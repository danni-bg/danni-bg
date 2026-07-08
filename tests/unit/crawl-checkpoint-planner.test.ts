import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOrLoadCampaign,
  decideDatasetSkip,
  planSession,
  prepareSession,
  reconcileCatalog,
} from '../../src/crawler/crawl-checkpoint.ts';
import type { EgovBgClient } from '../../src/crawler/egov-bg-client.ts';
import { computeScopeHash } from '../../src/crawler/scope-hash.ts';
import { runMigrations } from '../../src/store/migrate.ts';
import { CrawlCheckpointsRepo } from '../../src/store/repos/crawl-checkpoints.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db, join(ROOT, 'migrations'));
  return db;
}

/** A fake EgovBgClient that pages listDatasets from an in-memory uri set. */
function pagingClient(uris: string[], pageSize = 100): EgovBgClient {
  return {
    listDatasets: async ({ pageNumber }: { recordsPerPage?: number; pageNumber?: number }) => {
      const page = pageNumber ?? 1;
      const slice = uris.slice((page - 1) * pageSize, page * pageSize);
      return {
        success: true,
        total_records: uris.length,
        datasets: slice.map((uri, i) => ({ id: i, uri, name: uri })),
      };
    },
  } as unknown as EgovBgClient;
}

/** A paging client whose summaries carry an org_id, keyed by uri (for publisher-scope tests). */
function orgPagingClient(rows: { uri: string; org_id: number }[], pageSize = 100): EgovBgClient {
  return {
    listDatasets: async ({ pageNumber }: { recordsPerPage?: number; pageNumber?: number }) => {
      const page = pageNumber ?? 1;
      const slice = rows.slice((page - 1) * pageSize, page * pageSize);
      return {
        success: true,
        total_records: rows.length,
        datasets: slice.map((r, i) => ({ id: i, uri: r.uri, org_id: r.org_id, name: r.uri })),
      };
    },
  } as unknown as EgovBgClient;
}

