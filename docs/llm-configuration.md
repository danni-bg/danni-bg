# LLM provider configuration (global + per-organization)

The chat's language model is resolved **per request** from runtime settings, so changes apply without
a restart. Resolution order (`apps/explorer-api/src/admin/resolve-default.ts` `resolveServerDefault`):

```
tenant override  →  global setting  →  EXPLORER_DEFAULT_* env
   (the caller's ACTIVE org)   (platform_settings 'global' row)   (deployment fallback)
```

The setting shape (`llmSettingSchema`) is `{ kind: 'openai-compatible' | 'anthropic', model, baseUrl?,
apiKey? }`. The API key is **write-only over the wire** — masked on read, kept on empty write, never
logged, and never leaked across tenants.

## Global default

Two equivalent ways to set the platform-wide default:

- **Env (deployment)** — `EXPLORER_DEFAULT_PROVIDER` / `_MODEL` / `_BASE_URL` in the manifest + the
  secret `EXPLORER_DEFAULT_API_KEY` (from the secret backend). This is the single-source-of-truth path:
  the key lives only in the secret store, so a rotation can't be shadowed by a stale copy. Used when no
  `platform_settings 'global'` row exists.
- **Admin API** — `GET/PUT /api/admin/settings` (super-admin). A `PUT` writes a `global`
  `platform_settings` row that **overrides the env**. Prefer env for the global default; if you set it
  here, use the live key (a stale DB key silently shadowing a good env key is a classic outage).

## Per-organization override

Each org can point at its own model / provider / key. The org's setting **wins over the global** for
any request made while that org is the caller's active org.

- **Org admin** — `GET/PUT /api/tenant/settings` (`requireTenantAdmin`). The overridable set is an
  explicit allowlist — **the LLM provider + `defaultTokenLimit` only** (`TENANT_OVERRIDABLE_KEYS`).
  Per field: a value sets the override, `null` clears it (falls back to global), omission leaves it.
  The LLM `apiKey` is write-only; an empty/omitted key keeps the org's OWN existing key and **never
  inherits the global secret**. A tenant-facing read shows only `apiKeyConfigured` for an inherited
  provider — never another tenant's or the global key or a hint of it (isolation invariant, spec 042
  FR-243).
- **Super-admin** — `GET /api/admin/tenants/:id/settings` views any org's overrides;
  `DELETE /api/admin/tenants/:id/settings` clears them (the recovery path).

### What is NOT per-org

Platform toggles (`chatEnabled`) and the API rate/quota knobs (`apiRate*` / `apiQuota*`) are
**deployment-global** — a per-tenant write of those is rejected `400` and writes nothing. Only the LLM
provider and the default token limit are tenant-overridable.

## Onboarding a real org (typical flow)

1. Create the org (super-admin `POST /api/admin/tenants`) and add the owner
   (`POST /api/admin/tenants/:id/members`).
2. The owner/admin switches into the org (`POST /api/tenant/switch`) and sets the org's model:
   ```http
   PUT /api/tenant/settings
   { "llm": { "kind": "openai-compatible", "model": "…", "baseUrl": "…", "apiKey": "…" } }
   ```
3. From then on, that org's chat turns use its own model + key; its keys/sessions/usage are
   attributed to the org (specs 029/041). Other orgs are unaffected and inherit the global default.

## Current acceptance state

The **global** default is driven from **env** (`EXPLORER_DEFAULT_*` → DeepSeek `deepseek-v4-pro`, key
from the secret backend); there is intentionally **no `global` `platform_settings` row**, so the admin
global-settings LLM panel reads blank while chat still runs from env. No per-org overrides are set
(only the `default` org exists). To manage the global via the UI instead, set it under
`/api/admin/settings` with the live key.
