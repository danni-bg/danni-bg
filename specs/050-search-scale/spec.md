# Feature Specification: Search path at corpus scale

**Feature Branch**: `050-search-scale`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the hybrid
search hot path re-deserializes the entire embedding corpus on every query and the explorer search
route fans out a full per-dataset view per hit — neither survives the real ~12k-dataset deployment.

## Overview

Make the shared search path (`src/index/query.ts`, consumed by the explorer API via `ReadBridge`,
by every chat `mirrorSearch` tool call, and by the MCP `mirror_search` tool) scale to the full
production corpus (~12k datasets × 4096-dim f32 vectors ≈ 190 MB of embeddings), and make the two
halves of the `IndexEntry` contract (`search` vs `searchByEntity`) agree.

Single responsibility: **the search path scales to the full corpus with a consistent result
contract.** Ranking quality (RRF weights, embedder choice) is unchanged; MCP/chat capability parity
is spec 053.

## Finding & evidence

- **(a) Full-corpus deserialization per query.** `search()` calls `listEmbeddings(opts.db)` on every
  invocation (`src/index/query.ts:117`); `listEmbeddings` (`src/index/embeddings-store.ts:52-65`)
  SELECTs every row of `dataset_embeddings` and **copies** each BLOB into a fresh `Float32Array`
  (`buffer.slice`). At production scale that is ~190 MB allocated + a full-scan cosine
  (`query.ts:122-127`) per query. This is the hot path for `GET /api/datasets?query=…`
  (`apps/explorer-api/src/app.ts:368`), every chat `mirrorSearch` call
  (`apps/explorer-api/src/read-bridge.ts:295-304`, `apps/explorer-api/src/chat/tools.ts:74` — geo
  scopes over-fetch 200), and MCP `mirror_search` (`src/mcp/server.ts:76`). Direction: an in-process
  vector-matrix cache invalidated via `embeddings_meta.updated_at` (already bumped by
  `setEmbeddingsMeta`, `src/index/run-index.ts:214`), or wire the `sqlite-vec` `vec0` virtual table
  (`docs/ARCHITECTURE.md:222` calls it "a future upgrade for large corpora").
- **(b) `loadVec: true` default is an unused footgun.** `openDb` defaults `loadVec` to true and
  throws when the vendored binary is absent (`src/store/db.ts:38-46`) — and the binary IS absent:
  `vendor/sqlite-vec/{linux-x64,…}/` contain no files (only `README.md`). All 12 production call
  sites (11 CLI commands + `apps/explorer-api/src/server.ts:66`) and every test pass
  `loadVec: false`. `vecVersion()` (`src/store/db.ts:56`) has zero production callers — its only
  caller is a conditional branch of a unit test (`tests/unit/store/db.test.ts:48`) that never runs
  in this repo state. Default to `false` (or delete the vec plumbing) — fold the decision into
  whichever direction (a) takes.
- **(c) Per-hit view fan-out on the explorer search route.** `GET /api/datasets?query=…` calls
  `bridge.search(query, undefined, 200)` then `ctx.bridge.view(hit.datasetId)` **per hit**
  (`apps/explorer-api/src/app.ts:368-375`) — up to 200 full ~7-query dataset views per request,
  resurrecting exactly the fan-out `ReadBridge.listLite()` was built to kill for the no-query path
  (`app.ts:378`).
- **(d) `IndexEntry` contract split.** `searchByEntity` hardcodes `title.en: null` and
  `publisher: null` (`src/index/query.ts:218-219`) while `search()` resolves both from
  `TranslationsRepo`/`OrganizationsRepo` (`query.ts:157-187`). Entity-sourced results (map region
  clicks, chat `mirrorEntitySearch`, geo-scope backfill in `chat/tools.ts:84`, MCP
  `mirror_entity_search`) silently lose the EN title and publisher the same UI renders for hybrid
  results.

## Requirements

- **FR-320**: A `search()` call MUST NOT re-read or re-copy the full embedding corpus. The semantic
  leg MUST be served either by an in-process vector cache (one resident copy, reused across
  queries) or by a `vec0` ANN index; per-query allocation MUST be O(candidates), not O(corpus).
- **FR-321**: The cached/indexed vectors MUST be invalidated by index runs: after `danni index`
  updates embeddings (which bumps `embeddings_meta.updated_at`), the next search MUST reflect the
  new vectors without a process restart. A stale-check MUST cost O(1) per query.
- **FR-322**: `openDb` MUST NOT load the sqlite-vec extension unless explicitly requested
  (`loadVec` defaults to `false`), or the vec plumbing (`loadVec`, `vecVersion`) MUST be removed —
  whichever matches the FR-320 direction. Opening a store MUST NOT fail on a missing vendored
  binary that no caller asked for.
- **FR-323**: The explorer search route MUST resolve search hits through a bulk projection (one
  bounded set of queries for all hits, per the `listLite` pattern) instead of a per-hit
  `bridge.view()` fan-out; the response shape (`DatasetPointer` + filter semantics) is unchanged.
- **FR-324**: `searchByEntity` MUST populate `title.en`/`translator`/`translationConfidence` and
  `publisher` by the same resolution rules as `search()`, so every producer of `IndexEntry`
  honors one contract. `matchedEntities` stays entity-search-only (optional field).
- **FR-325**: An automated check (perf test or instrumented counter) MUST fail if the full-corpus
  deserialization regresses (e.g. asserts `listEmbeddings` — or its replacement — is not invoked
  per query at steady state).

## Success criteria

- **SC-1**: At a 12k × 4096-dim corpus, steady-state query throughput allocates no per-query
  full-corpus copy; N repeated searches perform ≤1 corpus load (measured via counter or heap
  delta), and search p95 stays within the explorer's existing latency budget.
- **SC-2**: `GET /api/datasets?query=…` returning 200 hits executes a bounded number of SQL
  statements independent of hit count (parity with the no-query `listLite` path).
- **SC-3**: A region/entity result and a hybrid-search result for the same dataset render the same
  EN title and publisher (contract test over both `search` and `searchByEntity`).
- **SC-4**: Re-running `danni index` with changed embeddings is visible to the next search in the
  running explorer/MCP process; `openDb` succeeds on a clean checkout for every CLI and the server
  without the vendored binary.

## Out of scope / dependencies

- Ranking changes (RRF constants, candidate depth, embedder choice) — specs 002/006 territory.
- MCP/chat capability parity → **spec 053**; the shared substrate change here benefits both.
- Grid/list filtering semantics (specs 009/010) unchanged; 023's `expandGeoUnitIds` unaffected.
- Adopting `vec0` for true ANN is an allowed implementation of FR-320, not a requirement; if not
  adopted, FR-322 removes the dead plumbing instead.
