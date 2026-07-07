// Explorer API entrypoint (T015 bootstrap). Thin, logic-free wiring: load config, open the store,
// build the read bridge + crosswalk, and serve the Hono app. Like src/cli/*, this bootstrap is
// exercised by running it / E2E rather than unit coverage (its routes are covered by app.test.ts).

import { resolve } from 'node:path';
import { serveStatic } from 'hono/bun';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { loadConfig } from '../../../src/config/loader.ts';
import { buildEmbedder } from '../../../src/index/embedders/factory.ts';
import { isStale } from '../../../src/lib/time.ts';
import { openDb } from '../../../src/store/db.ts';
import { ApiKeyRepo } from '../../../src/store/repos/api-keys.ts';
import { ApiUsageRepo } from '../../../src/store/repos/api-usage.ts';
import { PlatformSettingsRepo } from '../../../src/store/repos/platform-settings.ts';
import { TenantsRepo } from '../../../src/store/repos/tenants.ts';
import { TokenUsageRepo } from '../../../src/store/repos/token-usage.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { resolveServerDefault } from './admin/resolve-default.ts';
import { LLM_SETTING_KEY } from './admin/settings-schema.ts';
import { type AppContext, type HealthInfo, createApp } from './app.ts';
import { kratosProxy, kratosSessionResolver } from './auth/kratos-session.ts';
import { serverDefaultFromEnv } from './chat/providers.ts';
import { PersistentSessionStore } from './chat/sessions-repo.ts';
import { log } from './logging.ts';
import { Metrics } from './metrics.ts';
import { ReadBridge } from './read-bridge.ts';
import { checkReadiness } from './readiness.ts';

const SPA_ROOT = './apps/explorer-web/dist';

export function buildHealth(
  db: import('bun:sqlite').Database,
  sloSeconds: number,
  settings: PlatformSettingsRepo,
): HealthInfo {
  const row = db
    .query<{ last: string | null }, []>('SELECT MAX(last_synced_at) AS last FROM datasets')
    .get();
  const lastSyncedAt = row?.last ?? null;
  // A never-synced store (null timestamp) is stale — the shared helper folds in the `!lastSyncedAt`
  // short-circuit (FR-373).
  const stale = isStale(lastSyncedAt, sloSeconds);
  // Resolved from settings (admin-configured) else the env seed — matches what the chat will use.
  const defaultProvider = resolveServerDefault(settings, process.env) ? 'configured' : 'absent';
  return { lastSyncedAt, isStale: stale, defaultProvider };
}

/** Seed the LLM default from EXPLORER_DEFAULT_* on first run; afterwards the settings store is authoritative. */
export function seedSettings(settings: PlatformSettingsRepo): void {
  if (settings.get(LLM_SETTING_KEY) != null) return;
  const env = serverDefaultFromEnv(process.env);
  if (env) {
    settings.set(LLM_SETTING_KEY, {
      kind: env.kind,
      model: env.model,
      baseUrl: env.baseUrl ?? null,
      apiKey: env.apiKey ?? null,
    });
  }
}

export function main(): void {
  const config = loadConfig();
  // DANNI_STORE_ROOT lets a container/deploy point at its mounted store volume without baking a
  // host-specific path into danni.config.json (spec 030).
  const storeRoot = resolve(process.cwd(), process.env.DANNI_STORE_ROOT ?? config.store.root);
  const db = openDb({ storeRoot, loadVec: false });
  const slo = config.store.freshnessSloSeconds;
  const settings = new PlatformSettingsRepo(db);
  seedSettings(settings);
  const kratosUrl = process.env.KRATOS_PUBLIC_URL ?? 'http://localhost:14433';
  const ctx: AppContext = {
    bridge: new ReadBridge({
      db,
      storeRoot,
      embedder: buildEmbedder(config.enrichment.embedder),
      freshnessSloSeconds: slo,
    }),
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => buildHealth(db, slo, settings),
    readiness: () =>
      checkReadiness({
        db,
        migrationsDir: resolve(process.cwd(), 'migrations'),
        settings,
        env: process.env,
      }),
    metrics: new Metrics(),
    users: new UsersRepo(db),
    apiKeys: new ApiKeyRepo(db),
    apiUsage: new ApiUsageRepo(db),
    tokenUsage: new TokenUsageRepo(db),
    tenants: new TenantsRepo(db),
    chatSessions: new PersistentSessionStore(db),
    settings,
    kratosPublicUrl: kratosUrl,
    // Single-port mode: validate the Kratos session ourselves so the app works without Oathkeeper
    // in front. Inbound X-User-* headers are IGNORED unless the operator opts in with
    // TRUST_PROXY_AUTH_HEADERS (spec 034) — anyone can set them on a directly-exposed port.
    sessionResolver: kratosSessionResolver(kratosUrl),
  };
  const app = createApp(ctx);
  // Reverse-proxy Kratos on the same origin so the SPA's self-service flows + whoami work without a
  // separate proxy (first-party cookies/CSRF). Registered before the SPA catch-all.
  app.all('/kratos/*', kratosProxy(kratosUrl));
  // Serve the built SPA (production) / dev (Vite proxies here). SPA fallback for client routes.
  app.use('/*', serveStatic({ root: SPA_ROOT }));
  app.get('*', serveStatic({ path: `${SPA_ROOT}/index.html` }));
  const port = Number.parseInt(process.env.EXPLORER_API_PORT ?? '8790', 10);
  log.info('explorer_api_listening', { port });
  // Bun's default idleTimeout is 10s — too short for streaming chat where a large model can take
  // longer than that to emit its first token. Use the max (255s) so SSE connections aren't dropped.
  Bun.serve({ port, fetch: app.fetch, idleTimeout: 255 });
}

if (import.meta.main) main();
