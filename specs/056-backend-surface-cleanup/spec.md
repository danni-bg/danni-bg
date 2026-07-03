# Feature Specification: Backend surface cleanup (wire or delete)

**Feature Branch**: `056-backend-surface-cleanup`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the backend
carries dead options, misnamed errors, unwired toggles, and inconsistent API affordances.

## Overview

Every option the backend exposes must either do what it implies or not exist. This spec gives each
finding an explicit **wire** or **delete** verdict: dead plumbing (`lang`, `freshnessSloSeconds`
toggle, `schedule.timezone`, `onOverlap:'queue'`, dead exports) is removed; the one genuinely useful
unwired affordance (`chatEnabled` — a kill-switch for the gated LLM feature) is wired; naming and
API-surface inconsistencies (error class name, pagination, mount coupling, versioning) are settled.

Single responsibility: **no dead or inconsistent backend affordances — every option is wired or deleted.**

## Finding & evidence

- (a) `lang` is plumbed through four layers and never read: declared `src/index/query.ts:52`, exposed
  in the MCP tool schema (`src/mcp/server.ts:60-72,81`), forwarded by `ReadBridge.search`
  (`apps/explorer-api/src/read-bridge.ts:295-304`) and the chat `mirrorSearch` tool
  (`apps/explorer-api/src/chat/tools.ts:58,74`) — no line of `query.ts` uses `opts.lang`.
- (b) `chatEnabled` is validated (`apps/explorer-api/src/admin/settings-schema.ts:23`) but never
  consulted anywhere — the admin toggle that implies "disable chat" cannot disable chat.
- (c) `freshnessSloSeconds` toggle (`settings-schema.ts:22`) likewise has zero readers (verified:
  only the schema file mentions it) and duplicates `config.store.freshnessSloSeconds`, which is what
  the server actually threads through (`server.ts`, `read-bridge.ts`).
- (d) `schedule.timezone` (`src/config/schema.ts:76`, default `Europe/Sofia`) is only ever printed
  (`src/cli/schedule.ts:27`); `nextFire` computes in process-local time (`src/schedule/cron.ts:73-76`)
  — the option silently lies when server TZ ≠ configured TZ.
- (e) `onOverlap:'queue'` is indistinguishable from `'skip'`: both branches throw
  `LockContentionError` (`src/manifest/sync-run.ts:75-81`; the comment admits it). Also referenced in
  `src/schedule/scheduler.ts`, `docs/ARCHITECTURE.md`, and spec-005 docs.
- (f) `CkanApiError` (`src/lib/errors.ts:24-31`, code `CKAN_API_ERROR`) is thrown by the non-CKAN
  egov client (`src/crawler/egov-bg-client.ts:59,67`) and the generic `PortalHttp`
  (`src/crawler/http.ts:125,133`) as well as the real CKAN client (`ckan-client.ts:68,78`) — misnamed.
