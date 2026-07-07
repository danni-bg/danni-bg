<!-- SPECKIT START -->
For a current overview of the system — the `sync → curate → enrich → index`
pipeline, storage/schema, the explorer + serving layer, and the entity knowledge
graph — read `docs/ARCHITECTURE.md`.

Feature specs live under `specs/` (each is a full spec.md/plan.md/tasks.md set).
Foundational data substrate: `specs/001-egov-data-sync/` (sync/curate/enrich/index/MCP).
Map explorer + grounded-chat baseline: `specs/008-map-data-explorer/`. Subsequent
capabilities each have their own spec:
- 009 document reader + server-side grid · 010 grid filters + faceted search ·
  011 new-conversation/empty-state
- 012 SVG choropleth + oblast→municipality drill-down (real 265-municipality LAU geometry)
- 013 hierarchical region roll-up · 014 publisher-derived geo recall ·
  015 `danni curate --entities-only`
- 016 entity knowledge graph (`entity_relations`, predicate `part_of`, `GET /api/entities/:id`)
- 017 trustworthy grounded chat (anti-fabrication grounding, sticky context, auto-focus, value-filter)
- 018 agentic quality evals (`eval/agentic`, DeepEval; `bun run eval:agentic`) + grounding
  completeness (RAG row injection) & transparency (opt-in `grounding` SSE event)
- 019 identity (Ory Kratos+Oathkeeper, `infra/ory` + `docker-compose.yml`), tiered users
  (admin/user in app `users` table), gated chat, admin platform settings (runtime LLM config) — phased
- 020 persistent & resumable chat sessions (`chat_sessions`/`chat_messages`, `/api/me/sessions`),
  mid-stream resume via the in-memory `GenerationManager` + `/api/me/generations/:id/{stream,stop}` —
  supersedes FR-019 (chat history is now persisted per user)
- 021 per-user token metering & quotas (`token_usage`, `users.token_limit/usage_reset_at`,
  `chat/quota.ts`; admin `/api/admin/usage` + per-user limit/reset, `/api/me/usage`; cache-hit
  weighting + admin-configurable `defaultTokenLimit`/`cachedTokenWeight`/`maxOutputTokens`)
- 022 account & chat-UX (avatar `UserMenu`, display name from Kratos traits, profile pictures
  `users.avatar_url` + `/api/me/avatar`, full `/auth/settings` page, appearance in settings, header
  GitHub link, chat input-bar layout/tooltips, removed in-chat provider override)
- 023 region multi-select (Shift+click union on the map) + hierarchical geo-filter roll-up
  (`geo-rollup.ts` `expandGeoUnitIds` + `ReadBridge.partOfChildren`): an oblast geo filter expands to
  its municipalities so the list/facets/chat scope match the choropleth count (Стара Загора 638≠128)
- 024 agentic-eval hardening (extends 018): the `eval/agentic` suite authenticates against the gated
  chat, adds judge-independent deterministic guards (`guards.py`), a frontier judge (Qwen 3.7 Plus on
  Alibaba Model Studio — gemma-26b is an unreliable judge), and enumeration + geo-scoped cases
