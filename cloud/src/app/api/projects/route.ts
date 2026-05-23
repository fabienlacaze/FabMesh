/**
 * GET /api/projects
 *
 * Returns the user's generation history, formatted as the desktop renderer
 * expects (the same shape as `meshyAPI.listProjects()` from desktop).
 *
 * Desktop returns a list of project objects with { id, name, createdAt,
 * images: [...], meshes: [...] }. In cloud, our "projects" are individual
 * generation jobs persisted in Supabase (or mock store in dev).
 */
import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { MOCK, mock } from '@/lib/mock-store';

export const runtime = 'nodejs';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  if (MOCK) {
    const jobs = mock.listJobs(user.id);
    return NextResponse.json({ projects: jobs.map(toProject) });
  }

  const sb = supabaseAdmin();
  const { data } = await sb
    .from('jobs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  return NextResponse.json({ projects: (data ?? []).map(toProject) });
}

function toProject(j: {
  id: string; asset_type: string; mode: string; status: string;
  mesh_url: string | null; created_at: string;
  options?: Record<string, unknown>;
}) {
  // Desktop "project" shape vs cloud "job" — we adapt so the renderer's
  // existing project-card UI works without changes.
  return {
    id: j.id,
    name: `${capitalize(j.asset_type)} ${j.mode} · ${j.id.slice(-6)}`,
    asset_type: j.asset_type,
    mode: j.mode,
    status: j.status,
    createdAt: j.created_at,
    updatedAt: j.created_at,
    mesh_url: j.mesh_url,
    meshUrl: j.mesh_url,
    thumbnail: null,
    images: [],
    meshes: j.mesh_url ? [{ url: j.mesh_url, name: 'output.glb' }] : [],
    options: j.options ?? {},
  };
}
function capitalize(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }
