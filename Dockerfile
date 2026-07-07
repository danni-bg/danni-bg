# syntax=docker/dockerfile:1
# App image for danni (spec 030 FR-134; hardened per spec 044): build the SPA, then run explorer-api
# (Bun) serving the built SPA + the API from one MINIMAL, NON-ROOT container. Bun runs the TypeScript
# server directly — no server transpile step.

# --- build: install ALL deps (incl. the Vite/SPA toolchain) + build the SPA bundle ---
FROM oven/bun:1.3.6 AS build
WORKDIR /app
# Copy the whole repo (every package.json present for a faithful install), then install against the
# committed lockfile for reproducibility and build the SPA into apps/explorer-web/dist.
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/explorer-web && bun run build

# --- deps: production-only node_modules (spec 044 FR-260) — NO Vite/Playwright/test toolchain ---
# A separate install from the manifests + lockfile only, so this layer caches on dependency changes
# (not source edits) and never pulls devDependencies into the shipped image.
FROM oven/bun:1.3.6-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
# --ignore-scripts: the root `prepare` hook (simple-git-hooks) is a devDependency absent under
# --production; runtime deps need no postinstall builds, so skip lifecycle scripts entirely.
RUN bun install --frozen-lockfile --production --ignore-scripts

# --- runtime: slim, NON-ROOT image = prod deps + server source + built SPA + migrations only ---
FROM oven/bun:1.3.6-slim AS runtime
ENV NODE_ENV=production \
    DANNI_PROFILE=production \
    DANNI_STORE_ROOT=/data \
    EXPLORER_API_PORT=8790
WORKDIR /app

# Production dependencies (FR-260) — resolved without the dev/SPA-build toolchain.
COPY --from=deps /app/node_modules ./node_modules

# Explicit allowlist of runtime-needed paths (FR-261) — NOT the whole build stage. specs/, tests/,
# eval/, colocated *.test.ts, the SPA source/e2e, dev node_modules, logs + coverage are all absent
# (kept out of the build context via .dockerignore and never copied here).
COPY package.json bun.lock ./
COPY src ./src
COPY apps/explorer-api/src ./apps/explorer-api/src
COPY apps/explorer-api/package.json ./apps/explorer-api/package.json
COPY --from=build /app/apps/explorer-web/dist ./apps/explorer-web/dist
COPY packages ./packages
COPY migrations ./migrations
COPY scripts ./scripts
COPY vendor ./vendor
COPY bin ./bin

# Dedicated non-root user with a FIXED uid/gid (FR-262). The entrypoint's ONLY writes are to the
# /data store (create + migrate on boot), so make /app and /data owned by this user: a FRESH volume
# is then writable. An operator upgrading a PRE-EXISTING root-era volume must first
# `chown -R 10001:10001` its host path (see docs; SC-4) so uid 10001 can write the SQLite store.
RUN groupadd --system --gid 10001 danni \
 && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin danni \
 && mkdir -p /data \
 && chown -R danni:danni /app /data
USER 10001:10001

# The SQLite store (read substrate + app tables) lives on a mounted volume; migrations run on start.
VOLUME ["/data"]
EXPOSE 8790
# Migrate-on-release then serve (FR-135 / spec 044 FR-263): check-secrets → db:migrate (a bad/pending
# migration fails the start, never serves 500s) → serve. Behavior is byte-for-byte unchanged.
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
