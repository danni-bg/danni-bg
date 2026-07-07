# Feature Specification: Store operational safety (concurrent writers + backup/restore)

**Feature Branch**: `043-store-operational-safety`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the one
SQLite file now holds SaaS state (users, hashed keys, usage, tenants, chat) alongside the mirror, yet
has no busy_timeout, no backup story, and 1:1 read→write amplification on gated/keyed requests.

## Overview

The serving layer stopped being read-only around specs 019–029: every gated request writes
`chat_sessions`/`token_usage`/`api_usage` rows, while `danni sync/curate/index` remains a long-running
second writer on the same `store/danni.sqlite`. This spec makes that file safe to operate: concurrent
writers queue instead of erroring, the file is recoverable, and per-request write amplification is
bounded. Per the standing `db-architecture-decision` memo we stay on SQLite (FTS5 + sqlite-vec +
ReadBridge substrate); app tables move only if the product goes multi-instance. The review's
refinement: the contention tripwire fires **earlier** than multi-instance — at "mirror refresh overlaps
live serving" — so it must be fixed inside SQLite, now.

Single responsibility: **the production store tolerates concurrent writers and is recoverable.**

## Finding & evidence

- **No busy_timeout** — `src/store/db.ts:35-36` sets only `PRAGMA foreign_keys` + `journal_mode=WAL`.
  With the default `busy_timeout=0`, a write that hits a lock held by the other process throws
  `SQLITE_BUSY` immediately instead of queueing. WAL allows one writer at a time; refreshing the mirror
  against a live instance is therefore a latent 500-generator on every gated request that writes.
- **No backup/restore story in this repo** — no `VACUUM INTO` / `.backup` / `wal_checkpoint` anywhere
  under `src/`, `scripts/`, or `apps/` (verified by grep). `.env.example:34` points operators at
  `docs/OPERATIONS.md`, which moved to the private deploy repo (spec 047 fixes the pointer;
  the *capability* gap is here). `README.md:84-86` claims the repo is self-hostable — a self-hoster
  currently has no supported way to back up users/keys/usage/chat.
- **Write amplification** — `src/store/repos/users.ts:67-71`: `findOrCreateByKratosId` runs an
  `UPDATE users … last_login_at = ?` on **every** session resolution, i.e. every gated request.
  `src/store/repos/api-keys.ts:123`: `resolveBySecret` bumps `api_keys.last_used_at` on **every**
  keyed request. Every authenticated read is currently also a SQLite write — worst-case fuel for the
  contention above, and needless WAL churn.

## Requirements

- **FR-250**: `openDb` (`src/store/db.ts`) MUST set `PRAGMA busy_timeout` to ~5000 ms so a writer
  blocked by the other process queues for up to the timeout instead of throwing `SQLITE_BUSY`.
- **FR-251**: Concurrency MUST be regression-tested: with one connection holding a write transaction,
  a second connection's write MUST succeed once the lock is released (within the timeout) rather than
  erroring — a test simulating "pipeline writes while the server writes".
- **FR-252**: A `danni backup <dest>` CLI command MUST produce a consistent snapshot of the live
  database without stopping the server (SQLite online-backup semantics: `VACUUM INTO` or the backup
  API, preceded/accompanied by a WAL checkpoint), and MUST verify the output (e.g. open it and run
  `PRAGMA integrity_check` or a row-count probe) before reporting success.
- **FR-253**: Restore MUST be documented **in this repo** (short doc or README section): stop the
  server, replace `danni.sqlite` (removing stale `-wal`/`-shm` siblings), run migrations, start. The
  doc MUST note what the file contains (mirror + all SaaS state) so operators size retention.
- **FR-254**: The per-request bumps MUST be throttled: `users.last_login_at` (users.ts:67-71) and
  `api_keys.last_used_at` (api-keys.ts:123) update at most once per N minutes per row (N ≈ 5,
  constant or config), so steady-state authenticated reads perform zero writes. Timestamp semantics
  change from "exact last use" to "last use within N minutes" — acceptable and documented.

## Success criteria

- **SC-1**: Running `danni sync`/`index` against the store of a live, traffic-serving instance
  produces zero 5xx responses attributable to `SQLITE_BUSY` (exercised by a test that interleaves a
  pipeline-style writer with request-path writes).
- **SC-2**: A backup taken under concurrent writes restores (per the FR-253 procedure) to a store
  that passes migrations + integrity check and serves the explorer with identical counts.
- **SC-3**: 100 consecutive keyed GET requests within the throttle window perform ≤1 `users` UPDATE
  and ≤1 `api_keys` UPDATE (observable via a repo-level test or statement counter).

## Out of scope / dependencies

- **Splitting app tables into their own SQLite file** (serving-writes DB separate from the mirror DB)
  — a plausible follow-on if contention persists after FR-250/254, noted by the review; deliberately
  out of scope here. The SQLite→Postgres move stays gated on multi-instance per the
  `db-architecture-decision` memo and spec 029's notes.
- Continuous replication / point-in-time recovery (Litestream etc.) — deployment-layer, private
  deploy repo (specs 030–033). This repo ships the primitive (`danni backup`); scheduling it is ops.
- Dangling `docs/OPERATIONS.md` / observability references — spec **047**. Metrics for contention —
  spec **045**. Consciously accepted: single-node, single-writer-at-a-time SQLite is the product.
