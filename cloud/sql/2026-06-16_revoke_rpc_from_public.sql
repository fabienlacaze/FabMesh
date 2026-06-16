-- 2026-06-16 P0: lock down SECURITY DEFINER credit RPCs.
-- Postgres auto-grants EXECUTE TO PUBLIC on CREATE FUNCTION, so the
-- existing `grant execute ... to service_role` does NOT remove anon access.
-- Re-runnable: REVOKE is a no-op if the privilege is already gone.

REVOKE EXECUTE ON FUNCTION public.add_credits(uuid, integer)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.spend_credits(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()           FROM PUBLIC, anon, authenticated;

-- Re-assert the only legit caller (server-side service_role) — idempotent.
GRANT EXECUTE ON FUNCTION public.add_credits(uuid, integer)    TO service_role;
GRANT EXECUTE ON FUNCTION public.spend_credits(uuid, integer)  TO service_role;

-- handle_new_user runs as a trigger owned by the definer; it does NOT need
-- a role grant, so we leave it revoked from everyone (trigger still fires).

-- Stop future functions in this schema from defaulting to PUBLIC execute.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
