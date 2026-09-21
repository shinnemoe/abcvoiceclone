import { NextRequest, NextResponse } from 'next/server';

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY!;
const ENDPOINT_ID    = process.env.RUNPOD_SERVERLESS_ENDPOINT_ID || '9i7bqsopxktm7t';
const BASE_URL       = `https://api.runpod.ai/v2/${ENDPOINT_ID}`;

// ── GET: Check endpoint health or poll job status ───────────────────────────
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action') || 'health';
  const jobId  = req.nextUrl.searchParams.get('jobId');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${RUNPOD_API_KEY}`,
  };

  try {
    if (action === 'health') {
      const res = await fetch(`${BASE_URL}/health`, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        return NextResponse.json({ status: 'unreachable', error: `HTTP ${res.status}` }, { status: res.status });
      }
      const data = await res.json();
      return NextResponse.json({ endpointId: ENDPOINT_ID, ...data });
    }

    if (action === 'status') {
      if (!jobId) {
        return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
      }
      const res = await fetch(`${BASE_URL}/status/${encodeURIComponent(jobId)}`, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return NextResponse.json({ error: `RunPod status error ${res.status}` }, { status: res.status });
      }
      const data = await res.json();
      return NextResponse.json(data);
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── POST: Submit a serverless generation job ─────────────────────────────────
export async function POST(req: NextRequest) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${RUNPOD_API_KEY}`,
  };

  try {
    const formData = await req.formData();
    const text       = (formData.get('text') as string || '').trim();
    const refAudio   = formData.get('reference_audio') as File | null;
    const promptText = (formData.get('prompt_text') as string || '').trim();
    const seedVal    = formData.get('seed') ? parseInt(formData.get('seed') as string) : 42;
    const style      = (formData.get('style') as string || 'Natural');
    const customStyle= (formData.get('custom_style') as string || '').trim();
    const speed      = (formData.get('speed') as string || 'Normal');

    if (!text) {
      return NextResponse.json({ error: 'Text to clone is required' }, { status: 400 });
    }
    if (!refAudio) {
      return NextResponse.json({ error: 'Reference audio file is required' }, { status: 400 });
    }

    // Convert reference audio file to Base64
    const audioBuffer = await refAudio.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');
    const mimeType    = refAudio.type || 'audio/wav';

    // Build payload for RunPod Serverless
    const payload = {
      input: {
        text,
        reference_audio: audioBase64,
        reference_audio_type: mimeType,
        prompt_text: promptText,
        seed: seedVal,
        style,
        custom_style: customStyle,
        speed,
      },
    };

    console.log(`[Serverless] Submitting job to ${BASE_URL}/run (text length: ${text.length})`);
    const res = await fetch(`${BASE_URL}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[Serverless] Submit error:', res.status, errText.slice(0, 300));
      return NextResponse.json({ error: `Serverless submit failed: ${errText}` }, { status: res.status });
    }

    const data = await res.json();
    console.log(`[Serverless] Job queued successfully:`, data.id);
    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Serverless] Unexpected error in POST:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
