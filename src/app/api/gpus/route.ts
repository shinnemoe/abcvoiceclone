import { NextResponse } from 'next/server';

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY!;
const GQL = `https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}`;

export async function GET() {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{
        gpuTypes {
          id
          displayName
          memoryInGb
          secureCloud
          communityCloud
          lowestPrice(input: { gpuCount: 1 }) { minimumBidPrice uninterruptablePrice }
        }
      }`,
    }),
    cache: 'no-store',
  });
  const data = await res.json();
  // Filter to >=16GB VRAM only and sort by price
  const gpus = (data?.data?.gpuTypes || [])
    .filter((g: { memoryInGb: number }) => g.memoryInGb >= 16)
    .sort((a: { lowestPrice: { uninterruptablePrice: number } }, b: { lowestPrice: { uninterruptablePrice: number } }) =>
      (a.lowestPrice?.uninterruptablePrice ?? 99) - (b.lowestPrice?.uninterruptablePrice ?? 99)
    );
  return NextResponse.json({ count: gpus.length, gpus });
}
