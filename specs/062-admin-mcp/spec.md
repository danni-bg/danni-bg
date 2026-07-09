# Spec 062 — Administrative MCP server

## Problem

Spec 061 gave read consumers a hosted MCP door (`/mcp`, API-key auth, `read` scope). There is no
equivalent for **platform management** — API keys, tenants, members, and runtime settings can only be
managed through the REST admin surface (specs 019/027/029/036/041/042). We want an MCP door for
administration so an authorized human (or an agent acting on their behalf) can manage the platform
conversationally — **without inventing a second authorization model** and **without weakening the
machine-credential trust boundary** (spec 038: a leaked machine key must never touch identity/keys).

## Principle — a thin, role-guarded projection (not a new authz layer)

The admin MCP is a projection of the *existing* admin surface: each tool wraps the SAME repo/route
logic behind the SAME guard (`requireHuman` / `requireTenantAdmin` / `requireAdmin`). No parallel
authorization, no reimplemented invariants. This is the spec-053 parity discipline applied to writes —
a behavior change in a guarded route changes the MCP tool identically, enforced by a parity test.

## Functional requirements

### Authorization — user-delegated, never a machine key

- **FR-460** `/admin/mcp` authenticates via **user-delegated MCP OAuth** (the MCP authorization spec).
  The resolved principal carries the app `user`, `role` (`admin`|`user`), and active `tenant` — the
  SAME context `requireAuth` builds for REST. A machine API key (`dnk_live_…`) is **rejected `403`** on
  `/admin/mcp`: administration is human-delegated only, preserving spec-038 (machine keys never manage
  identity/keys/tenants). This is why MCP OAuth — deferred as nice-to-have for the read server — is a
  **hard prerequisite** here.
- **FR-461** Tools enforce the caller's role EXACTLY as REST does: `requireTenantAdmin` tools operate
  only on the caller's **active org** (a cross-org target is `403`/`404`); `requireAdmin` tools require
  super-admin; `requireHuman` tools (own keys) require a human principal. No tool broadens what its REST
  counterpart allows.

### Surface + wiring

- **FR-462** A SEPARATE endpoint (`/admin/mcp`) and a separate `buildAdminMcpServer`, distinct from the
  read `/mcp` (061) — different auth, blast radius, and enable/disable. Mounted only when
  `AppContext.adminMcp` is wired; absent → `404`. The read server is unchanged.
- **FR-463** Per-request identity flows into the tools: the gate resolves `{user, role, tenant}` and
  passes it to each tool handler via the SDK callback's `extra.authInfo`; tools read it to scope +
  guard. Stateless per request (as 061).

### Tools (tiered — each wraps existing logic)

- **FR-464** *human-self* (`requireHuman`): `list_my_api_keys`, `create_api_key` (returns the plaintext
  ONCE), `revoke_api_key`.
- **FR-465** *org-admin* (`requireTenantAdmin`, active org): `list_members`, `add_member`,
  `set_member_role`, `remove_member`; `get_tenant_settings`, `set_tenant_settings` (LLM provider +
  `defaultTokenLimit` — the spec-042 overridable allowlist; `apiKey` write-only); `list_tenant_api_keys`,
  `tenant_usage`.
- **FR-466** *super-admin* (`requireAdmin`): `list_tenants`, `create_tenant`, `add_tenant_member` /
  `remove_tenant_member` (any org, ≥1-owner invariant), `set_user_role`, `get_global_settings`,
  `set_global_settings`, `usage_rollup`, `set_api_key_quota`.
- **FR-467** Every tool wraps the existing repo/route logic — no reimplementation. A **parity test**
  asserts each MCP tool and its REST counterpart produce the same effect AND the same guard rejections.

### Safety — this surface MUTATES, and an LLM drives it

- **FR-470** Destructive/irreversible tools (`revoke_api_key`, `remove_member`, `remove_tenant_member`,
  an owner/role demotion, a tenant delete if added) require CONFIRMATION via MCP **elicitation** before
  executing: the server elicits an explicit confirm from the client/user; a declined/absent confirm
  aborts with NO change. Read-admin + additive tools do not elicit.
- **FR-471** Tools inherit the existing invariants unchanged — owner protection, ≥1-owner, insert-only
  `addMember` (spec 036), the tenant-overridable allowlist + secret isolation (spec 042) — so their
  `400`s surface through the tool; no invariant is re-implemented or bypassable via MCP.
- **FR-472** Every MUTATING admin action writes an **audit record** (actor `user`+`role`, tool/route,
  target, argument summary, outcome) to a new `admin_audit` trail via a SHARED helper the equivalent
  REST mutations also call — so the trail is complete regardless of which door was used. A super-admin
  read tool (`list_audit`) exposes it.
- **FR-473** Read-admin and write-admin tools are separately gated — a session may be opened read-only
  (write tools absent from `tools/list`) so "let the agent inspect usage" cannot also mutate.
- **FR-474** `/admin/mcp` is rate-limited + metered like the data/chat surfaces (spec 028), and a
  kill-switch toggle (resolved tenant→global, spec 042/056) can disable it without a redeploy.

## Non-goals / deferred

- The read `/mcp` (spec 061) is untouched.
- Bulk/migration admin ops (batch member import, tenant cloning) — later.
- A web UI for the audit trail — this spec adds the data model + a read tool only.

## Dependencies

- **MCP OAuth** — authorization-server metadata (discovery), token issuance, and per-request token
  validation resolving the app principal. NEW, and the gating prerequisite; the read server's API-key
  auth does not carry over. Reuses the SDK + Streamable-HTTP transport pattern from 061 and the guards
  from 019/027/029/036/038/041/042.

## Testing (Constitution VIII — 100%)

- **Guard matrix**: each tool × { anon, machine-key, human non-admin, org-admin own-org, org-admin
  cross-org, super-admin } → allow/deny parity with the REST route.
- **Effect parity**: each MCP tool's effect == its REST route's effect (shared logic).
- **Elicitation**: a destructive tool aborts on a declined/absent confirm (state unchanged) and
  executes on confirm.
- **Invariants**: ≥1-owner / owner-protection / allowlist rejections surface through the tool.
- **Audit**: every mutation (via MCP or REST) writes a record; `list_audit` returns it.
- **Auth**: a valid delegated OAuth token resolves the right principal+role; a `dnk_live_` key is
  rejected `403`; the anon path is `401`.
