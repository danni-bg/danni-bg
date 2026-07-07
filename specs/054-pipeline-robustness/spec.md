# Feature Specification: Pipeline robustness papercuts

**Feature Branch**: `054-pipeline-robustness`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): three
independent pipeline papercuts — curator sniffing reads whole files to inspect 4KB, embed-retry
classification is coupled to an error-message string, and egov org resolution silently degrades
past a paging cap.

## Overview

Three small defects share one theme: the pipeline's failure and efficiency behavior is incidental
(a convenience `readFileSync`, a regex over a `message`, a hard-coded page cap) rather than
explicit. Each is cheap to fix and independently shippable; they are bundled because none warrants
a spec alone.

Single responsibility: **pipeline failure and efficiency behavior is explicit, not incidental.**

## Finding & evidence

(a) Curator selection reads the whole file to sniff 4KB:

- `src/curate/registry.ts:54-63` — `readHead` does `readFileSync(path)` (61) then
  `subarray(0, 4096)` (62). The selected curator then re-reads the full file anyway
  (`src/curate/csv.ts:112`, `src/curate/json.ts:24`), so every resource is read twice in full.
  On the ~16k-resource mirror this doubles curate I/O and feeds the ~20GB full-curate RSS problem
  (see the `curate-entities-only` memo).

(b) Embed retry classification is string-coupled:

- `src/index/batch-embed.ts:78-85` — `classifyEmbedError` regexes `/HTTP (\d{3})/` out of
  `err.message` (80). The only producer of that message shape is `HostedApiEmbedder`'s throw
  (`src/index/embedders/hosted-api.ts:45`: `` `Embedder ${this.endpoint} returned HTTP ${res.status}` ``).
  Rewording that message — or adding an embedder that phrases errors differently — silently turns
  every 429/5xx into a non-retryable `content` failure, disabling backoff with no test tripping.
  Typed errors carrying `httpStatus` already exist: `CkanApiError` at `src/lib/errors.ts:24-31`.

(c) egov org resolution silently truncates:

- `src/crawler/egov-sync.ts:47` — `MAX_ORG_PAGES = 12` × `PAGE_SIZE = 100`; the `resolveOrg` paging
  loop (182-193) stops at 1200 organisations. Any org beyond that is upserted as a placeholder
  (`Организация ${orgId}`, 199) with a portal-root source URL — no log line, no marker, so the bad
  publisher rows are indistinguishable from real ones downstream (facets, publisher-derived geo).

## Requirements

Cluster A — sniff I/O:

- **FR-360**: `readHead` MUST read at most 4096 bytes from the file (open + read into a 4KB buffer +
  close), never the whole file. Behavior on short files, non-files, and missing paths is unchanged.
- **FR-361**: A regression test MUST pin the bound (e.g. sniffing a multi-MB fixture allocates only
  the head buffer / a stubbed reader observes a single ≤4096-byte read).

Cluster B — typed embed errors:

- **FR-362**: `HostedApiEmbedder` MUST throw a typed error carrying the numeric HTTP status
  (`httpStatus`) for non-OK responses (reusing or paralleling `src/lib/errors.ts`), keeping a
  human-readable message that is free to change.
- **FR-363**: `classifyEmbedError` MUST classify by the typed error's status field — never by
  parsing `err.message`. Non-typed/non-HTTP throws remain `content`. Existing classification
  outcomes (429/5xx transient, other 4xx + mismatches content) are unchanged and covered by tests
  constructed from typed errors, plus one test proving a reworded message no longer degrades
  classification.

Cluster C — org paging honesty:

- **FR-364**: `resolveOrg` MUST page `listOrganisations` to exhaustion (loop until a short page)
  instead of a fixed page cap; a defensive upper bound MAY remain but MUST be high enough to be
  unreachable in practice and MUST log when hit.
- **FR-365**: When an org id is still not found after full paging, the placeholder upsert MUST log
  a warning (org id + dataset uri) and mark the row as unresolved (e.g. a flag/attribute on the
  organizations row or a sentinel slug convention) so downstream consumers and a later backfill can
  find placeholder publishers deterministically.

## Success criteria

- **SC-1**: Full `danni curate` over the mirror performs one full read per resource (sniff reads
  ≤4KB); measured curate RSS/IO does not regress and the double-read is gone.
- **SC-2**: Changing the embedder error message text breaks no classification test and does not
  alter retry behavior; a simulated 503 still backs off and a 400 still fails fast.
- **SC-3**: A mirror crawl against a fixture portal with >1200 organisations resolves every org
  name; forcing a lookup miss produces a logged warning and a queryable unresolved marker instead
  of a silent `Организация N` row.

## Out of scope / dependencies

- Transactional wrapping of the writes these code paths perform — **spec 052**.
- What the egov capture writes to raw (curator selection inputs change shape there) — **spec 049**;
  FR-360 is orthogonal and applies to any raw format.
- Deeper curate memory work beyond removing the double read (streaming curators) — deferred.
