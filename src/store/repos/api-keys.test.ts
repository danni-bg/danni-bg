import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../migrate.ts';
import { ApiKeyRepo, API_KEY_NAMESPACE } from './api-keys.ts';
import { LAST_SEEN_THROTTLE_MS } from './last-seen.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('ApiKeyRepo', () => {
  let db: Database;
  let repo: ApiKeyRepo;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, join(ROOT, 'migrations'));
    repo = new ApiKeyRepo(db);
  });
  afterEach(() => db.close());

  it('creates a namespaced key, returns the secret ONCE, stores only its hash + prefix', () => {
    const { plaintext, view } = repo.create({ userId: 'u1', name: 'CI' });
    expect(plaintext.startsWith(API_KEY_NAMESPACE)).toBe(true);
    expect(view.prefix.startsWith(API_KEY_NAMESPACE)).toBe(true);
    expect(view.scopes).toEqual(['read', 'chat']);
    // the plaintext is never persisted; only its hash is
    const row = db.query<{ key_hash: string }, []>('SELECT key_hash FROM api_keys').get();
    expect(row?.key_hash).toBeTruthy();
    expect(row?.key_hash).not.toBe(plaintext);
    expect(JSON.stringify(view)).not.toContain(plaintext.slice(API_KEY_NAMESPACE.length));
  });

  it('resolves a valid secret to its key + bumps last_used_at; rejects unknown', () => {
    const { plaintext } = repo.create({ userId: 'u1', name: 'k' });
    const ok = repo.resolveBySecret(plaintext);
    expect(ok.status).toBe('ok');
    if (ok.status === 'ok') expect(ok.key.user_id).toBe('u1');
    expect(repo.listForUser('u1')[0]?.lastUsedAt).toBeTruthy();
    expect(repo.resolveBySecret(`${API_KEY_NAMESPACE}nope`).status).toBe('invalid');
    expect(repo.resolveBySecret('not-ours').status).toBe('invalid');
  });

  it('rejects a revoked key and an expired key with distinct statuses', () => {
    const revoked = repo.create({ userId: 'u1', name: 'r' });
    expect(repo.revoke(revoked.view.id, 'u1')).toBe(true);
    expect(repo.resolveBySecret(revoked.plaintext).status).toBe('revoked');
    // revoke is owner-scoped + idempotent
    expect(repo.revoke(revoked.view.id, 'someone-else')).toBe(false);

    const expired = repo.create({ userId: 'u1', name: 'e', expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(repo.resolveBySecret(expired.plaintext).status).toBe('expired');
  });

  it('lists only the owner’s keys, newest first, without the hash', () => {
    repo.create({ userId: 'u1', name: 'a', now: '2026-01-01T00:00:00.000Z' });
    repo.create({ userId: 'u1', name: 'b', now: '2026-02-01T00:00:00.000Z' });
    repo.create({ userId: 'u2', name: 'other' });
    const keys = repo.listForUser('u1');
    expect(keys.map((k) => k.name)).toEqual(['b', 'a']);
    expect(JSON.stringify(keys)).not.toContain('key_hash');
  });

  it('honours custom scopes', () => {
    const { view } = repo.create({ userId: 'u1', name: 'read-only', scopes: ['read'] });
    expect(view.scopes).toEqual(['read']);
  });

  it('throttles the last_used_at bump within the window and resumes past it (spec 043 FR-254)', () => {
    const t0 = '2026-07-07T00:00:00.000Z';
    const plus = (ms: number) => new Date(Date.parse(t0) + ms).toISOString();
    const { plaintext } = repo.create({ userId: 'u1', name: 'k', now: t0 });

    // First resolution bumps from null → t0; 100 more inside the window perform no further write.
    expect(repo.resolveBySecret(plaintext, t0).status).toBe('ok');
    for (let i = 1; i <= 100; i++) repo.resolveBySecret(plaintext, plus(i * 1000));
    expect(repo.listForUser('u1')[0]?.lastUsedAt).toBe(t0);

    // Once the window elapses the next resolution advances it again.
    const later = plus(LAST_SEEN_THROTTLE_MS);
    repo.resolveBySecret(plaintext, later);
    expect(repo.listForUser('u1')[0]?.lastUsedAt).toBe(later);
  });
});
