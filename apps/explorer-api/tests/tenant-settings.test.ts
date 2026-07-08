// Tenant-scoped settings resolution (spec 042) — hermetic via createApp + injected identity headers.
// Covers: an org-admin per-tenant LLM/quota override surface (FR-242), the overridable-key allowlist
// (FR-241 / SC-3), the no-cross-tenant-secret-leak isolation invariant (FR-243 / SC-2), per-tenant
// metering resolution end-to-end (FR-240 / SC-1 via /api/me/usage), super-admin recovery (FR-244),
// and default-org parity (FR-245 / SC-4).

import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { PlatformSettingsRepo } from '../../../src/store/repos/platform-settings.ts';
import { TenantsRepo } from '../../../src/store/repos/tenants.ts';
import { TokenUsageRepo } from '../../../src/store/repos/token-usage.ts';
import { type UserRow, UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import type { ReadBridge } from '../src/read-bridge.ts';

// Header-driven gated routes require the explicit trust opt-in (spec 034; hermetic — no live Kratos).
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
  const tenants = new TenantsRepo(db);
  const settings = new PlatformSettingsRepo(db);
  const ctx: AppContext = {
    bridge: {} as ReadBridge,
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    users,
    tenants,
    tokenUsage: new TokenUsageRepo(db),
    settings,
  };
  return { db, users, tenants, settings, app: createApp(ctx) };
}

const h = (u: UserRow) => ({
  'content-type': 'application/json',
  'x-user-id': u.kratos_identity_id,
  'x-user-email': u.email,
  'x-user-verified': 'true',
});

