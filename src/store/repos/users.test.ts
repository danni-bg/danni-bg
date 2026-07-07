import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../migrate.ts';
import { LAST_SEEN_THROTTLE_MS } from './last-seen.ts';
import { UsersRepo } from './users.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('UsersRepo last_login_at throttle (spec 043 FR-254)', () => {
  let db: Database;
  let repo: UsersRepo;
  const t0 = '2026-07-07T00:00:00.000Z';
  const plus = (ms: number) => new Date(Date.parse(t0) + ms).toISOString();

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, join(ROOT, 'migrations'));
    repo = new UsersRepo(db);
  });
  afterEach(() => db.close());

  it('does not re-write on unchanged reads within the window (SC-3)', () => {
    const created = repo.findOrCreateByKratosId({ kratosIdentityId: 'k1', email: 'a@b.bg', now: t0 });
    expect(created.last_login_at).toBe(t0);

    // 100 consecutive resolutions inside the window perform zero UPDATEs: last_login_at and
    // updated_at stay pinned to the creation time.
    for (let i = 1; i <= 100; i++) {
      const r = repo.findOrCreateByKratosId({
        kratosIdentityId: 'k1',
        email: 'a@b.bg',
        now: plus(i * 1000), // 1s apart, all well under the 5-minute window
      });
      expect(r.last_login_at).toBe(t0);
      expect(r.updated_at).toBe(t0);
    }
  });

  it('advances last_login_at once the window elapses', () => {
    repo.findOrCreateByKratosId({ kratosIdentityId: 'k1', email: 'a@b.bg', now: t0 });
    const later = plus(LAST_SEEN_THROTTLE_MS);
    const r = repo.findOrCreateByKratosId({ kratosIdentityId: 'k1', email: 'a@b.bg', now: later });
    expect(r.last_login_at).toBe(later);
  });

  it('writes a changed profile immediately without advancing last_login_at inside the window', () => {
    repo.findOrCreateByKratosId({
      kratosIdentityId: 'k1',
      email: 'a@b.bg',
      displayName: 'Old',
      now: t0,
    });
    const within = plus(60_000);
    const r = repo.findOrCreateByKratosId({
      kratosIdentityId: 'k1',
      email: 'new@b.bg',
      displayName: 'New',
      now: within,
    });
    expect(r.email).toBe('new@b.bg');
    expect(r.display_name).toBe('New');
    expect(r.updated_at).toBe(within); // the profile change was persisted
    expect(r.last_login_at).toBe(t0); // but the login timestamp stays throttled
  });
});
