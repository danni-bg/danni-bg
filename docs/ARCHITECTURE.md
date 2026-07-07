# danni-bg — Architecture

`danni-bg` keeps a **local, byte-faithful mirror of [data.egov.bg](https://data.egov.bg)** and turns it into a curated, enriched, machine-readable corpus that can be searched offline.

It is a Bun + TypeScript monorepo with two layers over one SQLite store:

```
build layer (CLI):   sync  →  curate  →  enrich  →  index  →  search      ← builds the store
serve layer:         MCP server  ·  HTTP API + web explorer (map + chat)   ← only reads the store
```

Each pipeline stage is independent, idempotent, and re-runnable; the store on disk is the source of
truth. The serving layer (§6) never writes — it projects the same store for LLM agents (MCP) and for
the interactive map explorer with a grounded chat assistant.

---

## 1. The pipeline at a glance

```mermaid
flowchart TD
  CFG["danni.config.json<br/>portal.api · scope · rate/robots · embedder · translator"]
  PORTAL[("data.egov.bg<br/>live portal")]

  subgraph CLIENTS["Portal clients"]
    CKAN["CkanClient<br/>GET /api/3/action"]
    EGOV["EgovBgClient<br/>POST /api/{method}"]
  end
  HTTP["PortalHttp<br/>RateLimiter · BackoffRunner · RobotsCache (obey / allowHosts)"]

  PORTAL --> CKAN --> HTTP
  PORTAL --> EGOV --> HTTP
  CFG -.-> CLIENTS

  HTTP --> SYNC["1 · SYNC<br/>danni sync"]
  SYNC --> CURATE["2 · CURATE<br/>danni curate"]
  CURATE --> ENRICH["3 · ENRICH<br/>entities · links · translations"]
  ENRICH --> INDEX["4 · INDEX<br/>danni index"]
  INDEX --> SEARCH["5 · SEARCH<br/>danni search · mirror-info · status"]

  SYNC --> RAW[("store/raw/*<br/>byte-faithful")]
  CURATE --> CUR[("store/curated/*<br/>data.ndjson / json + schema.json")]
  SYNC --- DB[("store/danni.sqlite")]
  CURATE --- DB
  ENRICH --- DB
  INDEX --- DB
  SEARCH --- DB
```

Plain-text view of the same flow:

```
                          danni.config.json
        portal.api (ckan│egov-bg) · scope · rate/robots · embedder · translator
                                   │
   ┌───────────────────────────────────────────────────────────────────────┐
   │                       data.egov.bg  (live portal)                       │
   └─────────────┬───────────────────────────────────┬─────────────────────┘
   CkanClient (GET /api/3/action)        EgovBgClient (POST /api/<method>)   │
   package_search / package_show          listDatasets / getDatasetDetails  │
                 └──────────────┬──────────listResources / getResourceData──┘
                                ▼
        PortalHttp  ─ RateLimiter · BackoffRunner · RobotsCache(obey / allowHosts opt-out)
                                │
   ╔════════════╗   ╔══════════▼═══════════╗   ╔═══════════╗   ╔═══════════╗   ╔══════════╗
   ║  1. SYNC   ║──▶║  2. CURATE           ║──▶║ 3. ENRICH ║──▶║ 4. INDEX  ║──▶║ 5.SEARCH ║
   ║ danni sync ║   ║   danni curate       ║   ║ (part of  ║   ║danni index║   ║danni     ║
   ╚═════╤══════╝   ╚══════════╤═══════════╝   ║  curate)  ║   ╚═════╤═════╝   ║ search   ║
         │                     │               ╚═════╤═════╝         │         ╚════╤═════╝
         ▼                     ▼                     ▼               ▼              ▼
   store/raw/*           store/curated/*        entities/links   datasets_fts   hybrid
   (byte-faithful)       data.ndjson|json       translations     dataset_       FTS5 + vector
                         + schema.json                           embeddings     (RRF fusion)
         └─────────────────────────┴─────── store/danni.sqlite ──────┴──────────────┘
```

---

## 2. Stages

### 1 · Sync — `danni sync` (`src/crawler`, `src/cli/sync.ts`)

Pulls the portal into `store/raw/` and records metadata in SQLite. Two interchangeable portal clients, selected by `portal.api`:

| `portal.api` | Client | Orchestrator | Notes |
|---|---|---|---|
| `ckan` (default) | `CkanClient` (GET `/api/3/action/*`) | `run-sync.ts` | Standard CKAN; documented contract + recorded fixtures |
| `egov-bg` | `EgovBgClient` (POST `/api/<method>`) | `run-egov-sync.ts` | data.egov.bg's **actual** API (governmentbg/data-gov-bg) |

All HTTP goes through `PortalHttp` (`http.ts`) with `RateLimiter`, `BackoffRunner`, and `RobotsCache`. Respectful by default; `crawler.robots.obey: false` / `allowHosts` is an operator opt-out for the official public API.

- **CKAN path**: `discover` (package_search) → `packageShow` → `capture-resource` downloads each resource's bytes (conditional GET via etag/last-modified).
- **egov-bg path**: `listDatasets` → `getDatasetDetails` → `listResources` → `getResourceData`; the **verbatim** datastore response envelope is written to `store/raw/` as `raw.json` (byte-faithful, like the CKAN path — spec 049). No shape transform at capture: array-of-arrays → CSV, header flattening, and absent-data normalization all moved into curate. Captures carry the `egov-datastore` format hint so the registry routes them to the `DatastoreJsonCurator`.
- **Resumable full crawl** (`crawl-checkpoint.ts`, `scope-hash.ts`, `egov-validator.ts`): a `crawl_checkpoint` keyed by scope-hash with a **frozen sorted dataset-id cursor** and per-resource completion + attempt counts; **atomic capture** (temp + fsync + rename); runs inside `beginSyncRun` (shared `sync_runs_lock`, mutually exclusive with the CKAN path); `--max` per-session batch and `--retry-failed` (max-attempts cap).

**Writes:** `store/raw/<dataset>/<resource>/raw.*` + `datasets`, `resources`, `organizations`, `sync_runs` rows.

### 2 · Curate — `danni curate` (`src/curate`)

Normalizes raw bytes into typed, UTF-8 artifacts with a declared schema.

```
CuratorRegistry.select(resource)  ── sniff(magic bytes + extension + declared format)
        │
        ├─ DatastoreJsonCurator (egov-datastore hint: unwrap envelope → CSV/JSON/text; spec 049)
        ├─ CsvCurator   ├─ XlsxCurator   ├─ GeoJsonCurator   ├─ JsonCurator
        ├─ XmlCurator   ├─ TextCurator   └─ UncuratedMarker (fallback, raw retained)
        │                  └ dependency-free OOXML reader (ZIP central dir + node:zlib inflate)
        ▼
  encoding.ts  (BOM → CP1251 vs UTF-8 heuristic)
  normalize.ts (ISO/Bulgarian-month dates, decimal-comma numbers)
  schema.ts    (per-column type inference; canonicalizeName w/ Cyrillic→Latin transliteration)
```

`CsvCurator.canHandle` rejects ZIP-magic bytes so a mislabeled `.xlsx` routes to `XlsxCurator`. Column names are transliterated (`"Пореден №"` → `poreden_no`) while the original Cyrillic is preserved in `sourceName`/`labelBg`.

**Writes:** `store/curated/<dataset>/<resource>/data.ndjson|data.json|data.xml|data.txt` + `schema.json`, and a `curated_artifacts` row. Re-curation is idempotent per `curator_version`.

**`danni curate --entities-only`** re-runs only the enrich half — extractors + cross-dataset linking +
entity-relation materialisation (§3) — and skips resource parsing into curated artifacts *and*
translation. It is the low-memory path for re-running after an extractor or gazetteer change: a full
re-curate parses every resource and can exhaust memory on the ~16k-resource mirror (~20 GB RSS), whereas
the entities-only pass runs against metadata at ~140 MB. All writes are PK-guarded upserts, so it is
idempotent over the whole catalog.

### 3 · Enrich — runs inside the curate orchestrator (`src/enrich`)

Attaches machine-meaning to each dataset.

```
Extractors (src/enrich/extractors)         registerEntities → entities + dataset_entities
  ckan_organization · ckan_groups · ckan_tags
  bg_admin_gazetteer (28 oblasts + 265 municipalities)   linkDatasets → dataset_links
  bg_admin_publisher (place from publisher org name)     (shared entity, undirected)
  iso8601_dates · bg_month_dates · column_name_heuristics
                                            registerEntityRelations → entity_relations
                                              (part_of: municipality → oblast, from gazetteer)
Translators (src/enrich/translators)       translate → translations (incremental: skip unchanged text_bg)
  local-marianmt (stub) │ hosted-api        BG preserved byte-exact; EN added with provenance/confidence
                                            stub (no translateFn) short-circuits the whole stage (spec 051)
```

**Publisher-derived geo recall** (`bg_admin_publisher`, `BgAdminPublisherExtractor`). The
in-content gazetteer extractor only places a dataset that *names* a place in its own title/description,
which left a large class of municipal/regional datasets (whose own metadata names no place) in the
non-georeferenced "national" bucket. `BgAdminPublisherExtractor` recovers them by matching the dataset's
**publisher organisation name** (`Община Бургас` → Бургас) against the same gazetteer, at a deliberately
lower confidence (canonical `0.7` / alias `0.6`, below the in-content `0.95` / `0.75`) so an in-content
placement always wins for the same `(dataset, entity)` pair (its `dataset_entities` PK includes the
extractor, so both rows coexist and the read layer takes the max). This shrank the national bucket from
~57% to ~15% of the mirror (georeferenced datasets ~43% → ~85%).

**Entity knowledge graph** (`registerEntityRelations`, `src/enrich/relations`). Beyond dataset→entity
edges (`dataset_entities`), curate also materialises **typed directed entity↔entity relations** into
`entity_relations` — triples `(subject_id, predicate, object_id)` with `confidence` and `evidence_json`
provenance, drawn from a controlled predicate vocabulary (`src/enrich/relations/vocabulary.ts`; currently
just `part_of`, asserting municipality → parent-oblast from the bundled gazetteer). The roll-up,
drill-down and `GET /api/entities/:id` read all build on this graph; it is also re-asserted by
`curate --entities-only` (§2).

`linkDatasets` is pairwise per shared entity (O(n²)), so generic "stop-word" entities (the tags
`регистър`/`община`, a whole oblast, a ministry publisher) would form huge cliques — one tag on 4k
datasets alone is ~8M links. A **fan-out cap** (`MAX_ENTITY_FANOUT`, default 50) skips any entity
shared by more than 50 datasets, so only specific/rare shared entities link; this keeps the link set
a meaningful "these two datasets are related" signal (~260k links) instead of a ~20M near-clique.

### 4 · Index — `danni index` (`src/index`)

Builds the two search indexes over active, curated datasets.

```
per dataset:
  buildFtsRow (fts.ts)            → datasets_fts          (FTS5 keyword)
  composeEmbeddingText (vec.ts)   → Embedder.embed()      → dataset_embeddings (BLOB vector)
                                     local-onnx (hash stub) │ hosted-api (real model)
```

Two recent additions make a corpus-scale re-index practical:

- **Incremental** (`index-state.ts`): a per-dataset `index_state(content_fp, embed_fp, model_id)` fingerprint ledger. A dataset is skipped only when its fingerprint matches **and** the target store row exists; a model change re-embeds **vectors only** (FTS is model-independent); `--full` forces a single-transaction rebuild; every run reconciles against `listActive()` and purges orphans from all three stores. Incremental is the default (`config.index.incremental`; precedence `--full` > config > true).
- **Batched** (`batch-embed.ts`): embeds **only the changed set** in batches (default 32) with positional length-checked mapping, single-text retry, and 429/5xx backoff; an `index_failures` ledger records per-dataset not-embedded reasons. FTS stays per-dataset, outside batching.

### 5 · Search & read (`src/index/query.ts`, `src/cli/{search,mirror-info,status}.ts`)

```
danni search "Плевен"   FTS5 keyword  ⊕  vector cosine  →  RRF fusion  →  ranked IndexEntry[]
searchByEntity(...)     entity-anchored recall via dataset_entities
danni mirror-info <id>  joins datasets+resources+curated_artifacts+entities+links+translations
danni status            sync-run history + freshness SLO
```

Every result carries a pointer back to the curated artifact and the original source URL (one-hop traceability).

---

## 3. Storage & schema

```
store/
 ├─ raw/      <dataset_id>/<resource_id>/raw.*        ← byte-faithful archive (a static mirror)
 ├─ curated/  <dataset_id>/<resource_id>/data.* + schema.json
 └─ danni.sqlite
```

Migrations are applied in numeric order by a checksum-guarded runner (`src/store/migrate.ts`):

| Migration | Adds | For |
|---|---|---|
| `001_core` | `datasets`, `resources`, `organizations`, `sync_runs` (+ lock + events) | sync |
| `002_curate_enrich` | `curated_artifacts`, `entities`, `dataset_entities`, `dataset_links`, `translations`, `embeddings_meta` | curate + enrich |
| `003_index` | `datasets_fts` (FTS5), `dataset_embeddings` (BLOB) | index |
| `004_index_failures` | `index_failures` | batch embedding |
| `005_index_state` | `index_state` (incremental fingerprints) | incremental indexing |
| `006_crawl_checkpoint` | `crawl_checkpoint` | resumable crawl |
| `007_entity_relations` | `entity_relations` (typed `(subject, predicate, object)` triples + confidence/provenance) | entity knowledge graph |
| `008_users` | `users` (`kratos_identity_id`, `email`, `display_name`, `role`, …) | identity / tiers (spec 019) |
| `009_platform_settings` | `platform_settings` (k/v `value_json`) | runtime admin settings (spec 019) |
| `010_token_usage` | `token_usage` (per-turn tokens) + `users.token_limit` / `usage_reset_at` | token metering (spec 021) |
| `011_token_usage_cached` | `token_usage.cached_input_tokens` | usage breakdown (spec 021) |
| `012_user_avatar` | `users.avatar_url` | profile pictures (spec 022) |
| `013_chat_sessions` | `chat_sessions` + `chat_messages` | persistent/resumable chat (spec 020) |
| `014_message_usage_duration` | `chat_messages.usage_json` + `duration_ms` | per-turn tokens + reply time kept on each message (spec 026) |

Vectors are stored as plain BLOBs; similarity search is in-process cosine + Reciprocal-Rank-Fusion with FTS5. The corpus is deserialized **once** into a resident in-process matrix (`src/index/vector-cache.ts`), reused across queries and invalidated in O(1) against `embeddings_meta.updated_at` — which each `danni index` run bumps once it has written/purged vectors (`bumpEmbeddingsMeta`), so a running explorer/MCP reflects new vectors on its next query without a restart (spec 050). Per-query allocation is O(candidates), not O(corpus). The `sqlite-vec` `vec0` virtual-table path remains an optional future upgrade for true ANN; `openDb` does **not** load the extension by default (`loadVec` defaults to `false`) and opens fine without the vendored binary.

**Write-atomicity & upsert convention (spec 052).** Two rules hold across the write layer:

1. **One logical pipeline unit = one transaction.** A write that spans several tables to persist a single unit runs inside one `withTransaction` (`src/store/db.ts`) so an interrupt (or a second writer, once one exists) can never leave half a unit. The reference example is `src/crawler/capture-dataset.ts:61` (org + dataset + revisions + resources for one CKAN dataset). The same closure wraps the egov per-resource capture triple (`egov-sync.ts`: resource upsert + `recordCapture` + checkpoint mark), `registerEntities`' per-candidate entity-upsert + attach, and one entity's whole pairwise-link batch in `linkDatasetsForEntity` (one commit instead of up to ~1.2k).
2. **Repos upsert with one atomic statement — `INSERT … ON CONFLICT(…) DO UPDATE`** — never `INSERT OR REPLACE` (delete+reinsert: FK-cascade / rowid churn) and never a bare read-then-`INSERT`/`UPDATE`. Where an upsert must diff the old row (the field-level revision trail in `datasets.upsert`, the keep-non-empty rule in `translations.upsert`), the read **and** the write execute inside one transaction so the diff can't be computed against a stale row.

---

## 4. Configuration (`danni.config.json`)

```jsonc
{
  "portal":  { "baseUrl": "...", "api": "ckan" | "egov-bg", "apiKeyEnv": null },
  "crawler": { "userAgent": "...", "rateLimit": {...}, "concurrency": {...},
               "backoff": {...}, "robots": { "recheckIntervalSeconds": 86400,
                                             "obey": true, "allowHosts": [] } },
  "store":   { "root": "./store", "freshnessSloSeconds": 86400 },
  "schedule":{ "enabled": false, "cron": null, "onOverlap": "skip", "notifier": {...} },
  "scope":   { "publishers": [], "categories": [], "tags": [], "datasetIds": [] },
  "enrichment": { "translator": { "provider": "local-marianmt" | "hosted-api", ... },
                  "embedder":   { "provider": "local-onnx"     | "hosted-api", ... } },
  "index":   { "incremental": true }
}
```

`scope` (empty = the whole portal) selects which datasets to mirror. `schedule` drives recurring runs with overlap prevention via the `sync_runs_lock`. The cron expression fires in the **server's local time** (there is no `timezone` knob — spec 056 FR-388); `onOverlap` accepts only `"skip"` (a fire that overlaps a still-running one is skipped — spec 056 FR-389 removed the indistinguishable `"queue"`).

---

## 5. Source map (`src/`)

| Subsystem | Responsibility |
|---|---|
| `cli/` | the `danni` command surface (`sync`, `curate`, `index`, `search`, `mirror-info`, `status`, `schedule`) |
| `config/` | zod-validated config schema + loader |
| `crawler/` | portal clients (ckan/egov), `PortalHttp`, rate-limit/backoff/robots, discovery, capture, checkpoint/resume |
| `curate/` | curator registry + per-format curators, sniff/encoding/normalize/schema, curate orchestrator |
| `enrich/` | entity extractors (incl. publisher-derived geo), gazetteer, entity registrar, cross-dataset linker, `relations/` (entity-relation materialiser + predicate vocabulary), translators |
| `index/` | FTS + vector builders, embedders, incremental `index_state`, `batch-embed`, query/search |
| `manifest/` | `beginSyncRun`, run records, lock, manifest writer |
| `store/` | `bun:sqlite` open/migrate + typed repos per table |
| `lib/`, `logging/`, `notify/`, `schedule/` | hashing/ids/time/fs, structured logging, notifier, cron |

---

## 6. The explorer & serving layer (`apps/`, `packages/geo-boundaries`)

The pipeline *builds* the store; the serving layer *only reads* it through one shared read substrate
(`src/read` + `src/index/query.ts`). Two front doors:

- **MCP server** — `danni mcp`, read-only tools for LLM agents (see [CONSUMERS.md](./CONSUMERS.md)).
- **Web explorer** — `apps/explorer-api` (Bun + Hono) + `apps/explorer-web` (React 19 + Vite +
  Tailwind/shadcn): an interactive Bulgaria choropleth (headless-renderable SVG, drill-down to
  municipalities) with faceted filters, a dataset document-reader + grid drilldown, and a
  grounded chat assistant.

```mermaid
flowchart TD
  subgraph WEB["apps/explorer-web — React 19 · Vite · SVG D3-geo · Tailwind/shadcn"]
    MAP["SVG choropleth<br/>28 oblasts → click drills into<br/>265 municipalities (zoom + back)"]
    FILT["Faceted filters + chips"]
    DRILL["Dataset drilldown<br/>document reader · sortable/filterable grid"]
    CHATUI["Chat panel (SSE)"]
  end
  subgraph API["apps/explorer-api — Bun · Hono · Zod"]
    REST["/api/datasets · /api/regions(level) · /api/regions/:id<br/>/api/national · /api/facets · /api/entities/:id"]
    CHATR["/api/chat — SSE stream"]
  end
  BRIDGE["ReadBridge<br/>listLite (bulk projection) · view/detail · rows (sort/filter) · search · partOfParents"]
  RUN["chat turn<br/>tool loop ⟷ RAG fallback · grounding · caps"]
  GEO["packages/geo-boundaries<br/>NUTS3 oblasts + LAU municipalities crosswalk"]
  DB[("store/danni.sqlite")]
  LLM[("LLM provider<br/>OpenAI-compatible / Anthropic")]

  MAP --> REST
  FILT --> REST
  DRILL --> REST
  CHATUI --> CHATR
  REST --> BRIDGE
  REST --> GEO
  CHATR --> RUN --> BRIDGE
  RUN --> LLM
  BRIDGE --> DB
```

**Read bridge — scaling to the whole catalog.** The whole-catalog endpoints (list / regions /
national / facets) project the store through `ReadBridge.listLite()`: four set-based SQL queries +
an in-memory join, instead of materializing a full `CuratedDatasetView` (≈7 queries) per dataset. At
the full ~12k-dataset mirror the per-dataset fan-out cost tens of GB of RAM and timed out; the bulk
projection answers in tens of milliseconds at ~140 MB. The **?query search route** uses the same
bulk projection: it resolves ranked hits (`ReadBridge.searchRanked` — ids+scores, no per-hit DB
projection) through one `listLite()` call instead of a per-hit `view()` fan-out, so a 200-hit query
runs a bounded set of statements independent of hit count (spec 050 FR-323). Detail / rows endpoints stay keyed by id; the
`rows` endpoint does **server-side sort + per-column (Excel-style) substring filters** over the whole
resource (scanning up to a cap, with a `gridTruncated` flag) so the grid is not limited to the loaded
page.

**Hierarchical region roll-up.** `regions-aggregate.ts` no longer just buckets per-oblast counts: at
`level=oblast` an oblast's `datasetCount` is the **de-duplicated union of its own and its municipalities'**
datasets (a dataset linked to both a municipality and its oblast counts once, at its strongest
confidence). The municipality→oblast parent is resolved from the `part_of` knowledge graph via
`ReadBridge.partOfParents()` (reading `entity_relations`), not from geometry. `GET /api/regions` takes
`level=oblast|municipality`; each `RegionSummary` carries `oblastEntityId` (null for an oblast, the parent
oblast for a municipality), which drives the map drill-down. `GET /api/regions/:id` paginates the datasets
behind a region. `GET /api/entities/:id` returns one entity's graph node — canonical labels, outgoing /
incoming `entity_relations` edges (resolved far-end nodes), and its direct dataset count.

**Geo filter roll-up + region selection (spec 023).** Selecting a region constrains the dataset list
and the chat scope via `geoUnitIds` (the single selection source of truth, `filters.geoUnitIds`). An
**oblast filter expands to its municipalities** (`geo-rollup.ts` `expandGeoUnitIds` +
`ReadBridge.partOfChildren`) so the filtered count matches the choropleth roll-up (e.g. Стара Загора:
128 oblast-only → **638**); a municipality filter stays exact. The map supports **Shift+click
multi-select** (oblasts, or municipalities when drilled in), rendered as a high-contrast selection
(orange) + filter chips. The chat is **scope-aware**: a geo-scope rolls up the same way, and the tool
loop + RAG path **over-fetch then backfill the region's datasets** so a tight scope narrows rather than
starves; the model is told to stay in-region (no cross-region padding). A chat answer's grounded
regions (oblast-focused anchor) **become the selection** — chat and map share one selection — and are
re-selected when a saved conversation is reopened.

**Map — SVG choropleth + drill-down.** The map is a **headless-renderable SVG D3-geo choropleth**
(`apps/explorer-web/src/map/MapView.tsx` + pure `lib/projection.ts` / `lib/map-scale.ts`), not a
WebGL/MapLibre canvas. It renders the 28 oblasts; clicking one **zooms into its 265-municipality
geometry** (real Eurostat GISCO LAU 2021 boundaries, Cyrillic names) as a sub-choropleth, with a back
action to the national view. The dataset drilldown opens a **centre document reader** plus the sortable /
filterable grid; the old bar/line charts were removed entirely. A **faceted search panel** (`GET
/api/facets`) returns conjunctive tag/publisher facet counts and freshness buckets over the current
filter scope, surfaced as removable chips with a debounced search box.

**Chat — grounded, provider-agnostic.** `/api/chat` streams Server-Sent Events. A turn runs a tool
loop over four **scope-filtered** tools — `mirrorSearch`, `mirrorEntitySearch`, `mirrorInfo`,
`readResource` — so the model can only retrieve in-scope datasets; every id a tool returns is
recorded and citations are validated against it (hallucinated/out-of-scope sources are dropped).
Providers without function-calling (a vanilla vLLM Gemma) fall back to a **RAG path** that retrieves
scoped candidates server-side and feeds them as context, so grounded chat works with any
OpenAI-compatible model. Context guards (`apps/explorer-api/src/chat/cap.ts`): `capDatasetDetail`
trims a high-degree dataset's links/entities and `capResourceContent` bounds a resource read, so a
large artifact can't overflow the model's window; `maxOutputTokens` reserves output room; the loop
runs up to 16 steps so a multi-dataset question (comparing periods/regions) can read one figure per
dataset before answering.

Answers are **grounded by construction**. The actual rows of the focused/open dataset(s) are pre-read
and injected as a ground-truth context block (a "ДАННИ" block) in **both** the tool loop and the RAG
fallback, listing each resource's exact column names and `resourceId`. Grounding has three precedence
tiers: an explicit hard `scope.datasetIds` focus (injects rows *and* narrows tool scope); a
`groundingDatasetIds` reader focus that **auto-focuses the dataset open in the reader** (injects its rows
*without* narrowing tool scope); and **sticky session grounding** (`contextDatasetIds`, capped and
session-only) that carries the dataset(s) a conversation is about forward across turns, re-injected every
turn. Recent turns are replayed within a char budget. A grounded dataset is always cited even with no tool
call, `readResource` gained a **value-filter** (exact column → case-insensitive substring, matching over
the whole resource) and exposes column names, and a hardened **anti-fabrication** system prompt forbids
stating any specific value not present verbatim in a tool result or the injected context.

**Answer presentation & anti-fabrication (specs 023/025).** The system prompt also (a) references
datasets **by title, never raw ids/UUIDs** in prose — the `citations` carry the linkable id (no
`datasetId` columns of noise); (b) enforces **enumeration closure** — when listing, the tool results
are the complete, closed set, so the model must not "round out" a list with datasets, publishers, or
municipalities from prior knowledge; and (c) under a geo-scope, must stay **in-region**. These close
real fabrication modes the agentic eval caught (cross-region padding, register/municipality lists).

**Live usage telemetry (spec 026).** Each turn streams a `usage` SSE event — cumulative token usage
per provider step (`onStepFinish`) plus an authoritative final total (billing/metering unchanged) — so
the UI shows a live **↑input / ↓output (+ ⚡cached)** meter with a ticking **⏱ duration** clock. The
totals + reply duration are **persisted per message** (`014_message_usage_duration`) and restored on
reload/resume; one `UsageFooter` renders both the live and the kept-after-completion states.

**Serving-layer source map**

| Path | Responsibility |
|---|---|
| `apps/explorer-api/` | Hono routes (incl. `/api/regions(:id)` roll-up + `/api/entities/:id` graph + `/api/facets`), `ReadBridge` (`listLite`/view/detail/rows-with-sort+filter/search/`partOfParents`), `regions-aggregate.ts`, scope filtering, chat (`chat/{run,tools,grounding,cap,scope,session,providers}.ts`), SSE |
| `apps/explorer-web/` | React SPA: SVG D3-geo choropleth with oblast→municipality drill-down, faceted filters + chips, dataset document-reader + sortable/filterable grid, chat panel, Zustand store, pure `lib/*` (projection/map-scale/choropleth/pagination/grid/markdown/theme) |
| `packages/geo-boundaries/` | crosswalk + geometry: 28 NUTS3 oblasts + 265 LAU (2021) municipalities, joined by official code (ISO-3166-2 / EKATTE / LAU id) |
| `src/read/`, `src/index/query.ts` | the shared read substrate both front doors consume |

---

## 7. Identity, accounts & the chat platform

On top of the read substrate sits an authenticated chat platform (specs 019–022). Public browsing
(map, datasets, search, regions) stays anonymous; **chat and `/api/admin/*` are gated**.

- **Identity (spec 019).** danni owns an Ory stack (Kratos + Oathkeeper **v26.2.0** + Postgres +
  Mailpit) via `docker-compose.yml` + `infra/ory/`. Self-service email+password signup; **passkeys
  (WebAuthn)** for passwordless register/login; **link-mode** recovery/verification (danni-branded
  emails, Mailpit in dev). **Single-port:** the Hono server reverse-proxies `/kratos/*` and validates
  the session itself (`/sessions/whoami`), so `:8790` stands alone (Oathkeeper optional; its
  `X-User-*` headers are honored only behind the `TRUST_PROXY_AUTH_HEADERS` opt-in — spec 034).
  Tiers live in the app `users` table
  (`role ∈ {admin,user}`, keyed by `kratos_identity_id`), not Kratos; first admin via `danni admin grant`.
- **Admin settings (spec 019, tenant-scoped spec 042).** Runtime, admin-editable `platform_settings`
  (k/v): the chat's LLM provider (kind/model/baseUrl/apiKey, API key masked) + toggles — resolved per
  request, so edits apply without a restart. **Resolution goes through the caller's active org**
  (`settings.get(key, activeTenantId)`): a tenant override wins, the `global` row is the fallback. Org
  admins manage their org's OVERRIDABLE keys (an explicit allowlist — the LLM provider +
  `defaultTokenLimit`; platform toggles/api rate-quota knobs stay global) via `GET/PUT
  /api/tenant/settings`; super-admins manage `global` via `/api/admin/settings` and can view/clear any
  org's overrides. A tenant-facing view never returns another tenant's or the global secret (an
  inherited LLM shows only that a key exists, never a hint).
