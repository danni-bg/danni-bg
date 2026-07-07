import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../../src/store/repos/datasets.ts';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

function db(): Database {
  const d = new Database(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  runMigrations(d, MIGRATIONS);
  return d;
}

describe('store.repos.datasets', () => {
  let database: Database;
  beforeEach(() => {
    database = db();
  });
  afterEach(() => {
    database.close();
  });

  it('inserts a new dataset and reports inserted=true', () => {
    const repo = new DatasetsRepo(database);
    const out = repo.upsert({
      id: 'd1',
      slug: 'one',
      titleBg: 'Първи',
      tags: ['a'],
      groups: ['g'],
      sourceUrl: 'https://example.org/d1',
    });
    expect(out.inserted).toBe(true);
    expect(out.changes.length).toBe(0);
    expect(out.row.title_bg).toBe('Първи');
    expect(out.row.lifecycle_state).toBe('active');
  });

  it('records field changes on update', () => {
    const repo = new DatasetsRepo(database);
    repo.upsert({
      id: 'd1',
      slug: 'one',
      titleBg: 'A',
      tags: [],
      groups: [],
      sourceUrl: 'https://example.org/d1',
    });
    const out = repo.upsert({
      id: 'd1',
      slug: 'one',
      titleBg: 'B',
      descriptionBg: 'desc',
      tags: ['x'],
      groups: ['y'],
      sourceUrl: 'https://example.org/d1',
      metadataModified: '2026-05-08T00:00:00Z',
    });
    expect(out.inserted).toBe(false);
    const fields = out.changes.map((c) => c.field);
    expect(fields).toContain('title_bg');
    expect(fields).toContain('description_bg');
    expect(fields).toContain('tags_json');
    expect(fields).toContain('groups_json');
    expect(fields).toContain('metadata_modified');
  });

  it('re-upsert with identical values records no changes (change-tracking survives the wrapping tx, FR-343)', () => {
    const repo = new DatasetsRepo(database);
    const input = {
      id: 'd1',
      slug: 'one',
      titleBg: 'A',
      descriptionBg: 'd',
      tags: ['a'],
      groups: ['g'],
      sourceUrl: 'https://example.org/d1',
      metadataModified: '2026-05-08T00:00:00Z',
    };
    repo.upsert(input);
    const again = repo.upsert(input);
    expect(again.inserted).toBe(false);
    expect(again.changes.length).toBe(0); // unchanged upsert does not fabricate a change
    const changed = repo.upsert({ ...input, titleBg: 'A2' });
    expect(changed.changes.map((c) => c.field)).toEqual(['title_bg']);
  });

  it('updates lifecycle and timestamp on transition', () => {
    const repo = new DatasetsRepo(database);
    repo.upsert({
      id: 'd1',
      slug: 'one',
      titleBg: 'A',
      tags: [],
      groups: [],
      sourceUrl: 'https://example.org/d1',
    });
    repo.setLifecycle('d1', 'withdrawn', 'gone');
    const row = repo.get('d1');
    expect(row?.lifecycle_state).toBe('withdrawn');
    expect(row?.withdrawn_reason).toBe('gone');
    repo.setLifecycle('d1', 'out_of_scope');
    const row2 = repo.get('d1');
    expect(row2?.lifecycle_state).toBe('out_of_scope');
    expect(row2?.withdrawn_reason).toBeNull();
  });

  it('listActive filters and listAll returns everything', () => {
    const repo = new DatasetsRepo(database);
    repo.upsert({
      id: 'a',
      slug: 'a',
      titleBg: 'A',
      tags: [],
      groups: [],
      sourceUrl: 'https://x/a',
    });
    repo.upsert({
      id: 'b',
      slug: 'b',
      titleBg: 'B',
      tags: [],
      groups: [],
      sourceUrl: 'https://x/b',
    });
    repo.setLifecycle('b', 'withdrawn');
    expect(repo.listActive().map((r) => r.id)).toEqual(['a']);
    expect(repo.listAll().map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('lifecycle transition between active states updates lifecycle_changed_at', () => {
    const repo = new DatasetsRepo(database);
    repo.upsert({
      id: 'd1',
      slug: 'one',
      titleBg: 'A',
      tags: [],
      groups: [],
      sourceUrl: 'https://example.org/d1',
      lifecycleState: 'active',
    });
    const before = repo.get('d1')?.lifecycle_changed_at;
    repo.upsert({
      id: 'd1',
      slug: 'one',
      titleBg: 'A',
      tags: [],
      groups: [],
      sourceUrl: 'https://example.org/d1',
      lifecycleState: 'out_of_scope',
      now: '2099-01-01T00:00:00Z',
    });
    const after = repo.get('d1')?.lifecycle_changed_at;
    expect(after).not.toBe(before);
  });
});