- (g) Dead exports: `upsertEmbeddingFor` (`src/index/vec.ts:34-48`) has **zero** callers — not even a
  unit test (stronger than the review's claim); `vecVersion` (`src/store/db.ts:56-60`) has zero callers.
- (h) Pagination is inconsistent: `/api/datasets` has `limit`/`offset`/`total`
  (`apps/explorer-api/src/app.ts:359-383`), but `/api/me/sessions` is a fixed `LIMIT 100` with no
  paging (`apps/explorer-api/src/chat/sessions-repo.ts:136-143`), and admin `/usage`, `/tenants`,
  `/api-usage` return unbounded full-table lists (`src/store/repos/token-usage.ts:106` `summaryByUser`,
  `src/store/repos/tenants.ts:61` `listAll`, `api-usage` summaries).
- (i) All of `/api/me/*` — API-key management, chat sessions, generation resume, avatar — mounts only
  `if (ctx.tokenUsage)` (`app.ts:228-243`), because `meRoutes` takes the usage repo as a required
  positional argument; unrelated features are coupled to token metering being wired.
- (j) No `/api/v1` prefix, yet the read API is now publicly advertised with keys/quotas (specs
  027/028) — the compatibility posture is undocumented.

## Requirements

- **FR-385**: **Delete** the `lang` plumbing end-to-end: `QueryOptions.lang` + the `Lang` type export
  (query.ts:52), the MCP schema field + forwarding (mcp/server.ts:60-72,81), the `ReadBridge.search`
  parameter (read-bridge.ts:295-304), and the chat-tool schema field (tools.ts:58,74). i18n search
  returns only with a real language-aware ranker.
- **FR-386**: **Wire** `chatEnabled`: when the resolved toggle is `false`, `POST /api/chat` MUST
  refuse before any model/quota work with a clear typed error (e.g. 503 `{ code: 'chat_disabled' }`),
  read at request time so flipping the admin toggle takes effect without restart. Default (unset)
  remains enabled.
- **FR-387**: **Delete** the `freshnessSloSeconds` toggle from `togglesSchema` (settings-schema.ts:22)
  and from the admin settings UI; `config.store.freshnessSloSeconds` remains the single owner.
  (Re-verified: no reader exists, so this is a pure schema/UI removal.)
- **FR-388**: **Delete** `schedule.timezone` from `ScheduleConfigSchema` (config/schema.ts:76) and the
  `tz='…'` fragment of `danni schedule show` (cli/schedule.ts:27); document in the config reference
  that cron fires in **server-local time**. Existing configs carrying the key MUST fail loudly
  (strict schema) with a message naming the removal — silent ignoring is not acceptable.
- **FR-389**: **Delete** `'queue'` from the `onOverlap` enum (config/schema.ts) until real queueing
  exists; `sync-run.ts:75-81` keeps the single `LockContentionError` throw, and
  `docs/ARCHITECTURE.md` + scheduler references are updated. A config with `onOverlap:'queue'` MUST
  produce a clear validation error suggesting `'skip'`.
- **FR-390**: **Rename** `CkanApiError` → `PortalApiError` (error code `PORTAL_API_ERROR`), updating
  all throw/catch sites (`ckan-client.ts`, `egov-bg-client.ts`, `http.ts`). Verified: no importers
  outside `src/`, but since the repo is now published (EUPL open-core), keep a deprecated
  `CkanApiError = PortalApiError` alias export for one release.
- **FR-391**: **Delete** the dead exports `upsertEmbeddingFor` (vec.ts:34-48, superseded by the batch
  embed path) and `vecVersion` (db.ts:56-60), plus any helpers that become unreferenced as a result.
  (The `loadVec` default decision belongs to **spec 050** — referenced, not duplicated here.)
- **FR-392**: **Wire** consistent pagination on the growing surfaces: `GET /api/me/sessions`, admin
  `GET /usage`, `GET /tenants`, and `GET /api-usage` MUST accept `limit`/`offset` (with a documented
  default and hard cap, matching `/api/datasets`' `clampInt` semantics) and return `total`. Repo
  methods (`listForUser`, `summaryByUser`, `listAll`, usage summaries) grow bounded variants; no
  endpoint may return an unbounded full-table list.
- **FR-393**: **Decouple** the `/api/me` mount from token metering: `meRoutes` MUST accept the usage
  repo as optional (like its other deps) and mount unconditionally (app.ts:228-243), with `/usage`
  returning a clear "metering not configured" response when absent. API keys, sessions, generations,
  and avatar MUST work in a deployment without `tokenUsage`.
- **FR-394**: **Decide versioning explicitly**: commit to `/api` as **v1-implicit** — no `/v1` prefix
  now (avoids breaking every existing client, SPA, and MCP consumer for zero functional gain) — and
  document the compatibility promise in the API docs: additive changes only under `/api`; any
  breaking change introduces `/api/v2` alongside. Revisit only at a real break.

## Success criteria

- **SC-1**: `grep -rn "lang" src/index/query.ts src/mcp/server.ts apps/explorer-api/src/read-bridge.ts
  apps/explorer-api/src/chat/tools.ts` shows no search-language plumbing; MCP tool listing no longer
  advertises `lang`.
- **SC-2**: With `chatEnabled:false` set via `PUT /api/admin/settings`, the next `POST /api/chat`
  returns the typed refusal without any LLM call; setting it back re-enables without restart
  (integration test).
- **SC-3**: Config validation rejects `schedule.timezone` and `onOverlap:'queue'` with actionable
  messages; `togglesSchema` rejects `freshnessSloSeconds` (it is `.strict()`).
- **SC-4**: No occurrence of `CkanApiError` outside the alias line; `upsertEmbeddingFor`/`vecVersion`
  are gone and `bun test` + typecheck stay green.
- **SC-5**: Every list endpoint under `/api/me` and `/api/admin` honors `limit`/`offset` and returns
  `total` (contract tests); a store seeded past the cap never returns more than the cap.
- **SC-6**: An app built without `tokenUsage` serves `/api/me/api-keys` and `/api/me/sessions`
  normally (regression test), and the documented v1-implicit compatibility promise exists in the API
  docs.

## Out of scope / dependencies

- Merging live duplicated code (parseBody, sync epilogue, isStale, requireAuth composition) —
  **spec 055**; FR-393's `meRoutes` signature change should land after 055's auth-gate factory to
  avoid churn.
- `loadVec` runtime default — **spec 050**.
- Real sync-run queueing (would reintroduce `onOverlap:'queue'`) and true i18n search ranking —
  future specs.
- Admin settings substrate is **spec 019**; per-tenant settings composite is **spec 029**
  (`chatEnabled` resolution follows the existing tenant→global fallback).
