/**
 * GET /api/jobs/[id]
 *
 * Polled by the client every 3 s while a generation is in progress.
 * Returns { status, url?, duration_s?, error? }.
 *
 * On success: persists the GLB to R2 (so the user can download from a stable
 * URL and we keep history without depending on Replicate's 24h expiry).
 * On failure: refunds the credit cost.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getPrediction } from '@/lib/replicate';
import { supabaseAdmin } from '@/lib/supabase';
import { addCredits } from '@/lib/auth';
import { uploadGlbToR2 } from '@/lib/r2';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const prediction = await getPrediction(id);

  const sb = supabaseAdmin();
  const { data: job } = await sb.from('jobs').select('*').eq('id', id).maybeSingle();

  // Replicate predictions return output as { model_file: { url }, ... } for
  // fishwowater/trellis2, or directly the file URL for our own Cog
  // (return Path). Handle both.
  function extractGlb(output: any): string | null {
    if (!output) return null;
    if (typeof output === 'string') return output;
    if (typeof output?.url === 'string') return output.url;
    if (typeof output?.model_file === 'string') return output.model_file;
    if (typeof output?.model_file?.url === 'string') return output.model_file.url;
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
      status: 'succeeded',
      url: stableUrl ?? replicateUrl,
      duration_s: (Date.now() - start) / 1000,
    });
  }

  if (prediction.status === 'failed' || prediction.status === 'canceled') {
    if (job && job.status !== prediction.status) {
      // Refund once.
      await addCredits(job.user_id, job.credit_cost);
      await sb.from('jobs')
        .update({ status: prediction.status, error: prediction.error || null, finished_at: new Date().toISOString() })
        .eq('id', id);
    }
    return NextResponse.json({
      status: prediction.status,
      error: prediction.error || 'unknown error',
    });
  }

  return NextResponse.json({ status: prediction.status });
}
