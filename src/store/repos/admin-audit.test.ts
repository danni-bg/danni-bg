import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../migrate.ts';
import { AdminAuditRepo } from './admin-audit.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('AdminAuditRepo (spec 062)', () => {
  let db: Database;
  let repo: AdminAuditRepo;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, join(ROOT, 'migrations'));
    repo = new AdminAuditRepo(db);
  });
  afterEach(() => db.close());

  it('records a mutation and reads it back most-recent-first, paginated', () => {
    repo.record({ actorUserId: 'u1', actorRole: 'admin', tenantId: 't1', action: 'revoke_api_key', target: 'k1', detail: { name: 'k' }, outcome: 'ok', now: '2026-01-01T00:00:00Z' });
    repo.record({ actorUserId: 'u1', actorRole: 'admin', action: 'set_user_role', target: 'u2', detail: { role: 'admin' }, outcome: 'ok', now: '2026-01-02T00:00:00Z' });
    const page = repo.list({ limit: 10, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items[0]?.action).toBe('set_user_role'); // newest first
    expect(page.items[0]?.tenantId).toBeNull();
    expect(page.items[0]?.detail).toEqual({ role: 'admin' });
    expect(page.items[1]?.action).toBe('revoke_api_key');
    expect(page.items[1]?.detail).toEqual({ name: 'k' });
  });

  it('paginates', () => {
    for (let i = 0; i < 5; i++) {
      repo.record({ actorUserId: 'u', actorRole: 'admin', action: 'a', outcome: 'ok', now: `2026-01-0${i + 1}T00:00:00Z` });
    }
    const page = repo.list({ limit: 2, offset: 2 });
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
  });

  it('stores null detail when omitted', () => {
    repo.record({ actorUserId: 'u', actorRole: 'user', action: 'denied_thing', outcome: 'denied' });
    expect(repo.list({ limit: 1, offset: 0 }).items[0]?.detail).toBeNull();
  });
});
