# Feature Specification: Request quota & rate-limit semantics

**Feature Branch**: `040-request-quota-semantics`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the
spec-028 request quota compares a per-user count against a per-key limit that nothing can set, and
the two metering gates disagree on what counts as a request.

## Overview

Spec 028's public-API gate mixes attribution units: the quota cap can come from a single key
(`quota_limit`) while the usage count and the rate bucket aggregate across **all** keys of the
owning user. The per-key override itself is dead — no code path writes `quota_limit`. And the two
gates record usage at different points relative to their checks, so "one request" means different
things on the data and chat routes. This spec pins down the principal, makes the limit settable, and
defines one recording semantic.

Single responsibility: **request quotas and rate limits attribute to a well-defined principal with a
settable limit.** Token metering is specs 021/039; who the tenant is, is spec 041.

## Finding & evidence

- **Mixed attribution** — `apps/explorer-api/src/middleware/api-metering.ts:104-116`: the cap is
  `res.key.quota_limit ?? quotaData()` (per-key, line 110), but `owner = res.key.user_id` (line 104)
  keys both the rate bucket (`${owner}:data`, line 105) and the quota count
  (`deps.usage.countSince(owner, …)`, lines 112-116). `ApiUsageRepo.countSince`
  (`src/store/repos/api-usage.ts:47-59`) counts by `principal_id` — i.e. all the owner's keys
  together. A key with `quota_limit = 1000` is throttled by traffic on the owner's *other* keys.
- **Unsettable override** — `quota_limit` exists only as a read-only column
  (`src/store/repos/api-keys.ts:29`, from migration 015): no repo method writes it (`create` at
  `api-keys.ts:80-112` never sets it, there is no update method) and no route touches it. The
  spec-028 per-key override is unreachable except by manual SQL.
- **Inconsistent recording semantics** — *correction to the review finding:* **both** gates record
  before the handler runs, not just `chatMeter`. `chatMeter` records after only the rate-limit check
  (`api-metering.ts:51-62`), so a request the handler then rejects (400 invalid body, or the spec-021
  token-quota 429 in `routes/chat.ts:80-96`) still counts and still consumed a rate token.
  `dataApiGate` records after auth + scope + rate + quota checks (`api-metering.ts:125-136`) but also
  before `await next()`. The real inconsistency is *which gate checks precede the record*, and neither
  route documents whether handler-level failures count.
- **Quota 429 without retry hint** — the request-quota rejection (`api-metering.ts:117-123`) has a
  fully computable rolling window (`quotaWindowSec`) yet sets no `Retry-After`, unlike the rate-limit
  429 four lines up (`api-metering.ts:35-38`).
- **`tenants.plan` drives nothing** — it is stored (`src/store/repos/tenants.ts:41-48`) and echoed
  (`apps/explorer-api/src/routes/tenant.ts:41`) but no limit, rate, or quota reads it.

## Requirements

- **FR-220**: The quota and rate-limit attribution unit for keyed data-API traffic MUST be the **API
  key**: the rate bucket is keyed by `key.id` and the quota count filters `api_usage` by `key_id`,
  so a per-key cap compares against that key's own usage. (User- and tenant-level rollups remain
  view-layer concerns.)
- **FR-221**: `quota_limit` MUST be settable and clearable through a supported path: an `ApiKeyRepo`
  update method plus a super-admin route (per-key limits are billing policy — key owners MUST NOT set
  their own). The effective limit (own vs plan default) MUST be visible wherever the key is listed.
- **FR-222**: One recording semantic MUST hold on both gates: a request is counted iff it is admitted
  past its gate (auth + scope + rate + quota all passed); handler-level outcomes (400/404/5xx, or the
  chat token-quota 429) still count and this MUST be stated in the middleware docs. `chatMeter` MUST
  move its record after the same class of gate checks as `dataApiGate` so the two agree.
- **FR-223**: The request-quota 429 MUST set `Retry-After` derived from the rolling window
  (`quotaWindowSec`), matching the existing rate-limit 429 behavior.
- **FR-224**: `tenants.plan` MUST be explicitly deferred: it maps to no runtime limits until a
  dedicated pricing/plans spec; the deferral is documented on the column and in the tenant route so
  the field is not mistaken for enforcement. (Recommended follow-on: a plans spec that resolves
  default rate/quota/token limits from `plan`.)

## Success criteria

- **SC-1**: Two keys of one user, one with `quota_limit`, meter independently: exhausting key A does
  not 429 key B, and key B's cap counts only key B's requests (integration test).
- **SC-2**: A super-admin can set, change, and clear a key's `quota_limit` via the API and the new
  cap takes effect on the next request — no SQL required.
- **SC-3**: For any request on either gated route, whether it incremented `api_usage` is predictable
  from the gate outcome alone; a table-driven test covers admitted-then-handler-rejected cases on
  both routes.
- **SC-4**: A request-quota 429 carries a `Retry-After` consistent with the configured window.

## Out of scope / dependencies

- Token (LLM) metering integrity — spec **039**. Key CRUD/scopes — spec **027**. Gate/middleware
  origin — spec **028** (this spec amends its semantics).
- Which tenant usage attributes to (active-org resolution) — spec **041**; per-tenant limit
  *configuration* — spec **042**.
- A pricing/plans model giving `tenants.plan` teeth — deferred to a future spec (FR-224).