- 025 chat answer presentation (signal-to-noise): the shared `SYSTEM_PROMPT` tells the chat to
  reference datasets by Bulgarian title and never print raw ids/UUIDs in the answer (the `citations`
  event still carries each dataset's id + source URL for the UI to link)
- 026 chat UX + live usage telemetry: favicon + Claude-style typing animation; a live ↑input/↓output
  token meter via a new `usage` SSE event (per-step + final, billing unchanged); per-turn tokens +
  reply duration kept per message (migration 014 `usage_json`/`duration_ms`, restored on reload); one
  `UsageFooter` with identical live (ticking ⏱) and completed styling
- 027 API-key authentication for machine clients (`Authorization: Bearer dnk_live_…`, hashed
  `api_keys` migration 015, scopes `read`/`chat`; `requireAuth`/`requireScope`/`requireHuman`;
  `/api/me/api-keys` CRUD + account "API ключове" section). Keys never reach admin or key-management;
  the secret is shown once. Billing/metering of API calls is 028.
- 028 API metering, quotas & rate limiting: per-key request metering (`api_usage` migration 016,
  `ApiUsageRepo`), in-process token-bucket rate limits + a per-key/plan request quota on the public
  read API (`dataApiGate`: anon traffic stays free, keyed traffic is auth'd→limited→quota'd→recorded;
  `chatMeter` rate-limits + records the chat route), all runtime admin-configurable
  (`apiRate{Data,Chat}`/`apiQuota{Data,WindowSec}`); `/api/me/api-usage` + admin `/api/admin/api-usage`,
  per-key request count surfaced in the account "API ключове" section — builds on 027

- 029 multi-tenancy (control plane): `tenants`/`tenant_members` (org role `owner`/`admin`/`member`,
  migration 017) — note the table is `tenants`, since `organizations` already names egov dataset
  publishers. `tenant_id` added to `api_keys`/`chat_sessions`/`token_usage`/`api_usage`;
  `platform_settings` repivoted to composite `(tenant_id,key)` with a `global` fallback row (per-tenant
  config, FR-131). `requireAuth` resolves an active org (`TenantsRepo.ensureMembership` auto-joins new
  users to the `default` tenant); `requireTenantAdmin` gates org self-management (`/api/tenant` +
  members CRUD); super-admin org CRUD + per-tenant usage rollup under `/api/admin/tenants` +
  `/api/admin/api-usage` `byTenant`. Keys/usage/sessions are org-attributed; existing data backfills
  into the `default` org with no behavior change (SC-C1/C2/C3) — builds on 027/028

- 030–033 deployment & operations (production deployment, infra provisioning, observability,
  secret/image/network delivery) live in the **private `danni-bg/deploy`** repo — the commercial layer
  of the open-core split (this repo is EUPL-1.2). The app's own run/health/telemetry primitives stay
  here (`Dockerfile`, `docker-compose*.yml`, `scripts/docker-entrypoint.sh` + `check-secrets.ts`,
  `apps/explorer-api/src/{readiness,metrics,trace}.ts`); the scalable IaC (Terraform/k8s/observability),
  the `OPERATIONS.md` runbook, and the OpenBao/Headscale `vault` repo are commercial.

- 035 chat provider lockdown: the client-supplied `provider` (SSRF/egress vector) is removed from
  `/api/chat` — the strict schema 400s a request still sending it; `selectModel(serverDefault)` builds
  the model from admin runtime settings → `EXPLORER_DEFAULT_*` only, and the SPA/eval send no provider
  (finishes what 022 started in the UI)

- 038 API-key scope coverage for `/api/me`: every personal surface now declares an explicit access
  class (FR-200) enforced by the spec-027 guards instead of bare `requireAuth` — human-only
  (`requireHuman`: key CRUD + `PUT /avatar`), `chat` scope (`requireScope('chat')`: sessions
  list/read/delete + generation stream/stop), any-key (`allowAnyKey`: `GET /usage`+`/api-usage`
  self-introspection). Closes the gap where a leaked `read` key could read/delete chat history, stop
  live generations, and overwrite the avatar; a route enumeration test fails on any undeclared surface
- 039 chat metering integrity: the token quota was checked-then-recorded, so an errored/aborted/stopped
  turn consumed unmetered provider tokens. `chatHandler` now meters the tokens billed on EVERY exit path
  (`routes/chat.ts`): `onStepFinish`/`onUsage` accumulates per-step usage, a single-fire `meter()`
  records the peak-vs-reconciled total once per turn (FR-210/211; a graceful stop that resolves
  `totalUsage` to 0 falls back to the streamed accumulation), and reconnect/replay never re-records
  (FR-214). The token-quota 429 keeps its `used`/`limit` body and states no auto-reset via
  `details.resetsAt: null` — there is no scheduled reset to advertise (`usage_reset_at` is manual-only),
  with a Retry-After seam for when one exists (FR-212). The concurrent check-then-record overrun is a
  conscious, documented + tested bound (`quota.ts` `maxConcurrentOverrun` = (concurrentTurns−1) ×
  per-turn cost), not a distributed lock (FR-213). Rejection metrics stay spec 045 — builds on 021/028
- 040 request-quota & rate-limit semantics: fixes spec 028's mixed attribution. The data-API quota +
  rate principal is now the API KEY (`api-metering.ts`: rate bucket keyed by `key.id`,
  `ApiUsageRepo.countSinceForKey` filters `api_usage` by `key_id`), so a per-key `quota_limit` compares
  against that key's own usage — not the owner's aggregate (FR-220). `quota_limit` is settable/clearable
  via `ApiKeyRepo.setQuotaLimit` + super-admin `PUT /api/admin/api-keys/:id/quota` (billing policy —
  owners never set their own; `null` clears to the plan default) and is surfaced as `quotaLimit` in the
  key view (FR-221). One recording semantic on both gates: a request is counted IFF admitted past its
  gate (auth+scope+rate+quota); handler-level 400/404/5xx + the chat token-quota 429 still count —
  documented in the middleware (FR-222, preserves spec 039's chat token metering). The request-quota 429
  now sets `Retry-After` from `quotaWindowSec` (FR-223). `tenants.plan` is explicitly DEFERRED — it drives
  no runtime limit until a pricing spec, documented on the column + tenant route (FR-224). No migration
  (`quota_limit` existed since 016) — builds on 027/028/029
- 041 tenant activation (reachable non-default orgs): fulfils spec 029's FR-128/FR-132 beyond the
  `default` org. The active org is now an explicit, PERSISTED per-user selection (`users.active_tenant_id`,
  migration 018) — `requireAuth` resolves it via `TenantsRepo.activeMembership` (falls back to the
  primary/oldest membership when unset or stale, so a never-switching user is unchanged, FR-235).
  `POST /api/tenant/switch` (human-only) changes it to any org the caller belongs to (non-membership →
  404); super-admin `POST/DELETE /api/admin/tenants/:id/members` seed/remove members (any role incl.
  `owner`) on ANY org, keeping the ≥1-owner invariant; `GET /api/tenant/api-keys` (org-admin, via
  `listForTenant`) is the tenant-scoped key view. New keys/sessions/usage attribute to the caller's
  active org (FR-233). API-key requests keep the key's own tenant (keys are tenant-bound). Preserves
  spec 036's insert-only `addMember` + owner protection — builds on 027/029
- 042 tenant-scoped settings resolution: fulfils spec 029 FR-131 at the API layer (migration 017 made
  `platform_settings` `(tenant_id,key)`, but every caller read/wrote only `global`). Runtime resolution
  now goes through the caller's ACTIVE org (spec 041) — `settings.get(key, activeTenantId)`: tenant
  override wins, `global` is the fallback — for the chat LLM provider (`resolveServerDefault`) and the
  per-tenant `defaultTokenLimit`. Org admins manage their org's overrides via `GET/PUT
  /api/tenant/settings` (`requireTenantAdmin`); the overridable set is an explicit ALLOWLIST
  (`TENANT_OVERRIDABLE_KEYS` in `admin/tenant-settings.ts`: the LLM provider + `defaultTokenLimit` only;
  platform toggles + `apiRate*`/`apiQuota*` stay global — a non-allowlisted write is a 400). Super-admin
  views/clears any org's overrides via `GET/DELETE /api/admin/tenants/:id/settings`. Isolation invariant
  (FR-243): no tenant-facing response carries another tenant's or the global secret — an inherited LLM
  view exposes only `apiKeyConfigured` (never a hint); secret mask/merge mirrors the admin surface. No
  migration (017 sufficed). Repo gains `own()`/`clear()`. Builds on 019/029/041
- 043 store operational safety: the one `store/danni.sqlite` now holds SaaS state alongside the
  mirror, so `openDb` sets `PRAGMA busy_timeout` (5s, `DEFAULT_BUSY_TIMEOUT_MS`) — a second writer
  (pipeline vs. serving) queues instead of throwing `SQLITE_BUSY`; a `danni backup <dest>` CLI takes a
  verified online snapshot (WAL checkpoint + `VACUUM INTO` + `integrity_check`) with a restore runbook
  in `docs/backup-restore.md`; per-request `users.last_login_at` / `api_keys.last_used_at` bumps are
  throttled to at most once per 5 min (`repos/last-seen.ts` `bumpDue`), so steady-state authenticated
  reads perform zero writes (timestamps become "last use within N minutes")
- 053 MCP read parity: the two front doors over the shared read substrate (`src/read`) had drifted —
  the chat `readResource` tool exposed the spec-017 value-filter (`filters` → `GridQuery`) but the MCP
  `read_resource` tool (`src/mcp/server.ts`) could only page. The MCP tool now accepts optional
  `filters` (exact column → case-insensitive substring) + `sort` (`{col, dir?}`), passed straight
  through to the same `readResourceRows`/`GridQuery` call the chat/explorer use (identical matching
  rules, `MAX_GRID_SCAN` cap, pagination-after-filter, `gridTruncated` flag — specs 009/010/017
  unchanged, no parallel filter impl); a malformed `filters`/`sort` returns `isError:true`. A parity
  test asserts both doors return the same rows for the same `(datasetId, resourceId, filters)`;
  `docs/CONSUMERS.md` documents the extended contract (FR-350..353)

- 051 translation efficiency: the enrich/translate stage is now incremental. `translateSubjects`
  compares against the stored `(subject kind, subject id, translator)` row and SKIPS a subject whose
  source `text_bg` is unchanged (FR-330) — no translator call, no write; a changed source, new subject,
  or different translator id still translates. The dead `force` option (never read) + its stale
  `TranslationsRepo.upsert` comment are removed (FR-331; translator ids embed model version, so a
  model change re-translates without a flag). A no-op stub translator (`Translator.noop` —
  `LocalMarianMtTranslator` with no `translateFn`) short-circuits the whole stage with one
  `curate.translate-skipped-stub` log line (FR-332), keeping the `hosted-api` seam intact. The
  `curate.completed` log + `RunCurateResult` now report `translationsWritten`/`translationsSkipped`/
  `translationsEmpty` (FR-333)
- 052 pipeline write atomicity & one upsert idiom: codifies "one logical pipeline unit = one
  transaction" as the repo-wide convention (reference: `capture-dataset.ts:61`) and closes the
  unwrapped gaps — the egov per-resource success/failure triple (`egov-sync.ts`: resource upsert +
  `recordCapture` + checkpoint mark) and `registerEntities`' per-candidate entity-upsert + attach now
  run in one `withTransaction` (FR-340); `linkDatasetsForEntity` writes one entity's whole pairwise
  batch in a single transaction — one commit instead of up to ~1.2k WAL fsyncs on the full mirror —
  leaving `linkAllSharedEntities` a loop of per-entity transactions (FR-341). Repos now share ONE
  upsert idiom: a single atomic `INSERT … ON CONFLICT DO UPDATE` (all `INSERT OR REPLACE` sites
  migrated: `entities.attach`, `dataset-links`, `entity-relations`, `index-failures`,
  `sync-run-events`; `entities.upsert` collapsed from read-then-write to one statement, FR-342), and
  where an upsert must diff the old row (`datasets.upsert` field-level revision trail;
  `translations.upsert` keep-non-empty) the read+write run in one transaction so the diff can't race a
  stale row (FR-343). Convention recorded in `docs/ARCHITECTURE.md` §3 (FR-344); interrupt-safety
  tests assert a fault-injected mid-unit throw leaves no partial rows (FR-345). No migration; behavior
  unchanged (043/048/049/050/051 preserved)
- 048 egov scope fidelity: `scope` now means the same thing on every portal adapter. The egov-bg path
  previously honored only `scope.datasetIds` and froze the whole portal into the campaign checkpoint.
  Now `enumerateUris` filters `listDatasets` pages by the summary `org_id` (`egovSummaryInScope`,
  publisher identity `egov-org-<id>`; FR-300/303), `runEgovSync` applies the shared
  `buildScopePredicate` over the full `getDatasetDetails` as a per-dataset in-scope check — resolving
  `tags` (absent from the summary) and recording out-of-scope datasets as `outOfScope` rather than
  capturing (FR-301) — and `reconcileCatalog` reuses the same enumeration filter (FR-303). A scope
  field an adapter can't express (`categories` on egov) fails loud at sync start
  (`assertScopeSupported` → `UnsupportedScopeFieldError`, FR-302; never silently crawls a superset).
  The scoped campaign hash INPUT is versioned (`scope-hash.ts` `SCOPE_SEMANTICS_VERSION`, FR-304) so a
  pre-fix scoped campaign (which froze the full portal) re-keys to a fresh row; the `{ all: true }`
  full-portal sentinel stays unversioned and resumes untouched. Adapter-parity tests (SC-4) assert the
  egov filter and `buildScopePredicate` agree for the fields both support
- 050 search path at corpus scale: the hybrid search hot path no longer re-deserializes the whole
  embedding corpus per query. `search()` is split into ranking (`searchRanked` — FTS ⊕ cosine RRF over
  a resident, cached matrix; O(candidates) allocation) and projection; the matrix lives in
  `src/index/vector-cache.ts` (one copy per DB, WeakMap-keyed) and is invalidated in O(1) against
  `embeddings_meta.updated_at`, which each index run now bumps once it has written/purged vectors
  (`bumpEmbeddingsMeta` in `run-index.ts` — the previously-broken seam that only fired on model change,
  FR-320/321/325). The explorer `?query` route resolves hits through the bulk `listLite` projection
  (`ReadBridge.searchRanked` + one `listLite()`) instead of a per-hit `bridge.view()` fan-out, so a
  200-hit query runs a bounded number of statements (FR-323). `searchByEntity` now resolves
  `title.en`/`translator`/`translationConfidence` + `publisher` by the same rules as `search()` (one
  `IndexEntry` contract; `matchedEntities` stays entity-only, FR-324). `openDb` no longer loads
  sqlite-vec by default (`loadVec` defaults to `false`) and opens on a clean checkout without the
  (absent) vendored binary; the `vec0` path stays an opt-in operator seam (FR-322)

- 049 byte-faithful egov capture: the egov adapter used to run curation-grade transforms (CSV
  serialization, numeric heuristics, 2-row `flattenHeader`, envelope drop, absent-data → `[]`,
  JSON re-serialization) BEFORE writing `store/raw/`, so "raw" was a derived artifact and a
  header-flatten bug could only be fixed by re-crawling. Now `getResourceData` returns the VERBATIM
  response body and capture writes those exact bytes as `raw.json` (`store/raw/` is byte-faithful on
  both adapters — FR-310). All transformation moved into a `DatastoreJsonCurator`
  (`src/curate/datastore-json.ts`; `rowsToCsv`/`flattenHeader` + their tests moved out of
  `src/crawler/`), selected by the registry via the recorded `EGOV_DATASTORE_FORMAT` hint ahead of
  the generic `JsonCurator` (FR-311/312). It reuses the CSV/JSON/Text curators' cores, so curated
  output is unchanged. Migration is additive: existing `raw.{csv,json,txt}` archives still curate via
  the legacy curators, no re-crawl required (FR-313); a curation fix now re-runs from raw alone (FR-314)

- 058 chat session lifecycle extraction: the 676-line `ChatPanel` god-component is split — the whole
  session state machine (messages, streaming flag, live token/usage + elapsed meters, session id +
  localStorage persistence, the single session-message→`ChatMessage` mapper, and send/stop/new/open/
  delete/resume) now lives in `chat/useChatSession.ts` as a framework-agnostic zustand/vanilla store
  (`createChatSessionStore`, unit-tested like `explorerStore`) behind a thin React `useChatSession`
  hook; `ChatPanel` is layout + rendering + input only (FR-410). Mount-time restore routes its
  mid-stream resume through the SAME `attachStream` path as send/open — the duplicated ~55-line effect
  and the second mapper copy are gone (FR-411), so aborting a resume (new chat / switch / unmount) no
  longer throws an uncaught `AbortError` and a genuine network failure surfaces the shared
  `'мрежова грешка'` affordance (FR-412). Resumed turns OMIT `durationMs` rather than record a bogus
  from-re-attach value (FR-413; server `startedAt` is the non-blocking follow-on). The dead `onTool`
  callback + `tool` SSE case are dropped — the server still emits `tool`, which now falls through the
  router harmlessly (FR-414). The `sse.ts`/`dispatchSSEEvent`/`sendChat`/`resumeChat` transport layer
  is preserved unchanged; the hook composes it. Injectable transport/api/storage give `bun:test`
  coverage for send, resume, abort- and network-failure-during-resume, and new/open/delete (FR-415)
- 059 single-source frontend API types: the SPA no longer hand-mirrors the API's response shapes —
  every payload type has ONE definition, owned by the API app and consumed by the web app via
  `import type` only (erased at build, so the decoupled Vite bundle emits no server code; a backend
  field rename now breaks `bun run --cwd apps/explorer-web typecheck` instead of silently rendering
  `undefined`). `apps/explorer-web/src/types.ts` is now type-only re-exports from
  `apps/explorer-api/src/schemas.ts` (`DatasetPointer`/`RegionSummary`/`Facets`/`FilterState`/…) +
  the leaf `chat/sse-events.ts` (`Citation`/`MapAnchor`), plus only the client-only `Lang`/
  `EMPTY_FILTERS`/`ResourceContent` (a reduced read view). `DatasetDetail.tsx` imports
  `DatasetDetailView` (no inline `DetailView`); `lib/meApi.ts` imports the sessions-route shapes
  (`SessionSummary`/`ResumedSession`/`ChatMessage`) from `chat/session.ts`. The chat SSE contract is
  one shared `ChatSSEEventMap` (`chat/sse-events.ts`): the server serializes via `chatSSE(event,
  payload)` and `dispatchSSEEvent` decodes via `parseEventData<ChatSSEEventMap[...]>`, so an
  event/field change breaks both sides (FR-420..425). Web-facing sources are leaf modules
  (`schemas.ts`→zod-only, `sse-events.ts`/`session.ts`→no `bun:sqlite`) so the web type graph never
  pulls server runtime. Transport unification is spec 057; the chat lifecycle hook is spec 058
- 057 frontend server-state layer: the SPA now has ONE way to fetch, cache, and surface server state
  — including its failures. A single `request<T>(path, {method,body,params,authed})`
  (`lib/http.ts`, owns `buildUrl` + JSON headers + `credentials:'include'` when authed + non-OK →
  typed `HttpError`) is the sole HTTP convention; `lib/api.ts`/`meApi.ts`/`adminApi.ts` are thin
  typed facades that delegate to it (no hand-rolled `fetch → !res.ok → json` remains, FR-400). One
  in-house `useServerState(key, loader)` hook (`lib/useServerState.ts`; a framework-agnostic
  `runQuery` core unit-tested without a DOM, per the useChatSession precedent — NOT TanStack, FR-401)
  owns loading/error/data + cancel-on-unmount/key-change + in-flight dedup; the ~10 hand-rolled
  `fetch+useEffect+cancelled-flag` blocks (App regions/dataset-list, FilterPanel facets,
  DatasetDetail, ResourcePreview, SelfUsage, ApiKeys, AdminUsage, admin/SettingsPage) are converted
  (FR-402). Every core fetch now DISTINGUISHES "loaded empty" from "failed": the `.catch(()=>
  undefined)` swallows (App map layers/dataset list + FilterPanel facets) and the admin
  limit/reset void-discarded rejections are replaced with a shared error+retry affordance
  (`components/StatusMessage.tsx` `Loading`/`ErrorState`; the seven `Зареждане…` strings collapse to
  one, FR-403/405); admin save/reset go through non-throwing `admin/adminUsageActions.ts` that keep
  the attempted value on failure (FR-404). Behavior-preserving on the happy path (FR-406). Type
  single-sourcing is spec 059; the chat SSE lifecycle is spec 058 (untouched)

- 054 pipeline robustness (three independent papercuts, "failure/efficiency behavior is explicit,
  not incidental"): (a) curator selection sniffed the format by `readFileSync`-ing the WHOLE file to
  inspect 4KB — then the chosen curator re-read it — doubling curate I/O on the ~16k-resource mirror.
  `CuratorRegistry.readHead` (`src/curate/registry.ts`) now opens the fd and reads a single ≤4096-byte
  head (`SNIFF_BYTES`), never the whole file (FR-360/361). (b) the embed-retry classifier regexed
  `HTTP (\d{3})` out of `err.message`, so rewording `HostedApiEmbedder`'s throw silently degraded
  every 429/5xx into a permanent `content` failure (no backoff). The embedder now throws a TYPED
  `EmbedderHttpError` carrying `httpStatus` (`src/lib/errors.ts`) and `classifyEmbedError`
  (`src/index/batch-embed.ts`) switches on that status field — never the message; a reworded message
  no longer changes retry behavior (FR-362/363). (c) `resolveOrg` (`src/crawler/egov-sync.ts`) capped
  org paging at `MAX_ORG_PAGES=12` × 100, silently turning every publisher past #1200 into a
  placeholder `Организация N` row. It now pages `listOrganisations` to exhaustion (short-page stop;
  the retained bound is unreachable-high and logs when hit), and a still-unresolvable publisher is
  upserted with a sentinel `unresolved-org-<id>` slug + a `egov.org.unresolved` warning (org id +
  dataset uri) so placeholder rows are queryable, not silent (FR-364/365). No migration; 048/049/052
  preserved
- 060 frontend structure hygiene: every frontend concern gets one home, no dead affordances. Dataset
  selection moves INTO `explorerStore` (`selectedDataset` + `openDataset`/`closeDataset` beside
  `reader`/`chatFocus`); the `onSelectDataset` prop + its App→DatasetList/ChatPanel drilling are gone —
  a chat citation calls `store.openDataset()` directly (FR-430; map `focus`/hover stays local). An
  `AccountPage` (`account/AccountPage.tsx`, routed at `/auth/settings`) owns the account composition
  (avatar, appearance, usage, API keys + the Kratos settings sections via the reusable
  `KratosSettingsSections`); `KratosFlow` shrinks to the generic login/registration/recovery/
  verification renderer and its `createFlow`/`getFlow`/`submitFlow` triplet collapses to one
  kind→SDK-method `flowApi` map (FR-431/432). The unused `ui/input`+`ui/textarea` shadcn primitives
  are now USED across all hand-rolled input/textarea class sites (SettingsPage/KratosFlow/AdminUsage/
  ApiKeys/FilterPanel/ResourcePreview/SearchBar + the chat composer's transparent `Textarea`), size/
  variant deltas via `className` overrides (FR-433). `lib/format.ts` gains tested `formatNumber`
  (bg-BG) / `formatDate` (bg-BG medium, `null → '—'`) / one `initials(nameOrEmail)` — the
  `Intl`/`toLocaleString`/duplicate-`initials` sites all call them (FR-434). Dead exports deleted:
  `cycleTheme`, `RequireAuth`, `fetchRegion`, `isEmptyFilter`, `translationNote` + the whole
  `bilingualLabel`/`Lang`/`'en'` i18n-ahead-of-need branch (bg is the only exercised path; inlined to
  `titleBg`), with their orphaned tests (FR-435). Frontend-only; behaviour unchanged — builds on
  057/058/059

- 055 backend DRY consolidation: one shared implementation per repeated backend idiom (pure refactor,
  behavior-preserving). `parseBody(c, schema, opts)` (`apps/explorer-api/src/middleware/parse-body.ts`)
  replaces the copy-pasted `try{c.req.json()}catch→400` + `safeParse→400` block at all 8+ route sites
  (me/admin/tenant/chat) — returns the typed value or a 400 `{error:{code,message}}`; per-site messages
  + admin/tenant `details:'flatten'` + chat `details:'string'` stay expressible via opts (FR-370). The
  sync-runner epilogue is shared: `finalizeSyncRun(handle, totals, entries, {db,notifier,config,
  failedSummary})` owns the `summaryOutcome` ternary + `handle.end` + notifier dispatch, and
  `guardSyncRun(handle, fn)` owns the `LockContentionError`-rethrow/abort tail — both in
  `src/manifest/sync-run.ts` next to `beginSyncRun`; `run-sync.ts`/`run-egov-sync.ts` only parameterize
  the summary string (FR-371/372). `isStale(lastSyncedAt, sloSeconds, now?)` in `src/lib/time.ts` is
  the single staleness rule (strict `>`, nullish→stale, batch `now`) for `query.ts`/`dataset-view.ts`/
  `read-bridge.ts`/`server.ts` (FR-373). `ServerDefault` (`chat/providers.ts`) is now DERIVED from the
  canonical `llmSettingSchema` (`admin/settings-schema.ts`) — adding a provider `kind` is a one-line
  enum edit, guarded by a type-level test (FR-374; `providerConfigSchema` was already removed by 035).
  `authGate(deps)` composes `requireAuth` ONCE in `app.ts` and is handed to every gated router — fixing
  the live `routes/auth.ts` divergence where an API key on `/api/auth/*` got a generic session 401
  instead of key-aware handling (FR-375). The chat tool `pointer()` now derives from the shared
  `viewToPointer` (a documented minimal pick, FR-376). Existing route/runner tests stay green; new
  hermetic tests cover each helper (FR-377)

- 056 backend surface cleanup (wire-or-delete; the final remediation spec — no dead or inconsistent
  backend affordances). DELETED end-to-end: the never-read `lang` search option (`query.ts` +
  `Lang` type, MCP `mirror_search` schema, `ReadBridge.search`, chat `mirrorSearch` tool — FR-385);
  the duplicate `freshnessSloSeconds` toggle (`config.store.freshnessSloSeconds` is the sole owner —
  FR-387); `schedule.timezone` (cron fires in **server-local time**; strict schema fails loud on a
  config still carrying it — FR-388); `onOverlap: 'queue'` (was indistinguishable from `'skip'`; enum
  is now `['skip']`, `sync-run.ts` keeps the single `LockContentionError` throw, `Scheduler` drops its
  queue branch — FR-389); dead exports `upsertEmbeddingFor` (`index/vec.ts`) + `vecVersion`
  (`store/db.ts`) — FR-391. WIRED: `chatEnabled` is a real kill-switch — `POST /api/chat` refuses with
  a typed 503 `chat_disabled` before any model/quota work, resolved per request (tenant→global) so the
  admin toggle takes effect without a restart (FR-386). `CkanApiError` → **`PortalApiError`**
  (`PORTAL_API_ERROR`; thrown by every portal client, not just CKAN) with a deprecated
  `CkanApiError = PortalApiError` alias kept one release (FR-390). Pagination: `/api/me/sessions` +
  admin `/usage`/`/tenants`/`/api-usage` now take `limit`/`offset` (shared
  `apps/explorer-api/src/pagination.ts`, default 100 cap 200) and return `total` — no unbounded
  full-table lists; repos grew bounded variants + counts (FR-392). `/api/me` mounts UNCONDITIONALLY —
  `meRoutes(users, opts)` takes `tokenUsage` as optional, so keys/sessions/generations/avatar work with
  no metering wired and `/usage` returns a clear 501 `metering_unconfigured` when absent (FR-393). API
  versioning decided: `/api` is **v1-implicit** (no `/v1` prefix); the additive-only compatibility
  promise is documented in `docs/CONSUMERS.md` (FR-394)

Project constitution: `.specify/memory/constitution.md` (v1.1.1; the locked test runner is `bun:test`).
<!-- SPECKIT END -->
