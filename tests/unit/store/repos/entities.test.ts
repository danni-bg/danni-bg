import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../../../src/store/repos/entities.ts';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

function setup(): { db: Database; repo: EntitiesRepo } {
  const d = new Database(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  runMigrations(d, MIGRATIONS);
  const ds = new DatasetsRepo(d);
  ds.upsert({ id: 'd1', slug: 'd1', titleBg: 'A', tags: [], groups: [], sourceUrl: 'https://x/d1' });
  ds.upsert({ id: 'd2', slug: 'd2', titleBg: 'B', tags: [], groups: [], sourceUrl: 'https://x/d2' });
  return { db: d, repo: new EntitiesRepo(d) };
}

describe('store.repos.entities', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    s.db.close();
  });

  it('inserts then updates an entity', () => {
    s.repo.upsert({
      id: 'org:p1',
      kind: 'organization',
      canonicalLabelBg: 'A',
    });
    s.repo.upsert({
      id: 'org:p1',
      kind: 'organization',
      canonicalLabelBg: 'B',
      canonicalLabelEn: 'B-en',
    });
    expect(s.repo.get('org:p1')?.canonical_label_bg).toBe('B');
    expect(s.repo.get('org:p1')?.canonical_label_en).toBe('B-en');
  });

  it('attach + listAttachments + datasetsForEntity round trip', () => {
    s.repo.upsert({ id: 'tag:x', kind: 'tag', canonicalLabelBg: 'x' });
    s.repo.attach({ datasetId: 'd1', entityId: 'tag:x', extractor: 'ckan_tags', confidence: 0.6 });
    s.repo.attach({ datasetId: 'd2', entityId: 'tag:x', extractor: 'ckan_tags', confidence: 0.6 });
    const list = s.repo.listAttachments('d1');
    expect(list.length).toBe(1);
    expect(s.repo.datasetsForEntity('tag:x')).toEqual(['d1', 'd2']);
  });

  it('re-attach is idempotent and updates in place (ON CONFLICT DO UPDATE, spec 052 FR-342)', () => {
    s.repo.upsert({ id: 'tag:x', kind: 'tag', canonicalLabelBg: 'x' });
    s.repo.attach({ datasetId: 'd1', entityId: 'tag:x', extractor: 'ckan_tags', confidence: 0.6 });
    s.repo.attach({ datasetId: 'd1', entityId: 'tag:x', extractor: 'ckan_tags', confidence: 0.9 });
    const list = s.repo.listAttachments('d1');
    expect(list.length).toBe(1); // same PK → in-place update, not a duplicate row
    expect(list[0]?.confidence).toBe(0.9);
  });

  it('entitiesForDataset joins via dataset_entities', () => {
    s.repo.upsert({ id: 'tag:y', kind: 'tag', canonicalLabelBg: 'y' });
    s.repo.attach({ datasetId: 'd1', entityId: 'tag:y', extractor: 'ckan_tags', confidence: 0.6 });
    const ents = s.repo.entitiesForDataset('d1');
    expect(ents.length).toBe(1);
    expect(ents[0]?.id).toBe('tag:y');
  });

  it('get returns null when missing', () => {
    expect(s.repo.get('missing')).toBeNull();
  });
});
