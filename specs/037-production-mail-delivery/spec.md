# Feature Specification: Production mail delivery (real SMTP; Mailpit dev-only)

**Feature Branch**: `037-production-mail-delivery`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the
production compose overlay inherits the dev Mailpit courier, so Kratos recovery/verification emails
(account-takeover material) land in an unauthenticated Mailpit published on a host port, and real
users never receive mail.

## Overview

The Kratos config hardcodes the courier SMTP to the dev Mailpit catcher, and the production overlay —
which carefully overrides the DSN and secrets — sets no courier override. The base compose (which prod
is layered on) also publishes Mailpit's UI/API on host port 14438 with no auth. Net effect in a
production deployment: every recovery code, verification link, and courier message is readable by
anyone who can reach :14438, and no real user ever gets an email. This spec makes a real
operator-configured SMTP relay a hard production requirement and confines Mailpit to dev.

Single responsibility: **production account emails go to a real, operator-configured SMTP relay.**

## Finding & evidence

- `infra/ory/kratos.yaml:138-143` — `courier.smtp.connection_uri:
  smtp://mailpit:1025/?disable_starttls=true` (deliberately no-auth plaintext — correct for dev, see
  the comment at lines 140-141 and the `dev-mail-mailpit` decision).
- `docker-compose.prod.yml` — the `kratos` service overrides `DSN`/`SECRETS_COOKIE`/`SECRETS_CIPHER`
  (lines 23-26) but sets no `COURIER_SMTP_CONNECTION_URI`, so the YAML Mailpit URI stays effective;
  `--watch-courier` (line 22) actively delivers to it. The overlay neither disables nor un-publishes
  Mailpit.
- `docker-compose.yml:91-98` — the base compose (required under prod: "Use TOGETHER with the base
  file", prod overlay line 1-5) runs Mailpit with UI+API published on host `14438:8025`,
  `MP_SMTP_AUTH_ACCEPT_ANY: true`, no UI auth.
- `src/lib/secret-scan.ts:28-31` — `REQUIRED_SECRETS` is only `KRATOS_SECRETS_COOKIE` +
  `KRATOS_SECRETS_CIPHER`; the SMTP URI is not required, and the `SECRET_NAME` pattern (lines 24-25)
  would not match `COURIER_SMTP_CONNECTION_URI` anyway — the secret gate (spec 030 FR-136) cannot
  catch this today.

## Requirements

- **FR-190**: A non-dev profile (per `DEV_PROFILES`, secret-scan.ts:9) MUST require an
  operator-supplied Kratos courier SMTP connection URI (env `COURIER_SMTP_CONNECTION_URI`):
  add it to `REQUIRED_SECRETS` so `scripts/check-secrets.ts` / the entrypoint gate fails the
  deployment when it is missing.
- **FR-191**: A Mailpit-shaped or otherwise non-production URI (host `mailpit`/`localhost`, or any
  `PLACEHOLDER_PATTERNS` hit) MUST count as a placeholder violation for this variable on a non-dev
  profile — extend the audit so the URI's VALUE is checked, not just its presence (the generic
  `SECRET_NAME` regex does not match this name).
- **FR-192**: `docker-compose.prod.yml` MUST pass `COURIER_SMTP_CONNECTION_URI:
  ${COURIER_SMTP_CONNECTION_URI:?…}` into the `kratos` service (Ory env mapping overrides the YAML
  value, same mechanism as `SECRETS_COOKIE`), and MUST ensure Mailpit is not reachable in production:
  the overlay disables the `mailpit` service (e.g. `profiles`/replicas-0) or at minimum removes its
  host port publication. Kratos in prod must not depend on Mailpit being up.
- **FR-193**: Dev behavior is UNCHANGED: base compose alone still runs Mailpit on :14438 and the
  no-auth plaintext `disable_starttls` URI keeps working (Kratos refuses AUTH over plaintext — the
  dev combo is deliberate and must not be "fixed").
- **FR-194**: The self-hosting docs (prod overlay header comment / README deployment note) MUST list
  the SMTP requirement next to the existing required secrets, including that recovery/verification
  mail is security-critical.

## Success criteria

- **SC-1**: `check-secrets` (and the container entrypoint gate) exits non-zero on
  `DANNI_PROFILE=production` when `COURIER_SMTP_CONNECTION_URI` is unset OR set to the Mailpit URI —
  covered by unit tests on `auditSecrets`.
- **SC-2**: `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` renders no
  published Mailpit port and shows the courier env override on the `kratos` service.
- **SC-3**: With a real relay configured, a recovery flow delivers mail to the relay (manual/staging
  verification); with the dev stack, recovery mail still appears in Mailpit at :14438.

## Out of scope / dependencies

- Builds on **spec 030** (secret-placeholder gate, FR-136) and **spec 019** (Kratos stack). Choosing
  and operating the actual relay (provider, SPF/DKIM, k8s secret delivery) is the private deploy
  repo's concern (specs 030–033).
- Courier template content and email branding are unchanged.
