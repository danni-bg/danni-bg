# Feature Specification: Backend DRY consolidation

**Feature Branch**: `055-backend-dry-consolidation`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): six backend
idioms are copy-pasted across routes, sync orchestrators, and read paths instead of shared.

## Overview

Pure refactor: converge each repeated backend idiom onto one shared implementation, with zero behavior
change. Every duplicate is a place where a future fix lands once and misses the copies — the
`requireAuth` divergence in `routes/auth.ts` is already a live inconsistency, not just a smell.

Single responsibility: **one shared implementation per repeated backend idiom.**

## Finding & evidence

- **Body-parse boilerplate ×8.** The `try { await c.req.json() } catch → 400` + `safeParse → 400`
  block is copied verbatim 7× — `apps/explorer-api/src/routes/me.ts:68-78,123-133`,
  `routes/admin.ts:100-119,159-169,200-210`, `routes/tenant.ts:56-66,77-87` — plus an eighth variant
  (`schema.parse` inside try/catch) at `routes/chat.ts:62-69`.
- **Sync-runner epilogue duplicated verbatim** between the two portal orchestrators: the
  `summaryOutcome` ternary (`src/crawler/run-sync.ts:221-226` vs `run-egov-sync.ts:140-145`), the
  notifier dispatch block (`run-sync.ts:230-256` vs `run-egov-sync.ts:153-179`), and the
  `LockContentionError`-rethrow/abort tail (`run-sync.ts:275-281` vs `run-egov-sync.ts:190-196`).
  The prelude (`beginSyncRun`) and `failureRate` are already shared from `src/manifest/sync-run.ts`;
  only the epilogue diverged.
- **Staleness computation ×5.** `(Date.now() - new Date(ts).getTime()) / 1000 > slo` appears at
  `src/index/query.ts:194` and `:237`, `src/read/dataset-view.ts:101-104`,
  `apps/explorer-api/src/read-bridge.ts:210`, and `apps/explorer-api/src/server.ts:41`.
  `src/lib/time.ts` already holds the time helpers (`diffSeconds`, `parseIso`) but no `isStale`.
- **Three near-identical LLM-config shapes:** `llmSettingSchema`
  (`apps/explorer-api/src/admin/settings-schema.ts:11-16`), `providerConfigSchema`
  (`apps/explorer-api/src/chat/providers.ts:12-21`), and the hand-written `ServerDefault` interface
  (`providers.ts:23-28`) — same `kind`/`model`/`baseUrl`/`apiKey` core, three definitions to keep in
  sync (e.g. adding a provider kind must touch all three).
- **`requireAuth` wired 5× with inconsistent arguments:** `routes/me.ts:60`, `routes/admin.ts:93`,
  `routes/tenant.ts:29`, and `app.ts:210` pass `(users, sessionResolver, apiKeys, tenants)`, but
  `routes/auth.ts:18` passes only `(users, resolveSession)` — an API key hitting `/api/auth/*` gets a
  generic session 401 instead of the key-aware handling every other gated route gives it.
- **Duplicate pointer projection:** the private `pointer()` in
  `apps/explorer-api/src/chat/tools.ts:26-36` re-implements `viewToPointer`
  (`apps/explorer-api/src/read-bridge.ts:37-53`) minus `translationConfidence`/`tags`/`geoEntityIds`.
  A pointer-shape change (e.g. a new freshness field) lands in one and silently misses the other.

## Requirements

