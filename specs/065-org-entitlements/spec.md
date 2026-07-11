# Spec 065 — Organization entitlements: token pools, per-member budgets, gated BYOM

## Context

The token allowance is per-user today (spec 021/042): each user's limit is their own
`users.token_limit` else a tenant/global `defaultTokenLimit`, defaulting to unlimited. There is no
**organization-level** allowance and no way to monetize an org. This spec makes the **organization**
the unit of entitlement — the place a manual B2B sale is expressed — without the platform doing any
billing.

The model (settled with the product owner):

- **Manual, contract-driven entitlements.** No pricing, invoicing, or self-serve purchase in the
  platform. A **super-admin assigns a token pool** to an org (reflecting an offline B2B contract);
  the platform only *enforces* it. Same for BYOM capability.
- **Reserved sub-budgets.** The org's pool is carved into **per-member reserved allowances** by the
  org's own admins; the sum of allowances must be ≤ the pool. A member spends only their own slice —
  one member running out never touches another's.
- **Owner stays the top role.** `owner` holds the contract (last-owner protected); `admin` manages
  members, other admins, and allocations; `member` spends their allowance.
- **BYOM bypasses the pool.** The pool governs **dannibg-routed** models only. An org that Brings
  Its Own Model calls its own provider (and pays it) — those turns don't deduct the pool and aren't
  bounded by it. BYOM is **off by default** and only a **super-admin can enable** it per org.

Out of scope (unchanged / deferred): automated billing, pricing, invoicing, usage-based charging, or
self-serve purchase (all sales are manual B2B); pool auto-refill/scheduling (manual, like
`usage_reset_at`); the data/request-API quota (spec 028/040) is a separate allowance, untouched.

## Data model (migration)

- **`tenants.token_pool`** INTEGER NULL — the org's assigned platform-routing token entitlement.
  `NULL` = no pool-model entitlement (**legacy** behavior, backward-compatible); a value ≥ 0 = a
  pool-model org. Set **only** by a super-admin.
- **`tenants.byom_enabled`** INTEGER NOT NULL DEFAULT 0 — BYOM capability. Set **only** by a
  super-admin. Default **off**.
- **`tenant_members.token_limit`** INTEGER NULL — a member's reserved allowance within the org.
  `NULL`/absent = **0** (no allocation). Set by the org's owner/admins.

Existing rows: every current tenant gets `token_pool = NULL` + `byom_enabled = 0`, and every
membership `token_limit = NULL` — so all existing orgs (incl. `default`) keep today's behavior with
no change (SC-3).

## Functional requirements

### Entitlement — super-admin only (the contract boundary)

- **FR-600** `PUT /api/admin/tenants/:id/pool` (super-admin) sets/clears an org's `token_pool` (a
  non-negative integer, or `null` to return it to legacy). Reflects the offline contract.
- **FR-601** `PUT /api/admin/tenants/:id/byom` (super-admin) enables/disables `byom_enabled`.
- **FR-602** Neither pool nor BYOM is ever settable by an org owner/admin — they are the platform's
  side of the contract. The tenant-facing surfaces expose them **read-only**.
- **FR-603** Lowering a pool below the org's already-**allocated** sum is rejected (`400
  pool_below_allocated`) — the platform can't strand existing member budgets; the org must
  re-allocate down first.

### Allocation — org owner/admin (distribute the pool)

- **FR-610** `PUT /api/tenant/members/:userId/allowance` (`requireTenantAdmin`) sets a member's
  reserved `token_limit` (non-negative integer, or `null` to deallocate). Only valid in a pool-model
  org (pool not `NULL`); on a legacy org it is `400 no_pool`.
- **FR-611** **Reserved invariant:** the change is rejected `400 over_pool` (writing nothing) if the
  resulting **sum of all members' allowances would exceed the pool**.
- **FR-612** `GET /api/tenant` surfaces, for owner/admins: `pool`, `allocated` (sum of allowances),
  `unallocated` (`pool − allocated`), `byomEnabled`, and each member's `allowance` + `used`.

### Metering — chat (enforce the right allowance)

- **FR-620** In a **pool-model org using platform routing**, a member's effective chat limit is
  their reserved `tenant_members.token_limit` (NULL → 0), enforced against **their usage within that
  org** (`token_usage` by tenant + user). Exhausted or unallocated → the spec-039 token-quota `429`.
- **FR-621** A **BYOM org** (byom_enabled AND an active tenant LLM override, spec 042) does **not**
  consume the pool and is **not** bounded by it — platform metering records usage for observability
  but enforces no pool limit (the org pays its provider). *Platform routing* = the resolved model is
  the platform/global default; *BYOM* = the org's own LLM override is in force.
- **FR-622** A **legacy org** (`token_pool = NULL`) keeps today's behavior exactly: per-user
  `users.token_limit` → tenant/global `defaultTokenLimit` → unlimited. The `default` tenant and every
  un-entitled org are unaffected (SC-3).

### BYOM gate (extends spec 042)

- **FR-630** Setting the tenant **LLM override** (`PUT /api/tenant/settings` `llm`) requires
  `byom_enabled`; otherwise `403 byom_disabled`, writing nothing. `defaultTokenLimit` is unaffected
  (it still governs legacy orgs; in a pool-model org, per-member allocation is authoritative).
- **FR-631** The tenant settings view marks whether BYOM is enabled; the console shows the LLM
  section only when it is.

### Membership hardening (owner-on-top, admin-manages-admin)

- **FR-640** Admins may add/remove **other admins** and members (member↔admin). **Owner-only**
  actions (extending spec 036 FR-181 from PATCH to DELETE): granting/transferring `owner`, and
  **modifying or removing an owner** — an admin can no longer remove an owner (closes today's gap
  where DELETE only checked the last-owner floor). The last-owner floor and self-removal block are
  unchanged.

### Frontend

- **FR-650** Super-admin console: assign/adjust an org's **token pool** and toggle **BYOM** (a new
  super-admin org surface).
- **FR-651** Org console (extends spec 064 `Organizations`): owner/admins see **pool / allocated /
  unallocated** and set each member's **allowance**; the LLM/BYOM section appears only when
  `byom_enabled`. Members see their own allowance + usage.
- **FR-652** One typed facade per surface over `request` (spec 057), with the testable cores at 100%
  (`bun run coverage`); `.tsx` covered by typecheck + build.

## Success criteria

- **SC-1** A super-admin assigns a pool to an org; the org's admins split it into per-member budgets
  (sum ≤ pool enforced); each member's platform-routed chat is bounded by their slice; exhaustion
  429s that member alone.
- **SC-2** BYOM is off until a super-admin enables it; once on, the org can set its own model and its
  chat stops touching the pool.
- **SC-3** Every existing org (incl. `default`) and every spec-036 owner invariant is unchanged —
  the whole model is additive and opt-in per org.
- **SC-4** 100% line + function coverage; typecheck + e2e gate green.
