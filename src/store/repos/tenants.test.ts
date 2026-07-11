import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../migrate.ts';
import { DEFAULT_TENANT_ID, TenantsRepo } from './tenants.ts';
import { UsersRepo } from './users.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  const tenants = new TenantsRepo(db);
  const mkUser = (email: string, role: 'admin' | 'user' = 'user') =>
    users.findOrCreateByKratosId({ kratosIdentityId: `k-${email}`, email, createRole: role });
  return { db, users, tenants, mkUser };
}

describe('TenantsRepo (spec 029)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('migration creates a default tenant', () => {
    const def = s.tenants.get(DEFAULT_TENANT_ID);
    expect(def?.slug).toBe('default');
    expect(s.tenants.getBySlug('default')?.id).toBe(DEFAULT_TENANT_ID);
  });

  it('create + listAll with member counts', () => {
    const acme = s.tenants.create({ name: 'Acme', slug: 'acme', plan: 'pro' });
    const u = s.mkUser('a@acme.test');
    s.tenants.addMember(acme.id, u.id, 'owner');
    const all = s.tenants.listAll();
    const row = all.find((t) => t.id === acme.id);
    expect(row?.plan).toBe('pro');
    expect(row?.memberCount).toBe(1);
  });

  it('addMember is insert-only: re-adding never changes the role (spec 036 FR-180)', () => {
    const t = s.tenants.create({ name: 'T', slug: 't' });
    const u = s.mkUser('u@t.test');
    expect(s.tenants.addMember(t.id, u.id, 'owner')).toBe(true);
    expect(s.tenants.addMember(t.id, u.id, 'member')).toBe(false); // conflict → row untouched
    expect(s.tenants.membersOf(t.id)).toHaveLength(1);
    expect(s.tenants.membershipOf(t.id, u.id)?.role).toBe('owner');
  });

  it('ownerCount counts only owners of the given tenant (spec 036 FR-182)', () => {
    const t = s.tenants.create({ name: 'T', slug: 'oc' });
    const other = s.tenants.create({ name: 'O', slug: 'oc2' });
    expect(s.tenants.ownerCount(t.id)).toBe(0);
    s.tenants.addMember(t.id, s.mkUser('o1@t.test').id, 'owner');
    s.tenants.addMember(t.id, s.mkUser('a1@t.test').id, 'admin');
    s.tenants.addMember(other.id, s.mkUser('o2@t.test').id, 'owner');
    expect(s.tenants.ownerCount(t.id)).toBe(1);
  });

  it('setMemberRole + removeMember', () => {
    const t = s.tenants.create({ name: 'T', slug: 't2' });
    const u = s.mkUser('u2@t.test');
    s.tenants.addMember(t.id, u.id, 'member');
    expect(s.tenants.setMemberRole(t.id, u.id, 'owner')).toBe(true);
    expect(s.tenants.membershipOf(t.id, u.id)?.role).toBe('owner');
    expect(s.tenants.removeMember(t.id, u.id)).toBe(true);
    expect(s.tenants.membershipOf(t.id, u.id)).toBeNull();
  });

  it('ensureMembership joins the default tenant only when the user has none', () => {
    const u = s.mkUser('new@t.test');
    expect(s.tenants.primaryMembership(u.id)).toBeNull();
    const m = s.tenants.ensureMembership(u.id);
    expect(m.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(m.role).toBe('member');
    // Idempotent + does not change an existing primary membership.
    const acme = s.tenants.create({ name: 'Acme', slug: 'acme2' });
    s.tenants.addMember(acme.id, u.id, 'admin');
    expect(s.tenants.ensureMembership(u.id).tenantId).toBe(DEFAULT_TENANT_ID); // primary stays the default
  });

  it('membersOf joins identity; membershipsOf lists every tenant for a user', () => {
    const t1 = s.tenants.create({ name: 'One', slug: 'one' });
    const t2 = s.tenants.create({ name: 'Two', slug: 'two' });
    const u = s.mkUser('multi@t.test');
    s.tenants.addMember(t1.id, u.id, 'owner');
    s.tenants.addMember(t2.id, u.id, 'member');
    expect(s.tenants.membersOf(t1.id)[0]?.email).toBe('multi@t.test');
    expect(s.tenants.membershipsOf(u.id).map((m) => m.tenantId).sort()).toEqual(
      [t1.id, t2.id].sort(),
    );
  });

  // ── spec 064 (self-service) ────────────────────────────────────────────────────────────────────
  it('createOwned makes the caller the owner atomically (spec 064 FR-500/505)', () => {
    const u = s.mkUser('owner@x.test');
    const t = s.tenants.createOwned({ name: 'Мой Бизнес', slug: 'moi-biznes', ownerUserId: u.id });
    expect(t.name).toBe('Мой Бизнес');
    expect(s.tenants.membershipOf(t.id, u.id)?.role).toBe('owner');
    expect(s.tenants.ownerCount(t.id)).toBe(1);
  });

  it('ownedCount counts only the orgs a user owns (spec 064 FR-502)', () => {
    const u = s.mkUser('u@x.test');
    const owned = s.tenants.createOwned({ name: 'A', slug: 'a', ownerUserId: u.id });
    const other = s.tenants.create({ name: 'B', slug: 'b' });
    s.tenants.addMember(other.id, u.id, 'admin'); // admin, not owner → not counted
    expect(s.tenants.ownedCount(u.id)).toBe(1);
    expect(s.tenants.ownerCount(owned.id)).toBe(1);
  });

  it('uniqueSlug de-duplicates on collision (spec 064 FR-501)', () => {
    expect(s.tenants.uniqueSlug('free')).toBe('free'); // untaken → as-is
    s.tenants.create({ name: 'Taken', slug: 'taken' });
    expect(s.tenants.uniqueSlug('taken')).toBe('taken-2');
    s.tenants.create({ name: 'Taken2', slug: 'taken-2' });
    expect(s.tenants.uniqueSlug('taken')).toBe('taken-3');
  });

  it('membershipsDetailed carries each org name + slug (spec 064 FR-504)', () => {
    const u = s.mkUser('d@x.test');
    const t = s.tenants.createOwned({ name: 'Detailed Co', slug: 'detailed-co', ownerUserId: u.id });
    const rows = s.tenants.membershipsDetailed(u.id);
    expect(rows).toEqual([{ tenantId: t.id, name: 'Detailed Co', slug: 'detailed-co', role: 'owner' }]);
  });

  // ── spec 065 (org entitlements) ────────────────────────────────────────────────────────────────
  it('a fresh org defaults to legacy: null pool, BYOM off, no allocations', () => {
    const t = s.tenants.create({ name: 'E', slug: 'e' });
    expect(t.token_pool).toBeNull();
    expect(t.byom_enabled).toBe(0);
    expect(s.tenants.allocatedTokens(t.id)).toBe(0);
  });

  it('setPool + setByom are reflected on the row (spec 065 FR-600/601)', () => {
    const t = s.tenants.create({ name: 'E', slug: 'e2' });
    s.tenants.setPool(t.id, 1_000_000);
    s.tenants.setByom(t.id, true);
    const row = s.tenants.get(t.id);
    expect(row?.token_pool).toBe(1_000_000);
    expect(row?.byom_enabled).toBe(1);
    s.tenants.setPool(t.id, null); // back to legacy
    s.tenants.setByom(t.id, false);
    expect(s.tenants.get(t.id)?.token_pool).toBeNull();
    expect(s.tenants.get(t.id)?.byom_enabled).toBe(0);
  });

  it('member allowances: set/clear, allocatedTokens sums them, membersOf carries them (FR-610/611/612)', () => {
    const t = s.tenants.create({ name: 'E', slug: 'e3' });
    const alice = s.mkUser('alice@e.test');
    const bob = s.mkUser('bob@e.test');
    s.tenants.addMember(t.id, alice.id, 'owner');
    s.tenants.addMember(t.id, bob.id, 'member');
    expect(s.tenants.memberAllowance(t.id, alice.id)).toBeNull(); // no allocation yet
    expect(s.tenants.setMemberAllowance(t.id, alice.id, 500_000)).toBe(true);
    expect(s.tenants.setMemberAllowance(t.id, bob.id, 300_000)).toBe(true);
    expect(s.tenants.allocatedTokens(t.id)).toBe(800_000);
    expect(s.tenants.memberAllowance(t.id, alice.id)).toBe(500_000);
    expect(s.tenants.membersOf(t.id).find((m) => m.userId === bob.id)?.tokenLimit).toBe(300_000);
    // clearing an allocation drops it back out of the sum
    s.tenants.setMemberAllowance(t.id, bob.id, null);
    expect(s.tenants.allocatedTokens(t.id)).toBe(500_000);
    // setting a non-member is a no-op
    expect(s.tenants.setMemberAllowance(t.id, 'ghost', 1)).toBe(false);
  });
});
