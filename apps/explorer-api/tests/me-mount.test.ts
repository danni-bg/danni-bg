// Spec 056 FR-393 (SC-6) + FR-392 (SC-5, /api/me): the /api/me mount is decoupled from token
// metering — API keys + sessions work with NO tokenUsage repo wired; /usage says so clearly. Sessions
// honor limit/offset and return total. Hermetic via createApp + injected identity headers.

import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { ApiKeyRepo } from '../../../src/store/repos/api-keys.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import { PersistentSessionStore } from '../src/chat/sessions-repo.ts';
import type { ReadBridge } from '../src/read-bridge.ts';

beforeAll(() => {
  process.env.TRUST_PROXY_AUTH_HEADERS = 'true';
});
afterAll(() => {
  delete process.env.TRUST_PROXY_AUTH_HEADERS;
});

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const USER = {
  'content-type': 'application/json',
  'x-user-id': 'user-k',
  'x-user-email': 'user@example.com',
  'x-user-verified': 'true',
};

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  const user = users.findOrCreateByKratosId({
    kratosIdentityId: 'user-k',
    email: 'user@example.com',
  });
  const chatSessions = new PersistentSessionStore(db);
  const ctx: AppContext = {
    bridge: {} as ReadBridge,
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    users,
    apiKeys: new ApiKeyRepo(db),
    chatSessions,
    // NOTE: deliberately NO tokenUsage — the whole point of FR-393.
  };
  return { db, users, user, chatSessions, app: createApp(ctx) };
}

describe('spec 056 SC-6: /api/me mounts without token metering', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  it('serves /api/me/api-keys with no tokenUsage repo wired', async () => {
    const res = await s.app.request('/api/me/api-keys', { headers: USER });
    expect(res.status).toBe(200);
    expect((await res.json()) as { keys: unknown[] }).toEqual({ keys: [] });
  });

  it('serves /api/me/sessions with no tokenUsage repo wired', async () => {
    const res = await s.app.request('/api/me/sessions', { headers: USER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[]; total: number };
    expect(body.sessions).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('/api/me/usage returns a clear "metering not configured" response (501) when absent', async () => {
    const res = await s.app.request('/api/me/usage', { headers: USER });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('metering_unconfigured');
  });

  it('SC-5: /api/me/sessions honors limit/offset and returns total', async () => {
    // Seed 3 owned sessions.
    for (let i = 0; i < 3; i++) {
      const conv = s.chatSessions.getOrCreate(null, s.user.id);
      s.chatSessions.append(conv.sessionId, { role: 'user', content: `q${i}` });
    }
    const page = async (qs: string) =>
      (await (await s.app.request(`/api/me/sessions${qs}`, { headers: USER })).json()) as {
        sessions: unknown[];
        total: number;
        limit: number;
        offset: number;
      };

    const all = await page('');
    expect(all.total).toBe(3);
    expect(all.sessions).toHaveLength(3);

    const first2 = await page('?limit=2');
    expect(first2.sessions).toHaveLength(2);
    expect(first2.total).toBe(3);
    expect(first2.limit).toBe(2);

    const rest = await page('?limit=2&offset=2');
    expect(rest.sessions).toHaveLength(1);
    expect(rest.offset).toBe(2);
  });
});