- **Token metering & quotas (spec 021).** Every chat turn records per-user token usage
  (`token_usage`: input/output/total + cache hits). The chat gate enforces an effective per-user
  quota (per-user override → platform default → unlimited) and 429s when exceeded; cache hits count at
  an admin-set weight. Admins see a per-user table + set limits/reset; users see their own usage.
  `defaultTokenLimit` / `cachedTokenWeight` / `maxOutputTokens` are admin-configurable toggles.
- **Persistent & resumable chat (spec 020).** Conversations (questions + replies) persist per user
  (`chat_sessions` / `chat_messages`) and are reopenable from a history list. A turn runs **detached**
  via an in-memory `GenerationManager`, so a disconnect doesn't lose the answer: a reconnecting client
  re-attaches to the live token stream (`/api/me/generations/:id/{stream,stop}`). Supersedes the old
  in-memory-only FR-019.
- **Account & chat UX (spec 022).** Avatar dropdown (name from Kratos traits, role, logout), a full
  `/auth/settings` account page (appearance / profile / password / passkeys / usage), profile pictures
  (`users.avatar_url`), and a header link to the repo.

The backend pieces live under `apps/explorer-api/src/{auth,chat,middleware,routes}` + `src/store/repos`;
the SPA account/chat UI under `apps/explorer-web/src/{auth,account,admin,chat}`.

