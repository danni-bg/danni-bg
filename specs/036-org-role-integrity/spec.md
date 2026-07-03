# Feature Specification: Org role integrity (owner protection on every path)

**Feature Branch**: `036-org-role-integrity`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the spec-029
member-management routes let a non-owner org admin demote the owner (via add-member upsert or PATCH),
and an org can be left ownerless.

## Overview

Spec 029's tenant self-management guards the owner role only at two spots: PATCH blocks a non-owner
from GRANTING owner, and DELETE blocks removing the last owner. Two paths slip through: POST /members
is an upsert (`ON CONFLICT … DO UPDATE SET role`), so an org admin "re-adding" the owner with
`role: member` silently strips ownership; and PATCH only owner-gates the new role, not the target's
current role, so an admin can demote an owner — including the last one, leaving the org ownerless.
This spec makes role authorization uniform: add is insert-only, owner-targeting changes need an owner
caller, and last-owner protection applies to every demotion path.

Single responsibility: **org role changes follow explicit authorization rules on every path.**

## Finding & evidence

- `src/store/repos/tenants.ts:71-78` — `addMember` is
  `INSERT … ON CONFLICT(tenant_id, user_id) DO UPDATE SET role = excluded.role`: adding an existing
  member is a silent role overwrite.
- `apps/explorer-api/src/routes/tenant.ts:56-74` — POST `/api/tenant/members` (behind
  `requireTenantAdmin`, so any org admin) accepts `role: admin|member` (body schema lines 12-15) and
  calls `addMember` (line 72). Combined with the upsert: an org admin re-adds the owner's email with
  `role: member` → owner demoted, no owner check, 201.
- `apps/explorer-api/src/routes/tenant.ts:89-94` — PATCH owner-gates only GRANTING `owner`; setting an
  owner's role to `admin`/`member` (line 95, `setMemberRole`) is allowed for any org admin, i.e. a
  non-owner can demote an owner.
- `apps/explorer-api/src/routes/tenant.ts:113-121` — last-owner protection exists only on DELETE;
  PATCH (and the POST upsert) can demote the sole owner, leaving the org with zero owners — after
  which owner-gated actions (ownership transfer) are permanently unreachable for that org.

## Requirements

- **FR-180**: `TenantsRepo.addMember` (as used by member-management) MUST be insert-only: adding a
  user who is already a member of the tenant MUST NOT change their role. POST `/api/tenant/members`
  MUST return 409 (`already_member`) in that case. (Idempotent bootstrap paths — `ensureMembership`,
  default-tenant backfill — keep their semantics but MUST NOT overwrite an existing role either.)
- **FR-181**: Any role change whose TARGET currently holds `owner` MUST require an `owner` caller —
  on PATCH and on every other mutation path (add, future bulk/import paths). A non-owner org admin
  attempting it gets 403. Granting `owner` stays owner-only (existing behavior).
- **FR-182**: Every path that would demote an owner (PATCH role change; DELETE already covered) MUST
  refuse when the target is the tenant's LAST owner (400, `last_owner`). An org can never reach zero
  owners through the API.
- **FR-183**: Super-admin org management (`/api/admin/tenants`, spec 029) MUST be reviewed against the
  same invariant: whatever member/role mutations it exposes may bypass the owner-CALLER rule (a
  platform admin outranks org owners) but MUST NOT violate the zero-owner invariant (FR-182).
- **FR-184**: Authorization tests MUST cover the matrix: admin re-adds owner → 409 + role unchanged;
  admin PATCHes owner→member → 403; owner demotes a co-owner → 200; sole owner demotes self → 400;
  owner transfers ownership then is demotable.

## Success criteria

- **SC-1**: No sequence of `/api/tenant` calls by a non-owner org admin changes any owner's role
  (property asserted by the FR-184 test matrix).
- **SC-2**: For every tenant, `COUNT(role='owner') >= 1` holds after any sequence of API mutations
  (attempted violations return 400/403 and leave the row unchanged).
- **SC-3**: Adding a genuinely new member (member or admin) still works with a 201 and the existing
  response shape; `ensureMembership` auto-join behavior is unchanged (spec 029 SC-C2 still holds).

## Out of scope / dependencies

- Builds on **spec 029** (tenants/membership, `requireTenantAdmin`). Invitation of not-yet-registered
  users, a self-serve "leave org" flow, and org deletion lifecycles stay out (029 deferred them).
- Identity-header spoofing that could impersonate an owner in the first place is **spec 034**.
