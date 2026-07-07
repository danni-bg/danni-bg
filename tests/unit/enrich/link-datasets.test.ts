import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_ENTITY_FANOUT,
  linkAllSharedEntities,
  linkDatasetsForEntity,
} from '../../../src/enrich/link-datasets.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { DatasetLinksRepo } from '../../../src/store/repos/dataset-links.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../../src/store/repos/entities.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

function setup(): {
  db: Database;
  entitiesRepo: EntitiesRepo;
  linksRepo: DatasetLinksRepo;
} {
  const d = new Database(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  runMigrations(d, MIGRATIONS);
  const ds = new DatasetsRepo(d);
  for (const id of ['d1', 'd2', 'd3']) {
    ds.upsert({ id, slug: id, titleBg: id, tags: [], groups: [], sourceUrl: `https://x/${id}` });
  }
  const ents = new EntitiesRepo(d);
  ents.upsert({
    id: 'geo:bg-municipality-sofia',
    kind: 'geographic_unit',
    canonicalLabelBg: 'Столична община',
  });
  ents.attach({
    datasetId: 'd1',
    entityId: 'geo:bg-municipality-sofia',
    extractor: 'gaz',
    confidence: 0.9,
  });
  ents.attach({
    datasetId: 'd2',
    entityId: 'geo:bg-municipality-sofia',
    extractor: 'gaz',
    confidence: 0.9,
  });
  ents.attach({
    datasetId: 'd3',
    entityId: 'geo:bg-municipality-sofia',
    extractor: 'gaz',
    confidence: 0.9,
  });
  return { db: d, entitiesRepo: ents, linksRepo: new DatasetLinksRepo(d) };
}

describe('enrich.link-datasets', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    s.db.close();
  });

  it('creates pairwise links for an entity attached to multiple datasets', () => {
    const r = linkDatasetsForEntity(
      { db: s.db, entitiesRepo: s.entitiesRepo, linksRepo: s.linksRepo },
      'geo:bg-municipality-sofia',
    );
    expect(r.created).toBe(3); // (d1,d2), (d1,d3), (d2,d3)
    const links = s.linksRepo.forDataset('d1');
    expect(links.length).toBe(2);
    for (const l of links) {
      expect(l.dataset_a_id < l.dataset_b_id).toBe(true);
      expect(l.heuristic).toBe('shared_geo');
    }
  });

  it('returns 0 for unknown entity', () => {
    const r = linkDatasetsForEntity(
      { db: s.db, entitiesRepo: s.entitiesRepo, linksRepo: s.linksRepo },
      'missing',
    );
    expect(r.created).toBe(0);
  });

  it('linkAllSharedEntities aggregates across entities', () => {
    const r = linkAllSharedEntities(
      { db: s.db, entitiesRepo: s.entitiesRepo, linksRepo: s.linksRepo },
      ['geo:bg-municipality-sofia', 'missing'],
    );
    expect(r.created).toBe(3);
    expect(r.skippedHubs).toBe(0);
  });

  it('writes one entity’s links atomically — a fault mid-batch rolls back the whole batch (spec 052 FR-341)', () => {
    // One entity's pairwise links are one transaction, so a crash on the 2nd insert must roll back the
    // 1st too — no partial link set persists.
    const orig = DatasetLinksRepo.prototype.insert;
    let n = 0;
    DatasetLinksRepo.prototype.insert = function (this: DatasetLinksRepo, input) {
      n += 1;
      if (n === 2) throw new Error('mid-batch fault');
      return orig.call(this, input);
    };
    try {
      expect(() =>
        linkDatasetsForEntity(
          { db: s.db, entitiesRepo: s.entitiesRepo, linksRepo: s.linksRepo },
          'geo:bg-municipality-sofia',
        ),
      ).toThrow('mid-batch fault');
    } finally {
      DatasetLinksRepo.prototype.insert = orig;
    }
    expect(s.db.query<{ c: number }, []>('SELECT count(*) AS c FROM dataset_links').get()?.c).toBe(
      0,
    );
    expect(s.linksRepo.forDataset('d1').length).toBe(0);
  });

  it('is idempotent across re-runs — no duplicate rows (ON CONFLICT upsert, spec 052 FR-342)', () => {
    const opts = { db: s.db, entitiesRepo: s.entitiesRepo, linksRepo: s.linksRepo };
    const first = linkDatasetsForEntity(opts, 'geo:bg-municipality-sofia');
    const second = linkDatasetsForEntity(opts, 'geo:bg-municipality-sofia');
    expect(first.created).toBe(3);
    expect(second.created).toBe(3); // re-inserts, but ON CONFLICT updates in place
    expect(s.db.query<{ c: number }, []>('SELECT count(*) AS c FROM dataset_links').get()?.c).toBe(
      3,
    );
  });

  it('skips a hub entity whose fan-out exceeds MAX_ENTITY_FANOUT (no O(n²) explosion)', () => {
    const ds = new DatasetsRepo(s.db);
    s.entitiesRepo.upsert({ id: 'tag:регистър', kind: 'tag', canonicalLabelBg: 'регистър' });
    for (let i = 0; i < MAX_ENTITY_FANOUT + 1; i++) {
      const id = `hub${i}`;
      ds.upsert({ id, slug: id, titleBg: id, tags: [], groups: [], sourceUrl: `https://x/${id}` });
      s.entitiesRepo.attach({
        datasetId: id,
        entityId: 'tag:регистър',
        extractor: 't',
        confidence: 0.5,
      });
    }
    const r = linkDatasetsForEntity(
      { db: s.db, entitiesRepo: s.entitiesRepo, linksRepo: s.linksRepo },
      'tag:регистър',
    );
    expect(r.created).toBe(0);
    expect(r.skippedHubs).toBe(1);
    expect(s.linksRepo.forDataset('hub0')).toHaveLength(0);
  });
});
