# Spec 067 — Organization profile

## Context

An organization (spec 029/064/065) had only a name + slug — no way to describe itself or be contacted.
This adds an **org profile**: a contact email, a description, and a picture, set by the org's
owners/admins. Analogous to the user profile (avatar + Kratos traits), and the picture reuses the same
client-side resize → `data:` URL flow as `users.avatar_url` (spec 022) so the stored blob stays tiny.

## Data model (migration 023)

Additive nullable columns on `tenants` — every existing org keeps `null` (no profile), no behavior
change:

- **`contact_email`** TEXT — a public contact address.
- **`description`** TEXT — free text (≤ 2000 chars).
- **`avatar_url`** TEXT — the picture as a resized `data:image` URL (same cap/shape as the user avatar).

## Functional requirements

- **FR-500** `PUT /api/tenant/profile` (`requireTenantAdmin`, human-only) sets the active org's
  `contactEmail` (valid email or `null`) + `description` (`≤ 2000` chars or `null`). Invalid email → `400`.
- **FR-501** `PUT /api/tenant/avatar` (`requireTenantAdmin`) sets/clears the org picture — a
  `data:image/(png|jpeg|webp);base64,` URL capped at 600 000 chars (mirrors `/api/me/avatar`), or `null`.
  A non-data-URL → `400`.
- **FR-502** `GET /api/tenant` returns the profile (`contactEmail`, `description`, `avatarUrl`) to any
  member — it's an org identity, not a secret. Writes remain owner/admin-only (a plain member → `403`).
- **FR-503** The Organizations console (spec 064) gains an **org-profile editor** for owner/admins:
  the picture (upload → resize → `data:` URL, with remove), the contact email, and the description.
  The resize helper is shared with the user avatar (`lib/image.ts`). `tenantApi` gains `setOrgProfile`
  + `setOrgAvatar`, unit-tested to 100%.

## Success criteria

- **SC-1** An org owner/admin sets a picture, contact email, and description; every member sees them on
  `GET /api/tenant`; a plain member cannot write them.
- **SC-2** Email + avatar shape are validated server-side; existing orgs (incl. `default`) are
  unaffected (all-null profile).
- **SC-3** 100% line + function coverage; typecheck + SPA build + the e2e gate stay green.
