# Quickstart — danni-bg local mirror

> **Audience**: an operator setting up the local mirror for the first time.
> Keep it short — 5 minutes from clone to a usable mirror of a small subset
> of the portal.

## 1. Prerequisites

- **Bun** ≥ 1.x ([install](https://bun.sh))
- **SQLite** ≥ 3.43 with the `sqlite-vec` loadable extension (the project
  bundles a prebuilt extension under `vendor/sqlite-vec/` for Linux/macOS;
  no manual install needed)
- ~5 GB free disk for a small-scope first sync; budget 50–200 GB if you plan
  to mirror the entire portal
- Outbound HTTPS to `https://data.egov.bg` and to whatever resource hosts the
  portal links to (Bulgarian agency domains are common)

## 2. Clone & install

```bash
git clone https://github.com/<your-org>/danni-bg.git
cd danni-bg
bun install
```

## 3. Configure

Copy the example config and edit:

```bash
cp danni.config.example.json danni.config.json
$EDITOR danni.config.json
```

Required edits before the first run:

- `crawler.userAgent` — must include your contact URL or email
  (Principle XI). Example:
  `"danni-bg/0.1.0 (+https://github.com/your-org/danni-bg)"`
- `scope` — start narrow (e.g. one publisher) for the first run; widen once
  you've confirmed the pipeline works.

The example `portal` block is preset for the flagship portal, **data.egov.bg**
(`"api": "egov-bg"`, `"baseUrl": "https://data.egov.bg/api/"`) — no edit needed to
sync it. To point danni at a **generic CKAN** portal instead, set
`"api": "ckan"` with that portal's CKAN Action API base
(e.g. `"https://<host>/api/3/action/"`).

Validate the config without running anything:

```bash
bun run danni status
```

## 4. Initialize the store

Run migrations to create `store/danni.sqlite`:

```bash
bun run db:migrate
```

This is idempotent — safe to re-run.

## 5. First sync (narrow scope)

```bash
bun run danni sync --scope '{"publishers":["<a-single-org-id>"]}' --dry-run
```

`--dry-run` discovers datasets without downloading. Inspect the resulting
manifest at `store/manifest/<run_id>.json` to confirm the scope is right.
Then drop the flag:

```bash
bun run danni sync --scope '{"publishers":["<a-single-org-id>"]}'
```

Expect:
- Per-resource progress logs on stderr (structured JSON)
- A manifest file at `store/manifest/<run_id>.json` (conforms to
  `specs/001-egov-data-sync/contracts/manifest.schema.json`)
- Raw bytes under `store/raw/<dataset_id>/<resource_id>/<sha256>.<ext>`
- A row per dataset and per resource in `danni.sqlite`

## 6. Curate

```bash
bun run danni curate
```

Curates every captured resource. Idempotent — re-runs with the same curator
version are no-ops (FR-011).

## 7. Index

```bash
bun run danni index
```

Builds FTS5 + vector index incrementally over the curated mirror.

## 8. Test queries

```bash
bun run danni search "общини бюджет" --lang bg --json
bun run danni search "municipal budgets" --lang en --json
```

Each result includes `sourceUrl` (back to data.egov.bg) and
`curatedDatasetPath` (back to the curated artifact on disk) per FR-013.

## 9. Schedule (optional)

Edit `danni.config.json` → `schedule`:

```json
{
  "schedule": {
    "enabled": true,
    "cron": "0 3 * * *",
    "timezone": "Europe/Sofia",
    "onOverlap": "skip",
    "failureRateThreshold": 0.05,
    "notifier": { "kind": "stderr" }
  }
}
```

Then run the scheduler in the foreground (use systemd/launchd/Docker for
production):

```bash
bun run danni schedule install
```

Off-peak (overnight Europe/Sofia) is recommended (Principle XI).

## 10. Verify health

```bash
bun run danni status --limit 5
```

You should see your recent runs with `summaryOutcome` set, totals, and the
last successful sync timestamp.

## What's not in this quickstart

- **MCP read interface** — a separate follow-up feature. Until then,
  downstream consumers read directly from `store/curated/` and the
  `curated-dataset.schema.json`-conforming records produced by
  `danni mirror-info`.
- **Translator + embedder swap** — operators running offline-only get the
  bundled local providers by default. To switch to a hosted provider, edit
  `enrichment.translator.provider` / `enrichment.embedder.provider` and
  set the corresponding `endpointUrl` and `apiKeyEnv`.
