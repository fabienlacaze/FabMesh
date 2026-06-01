-- user_assets: one row per generated artifact (image, thumb, ...).
-- Removes the need for the client to cache R2 paths in localStorage,
-- which was hitting the ~5 MB quota cap on heavy users.
--
-- We use ONE table for any asset type (kind column) instead of multiple
-- tables, so future asset types (cinematics, sheets, etc.) just need a
-- new `kind` value, no migration.

create table if not exists public.user_assets (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  project      text not null,                       -- 'dragon', 'lion vert', ...
  kind         text not null,                       -- 'image-front', 'image-back', 'image-modified', 'image-removebg', 'thumb-mesh', etc.
  r2_path      text not null,                       -- '<uid>/front/<ts>_<seed>.png' (key in R2 MESHES bucket)
  parent_path  text,                                -- e.g. front-image path for a back-image, or mesh-path for a thumb
  meta         jsonb not null default '{}'::jsonb,  -- {seed, prompt, jobId, asset_type, asset_style, ...}
  created_at   timestamptz not null default now()
);

-- Lookup by user+project for the listing UI (most common query)
create index if not exists user_assets_user_proj_idx
  on public.user_assets (user_id, project, created_at desc);

-- Lookup by kind for cross-project queries (e.g. all thumbs)
create index if not exists user_assets_user_kind_idx
  on public.user_assets (user_id, kind, created_at desc);

-- Optional secondary: same R2 path can never appear twice for the same user
create unique index if not exists user_assets_user_r2path_unique
  on public.user_assets (user_id, r2_path);

-- RLS: users read only their own rows; writes go through service_role
-- (the worker), so no public INSERT/UPDATE policy needed.
alter table public.user_assets enable row level security;

drop policy if exists "own user_assets" on public.user_assets;
create policy "own user_assets" on public.user_assets
  for select using (auth.uid() = user_id);
