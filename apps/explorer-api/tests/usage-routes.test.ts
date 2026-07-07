// Token metering routes — hermetic via createApp + injected identity headers (Constitution VI):
// admin per-user usage/quota admin, the per-user self view, and the chat quota gate (429).

import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { PlatformSettingsRepo } from '../../../src/store/repos/platform-settings.ts';
import { TokenUsageRepo } from '../../../src/store/repos/token-usage.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { TOGGLES_SETTING_KEY } from '../src/admin/settings-schema.ts';
import { type AppContext, createApp } from '../src/app.ts';
import type { ReadBridge } from '../src/read-bridge.ts';

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
  const tokenUsage = new TokenUsageRepo(db);
  const settings = new PlatformSettingsRepo(db);
  const ctx: AppContext = {
    bridge: {} as ReadBridge,
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    users,
    tokenUsage,
    settings,
  };
  const admin = users.findOrCreateByKratosId({
    kratosIdentityId: 'admin-k',
    email: 'admin@example.com',
  });
  users.setRoleByEmail('admin@example.com', 'admin');
  const user = users.findOrCreateByKratosId({
    kratosIdentityId: 'user-k',
    email: 'user@example.com',
  });
  return { db, users, tokenUsage, settings, admin, user, app: createApp(ctx) };
}

const ADMIN = {
  'content-type': 'application/json',
  'x-user-id': 'admin-k',
  'x-user-email': 'admin@example.com',
};
const USER = {
  'content-type': 'application/json',
  'x-user-id': 'user-k',
  'x-user-email': 'user@example.com',
};

describe('GET /api/admin/usage', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  it('returns per-user usage with the effective limit (admin only)', async () => {
    s.users.setTokenLimit(s.user.id, 1000);
    s.tokenUsage.record({
      userId: s.user.id,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 20,
    });
    const res = await s.app.request('/api/admin/usage', { headers: ADMIN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      defaultLimit: number;
      users: {
        email: string;
        used: number;
        input: number;
        output: number;
        cached: number;
        limit: number;
        remaining: number;
        exceeded: boolean;
        tokenLimit: number | null;
      }[];
    };
    expect(body.defaultLimit).toBe(0);
    const row = body.users.find((u) => u.email === 'user@example.com');
    // used is the billable total: 150 − (1−0.1)·20 cache = 132. Breakdown stays raw.
    expect(row).toMatchObject({
      used: 132,
      input: 100,
      output: 50,
      cached: 20,
      limit: 1000,
      remaining: 868,
      exceeded: false,
      tokenLimit: 1000,
    });
  });

  it('403 for a normal user, 401 for anon', async () => {
    expect((await s.app.request('/api/admin/usage', { headers: USER })).status).toBe(403);
    expect((await s.app.request('/api/admin/usage')).status).toBe(401);
  });
});

describe('admin user-quota mutations', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  const put = (id: string, body: unknown) =>
    s.app.request(`/api/admin/users/${id}/limit`, {
      method: 'PUT',
      headers: ADMIN,
      body: JSON.stringify(body),
    });

  it('PUT sets and clears a per-user limit', async () => {
    expect((await put(s.user.id, { limit: 500 })).status).toBe(200);
    expect(s.users.get(s.user.id)?.token_limit).toBe(500);
    expect((await put(s.user.id, { limit: null })).status).toBe(200);
    expect(s.users.get(s.user.id)?.token_limit).toBeNull();
  });

  it('PUT rejects a bad body (400) and a missing user (404)', async () => {
    expect((await put(s.user.id, { limit: 'lots' })).status).toBe(400);
    expect((await put(s.user.id, 'nope')).status).toBe(400);
    expect((await put('missing', { limit: 5 })).status).toBe(404);
  });

  it('POST reset zeroes the counted usage and 404s a missing user', async () => {
    // Recorded before the reset instant, so the new window excludes it.
    s.tokenUsage.record({
      userId: s.user.id,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 999,
      now: '2020-01-01T00:00:00Z',
    });
    expect(
      (
        await s.app.request(`/api/admin/users/${s.user.id}/reset`, {
          method: 'POST',
          headers: ADMIN,
        })
      ).status,
    ).toBe(200);
    expect(
      s.tokenUsage.usageForUser(s.user.id, s.users.get(s.user.id)?.usage_reset_at ?? null).used,
    ).toBe(0);
    expect(
      (await s.app.request('/api/admin/users/missing/reset', { method: 'POST', headers: ADMIN }))
        .status,
    ).toBe(404);
  });
});

