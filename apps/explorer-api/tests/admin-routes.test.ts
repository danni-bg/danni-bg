// Admin settings API (spec 019, Phase C) — hermetic via createApp + injected identity headers.

import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { ApiKeyRepo } from '../../../src/store/repos/api-keys.ts';
import { ApiUsageRepo } from '../../../src/store/repos/api-usage.ts';
import { PlatformSettingsRepo } from '../../../src/store/repos/platform-settings.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
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
  const settings = new PlatformSettingsRepo(db);
  const ctx: AppContext = {
    bridge: {} as ReadBridge,
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    users,
    settings,
  };
  return { db, users, settings, app: createApp(ctx) };
}

const ADMIN = {
  'content-type': 'application/json',
  'x-user-id': 'admin-k',
  'x-user-email': 'admin@example.com',
  'x-user-verified': 'true',
};
const USER = { ...ADMIN, 'x-user-id': 'user-k', 'x-user-email': 'user@example.com' };

describe('GET/PUT /api/admin/settings', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
    s.users.findOrCreateByKratosId({ kratosIdentityId: 'admin-k', email: 'admin@example.com' });
    s.users.setRoleByEmail('admin@example.com', 'admin');
  });
  afterEach(() => s.db.close());

  const get = (h: Record<string, string>) => s.app.request('/api/admin/settings', { headers: h });
  const put = (h: Record<string, string>, body: unknown) =>
    s.app.request('/api/admin/settings', { method: 'PUT', headers: h, body: JSON.stringify(body) });

  it('401 for anonymous', async () => {
    expect((await get({})).status).toBe(401);
  });

  it('403 for a non-admin user', async () => {
    expect((await get(USER)).status).toBe(403);
    expect((await put(USER, { toggles: { chatEnabled: false } })).status).toBe(403);
  });

  it('PUT persists the LLM provider; GET masks the key and never returns it raw', async () => {
    await put(ADMIN, {
      llm: { kind: 'openai-compatible', model: 'm', baseUrl: 'http://x', apiKey: 'sk-secret-7777' },
    });
    const res = await get(ADMIN);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('sk-secret-7777');
    const body = JSON.parse(text);
    expect(body.source).toBe('settings');
    expect(body.llm.model).toBe('m');
    expect(body.llm.apiKeyMasked).toBe(true);
    expect(body.llm.apiKeyHint).toBe('••••7777');
  });

  it('PUT with an omitted key keeps the existing secret while updating other fields', async () => {
    await put(ADMIN, {
      llm: { kind: 'openai-compatible', model: 'm', baseUrl: 'http://x', apiKey: 'sk-keep-1234' },
    });
    await put(ADMIN, { llm: { kind: 'openai-compatible', model: 'm2', baseUrl: 'http://y' } });
    const stored = s.settings.get('llm.default') as { apiKey: string; model: string };
    expect(stored.apiKey).toBe('sk-keep-1234');
    expect(stored.model).toBe('m2');
  });

  it('GET reports source=env with a null LLM when nothing is configured', async () => {
    // No persisted setting and no EXPLORER_DEFAULT_* env → resolveDefaultView's env fallthrough.
    const savedP = process.env.EXPLORER_DEFAULT_PROVIDER;
    const savedM = process.env.EXPLORER_DEFAULT_MODEL;
    delete process.env.EXPLORER_DEFAULT_PROVIDER;
    delete process.env.EXPLORER_DEFAULT_MODEL;
    try {
      const body = (await (await get(ADMIN)).json()) as { source: string; llm: unknown };
      expect(body.source).toBe('env');
      expect(body.llm).toBeNull();
    } finally {
      if (savedP !== undefined) process.env.EXPLORER_DEFAULT_PROVIDER = savedP;
      if (savedM !== undefined) process.env.EXPLORER_DEFAULT_MODEL = savedM;
    }
  });

  it('PUT toggles round-trips', async () => {
    await put(ADMIN, { toggles: { chatEnabled: false, defaultTokenLimit: 3600 } });
    const body = (await (await get(ADMIN)).json()) as { toggles: unknown };
    expect(body.toggles).toEqual({ chatEnabled: false, defaultTokenLimit: 3600 });
  });

  it('PUT rejects an invalid body with 400', async () => {
    expect((await put(ADMIN, { llm: { kind: 'bogus', model: 'm' } })).status).toBe(400);
  });
});

// Super-admin per-key request-quota override (spec 040 FR-221 / SC-2): settable + clearable via the
// API, no SQL. Wires an ApiKeyRepo so the route is mounted.
describe('PUT /api/admin/api-keys/:id/quota', () => {
  function setupKeys() {
    const db = new Database(':memory:');
    runMigrations(db, join(ROOT, 'migrations'));
    const users = new UsersRepo(db);
    const settings = new PlatformSettingsRepo(db);
    const apiKeys = new ApiKeyRepo(db);
    const apiUsage = new ApiUsageRepo(db);
    const ctx: AppContext = {
      bridge: {} as ReadBridge,
      crosswalk: new Crosswalk(loadCrosswalk()),
      health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
      users,
      settings,
      apiKeys,
      apiUsage,
    };
    return { db, users, apiKeys, app: createApp(ctx) };
  }

  let s: ReturnType<typeof setupKeys>;
  let ownerId: string;
  beforeEach(() => {
    s = setupKeys();
    s.users.findOrCreateByKratosId({ kratosIdentityId: 'admin-k', email: 'admin@example.com' });
    s.users.setRoleByEmail('admin@example.com', 'admin');
    ownerId = s.users.findOrCreateByKratosId({
      kratosIdentityId: 'user-k',
      email: 'user@example.com',
    }).id;
  });
  afterEach(() => s.db.close());

  const putQuota = (h: Record<string, string>, id: string, body: unknown) =>
    s.app.request(`/api/admin/api-keys/${id}/quota`, {
      method: 'PUT',
      headers: h,
      body: JSON.stringify(body),
    });

  it('a super-admin sets, changes, and clears a key quota (no SQL)', async () => {
    const { view } = s.apiKeys.create({ userId: ownerId, name: 'k' });

    expect((await putQuota(ADMIN, view.id, { limit: 500 })).status).toBe(200);
    expect(s.apiKeys.listForUser(ownerId)[0]?.quotaLimit).toBe(500);
    expect((await putQuota(ADMIN, view.id, { limit: 10 })).status).toBe(200);
    expect(s.apiKeys.listForUser(ownerId)[0]?.quotaLimit).toBe(10);
    expect((await putQuota(ADMIN, view.id, { limit: null })).status).toBe(200);
    expect(s.apiKeys.listForUser(ownerId)[0]?.quotaLimit).toBeNull();
  });

  it('404 for an unknown key, 400 for an invalid limit', async () => {
    expect((await putQuota(ADMIN, 'no-such', { limit: 5 })).status).toBe(404);
    const { view } = s.apiKeys.create({ userId: ownerId, name: 'k' });
    expect((await putQuota(ADMIN, view.id, { limit: -1 })).status).toBe(400);
    expect((await putQuota(ADMIN, view.id, {})).status).toBe(400);
  });

  it('a non-admin (and an anonymous caller) cannot set a key quota', async () => {
    const { view } = s.apiKeys.create({ userId: ownerId, name: 'k' });
    expect((await putQuota(USER, view.id, { limit: 5 })).status).toBe(403);
    expect(
      (await putQuota({ 'content-type': 'application/json' }, view.id, { limit: 5 })).status,
    ).toBe(401);
  });
});
