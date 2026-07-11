-- 021_org_entitlements.sql — organization entitlements (spec 065). Makes the ORG the unit of a
-- manual, contract-driven token entitlement, without the platform doing any billing. Three additive
-- columns; every existing row keeps today's behavior (NULL pool = legacy per-user metering, BYOM off,
-- no allocation), so `default` and all current orgs are unaffected (SC-3).

-- The org's assigned platform-routing token entitlement. NULL = no pool-model entitlement (legacy);
-- a value >= 0 = a pool-model org. Set ONLY by a super-admin (reflects an offline B2B contract).
ALTER TABLE tenants ADD COLUMN token_pool INTEGER;

-- Whether the org may Bring Its Own Model (spec 042 LLM override). Off by default; only a super-admin
-- enables it per org.
ALTER TABLE tenants ADD COLUMN byom_enabled INTEGER NOT NULL DEFAULT 0;

-- A member's RESERVED token allowance within the org (the org admin's carve-up of the pool). NULL = 0
-- (no allocation). The sum of a pool-model org's member allowances is kept <= its token_pool.
ALTER TABLE tenant_members ADD COLUMN token_limit INTEGER;
