import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const RUNPOD_API_KEY    = process.env.RUNPOD_API_KEY!;
const NETWORK_VOLUME_ID = process.env.RUNPOD_NETWORK_VOLUME_ID!;
const IMAGE             = process.env.RUNPOD_IMAGE || 'ghcr.io/shinnemoe/voice-studio:latest';
const GQL               = `https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}`;
const POD_STATE_FILE    = join(tmpdir(), 'voiceclone-pod.json');

// ─── Pod state (server-side, survives page refresh) ──────────────────────────
interface PodState {
  podId: string;
  podUrl: string;
  gpuType: string;
  createdAt: string;
}

function readState(): PodState | null {
  try {
    if (!existsSync(POD_STATE_FILE)) return null;
    return JSON.parse(readFileSync(POD_STATE_FILE, 'utf-8'));
  } catch { return null; }
}

function writeState(state: PodState) {
  writeFileSync(POD_STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState() {
  try { if (existsSync(POD_STATE_FILE)) unlinkSync(POD_STATE_FILE); } catch {}
}

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

// ── Fetch live GPU pricing and sort cheapest first ─────────────────────────
async function getGpuTypesByPrice() {
  const query = `{
    gpuTypes {
      id
      displayName
      memoryInGb
      secureCloud
      communityCloud
      lowestPrice(input: { gpuCount: 1 }) { minimumBidPrice uninterruptablePrice }
    }
  }`;
  const data = await gql(query);
  const priced: { id: string; price: number }[] = [];
  const unpriced: string[] = [];

  for (const g of data?.data?.gpuTypes || []) {
    // VoxCPM2 runs great on >= 16GB VRAM (e.g. RTX A4000 $0.17/hr)
    if (g.memoryInGb < 16) continue;
    // Skip GPUs that aren't available in any cloud type
    if (!g.secureCloud && !g.communityCloud) continue;
    // Skip Blackwell / RTX PRO — too new for PyTorch 2.5.1 (CUDA 12.1)
    const name = (g.displayName || '').toLowerCase();
    if (name.includes('blackwell') || name.includes('rtx pro')) continue;
    const price = g.lowestPrice?.uninterruptablePrice;
    if (price != null && price > 0) {
      priced.push({ id: g.id, price });
    } else {
      unpriced.push(g.id); // try these last (no pricing data)
    }
  }

  priced.sort((a, b) => a.price - b.price);
  const result = [...priced.map(g => g.id), ...unpriced];

  const preview = priced.slice(0, 5).map(g => `${g.id} ($${g.price}/hr)`).join(', ');
  console.log(`[RunPod] ${priced.length} priced GPUs, ${unpriced.length} unpriced. Cheapest: ${preview || 'none'}`);
  return result;
}

// ── Create pod with first available GPU (cheapest first) ───────────────────
async function createPod() {
  const configs = [
    { withVolume: true,  cloudType: 'SECURE', diskGb: 20  },
    { withVolume: false, cloudType: 'ALL',    diskGb: 50  },
  ];

  // Fetch live pricing — try cheapest GPUs first
  const gpuTypes = await getGpuTypesByPrice();

  for (const { withVolume, cloudType, diskGb } of configs) {
    for (const gpuType of gpuTypes) {
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
            dockerArgs: "python backend/cloud_server.py"
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

// GET /api/pod — check if a pod is already running (survives page refresh)
export async function GET() {
  const state = readState();
  if (!state) {
    return NextResponse.json({ running: false });
  }
  return NextResponse.json({ running: true, ...state });
}

// POST /api/pod
export async function POST(req: NextRequest) {
  const { action, podId } = await req.json();

  if (action === 'create') {
    // If there's already a running pod, return it instead of creating a new one
    const existing = readState();
    if (existing) {
      console.log('[RunPod] Pod already running:', existing.podId, '— returning existing');
      return NextResponse.json({ success: true, ...existing });
    }

    try {
      const result = await createPod();
      const podUrl = `https://${result.podId}-8000.proxy.runpod.net`;
      const state: PodState = {
        podId: result.podId,
        podUrl,
        gpuType: result.gpuType,
        createdAt: new Date().toISOString(),
      };
      writeState(state);
      return NextResponse.json({ success: true, ...state });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ success: false, error: msg }, { status: 503 });
    }
  }

  if (action === 'terminate') {
    // Use provided podId or read from server state
    const targetId = podId || readState()?.podId;
    if (!targetId) {
      return NextResponse.json({ error: 'No pod to terminate' }, { status: 400 });
    }
    let data: any;
    try { data = await terminatePod(targetId); } catch { /* pod already gone */ }
    clearState();
    return NextResponse.json(data);
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
