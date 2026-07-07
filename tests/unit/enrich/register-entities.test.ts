import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CkanGroupsExtractor } from '../../../src/enrich/extractors/ckan-groups.ts';
import { CkanTagsExtractor } from '../../../src/enrich/extractors/ckan-tags.ts';
import { registerEntities } from '../../../src/enrich/register-entities.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../../src/store/repos/entities.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

function setup(): { db: Database } {
  const d = new Database(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  runMigrations(d, MIGRATIONS);
  new DatasetsRepo(d).upsert({
    id: 'd1',
    slug: 'd1',
    titleBg: 'A',
    tags: ['budget', 'municipality'],
    groups: ['finansi'],
    sourceUrl: 'https://x/d1',
  });
  return { db: d };
}

describe('enrich.register-entities', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    s.db.close();
  });

  it('persists entities + dataset_entities for each extractor', async () => {
    const repo = new EntitiesRepo(s.db);
    const datasets = new DatasetsRepo(s.db);
    const dataset = datasets.get('d1');
    if (!dataset) throw new Error('seed missing');
    const result = await registerEntities(
      { db: s.db, repo, extractors: [new CkanTagsExtractor(), new CkanGroupsExtractor()] },
      { dataset, resources: [] },
    );
    expect(result.attached).toBe(3); // 2 tags + 1 group
    const attachments = repo.listAttachments('d1');
    expect(attachments.length).toBe(3);
    expect(repo.entitiesForDataset('d1').length).toBe(3);
  });

  it('upserts existing entities (extractor variation preserves multiple rows)', async () => {
    const repo = new EntitiesRepo(s.db);
    const datasets = new DatasetsRepo(s.db);
    const dataset = datasets.get('d1');
    if (!dataset) throw new Error('seed missing');
    await registerEntities(
      { db: s.db, repo, extractors: [new CkanTagsExtractor()] },
      { dataset, resources: [] },
    );
    await registerEntities(
      { db: s.db, repo, extractors: [new CkanTagsExtractor()] },
      { dataset, resources: [] },
    );
    expect(repo.listAttachments('d1').length).toBe(2);
  });

  it('rolls back the entity upsert when attach faults mid-unit (spec 052 FR-345)', async () => {
    const repo = new EntitiesRepo(s.db);
    const datasets = new DatasetsRepo(s.db);
    const dataset = datasets.get('d1');
    if (!dataset) throw new Error('seed missing');
    // Fault-inject a crash between the entity upsert and its attach. The two now run in ONE
    // transaction, so the whole unit MUST roll back — no entity row survives without its attachment.
    const orig = EntitiesRepo.prototype.attach;
    EntitiesRepo.prototype.attach = () => {
      throw new Error('attach fault');
    };
    try {
      await expect(
        registerEntities(
          { db: s.db, repo, extractors: [new CkanTagsExtractor()] },
          { dataset, resources: [] },
        ),
      ).rejects.toThrow('attach fault');
    } finally {
      EntitiesRepo.prototype.attach = orig;
    }
    expect(s.db.query<{ c: number }, []>('SELECT count(*) AS c FROM entities').get()?.c).toBe(0);
    expect(repo.listAttachments('d1').length).toBe(0);
  });
});
