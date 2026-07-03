# Feature Specification: Self-host parity (no dangling promises after the open-core split)

**Feature Branch**: `047-self-host-parity`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation):
post open-core split (PR #103), this repo still points self-hosters at files that now live in the
private deploy repo, and the committed example config cannot sync the flagship portal as-is.

## Overview

The open-core promise (README: EUPL-1.2, "self-hostable on its own") only holds if every path this
repo references exists in this repo, and the documented clone→configure→run journey works without
the commercial layer. This spec closes the papercuts the split left behind: dangling doc/comment
references, and an example config whose portal block doesn't match the portal the whole product is
built around.

Single responsibility: **everything this repo references or promises exists in this repo (or is
explicitly marked commercial).**

## Finding & evidence

- **Personal config: already handled (finding revised)** — the review draft flagged a *committed*
  `danni.config.json` with a host-specific absolute `store.root` and `robots.obey:false`. Verified:
  that file is **gitignored** (`.gitignore:34`) and untracked; `danni.config.example.json` is the
  committed shape and already uses relative `./store` and `robots.obey:true`. No change needed there.
- **…but the example config can't sync data.egov.bg** — `danni.config.example.json` sets
  `portal.api: "ckan"` with `baseUrl: "https://data.egov.bg/api/3/action/"`. data.egov.bg does not
  serve the CKAN Action API; it needs the custom adapter (`src/config/schema.ts:6-8`:
  `api: 'ckan' | 'egov-bg'`) with `baseUrl: "https://data.egov.bg/api/"`. The quickstart
  (`specs/001-egov-data-sync/quickstart.md:31-32`) says `cp danni.config.example.json
  danni.config.json` — a fresh self-hoster's first `danni sync` fails. Nothing validates the example
  against the config schema either.
- **Dangling references to the private repo** — `apps/explorer-api/src/metrics.ts:5`,
  `apps/explorer-api/src/trace.ts:4`, `apps/explorer-api/src/app.ts:304` reference
  `infra/observability` (only `infra/ory` exists here); `.env.example:34` references
  `docs/OPERATIONS.md` (docs/ holds only ARCHITECTURE, CONSUMERS, semantic-search). Both moved to
  the private deploy repo in the split. (`docker-compose.prod.yml`, also named at `.env.example:34`,
  does exist — not dangling.)
- **README self-host promise** — `README.md:84-86`: self-hostable via `docker compose` + the dev Ory
  stack. Largely true today (Dockerfile, `docker-compose*.yml`, `infra/ory`, entrypoint all present)
  but unlocked by any requirement or smoke check, so the next split-style refactor can silently
  break it.

## Requirements

- **FR-290**: `danni.config.example.json` MUST work against the documented default portal out of the
  box: `portal.api: "egov-bg"` + `baseUrl: "https://data.egov.bg/api/"` (keeping conservative
  crawler defaults and `robots.obey:true`), with a comment noting the generic `ckan` alternative —
  or ship both variants with the quickstart naming which to copy.
- **FR-291**: A test MUST parse `danni.config.example.json` through the config schema
  (`src/config/schema.ts`) so the committed example can never drift invalid.
- **FR-292**: No operator-facing text in this repo (source comments, `.env.example`, README, docs/)
  may reference a repo-relative path that does not exist here. The `infra/observability` mentions
  (metrics.ts:5, trace.ts:4, app.ts:304) and the `docs/OPERATIONS.md` mention (.env.example:34) MUST
  be reworded to either inline minimal guidance or say "the commercial deploy repo" explicitly.
  Historical `specs/` documents are exempt (they record decisions as-of their date).
- **FR-293**: The README self-host claim MUST be locked by a documented, repeatable smoke procedure
  in this repo: fresh clone → documented steps (`docker compose up` + dev Ory stack) → explorer
  serves `/healthz` and the SPA — runnable by hand and suitable for occasional CI execution.
- **FR-294**: Whatever remains commercial-only (operations runbook, IaC, observability stack,
  managed hosting) MUST be listed in one place in the README's open-core section so "marked
  commercial" is a single maintained list rather than scattered comments.

## Success criteria

- **SC-1**: On a fresh clone, `cp danni.config.example.json danni.config.json && danni sync --max 5`
  (or the quickstart's equivalent) succeeds against data.egov.bg with no config edits.
- **SC-2**: `grep -rn "infra/observability\|docs/OPERATIONS.md"` over `src/`, `apps/`, `README.md`,
  `docs/`, `.env.example` returns nothing (specs/ and CLAUDE.md history exempt).
- **SC-3**: The FR-293 smoke procedure passes from a clean checkout with no access to any private
  repo — the open-core promise holds by construction.

## Out of scope / dependencies

- The backup/restore *capability* the missing OPERATIONS.md used to describe — spec **043** (this
  spec only fixes the pointers). Image contents — spec **044**. `/metrics` exposure — spec **045**.
- Re-publishing an open OPERATIONS guide — the runbook stays commercial (specs 030–033, private
  deploy repo) by conscious open-core decision; this repo documents only what it ships.
- Consciously accepted: the dev Ory stack (`infra/ory`) with placeholder secrets is the supported
  self-host identity path; production-grade identity hardening is spec **037**/deploy-repo territory.
