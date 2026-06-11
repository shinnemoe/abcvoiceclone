import { NextRequest, NextResponse } from 'next/server';

// GET /api/health?podUrl=https://...  — proxy health check
export async function GET(req: NextRequest) {
  const podUrl = req.nextUrl.searchParams.get('podUrl');
  if (!podUrl) return NextResponse.json({ status: 'unreachable', ready: false }, { status: 400 });

  try {
    const res = await fetch(`${podUrl}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: 'unreachable', ready: false }, { status: 503 });
  }
}

// POST /api/health?endpoint=generate&podUrl=https://... — proxy generate
export async function POST(req: NextRequest) {
  const podUrl   = req.nextUrl.searchParams.get('podUrl');
  const endpoint = req.nextUrl.searchParams.get('endpoint') || 'generate';

  if (!podUrl) return NextResponse.json({ error: 'podUrl required' }, { status: 400 });

  try {
    const formData = await req.formData();
    const res = await fetch(`${podUrl}/${endpoint}`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: err }, { status: res.status });
    }

    const audioBuffer = await res.arrayBuffer();
    return new NextResponse(audioBuffer, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Disposition': `attachment; filename="voice-clone-${Date.now()}.wav"`,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
