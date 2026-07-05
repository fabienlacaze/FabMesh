-- Defense-in-depth: the credit RPCs are SECURITY DEFINER (they bypass RLS), so
-- the default PUBLIC EXECUTE grant would let anyone holding the public anon key
-- call them directly via PostgREST and mint/spend credits. schema.sql already
-- REVOKEs this, but the init_schema migrations stopped at `grant ... to
-- service_role` and never revoked PUBLIC — so a DB provisioned purely from the
-- migration path could be exposed. This migration makes the migration path
-- match schema.sql. (Verified 2026-07-05: the live DB is already locked —
-- add_credits/spend_credits acl = {postgres, service_role} only — so this is a
-- no-op there and only protects future re-provisioning.)
--
-- Only the server-side service_role admin client legitimately calls these; it
-- keeps its explicit grant from the init migration.
revoke execute on function public.spend_credits(uuid, integer) from public, anon, authenticated;
revoke execute on function public.add_credits(uuid, integer) from public, anon, authenticated;
