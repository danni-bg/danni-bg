# Spec 064 — Tenant self-service & organization console

## Context

Multi-tenancy (spec 029) and its whole control plane — per-tenant keys, usage, settings
(042), owner-protected membership (036), active-org switching (041) — are built, but two
customer-facing pieces are missing, so tenants can only be administered by a super-admin over
curl/MCP/CLI:

1. **Org creation is super-admin-only** (`POST /api/admin/tenants`). A regular user cannot
   create their own organization — every self-registered user is auto-joined to the `default`
   org and stuck there.
2. **There is no web console** for org/member management. The org-self routes (`/api/tenant/*`)
   exist but nothing in the SPA drives them.

This spec closes both: a human can **create their own organization** (becoming its owner) and
**manage it from the account page** — no super-admin in the loop.

Out of scope (deferred, unchanged): billing/plans (`tenants.plan` stays inert, spec 040 FR-224);
org creation during Kratos registration (orgs are created post-login); an `admin_mcp`
`create_tenant` tool; inviting users who have never signed in (an invitee must already have an
account, per the existing `/members` contract).

## Functional requirements

### Self-serve org creation (backend)

- **FR-500** `POST /api/tenant` (human-only, `requireHuman`) creates a new organization, makes
  the caller its **`owner`**, and **switches** the caller's active org to it — then returns the
  created org (`{id, name, slug, role: 'owner'}`, 201). An API-key caller is rejected 403 (a
  machine credential can never create an org), consistent with the rest of `/api/tenant/*`.
- **FR-501** The slug is **derived from the name** and URL-safe: lowercased, whitespace collapsed
  to `-`, characters outside `[letter, digit, -]` dropped (Cyrillic letters are kept, matching the
  dataset/publisher slug convention). On collision it is de-duplicated with a numeric suffix
  (`-2`, `-3`, …). An empty derived slug falls back to a stable generated token.
- **FR-502** A user may **own at most `MAX_ORGS_OWNED_PER_USER`** organizations (anti-abuse).
  Exceeding it fails `403 org_limit` and creates nothing.
- **FR-503** The name is validated (trimmed, non-empty, ≤ 80 chars); invalid → `400`. The stored
  name is the trimmed value.
- **FR-504** `GET /api/tenant/memberships` is **enriched** to carry each org's `name` + `slug`
  (not just `tenantId` + `role`), so the console can render a labelled org list in one call.
- **FR-505** Creation is **atomic** (spec 052): the tenant row and the owner membership are written
  in one transaction — a fault mid-creation leaves no orphan org and no ownerless org.

### Organization console (frontend)

- **FR-510** An **“Организации”** section on the account page (`/auth/settings`) lists the caller's
  organizations (name, role, an **active** indicator), lets them **create** a new org (name → owner
  → active), and **switch** the active org (any non-active membership).
- **FR-511** For an org where the caller is **owner/admin**, the section manages **members**: list
  (email + role), **add by email** (member/admin), **change role**, and **remove** — surfacing the
  spec-036 protections as human-readable errors (`already_member` 409, `last_owner` 400, owner-only
  ownership changes 403, self-removal 400).
- **FR-512** The console is **human-only** and error-honest: it reuses the shared `request` helper
  and the `StatusMessage` (`Loading`/`ErrorState`) affordances (spec 057) — a load failure shows a
  retry, a mutation failure shows the server's reason and keeps the form.
- **FR-513** All calls go through **one typed facade** `lib/tenantApi.ts` over `request` (spec 057
  FR-400), unit-tested to 100% like `meApi`. The `.tsx` sections are covered by typecheck + the
  production build (matching the account page's existing state — it has no e2e today); a Playwright
  e2e for `/auth/settings` is a follow-up, not a blocker for this spec.

## Success criteria

- **SC-1** A signed-in user with no admin rights can create an org, is immediately its owner, and
  can add/manage members — with no super-admin action. The `default` org and every other tenant are
  unaffected (isolation, spec 029 SC-C1).
- **SC-2** The org-owner cap and name validation are enforced; a failed create writes nothing.
- **SC-3** The super-admin surfaces (`/api/admin/tenants`) and every spec-036 invariant are
  unchanged — self-service is additive.
- **SC-4** 100% line + function coverage (`bun run coverage`); typecheck + the e2e gate stay green.
