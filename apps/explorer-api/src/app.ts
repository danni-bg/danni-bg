// Hono app factory for the explorer API (T015). Routes are wired here and bound to an injected
// AppContext so tests can drive them against an in-memory store. Zod failures and not-found errors
// are mapped to the shared error envelope. Authoritative Bulgarian fields and freshness blocks pass
// through verbatim (Constitution IX/X).

import type { LanguageModel } from 'ai';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { MUNICIPALITIES, OBLASTS } from '../../../src/enrich/gazetteer/bg-admin.ts';
import type { ApiKeyRepo } from '../../../src/store/repos/api-keys.ts';
import type { ApiUsageRepo } from '../../../src/store/repos/api-usage.ts';
import type { PlatformSettingsRepo } from '../../../src/store/repos/platform-settings.ts';
import type { TenantsRepo } from '../../../src/store/repos/tenants.ts';
import type { TokenUsageRepo } from '../../../src/store/repos/token-usage.ts';
import type { UsersRepo } from '../../../src/store/repos/users.ts';
import { resolveServerDefault } from './admin/resolve-default.ts';
import { TOGGLES_SETTING_KEY, togglesSchema } from './admin/settings-schema.ts';
import type { SessionResolver } from './auth/kratos-session.ts';
import { capDatasetDetail } from './chat/cap.ts';
import { GenerationManager } from './chat/generation-manager.ts';
import { type ServerDefault, selectModel, serverDefaultFromEnv } from './chat/providers.ts';
import { type ConversationStore, SessionStore } from './chat/session.ts';
import type { PersistentSessionStore } from './chat/sessions-repo.ts';
import { type DatasetLite, hasGeo, liteToPointer, matchesFiltersLite } from './dataset-lite.ts';
import { expandGeoUnitIds } from './geo-rollup.ts';
import type { Metrics } from './metrics.ts';
import { type ApiMeterConfig, chatMeter, dataApiGate } from './middleware/api-metering.ts';
import {
  type MetricsGateConfig,
  metricsAllowed,
  metricsGateFromEnv,
} from './middleware/metrics-gate.ts';
import { RateLimiter } from './middleware/rate-limiter.ts';
import { requestId } from './middleware/request-id.ts';
import { requestLog } from './middleware/request-log.ts';
import { requireAuth, requireScope } from './middleware/require-auth.ts';
import type { ReadBridge } from './read-bridge.ts';
import type { ReadinessReport } from './readiness.ts';
import { aggregateRegions } from './regions-aggregate.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes } from './routes/auth.ts';
import { chatHandler } from './routes/chat.ts';
import { meRoutes } from './routes/me.ts';
import { tenantRoutes } from './routes/tenant.ts';
import {
  type DatasetPointer,
  type ErrorCode,
  type Facets,
  type FilterState,
  type RegionSummary,
  filterStateSchema,
} from './schemas.ts';

export interface HealthInfo {
  lastSyncedAt: string | null;
  isStale: boolean;
  defaultProvider: 'configured' | 'absent';
}

export interface ChatConfig {
  sessions: ConversationStore;
  serverDefault: ServerDefault | null;
  /** Test override; when absent the real provider seam (server config only, spec 035) is used. */
  selectModel?: () => LanguageModel;
}

