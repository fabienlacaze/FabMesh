-- MyFabmesh.AI Cloud — Supabase schema.
-- Run this in the SQL editor of your Supabase project once.

-- 1. PROFILES (one row per auth.users) ----------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  credits      integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Auto-create profile on signup. New users get 50 free credits (trial-
-- conversion policy — matches the landing page + confirmation email).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, credits) values (new.id, new.email, 50)
    on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. JOBS (generation history) ------------------------------------------
create table if not exists public.jobs (
  id           text primary key,             -- Replicate prediction id
  user_id      uuid not null references auth.users(id) on delete cascade,
  asset_type   text not null,
  mode         text not null,
  seed         integer,
  credit_cost  integer not null default 1,
  status       text not null default 'starting',  -- starting/processing/succeeded/failed/canceled
  options      jsonb not null default '{}'::jsonb,
  mesh_url     text,
  error        text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists jobs_user_idx on public.jobs (user_id, created_at desc);

-- 3. PAYMENTS (Stripe Checkout completions) -----------------------------
create table if not exists public.payments (
  id                 bigserial primary key,
  stripe_session_id  text unique not null,
  user_id            uuid not null references auth.users(id) on delete cascade,
  pack_id            text not null,
  credits            integer not null,
  -- Dotation d'ORIGINE, figee au premier remboursement partiel.
  --
  -- `credits` porte le reliquat, qui diminue a chaque remboursement. Sans
  -- memoire de la valeur de depart, un second remboursement ne pouvait plus
  -- calculer combien reprendre : Stripe cumule `amount_refunded`, donc la
  -- reprise doit se calculer sur le montant initial. NULL tant qu'aucun
  -- remboursement n'a eu lieu.
  credits_origine    integer,
  amount_eur         numeric(8,2),
  created_at         timestamptz not null default now()
);

-- Migration pour les bases deja creees : la colonne peut manquer.
alter table public.payments add column if not exists credits_origine integer;

-- 4. ATOMIC CREDIT RPCs --------------------------------------------------
-- spend_credits: returns new balance, or NULL if insufficient.
create or replace function public.spend_credits(p_user_id uuid, p_amount integer)
returns integer language plpgsql security definer set search_path = public as $$
declare new_balance integer;
begin
  update public.profiles
  set credits = credits - p_amount, updated_at = now()
  where id = p_user_id and credits >= p_amount
  returning credits into new_balance;
  return new_balance;     -- NULL if no row updated (i.e. insufficient)
end;
$$;
grant execute on function public.spend_credits(uuid, integer) to service_role;
-- Lock down: only the service_role (server) may spend credits, never the anon/
-- authenticated client keys (default PUBLIC grant on functions would otherwise
-- let a forged client call it directly).
revoke execute on function public.spend_credits(uuid, integer) from public, anon, authenticated;

-- add_credits: returns new balance.
create or replace function public.add_credits(p_user_id uuid, p_amount integer)
returns integer language plpgsql security definer set search_path = public as $$
declare new_balance integer;
begin
  update public.profiles
  set credits = credits + p_amount, updated_at = now()
  where id = p_user_id
  returning credits into new_balance;
  return new_balance;
end;
$$;
grant execute on function public.add_credits(uuid, integer) to service_role;
-- Lock down: only the service_role (server) may add credits — prevents a client
-- with the anon/authenticated key from forging a balance top-up.
revoke execute on function public.add_credits(uuid, integer) from public, anon, authenticated;

-- 5. ROW LEVEL SECURITY --------------------------------------------------
alter table public.profiles  enable row level security;
alter table public.jobs      enable row level security;
alter table public.payments  enable row level security;

-- Users can read only their own data via authenticated client.
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select using (auth.uid() = id);

drop policy if exists "own jobs" on public.jobs;
create policy "own jobs" on public.jobs for select using (auth.uid() = user_id);

drop policy if exists "own payments" on public.payments;
create policy "own payments" on public.payments for select using (auth.uid() = user_id);

-- Writes only via service_role (server API routes). Default deny is fine.
