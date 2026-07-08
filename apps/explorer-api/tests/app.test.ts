// Route-level contract tests for the explorer API against a seeded in-memory store
// (covers T016 healthz, T019 regions, T020 dataset detail, T032 datasets list, T033 facets,
// T073 no-auth). Datasets are seeded via the existing repos; the embedder is the deterministic stub.

import type { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { runIndex } from '../../../src/index/run-index.ts';
import { openDb } from '../../../src/store/db.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../../src/store/repos/entities.ts';
import { EntityRelationsRepo } from '../../../src/store/repos/entity-relations.ts';
import { OrganizationsRepo } from '../../../src/store/repos/organizations.ts';
import { ResourcesRepo } from '../../../src/store/repos/resources.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import { ReadBridge } from '../src/read-bridge.ts';

// This suite drives gated routes via X-User-* headers, which requires the explicit trust opt-in
// (spec 034 FR-164; hermetic — no live Kratos, Constitution VI).
beforeAll(() => {
  process.env.TRUST_PROXY_AUTH_HEADERS = 'true';
});
afterAll(() => {
  delete process.env.TRUST_PROXY_AUTH_HEADERS;
});

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function seed(db: Database): void {
  const orgs = new OrganizationsRepo(db);
  orgs.upsert({ id: 'p1', slug: 'p1', titleBg: 'Столична община', sourceUrl: 'https://x/p1' });
  const ds = new DatasetsRepo(db);
  ds.upsert({
    id: 'd1',
    slug: 'd1',
    titleBg: 'Качество на въздуха',
    publisherId: 'p1',
    tags: ['въздух'],
    groups: [],
    sourceUrl: 'https://data.egov.bg/d1',
  });
  ds.upsert({
    id: 'd2',
    slug: 'd2',
    titleBg: 'Бюджет',
    publisherId: 'p1',
    tags: ['бюджет'],
    groups: [],
    sourceUrl: 'https://data.egov.bg/d2',
  });
  new ResourcesRepo(db).upsert({
    id: 'r1',
    datasetId: 'd1',
    sourceUrl: 'https://data.egov.bg/d1/r1',
    name: 'rows',
  });
  const ents = new EntitiesRepo(db);
  ents.upsert({
    id: 'geo:bg-oblast-sofia-grad',
    kind: 'geographic_unit',
    canonicalLabelBg: 'София (град)',
  });
  ents.attach({
    datasetId: 'd1',
    entityId: 'geo:bg-oblast-sofia-grad',
    extractor: 'gaz',
    confidence: 0.9,
  });
  ents.attach({
    datasetId: 'd2',
    entityId: 'geo:bg-oblast-sofia-grad',
    extractor: 'gaz',
    confidence: 0.6,
  });
}

describe('explorer API routes', () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    seed(db);
    const embedder = new LocalOnnxEmbedder({ dimension: 8 });
    await runIndex({ db, embedder });
    const bridge = new ReadBridge({ db, storeRoot, embedder, freshnessSloSeconds: 86400 });
    const ctx: AppContext = {
      bridge,
      crosswalk: new Crosswalk(loadCrosswalk()),
      users: new UsersRepo(db),
      health: () => ({
        lastSyncedAt: '2026-06-01T00:00:00Z',
        isStale: false,
        defaultProvider: 'absent',
      }),
    };
    app = createApp(ctx);
  });
  afterEach(() => db.close());

  it('GET /healthz reports degraded when the default provider is absent', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; components: { defaultProvider: string } };
    expect(body.status).toBe('degraded');
    expect(body.components.defaultProvider).toBe('absent');
  });

  it('POST /api/auth/callback materializes the app user + reports the tier', async () => {
    const headers = {
      'content-type': 'application/json',
      'x-user-id': 'k-callback',
      'x-user-email': 'cb@example.com',
      'x-user-verified': 'true',
    };
    const res = await app.request('/api/auth/callback', { method: 'POST', headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string; role: string }; isAdmin: boolean };
    expect(body.user.email).toBe('cb@example.com');
    expect(body.user.role).toBe('user');
    expect(body.isAdmin).toBe(false);
  });

  it('POST /api/auth/callback requires a session (401 anonymous)', async () => {
    const res = await app.request('/api/auth/callback', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/logout returns the Kratos logout URL', async () => {
    const res = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { 'x-user-id': 'k-lo', 'x-user-email': 'lo@example.com' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logoutUrl: string };
    expect(body.logoutUrl).toContain('/self-service/logout/browser');
  });

  it('GET /api/datasets lists all, no auth header required', async () => {
    const res = await app.request('/api/datasets');
    const body = (await res.json()) as { total: number; datasets: { datasetId: string }[] };
    expect(res.status).toBe(200);
    expect(body.total).toBe(2);
  });

  it('GET /api/datasets filters by tag (AND)', async () => {
    const res = await app.request('/api/datasets?tags=въздух');
    const body = (await res.json()) as { total: number; datasets: { datasetId: string }[] };
    expect(body.datasets.map((d) => d.datasetId)).toEqual(['d1']);
  });

  it('GET /api/datasets with q runs ranked search', async () => {
    const res = await app.request(`/api/datasets?q=${encodeURIComponent('въздух')}`);
    const body = (await res.json()) as { datasets: { datasetId: string }[] };
    expect(body.datasets.some((d) => d.datasetId === 'd1')).toBe(true);
  });

  it('GET /api/datasets/:id returns detail; unknown id 404', async () => {
    const ok = await app.request('/api/datasets/d1');
    expect(ok.status).toBe(200);
    const d = (await ok.json()) as { titleBg: string; geoEntityIds: string[] };
    expect(d.titleBg).toBe('Качество на въздуха');
    expect(d.geoEntityIds).toContain('geo:bg-oblast-sofia-grad');
    const miss = await app.request('/api/datasets/nope');
    expect(miss.status).toBe(404);
  });

  it('GET /api/regions aggregates per oblast with deduped counts', async () => {
    const res = await app.request('/api/regions?level=oblast');
    const body = (await res.json()) as {
      regions: { entityId: string | null; datasetCount: number; maxConfidence: number }[];
    };
    const sofia = body.regions.find((r) => r.entityId === 'geo:bg-oblast-sofia-grad');
    expect(sofia?.datasetCount).toBe(2);
    expect(sofia?.maxConfidence).toBe(0.9);
  });

  it('GET /api/regions/:id lists datasets; empty + 404 cases', async () => {
    const res = await app.request('/api/regions/geo:bg-oblast-sofia-grad');
    const body = (await res.json()) as { total: number; region: { hasData: boolean } };
    expect(body.total).toBe(2);
    expect(body.region.hasData).toBe(true);

    const empty = await app.request('/api/regions/geo:bg-oblast-varna');
    const eb = (await empty.json()) as { total: number; datasets: unknown[] };
    expect(empty.status).toBe(200);
    expect(eb.total).toBe(0);
    expect(eb.datasets).toEqual([]);

    const bad = await app.request('/api/regions/geo:bg-oblast-unmapped-xyz');
    expect(bad.status).toBe(404);
  });

  it('GET /api/entities/:id returns the knowledge-graph node with typed relations', async () => {
    // Seed a municipality linked to a dataset, and a part_of edge to the (seeded) oblast.
    const ents = new EntitiesRepo(db);
    ents.upsert({
      id: 'geo:bg-municipality-stolichna',
      kind: 'geographic_unit',
      canonicalLabelBg: 'Столична',
    });
    ents.attach({
      datasetId: 'd1',
      entityId: 'geo:bg-municipality-stolichna',
      extractor: 'g',
      confidence: 0.9,
    });
    new EntityRelationsRepo(db).upsert({
      subjectId: 'geo:bg-municipality-stolichna',
      predicate: 'part_of',
      objectId: 'geo:bg-oblast-sofia-grad',
      confidence: 1,
    });

    const muni = (await (
      await app.request('/api/entities/geo:bg-municipality-stolichna')
    ).json()) as {
      entity: { kind: string };
      out: { predicate: string; entity: { entityId: string } }[];
      datasetCount: number;
    };
    expect(muni.entity.kind).toBe('geographic_unit');
    expect(muni.out).toHaveLength(1);
    expect(muni.out[0]?.predicate).toBe('part_of');
    expect(muni.out[0]?.entity.entityId).toBe('geo:bg-oblast-sofia-grad');
    expect(muni.datasetCount).toBe(1);

    // Reverse edge is visible from the oblast.
    const oblast = (await (await app.request('/api/entities/geo:bg-oblast-sofia-grad')).json()) as {
      in: { entity: { entityId: string } }[];
    };
    expect(oblast.in.some((e) => e.entity.entityId === 'geo:bg-municipality-stolichna')).toBe(true);

    const miss = await app.request('/api/entities/nope');
    expect(miss.status).toBe(404);
  });

  it('GET /api/regions rolls municipalities into their oblast via the part_of graph', async () => {
    // A dataset tagged to a municipality only (no direct oblast link).
    new DatasetsRepo(db).upsert({
      id: 'd3',
      slug: 'd3',
      titleBg: 'Общински',
      tags: [],
      groups: [],
      sourceUrl: 'https://x/d3',
    });
    const ents = new EntitiesRepo(db);
    ents.upsert({
      id: 'geo:bg-municipality-stolichna',
      kind: 'geographic_unit',
      canonicalLabelBg: 'Столична',
    });
    ents.attach({
      datasetId: 'd3',
      entityId: 'geo:bg-municipality-stolichna',
      extractor: 'g',
      confidence: 0.8,
    });

    const oblastCount = async () => {
      const body = (await (await app.request('/api/regions?level=oblast')).json()) as {
        regions: { entityId: string | null; datasetCount: number }[];
      };
      return body.regions.find((r) => r.entityId === 'geo:bg-oblast-sofia-grad')?.datasetCount;
    };

    // No part_of edge yet → the municipality does NOT roll into the oblast (only d1, d2 directly).
    expect(await oblastCount()).toBe(2);

    // Assert the graph edge → d3 now rolls up into Sofia-grad.
    new EntityRelationsRepo(db).upsert({
      subjectId: 'geo:bg-municipality-stolichna',
      predicate: 'part_of',
      objectId: 'geo:bg-oblast-sofia-grad',
      confidence: 1,
    });
    expect(await oblastCount()).toBe(3);

    // The municipality region carries the graph-sourced parent (drives map drill-down).
    const muni = (await (await app.request('/api/regions?level=municipality')).json()) as {
      regions: { entityId: string | null; oblastEntityId?: string | null; datasetCount: number }[];
    };
    const st = muni.regions.find((r) => r.entityId === 'geo:bg-municipality-stolichna');
    expect(st?.datasetCount).toBe(1);
    expect(st?.oblastEntityId).toBe('geo:bg-oblast-sofia-grad');
  });

  it('GET /api/datasets?geoUnitIds expands the geo filter via the part_of children map', async () => {
    // A non-empty geoUnitIds filter drives expandGeo → childrenOf() → bridge.partOfChildren()
    // (app.ts 348-349); d1 + d2 are linked directly to the oblast so they stay in scope.
    const res = await app.request('/api/datasets?geoUnitIds=geo:bg-oblast-sofia-grad');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { datasets: { datasetId: string }[] };
    // d1 + d2 are linked directly to the oblast, so they are in the expanded scope.
    expect(body.datasets.map((d) => d.datasetId).sort()).toEqual(['d1', 'd2']);
  });

  it('GET /api/regions?level=oblast ignores a geo link that is neither oblast nor municipality', async () => {
    // A settlement-level geo link rolls up to nothing at the oblast level (app.ts final `return []`).
    new DatasetsRepo(db).upsert({
      id: 'd5',
      slug: 'd5',
      titleBg: 'Селищен',
      tags: [],
      groups: [],
      sourceUrl: 'https://x/d5',
    });
    const ents = new EntitiesRepo(db);
    ents.upsert({ id: 'geo:bg-ekatte-12345', kind: 'geographic_unit', canonicalLabelBg: 'Село' });
    ents.upsert({
      id: 'geo:bg-ekatte-67890',
      kind: 'geographic_unit',
      canonicalLabelBg: 'Друго село',
    });
    ents.attach({
      datasetId: 'd5',
      entityId: 'geo:bg-ekatte-12345',
      extractor: 'g',
      confidence: 0.7,
    });
    // A SECOND geo link on the same dataset (also non-oblast/non-municipality) makes listLite sort
    // its geoLinks (read-bridge.ts sort comparator, which only runs on ≥2 entries) without changing
    // any oblast roll-up count.
    ents.attach({
      datasetId: 'd5',
      entityId: 'geo:bg-ekatte-67890',
      extractor: 'g',
      confidence: 0.5,
    });
    const body = (await (await app.request('/api/regions?level=oblast')).json()) as {
      regions: { entityId: string | null; datasetCount: number }[];
    };
    // The settlement link contributes to no oblast; Sofia-grad still counts only its direct d1 + d2.
    expect(body.regions.find((r) => r.entityId === 'geo:bg-oblast-sofia-grad')?.datasetCount).toBe(
      2,
    );
  });

  it('GET resource rows applies a valid JSON column filter', async () => {
    // A well-formed ?filters JSON object drives the parse-success branch (app.ts 444-449).
    const res = await app.request(
      `/api/datasets/d1/resources/r1/rows?limit=10&filters=${encodeURIComponent(JSON.stringify({ col: 'x', ignored: 5 }))}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { datasetId: string };
    expect(body.datasetId).toBe('d1');
  });

  it('GET /api/facets returns in-scope tag/publisher/freshness counts', async () => {
    const res = await app.request('/api/facets');
    const body = (await res.json()) as {
      tags: { id: string }[];
      publishers: { count: number }[];
      freshnessBuckets: { id: string; count: number }[];
    };
    expect(body.tags.map((t) => t.id).sort()).toEqual(['бюджет', 'въздух']);
    expect(body.publishers[0]?.count).toBe(2);
    expect(body.freshnessBuckets.find((b) => b.id === 'fresh')?.count).toBe(2);
  });

  it('GET resource rows returns content; missing resource 404', async () => {
    const ok = await app.request('/api/datasets/d1/resources/r1/rows?limit=10');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { datasetId: string; total: number };
    expect(body.datasetId).toBe('d1');
    const miss = await app.request('/api/datasets/d1/resources/nope/rows');
    expect(miss.status).toBe(404);
  });

  it('maps invalid query params to a 400 bad_request envelope', async () => {
    const res = await app.request('/api/datasets?freshness=bogus');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('maps an unexpected handler error to a 500 internal envelope', async () => {
    const boom: AppContext = {
      bridge: {
        listAllIds: () => {
          throw new Error('boom');
        },
      } as unknown as ReadBridge,
      crosswalk: new Crosswalk(loadCrosswalk()),
      users: new UsersRepo(db),
      health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    };
    const res = await createApp(boom).request('/api/facets');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('internal');
  });
});
