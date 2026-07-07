# Feature Specification: Tenant activation (reachable non-default orgs)

**Feature Branch**: `041-tenant-activation`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the
spec-029 control plane cannot leave the `default` tenant — a created org can never gain members,
keys, sessions, or usage.

## Overview

Spec 029 shipped tables, guards, and tenant columns, but the *active* tenant is hard-wired to a
user's oldest membership — which is always the auto-joined `default` org. There is no way to switch
orgs, and every membership-granting path operates on the caller's active (= default) org. The result:
a super-admin can create an org via `/api/admin/tenants`, and that org is permanently empty — no
member, no key, no session, no usage row can ever attribute to it. Multi-tenancy exists on disk but
not in behavior.

Single responsibility: **a non-default org is actually reachable — users can join it, select it, and
have their keys, sessions, and usage attribute to it.** This fulfils spec 029's FR-128 ("a request
resolves an active org") and FR-132 (org admins manage members + keys) beyond the default org.

## Finding & evidence

- **Active tenant = oldest membership, always** — `TenantsRepo.primaryMembership` returns
  `membershipsOf(userId)[0]` ordered by `created_at` (`src/store/repos/tenants.ts:104-116`), and
  `requireAuth` sets the request tenant from `ensureMembership` (`tenants.ts:123-128`;
  `apps/explorer-api/src/middleware/require-auth.ts:122-126`). Since `ensureMembership` auto-joins
  every new user to `default` first, the oldest membership is always `default`. No switch endpoint
  exists anywhere under `apps/explorer-api/src/routes/`.
- **Membership grants are trapped in the caller's active org** — `POST /api/tenant/members` adds to
  `c.get('tenant').id` (`apps/explorer-api/src/routes/tenant.ts:56-74`, write at line 72), i.e. the
  default org. Super-admin routes only **list/create** orgs (`apps/explorer-api/src/routes/admin.ts:157-179`)
  — nothing adds a member to an arbitrary org. So a non-default org can never gain its first member.
- **Everything attributes to default** — human chat turns take the context tenant
  (`routes/chat.ts:76`, recorded at `241-252`); keys are created with `tenantId: c.get('tenant').id`
  (`routes/me.ts:79-81`). Both are always `default` for humans. (API-key requests do already act
  within the key's own tenant — `require-auth.ts:77` — but no key can be created outside default.)
- **Dead org-admin key view** — `ApiKeyRepo.listForTenant` (`src/store/repos/api-keys.ts:136-143`)
  has no calling route; the FR-132 "org admins manage their keys" surface does not exist.

## Requirements

- **FR-230**: A user's active org MUST be an explicit, **persisted per-user selection** (validated
  against their memberships), not the oldest membership. `requireAuth` resolves it; when unset or no
  longer a membership, it falls back to the primary membership (today's behavior). API-key requests
  keep using the key's own `tenant_id` — a key is tenant-bound and needs no switching.
- **FR-231**: A human-session endpoint MUST let a user switch their active org to any org they are a
  member of (and see the choice reflected in `GET /api/tenant`); switching to a non-membership org is
  rejected.
- **FR-232**: A super-admin MUST be able to add/remove a member (with an org role) on **any** org via
  `/api/admin/tenants/:id/members`, so a freshly created org can be seeded with its first owner. The
  self-service `POST /api/tenant/members` behavior (active org only) is unchanged.
- **FR-233**: New API keys, chat sessions, and token/api usage MUST attribute to the caller's active
  org at creation/turn time. Existing rows keep their tenant; a key never migrates orgs after
  creation.
- **FR-234**: Org admins MUST have a tenant-scoped key view (`GET /api/tenant/api-keys` backed by the
  existing `listForTenant`) — views only, never hashes or secrets, consistent with spec 027.
- **FR-235**: A user who never switches MUST observe zero behavior change: active org stays
  `default`, all attribution unchanged (protects spec 029 SC-C2).

## Success criteria

- **SC-1**: End-to-end without SQL: super-admin creates an org, adds user U as `owner`; U switches to
  it; U's new key, chat session, and usage rows carry that org's `tenant_id`; the org shows up in
  `/api/admin/api-usage` `byTenant`.
- **SC-2**: Switching to an org the user does not belong to returns 403/404 and leaves the active
  selection unchanged.
- **SC-3**: An org admin sees exactly their org's keys via the new view; a member (non-admin) and a
  member of another org are refused (spec 029 SC-C1 boundary test).
- **SC-4**: The full existing test suite passes with no fixture changes for default-org users
  (FR-235).

## Out of scope / dependencies

- **Invitation flow** (inviting an email that has no account yet, with email delivery) — explicitly
  deferred; today's "invitee must have signed in once" (`routes/tenant.ts:67-70`) stands. Mail
  substrate is spec **037**.
- Per-tenant settings resolution — spec **042** (depends on this spec's active-org mechanism).
- Quota/rate principal semantics — spec **040**. Org role escalation rules — spec **036**.
- Builds on spec **029** (tables/guards) and **027** (keys); fulfils 029 FR-128/FR-132.
