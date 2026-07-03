# Feature Specification: Byte-faithful capture on the egov adapter

**Feature Branch**: `049-byte-faithful-capture`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the egov
sync transforms datastore responses (CSV serialization, numeric heuristics, merged-header
flattening) BEFORE writing `store/raw/`, so the raw archive is not byte-faithful and a
header-flattening bug can only be fixed by re-crawling the portal.

## Overview

The architecture's core invariant is that `store/raw/` is a byte-faithful archive and every later
stage is re-runnable from it (`docs/ARCHITECTURE.md:3,41,198` and §8 `:430` — "Any stage can be
re-run"). The CKAN adapter honors this (bytes stream to disk untouched). The egov adapter does not:
curation-grade heuristics run at capture time, so their bugs are frozen into "raw" forever. This
spec moves all transformation into curate and makes the egov raw artifact the verbatim response.

Single responsibility: **`store/raw/` is byte-faithful on every adapter; all transformation lives
in curate.**

## Finding & evidence

- `src/crawler/egov-sync.ts:60-156` — curation logic in the sync module: `csvCell`/`rowsToCsv`
  (60-68), numeric-cell heuristics `looksNumeric`/`isHeaderLike` (78-85), merged-group detection
  `groupFillColumns` (94-105), and the 2-row header flattener `flattenHeader` (121-156, with
  documented misread risks in its own comment at 116-119).
- `src/crawler/egov-sync.ts:380-395` — the transform is applied before capture: shape-based `ext`
  selection (381-385), `flattenHeader` + `rowsToCsv` rewrite the rows (390-392), and even the JSON
  branch re-serializes (`JSON.stringify(data, null, 2)`, 394). Line 344 additionally normalizes an
  absent `data` field to `[]`. The response envelope is dropped in every branch. The result is
  hashed and written as `raw.{csv,json,txt}` (396-405) — so "raw" is a derived artifact.
- Consequence: a `flattenHeader` bug (e.g. a misread all-text data row) is unfixable by re-running
  curate; the pre-transform bytes were never stored, violating the re-runnability invariant.
- Curate is the designed home for this: shape normalization lives in `src/curate/normalize.ts`, and
  `CuratorRegistry` (`src/curate/registry.ts:16-52`) already dispatches on sniffed content.

## Requirements

- **FR-310**: The egov capture MUST write the verbatim `getResourceData` HTTP response body bytes to
  `store/raw/` (as `raw.json`), with no field extraction, defaulting, re-serialization, CSV
  conversion, or header flattening. The stored sha256 is the hash of those bytes.
- **FR-311**: A datastore-JSON curator (beside `src/curate/normalize.ts`) MUST own everything the
  sync currently does: unwrap the envelope, normalize absent/`{}` data to an empty artifact,
  array-of-arrays → CSV (incl. the 2-row merged-header flattening), array-of-objects/document →
  normalized JSON, plain-string → text. `rowsToCsv`/`flattenHeader` and their tests move with it.
- **FR-312**: `CuratorRegistry` MUST select the datastore curator for these captures (envelope
  sniffing and/or a recorded format hint) ahead of the generic `JsonCurator`, so `danni curate`
  over a new-format mirror yields curated outputs equivalent to today's.
- **FR-313**: Migration is additive, not destructive: already-captured `raw.{csv,json,txt}`
  artifacts remain valid curate inputs via the existing curators (they are well-formed CSV/JSON/
  text). No re-crawl is required; a re-crawl is optional and simply upgrades a resource to a
  verbatim raw on its next content change (the validator/checkpoint reuse of unchanged resources is
  preserved).
- **FR-314**: A header-flattening (or any datastore-curation) fix MUST be applicable by re-running
  `danni curate` alone over post-change captures — demonstrated by a test that curates the same raw
  fixture twice under two curator versions without touching sync.
- **FR-315**: Sync modules MUST NOT contain content-transformation logic; enforce by module
  boundary (no curate imports of sync, no row/header manipulation exports from `src/crawler/`).

## Success criteria

- **SC-1**: For a new egov capture, bytes on disk equal the portal response body byte-for-byte
  (fixture round-trip test).
- **SC-2**: Curating a new verbatim capture of an existing resource produces the same curated
  artifact content as today's capture-time transform (golden-fixture parity, incl. a merged-header
  case).
- **SC-3**: An existing mirror re-curates end-to-end with zero sync involvement and zero failures
  attributable to the format change.
- **SC-4**: `flattenHeader` no longer exists under `src/crawler/`.

## Out of scope / dependencies

- Which datasets get captured at all (scope semantics) — **spec 048**.
- Transactionality of the capture bookkeeping writes — **spec 052**.
- CKAN resource capture (already byte-faithful via `BlobStore`) — unchanged.