export interface AppContext {
  bridge: ReadBridge;
  crosswalk: Crosswalk;
  health: () => HealthInfo;
  /** Readiness probe (spec 030): DB reachable + migrations current. When wired, exposes /readyz. */
  readiness?: () => ReadinessReport;
  /** In-process RED metrics (spec 030): when wired, requests are logged + metered and /metrics is exposed. */
  metrics?: Metrics;
  /** `/metrics` exposure gate (spec 045 FR-273). When omitted, resolved from env + `DANNI_PROFILE`
   * (bearer token / CIDR allowlist; a non-dev profile with no gate fails closed). Injectable for tests. */
  metricsGate?: MetricsGateConfig;
  chat?: ChatConfig;
  /** App users repo — gates /api/chat + backs /api/auth (spec 019). */
  users: UsersRepo;
  /** API-key repo (spec 027) — machine-client Bearer auth alongside sessions; when omitted, only
   * sessions authenticate (hermetic tests can opt in by passing a repo). */
  apiKeys?: ApiKeyRepo;
  /** API request-usage repo (spec 028) — when wired, the chat + data API are metered, rate-limited,
   * and (data) request-quota'd per principal; backs the api-usage views. */
  apiUsage?: ApiUsageRepo;
  /** Per-user token metering — records chat usage + backs the quota gate and usage views. */
  tokenUsage?: TokenUsageRepo;
  /** Organizations (tenants) repo (spec 029) — when wired, requests resolve an active org and the
   * org self-management + super-admin org routes are mounted; else everything is the default tenant. */
  tenants?: TenantsRepo;
  /** Persistent per-user chat history — when wired, conversations are saved + resumable. */
  chatSessions?: PersistentSessionStore;
  /** In-flight generation registry (mid-stream resume). Injectable for tests; else created here. */
  generations?: GenerationManager;
  /** Platform settings repo — backs /api/admin/settings + the chat's default provider (spec 019). */
  settings?: PlatformSettingsRepo;
  /** Kratos public base URL (for the logout flow URL). */
  kratosPublicUrl?: string;
  /** Validate a Kratos session cookie directly (single-port mode, no Oathkeeper). When omitted, the
   * only session path is Oathkeeper's injected X-User-* headers — honored solely behind the
   * TRUST_PROXY_AUTH_HEADERS opt-in (spec 034; hermetic tests enable it in their setup). */
  sessionResolver?: SessionResolver;
}

const LABELS = new Map<string, { labelBg: string; labelEn: string | null }>([
  ...OBLASTS.map((o) => [o.id, { labelBg: o.labelBg, labelEn: o.labelEn }] as const),
  ...MUNICIPALITIES.map((m) => [m.id, { labelBg: m.labelBg, labelEn: m.labelEn }] as const),
]);

