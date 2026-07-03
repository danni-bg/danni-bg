# Feature Specification: Identity trust boundary (proxy-header hardening)

**Feature Branch**: `034-identity-trust-boundary`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the backend
trusts spoofable X-User-* identity headers from ANY client in single-port production mode, up to and
including bootstrap-admin promotion.

## Overview

The spec-019 design assumed Oathkeeper always fronts the gated routes, so the backend blindly trusts
the X-User-* headers Oathkeeper injects. Spec 020+ added single-port mode (the app validates the
Kratos cookie itself, no Oathkeeper), and the production overlay deploys exactly that — but the header
trust was never revoked. Anyone who can reach the app port can mint an arbitrary identity by setting
headers, and spoofing an `ADMIN_BOOTSTRAP_EMAILS` address yields super-admin. This spec makes header
trust an explicit operator opt-in (default OFF) and requires a verified email for bootstrap promotion.

Single responsibility: **the backend only accepts identity assertions it can verify.**

## Finding & evidence

- `apps/explorer-api/src/middleware/auth.ts:17-27` — `readAuth` returns whatever
  `x-user-id`/`x-user-email`/`x-user-name`/`x-session-id`/`x-user-verified` say, from any request.
  The file's header comment (lines 1-4) claims "Gated traffic reaches Hono only via Oathkeeper, so
  the trust boundary holds" — false in single-port mode.
- `apps/explorer-api/src/middleware/require-auth.ts:91-106` — `requireAuth` consults the headers
  FIRST; the Kratos cookie resolver (`resolveSession`, line 106) runs only when they are absent. So a
  forged header wins even when a session resolver is configured.
- `apps/explorer-api/src/middleware/require-auth.ts:110-117` — `findOrCreateByKratosId` mints a user
  row from the (unverified) header identity, with `createRole: 'admin'` when the spoofed email matches
  `ADMIN_BOOTSTRAP_EMAILS`. `isBootstrapAdmin(identity.email)` (lines 45-51, 110) never checks
  `identity.verified`, so even via real Kratos, if sessions are issued pre-verification the first
  registrant of a bootstrap address becomes admin.
- `docker-compose.prod.yml:35-36` — production publishes the app directly on host `:8790`; the overlay
  runs no Oathkeeper in front of it and nothing strips inbound X-User-* headers.
  `apps/explorer-api/src/server.ts:96-98` documents single-port mode ("headers still take precedence
  when present" — the vulnerability in one line).
- Constitution VI context: unit tests drive auth by setting these headers (e.g.
  `apps/explorer-api/tests/auth-middleware.test.ts`, `admin-routes.test.ts`) — that story must keep
  working under the fix.

## Requirements

- **FR-160**: The backend MUST NOT derive identity from X-User-* headers unless an explicit trust
  opt-in is enabled — an env flag (e.g. `TRUST_PROXY_AUTH_HEADERS`) and/or an Oathkeeper-injected
  shared-secret header compared in constant time. The default is OFF. With trust off, X-User-* headers
  MUST have no effect on the resolved identity: authentication comes only from the Kratos session
  resolver (cookie) or an API key (spec 027).
- **FR-161**: In the default (single-port, trust-off) configuration, a request carrying forged
  X-User-* headers and no valid cookie/key MUST get 401; one carrying forged headers AND a valid
  cookie MUST resolve to the cookie's identity, never the headers'.
- **FR-162**: Enabling trust is an operator assertion that a header-sanitizing proxy (Oathkeeper) is
  the only path to the app. The Oathkeeper deployment docs/config MUST pair the flag with the proxy;
  `auth.ts`'s header comment MUST be corrected to describe the real, conditional trust boundary.
- **FR-163**: Bootstrap-admin promotion (`ADMIN_BOOTSTRAP_EMAILS`) MUST additionally require
  `identity.verified === true`. An unverified match creates a plain `user` row (which is promoted on a
  later login once verified only if the row's role can be upgraded — pick and document one behavior:
  recommended is "promotion is evaluated on first creation only, so verify before first login", made
  explicit in the option's docs).
- **FR-164**: The existing header-driven unit-test story stays: tests that exercise gated routes via
  X-User-* headers enable the trust opt-in explicitly in their setup. At least one test MUST assert
  the trust-off default (forged headers rejected), and one MUST assert the bootstrap-verified rule.

## Success criteria

- **SC-1**: With default configuration, `curl -H 'X-User-ID: …' -H 'X-User-Email: <bootstrap email>'`
  against a gated route returns 401 — reproduced as an automated test.
- **SC-2**: No combination of spoofed headers can create or elevate a user to `admin` without a
  verified Kratos session for a bootstrap email.
- **SC-3**: The full existing explorer-api test suite passes with the trust flag enabled in test
  setup; no test drives auth through a live Kratos (Constitution VI preserved).
- **SC-4**: `docker-compose.prod.yml` deployments need no config change beyond upgrading — trust-off
  is the shipped default and cookie auth keeps working.

## Out of scope / dependencies

- Builds on **spec 019** (identity stack) and **spec 020** (single-port session resolver); API-key
  auth (**spec 027**) is unaffected. Personal-surface scope gaps are **spec 038**.
- Rotating/expiring the Oathkeeper shared secret and multi-node header policy belong to the private
  deploy repo (specs 030–033).