- **FR-370**: A shared `parseBody(c, schema)` helper (home: new
  `apps/explorer-api/src/middleware/parse-body.ts` or equivalent) MUST return either the typed parsed
  value or the standard `{ error: { code: 'bad_request', … } }` 400 response, and all eight call
  sites (`me.ts:68-78,123-133`, `admin.ts:100-119,159-169,200-210`, `tenant.ts:56-66,77-87`,
  `chat.ts:62-69`) MUST use it. Per-site error messages (and `admin.ts`'s `details` flatten) stay
  expressible via options.
- **FR-371**: A shared `finalizeSyncRun(handle, totals, datasetEntries, { db, notifier, config })`
  (home: `src/manifest/sync-run.ts` or `src/crawler/portal-sync.ts`, next to the already-shared
  prelude) MUST own the `summaryOutcome` ternary, `handle.end(…)`, and the `run_failed` /
  `threshold_exceeded` notifier dispatch, and both orchestrators (`run-sync.ts:221-256`,
  `run-egov-sync.ts:140-179`) MUST call it. Only the run-specific summary string (`'sync run
  failed'` vs `'egov sync run failed'`) is parameterized.
- **FR-372**: The catch tail (rethrow `LockContentionError`, otherwise `handle.abort(message)` and
  rethrow) MUST exist once — e.g. a `guardSyncRun(handle, fn)` wrapper in the same home as FR-371 —
  replacing `run-sync.ts:275-281` and `run-egov-sync.ts:190-196`.
- **FR-373**: `src/lib/time.ts` MUST export `isStale(lastSyncedAt, sloSeconds, now?)` and the five
  occurrences (`query.ts:194,237`, `dataset-view.ts:101-104`, `read-bridge.ts:210`, `server.ts:41`)
  MUST call it. The `now` parameter preserves `listLite`'s single-timestamp batch behavior
  (`read-bridge.ts:209-210`) and makes the helper unit-testable without clock mocking.
- **FR-374**: One canonical LLM-provider shape MUST exist, with the other two derived from it:
  `llmSettingSchema` (settings-schema.ts:11-16) becomes the base zod object, `providerConfigSchema`
  (providers.ts:12-21) extends it with `useServerDefault`, and `ServerDefault` (providers.ts:23-28)
  is a type derived from the base (nullable→optional mapping allowed). Adding a provider `kind` MUST
  require exactly one edit.
- **FR-375**: `requireAuth` MUST be composed at one point — a factory (e.g. `authGate(ctx)` built
  once in `app.ts` and passed to the route modules) — so every gated router receives the identical
  argument set. `routes/auth.ts:18` MUST gain `apiKeys`/`tenants`, giving API keys on `/api/auth/*`
  the same key-aware handling (and 403-vs-401 semantics) as every other route.
- **FR-376**: The chat tools MUST reuse the shared pointer projection: `chat/tools.ts:26-36`
  `pointer()` is deleted in favor of `viewToPointer` (read-bridge.ts:37-53), or of an explicit
  documented pick over it if the chat payload must stay minimal for context-size reasons. Either
  way there is exactly one place that maps a view to a pointer shape.
- **FR-377**: The consolidation MUST be behavior-preserving: identical HTTP responses (status codes,
  error bodies), identical run manifests/notifications, and identical search/list payloads. Existing
  tests keep passing unmodified except where they asserted on now-shared internals; each new helper
  gets its own unit test.

## Success criteria

- **SC-1**: `grep -rn "await c.req.json()"` under `apps/explorer-api/src/routes` returns only the
  shared helper; no route file contains its own try/catch JSON-parse block.
- **SC-2**: The epilogue (`summaryOutcome` ternary + notifier dispatch + abort tail) exists in exactly
  one module; `run-sync.ts` and `run-egov-sync.ts` contain no `dispatchAndPersist` or
  `LockContentionError` catch of their own.
- **SC-3**: The staleness expression `new Date(…).getTime()) / 1000 >` appears only in
  `src/lib/time.ts`; all five former sites call `isStale` and existing freshness tests pass.
- **SC-4**: An API key calling `/api/auth/callback` receives the same key-aware response class as on
  other gated routes (regression test across the five mounts), and adding a hypothetical provider
  kind is a one-line schema change verified by a type-level test.
- **SC-5**: Full suite (`bun test`) green with no snapshot/response-shape diffs.

## Out of scope / dependencies

- Wiring or deleting *unused* affordances (dead `lang` plumbing, `chatEnabled`, dead exports) —
  that is **spec 056** (surface cleanup); this spec only merges live duplicates.
- Pagination/versioning consistency of the API surface — **spec 056**.
- The `loadVec` default decision — **spec 050**.
- Builds on the route/middleware structure of **specs 019/027/028/029**; no schema or contract
  changes.