describe('crawler.crawl-checkpoint planner', () => {
  it('buildOrLoadCampaign enumerates the in-scope set, sorts by uri, and freezes once', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const scope = {};
    const { scopeHash } = computeScopeHash(scope);
    const built = await buildOrLoadCampaign({
      db,
      client: pagingClient(['zeta', 'alpha', 'mu']),
      scope,
    });
    expect(built.scopeHash).toBe(scopeHash);
    expect(built.created).toBe(true);
    expect(repo.frozenIds(scopeHash)).toEqual(['alpha', 'mu', 'zeta']); // sorted
    db.close();
  });

  it('buildOrLoadCampaign loads an existing campaign without re-enumerating (created=false)', async () => {
    const db = freshDb();
    let calls = 0;
    const client = {
      listDatasets: async () => {
        calls++;
        return { success: true, datasets: [{ id: 1, uri: 'a', name: 'a' }] };
      },
    } as unknown as EgovBgClient;
    await buildOrLoadCampaign({ db, client, scope: {} });
    expect(calls).toBeGreaterThan(0);
    const callsAfterBuild = calls;
    const loaded = await buildOrLoadCampaign({ db, client, scope: {} });
    expect(loaded.created).toBe(false);
    expect(calls).toBe(callsAfterBuild); // no new discovery
    db.close();
  });

  it('a datasetIds scope bypasses discovery (frozen list is the sorted ids)', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    let calls = 0;
    const client = {
      listDatasets: async () => {
        calls++;
        return { success: true, datasets: [] };
      },
    } as unknown as EgovBgClient;
    const scope = { datasetIds: ['d2', 'd1'] };
    const { scopeHash } = computeScopeHash(scope);
    await buildOrLoadCampaign({ db, client, scope });
    expect(calls).toBe(0); // no discovery paging
    expect(repo.frozenIds(scopeHash)).toEqual(['d1', 'd2']);
    db.close();
  });

  it('a publisher scope freezes only that publisher’s uris (spec 048 FR-300/303, SC-1)', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const scope = { publishers: ['egov-org-113'] };
    const { scopeHash } = computeScopeHash(scope);
    await buildOrLoadCampaign({
      db,
      client: orgPagingClient([
        { uri: 'target-b', org_id: 113 },
        { uri: 'other', org_id: 7 },
        { uri: 'target-a', org_id: 113 },
      ]),
      scope,
    });
    // Sorted, and only org 113 datasets — the other publisher's uri is never frozen.
    expect(repo.frozenIds(scopeHash)).toEqual(['target-a', 'target-b']);
    db.close();
  });

  it('reconcileCatalog appends only in-scope additions for a publisher scope (FR-303)', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const scope = { publishers: ['egov-org-113'] };
    const { scopeHash } = computeScopeHash(scope);
    repo.createCampaign({
      scopeHash,
      scopeJson: { publishers: ['egov-org-113'], categories: [], tags: [], datasetIds: [] },
      frozenIds: ['target-a'],
    });
    const out = await reconcileCatalog({
      db,
      client: orgPagingClient([
        { uri: 'target-a', org_id: 113 },
        { uri: 'target-b', org_id: 113 }, // new + in-scope → appended
        { uri: 'intruder', org_id: 9 }, // new but out-of-scope → NOT appended
      ]),
      scope,
      scopeHash,
    });
    expect(out.added).toEqual(['target-b']);
    expect(repo.frozenIds(scopeHash)).toEqual(['target-a', 'target-b']); // no 'intruder'
    db.close();
  });

  it('paginates discovery across multiple pages', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const uris = Array.from({ length: 250 }, (_, i) => `ds-${String(i).padStart(3, '0')}`);
    const { scopeHash } = computeScopeHash({});
    await buildOrLoadCampaign({ db, client: pagingClient(uris), scope: {} });
    expect(repo.frozenIds(scopeHash).length).toBe(250);
    db.close();
  });

  it('buildOrLoadCampaign degrades to a safe re-scan on a corrupt frozen_ids_json (FR-008)', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['old'] });
    db.query('UPDATE crawl_checkpoints SET frozen_ids_json = ? WHERE scope_hash = ?').run(
      '{bad',
      scopeHash,
    );
    const out = await buildOrLoadCampaign({ db, client: pagingClient(['a', 'b']), scope: {} });
    expect(out.degraded).toBe(true);
    expect(out.created).toBe(true);
    expect(repo.frozenIds(scopeHash)).toEqual(['a', 'b']); // rebuilt
    db.close();
  });

  it('buildOrLoadCampaign rethrows a non-corruption error during validation', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a'] });

    // Let the first getCampaign (existence probe) succeed, then make the SECOND read — the one inside
    // frozenIds() during validation — throw a GENERIC (non-CheckpointCorruptError) DB error. That must
    // propagate, not be swallowed as a corrupt-checkpoint re-scan.
    const origQuery = db.query.bind(db);
    let getCampaignReads = 0;
    (db as unknown as { query: (sql: string) => unknown }).query = ((sql: string) => {
      const stmt = origQuery(sql);
      if (sql === 'SELECT * FROM crawl_checkpoints WHERE scope_hash = ?') {
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop === 'get') {
              return (...args: unknown[]) => {
                getCampaignReads++;
                if (getCampaignReads >= 2) throw new Error('simulated disk read failure');
                return (target as { get: (...a: unknown[]) => unknown }).get(...args);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      return stmt;
    }) as typeof db.query;

    await expect(
      buildOrLoadCampaign({ db, client: pagingClient(['a', 'b']), scope: {} }),
    ).rejects.toThrow('simulated disk read failure');

    (db as unknown as { query: unknown }).query = origQuery;
    db.close();
  });

  it('planSession yields units strictly after the cursor, in frozen order', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a', 'b', 'c', 'd'] });
    repo.advanceCursor(scopeHash, 'b', 'r1');
    const plan = planSession({ db, scopeHash });
    expect(plan.uris).toEqual(['c', 'd']);
    expect(plan.completed).toBe(false);
    db.close();
  });

  it('planSession honors --max (per-session dataset batch)', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a', 'b', 'c', 'd'] });
    const plan = planSession({ db, scopeHash, max: 2 });
    expect(plan.uris).toEqual(['a', 'b']);
    db.close();
  });

  it('planSession skips already-failed datasets on a normal resume (cursor would advance past)', () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a', 'b', 'c'] });
    repo.upsertDataset({ scopeHash, datasetUri: 'b', validator: 'v', resourceCount: 0 });
    repo.markDatasetFailed(scopeHash, 'b', 'broke');
    const plan = planSession({ db, scopeHash });
    expect(plan.uris).toEqual(['a', 'c']); // 'b' (failed) skipped on normal resume
    db.close();
  });

  it('planSession with retryFailed re-includes sub-cap failed datasets but not capped ones', () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a', 'b', 'c'] });
    repo.upsertDataset({ scopeHash, datasetUri: 'b', validator: 'v', resourceCount: 0 });
    repo.markDatasetFailed(scopeHash, 'b', '1'); // sub-cap
    repo.upsertDataset({ scopeHash, datasetUri: 'c', validator: 'v', resourceCount: 0 });
    repo.markDatasetFailed(scopeHash, 'c', '1');
    repo.markDatasetFailed(scopeHash, 'c', '2');
    repo.markDatasetFailed(scopeHash, 'c', '3'); // capped
    const plan = planSession({ db, scopeHash, retryFailed: true });
    expect(plan.uris).toEqual(['a', 'b']); // 'c' capped → excluded even with retryFailed
    db.close();
  });

  it('planSession reports completed when the cursor has passed the last frozen id', () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a', 'b'] });
    repo.advanceCursor(scopeHash, 'b', 'r1');
    const plan = planSession({ db, scopeHash });
    expect(plan.uris).toEqual([]);
    expect(plan.completed).toBe(true);
    db.close();
  });

  it('decideDatasetSkip: skip when validator unchanged AND all resources success', () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a'] });
    repo.upsertDataset({ scopeHash, datasetUri: 'a', validator: 'v1', resourceCount: 2 });
    repo.upsertResource({ scopeHash, datasetUri: 'a', resourceUri: 'r1' });
    repo.upsertResource({ scopeHash, datasetUri: 'a', resourceUri: 'r2' });
    repo.markResourceSuccess({
      scopeHash,
      datasetUri: 'a',
      resourceUri: 'r1',
      sha256: 'h',
      validator: 'v1',
    });
    repo.markResourceSuccess({
      scopeHash,
      datasetUri: 'a',
      resourceUri: 'r2',
      sha256: 'h',
      validator: 'v1',
    });
    expect(decideDatasetSkip({ db, scopeHash, datasetUri: 'a', validator: 'v1' })).toBe(true);
    db.close();
  });

  it('decideDatasetSkip: fetch when the validator changed (re-opens the dataset)', () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a'] });
    repo.upsertDataset({ scopeHash, datasetUri: 'a', validator: 'v1', resourceCount: 1 });
    repo.upsertResource({ scopeHash, datasetUri: 'a', resourceUri: 'r1' });
    repo.markResourceSuccess({
      scopeHash,
      datasetUri: 'a',
      resourceUri: 'r1',
      sha256: 'h',
      validator: 'v1',
    });
    expect(decideDatasetSkip({ db, scopeHash, datasetUri: 'a', validator: 'v2' })).toBe(false);
    db.close();
  });

  it('decideDatasetSkip: fetch when a resource is not yet success', () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a'] });
    repo.upsertDataset({ scopeHash, datasetUri: 'a', validator: 'v1', resourceCount: 2 });
    repo.upsertResource({ scopeHash, datasetUri: 'a', resourceUri: 'r1' });
    repo.upsertResource({ scopeHash, datasetUri: 'a', resourceUri: 'r2' });
    repo.markResourceSuccess({
      scopeHash,
      datasetUri: 'a',
      resourceUri: 'r1',
      sha256: 'h',
      validator: 'v1',
    });
    // r2 still pending
    expect(decideDatasetSkip({ db, scopeHash, datasetUri: 'a', validator: 'v1' })).toBe(false);
    db.close();
  });

  it('decideDatasetSkip: fetch when the dataset has never been visited', () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a'] });
    expect(decideDatasetSkip({ db, scopeHash, datasetUri: 'a', validator: 'v1' })).toBe(false);
    db.close();
  });

  it('decideDatasetSkip: fetch when validator-success rows exist but a resource has zero rows recorded', () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a'] });
    repo.upsertDataset({ scopeHash, datasetUri: 'a', validator: 'v1', resourceCount: 0 });
    // No resource rows at all → cannot be sure it is fully captured → fetch.
    expect(decideDatasetSkip({ db, scopeHash, datasetUri: 'a', validator: 'v1' })).toBe(false);
    db.close();
  });

  it('decideDatasetSkip returns false for an absent campaign/dataset', () => {
    const db = freshDb();
    const { scopeHash } = computeScopeHash({});
    expect(decideDatasetSkip({ db, scopeHash, datasetUri: 'absent', validator: 'v' })).toBe(false);
    db.close();
  });
});

