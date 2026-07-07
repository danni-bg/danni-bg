# Feature Specification: Runtime image hardening (minimal, non-root container)

**Feature Branch**: `044-runtime-image-hardening`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the
published app image ships the entire build stage — dev toolchain, specs, tests — and runs as root
against the mounted data volume.

## Overview

The `Dockerfile` (spec 030) builds the SPA and serves it plus the API from one Bun container. The
runtime stage, however, is not a runtime stage in practice: it inherits everything the build stage
had. This spec prunes the shipped image to exactly what serving needs and drops root, while keeping
the good parts — the migrate-on-boot entrypoint and the secret check — byte-for-byte in behavior.

Single responsibility: **the shipped container is minimal and unprivileged.**

## Finding & evidence

- **Whole build stage copied** — `Dockerfile:21` `COPY --from=build /app /app` after a full
  `bun install --frozen-lockfile` (Dockerfile:11): the runtime image contains dev `node_modules`
  (incl. `@playwright/test`, the Vite/build toolchain), plus `specs/`, `tests/`, `eval/` and other
  non-runtime trees. `.dockerignore` excludes `store/`, `.git/`, `node_modules/` — which trims the
  **build context**, not the runtime layer (deps are re-installed with dev packages in-stage).
- **Runs as root** — no `USER` directive anywhere in the Dockerfile; the process runs as root with
  write access to the mounted `/data` volume holding the SQLite store (users, hashed keys, chat).
- **Worth preserving** — `scripts/docker-entrypoint.sh`: secret check (`scripts/check-secrets.ts`,
  FR-136) → `db:migrate` (FR-135, a failed migration aborts boot) → `exec bun run
  apps/explorer-api/src/server.ts`. This contract must survive unchanged.

## Requirements

- **FR-260**: The runtime stage MUST contain only production dependencies (e.g.
  `bun install --frozen-lockfile --production` in a separate layer, or an equivalent prune). Dev-only
  packages — `@playwright/test`, Vite and the SPA build toolchain — MUST be absent from the image.
- **FR-261**: The runtime stage MUST copy an explicit allowlist of runtime-needed paths instead of
  `/app` wholesale: `src/`, `apps/explorer-api/`, `apps/explorer-web/dist/` (built SPA only),
  `packages/`, `migrations/`, `scripts/` (entrypoint + check-secrets), `vendor/` (the sqlite-vec
  extension `src/store/db.ts` loads from the project root), `bin/`, and the package
  manifests/lockfile. `specs/`, `tests/`, `eval/`, `apps/explorer-web/src|e2e`, logs and coverage
  MUST NOT be in the image.
- **FR-262**: The container MUST run as a dedicated non-root user (`USER` directive, fixed UID). The
  entrypoint's writes — the `/data` store (create/migrate) and nothing else — MUST work under that
  user; the image documents the UID so operators can `chown` pre-existing volumes.
- **FR-263**: Entrypoint behavior is preserved exactly: check-secrets → migrate-on-boot (failure
  aborts the start) → serve on `EXPLORER_API_PORT`. Existing env defaults (`DANNI_PROFILE`,
  `DANNI_STORE_ROOT=/data`) and the `VOLUME`/`EXPOSE` contract are unchanged.
- **FR-264**: A guard MUST make regressions visible: a CI or test step asserting that (a) the built
  image contains no `@playwright/test`/`vite` under `node_modules` and no `specs/`/`tests/` tree, and
  (b) the container's effective UID is non-zero.

## Success criteria

- **SC-1**: A container from the hardened image starts on a fresh volume, migrates, and serves
  `/healthz` — as a non-root user (`id -u` ≠ 0 inside the running container).
- **SC-2**: `docker run … ls` probes confirm the FR-261 denylist: no `specs/`, `tests/`, `eval/`,
  no SPA source/e2e, no Playwright/Vite packages.
- **SC-3**: Image size drops materially versus the current image (dev `node_modules` + repo trees
  removed); the reduction is recorded in the PR to anchor the FR-264 guard.
- **SC-4**: An upgrade in place (existing `/data` volume from the root-era image, after the
  documented `chown`) boots and serves with no schema or data loss.

## Out of scope / dependencies

- Registry/publish pipeline (`.github/workflows/ci.yml` image job) is unchanged apart from any
  FR-264 assertion step; production rollout stays in the private deploy repo (specs 030–033).
- Rootless *builds*, distroless base images, image signing/SBOM — worthwhile hardening, not required
  by this finding; note as follow-ons.
- Kubernetes securityContext / seccomp profiles — deployment layer (private repo). Consciously
  accepted: one container serving API+SPA on a single node is the product shape.
