# Feature Specification: Tenant-scoped settings resolution

**Feature Branch**: `042-tenant-scoped-settings`
**Created**: 2026-07-03
**Status**: Draft (blocked on spec 041)
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): migration
017 repivoted `platform_settings` to `(tenant_id, key)` with a global fallback, but every caller
still reads and writes only the global row — spec 029's FR-131 per-tenant config is dead capability.

## Overview

The storage and repo layers already speak per-tenant: `PlatformSettingsRepo.get(key, tenantId)`
returns the tenant's own value with a `global` fallback. But no call site ever passes a tenant, so a
deployment cannot actually give one org its own LLM provider or default token limit. This spec wires
the existing capability through the request path and gives org admins a management surface — with an
explicit allowlist of which keys a tenant may override, and a hard rule that per-tenant settings never
expose another tenant's (or the global) secrets.

Single responsibility: **per-tenant runtime configuration is actually resolvable and manageable.**
Which org a request acts in is spec 041; this spec consumes that answer.

## Finding & evidence

- **Capability exists, unused** — `PlatformSettingsRepo.get` resolves tenant-override-then-global
  (`src/store/repos/platform-settings.ts:29-36`; `set` takes a `tenantId` defaulting to `global`,
  lines 46-59). Every caller uses the global default:
  `apps/explorer-api/src/admin/resolve-default.ts:14` (LLM default; *review said :13, actual call is
  line 14*), `apps/explorer-api/src/routes/admin.ts:36,60,122` (reads) and `:129,131` (writes), and
  `apps/explorer-api/src/app.ts:159` (toggles). None passes the request's tenant, so spec 029 FR-131
  (per-tenant portal/LLM/quota policy) is unreachable at the API layer.
- **Upside worth preserving** — today no cross-tenant secret leak is possible *because* tenants never
  read settings at all, and the super-admin view masks the LLM API key
  (`routes/admin.ts:26-57` via `maskApiKey`; `mergeSecret` treats an empty key as "keep existing",
  `admin.ts:127`). Turning per-tenant settings on MUST NOT regress this: tenant-facing surfaces must
  never return the global (or any other tenant's) secret material.
- **Hard dependency** — resolution requires knowing the request's active tenant. Spec **041** provides
  that; until it lands, every human request's tenant is `default` and this spec is **blocked** (it
  would only ever resolve one org's overrides).

## Requirements

- **FR-240**: Runtime resolution on the chat and gated read paths MUST go through the active tenant:
  the chat's default LLM provider (`resolveServerDefault`) and the platform toggles are looked up as
  `settings.get(key, activeTenantId)` — tenant override wins, `global` remains the fallback. The
  metering defaults consumed per-tenant (e.g. `defaultTokenLimit`) resolve the same way.
- **FR-241**: Tenant-overridable keys MUST be an explicit **allowlist**, defined in one place:
  the LLM provider setting (`LLM_SETTING_KEY`) and `defaultTokenLimit` are overridable;
  platform-wide toggles and the API rate/quota knobs (`apiRate*`, `apiQuota*`) are **not** —
  they are deployment policy and stay global-only. Writes of a non-allowlisted key to a tenant row
  are rejected.
- **FR-242**: Org admins get a management surface for their own org's overrides
  (`GET/PUT /api/tenant/settings`, behind `requireTenantAdmin`): view which allowlisted keys are
  overridden vs inherited, set an override, and clear one (falling back to global). Secret fields use
  the same mask/merge treatment as the super-admin surface (masked on read; empty = keep).
- **FR-243**: Isolation invariant: no tenant-facing response may contain another tenant's or the
  global row's secret values — a tenant that has NOT overridden the LLM key sees only "inherited"
  plus non-secret fields of the effective config, never the global `apiKey` (masked or otherwise
  derivable). Fallback resolution happens server-side only.
- **FR-244**: A super-admin MUST be able to view and clear any tenant's overrides (extending
  `/api/admin/tenants`), so a misconfigured org can be recovered without SQL.
- **FR-245**: A tenant with no overrides MUST behave exactly as today (global row only) — including
  the `default` tenant, protecting spec 029 SC-C2.

## Success criteria

- **SC-1**: Two orgs in one deployment chat through different LLM configs: org A sets its own
  provider, org B inherits the global one; each turn resolves per the caller's active org
  (integration test across the boundary).
- **SC-2**: Org A's admin can never read org B's or the global LLM `apiKey` through any tenant-facing
  endpoint — asserted by an authorization test, including the inherited-config view (FR-243).
- **SC-3**: Overriding a non-allowlisted key (e.g. a platform toggle) via `/api/tenant/settings` is
  rejected with a 4xx and writes nothing.
- **SC-4**: With zero tenant rows present, all existing settings/chat tests pass unchanged (FR-245).

## Out of scope / dependencies

- **Blocked on spec 041** (active-tenant resolution); without it this spec cannot ship.
- Storage/repo pivot — done in spec **029** (migration 017); this spec adds no schema.
- Per-tenant *portal/mirror* selection (which data substrate a tenant sees) — the larger half of 029
  FR-131 — stays deferred with 029's substrate note.
- Plan-derived defaults (`tenants.plan`) — deferred with spec **040** FR-224.
