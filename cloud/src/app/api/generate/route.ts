/**
 * POST /api/generate
 *
 * Multipart form: image (Blob) + asset_type, mode, seed, options (booleans).
 * Returns { jobId } so the client can poll /api/jobs/[id].
 *
 * Flow:
 *  1. Verify session + credit balance.
 *  2. Reserve credits (deduct now; refund on failure via /api/jobs polling).
 *  3. Create Replicate prediction (async) — or fake one in MOCK mode.
 *  4. Persist job → Supabase OR mock store.
 *  5. Return jobId.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, spendCredits, addCredits } from '@/lib/auth';
import { createPrediction, creditCost, GenerateInput } from '@/lib/replicate';
import { supabaseAdmin } from '@/lib/supabase';
import { MOCK, mock } from '@/lib/mock-store';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const form = await req.formData();
  const image = form.get('image');
  if (!(image instanceof File)) return NextResponse.json({ error: 'image required' }, { status: 400 });

  const input: GenerateInput = {
    image,
    asset_type: (form.get('asset_type') as GenerateInput['asset_type']) || 'character',
    mode: (form.get('mode') as GenerateInput['mode']) || 'standard',
    seed: parseInt(String(form.get('seed') ?? '42')) || 42,
    rectify: form.get('rectify') === 'true',
    back_view: form.get('back_view') === 'true',
    smooth: form.get('smooth') === 'true',
    face_fix: form.get('face_fix') === 'true',
    ultra_hd: form.get('ultra_hd') === 'true',
    fast: form.get('fast') === 'true',
  };

  const cost = creditCost(input);
  const remaining = await spendCredits(user.id, cost);
  if (remaining == null) return NextResponse.json({ error: 'insufficient credits' }, { status: 402 });

  // ─── MOCK : skip Replicate entirely, return a fake jobId that resolves
  // after ~5s to the POC mesh GLB we already have on disk. ───
  if (MOCK) {
    const jobId = 'mock_' + Date.now();
    mock.insertJob({
      id: jobId, user_id: user.id,
      asset_type: input.asset_type, mode: input.mode, seed: input.seed ?? 42,
      credit_cost: cost, status: 'processing',
      options: {
        rectify: input.rectify, back_view: input.back_view, smooth: input.smooth,
        face_fix: input.face_fix, ultra_hd: input.ultra_hd, fast: input.fast,
      },
      created_at: new Date().toISOString(),
    });
    return NextResponse.json({ jobId, creditsRemaining: remaining, mock: true });
  }

  // ─── REAL : call Replicate ───
  let prediction;
  try {
    prediction = await createPrediction(input);
  } catch (err: unknown) {
    await addCredits(user.id, cost);
    return NextResponse.json({ error: 'replicate failed: ' + (err instanceof Error ? err.message : String(err)) }, { status: 502 });
  }

  await supabaseAdmin().from('jobs').insert({
    id: prediction.id, user_id: user.id,
    asset_type: input.asset_type, mode: input.mode, seed: input.seed,
    credit_cost: cost, status: prediction.status,
    options: {
      rectify: input.rectify, back_view: input.back_view, smooth: input.smooth,
      face_fix: input.face_fix, ultra_hd: input.ultra_hd, fast: input.fast,
    },
    created_at: new Date().toISOString(),
  });

  return NextResponse.json({ jobId: prediction.id, creditsRemaining: remaining });
}
