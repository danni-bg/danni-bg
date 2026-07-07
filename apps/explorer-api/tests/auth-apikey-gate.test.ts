// spec 055 FR-375 / SC-4 — the auth gate is composed ONCE and handed to every gated router, so an
// API key hitting /api/auth/* now gets the same key-aware handling (200 for a valid key, a distinct
// api_key_* 401 for a revoked one) it already got on /api/me, /api/chat, /api/tenant, /api/admin —
// instead of the generic session 401 the pre-fix `requireAuth(users, resolveSession)` produced.

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { ApiKeyRepo } from '../../../src/store/repos/api-keys.ts';
import { TenantsRepo } from '../../../src/store/repos/tenants.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import type { ReadBridge } from '../src/read-bridge.ts';

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
  const ctx: AppContext = {
    bridge: {} as ReadBridge,
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    users,
    apiKeys,
    tenants: new TenantsRepo(db),
  };
  return { db, users, apiKeys, owner, app: createApp(ctx) };
}

const bearer = (key: string) => ({
  method: 'POST',
  headers: { authorization: `Bearer ${key}` },
});

describe('API-key handling on /api/auth/* (spec 055 FR-375)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('a valid API key authenticates on POST /api/auth/callback (materializes the user)', async () => {
    const { plaintext } = s.apiKeys.create({ userId: s.owner.id, name: 'k' });
    const res = await s.app.request('/api/auth/callback', bearer(plaintext));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string } };
    expect(body.user.id).toBe(s.owner.id);
    expect(body.user.email).toBe('u@example.com');
  });

  it('a revoked key gets the key-aware 401 code (not a generic session 401)', async () => {
    const revoked = s.apiKeys.create({ userId: s.owner.id, name: 'r' });
    s.apiKeys.revoke(revoked.view.id, s.owner.id);
    const res = await s.app.request('/api/auth/callback', bearer(revoked.plaintext));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('api_key_revoked');
  });

  it('no credentials still 401 unauthorized', async () => {
    const res = await s.app.request('/api/auth/callback', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
  });
});