describe('crawler.crawl-checkpoint --max batch + completion (US2)', () => {
  it('a session yields exactly max units after the cursor', () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({
      scopeHash,
      scopeJson: { all: true },
      frozenIds: ['a', 'b', 'c', 'd', 'e'],
    });
    repo.advanceCursor(scopeHash, 'a', 'r1');
    const plan = planSession({ db, scopeHash, max: 2 });
    expect(plan.uris).toEqual(['b', 'c']);
    db.close();
  });

  it('a completed campaign cursor at the last id yields an empty, completed plan', () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a', 'b'] });
    repo.advanceCursor(scopeHash, 'b', 'r1');
    repo.markCampaignCompleted(scopeHash);
    const plan = planSession({ db, scopeHash });
    expect(plan.uris).toEqual([]);
    expect(plan.completed).toBe(true);
    db.close();
  });

  it('planSession over an absent campaign reports completed (empty plan)', () => {
    const db = freshDb();
    const { scopeHash } = computeScopeHash({});
    const plan = planSession({ db, scopeHash });
    expect(plan.uris).toEqual([]);
    expect(plan.completed).toBe(true);
    db.close();
  });

  it('a vanished cursor (not in the frozen list) reconsiders the whole list', () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a', 'b', 'c'] });
    repo.advanceCursor(scopeHash, 'gone', 'r1'); // cursor no longer in frozen
    expect(planSession({ db, scopeHash }).uris).toEqual(['a', 'b', 'c']);
    db.close();
  });
});

