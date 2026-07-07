// API-key auth (spec 027) — hermetic. A machine client presents `Authorization: Bearer dnk_live_…`;
// it resolves to the owning user, carries scopes, and can never reach admin or the key-management
// (human-only) routes.

import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { runMigrations } from '../../../src/store/migrate.ts';
import { ApiKeyRepo } from '../../../src/store/repos/api-keys.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import {
  type AuthEnv,
  requireAdmin,
  requireAuth,
  requireHuman,
  requireScope,
} from '../src/middleware/require-auth.ts';

// This suite drives gated routes via X-User-* headers, which requires the explicit trust opt-in
// (spec 034 FR-164; hermetic — no live Kratos, Constitution VI).
beforeAll(() => {
  process.env.TRUST_PROXY_AUTH_HEADERS = 'true';
});
afterAll(() => {
  delete process.env.TRUST_PROXY_AUTH_HEADERS;
});

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  const apiKeys = new ApiKeyRepo(db);
  const owner = users.findOrCreateByKratosId({ kratosIdentityId: 'k1', email: 'u@example.com' });
  const app = new Hono<AuthEnv>();
  app.use('/me', requireAuth(users, undefined, apiKeys));
  app.get('/me', (c) => c.json({ id: c.get('user').id, apiKey: c.get('apiKey') ?? null }));
  app.use('/chat', requireAuth(users, undefined, apiKeys), requireScope('chat'));
  app.get('/chat', (c) => c.json({ ok: true }));
  app.use('/admin', requireAuth(users, undefined, apiKeys), requireAdmin);
  app.get('/admin', (c) => c.json({ ok: true }));
  app.use('/keys', requireAuth(users, undefined, apiKeys), requireHuman);
  app.get('/keys', (c) => c.json({ ok: true }));
  return { db, users, apiKeys, owner, app };
}

const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });
const session = { headers: { 'x-user-id': 'k1', 'x-user-email': 'u@example.com' } };

describe('API-key auth (spec 027)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  it('a valid key authenticates as the owning user and carries its scopes', async () => {
    const { plaintext } = s.apiKeys.create({ userId: s.owner.id, name: 'k' });
    const res = await s.app.request('/me', bearer(plaintext));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; apiKey: { scopes: string[] } | null };
    expect(body.id).toBe(s.owner.id);
    expect(body.apiKey?.scopes).toEqual(['read', 'chat']);
  });

  it('revoked / expired keys are rejected with distinct codes', async () => {
    const revoked = s.apiKeys.create({ userId: s.owner.id, name: 'r' });
    s.apiKeys.revoke(revoked.view.id, s.owner.id);
    const r1 = await s.app.request('/me', bearer(revoked.plaintext));
    expect(r1.status).toBe(401);
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe('api_key_revoked');

    const expired = s.apiKeys.create({
      userId: s.owner.id,
      name: 'e',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const r2 = await s.app.request('/me', bearer(expired.plaintext));
    expect(((await r2.json()) as { error: { code: string } }).error.code).toBe('api_key_expired');
  });

  it('enforces scope: a key without chat scope is 403; with it, 200', async () => {
    const readOnly = s.apiKeys.create({ userId: s.owner.id, name: 'ro', scopes: ['read'] });
    const r1 = await s.app.request('/chat', bearer(readOnly.plaintext));
    expect(r1.status).toBe(403);
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe(
      'insufficient_scope',
    );

    const full = s.apiKeys.create({ userId: s.owner.id, name: 'full' });
    expect((await s.app.request('/chat', bearer(full.plaintext))).status).toBe(200);
  });

  it('a key can NEVER reach admin or key-management (human-only) routes', async () => {
    const { plaintext } = s.apiKeys.create({ userId: s.owner.id, name: 'k' });
    expect((await s.app.request('/admin', bearer(plaintext))).status).toBe(403);
    expect((await s.app.request('/keys', bearer(plaintext))).status).toBe(403);
  });

  it('a human session passes scope + human-only routes', async () => {
    expect((await s.app.request('/chat', session)).status).toBe(200);
    expect((await s.app.request('/keys', session)).status).toBe(200);
  });

  it('a non-namespaced Bearer token falls through to session auth (401 without one)', async () => {
    expect((await s.app.request('/me', bearer('random-token'))).status).toBe(401);
  });
});
