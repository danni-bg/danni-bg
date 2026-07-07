# Ory identity stack (danni-bg)

Local Ory identity stack backing identity management + tiered users (spec
`specs/019-identity-and-settings/`). Kratos owns identities in its own Postgres; the
danni app keeps its data in SQLite.

**Single-port mode (default).** The Hono backend is self-contained: it serves the API +
SPA, **reverse-proxies `/kratos/*` to Kratos** on the same origin, and **validates the
Kratos session itself** (`/sessions/whoami`) for the gated routes (`/api/{chat,admin,auth}`).
So `http://localhost:8790` is a complete, standalone entry point and **Oathkeeper is
optional** — you only need Kratos (+ its Postgres + Mailpit).

Kratos's `serve.public.base_url` is `http://localhost:8790/kratos/`, so every browser-facing URL
it builds — flow actions, redirects, and the **recovery/verification magic links** — is on the
single-port origin and travels through the `/kratos` proxy. Clicking a recovery link
(`:8790/kratos/self-service/recovery?flow=…&token=…`) validates server-side and 303-redirects to
`:8790/auth/settings` with a session, so password reset completes entirely on `:8790`. Kratos's own
`:14433` is internal-only (proxy upstream + the server-side `whoami` call).

**Oathkeeper (optional).** If you front the stack with Oathkeeper, it validates the
session and injects `X-User-*` headers, which the backend trusts in preference to its own
whoami call. The compose file still includes it for that deployment style.

## Components & ports (14xxx/15xxx band — avoids the looper stack's 34xxx)

| Component        | Host port | Purpose                                  |
|------------------|-----------|------------------------------------------|
| Kratos public    | 14433     | proxy upstream + server-side whoami (not hit by the browser) |
| Kratos admin     | 14434     | identity admin API                       |
| Oathkeeper proxy | 14455     | access proxy for gated `/api/*`          |
| Oathkeeper api   | 14456     | health/rules                             |
| Kratos Postgres  | 15432     | Kratos DB (separate from danni SQLite)   |
| Mailpit UI + API | 14438     | catches verification/recovery emails     |

## Run (dev)

```bash
docker compose up -d                          # Kratos (+ Postgres + Mailpit); Oathkeeper optional
bun run explorer:api                          # Hono backend on :8790 — serves API + SPA + /kratos proxy
# either open http://localhost:8790 directly (built SPA), OR for HMR:
cd apps/explorer-web && bunx vite --port 5173 # → http://localhost:5173
```

Hono on `:8790` is a complete entry point (proxies `/kratos`, self-validates sessions). The Vite
dev server just proxies everything (`/api`, `/kratos`, `/healthz`) → `:8790` for hot-reload.

## Verify

```bash
curl -s http://localhost:14433/health/ready   # kratos
curl -s http://localhost:14456/health/alive   # oathkeeper
open http://localhost:14438                    # mailpit inbox (UI + JSON API at /api/v1/messages)
```

Mailpit replaces Mailslurper: it serves its web UI and JSON API on a single port (no separate
service port), so its UI can never read another local instance's mailbox. Kratos delivers over
plain SMTP (`smtp://mailpit:1025/?disable_starttls=true`, no auth — Kratos refuses to send
credentials over an unencrypted connection, and Mailpit accepts unauthenticated dev mail).

## Notes

- `kratos --dev` auto-runs migrations and relaxes some checks — **dev only**.
- Secrets in `kratos.yaml` (`cookie`, `cipher`) are placeholders — **rotate for any non-local deploy**.
- **Mailpit is dev-only** (spec 037). Recovery/verification emails carry account-takeover links, so a
  production deploy must set `COURIER_SMTP_CONNECTION_URI` to a real SMTP relay — required alongside
  `KRATOS_SECRETS_COOKIE`/`KRATOS_SECRETS_CIPHER` by the `check-secrets` gate, which also rejects
  Mailpit/localhost-shaped URIs. The prod overlay never starts Mailpit (no `:14438`).
- Identity schema is minimal (email + name). Roles/tiers live in the danni app DB
  (`users.role`), not in Kratos — see the spec.
- **Passkeys (WebAuthn).** The `passkey` method is enabled (rp id `localhost`, origins `:8790` +
  `:5173`) for passwordless register/login + per-user passkey management in settings. The SPA's custom
  flow UI injects Kratos's `webauthn.js` and submits the credential natively; registration stays
  single-screen via `enable_legacy_one_step`. WebAuthn needs a secure context — `localhost` counts, so
  it works in dev without HTTPS.
- **Recovery/verification use link mode** (magic links, danni-branded templates) — the link resolves
  through the single-port `/kratos` proxy and lands on `:8790/auth/settings`. Kratos + Oathkeeper are
  pinned to **v26.2.0**.
- First admin: register + log in once, then `danni admin grant <email>`.
- Email templates live in `infra/ory/templates/<template>/valid/email.{subject,body}.gotmpl`
  (mounted at `/etc/config/kratos/templates`, set via `courier.template_override_path`). If you add
  templates and they don't take effect, recreate the container so the bind mount is fresh:
  `docker compose up -d --force-recreate kratos` (a container created before the files existed keeps a
  stale empty mount). Verify with `docker exec danni-kratos find /etc/config/kratos/templates -type f`.
