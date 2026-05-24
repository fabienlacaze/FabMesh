-- Add a free-form `project_name` column to the `jobs` table so the
-- cloud app can group meshes & images under user-facing project names
-- (the desktop app already keeps these on disk; in cloud they live in
-- Supabase).
--
-- Existing rows get NULL — the worker falls back to deriving a name
-- from asset_type + id slice (see handleProjects / handleCloudProjects).

alter table public.jobs
  add column if not exists project_name text;

create index if not exists jobs_project_name_idx
  on public.jobs (user_id, project_name);
