import { NextRequest, NextResponse } from 'next/server';

const RUNPOD_API_KEY    = process.env.RUNPOD_API_KEY!;
const NETWORK_VOLUME_ID = process.env.RUNPOD_NETWORK_VOLUME_ID!;
const IMAGE             = process.env.RUNPOD_IMAGE || 'ghcr.io/shinnemoe/voice-studio:latest';
const GQL               = `https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}`;

// GPU types to try in order of preference (cheapest first, ≥16GB VRAM)
const GPU_TYPES = [
  'NVIDIA RTX 2000 Ada Generation',
  'NVIDIA RTX A4000',
  'NVIDIA GeForce RTX 3090',
  'NVIDIA RTX A5000',
  'NVIDIA RTX 4000 Ada Generation',
  'NVIDIA GeForce RTX 3080 Ti',
  'NVIDIA RTX A5000',
  'NVIDIA RTX 6000 Ada Generation',
  'NVIDIA GeForce RTX 4090',
  'NVIDIA RTX A6000',
  'NVIDIA A100 80GB PCIe',
];

async function gql(query: string) {
  const res  = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    cache: 'no-store',
  });
  const text = await res.text();
  console.log('[RunPod GQL] status:', res.status, 'body:', text.slice(0, 600));
  try { return JSON.parse(text); } catch { return { error: text }; }
}

// ── Create pod with first available GPU ────────────────────────────────────
async function createPod() {
  const configs = [
    // Pass 1: use network volume (fast future starts), constrained to volume's datacenter
    { withVolume: true,  cloudType: 'SECURE', diskGb: 20  },
    // Pass 2: no volume, try any datacenter (model downloads fresh ~5-10 min)
    { withVolume: false, cloudType: 'ALL',    diskGb: 50  },
  ];

  for (const { withVolume, cloudType, diskGb } of configs) {
    for (const gpuType of GPU_TYPES) {
      const escapedGpu = gpuType.replace(/"/g, '\\"');
      const volumePart = withVolume
        ? `networkVolumeId: "${NETWORK_VOLUME_ID}" volumeMountPath: "/models"`
        : '';

      const query = `
        mutation {
          podFindAndDeployOnDemand(input: {
            cloudType: ${cloudType}
            gpuCount: 1
            containerDiskInGb: ${diskGb}
            minVcpuCount: 2
            minMemoryInGb: 15
            gpuTypeId: "${escapedGpu}"
            name: "voice-studio-session"
            imageName: "${IMAGE}"
            ports: "8000/http,22/tcp"
            ${volumePart}
            env: [{ key: "MODEL_PATH", value: "/models/VoxCPM2" }]
          }) {
            id
            imageName
            machine { podHostId }
          }
        }
      `;
      const data = await gql(query);
      const pod  = data?.data?.podFindAndDeployOnDemand;
      if (pod?.id) {
        const label = withVolume ? 'with volume' : 'WITHOUT volume (model will download)';
        console.log(`[RunPod] ✅ Created pod ${pod.id} GPU: ${gpuType} — ${label}`);
        return { podId: pod.id, gpuType, withVolume };
      }
      const errMsg = data?.errors?.[0]?.message || 'no pod returned';
      console.log(`[RunPod] ✗ ${gpuType} (${withVolume ? 'vol' : 'no-vol'}): ${errMsg.slice(0, 80)}`);
    }
  }
  throw new Error('No GPUs available in any region. Try again in a few minutes.');
}

// ── Terminate pod ──────────────────────────────────────────────────────────
async function terminatePod(podId: string) {
  const data = await gql(`mutation { podTerminate(input: { podId: "${podId}" }) }`);
  console.log('[RunPod] Terminated pod:', podId, JSON.stringify(data));
  return data;
}

// POST /api/pod
export async function POST(req: NextRequest) {
  const { action, podId } = await req.json();

  if (action === 'create') {
    try {
      const result = await createPod();
      const podUrl = `https://${result.podId}-8000.proxy.runpod.net`;
      return NextResponse.json({ success: true, podId: result.podId, podUrl, gpuType: result.gpuType });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ success: false, error: msg }, { status: 503 });
    }
  }

  if (action === 'terminate') {
    if (!podId) return NextResponse.json({ error: 'podId required' }, { status: 400 });
    const data = await terminatePod(podId);
    return NextResponse.json(data);
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
