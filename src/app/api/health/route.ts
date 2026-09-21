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

// ── WAV combiner (pure Node.js, no ffmpeg) ───────────────────────────────
function combineWavBuffers(
  buffers: ArrayBuffer[],
  sampleRate: number,
  silenceGapSec = 0.3
): ArrayBuffer {
  // WAV is: 44-byte header + float32 PCM
  const silenceSamples = Math.floor(sampleRate * silenceGapSec);
  const silenceBytes = silenceSamples * 4; // float32 = 4 bytes/sample

  let totalPcm = 0;
  const parts: Uint8Array[] = [];

  for (let i = 0; i < buffers.length; i++) {
    if (i > 0) {
      parts.push(new Uint8Array(silenceBytes)); // zeroed = silence
      totalPcm += silenceBytes;
    }
    const pcm = new Uint8Array(buffers[i], 44); // skip 44-byte WAV header
    parts.push(pcm);
    totalPcm += pcm.byteLength;
  }

  // Build WAV header for IEEE float32 mono
  const out = new Uint8Array(44 + totalPcm);
  const view = new DataView(out.buffer);
  const enc = new TextEncoder();
  out.set(enc.encode('RIFF'), 0);
  view.setUint32(4, 36 + totalPcm, true);       // file size - 8
  out.set(enc.encode('WAVE'), 8);
  out.set(enc.encode('fmt '), 12);
  view.setUint32(16, 16, true);                  // fmt chunk size
  view.setUint16(20, 3, true);                   // IEEE float
  view.setUint16(22, 1, true);                   // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);      // byte rate
  view.setUint16(32, 4, true);                   // block align
  view.setUint16(34, 32, true);                  // bits per sample
  out.set(enc.encode('data'), 36);
  view.setUint32(40, totalPcm, true);

  // Write PCM data
  let offset = 44;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out.buffer;
}

// ── Async chunk downloader + combiner ────────────────────────────────────
async function downloadAndCombine(
  jobId: string,
  podUrl: string,
  chunkCount: number,
  sampleRate: number
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

    // Combine on VPS
    combineJobs.set(jobId, { phase: 'combining', ts: Date.now() });
    const audio = combineWavBuffers(chunkBuffers, sampleRate);

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

  if (!podUrl) return NextResponse.json({ status: 'unreachable', ready: false }, { status: 400 });

  // ── result endpoint: maybe serve locally combined file ──────────────────
  if (endpoint === 'result' && jobId && VPS_COMBINE) {
    const state = combineJobs.get(jobId);
    if (!state) {
      // No VPS state — check disk for completed job
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
      // Not on disk either — fall through to RunPod proxy
    } else if (state.phase === 'done') {
      combineJobs.delete(jobId);
      return new NextResponse(readFileSync(state.filePath), {
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Disposition': `attachment; filename="voice-clone-${jobId}.wav"`,
        },
      });
    } else if (state.phase === 'error') {
      console.warn(`[VPS combine] Error, falling back to RunPod for job ${jobId}:`, state.msg);
      combineJobs.delete(jobId);
      // Fall through to normal proxy below
    } else {
      // Still downloading or combining — tell frontend to keep polling
      return NextResponse.json({ status: 'combining', progress: null });
    }
  }

  // ── status endpoint: check VPS combine state FIRST (pod may already be stopped) ──
  if (endpoint === 'status' && jobId && VPS_COMBINE) {
    const state = combineJobs.get(jobId);
    if (state?.phase === 'done') {
      return NextResponse.json({ status: 'done', progress: { done: 1, total: 1 } });
    }
    if (state?.phase === 'chunks_saved') {
      // All chunks on VPS — safe to stop GPU now!
      return NextResponse.json({ status: 'safe_to_stop_gpu', progress: null });
    }
    if (state && (state.phase === 'downloading' || state.phase === 'combining')) {
      return NextResponse.json({ status: 'combining', progress: null });
    }
    // Check disk too (survived restart)
    if (existsSync(join(OUTPUT_DIR, `${jobId}.wav`))) {
      return NextResponse.json({ status: 'done', progress: { done: 1, total: 1 } });
    }
    // No state — fall through to RunPod proxy
  }

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
          downloadAndCombine(jobId, podUrl, data.chunk_count, data.sample_rate);
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
