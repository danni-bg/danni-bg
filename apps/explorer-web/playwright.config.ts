import { defineConfig } from '@playwright/test';

// E2E specs use the `.e2e.ts` suffix so `bun test` (which matches *.test.ts / *.spec.ts) never runs
// them; only Playwright does. Requires browsers: `bunx playwright install chromium`.
//
// Two webServer modes (spec 046):
//   - default (local iteration): the Vite dev server (`vite`), fast HMR.
//   - E2E_PREVIEW=1 (CI, `test:e2e`): serve the production bundle (`vite build` + `vite preview`), so
//     bundler/env-inlining regressions are caught (FR-282). The suite is hermetic either way — every
//     `/api/**` and Kratos route is stubbed in-page via `page.route` (fixtures.ts), so no live mirror,
//     LLM, or Ory stack is needed (FR-281).
const preview = !!process.env.E2E_PREVIEW;
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // Fail fast in CI if a `.only` was committed; keep the run deterministic.
  forbidOnly: isCI,
  // Bounded retry so a single flake doesn't red the pipeline, but real failures still fail (FR-284).
  retries: isCI ? 1 : 0,
  // A per-test cap so a hung spec/server fails fast rather than eating the job timeout (FR-284, SC-3).
  timeout: 30_000,
  reporter: isCI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    // Diagnostics on failure only — uploaded as CI artifacts (FR-284).
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: preview ? 'bunx vite preview --port 5173 --strictPort' : 'bunx vite --port 5173',
    url: 'http://localhost:5173',
    // In CI always start a fresh server; locally reuse a running dev server for speed.
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
