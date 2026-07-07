# Feature Specification: egov scope fidelity

**Feature Branch**: `048-egov-scope-fidelity`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the
egov-bg sync path silently ignores every `scope` field except `datasetIds`, so a publisher/tag-scoped
config crawls the entire portal — and freezes that full-portal list into the campaign checkpoint.

## Overview

`scope` in `danni.config.json` declares which slice of a portal the mirror covers. On the CKAN
adapter it is honored in full; on the egov-bg adapter it is honored only for `datasetIds`. The same
config therefore means two different things depending on `portal.api` — a silent correctness bug for
any scoped deployment (and for the per-tenant portal configs of spec 029). This spec makes scope
semantics adapter-independent: enforce what the portal can express, refuse loudly what it cannot.

Single responsibility: **`scope` means the same thing on every portal adapter.**

## Finding & evidence

- `src/crawler/crawl-checkpoint.ts:32-45` — `enumerateUris` narrows the campaign ONLY by
  `scope.datasetIds`; when that is empty it pages the full catalog and returns every uri. The
  `publishers`, `categories`, and `tags` fields are never consulted — dropped without a warning.
- The full-portal uri list is then **frozen** into the campaign (`crawl-checkpoint.ts:73,78`
  `createCampaign`), so even a later fix to enumeration does not repair an existing scoped campaign:
  its `crawl_checkpoints` row already contains the whole portal under the scoped key.
- The CKAN path honors all four fields: `src/crawler/run-sync.ts:47` builds
  `buildScopePredicate(scope)` (`src/crawler/scope.ts:22-39`) and filters discovery with it.
- `src/crawler/scope-hash.ts:29-43,50-53` — the campaign key hashes the canonical scope, so two
  different egov scopes correctly get distinct campaign rows; but both rows freeze the identical
  full-portal list, defeating the point of the key. Scope-change re-keying itself works as designed
  (a changed scope → new hash → fresh campaign; the prior row is retained).
- Portal capability (from `src/crawler/egov-bg-schema.ts`): the `listDatasets` summary carries
  `org_id` (line 22) — publisher filtering is possible at enumeration time; `tags` exist only on
  `getDatasetDetails` (line 51); egov has no group/category concept at all (`src/crawler/egov-sync.ts:263`
  always writes `groups: []`).

## Requirements

- **FR-300**: The egov enumeration MUST honor `scope.publishers`: `enumerateUris` filters the
  `listDatasets` pages by the summary `org_id` before freezing the campaign list. Publisher values
  are matched against the egov org identity used elsewhere (`egov-org-<id>` and/or the org uri/slug —
  one documented form).
- **FR-301**: The egov path MUST honor `scope.tags` by filtering with the `getDatasetDetails`
  response (which carries `tags`) — either during enumeration or as a per-dataset in-scope check at
  processing time, recorded as `outOfScope` rather than captured.
- **FR-302**: A scope field the adapter CANNOT express (for egov: `categories`) MUST fail loudly at
  config load / sync start with an error naming the field and the adapter — never silently crawl a
  superset. Silent dropping of any scope field is prohibited on all adapters.
- **FR-303**: The frozen campaign list MUST contain only in-scope uris, and `reconcileCatalog`
  (`crawl-checkpoint.ts:173-185`) MUST apply the same filter when appending newly discovered uris, so
  a scoped campaign never grows out-of-scope entries mid-flight.
- **FR-304**: Campaign invalidation on semantics change: because pre-fix scoped campaigns froze the
  full portal under a scoped hash, the fix MUST NOT resume them as-is. Version the canonical-scope
  serialization (or the hash input) so post-fix scoped runs derive a fresh campaign; full-portal
  (`{ all: true }`) campaigns keep their key and resume untouched.
- **FR-305**: Scope behavior MUST be covered by adapter-parity tests: the same scoped config produces
  an equivalent in-scope dataset set (or an explicit unsupported-field error) on both adapters.

## Success criteria

- **SC-1**: A `scope.publishers` egov config enumerates and captures only that publisher's datasets;
  the frozen campaign list contains no other publisher's uris.
- **SC-2**: A `scope.categories` egov config aborts before any capture with an error naming
  `categories` and `egov-bg`.
- **SC-3**: An existing full-portal egov campaign resumes with zero re-downloads after the change
  (checkpoint reuse intact); a pre-fix scoped campaign is not resumed under the new semantics.
- **SC-4**: `buildScopePredicate` and the egov filter agree on fixtures: no dataset is in-scope on
  one adapter and out-of-scope on the other for the fields both support.

## Out of scope / dependencies

- Byte-faithfulness of what is captured once in scope — **spec 049**.
- Per-tenant portal/scope configuration consuming this guarantee — **spec 029** (FR-131).
- Adding category/group support to the egov portal API itself — upstream, out of scope.
