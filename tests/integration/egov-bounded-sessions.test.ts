import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DanniConfig } from '../../src/config/schema.ts';
import { runEgovSyncRun } from '../../src/crawler/run-egov-sync.ts';
import { computeScopeHash } from '../../src/crawler/scope-hash.ts';
import { openDb } from '../../src/store/db.ts';
import { runMigrations } from '../../src/store/migrate.ts';
import { CrawlCheckpointsRepo } from '../../src/store/repos/crawl-checkpoints.ts';
import { makeCatalog } from './egov-fixtures.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function testConfig(): DanniConfig {
  return {
    schedule: {
      onOverlap: 'skip',
      failureRateThreshold: 1,
      enabled: false,
      notifier: { kind: 'stderr' },
    },
    scope: {},
  } as unknown as DanniConfig;
}

function corpusSnapshot(storeRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(join(dir, ent.name), childRel);
      else out.push(`${childRel}\t${readFileSync(join(dir, ent.name), 'utf-8')}`);
    }
  };
  try {
    walk(join(storeRoot, 'raw'), '');
  } catch {
    // none yet
  }
  return out.sort();
}

describe('integration.egov-bounded-sessions (US2: multi-session exact-once coverage)', () => {
  let db: Database;
  let storeRoot: string;
  beforeEach(() => {
    storeRoot = globalThis.__TEST_TMP_DIR__;
    db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
  });
  afterEach(() => {
    db.close();
  });

  it('several --max sessions cover every dataset exactly once; the union equals one uncapped run', async () => {
    const config = testConfig();
    const N = 7;
    const catalog = makeCatalog(N, 2);
    const { scopeHash } = computeScopeHash({});
    const repo = new CrawlCheckpointsRepo(db);

    const visitedPerSession: string[][] = [];
    let guard = 0;
    for (;;) {
      const cursorBefore = repo.getCampaign(scopeHash)?.cursor_uri ?? null;
      const r = await runEgovSyncRun({
        db,
        config,
        client: catalog.client(),
        storeRoot,
        trigger: 'manual',
        scope: {},
        max: 3,
      });
      const cursorAfter = repo.getCampaign(scopeHash)?.cursor_uri ?? null;
      // (a) each session advances the cursor (unless already done) and processes ≤ max.
      expect(r.totals.discovered).toBeLessThanOrEqual(3);
      const frozen = repo.frozenIds(scopeHash);
      const startIdx = cursorBefore === null ? 0 : frozen.indexOf(cursorBefore) + 1;
      const endIdx = cursorAfter === null ? -1 : frozen.indexOf(cursorAfter);
      visitedPerSession.push(frozen.slice(startIdx, endIdx + 1));
      if (r.completed) break;
      if (++guard > 20) throw new Error('did not converge to completed');
    }
    expect(repo.getCampaign(scopeHash)?.status).toBe('completed');

    // (b) every dataset visited exactly once (no gaps/dupes).
    const visited = visitedPerSession.flat();
    expect(new Set(visited).size).toBe(visited.length);
    expect(visited.sort()).toEqual(
      Array.from({ length: N }, (_, i) => `ds-${String(i).padStart(3, '0')}`),
    );
    expect(repo.counts(scopeHash).captured).toBe(N);

    // (c) the union corpus byte-equals a single uncapped run.
    const batched = corpusSnapshot(storeRoot);
    const storeRoot2 = `${storeRoot}-single`;
    const db2 = openDb({ storeRoot: storeRoot2, loadVec: false });
    runMigrations(db2, join(ROOT, 'migrations'));
    const catB = makeCatalog(N, 2);
    await runEgovSyncRun({
      db: db2,
      config,
      client: catB.client(),
      storeRoot: storeRoot2,
      trigger: 'manual',
      scope: {},
    });
    expect(batched).toEqual(corpusSnapshot(storeRoot2));
    db2.close();
  });

  it('an extra session after completion (no upstream change) does zero captures (SC-005)', async () => {
    const config = testConfig();
    const catalog = makeCatalog(4, 2);
    const { scopeHash } = computeScopeHash({});
    // Drive to completion.
    let r = await runEgovSyncRun({
      db,
      config,
      client: catalog.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
    });
    expect(r.completed).toBe(true);
    expect(new CrawlCheckpointsRepo(db).getCampaign(scopeHash)?.status).toBe('completed');

    const resourceCallsBefore = { ...catalog.calls.getResourceData };
    // Extra session: zero captures (every validator matches, every resource success).
    r = await runEgovSyncRun({
      db,
      config,
      client: catalog.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
    });
    expect(r.totals.captured).toBe(0);
    for (const uri of Object.keys(resourceCallsBefore)) {
      expect(catalog.resourceDataCalls(uri)).toBe(resourceCallsBefore[uri] ?? 0);
    }
    // It re-converges to completed.
    expect(r.completed).toBe(true);
  });
});
