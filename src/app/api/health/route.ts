import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

// GET /api/health?podUrl=https://...  — proxy health check
// GET /api/health?endpoint=status&podUrl=https://...&jobId=... — proxy job status
// GET /api/health?endpoint=result&podUrl=https://...&jobId=... — proxy job result

// ── VPS-side combining feature flag ──────────────────────────────────────
// Set COMBINE_ON_VPS=true in systemd service env to enable.
// Revert: set COMBINE_ON_VPS=false or remove it → old RunPod combining.
const VPS_COMBINE = process.env.COMBINE_ON_VPS === 'true';

// Persistent output directory — survives VPS restarts
const OUTPUT_DIR = '/opt/voiceclone/outputs';
try { mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}

// Clean up audio files older than 24h on startup
try {
  const now = Date.now();
  for (const f of readdirSync(OUTPUT_DIR)) {
    const p = join(OUTPUT_DIR, f);
    if (now - statSync(p).mtimeMs > 24 * 60 * 60 * 1000) unlinkSync(p);
  }
} catch {}

// In-memory state for ongoing VPS combines (short-lived, seconds)
type CombineState =
  | { phase: 'downloading'; ts: number }
  | { phase: 'chunks_saved'; ts: number }   // all chunks in VPS memory — GPU can stop
  | { phase: 'combining'; ts: number }
  | { phase: 'done'; filePath: string; ts: number }
  | { phase: 'error'; msg: string; ts: number };
const combineJobs = new Map<string, CombineState>();

// Clean up abandoned jobs every 5 min (in case user closes tab before downloading)
const COMBINE_TTL_MS = 10 * 60 * 1000; // 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of combineJobs) {
    if (now - state.ts > COMBINE_TTL_MS) {
      combineJobs.delete(id);
      console.log(`[VPS combine] Cleaned up abandoned job ${id}`);
    }
  }
}, 5 * 60 * 1000);

// ── WAV header parser ─────────────────────────────────────────────────────
function parseWavHeader(buf: ArrayBuffer) {
  const view = new DataView(buf);
  let offset = 12; // skip RIFF + WAVE
  let audioFormat = 1, numChannels = 1, sampleRate = 24000, bitsPerSample = 16;
  let dataOffset = 44, dataSize = buf.byteLength - 44;

  while (offset + 8 <= buf.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset+1),
      view.getUint8(offset+2), view.getUint8(offset+3)
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      audioFormat  = view.getUint16(offset + 8,  true);
      numChannels  = view.getUint16(offset + 10, true);
      sampleRate   = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize   = size;
      break;
    }
    offset += 8 + size + (size & 1); // WAV chunks are word-aligned
  }
  return { audioFormat, numChannels, sampleRate, bitsPerSample, dataOffset, dataSize };
}

// ── WAV combiner — reads actual format from chunks, no hardcoded assumptions ─
function combineWavBuffers(buffers: ArrayBuffer[], silenceGapSec = 0.3): ArrayBuffer {
  const fmt = parseWavHeader(buffers[0]);
  const blockAlign  = fmt.numChannels * (fmt.bitsPerSample / 8);
  const byteRate    = fmt.sampleRate * blockAlign;
  const silenceBytes = Math.floor(fmt.sampleRate * silenceGapSec) * blockAlign;

  let totalData = 0;
  const parts: Uint8Array[] = [];

  for (let i = 0; i < buffers.length; i++) {
    if (i > 0) {
      parts.push(new Uint8Array(silenceBytes)); // zero = silence
      totalData += silenceBytes;
    }
    const f = parseWavHeader(buffers[i]);
    parts.push(new Uint8Array(buffers[i], f.dataOffset, f.dataSize));
    totalData += f.dataSize;
  }

  // Write correct header using actual format values from chunks
  const out  = new Uint8Array(44 + totalData);
  const view = new DataView(out.buffer);
  const enc  = new TextEncoder();
  out.set(enc.encode('RIFF'), 0);
  view.setUint32(4,  36 + totalData, true);
  out.set(enc.encode('WAVE'), 8);
  out.set(enc.encode('fmt '), 12);
  view.setUint32(16, 16,                true);
  view.setUint16(20, fmt.audioFormat,   true); // actual format (1=PCM, 3=float)
  view.setUint16(22, fmt.numChannels,   true);
  view.setUint32(24, fmt.sampleRate,    true);
  view.setUint32(28, byteRate,          true);
  view.setUint16(32, blockAlign,        true);
  view.setUint16(34, fmt.bitsPerSample, true);
  out.set(enc.encode('data'), 36);
  view.setUint32(40, totalData, true);

  let offset = 44;
  for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
  return out.buffer;
}