describe('GET /api/me/usage', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  it("reports the caller's own usage against the platform default limit", async () => {
    s.settings.set(TOGGLES_SETTING_KEY, { defaultTokenLimit: 100 }, 'test');
    s.tokenUsage.record({
      userId: s.user.id,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 5,
    });
    const res = await s.app.request('/api/me/usage', { headers: USER });
    expect(res.status).toBe(200);
    // used is billable: 30 − 0.9·5 cache = 25.5 → 26. Breakdown stays raw.
    expect(await res.json()).toMatchObject({
      used: 26,
      input: 10,
      output: 20,
      cached: 5,
      limit: 100,
      remaining: 74,
      exceeded: false,
      requests: 1,
    });
  });

  it('honors an admin-configured cache weight', async () => {
    s.settings.set(TOGGLES_SETTING_KEY, { defaultTokenLimit: 100, cachedTokenWeight: 0.5 }, 'test');
    s.tokenUsage.record({
      userId: s.user.id,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      cachedInputTokens: 10,
    });
    const res = await s.app.request('/api/me/usage', { headers: USER });
    // billable = 30 − (1−0.5)·10 = 25
    expect(await res.json()).toMatchObject({ used: 25, cached: 10, limit: 100, remaining: 75 });
  });
});

describe('PUT /api/me/avatar', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  const put = (body: unknown) =>
    s.app.request('/api/me/avatar', { method: 'PUT', headers: USER, body: JSON.stringify(body) });

  it('stores and clears a valid data: image URL', async () => {
    expect((await put({ avatarUrl: 'data:image/webp;base64,AAAA' })).status).toBe(200);
    expect(s.users.get(s.user.id)?.avatar_url).toBe('data:image/webp;base64,AAAA');
    expect((await put({ avatarUrl: null })).status).toBe(200);
    expect(s.users.get(s.user.id)?.avatar_url).toBeNull();
  });

  it('rejects a non-image / oversized payload (400) and anon (401)', async () => {
    expect((await put({ avatarUrl: 'https://evil.example/x.png' })).status).toBe(400);
    expect((await put({ avatarUrl: `data:image/png;base64,${'A'.repeat(700_000)}` })).status).toBe(
      400,
    );
    expect((await s.app.request('/api/me/avatar', { method: 'PUT', body: '{}' })).status).toBe(401);
  });
});

describe('POST /api/chat quota gate', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  it('429s a user who is over their quota, before any model work', async () => {
    s.users.setTokenLimit(s.user.id, 50);
    s.tokenUsage.record({ userId: s.user.id, inputTokens: 0, outputTokens: 0, totalTokens: 60 });
    const res = await s.app.request('/api/chat', {
      method: 'POST',
      headers: USER,
      body: JSON.stringify({
        message: 'hi',
        provider: { kind: 'openai-compatible', model: 'm', apiKey: 'x' },
      }),
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('quota_exceeded');
  });

  it('allows a user under quota to proceed past the gate', async () => {
    s.users.setTokenLimit(s.user.id, 1000);
    s.tokenUsage.record({ userId: s.user.id, inputTokens: 0, outputTokens: 0, totalTokens: 10 });
    // Under quota → not 429 (it proceeds to SSE; provider misconfig surfaces inside the stream, not here).
    const res = await s.app.request('/api/chat', {
      method: 'POST',
      headers: USER,
      body: JSON.stringify({
        message: 'hi',
        provider: { kind: 'openai-compatible', model: 'm', apiKey: 'x' },
      }),
    });
    expect(res.status).not.toBe(429);
  });
});
