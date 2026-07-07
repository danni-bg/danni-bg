# Feature Specification: CI e2e gate (Playwright in the merge pipeline)

**Feature Branch**: `046-ci-e2e-gate`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): a full
browser e2e suite exists and is maintained, but CI never runs it — the SPA and the login→chat flow
can regress with green CI.

## Overview

The repo has nine Playwright specs covering the product's user stories, kept deliberately out of
`bun test` via the `.e2e.ts` suffix. CI (`build-test` job) runs lint/typecheck/migrate-smoke/
coverage/parity only, so nothing exercises the browser. The suite is already **hermetic** — every
`/api/**` and Kratos route is stubbed in-page — so wiring it into CI is cheap: chromium + the SPA,
no live mirror, LLM, or identity stack. This spec makes that suite a merge gate.

Single responsibility: **the browser e2e suite gates CI.**

## Finding & evidence

- **CI gap** — `.github/workflows/ci.yml:25-39`: steps are Lint, Typecheck, Migrate (smoke), Test
  with coverage, parity-matrix check. No Playwright step; the `image` job publishes without any
  browser verification.
- **Suite exists and is current** — `apps/explorer-web/playwright.config.ts` (testDir `./e2e`,
  `**/*.e2e.ts`, webServer `bunx vite --port 5173`); nine specs `apps/explorer-web/e2e/us1-map …
  us9-admin-settings.e2e.ts` covering map, filters, chat SSE + citations, linked views, drilldown,
  ask-dataset, auth, admin settings. `apps/explorer-web/package.json` has an `e2e` script.
- **Already hermetic — no Kratos-in-CI needed** — `apps/explorer-web/e2e/fixtures.ts` stubs the
  entire API surface via `page.route` (`stubApi`, fixtures.ts:117-177) and the Kratos self-service
  flows (`stubAuth`/`stubLoginFlow`/`stubRecovery`/`stubLogout`, fixtures.ts:179-384). The review
  brief's suggested "seeded test store / Kratos compose service" is unnecessary: the mock boundary
  exists and is documented in fixtures.ts:1-4. (Adjustment recorded — see spec authorship note.)
- **Runs against the dev server, not the build** — the webServer command is `bunx vite`, so a
  production-build-only breakage (bundling, env inlining) would still pass.
- **Deliberately manual** — the DeepEval agentic suite (`eval/agentic`, `bun run eval:agentic`)
  needs the LAN LLM + a frontier judge (specs 018/024) and stays manual/nightly by design.

## Requirements

- **FR-280**: CI MUST run the Playwright suite headless (chromium) on every PR and push to `main`,
  and the `image` publish job MUST depend on it — a failing e2e spec blocks merge and publish.
- **FR-281**: The CI e2e job MUST stay hermetic: no live Kratos, LLM, or mirror. The `fixtures.ts`
  `page.route` stubs are the sanctioned mock boundary; new e2e specs MUST use it (or extend it)
  rather than reaching real backends.
- **FR-282**: The gate MUST exercise the production build: build the SPA and serve the bundle (e.g.
  `vite build` + `vite preview`) as the Playwright webServer in CI, so bundler/build regressions are
  caught. The dev-server config remains for local iteration.
- **FR-283**: All committed `.e2e.ts` specs run — no CI-side skip list. The minimum protected flows
  are: map/regions render (us1), filters (us2), chat SSE with citations (us3), auth gating +
  login/logout via stubbed Kratos (us8), admin settings (us9).
- **FR-284**: The job MUST stay cheap and deterministic: chromium install cached, a bounded retry
  policy (≤1 retry, retries reported), Playwright traces/screenshots uploaded as artifacts on
  failure, and a job timeout so a hang fails fast.

## Success criteria

- **SC-1**: A PR that breaks the login→chat rendering path (e.g. a regression in the SSE render or
  the auth callback handling) fails CI even when unit tests and typecheck pass.
- **SC-2**: The e2e job passes on a network-restricted runner apart from dependency/browser
  download — demonstrating the FR-281 hermetic boundary.
- **SC-3**: The full suite completes within the job timeout (target ≤10 minutes) on the standard
  GitHub runner, with cached browsers on warm runs.
- **SC-4**: An intentionally broken production build (compiles under dev server, fails bundled) is
  caught by the FR-282 preview-mode run.

## Out of scope / dependencies

- The DeepEval agentic-quality suite (`eval/agentic`, specs **018**/**024**) — needs LAN LLM +
  judge; stays manual/nightly by design. Explicitly not part of this gate.
- Live-Kratos integration e2e (compose-based, real self-service flows) — a possible follow-on if
  the stub boundary drifts from real Kratos; today the stubs mirror the flows specs 019/022 shipped.
- Cross-browser (firefox/webkit) and visual-regression testing — deferred; chromium-only matches
  the current config. Builds on spec **008** (SPA) and the e2e conventions from **019**/**022**.
