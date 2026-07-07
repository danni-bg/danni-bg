// Multi-tenancy (spec 029) — hermetic via createApp + injected identity headers. Covers the org
// boundary (SC-C1: tenants can't see each other's members/keys/usage), org self-management (FR-132),
// super-admin org CRUD, and the per-tenant usage rollup (SC-C3).

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
import { TenantsRepo } from '../../../src/store/repos/tenants.ts';
import { TokenUsageRepo } from '../../../src/store/repos/token-usage.ts';
import { type UserRow, UsersRepo } from '../../../src/store/repos/users.ts';
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
  const tenants = new TenantsRepo(db);
  const apiKeys = new ApiKeyRepo(db);
  const apiUsage = new ApiUsageRepo(db);
  const ctx: AppContext = {
    bridge: {} as ReadBridge,
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    users,
    tenants,
    apiKeys,
    apiUsage,
    tokenUsage: new TokenUsageRepo(db),
    settings: new PlatformSettingsRepo(db),
  };
  return { db, users, tenants, apiKeys, apiUsage, app: createApp(ctx) };
}

const h = (u: UserRow) => ({
  'content-type': 'application/json',
  'x-user-id': u.kratos_identity_id,
  'x-user-email': u.email,
  'x-user-verified': 'true',
});

describe('Multi-tenancy (spec 029)', () => {
  let s: ReturnType<typeof setup>;
  // Pre-seed two orgs, each with an owner, before any gated request (so ensureMembership leaves the
  // pre-set membership as the user's primary/active org rather than auto-joining the default tenant).
  let acme: ReturnType<TenantsRepo['create']>;
  let globex: ReturnType<TenantsRepo['create']>;
  let ownerA: UserRow;
  let ownerB: UserRow;
  let memberC: UserRow;

  const mkUser = (email: string, role: 'admin' | 'user' = 'user') =>
    s.users.findOrCreateByKratosId({ kratosIdentityId: `k-${email}`, email, createRole: role });

  beforeEach(() => {
    s = setup();
    acme = s.tenants.create({ name: 'Acme', slug: 'acme', plan: 'pro' });
    globex = s.tenants.create({ name: 'Globex', slug: 'globex' });
    ownerA = mkUser('a@acme.test');
    ownerB = mkUser('b@globex.test');
    memberC = mkUser('c@acme.test');
    s.tenants.addMember(acme.id, ownerA.id, 'owner');
    s.tenants.addMember(globex.id, ownerB.id, 'owner');
  });
  afterEach(() => s.db.close());

  it('a new self-registered user auto-joins the default tenant as member', async () => {
    const fresh = mkUser('fresh@x.test');
    const res = await s.app.request('/api/tenant', { headers: h(fresh) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; role: string; members?: unknown };
    expect(body.slug).toBe('default');
    expect(body.role).toBe('member');
    expect(body.members).toBeUndefined(); // members are listed only to org admins
  });

  it('the active org resolves to the pre-set membership; owners see their members', async () => {
    const res = await s.app.request('/api/tenant', { headers: h(ownerA) });
    const body = (await res.json()) as { slug: string; role: string; members: { email: string }[] };
    expect(body.slug).toBe('acme');
    expect(body.role).toBe('owner');
    expect(body.members.map((m) => m.email)).toEqual(['a@acme.test']);
  });

  it('SC-C1: an owner cannot see another org’s members', async () => {
    // ownerA adds memberC to Acme; ownerB (Globex) must never see Acme’s roster.
    const add = await s.app.request('/api/tenant/members', {
      method: 'POST',
      headers: h(ownerA),
      body: JSON.stringify({ email: 'c@acme.test' }),
    });
    expect(add.status).toBe(201);

    const acmeMembers = (await (
      await s.app.request('/api/tenant/members', { headers: h(ownerA) })
    ).json()) as { members: { email: string }[] };
    expect(acmeMembers.members.map((m) => m.email).sort()).toEqual(['a@acme.test', 'c@acme.test']);

    const globexMembers = (await (
      await s.app.request('/api/tenant/members', { headers: h(ownerB) })
    ).json()) as { members: { email: string }[] };
    expect(globexMembers.members.map((m) => m.email)).toEqual(['b@globex.test']);
  });

  it('requireTenantAdmin: a plain member is forbidden from member management', async () => {
    s.tenants.addMember(acme.id, memberC.id, 'member');
    const res = await s.app.request('/api/tenant/members', { headers: h(memberC) });
    expect(res.status).toBe(403);
  });

  it('only an owner can grant ownership; the last owner cannot be removed', async () => {
    s.tenants.addMember(acme.id, memberC.id, 'admin'); // an admin, not an owner
    // An admin (not owner) cannot promote someone to owner.
    const promote = await s.app.request(`/api/tenant/members/${ownerA.id}`, {
      method: 'PATCH',
      headers: h(memberC),
      body: JSON.stringify({ role: 'owner' }),
    });
    expect(promote.status).toBe(403);
    // The sole owner cannot be removed (would orphan the org).
    const remove = await s.app.request(`/api/tenant/members/${ownerA.id}`, {
      method: 'DELETE',
      headers: h(memberC),
    });
    expect(remove.status).toBe(400);
  });

  it('adding an unknown email 404s; you cannot remove yourself', async () => {
    const add = await s.app.request('/api/tenant/members', {
      method: 'POST',
      headers: h(ownerA),
      body: JSON.stringify({ email: 'nobody@x.test' }),
    });
    expect(add.status).toBe(404);
    const self = await s.app.request(`/api/tenant/members/${ownerA.id}`, {
      method: 'DELETE',
      headers: h(ownerA),
    });
    expect(self.status).toBe(400);
  });

  it('an API key created in a session belongs to the caller’s active org', async () => {
    const res = await s.app.request('/api/me/api-keys', {
      method: 'POST',
      headers: h(ownerA),
      body: JSON.stringify({ name: 'acme-key' }),
    });
    expect(res.status).toBe(201);
    expect(s.apiKeys.listForTenant(acme.id)).toHaveLength(1);
    expect(s.apiKeys.listForTenant(globex.id)).toHaveLength(0);
  });

  it('SC-C3: API usage rolls up under each org in the super-admin view', async () => {
    const superAdmin = mkUser('root@danni.bg', 'admin');
    s.apiUsage.record({
      principalKind: 'apiKey',
      principalId: ownerA.id,
      tenantId: acme.id,
      routeClass: 'data',
    });
    s.apiUsage.record({
      principalKind: 'apiKey',
      principalId: ownerA.id,
      tenantId: acme.id,
      routeClass: 'data',
    });
    s.apiUsage.record({
      principalKind: 'apiKey',
      principalId: ownerB.id,
      tenantId: globex.id,
      routeClass: 'chat',
    });

    const res = await s.app.request('/api/admin/api-usage', { headers: h(superAdmin) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      byTenant: { tenantId: string; name: string | null; data: number; chat: number }[];
    };
    const a = body.byTenant.find((t) => t.tenantId === acme.id);
    const g = body.byTenant.find((t) => t.tenantId === globex.id);
    expect(a).toMatchObject({ name: 'Acme', data: 2, chat: 0 });
    expect(g).toMatchObject({ name: 'Globex', data: 0, chat: 1 });
  });

  it('super-admin org CRUD: list, create, and slug-conflict', async () => {
    const superAdmin = mkUser('root@danni.bg', 'admin');
    const list = (await (
      await s.app.request('/api/admin/tenants', { headers: h(superAdmin) })
    ).json()) as { tenants: { slug: string }[] };
    expect(list.tenants.map((t) => t.slug).sort()).toEqual(['acme', 'default', 'globex']);

    const created = await s.app.request('/api/admin/tenants', {
      method: 'POST',
      headers: h(superAdmin),
      body: JSON.stringify({ name: 'Initech', slug: 'initech', plan: 'enterprise' }),
    });
    expect(created.status).toBe(201);

    const dup = await s.app.request('/api/admin/tenants', {
      method: 'POST',
      headers: h(superAdmin),
      body: JSON.stringify({ name: 'Dup', slug: 'acme' }),
    });
    expect(dup.status).toBe(409);
  });

  it('a non-admin user cannot reach super-admin org CRUD', async () => {
    const res = await s.app.request('/api/admin/tenants', { headers: h(ownerA) });
    expect(res.status).toBe(403); // org owner ≠ danni super-admin
  });
});
