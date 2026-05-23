import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { MOCK } from '@/lib/mock-store';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  if (MOCK) {
    // mock store doesn't expose delete yet; treat as no-op success
    return NextResponse.json({ ok: true });
  }
  const sb = supabaseAdmin();
  const { error } = await sb.from('jobs').delete().eq('id', id).eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
