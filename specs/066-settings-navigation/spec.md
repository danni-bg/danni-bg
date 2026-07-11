# Spec 066 — Settings navigation: a categorized, routed sidebar

## Context

Settings had accreted into two long single-column scrolls: the account page (`/auth/settings`,
`AccountPage`) stacked avatar · appearance · usage · organizations · API keys · profile/password/
passkeys (6 sections), and the super-admin page (`/admin/settings`, `SettingsPage`) stacked LLM
provider · platform toggles · per-user usage · org entitlements (4 more). A flat stack doesn't scale
and makes settings hard to find.

This introduces a **GitHub-style routed sidebar**: a persistent left nav of categories, each its own
deep-linkable route under `/auth/settings/*`, with the selected category rendered in the content pane.
Account categories are open; a gated **Платформа** group appears for super-admins in the same nav.

## Functional requirements

- **FR-500** A `SettingsLayout` shell renders a left sidebar + `<Outlet/>`; each category is a nested
  route under `/auth/settings`. `/auth/settings` redirects to `/auth/settings/profile`.
- **FR-501** Account categories (every signed-in user): **profile** (avatar + Kratos `profile` group),
  **security** (Kratos `password` + `passkey` groups), **appearance** (theme), **usage** (token usage),
  **api-keys**, **organizations** — one route + one nav entry each. `KratosSettingsSections` is
  parameterized by `groups` so profile ≠ security split cleanly from the one Kratos settings flow.
- **FR-502** Platform settings are a **separate page** (`/admin/settings`, super-admin only, the whole
  subtree gated by `RequireAdmin`) reusing the same `SettingsLayout` shell with its own **grouped** nav
  — group **Чат** (`llm`: provider + toggles) and group **Управление** (`usage`: per-user usage;
  `orgs`: pool + BYOM entitlements). Personal account settings and platform settings never share a nav.
  (Revised from the initial single-nav "Платформа group": platform is its own surface, like GitHub's
  personal-vs-org settings.)
- **FR-503** The old `AccountPage` + `SettingsPage` monoliths are deleted; their sections become
  route-mounted components (`ProfileSection`/`SecuritySection`/`AppearanceSection` +
  `SelfUsage`/`ApiKeys`/`Organizations`/`PlatformLlmSettings`/`AdminUsage`/`OrgEntitlements`).
- **FR-504** Back-compat: the old `/admin/settings` URL redirects (guarded) to
  `/auth/settings/admin/llm`; the header menu's "Платформа" link targets the new location. A non-admin
  hitting `/admin/settings` is still sent home.

## Success criteria

- **SC-1** Every prior section is reachable at its own deep-linkable URL; the sidebar highlights the
  active category and hides the platform group from non-admins.
- **SC-2** No behaviour change within a section — each is the same component as before, just routed.
- **SC-3** Frontend-only; the hygiene guard (spec 060) is updated to the routed structure, and the
  `us9-admin-settings` e2e follows the platform settings to their new URL. Typecheck + build + the
  full e2e gate stay green.