describe('Tenant-scoped settings (spec 042)', () => {
  let s: ReturnType<typeof setup>;
  let acme: ReturnType<TenantsRepo['create']>;
  let globex: ReturnType<TenantsRepo['create']>;
  let ownerA: UserRow;
  let ownerB: UserRow;
  let memberA: UserRow;
  let superAdmin: UserRow;

  const mkUser = (email: string, role: 'admin' | 'user' = 'user') =>
    s.users.findOrCreateByKratosId({ kratosIdentityId: `k-${email}`, email, createRole: role });

  beforeEach(() => {
    s = setup();
    acme = s.tenants.create({ name: 'Acme', slug: 'acme', plan: 'pro' });
    globex = s.tenants.create({ name: 'Globex', slug: 'globex' });
    ownerA = mkUser('a@acme.test');
    ownerB = mkUser('b@globex.test');
    memberA = mkUser('m@acme.test');
    superAdmin = mkUser('root@danni.bg', 'admin');
    s.tenants.addMember(acme.id, ownerA.id, 'owner');
    s.tenants.addMember(globex.id, ownerB.id, 'owner');
    s.tenants.addMember(acme.id, memberA.id, 'member');
  });
  afterEach(() => s.db.close());

  const putTenantSettings = (u: UserRow, body: unknown) =>
    s.app.request('/api/tenant/settings', {
      method: 'PUT',
      headers: h(u),
      body: JSON.stringify(body),
    });
  const getTenantSettings = (u: UserRow) =>
    s.app.request('/api/tenant/settings', { headers: h(u) });

  it('requireTenantAdmin gates the surface: a plain member is 403 on read and write', async () => {
    expect((await getTenantSettings(memberA)).status).toBe(403);
    expect((await putTenantSettings(memberA, { defaultTokenLimit: 100 })).status).toBe(403);
  });

  it('an org admin sets an LLM override; the view is masked with the org’s OWN key hint', async () => {
    const put = await putTenantSettings(ownerA, {
      llm: {
        kind: 'openai-compatible',
        model: 'acme-model',
        baseUrl: 'https://acme.llm',
        apiKey: 'sk-acme-secret',
      },
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as {
      llm: { overridden: boolean; source: string; model: string; apiKeyHint: string | null };
    };
    expect(body.llm).toMatchObject({
      overridden: true,
      source: 'tenant',
      model: 'acme-model',
      apiKeyConfigured: true,
      apiKeyHint: '••••cret',
    });
    // The raw secret is never echoed.
    expect(JSON.stringify(body)).not.toContain('sk-acme-secret');

    // Empty apiKey on a re-write keeps the org's OWN existing key (mask/merge parity with admin).
    const again = await putTenantSettings(ownerA, {
      llm: { kind: 'openai-compatible', model: 'acme-model-2', apiKey: '' },
    });
    const j = (await again.json()) as { llm: { model: string; apiKeyConfigured: boolean } };
    expect(j.llm.model).toBe('acme-model-2');
    expect(j.llm.apiKeyConfigured).toBe(true); // kept
  });

  // SC-1 (LLM path): the chat provider the app resolves per turn goes through the active org — org A
  // gets its override, org B still gets global. resolveServerDefault (the exact function the chat path
  // calls with the active tenant) is asserted directly in admin-settings.test.ts; here we prove the
  // storage/isolation end-to-end through the API.
  it('SC-2 / FR-243: org B never sees org A’s or the global LLM secret', async () => {
    // Global provider (super-admin) + an Acme-only override.
    await s.app.request('/api/admin/settings', {
      method: 'PUT',
      headers: h(superAdmin),
      body: JSON.stringify({
        llm: { kind: 'anthropic', model: 'global-model', apiKey: 'sk-global-secret' },
      }),
    });
    await putTenantSettings(ownerA, {
      llm: { kind: 'openai-compatible', model: 'acme-model', apiKey: 'sk-acme-secret' },
    });

    // Globex has no override → it sees an INHERITED view: non-secret fields only, no key hint at all.
    const view = await getTenantSettings(ownerB);
    expect(view.status).toBe(200);
    const raw = await view.text();
    expect(raw).not.toContain('sk-global-secret');
    expect(raw).not.toContain('sk-acme-secret');
    const body = JSON.parse(raw) as {
      llm: { overridden: boolean; source: string; model: string; apiKeyHint: string | null };
    };
    expect(body.llm).toMatchObject({
      overridden: false,
      source: 'inherited',
      model: 'global-model',
      apiKeyConfigured: true, // a key EXISTS globally
      apiKeyHint: null, // …but never a hint of it (not even the last 4)
    });
  });

  it('an org admin can clear the LLM override by writing llm: null', async () => {
    // Seed a GLOBAL default so clearing the tenant override falls back to a known inherited view.
    // (Without this the resolved llm would be null on a clean env — no ambient EXPLORER_DEFAULT_*/
    // .env-seeded global — which is exactly what differs between a local shell and CI.)
    await s.app.request('/api/admin/settings', {
      method: 'PUT',
      headers: h(superAdmin),
      body: JSON.stringify({
        llm: { kind: 'anthropic', model: 'global-model', apiKey: 'sk-global' },
      }),
    });
    // Set an override, then clear it with an explicit null → applyTenantSettings clears the tenant row.
    await putTenantSettings(ownerA, {
      llm: { kind: 'openai-compatible', model: 'acme-model', apiKey: 'sk-acme' },
    });
    expect(s.settings.own('llm.default', acme.id)).not.toBeNull();

    const cleared = await putTenantSettings(ownerA, { llm: null });
    expect(cleared.status).toBe(200);
    expect(s.settings.own('llm.default', acme.id)).toBeNull();
    const body = (await cleared.json()) as { llm: { overridden: boolean; source: string } };
    expect(body.llm.overridden).toBe(false); // falls back to the inherited global
    expect(body.llm.source).toBe('inherited');
  });

  it('SC-3 / FR-241: overriding a non-allowlisted key is 4xx and writes nothing', async () => {
    // A platform toggle / api rate knob is not in the tenant allowlist — .strict() rejects it.
    const bad = await putTenantSettings(ownerA, { apiRateData: 5 });
    expect(bad.status).toBe(400);
    const bad2 = await putTenantSettings(ownerA, { toggles: { chatEnabled: false } });
    expect(bad2.status).toBe(400);

    // Nothing was written: the tenant still has no overrides.
    const view = (await (await getTenantSettings(ownerA)).json()) as {
      defaultTokenLimit: { overridden: boolean };
      llm: { overridden: boolean } | null;
    };
    expect(view.defaultTokenLimit.overridden).toBe(false);
    expect(view.llm?.overridden ?? false).toBe(false);
    expect(s.settings.own('toggles', acme.id)).toBeNull();
  });

  it('SC-1 (metering): a per-tenant defaultTokenLimit changes that org’s quota; others inherit global', async () => {
    // Global default via the super-admin surface, then an Acme-only override.
    await s.app.request('/api/admin/settings', {
      method: 'PUT',
      headers: h(superAdmin),
      body: JSON.stringify({ toggles: { defaultTokenLimit: 1000 } }),
    });
    const set = await putTenantSettings(ownerA, { defaultTokenLimit: 5000 });
    expect(set.status).toBe(200);
    expect(
      ((await set.json()) as { defaultTokenLimit: { value: number } }).defaultTokenLimit.value,
    ).toBe(5000);

    // /api/me/usage resolves the default through the caller's active org (FR-240).
    const usageA = (await (
      await s.app.request('/api/me/usage', { headers: h(ownerA) })
    ).json()) as { limit: number };
    const usageB = (await (
      await s.app.request('/api/me/usage', { headers: h(ownerB) })
    ).json()) as { limit: number };
    expect(usageA.limit).toBe(5000); // Acme override
    expect(usageB.limit).toBe(1000); // Globex inherits global

    // Clearing the override falls back to the global default.
    await putTenantSettings(ownerA, { defaultTokenLimit: null });
    const cleared = (await (
      await s.app.request('/api/me/usage', { headers: h(ownerA) })
    ).json()) as { limit: number };
    expect(cleared.limit).toBe(1000);
    expect(s.settings.own('toggles', acme.id)).toBeNull();
  });

  it('FR-244: a super-admin can view and clear any org’s overrides', async () => {
    await putTenantSettings(ownerA, {
      llm: { kind: 'openai-compatible', model: 'acme-model', apiKey: 'sk-acme' },
      defaultTokenLimit: 9000,
    });
    const view = await s.app.request(`/api/admin/tenants/${acme.id}/settings`, {
      headers: h(superAdmin),
    });
    expect(view.status).toBe(200);
    const vb = (await view.json()) as {
      llm: { overridden: boolean };
      defaultTokenLimit: { overridden: boolean; value: number };
    };
    expect(vb.llm.overridden).toBe(true);
    expect(vb.defaultTokenLimit).toMatchObject({ overridden: true, value: 9000 });

    const del = await s.app.request(`/api/admin/tenants/${acme.id}/settings`, {
      method: 'DELETE',
      headers: h(superAdmin),
    });
    expect(del.status).toBe(200);
    // Both overrides are gone → back to inherited/global.
    expect(s.settings.own('llm.default', acme.id)).toBeNull();
    expect(s.settings.own('toggles', acme.id)).toBeNull();

    // A non-admin cannot reach the super-admin recovery surface.
    const denied = await s.app.request(`/api/admin/tenants/${acme.id}/settings`, {
      headers: h(ownerA),
    });
    expect(denied.status).toBe(403);
    // An unknown org 404s.
    const missing = await s.app.request('/api/admin/tenants/nope/settings', {
      headers: h(superAdmin),
    });
    expect(missing.status).toBe(404);
  });

  it('FR-245: an org with no overrides reports inherited everywhere (no behavior change)', async () => {
    await s.app.request('/api/admin/settings', {
      method: 'PUT',
      headers: h(superAdmin),
      body: JSON.stringify({
        llm: { kind: 'anthropic', model: 'global-model', apiKey: 'sk-global' },
        toggles: { defaultTokenLimit: 1234 },
      }),
    });
    const view = (await (await getTenantSettings(ownerA)).json()) as {
      llm: { overridden: boolean; model: string };
      defaultTokenLimit: { overridden: boolean; value: number };
    };
    expect(view.llm).toMatchObject({ overridden: false, model: 'global-model' });
    expect(view.defaultTokenLimit).toMatchObject({ overridden: false, value: 1234 });
  });
});
