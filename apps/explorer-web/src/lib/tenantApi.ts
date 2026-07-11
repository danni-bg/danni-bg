// Organization (tenant) self-service client (spec 064). A typed facade over the shared `request`
// helper (spec 057 FR-400) — every call is cookie-authed and human-only (an API-key caller 403s
// server-side). Types are defined here (not imported from the repo) so the web bundle never pulls
// `bun:sqlite` into its type graph (spec 059), matching how meApi declares `ApiKeyView`.

import { request } from './http.ts';

export type TenantRole = 'owner' | 'admin' | 'member';

/** One of the caller's org memberships, labelled (spec 064 FR-504). */
export interface OrgMembership {
  tenantId: string;
  name: string;
  slug: string;
  role: TenantRole;
}

/** A member of an org, as shown to org admins. `tokenLimit` = their reserved pool slice (spec 065). */
export interface OrgMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: TenantRole;
  tokenLimit: number | null;
}

/**
 * The caller's active org. `byomEnabled` + `myAllowance` are visible to any member; `members` + the
 * pool figures (`pool`/`allocated`/`unallocated`) are present only for an owner/admin (spec 065).
 */
export interface ActiveOrg {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: TenantRole;
  byomEnabled: boolean;
  myAllowance: number | null;
  members?: OrgMember[];
  pool?: number | null;
  allocated?: number;
  unallocated?: number | null;
}

export interface CreatedOrg {
  id: string;
  name: string;
  slug: string;
  role: TenantRole;
}

export async function listMemberships(): Promise<OrgMembership[]> {
  return (
    await request<{ memberships: OrgMembership[] }>('/api/tenant/memberships', { authed: true })
  ).memberships;
}

export function getActiveOrg(): Promise<ActiveOrg> {
  return request('/api/tenant', { authed: true });
}

export function createOrg(name: string): Promise<CreatedOrg> {
  return request('/api/tenant', { method: 'POST', body: { name }, authed: true });
}

export function switchOrg(
  tenantId: string,
): Promise<{ ok: boolean; id?: string; role?: TenantRole }> {
  return request('/api/tenant/switch', { method: 'POST', body: { tenantId }, authed: true });
}

export async function addOrgMember(email: string, role?: 'admin' | 'member'): Promise<void> {
  await request('/api/tenant/members', {
    method: 'POST',
    body: { email, ...(role ? { role } : {}) },
    authed: true,
  });
}

export function setOrgMemberRole(userId: string, role: TenantRole): Promise<void> {
  return request(`/api/tenant/members/${userId}`, {
    method: 'PATCH',
    body: { role },
    authed: true,
  });
}

export function removeOrgMember(userId: string): Promise<void> {
  return request(`/api/tenant/members/${userId}`, { method: 'DELETE', authed: true });
}

/** Set/clear a member's reserved token allowance within the org (spec 065; pool-model orgs only). */
export function setMemberAllowance(userId: string, limit: number | null): Promise<{ ok: boolean }> {
  return request(`/api/tenant/members/${userId}/allowance`, {
    method: 'PUT',
    body: { limit },
    authed: true,
  });
}
