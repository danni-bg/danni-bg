-- 018_active_tenant.sql — persisted per-user active org selection (spec 041, FR-230). Spec 029 shipped
-- the tenant tables but hard-wired the active tenant to a user's oldest membership (always the
-- auto-joined `default`), so a created org could never gain members/keys/sessions/usage. This adds an
-- explicit, persisted selection: `requireAuth` honours it when it is still a membership, else falls
-- back to the primary (oldest) membership — today's behavior. Additive + nullable: existing rows keep
-- NULL, so a user who never switches stays on `default` with no behavior change (spec 029 SC-C2 /
-- 041 FR-235). API-key requests keep using the key's own tenant_id — a key is tenant-bound.
ALTER TABLE users ADD COLUMN active_tenant_id TEXT;