---

## 8. Caveats worth knowing

- **The semantic half is opt-in.** `local-onnx` (embedder) and `local-marianmt` (translator) ship as **deterministic placeholders** — the FTS/keyword half of search is always real, but real *semantic* vectors and EN translations need a real model wired via `provider: "hosted-api"` (see [semantic-search.md](./semantic-search.md)). The reference deployment points the embedder at a vLLM **Qwen3-Embedding-8B** (4096-dim) on the LAN and the chat at an OpenAI-compatible model; `batch-embed` makes a real-model re-index practical at corpus scale.
- **The explorer needs `apps/explorer-api` running, and chat needs a provider + sign-in.** The web app reads the same store live (no rebuild to see new sync/curate/index results — just refresh). Chat is gated behind login and uses the **admin-configured** server-default provider (the old per-request user override was removed — spec 022); a provider without function-calling automatically uses the RAG fallback. The dev server is run non-hot (`--hot` EMFILE-chokes on the large `store/`), so a backend change needs a restart. To run unsandboxed for LAN access to the embedder/LLM, see the project memory + `specs/008-map-data-explorer/quickstart.md`.
- **The live data.egov.bg crawl needs the egov adapter + a robots opt-out.** The portal does **not** serve the CKAN API at `/api/3/action/` (every method returns "Непознат метод"); use `portal.api: "egov-bg"` with `baseUrl: "https://data.egov.bg/api/"`. The site's `robots.txt` is `Disallow: /`, so an authorized crawl of its public API requires `crawler.robots.obey: false` (or `allowHosts: ["data.egov.bg"]`). The egov datastore serves resources as a JSON envelope, captured **verbatim** to `store/raw/` (byte-faithful on both adapters — spec 049); the `DatastoreJsonCurator` unwraps it to CSV/JSON/text at curate time, so a curation-logic fix (e.g. header flattening) re-runs from raw without a re-crawl.
- **The store is the source of truth.** Any stage can be re-run; the raw archive remains usable read-only even if the portal is unreachable.

---

*See `specs/001-egov-data-sync/` for the foundational spec/plan; `specs/002-006-*/` for the
incremental-index, batch-embedding, crawl-resume, pipeline-hardening, and embedding-eval features;
`specs/007-read-api-mcp/` for the read API + MCP server; and `specs/008-map-data-explorer/` for the
map explorer + chat. The explorer has since evolved across `specs/009-017-*/`: document-reader + grid
(009), grid filters + facets (010), new-conversation chat (011), SVG map drill-down (012), hierarchical
region roll-up (013), publisher-derived geo recall (014), entities-only curate (015), the entity
knowledge graph (016), and grounded-chat hardening (017) — each with its clarified spec, plan, contracts,
and task list. The authenticated platform layer is `specs/018-022-*/`: agentic evals (018), identity +
admin settings + passkeys (019), persistent & resumable chat sessions (020), token metering & quotas
(021), and account & chat-UX (022). The latest UX + quality layer is `specs/023-026-*/`: region
multi-select + geo-filter roll-up + chat↔map selection + scope-aware recall (023), agentic-eval
hardening — auth, frontier judge, deterministic guards, expanded cases (024), chat answer presentation
+ anti-fabrication closure (025), and chat-UX polish + live usage telemetry (026).*
