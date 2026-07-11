import { afterEach, describe, expect, it } from 'bun:test';
import {
  addOrgMember,
  createOrg,
  getActiveOrg,
  listMemberships,
  removeOrgMember,
  setOrgMemberRole,
  switchOrg,
} from './tenantApi.ts';

// tenantApi is a thin typed facade over the shared `request` helper (spec 064 FR-513); stub the fetch
// layer like meApi.test.ts and assert each call's method/URL/body/credentials + shape unwrapping.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url?: string;
  init?: RequestInit;
}

function stub(cap: Captured, body: unknown, ok = true, status = ok ? 200 : 500): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    cap.url = typeof input === 'string' ? input : input.toString();
    cap.init = init;
    return {
      ok,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    } as unknown as Response;
  }) as typeof fetch;
}

describe('tenantApi — cookie-authed org self-service', () => {
  it('listMemberships unwraps the { memberships } envelope', async () => {
    const cap: Captured = {};
    stub(cap, { memberships: [{ tenantId: 't1', name: 'Acme', slug: 'acme', role: 'owner' }] });
    const out = await listMemberships();
    expect(out).toEqual([{ tenantId: 't1', name: 'Acme', slug: 'acme', role: 'owner' }] as never);
    expect(cap.url).toBe('/api/tenant/memberships');
    expect(cap.init?.method).toBe('GET');
    expect(cap.init?.credentials).toBe('include');
  });

  it('getActiveOrg GETs the active org', async () => {
    const cap: Captured = {};
    stub(cap, {
      id: 't1',
      name: 'Acme',
      slug: 'acme',
      plan: 'default',
      role: 'admin',
      members: [],
    });
    const out = await getActiveOrg();
    expect(out.role).toBe('admin');
    expect(cap.url).toBe('/api/tenant');
    expect(cap.init?.method).toBe('GET');
  });

  it('createOrg POSTs the name', async () => {
    const cap: Captured = {};
    stub(cap, { id: 't2', name: 'New', slug: 'new', role: 'owner' });
    const out = await createOrg('New');
    expect(out.slug).toBe('new');
    expect(cap.url).toBe('/api/tenant');
    expect(cap.init?.method).toBe('POST');
    expect(cap.init?.body).toBe(JSON.stringify({ name: 'New' }));
  });

  it('switchOrg POSTs the target tenant id', async () => {
    const cap: Captured = {};
    stub(cap, { ok: true, id: 't1', role: 'member' });
    const out = await switchOrg('t1');
    expect(out.ok).toBe(true);
    expect(cap.url).toBe('/api/tenant/switch');
    expect(cap.init?.body).toBe(JSON.stringify({ tenantId: 't1' }));
  });

  it('addOrgMember POSTs email + role, and omits an absent role', async () => {
    const cap: Captured = {};
    stub(cap, { ok: true });
    await addOrgMember('x@y.z', 'admin');
    expect(cap.url).toBe('/api/tenant/members');
    expect(cap.init?.method).toBe('POST');
    expect(cap.init?.body).toBe(JSON.stringify({ email: 'x@y.z', role: 'admin' }));
    await addOrgMember('a@b.c'); // no role → omitted
    expect(cap.init?.body).toBe(JSON.stringify({ email: 'a@b.c' }));
  });

  it('setOrgMemberRole PATCHes the member role', async () => {
    const cap: Captured = {};
    stub(cap, { ok: true });
    await setOrgMemberRole('u1', 'owner');
    expect(cap.url).toBe('/api/tenant/members/u1');
    expect(cap.init?.method).toBe('PATCH');
    expect(cap.init?.body).toBe(JSON.stringify({ role: 'owner' }));
  });

  it('removeOrgMember DELETEs the member', async () => {
    const cap: Captured = {};
    stub(cap, { ok: true });
    await removeOrgMember('u1');
    expect(cap.url).toBe('/api/tenant/members/u1');
    expect(cap.init?.method).toBe('DELETE');
  });
});