// ── Async chunk downloader + combiner ────────────────────────────────────
async function downloadAndCombine(
  jobId: string,
  podUrl: string,
  chunkCount: number,
): Promise<void> {
  try {
    combineJobs.set(jobId, { phase: 'downloading', ts: Date.now() });

    // Download all chunks concurrently
    const chunkBuffers = await Promise.all(
      Array.from({ length: chunkCount }, (_, i) =>
        fetch(`${podUrl}/chunk/${jobId}/${i}`, {
          signal: AbortSignal.timeout(60_000),
          cache: 'no-store',
        }).then(r => {
          if (!r.ok) throw new Error(`Chunk ${i} fetch failed: ${r.status}`);
          return r.arrayBuffer();
        })
      )
    );

    // ✅ All chunks are now safely in VPS memory — GPU can be stopped
    combineJobs.set(jobId, { phase: 'chunks_saved', ts: Date.now() });

    // Tell RunPod we're done — releases its waiting thread (fire-and-forget)
    fetch(`${podUrl}/chunks-fetched/${jobId}`, { method: 'POST', signal: AbortSignal.timeout(5_000) })
      .catch(() => {});

    // Combine on VPS (format read from actual WAV headers)
    combineJobs.set(jobId, { phase: 'combining', ts: Date.now() });
    const audio = combineWavBuffers(chunkBuffers);

    // Save to disk — survives page refresh and VPS restart
    const filePath = join(OUTPUT_DIR, `${jobId}.wav`);
    writeFileSync(filePath, Buffer.from(audio));
    combineJobs.set(jobId, { phase: 'done', filePath, ts: Date.now() });
    console.log(`[VPS combine] Job ${jobId}: combined ${chunkCount} chunks → ${filePath} ✓`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[VPS combine] Job ${jobId} failed:`, msg);
    combineJobs.set(jobId, { phase: 'error', msg, ts: Date.now() });
  }
}

// ── GET handler ───────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const podUrl   = req.nextUrl.searchParams.get('podUrl');
  const endpoint = req.nextUrl.searchParams.get('endpoint') || 'health';
  const jobId    = req.nextUrl.searchParams.get('jobId');

  // ── recent endpoint: list completed files on VPS disk ──────────────────
  if (endpoint === 'recent') {
    try {
      const files = readdirSync(OUTPUT_DIR)
        .filter(f => f.endsWith('.wav'))
        .map(f => {
          const p = join(OUTPUT_DIR, f);
          const s = statSync(p);
          const id = f.replace('.wav', '');
          return {
            id,
            url: `/voiceclone/api/health?endpoint=result&jobId=${id}`,
            label: `Voice Clone (${new Date(s.mtimeMs).toLocaleTimeString()})`,
            ts: s.mtimeMs,
            size: s.size,
          };
        })
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 10);
      return NextResponse.json({ files });
    } catch {
      return NextResponse.json({ files: [] });
    }
  }

  // ── result endpoint: maybe serve locally combined file (works even if pod is stopped) ──
  if (endpoint === 'result' && jobId) {
    const diskPath = join(OUTPUT_DIR, `${jobId}.wav`);
    if (existsSync(diskPath)) {
      combineJobs.delete(jobId);
      return new NextResponse(readFileSync(diskPath), {
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Disposition': `attachment; filename="voice-clone-${jobId}.wav"`,
        },
      });
    }

    if (VPS_COMBINE) {
      const state = combineJobs.get(jobId);
      if (state?.phase === 'done') {
        combineJobs.delete(jobId);
        return new NextResponse(readFileSync(state.filePath), {
          headers: {
            'Content-Type': 'audio/wav',
            'Content-Disposition': `attachment; filename="voice-clone-${jobId}.wav"`,
          },
        });
      } else if (state?.phase === 'error') {
        console.warn(`[VPS combine] Error for job ${jobId}:`, state.msg);
        combineJobs.delete(jobId);
      } else if (state) {
        // Still downloading or combining on VPS
        return NextResponse.json({ status: 'combining', progress: null });
      }
    }
  }

  // ── status endpoint: check VPS combine state FIRST (pod may already be stopped) ──
  if (endpoint === 'status' && jobId) {
    // Check disk first (survives restart & pod shutdown)
    if (existsSync(join(OUTPUT_DIR, `${jobId}.wav`))) {
      return NextResponse.json({ status: 'done', progress: { done: 1, total: 1 } });
    }

    if (VPS_COMBINE) {
      const state = combineJobs.get(jobId);
      if (state?.phase === 'done') {
        return NextResponse.json({ status: 'done', progress: { done: 1, total: 1 } });
      }
      if (state?.phase === 'chunks_saved') {
        return NextResponse.json({ status: 'safe_to_stop_gpu', progress: null });
      }
      if (state && (state.phase === 'downloading' || state.phase === 'combining')) {
        return NextResponse.json({ status: 'combining', progress: null });
      }
    }
  }

  // If no podUrl provided and not served from VPS above, return unreachable
  if (!podUrl) return NextResponse.json({ status: 'unreachable', ready: false }, { status: 400 });

  // Build the target URL
  let targetUrl: string;
  if (endpoint === 'health') {
    targetUrl = `${podUrl}/health`;
  } else if (jobId && (endpoint === 'status' || endpoint === 'result')) {
    targetUrl = `${podUrl}/${endpoint}/${encodeURIComponent(jobId)}`;
  } else {
    return NextResponse.json({ error: 'Invalid endpoint' }, { status: 400 });
  }

  try {
    const timeout = endpoint === 'health' ? 5000 : 10000;
    const res = await fetch(targetUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout),
    });

    // ── status endpoint: intercept chunks_ready ────────────────────────────
    if (endpoint === 'status' && res.ok) {
      const data = await res.json();

      if (data.status === 'chunks_ready' && VPS_COMBINE && jobId) {
        const existing = combineJobs.get(jobId);
        if (!existing) {
          // Kick off async download+combine (don't await — returns immediately)
          downloadAndCombine(jobId, podUrl, data.chunk_count);
        }
        const state = combineJobs.get(jobId);
        if (state?.phase === 'done') {
          // Race: finished extremely fast
          return NextResponse.json({ ...data, status: 'done' });
        }
        // Tell frontend: "combining on VPS, stop GPU"
        return NextResponse.json({ ...data, status: 'combining' });
      }

      return NextResponse.json(data);
    }

    // For result endpoint, stream the audio back (fallback / VPS_COMBINE=false path)
    if (endpoint === 'result' && res.ok && res.headers.get('content-type')?.startsWith('audio/')) {
      const audioBuffer = await res.arrayBuffer();
      return new NextResponse(audioBuffer, {
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Disposition': `attachment; filename="voice-clone-${jobId}.wav"`,
        },
      });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    if (endpoint === 'health') {
      return NextResponse.json({ status: 'unreachable', ready: false }, { status: 503 });
    }
    return NextResponse.json({ error: 'Pod unreachable' }, { status: 503 });
  }
}

// ── POST handler ──────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const podUrl   = req.nextUrl.searchParams.get('podUrl');
  const endpoint = req.nextUrl.searchParams.get('endpoint') || 'generate';

  if (!podUrl) return NextResponse.json({ error: 'podUrl required' }, { status: 400 });

  console.log('[Health POST]', req.method, req.url, 'podUrl:', podUrl?.slice(0, 60), 'endpoint:', endpoint);

  try {
    const formData = await req.formData();
    const res = await fetch(`${podUrl}/${endpoint}`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(300000),
    });

    const contentType = res.headers.get('content-type') || '';

    if (!res.ok) {
      const err = await res.text();
      console.error('[Health POST] Pod returned error:', res.status, err.slice(0, 300));
      return NextResponse.json({ error: err }, { status: res.status });
    }

    // If pod returns audio (legacy / TTS), stream it through
    if (contentType.startsWith('audio/')) {
      const audioBuffer = await res.arrayBuffer();
      return new NextResponse(audioBuffer, {
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Disposition': `attachment; filename="voice-clone-${Date.now()}.wav"`,
        },
      });
    }

    // Otherwise return JSON (new job system returns {job_id, status, progress})
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('[Health POST] Proxy error:', msg, 'podUrl:', podUrl, 'endpoint:', endpoint);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
