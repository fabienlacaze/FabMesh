/**
 * GET /api/jobs/[id]
 *
 * Polled by the client every 3s while a generation is in progress.
 * Returns { status, url?, duration_s?, error? }.
 *
 * REAL mode: hits Replicate, uploads GLB to R2 on success, refunds on failure.
 * MOCK mode: returns "processing" for ~5s, then "succeeded" with the POC GLB.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getPrediction } from '@/lib/replicate';
import { supabaseAdmin } from '@/lib/supabase';
import { addCredits } from '@/lib/auth';
import { uploadGlbToR2 } from '@/lib/r2';
import { MOCK, mock } from '@/lib/mock-store';

export const runtime = 'nodejs';

const MOCK_GEN_DURATION_MS = 5000;
const MOCK_GLB_URL = '/mock/sample.glb';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // ─── MOCK MODE ───
  if (MOCK) {
    const job = mock.getJob(id);
    if (!job) return NextResponse.json({ status: 'failed', error: 'job not found' });
    const age = Date.now() - new Date(job.created_at).getTime();
    if (job.status === 'succeeded') {
      return NextResponse.json({ status: 'succeeded', url: job.mesh_url, duration_s: age / 1000 });
    }
    if (age > MOCK_GEN_DURATION_MS) {
      mock.updateJob(id, {
        status: 'succeeded', mesh_url: MOCK_GLB_URL,
        finished_at: new Date().toISOString(),
      });
      return NextResponse.json({ status: 'succeeded', url: MOCK_GLB_URL, duration_s: age / 1000 });
    }
    return NextResponse.json({ status: 'processing' });
  }

  // ─── REAL MODE ───
  const prediction = await getPrediction(id);
  const sb = supabaseAdmin();
  const { data: job } = await sb.from('jobs').select('*').eq('id', id).maybeSingle();

  function extractGlb(output: unknown): string | null {
    if (!output) return null;
    if (typeof output === 'string') return output;
    const o = output as Record<string, unknown>;
    if (typeof o.url === 'string') return o.url;
    if (typeof o.model_file === 'string') return o.model_file;
    const mf = o.model_file as Record<string, unknown> | undefined;
    if (mf && typeof mf.url === 'string') return mf.url;
    return null;
  }

  if (prediction.status === 'succeeded') {
    const replicateUrl = extractGlb(prediction.output);
    let stableUrl = job?.mesh_url ?? null;
    if (replicateUrl && !stableUrl && job) {
      try {
        stableUrl = await uploadGlbToR2(replicateUrl, `${job.user_id}/${id}.glb`);
      } catch (err) {
        console.error('R2 upload failed, falling back to replicate URL:', err);
        stableUrl = replicateUrl;
      }
      await sb.from('jobs')
        .update({ status: 'succeeded', mesh_url: stableUrl, finished_at: new Date().toISOString() })
        .eq('id', id);
    }
    const start = job?.created_at ? new Date(job.created_at).getTime() : Date.now();
    return NextResponse.json({
      status: 'succeeded', url: stableUrl ?? replicateUrl,
      duration_s: (Date.now() - start) / 1000,
    });
  }

  if (prediction.status === 'failed' || prediction.status === 'canceled') {
    if (job && job.status !== prediction.status) {
      await addCredits(job.user_id, job.credit_cost);
      await sb.from('jobs')
        .update({ status: prediction.status, error: prediction.error || null, finished_at: new Date().toISOString() })
        .eq('id', id);
    }
    return NextResponse.json({
      status: prediction.status, error: prediction.error || 'unknown error',
    });
  }

  return NextResponse.json({ status: prediction.status });
}
