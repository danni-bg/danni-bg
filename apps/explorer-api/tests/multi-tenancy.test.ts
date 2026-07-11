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
import { LLM_SETTING_KEY } from '../src/admin/settings-schema.ts';
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
  const settings = new PlatformSettingsRepo(db);
  const ctx: AppContext = {
    bridge: {} as ReadBridge,
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    users,
    tenants,
    apiKeys,
    apiUsage,
    tokenUsage: new TokenUsageRepo(db),
    settings,
  };
  return { db, users, tenants, apiKeys, apiUsage, settings, app: createApp(ctx) };
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

  it('GET /api/tenant/memberships lists every org the caller belongs to, with name + slug', async () => {
    s.tenants.addMember(globex.id, ownerA.id, 'member'); // ownerA now belongs to two orgs
    const res = await s.app.request('/api/tenant/memberships', { headers: h(ownerA) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      memberships: { tenantId: string; name: string; slug: string; role: string }[];
    };
    expect(body.memberships.map((m) => m.tenantId).sort()).toEqual([acme.id, globex.id].sort());
    // enriched with name + slug (spec 064 FR-504)
    expect(body.memberships.find((m) => m.tenantId === acme.id)).toEqual({
      tenantId: acme.id,
      name: 'Acme',
      slug: 'acme',
      role: 'owner',
    });
  });

  describe('self-serve org creation (spec 064)', () => {
    const create = (u: UserRow, name: string) =>
      s.app.request('/api/tenant', {
        method: 'POST',
        headers: h(u),
        body: JSON.stringify({ name }),
      });

    it('creates an org, makes the caller owner (Cyrillic slug), and switches their active org', async () => {
      const res = await create(memberC, 'Моята Фирма');
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; name: string; slug: string; role: string };
      expect(body.name).toBe('Моята Фирма');
      expect(body.slug).toBe('моята-фирма');
      expect(body.role).toBe('owner');
      // the caller's active org is now the new one
      const active = (await (
        await s.app.request('/api/tenant', { headers: h(memberC) })
      ).json()) as {
        id: string;
        role: string;
      };
      expect(active.id).toBe(body.id);
      expect(active.role).toBe('owner');
    });

    it('de-duplicates the slug on name collision, and falls back when the name has no slug chars', async () => {
      expect(((await (await create(ownerA, 'Dup')).json()) as { slug: string }).slug).toBe('dup');
      expect(((await (await create(ownerB, 'Dup')).json()) as { slug: string }).slug).toBe('dup-2');
      const empty = (await (await create(memberC, '!!! ???')).json()) as { slug: string };
      expect(empty.slug.startsWith('org-')).toBe(true);
    });

    it('400s an invalid name, 403s an API-key caller, 403s over the org cap', async () => {
      expect((await create(ownerA, '   ')).status).toBe(400); // trims to empty
      // an API key can never create an org (requireHuman)
      const key = s.apiKeys.create({ userId: ownerA.id, name: 'k' });
      const viaKey = await s.app.request('/api/tenant', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key.plaintext}` },
        body: JSON.stringify({ name: 'Via Key' }),
      });
      expect(viaKey.status).toBe(403);
      // over the ownership cap → 403 org_limit, nothing created
      const capped = mkUser('capped@x.test');
      for (let i = 0; i < 10; i++)
        s.tenants.createOwned({ name: `o${i}`, slug: `cap-${i}`, ownerUserId: capped.id });
      const over = await create(capped, 'One More');
      expect(over.status).toBe(403);
      expect(((await over.json()) as { error: { code: string } }).error.code).toBe('org_limit');
    });
  });

  describe('org entitlements (spec 065)', () => {
    const put = (u: UserRow, path: string, body: unknown) =>
      s.app.request(path, { method: 'PUT', headers: h(u), body: JSON.stringify(body) });
    const superAdmin = () => mkUser('root@danni.bg', 'admin');
    const code = async (res: Response) =>
      ((await res.json()) as { error: { code: string } }).error.code;

    it('super-admin assigns a pool + toggles BYOM; disabling BYOM clears the org LLM override; 404s unknown', async () => {
      const root = superAdmin();
      expect((await put(root, `/api/admin/tenants/${acme.id}/pool`, { pool: 1000 })).status).toBe(
        200,
      );
      expect(s.tenants.get(acme.id)?.token_pool).toBe(1000);
      expect(
        (await put(root, `/api/admin/tenants/${acme.id}/byom`, { enabled: true })).status,
      ).toBe(200);
      s.settings.set(
        LLM_SETTING_KEY,
        { kind: 'openai-compatible', model: 'm', baseUrl: null, apiKey: 'k' },
        null,
        undefined,
        acme.id,
      );
      await put(root, `/api/admin/tenants/${acme.id}/byom`, { enabled: false });
      expect(s.settings.own(LLM_SETTING_KEY, acme.id)).toBeNull(); // disabling BYOM cleared it
      expect((await put(root, '/api/admin/tenants/ghost/pool', { pool: 1 })).status).toBe(404);
      expect((await put(root, '/api/admin/tenants/ghost/byom', { enabled: true })).status).toBe(
        404,
      );
    });

    it('lowering a pool below what is already allocated is rejected (FR-603)', async () => {
      const root = superAdmin();
      await put(root, `/api/admin/tenants/${acme.id}/pool`, { pool: 1000 });
      s.tenants.setMemberAllowance(acme.id, ownerA.id, 800);
      const res = await put(root, `/api/admin/tenants/${acme.id}/pool`, { pool: 500 });
      expect(res.status).toBe(400);
      expect(await code(res)).toBe('pool_below_allocated');
    });

    it('org admin allocates within the pool; over-allocation, unknown member, and no-pool are rejected', async () => {
      await put(superAdmin(), `/api/admin/tenants/${acme.id}/pool`, { pool: 1000 });
      s.tenants.addMember(acme.id, memberC.id, 'member');
      expect(
        (await put(ownerA, `/api/tenant/members/${ownerA.id}/allowance`, { limit: 600 })).status,
      ).toBe(200);
      const over = await put(ownerA, `/api/tenant/members/${memberC.id}/allowance`, { limit: 500 }); // 600+500>1000
      expect(over.status).toBe(400);
      expect(await code(over)).toBe('over_pool');
      expect((await put(ownerA, '/api/tenant/members/ghost/allowance', { limit: 1 })).status).toBe(
        404,
      );
      // globex (ownerB's active org) has no pool → no_pool
      expect(
        await code(await put(ownerB, `/api/tenant/members/${ownerB.id}/allowance`, { limit: 1 })),
      ).toBe('no_pool');
    });

    it('GET /api/tenant surfaces pool/allocated/unallocated + byomEnabled + myAllowance (member sees only their own)', async () => {
      await put(superAdmin(), `/api/admin/tenants/${acme.id}/pool`, { pool: 1000 });
      s.tenants.setMemberAllowance(acme.id, ownerA.id, 300);
      s.tenants.addMember(acme.id, memberC.id, 'member');
      s.tenants.setMemberAllowance(acme.id, memberC.id, 50);
      const admin = (await (await s.app.request('/api/tenant', { headers: h(ownerA) })).json()) as {
        pool: number;
        allocated: number;
        unallocated: number;
        byomEnabled: boolean;
        myAllowance: number;
      };
      expect(admin).toMatchObject({
        pool: 1000,
        allocated: 350,
        unallocated: 650,
        byomEnabled: false,
        myAllowance: 300,
      });
      const member = (await (
        await s.app.request('/api/tenant', { headers: h(memberC) })
      ).json()) as {
        pool?: number;
        myAllowance: number;
        byomEnabled: boolean;
      };
      expect(member.pool).toBeUndefined(); // pool figures are admin-only
      expect(member.myAllowance).toBe(50);
      expect(member.byomEnabled).toBe(false);
    });

    it('setting an LLM override requires BYOM enabled (FR-630)', async () => {
      const off = await put(ownerA, '/api/tenant/settings', {
        llm: { kind: 'openai-compatible', model: 'm', apiKey: 'k' },
      });
      expect(off.status).toBe(403);
      expect(await code(off)).toBe('byom_disabled');
      await put(superAdmin(), `/api/admin/tenants/${acme.id}/byom`, { enabled: true });
      const on = await put(ownerA, '/api/tenant/settings', {
        llm: { kind: 'openai-compatible', model: 'm', apiKey: 'k' },
      });
      expect(on.status).toBe(200);
      expect(((await on.json()) as { byomEnabled: boolean }).byomEnabled).toBe(true);
    });
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

  it('only an owner can grant ownership or remove an owner (spec 065 FR-640)', async () => {
    s.tenants.addMember(acme.id, memberC.id, 'admin'); // an admin, not an owner
    // An admin (not owner) cannot promote someone to owner.
    const promote = await s.app.request(`/api/tenant/members/${ownerA.id}`, {
      method: 'PATCH',
      headers: h(memberC),
      body: JSON.stringify({ role: 'owner' }),
    });
    expect(promote.status).toBe(403);
    // An admin cannot remove an owner at all — owner-only (403), not the last-owner 400 (the hardening).
    const adminRemoveOwner = await s.app.request(`/api/tenant/members/${ownerA.id}`, {
      method: 'DELETE',
      headers: h(memberC),
    });
    expect(adminRemoveOwner.status).toBe(403);
    // An owner CAN remove another owner (≥2 owners → the floor is never breached).
    const secondOwner = mkUser('owner2@acme.test');
    s.tenants.addMember(acme.id, secondOwner.id, 'owner');
    const ownerRemovesOwner = await s.app.request(`/api/tenant/members/${secondOwner.id}`, {
      method: 'DELETE',
      headers: h(ownerA),
    });
    expect(ownerRemovesOwner.status).toBe(200);
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

  it('removing a user who is not a member of the org 404s', async () => {
    // ownerB is a real user but not a member of Acme → membershipOf is null (tenant.ts 404 branch).
    const res = await s.app.request(`/api/tenant/members/${ownerB.id}`, {
      method: 'DELETE',
      headers: h(ownerA),
    });
    expect(res.status).toBe(404);
  });

  it('an owner can create then delete one of their API keys; deleting an unknown key 404s', async () => {
    const created = await s.app.request('/api/me/api-keys', {
      method: 'POST',
      headers: h(ownerA),
      body: JSON.stringify({ name: 'to-delete' }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const del = await s.app.request(`/api/me/api-keys/${id}`, {
      method: 'DELETE',
      headers: h(ownerA),
    });
    expect(del.status).toBe(200);
    expect((await del.json()) as { revoked: boolean }).toEqual({ revoked: true });

    const missing = await s.app.request('/api/me/api-keys/nope', {
      method: 'DELETE',
      headers: h(ownerA),
    });
    expect(missing.status).toBe(404);
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

  // Spec 041 (FR-230..235): a non-default org is actually reachable — super-admin seeds it, the user
  // switches to it, and their new key/session/usage attribute to it. A never-switching user is
  // unchanged (FR-235, covered by the default-tenant test above + the whole existing suite).
  describe('tenant activation (spec 041)', () => {
    it('SC-1: super-admin seeds an org, user switches, and a new key carries that org', async () => {
      const superAdmin = mkUser('root@danni.bg', 'admin');
      // A fresh org + a fresh user. The user makes a first gated request so ensureMembership auto-joins
      // them to the default tenant (their primary) BEFORE the org is seeded — mirroring a real
      // self-registered user who later gets added to a second org.
      const initech = s.tenants.create({ name: 'Initech', slug: 'initech', plan: 'enterprise' });
      const u = mkUser('peter@initech.test');
      const before = (await (await s.app.request('/api/tenant', { headers: h(u) })).json()) as {
        slug: string;
      };
      expect(before.slug).toBe('default');

      // Super-admin seeds the org's first owner via /api/admin.
      const seed = await s.app.request(`/api/admin/tenants/${initech.id}/members`, {
        method: 'POST',
        headers: h(superAdmin),
        body: JSON.stringify({ email: 'peter@initech.test', role: 'owner' }),
      });
      expect(seed.status).toBe(201);

      // The user switches their active org to Initech.
      const sw = await s.app.request('/api/tenant/switch', {
        method: 'POST',
        headers: h(u),
        body: JSON.stringify({ tenantId: initech.id }),
      });
      expect(sw.status).toBe(200);
      const after = (await (await s.app.request('/api/tenant', { headers: h(u) })).json()) as {
        slug: string;
        role: string;
      };
      expect(after.slug).toBe('initech');
      expect(after.role).toBe('owner');

      // A new key now belongs to Initech (FR-233), not the default org.
      const key = await s.app.request('/api/me/api-keys', {
        method: 'POST',
        headers: h(u),
        body: JSON.stringify({ name: 'initech-key' }),
      });
      expect(key.status).toBe(201);
      expect(s.apiKeys.listForTenant(initech.id)).toHaveLength(1);

      // A keyed data request meters usage against the key's tenant (Initech) — the metering gate
      // records before the route handler runs, so the empty hermetic bridge doesn't matter. The org
      // then rolls up under Initech in the super-admin byTenant view (SC-1).
      const keyBody = (await key.json()) as { key: string };
      await s.app.request('/api/regions', {
        headers: { authorization: `Bearer ${keyBody.key}` },
      });
      const rollup = (await (
        await s.app.request('/api/admin/api-usage', { headers: h(superAdmin) })
      ).json()) as { byTenant: { tenantId: string; data: number }[] };
      const initechRow = rollup.byTenant.find((t) => t.tenantId === initech.id);
      expect(initechRow?.data).toBeGreaterThanOrEqual(1);
    });

    it('SC-2: switching to a non-membership org is rejected and leaves the selection unchanged', async () => {
      // ownerA belongs to Acme only; switching to Globex must fail and keep them on Acme.
      const res = await s.app.request('/api/tenant/switch', {
        method: 'POST',
        headers: h(ownerA),
        body: JSON.stringify({ tenantId: globex.id }),
      });
      expect(res.status).toBe(404);
      const active = (await (
        await s.app.request('/api/tenant', { headers: h(ownerA) })
      ).json()) as { slug: string };
      expect(active.slug).toBe('acme');
    });

    it('a stale persisted selection falls back to the primary membership (FR-230)', async () => {
      // Persist a selection then remove that membership: the active org falls back, no error.
      s.tenants.addMember(globex.id, ownerA.id, 'member');
      const sw = await s.app.request('/api/tenant/switch', {
        method: 'POST',
        headers: h(ownerA),
        body: JSON.stringify({ tenantId: globex.id }),
      });
      expect(sw.status).toBe(200);
      s.tenants.removeMember(globex.id, ownerA.id);
      const active = (await (
        await s.app.request('/api/tenant', { headers: h(ownerA) })
      ).json()) as { slug: string };
      expect(active.slug).toBe('acme'); // fell back to the primary (oldest) membership
    });

    it('SC-3: FR-234 org admin sees exactly their org’s keys; a member and another org’s admin are refused', async () => {
      // ownerA (Acme owner) mints a key for Acme, then reads the tenant-scoped key view.
      await s.app.request('/api/me/api-keys', {
        method: 'POST',
        headers: h(ownerA),
        body: JSON.stringify({ name: 'acme-key' }),
      });
      const view = await s.app.request('/api/tenant/api-keys', { headers: h(ownerA) });
      expect(view.status).toBe(200);
      const body = (await view.json()) as { keys: { name: string }[] };
      expect(body.keys.map((k) => k.name)).toEqual(['acme-key']);

      // A plain member of Acme is refused (requireTenantAdmin).
      s.tenants.addMember(acme.id, memberC.id, 'member');
      const asMember = await s.app.request('/api/tenant/api-keys', { headers: h(memberC) });
      expect(asMember.status).toBe(403);

      // Globex's owner sees only Globex's keys (none) — never Acme's (SC-C1 boundary).
      const asOther = await s.app.request('/api/tenant/api-keys', { headers: h(ownerB) });
      expect(asOther.status).toBe(200);
      expect(((await asOther.json()) as { keys: unknown[] }).keys).toHaveLength(0);
    });

    it('FR-232: super-admin cannot remove the last owner; a co-owner is removable', async () => {
      const superAdmin = mkUser('root@danni.bg', 'admin');
      const last = await s.app.request(`/api/admin/tenants/${acme.id}/members/${ownerA.id}`, {
        method: 'DELETE',
        headers: h(superAdmin),
      });
      expect(last.status).toBe(400);
      expect(s.tenants.ownerCount(acme.id)).toBe(1);

      const coOwner = mkUser('co@acme.test');
      s.tenants.addMember(acme.id, coOwner.id, 'owner');
      const rm = await s.app.request(`/api/admin/tenants/${acme.id}/members/${coOwner.id}`, {
        method: 'DELETE',
        headers: h(superAdmin),
      });
      expect(rm.status).toBe(200);
      expect(s.tenants.membershipOf(acme.id, coOwner.id)).toBeNull();
    });

    it('FR-232: super-admin member-add is insert-only (re-adding a member is a 409)', async () => {
      const superAdmin = mkUser('root@danni.bg', 'admin');
      const again = await s.app.request(`/api/admin/tenants/${acme.id}/members`, {
        method: 'POST',
        headers: h(superAdmin),
        body: JSON.stringify({ email: 'a@acme.test', role: 'member' }),
      });
      expect(again.status).toBe(409);
      expect(s.tenants.membershipOf(acme.id, ownerA.id)?.role).toBe('owner'); // role untouched
    });

    it('super-admin member-add with an unknown email 404s', async () => {
      const superAdmin = mkUser('root@danni.bg', 'admin');
      const res = await s.app.request(`/api/admin/tenants/${acme.id}/members`, {
        method: 'POST',
        headers: h(superAdmin),
        body: JSON.stringify({ email: 'ghost@nowhere.test', role: 'member' }),
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    });

    it('a non-admin cannot reach super-admin member seeding', async () => {
      const res = await s.app.request(`/api/admin/tenants/${globex.id}/members`, {
        method: 'POST',
        headers: h(ownerA),
        body: JSON.stringify({ email: 'a@acme.test', role: 'owner' }),
      });
      expect(res.status).toBe(403);
    });
  });

  // Spec 036 (FR-180..184): owner protection on every member-mutation path. SC-1: no sequence of
  // /api/tenant calls by a non-owner admin changes an owner's role; SC-2: an org never reaches zero
  // owners; SC-3: adding a genuinely new member keeps working (covered by the SC-C1 test above).
  describe('org role integrity (spec 036)', () => {
    const patchRole = (caller: UserRow, targetId: string, role: string) =>
      s.app.request(`/api/tenant/members/${targetId}`, {
        method: 'PATCH',
        headers: h(caller),
        body: JSON.stringify({ role }),
      });

    it('FR-180: an org admin re-adding the owner gets 409 and the role is unchanged', async () => {
      s.tenants.addMember(acme.id, memberC.id, 'admin');
      const res = await s.app.request('/api/tenant/members', {
        method: 'POST',
        headers: h(memberC),
        body: JSON.stringify({ email: 'a@acme.test', role: 'member' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('already_member');
      expect(s.tenants.membershipOf(acme.id, ownerA.id)?.role).toBe('owner');
    });

    it('FR-180: re-adding any existing member (not just the owner) is a 409', async () => {
      s.tenants.addMember(acme.id, memberC.id, 'member');
      const res = await s.app.request('/api/tenant/members', {
        method: 'POST',
        headers: h(ownerA),
        body: JSON.stringify({ email: 'c@acme.test', role: 'admin' }),
      });
      expect(res.status).toBe(409);
      expect(s.tenants.membershipOf(acme.id, memberC.id)?.role).toBe('member');
    });

    it('FR-181: a non-owner admin PATCHing an owner to member gets 403, role unchanged', async () => {
      s.tenants.addMember(acme.id, memberC.id, 'admin');
      const res = await patchRole(memberC, ownerA.id, 'member');
      expect(res.status).toBe(403);
      expect(s.tenants.membershipOf(acme.id, ownerA.id)?.role).toBe('owner');
    });

    it('FR-182: the sole owner cannot demote themselves (org never ownerless)', async () => {
      const res = await patchRole(ownerA, ownerA.id, 'member');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('last_owner');
      expect(s.tenants.ownerCount(acme.id)).toBe(1);
    });

    it('an owner CAN demote a co-owner when another owner remains', async () => {
      const coOwner = mkUser('co@acme.test');
      s.tenants.addMember(acme.id, coOwner.id, 'owner');
      const res = await patchRole(ownerA, coOwner.id, 'admin');
      expect(res.status).toBe(200);
      expect(s.tenants.membershipOf(acme.id, coOwner.id)?.role).toBe('admin');
      expect(s.tenants.ownerCount(acme.id)).toBe(1);
    });

    it('ownership transfer: promote a member to owner, then the old owner is demotable', async () => {
      s.tenants.addMember(acme.id, memberC.id, 'admin');
      const promote = await patchRole(ownerA, memberC.id, 'owner');
      expect(promote.status).toBe(200);
      const demote = await patchRole(memberC, ownerA.id, 'member');
      expect(demote.status).toBe(200);
      expect(s.tenants.membershipOf(acme.id, ownerA.id)?.role).toBe('member');
      expect(s.tenants.membershipOf(acme.id, memberC.id)?.role).toBe('owner');
      expect(s.tenants.ownerCount(acme.id)).toBe(1);
    });

    it('normal flows still work: add member 201, patch member→admin 200, delete 200', async () => {
      const add = await s.app.request('/api/tenant/members', {
        method: 'POST',
        headers: h(ownerA),
        body: JSON.stringify({ email: 'c@acme.test' }),
      });
      expect(add.status).toBe(201);
      const patch = await patchRole(ownerA, memberC.id, 'admin');
      expect(patch.status).toBe(200);
      expect(s.tenants.membershipOf(acme.id, memberC.id)?.role).toBe('admin');
      const del = await s.app.request(`/api/tenant/members/${memberC.id}`, {
        method: 'DELETE',
        headers: h(ownerA),
      });
      expect(del.status).toBe(200);
      expect(s.tenants.membershipOf(acme.id, memberC.id)).toBeNull();
    });

    it('PATCHing a non-member still 404s', async () => {
      const res = await patchRole(ownerA, 'no-such-user', 'admin');
      expect(res.status).toBe(404);
    });
  });
});
