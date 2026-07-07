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

Project constitution: `.specify/memory/constitution.md` (v1.1.1; the locked test runner is `bun:test`).
<!-- SPECKIT END -->
