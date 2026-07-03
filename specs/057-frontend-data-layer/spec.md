# Feature Specification: Frontend server-state layer

**Feature Branch**: `057-frontend-data-layer`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the SPA
has no server-state layer — ~10 hand-rolled fetch effects, three API-client conventions, and core
data fetches that swallow every error into a plausible empty state.

## Overview

Give the SPA one way to fetch, cache, and surface server state. Today each component re-implements
the load/cancel/loading/error lifecycle by hand, three `lib/*Api.ts` modules re-implement the HTTP
convention, and the most important fetches (map regions, dataset list, facets) discard failures —
an API outage renders as "no data", which for an open-data portal is a trust bug, not a style issue.

Single responsibility: **one way to fetch, cache, and surface server state — including its
failures.** Chat streaming (SSE) is explicitly not server state and stays in spec 058's layer.

## Finding & evidence

- **~10 hand-rolled `fetch` + `useEffect` + cancelled-flag blocks**, no caching/retry/dedup:
  `apps/explorer-web/src/App.tsx:80-95` (two region layers) and `:98-115` (dataset list, plus the
  `loadMore` variant at `:117-124`), `filters/FilterPanel.tsx:68-76`, `datasets/DatasetDetail.tsx:33-48`,
  `datasets/ResourcePreview.tsx:92-104`, `account/SelfUsage.tsx:13-21`, `account/ApiKeys.tsx:26-34`,
  `admin/AdminUsage.tsx:16-28`, `admin/SettingsPage.tsx:41-45`. Seven separate `'Зареждане…'`
  strings render the same state (`AdminUsage.tsx:43`, `ResourcePreview.tsx:161`, `guards.tsx:8`,
  `ApiKeys.tsx:127`, `SelfUsage.tsx:36`, `KratosFlow.tsx:481,546`).
- **Three API-client modules, two conventions.** `lib/api.ts:24-28` has a typed `getJson<T>` helper;
  `lib/meApi.ts` (10×) and `lib/adminApi.ts` (5×) hand-roll `fetch → if (!res.ok) throw → res.json()`
  ~15×, each repeating `credentials: 'include'` and the JSON headers.
- **Core fetches swallow ALL errors.** `.catch(() => undefined)` at `App.tsx:86,91,108,123` and
  `FilterPanel.tsx:72` turns an API outage into the plausible empty state
  `'Няма набори от данни за текущия изглед.'` (`datasets/DatasetList.tsx:16`) and an empty facet
  panel — indistinguishable from a genuinely empty mirror.
- **Admin actions discard rejections.** `admin/AdminUsage.tsx:30-40` (`saveLimit`/`reset`) have no
  try/catch and their click handlers fire `void saveLimit(r)` / `void reset(r)`
  (`AdminUsage.tsx:102,112`) — a failed save is an unhandled rejection and the table silently keeps
  the stale value.
- **The correct pattern already exists in-tree:** `DatasetDetail.tsx:42-44` and
  `ResourcePreview.tsx:100` set a dedicated error state and render a distinct message
  (`'Грешка при зареждане на набора.'`) — this is the pattern to generalize, not invent.

## Requirements

- **FR-400**: A single shared `request<T>(path, { method?, body?, params?, authed? })` helper MUST
  own the HTTP convention (URL building via the existing `buildUrl`, JSON headers,
  `credentials: 'include'` when `authed`, non-OK → typed error). The `lib/api.ts`, `lib/meApi.ts`,
  and `lib/adminApi.ts` facades keep their typed signatures but MUST all delegate to it; no
  hand-rolled `fetch → !res.ok → json` block remains in `lib/`.
- **FR-401**: One `useQuery`-style hook (e.g. `useServerState(key, loader)`) MUST own the fetch
  lifecycle: loading flag, error state, data, cancellation on unmount/key-change, and in-flight
  dedup of identical keys. **Recommendation: a small in-house hook**, not TanStack Query — the app
  has ~10 GET call sites, no mutations-with-invalidation graph, and a constitution that prizes pure
  tested `lib/*`; a dependency is not yet earned. Re-evaluate if cross-view caching or optimistic
  updates arrive (record the decision in the plan).
- **FR-402**: All fetch-effect blocks listed in the finding MUST be converted to the hook; no
  component under `apps/explorer-web/src` declares its own `cancelled`/`active` flag for a plain
  GET.
- **FR-403**: Every view MUST distinguish "loaded empty" from "failed": `.catch(() => undefined)`
  on data the view renders is eliminated. On failure the map region layers, dataset list, and facet
  panel MUST show an error affordance (message + retry) instead of the empty state; the wording
  follows the existing `DatasetDetail` pattern.
- **FR-404**: Admin limit/reset actions (`AdminUsage.tsx:30-40,102,112`) MUST surface failure to
  the admin (inline error, input keeps the attempted value) and MUST NOT produce unhandled
  rejections.
- **FR-405**: The loading affordance MUST be shared (one component or one hook-provided state
  rendered consistently) so the seven duplicated `'Зареждане…'` paragraphs collapse to one
  definition.
- **FR-406**: The change is behavior-preserving on the happy path: identical requests (URLs,
  params, credentials), identical rendered data. The hook and `request` helper get unit tests
  (`bun:test`), including cancellation and error-propagation cases.

## Success criteria

- **SC-1**: With the API stopped, the SPA shows error + retry affordances for regions, dataset
  list, and facets — grep-level check: `grep -rn "catch(() => undefined)" apps/explorer-web/src`
  returns nothing.
- **SC-2**: `grep -rn "credentials: 'include'" apps/explorer-web/src/lib` matches only the shared
  helper; `grep -rn "Зареждане…"` matches only the shared affordance (plus KratosFlow until spec
  060 extracts the account page).
- **SC-3**: A failed admin limit save shows an error and leaves no unhandled promise rejection in
  the console (regression test with a mocked failing `setUserLimit`).
- **SC-4**: Hook unit tests cover: success, error, unmount-cancellation, key-change refetch, and
  in-flight dedup; full suite (`bun test`) stays green.

## Out of scope / dependencies

- Chat SSE streaming and resume lifecycle — **spec 058** (different transport, not request/response
  server state).
- Sharing the payload *types* the helper returns — **spec 059**; this spec only unifies transport.
- Moving dataset selection into the store, dead exports, formatting helpers — **spec 060**.
- Builds on the auth/session conventions of **specs 019/027** (cookie-authed `/api/me/*`,
  `/api/admin/*`); no API contract changes.