describe('crawler.crawl-checkpoint prepareSession + reconcile (US3/FR-004)', () => {
  it('prepareSession is a no-op on an active campaign', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a', 'b'] });
    repo.advanceCursor(scopeHash, 'a', 'r1');
    let calls = 0;
    const client = {
      listDatasets: async () => {
        calls++;
        return { success: true, datasets: [] };
      },
    } as unknown as EgovBgClient;
    const out = await prepareSession({ db, client, scope: {}, scopeHash });
    expect(out.vanished).toEqual([]);
    expect(calls).toBe(0); // no reconcile listDatasets on an active campaign
    expect(repo.getCampaign(scopeHash)?.cursor_uri).toBe('a'); // cursor untouched
    db.close();
  });

  it('prepareSession on a completed campaign reconciles, resets the cursor, re-activates', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a', 'b'] });
    repo.advanceCursor(scopeHash, 'b', 'r1');
    repo.markCampaignCompleted(scopeHash);
    const out = await prepareSession({
      db,
      client: pagingClient(['a', 'b', 'c']), // 'c' is new, 'b' present, none vanished
      scope: {},
      scopeHash,
    });
    expect(out.vanished).toEqual([]);
    expect(repo.frozenIds(scopeHash)).toEqual(['a', 'b', 'c']); // 'c' appended
    expect(repo.getCampaign(scopeHash)?.status).toBe('active'); // re-activated
    expect(repo.getCampaign(scopeHash)?.cursor_uri).toBeNull(); // reset for a re-walk
    db.close();
  });

  it('prepareSession surfaces vanished uris on a completed campaign', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['a', 'b'] });
    repo.markCampaignCompleted(scopeHash);
    const out = await prepareSession({
      db,
      client: pagingClient(['a']), // 'b' vanished
      scope: {},
      scopeHash,
    });
    expect(out.vanished).toEqual(['b']);
    db.close();
  });

  it('prepareSession over an absent campaign is a no-op', async () => {
    const db = freshDb();
    const { scopeHash } = computeScopeHash({});
    const out = await prepareSession({
      db,
      client: pagingClient([]),
      scope: {},
      scopeHash,
    });
    expect(out.vanished).toEqual([]);
    db.close();
  });

  it('reconcileCatalog appends additions and reports vanished without reordering', async () => {
    const db = freshDb();
    const repo = new CrawlCheckpointsRepo(db);
    const { scopeHash } = computeScopeHash({});
    repo.createCampaign({ scopeHash, scopeJson: { all: true }, frozenIds: ['b', 'd'] });
    const out = await reconcileCatalog({
      db,
      client: pagingClient(['a', 'b', 'c']), // 'd' vanished; 'a','c' added
      scope: {},
      scopeHash,
    });
    expect(out.added.sort()).toEqual(['a', 'c']);
    expect(out.vanished).toEqual(['d']);
    expect(repo.frozenIds(scopeHash)).toEqual(['b', 'd', 'a', 'c']); // append, never reorder
    db.close();
  });
});
