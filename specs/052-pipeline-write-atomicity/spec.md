# Feature Specification: Pipeline write atomicity & one upsert idiom

**Feature Branch**: `052-pipeline-write-atomicity`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation):
transaction conventions are inconsistent across write stages — some multi-table writes are atomic,
others are unwrapped; repos mix a racy read-then-write upsert with atomic single-statement upserts.

## Overview

Some pipeline stages already treat "one logical unit = one transaction" as the rule; others write
related rows as independent implicit transactions, so an interrupt (or a second writer, once one
exists) can leave half a unit persisted — e.g. a captured resource whose checkpoint row never said
success, or an attached entity that was never upserted. This spec codifies the existing good
pattern as the repo-wide convention and closes the known gaps.

Single responsibility: **multi-table pipeline writes are atomic and repos share one upsert idiom.**

## Finding & evidence

Good examples to codify (already correct):

- `src/crawler/capture-dataset.ts:61` — `withTransaction` wraps org upsert + dataset upsert +
  revision inserts + resource rows for one CKAN dataset.
- `src/index/run-index.ts:136,173,184,289` — each index unit (vector+state, full-clear, FTS+state)
  is its own transaction.
- `withTransaction` exists and is trivial to adopt: `src/store/db.ts:51-54`.

Gaps:

- `src/crawler/egov-sync.ts:407-422` — a successful egov resource writes 3 tables unwrapped:
  `resourcesRepo.upsert` (407), `resourcesRepo.recordCapture` (408-415), and
  `checkpoint.markResourceSuccess` (416-422). A crash between them records a capture the checkpoint
  will re-fetch, or an upserted resource with no capture row.
- `src/enrich/register-entities.ts:24-40` — per candidate, `repo.upsert` (25-31) and `repo.attach`
  (32-38) are separate implicit transactions.
- `src/enrich/link-datasets.ts:48-62` — the pairwise loop issues one `linksRepo.insert` implicit
  transaction per link (up to ~1.2k pairs per entity at `MAX_ENTITY_FANOUT=50`; hundreds of
  thousands across a full-mirror run) — each with its own WAL commit/fsync cost and no per-entity
  atomicity.

Two upsert idioms coexist:

- Read-then-INSERT/UPDATE without a transaction — `src/store/repos/datasets.ts:77-144` (the read at
  79 and the write at 85/121 can interleave with a second writer), `src/store/repos/entities.ts:49-77`,
  `src/store/repos/translations.ts:34-61`. Racy under a second writer; currently latent (single
  writer today).
- Atomic single statement — `INSERT OR REPLACE` in `entities.attach`
  (`src/store/repos/entities.ts:87`) and `dataset-links.ts:33`. Note `INSERT OR REPLACE` is
  delete+reinsert semantics (fires FK cascade/rowid churn); `ON CONFLICT DO UPDATE` is the safer
  single-statement form.

## Requirements

- **FR-340**: Every multi-table write that persists ONE logical pipeline unit MUST run inside a
  single transaction (`withTransaction`). Minimum closures: the egov per-resource success triple
  (`egov-sync.ts:407-422`), and `registerEntities`' upsert+attach per candidate (or per dataset).
- **FR-341**: `linkDatasetsForEntity` MUST write one entity's pairwise links in one transaction
  (per-entity atomicity + one commit instead of up to ~1.2k), leaving `linkAllSharedEntities` a loop
  of per-entity transactions.
- **FR-342**: The repo upsert convention is a single atomic statement using
  `ON CONFLICT(...) DO UPDATE`; new `INSERT OR REPLACE` and new unwrapped read-then-write upserts
  are prohibited. Existing `INSERT OR REPLACE` sites migrate to `ON CONFLICT DO UPDATE`.
- **FR-343**: Where an upsert must diff old values (field-level change tracking in
  `datasets.upsert`; the keep-non-empty rule in `translations.upsert`), the read and the write MUST
  execute inside one transaction so the diff cannot be computed against a stale row.
- **FR-344**: The convention (one unit = one transaction; `ON CONFLICT DO UPDATE`; when a
  read-diff-write needs a wrapping transaction) MUST be recorded where contributors will hit it
  (repo-layer doc comment or `docs/ARCHITECTURE.md` §3), with `capture-dataset.ts:61` cited as the
  reference example.
- **FR-345**: Interrupt-safety tests MUST cover the closed gaps: aborting mid-unit (fault-injected
  throw inside the transaction) leaves no partial rows for the egov resource triple and for
  entity registration.

## Success criteria

- **SC-1**: A fault injected between the egov capture write and its checkpoint write rolls back
  both; a resumed sync re-captures cleanly (no orphan `resources`/`crawl_checkpoints` disagreement).
- **SC-2**: `grep` finds no `INSERT OR REPLACE` under `src/store/repos/` and no multi-statement
  repo upsert executing outside a transaction.
- **SC-3**: Full-mirror `linkAllSharedEntities` performs at most one commit per entity (observable
  as a measurable wall-clock reduction on the ~16k-resource mirror; no behavior change in rows).

## Out of scope / dependencies

- Multi-process/second-writer support itself (this removes the latent race; concurrency is a
  storage-architecture question — see the `db-architecture-decision` memo and **spec 029/030**).
- What bytes the egov capture writes — **spec 049** (its curator writes should land already
  conforming to this convention).
- Failure classification/efficiency papercuts — **spec 054**.
