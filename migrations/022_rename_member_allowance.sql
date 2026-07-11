-- 022_rename_member_allowance.sql — terminology alignment (spec 065). The member's reserved slice of
-- the org pool is an ALLOWANCE in the domain + API (`PUT /api/tenant/members/:id/allowance`), but was
-- stored in `tenant_members.token_limit` (named to mirror the legacy per-user `users.token_limit`).
-- Rename the column so storage matches the domain: DB `token_allowance` ↔ API `allowance`, parallel to
-- `token_pool` ↔ `pool`. Pure rename, no data change (the column was added empty in 021). The legacy
-- per-user `users.token_limit` is a genuine "limit" and is left as-is.
ALTER TABLE tenant_members RENAME COLUMN token_limit TO token_allowance;
