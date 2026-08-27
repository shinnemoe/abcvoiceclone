import { NextRequest, NextResponse } from 'next/server';

// GET /api/health?podUrl=https://...  — proxy health check
// GET /api/health?endpoint=status&podUrl=https://...&jobId=... — proxy job status
// GET /api/health?endpoint=result&podUrl=https://...&jobId=... — proxy job result
export async function GET(req: NextRequest) {
  const podUrl   = req.nextUrl.searchParams.get('podUrl');
  const endpoint = req.nextUrl.searchParams.get('endpoint') || 'health';
  const jobId    = req.nextUrl.searchParams.get('jobId');

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

    // For result endpoint, stream the audio back
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

// POST /api/health?endpoint=generate&podUrl=https://... — proxy generate
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
