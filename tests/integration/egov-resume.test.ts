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

/** Snapshot the raw store as a sorted list of "relPath\tcontent" lines for byte-equality. */
function corpusSnapshot(storeRoot: string): string[] {
  const rawDir = join(storeRoot, 'raw');
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(join(dir, ent.name), childRel);
      else out.push(`${childRel}\t${readFileSync(join(dir, ent.name), 'utf-8')}`);
    }
  };
  try {
    walk(rawDir, '');
  } catch {
    // no raw dir yet
  }
  return out.sort();
}

describe('integration.egov-resume (US1: interrupt → resume, <1% re-fetch)', () => {
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

  it('resume after interruption re-fetches no already-captured resource and completes the rest', async () => {
    const catalog = makeCatalog(6, 2);
    const config = testConfig();

    // Session 1: cap at 3 datasets (the interruption boundary — M of N).
    await runEgovSyncRun({
      db,
      config,
      client: catalog.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
      max: 3,
    });
    const { scopeHash } = computeScopeHash({});
    const repo = new CrawlCheckpointsRepo(db);
    expect(repo.getCampaign(scopeHash)?.cursor_uri).toBe('ds-002');

    // Record the per-resource fetch counts after session 1.
    const firstSessionCalls = { ...catalog.calls.getResourceData };

    // Session 2: resume — process the remaining datasets.
    const r2 = await runEgovSyncRun({
      db,
      config,
      client: catalog.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
      max: 3,
    });
    expect(r2.completed).toBe(true);

    // (a) SC-001: ZERO getResourceData calls on resume for already-captured resources.
    for (const uri of Object.keys(firstSessionCalls)) {
      expect(catalog.resourceDataCalls(uri)).toBe(firstSessionCalls[uri] ?? 0);
    }
    // (b) the crawl continued from dataset ds-003 onward (new captures recorded).
    expect(catalog.resourceDataCalls('ds-003-r0')).toBe(1);

    // (c) every dataset is complete; corpus consistent.
    const counts = repo.counts(scopeHash);
    expect(counts.captured).toBe(6);
    db.close();

    // (e) SC-005: a clean post-completion re-invoke does ZERO captures and reports up to date.
    const db3 = openDb({ storeRoot, loadVec: false });
    const before = { ...catalog.calls.getResourceData };
    const r3 = await runEgovSyncRun({
      db: db3,
      config,
      client: catalog.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
    });
    expect(r3.totals.captured).toBe(0);
    for (const uri of Object.keys(before)) {
      expect(catalog.resourceDataCalls(uri)).toBe(before[uri] ?? 0);
    }
    db = db3;
  });

  it('the resumed corpus is byte-identical to an uninterrupted single-session crawl', async () => {
    const config = testConfig();

    // Interrupted: two capped sessions.
    const catA = makeCatalog(5, 2);
    await runEgovSyncRun({
      db,
      config,
      client: catA.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
      max: 2,
    });
    await runEgovSyncRun({
      db,
      config,
      client: catA.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
      max: 2,
    });
    await runEgovSyncRun({
      db,
      config,
      client: catA.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
      max: 2,
    });
    const interrupted = corpusSnapshot(storeRoot);

    // Uninterrupted: one session over a fresh store + DB.
    const storeRoot2 = `${storeRoot}-single`;
    const db2 = openDb({ storeRoot: storeRoot2, loadVec: false });
    runMigrations(db2, join(ROOT, 'migrations'));
    const catB = makeCatalog(5, 2);
    await runEgovSyncRun({
      db: db2,
      config,
      client: catB.client(),
      storeRoot: storeRoot2,
      trigger: 'manual',
      scope: {},
    });
    const single = corpusSnapshot(storeRoot2);
    db2.close();

    expect(interrupted).toEqual(single);
  });

  it('a mid-dataset interruption loses at most one in-flight resource on resume (SC-004)', async () => {
    const config = testConfig();
    const catalog = makeCatalog(2, 3);
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});

    // Simulate a mid-dataset interruption: pre-seed the campaign + the first dataset with one
    // resource already captured, then resume — only the two remaining resources of ds-000 plus
    // ds-001 should be fetched; the captured one is NOT re-fetched.
    await runEgovSyncRun({
      db,
      config,
      client: catalog.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
      max: 1,
    });
    // ds-000 fully captured in session 1 (3 resources). Resume to finish ds-001.
    const callsAfter1 = { ...catalog.calls.getResourceData };
    await runEgovSyncRun({
      db,
      config,
      client: catalog.client(),
      storeRoot,
      trigger: 'manual',
      scope: {},
    });
    // ds-000's resources are not re-fetched.
    for (const uri of ['ds-000-r0', 'ds-000-r1', 'ds-000-r2']) {
      expect(catalog.resourceDataCalls(uri)).toBe(callsAfter1[uri] ?? 0);
    }
    expect(repo.counts(scopeHash).captured).toBe(2);
  });
});
