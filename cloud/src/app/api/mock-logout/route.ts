import { NextResponse } from 'next/server';
import { MOCK } from '@/lib/mock-store';
import { mockSignOut } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST() {
  if (!MOCK) return NextResponse.json({ error: 'mock disabled' }, { status: 400 });
  await mockSignOut();
  return NextResponse.json({ ok: true });
}
