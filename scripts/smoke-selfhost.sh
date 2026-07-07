#!/usr/bin/env bash
# Self-host smoke test (spec 047, FR-293). Locks the README open-core promise: a fresh clone of THIS
# repo — with no access to the private danni-bg/deploy repo — can be configured and run so the
# explorer serves /healthz and the SPA. Runnable by hand and suitable for occasional CI execution.
#
#   scripts/smoke-selfhost.sh
#
# Steps (the documented clone → configure → run journey):
#   1. bun install                              — deps
#   2. cp danni.config.example.json ...         — the committed example is self-host-correct (FR-290)
#   3. docker compose up -d                     — the dev Ory identity stack (Kratos + Mailpit)
#   4. bun run db:migrate                        — create the SQLite store schema
#   5. build the SPA + start the explorer        — one process serves /healthz AND the SPA on :8790
#   6. probe /healthz (200) and / (SPA HTML)
# Everything is torn down on exit. No portal sync is required — an empty store still serves /healthz
# (degraded) and the SPA shell.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PORT="${SMOKE_PORT:-8790}"
BASE="http://localhost:${PORT}"
API_PID=""
STARTED_COMPOSE=0

cleanup() {
  set +e
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  if [ "$STARTED_COMPOSE" = "1" ]; then
    docker compose down >/dev/null 2>&1
  fi
}
trap cleanup EXIT

say() { printf '\n=== %s ===\n' "$1"; }

say "1/6 install deps"
bun install --frozen-lockfile

say "2/6 configure (cp the self-host-correct example)"
[ -f danni.config.json ] || cp danni.config.example.json danni.config.json

say "3/6 dev Ory stack (docker compose up -d)"
if command -v docker >/dev/null 2>&1; then
  docker compose up -d
  STARTED_COMPOSE=1
else
  echo "docker not found — skipping the Ory stack (the explorer /healthz + SPA probe does not need it)"
fi

say "4/6 migrate the store schema"
bun run db:migrate

say "5/6 build the SPA + start the explorer"
(cd apps/explorer-web && bun run build)
EXPLORER_API_PORT="$PORT" bun run apps/explorer-api/src/server.ts &
API_PID=$!

say "6/6 probe /healthz + the SPA"
for i in $(seq 1 60); do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$API_PID" 2>/dev/null; then echo "explorer exited early" >&2; exit 1; fi
  sleep 1
done

curl -fsS "${BASE}/healthz" | grep -q '"status"' || { echo "healthz did not return a status" >&2; exit 1; }
curl -fsS "${BASE}/" | grep -qi '<div id="root"' || { echo "SPA shell not served at /" >&2; exit 1; }

echo
echo "SMOKE OK — explorer serves /healthz and the SPA from a clean checkout."