function err(code: ErrorCode, message: string, status: 400 | 404 | 500, details?: unknown) {
  return {
    body: { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    status,
  };
}

/** Parse the shared filter query params into a validated FilterState. */
function parseFilters(q: URLSearchParams): FilterState {
  return filterStateSchema.parse({
    tags: q.getAll('tags'),
    publisherIds: q.getAll('publisherIds'),
    geoUnitIds: q.getAll('geoUnitIds'),
    freshness: q.get('freshness') ?? undefined,
    query: q.get('q') ?? undefined,
    includeWithdrawn: q.get('includeWithdrawn') === 'true' ? true : undefined,
  });
}

function clampInt(raw: string | null, def: number, max: number): number {
  const n = raw === null ? def : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  // Request-id correlation (spec 032) then structured logging + RED metrics (spec 030), first so they
  // wrap every API/auth request and the id is available to the log line + the chat span trace.
  app.use('*', requestId());
  app.use('*', requestLog(ctx.metrics));

  const chat: ChatConfig = ctx.chat ?? {
    sessions: new SessionStore(),
    serverDefault: serverDefaultFromEnv(),
  };
  // In-flight generations run here (detached from the request) so reload/disconnect can re-attach.
  const generations = ctx.generations ?? new GenerationManager();
  // The chat's default provider is resolved PER REQUEST so an admin's settings edit takes effect
  // without a restart: settings store wins, else the env seed (spec 019). Resolved through the
  // caller's ACTIVE org (spec 042 FR-240) — the tenant's override wins, `global` is the fallback.
  // Falls back to the configured ChatConfig.serverDefault when no settings repo is wired (e.g. focused
  // unit tests); an absent tenantId resolves the global row (single-tenant / non-chat call sites).
  const resolveDefault = (tenantId?: string) =>
    ctx.settings ? resolveServerDefault(ctx.settings, process.env, tenantId) : chat.serverDefault;

  // Platform toggles resolved from settings per request so an admin edit applies without a restart.
  // A `tenantId` resolves the toggles blob through the active org (tenant override → global fallback).
  // Only `defaultTokenLimit` is tenant-overridable (spec 042 FR-241); the cache weight, max output,
  // and api rate/quota knobs stay deployment-global and are read WITHOUT a tenant.
  const resolveToggles = (tenantId?: string) => {
    if (!ctx.settings) return undefined;
    const raw = ctx.settings.get(TOGGLES_SETTING_KEY, tenantId);
    return raw != null ? togglesSchema.parse(raw) : undefined;
  };
  const resolveDefaultTokenLimit = (tenantId?: string): number | undefined =>
    resolveToggles(tenantId)?.defaultTokenLimit;
  const resolveCacheWeight = (): number | undefined => resolveToggles()?.cachedTokenWeight;
  const resolveMaxOutputTokens = (): number | undefined => resolveToggles()?.maxOutputTokens;

  // API metering (spec 028): rate limits + the data-API request quota + per-request usage. Defaults
  // are admin-overridable via toggles. The limiter is in-process (single-node; multi-node needs a
  // shared store — spec 031). Wired only when an api-usage repo is present.
  const DEFAULT_API_RATE_DATA = 60;
  const DEFAULT_API_RATE_CHAT = 20;
  const DEFAULT_API_QUOTA_DATA = 10_000;
  const DEFAULT_API_QUOTA_WINDOW_SEC = 86_400;
  const meterConfig: ApiMeterConfig = {
    rateData: () => resolveToggles()?.apiRateData ?? DEFAULT_API_RATE_DATA,
    rateChat: () => resolveToggles()?.apiRateChat ?? DEFAULT_API_RATE_CHAT,
    quotaData: () => resolveToggles()?.apiQuotaData ?? DEFAULT_API_QUOTA_DATA,
    quotaWindowSec: () => resolveToggles()?.apiQuotaWindowSec ?? DEFAULT_API_QUOTA_WINDOW_SEC,
  };
  const meterDeps = ctx.apiUsage
    ? {
        usage: ctx.apiUsage,
        limiter: new RateLimiter(),
        config: meterConfig,
        ...(ctx.metrics ? { metrics: ctx.metrics } : {}),
      }
    : null;

  // Public read API: anonymous browser traffic is free; an API-key caller is auth'd + rate-limited +
  // request-quota'd + metered. Registered BEFORE the route handlers below so it runs first.
  if (meterDeps) {
    const gate = dataApiGate(ctx.apiKeys, meterDeps);
    for (const p of [
      '/api/datasets',
      '/api/datasets/*',
      '/api/regions',
      '/api/regions/*',
      '/api/national',
      '/api/facets',
      '/api/entities/*',
    ]) {
      app.use(p, gate);
    }
  }

  // Gated chat (spec 019): requireAuth runs before the streaming handler — anon → 401, else the
  // session's app user is resolved/created and the turn proceeds. The cast bridges the auth-typed
  // middleware onto the app's default env (it only gates + sets `user`, which chatHandler ignores).
  app.post(
    '/api/chat',
    requireAuth(ctx.users, ctx.sessionResolver, ctx.apiKeys, ctx.tenants) as MiddlewareHandler,
    requireScope('chat') as MiddlewareHandler,
    ...(meterDeps ? [chatMeter(meterDeps) as MiddlewareHandler] : []),
    chatHandler({
      bridge: ctx.bridge,
      // Persistent store when wired (conversations survive + resume), else the in-memory one.
      sessions: ctx.chatSessions ?? chat.sessions,
      generations,
      selectModel:
        chat.selectModel ?? ((tenantId?: string) => selectModel(resolveDefault(tenantId))),
      ...(ctx.tokenUsage ? { usage: ctx.tokenUsage } : {}),
      defaultTokenLimit: resolveDefaultTokenLimit,
      cacheWeight: resolveCacheWeight,
      maxOutputTokens: resolveMaxOutputTokens,
      ...(ctx.metrics ? { metrics: ctx.metrics } : {}),
    }),
  );

  // Per-user self view of token usage/quota (token metering) — any signed-in user.
  if (ctx.tokenUsage) {
    app.route(
      '/api/me',
      meRoutes(ctx.users, ctx.tokenUsage, {
        defaultTokenLimit: resolveDefaultTokenLimit,
        cacheWeight: resolveCacheWeight,
        sessionResolver: ctx.sessionResolver,
        chatSessions: ctx.chatSessions,
        generations,
        apiKeys: ctx.apiKeys,
        apiUsage: ctx.apiUsage,
        apiQuotaWindowSec: meterConfig.quotaWindowSec,
        tenants: ctx.tenants,
      }),
    );
  }

  // Backend auth endpoints (find-or-create app user + tier; logout URL). Self-service login/register
  // are Kratos flows driven by the SPA via the /kratos proxy.
  app.route(
    '/api/auth',
    authRoutes(ctx.users, ctx.kratosPublicUrl ?? 'http://localhost:14433', ctx.sessionResolver),
  );

  // Organization (tenant) self-management (spec 029) — active org + member admin. Mounted only when a
  // tenants repo is wired (always in prod); super-admin org CRUD lives under /api/admin.
  if (ctx.tenants) {
    app.route(
      '/api/tenant',
      tenantRoutes(ctx.users, ctx.tenants, {
        sessionResolver: ctx.sessionResolver,
        apiKeys: ctx.apiKeys,
        settings: ctx.settings,
      }),
    );
  }

  // Admin platform settings (spec 019) + per-user token usage/quota admin (token metering) — mounted
  // only when a settings repo is wired (always in prod).
  if (ctx.settings) {
    app.route(
      '/api/admin',
      adminRoutes(ctx.users, ctx.settings, {
        sessionResolver: ctx.sessionResolver,
        apiKeys: ctx.apiKeys,
        apiUsage: ctx.apiUsage,
        apiQuotaWindowSec: meterConfig.quotaWindowSec,
        tokenUsage: ctx.tokenUsage,
        tenants: ctx.tenants,
        defaultTokenLimit: resolveDefaultTokenLimit,
        cacheWeight: resolveCacheWeight,
      }),
    );
  }

  app.get('/healthz', (c) => {
    const h = ctx.health();
    const status = h.isStale || h.defaultProvider === 'absent' ? 'degraded' : 'ok';
    return c.json({
      status,
      lastSyncedAt: h.lastSyncedAt,
      isStale: h.isStale,
      components: { store: 'ok', boundaries: 'ok', defaultProvider: h.defaultProvider },
    });
  });

  // Readiness (spec 030): "can this process serve traffic?" — DB reachable + schema current. 503 when
  // not ready (a deploy with a pending migration), so an orchestrator holds traffic until it is.
  const readiness = ctx.readiness;
  if (readiness) {
    app.get('/readyz', (c) => {
      const r = readiness();
      return c.json(r, r.ready ? 200 : 503);
    });
  }

  // Prometheus metrics (spec 030 RED, deepened in 032): counters from the registry + scrape-time gauges
  // (active detached generations, index freshness). Scraped by the OTel collector (in the commercial
  // deploy repo, danni-bg/deploy).
  // Unlike /healthz + /readyz (public probes), /metrics is GATED (spec 045 FR-273): it leaks traffic
  // volumes, per-tenant labels, and LLM spend. A bearer token / CIDR allowlist admits a scraper; a
  // non-dev profile with no gate configured fails closed (404), never leaking.
  const metrics = ctx.metrics;
  if (metrics) {
    const metricsGate = ctx.metricsGate ?? metricsGateFromEnv(process.env);
    app.get('/metrics', (c) => {
      if (!metricsAllowed(metricsGate, c)) return c.body(null, 404);
      return c.text(
        metrics.prometheus({
          danni_active_generations: generations.activeCount(),
          danni_index_stale: ctx.health().isStale ? 1 : 0,
        }),
        200,
        { 'content-type': 'text/plain; version=0.0.4' },
      );
    });
  }

  // All in-scope datasets, honoring the structured filters (used by list / regions / national /
  // facets). Bulk lite projection (see ReadBridge.listLite) — not a per-dataset view fan-out — so
  // these whole-catalog endpoints scale to the full ~11k-dataset mirror.
  // Oblast geo filters expand to include their municipalities so the filtered list matches the
  // choropleth roll-up (spec 013): selecting Стара Загора must count its municipalities' datasets
  // too, not just oblast-level ones. The part_of graph is static at runtime, so memoize it.
  let childrenOfCache: Map<string, string[]> | null = null;
  const childrenOf = () => {
    childrenOfCache ??= ctx.bridge.partOfChildren();
    return childrenOfCache;
  };
  const expandGeo = (f: FilterState): FilterState =>
    f.geoUnitIds.length === 0
      ? f
      : { ...f, geoUnitIds: expandGeoUnitIds(f.geoUnitIds, childrenOf()) };

  const scopedLites = (f: FilterState) => {
    const ef = expandGeo(f);
    return ctx.bridge.listLite().filter((l) => matchesFiltersLite(l, ef));
  };

  // Maps a dataset's geo-link entity id to the region ids (at `level`) it should count toward.
  // Municipalities roll up into their parent oblast via the `part_of` knowledge-graph edges
  // (`parentOf`), so an oblast aggregates its own direct links plus all of its municipalities'
  // (de-duplicated per dataset in the aggregator / belongs check). Level is read from the entity-id
  // namespace; the parent comes from the graph, not the gazetteer crosswalk.
  const rollupTargets =
    (level: 'oblast' | 'municipality', parentOf: Map<string, string>) =>
    (linkEntityId: string): string[] => {
      const isOblast = linkEntityId.startsWith('geo:bg-oblast-');
      const isMunicipality = linkEntityId.startsWith('geo:bg-municipality-');
      if (level === 'municipality') return isMunicipality ? [linkEntityId] : [];
      if (isOblast) return [linkEntityId];
      if (isMunicipality) {
        const parent = parentOf.get(linkEntityId);
        return parent ? [parent] : [];
      }
      return [];
    };

  app.get('/api/datasets', async (c) => {
    const f = parseFilters(new URL(c.req.url).searchParams);
    const q = new URL(c.req.url).searchParams;
    const limit = clampInt(q.get('limit'), 50, 200);
    const offset = clampInt(q.get('offset'), 0, Number.MAX_SAFE_INTEGER);

    let pointers: DatasetPointer[];
    if (f.query.trim() !== '') {
      const ef = expandGeo(f);
      // Ranking-only hits (ids+scores) resolved through the bulk `listLite` projection, not a
      // per-hit `bridge.view()` fan-out (spec 050 FR-323): a bounded set of queries for all hits,
      // independent of hit count — parity with the no-query path below. Search-relevance order and
      // per-hit score are preserved; structured filters use the same predicate as the lite path.
      const hits = await ctx.bridge.searchRanked(f.query, 200);
      const liteById = new Map(ctx.bridge.listLite().map((l) => [l.datasetId, l]));
      const seen = new Set<string>();
      pointers = [];
      for (const hit of hits) {
        if (seen.has(hit.datasetId)) continue;
        seen.add(hit.datasetId);
        const lite = liteById.get(hit.datasetId);
        if (lite && matchesFiltersLite(lite, ef)) pointers.push(liteToPointer(lite, hit.score));
      }
    } else {
      pointers = scopedLites(f).map((l) => liteToPointer(l));
    }

    const total = pointers.length;
    return c.json({ datasets: pointers.slice(offset, offset + limit), total, limit, offset });
  });

  app.get('/api/datasets/:datasetId', (c) => {
    try {
      // Cap related-dataset links/entities: high-degree datasets carry 14k+ links (the link
      // heuristic forms large cliques), which bloats the detail payload sent to the browser.
      return c.json(capDatasetDetail(ctx.bridge.detail(c.req.param('datasetId'))));
    } catch {
      const e = err('not_found', 'dataset not found', 404);
      return c.json(e.body, e.status);
    }
  });

  // Entity knowledge-graph node: the entity plus its typed entity<->entity relations (e.g. a
  // municipality's parent oblast, an oblast's child municipalities) and its direct dataset count.
  app.get('/api/entities/:entityId', (c) => {
    const graph = ctx.bridge.entityGraph(c.req.param('entityId'));
    if (!graph) {
      const e = err('not_found', 'unknown entity', 404);
      return c.json(e.body, e.status);
    }
    return c.json(graph);
  });

  app.get('/api/datasets/:datasetId/resources/:resourceId/rows', (c) => {
    const q = new URL(c.req.url).searchParams;
    const limit = clampInt(q.get('limit'), 100, 1000);
    const offset = clampInt(q.get('offset'), 0, Number.MAX_SAFE_INTEGER);
    // Optional server-side grid: ?sort=<col>&dir=asc|desc&filters=<json {col:substring}>.
    const sortCol = q.get('sort');
    const dir: 'asc' | 'desc' = q.get('dir') === 'desc' ? 'desc' : 'asc';
    const filters: Record<string, string> = {};
    const filtersRaw = q.get('filters');
    if (filtersRaw) {
      try {
        const parsed = JSON.parse(filtersRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') filters[k] = v;
        }
      } catch {
        // Malformed filters are ignored rather than failing the request.
      }
    }
    const grid = { sort: sortCol ? { col: sortCol, dir } : null, filters };
    try {
      return c.json(
        ctx.bridge.rows(c.req.param('datasetId'), c.req.param('resourceId'), limit, offset, grid),
      );
    } catch {
      const e = err('not_found', 'resource not found', 404);
      return c.json(e.body, e.status);
    }
  });

  app.get('/api/regions', (c) => {
    const q = new URL(c.req.url).searchParams;
    const level = q.get('level') === 'municipality' ? 'municipality' : 'oblast';
    const f = parseFilters(q);
    const datasets = scopedLites(f).map((l) => ({
      datasetId: l.datasetId,
      geoLinks: l.geoLinks,
    }));
    const parentOf = ctx.bridge.partOfParents();
    const regions: RegionSummary[] = aggregateRegions({
      entries: ctx.crosswalk.entriesForLevel(level),
      labelOf: (id) => LABELS.get(id),
      datasets,
      rollup: rollupTargets(level, parentOf),
      parentOf: (id) => parentOf.get(id),
    });
    return c.json({ regions });
  });

  app.get('/api/regions/:entityId', (c) => {
    const entityId = c.req.param('entityId');
    const entry = ctx.crosswalk.entry(entityId);
    if (!entry) {
      const e = err('not_found', 'unknown or unlinked region', 404);
      return c.json(e.body, e.status);
    }
    const q = new URL(c.req.url).searchParams;
    const f = parseFilters(q);
    const limit = clampInt(q.get('limit'), 50, 200);
    const offset = clampInt(q.get('offset'), 0, Number.MAX_SAFE_INTEGER);
    // Roll-up–aware membership: an oblast also contains datasets linked to any of its
    // municipalities. `belongsConfidence` returns the strongest confidence among the links that
    // roll up to this region, or -1 when none — so the list + count match the aggregate exactly,
    // and each dataset is included at most once.
    const targetsFor = rollupTargets(entry.level, ctx.bridge.partOfParents());
    const belongsConfidence = (l: DatasetLite): number => {
      let best = -1;
      for (const g of l.geoLinks)
        if (targetsFor(g.entityId).includes(entityId) && g.confidence > best) best = g.confidence;
      return best;
    };
    const lites = scopedLites(f).filter((l) => belongsConfidence(l) >= 0);
    const label = LABELS.get(entityId);
    const region: RegionSummary = {
      entityId,
      level: entry.level,
      labelBg: label?.labelBg ?? entityId,
      labelEn: label?.labelEn ?? null,
      boundaryFeatureId: entry.boundaryFeatureId,
      datasetCount: lites.length,
      hasData: lites.length > 0,
      maxConfidence: lites.reduce((m, l) => Math.max(m, belongsConfidence(l)), 0),
    };
    const datasets = lites.slice(offset, offset + limit).map((l) => liteToPointer(l));
    return c.json({ region, datasets, total: lites.length });
  });

  // National / non-georeferenced grouping: datasets with no geographic entity, so they remain
  // discoverable rather than being dropped off the map (FR-006, SC-009).
  app.get('/api/national', (c) => {
    const q = new URL(c.req.url).searchParams;
    const f = parseFilters(q);
    const limit = clampInt(q.get('limit'), 50, 200);
    const offset = clampInt(q.get('offset'), 0, Number.MAX_SAFE_INTEGER);
    const lites = scopedLites(f).filter((l) => !hasGeo(l));
    const datasets = lites.slice(offset, offset + limit).map((l) => liteToPointer(l));
    return c.json({ datasets, total: lites.length, limit, offset });
  });

  app.get('/api/facets', (c) => {
    const f = parseFilters(new URL(c.req.url).searchParams);
    const lites = scopedLites(f);
    const tags = new Map<string, number>();
    const publishers = new Map<string, { labelBg: string; count: number }>();
    let fresh = 0;
    let stale = 0;
    for (const l of lites) {
      for (const t of l.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
      if (l.publisherId) {
        const p = publishers.get(l.publisherId) ?? { labelBg: l.publisherTitleBg ?? '', count: 0 };
        p.count += 1;
        publishers.set(l.publisherId, p);
      }
      if (l.freshness.isStale) stale += 1;
      else fresh += 1;
    }
    const facets: Facets = {
      tags: [...tags].map(([id, count]) => ({ id, labelBg: id, count })),
      publishers: [...publishers].map(([id, p]) => ({ id, labelBg: p.labelBg, count: p.count })),
      freshnessBuckets: [
        { id: 'fresh', count: fresh },
        { id: 'stale', count: stale },
      ],
    };
    return c.json(facets);
  });

  app.onError((e, c) => {
    if (e instanceof Error && e.name === 'ZodError') {
      const env = err('bad_request', 'invalid request parameters', 400, JSON.parse(e.message));
      return c.json(env.body, env.status);
    }
    const env = err('internal', 'internal error', 500);
    return c.json(env.body, env.status);
  });

  return app;
}
