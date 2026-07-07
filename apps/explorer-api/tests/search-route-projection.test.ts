// spec 050 FR-323 / SC-2: GET /api/datasets?q resolves ranked hits through the bulk `listLite`
// projection, NOT a per-hit `bridge.view()` fan-out. A request returning many hits must call
// listLite() once and view() zero times, yet still return correct DatasetPointers (parity with the
// no-query path) — i.e. a bounded set of queries independent of hit count.

import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { runIndex } from '../../../src/index/run-index.ts';
import { openDb } from '../../../src/store/db.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { OrganizationsRepo } from '../../../src/store/repos/organizations.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import { ReadBridge } from '../src/read-bridge.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('explorer search route bulk projection (spec 050)', () => {
  let db: Database;
  let bridge: ReadBridge;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    new OrganizationsRepo(db).upsert({
      id: 'p1',
      slug: 'p1',
      titleBg: 'Издател',
      sourceUrl: 'https://x/p1',
    });
    const ds = new DatasetsRepo(db);
    for (let i = 0; i < 30; i++) {
      ds.upsert({
        id: `d${i}`,
        slug: `d${i}`,
        titleBg: `Бюджет ${i}`,
        descriptionBg: `Описание за бюджет ${i}`,
        publisherId: 'p1',
        tags: [],
        groups: [],
        sourceUrl: `https://x/d${i}`,
      });
    }
    const embedder = new LocalOnnxEmbedder({ dimension: 8 });
    await runIndex({ db, embedder });
    bridge = new ReadBridge({ db, storeRoot, embedder, freshnessSloSeconds: 86400 });
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

  it('serves ?q results via one bulk listLite() and zero per-hit view() calls (SC-2)', async () => {
    const viewSpy = spyOn(bridge, 'view');
    const liteSpy = spyOn(bridge, 'listLite');

    const res = await app.request(`/api/datasets?q=${encodeURIComponent('бюджет')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      datasets: { datasetId: string; score: number | null; publisher: { id: string } | null }[];
    };

    // Many hits (every "Бюджет N" dataset matches the keyword leg)…
    expect(body.total).toBeGreaterThan(5);
    // …resolved with a bounded set of queries, independent of hit count:
    expect(liteSpy).toHaveBeenCalledTimes(1);
    expect(viewSpy).toHaveBeenCalledTimes(0);

    // Pointers still carry the projected fields + the search score.
    const first = body.datasets[0];
    expect(first?.datasetId).toBeDefined();
    expect(typeof first?.score).toBe('number');
    expect(first?.publisher?.id).toBe('p1');

    viewSpy.mockRestore();
    liteSpy.mockRestore();
  });
});
