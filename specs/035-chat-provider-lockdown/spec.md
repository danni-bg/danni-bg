# Feature Specification: Chat provider lockdown (remove client-supplied provider)

**Feature Branch**: `035-chat-provider-lockdown`
**Created**: 2026-07-03
**Status**: Implemented (`provider` removed from the strict `chatRequestSchema` → 400 for stale
clients; `selectModel(serverDefault)` takes server config only; SPA sends no provider; contract doc +
eval suite updated)
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): `/api/chat`
still accepts a client-supplied provider (arbitrary baseUrl + apiKey), making the server an egress
proxy / SSRF vector; spec 022 removed only the UI, not the API surface.

## Overview

Spec 022 removed the in-chat provider override from the UI because it bypasses the platform LLM config
and token metering — but the request schema still REQUIRES a provider object, and the backend will
happily build an HTTP client against any `baseUrl` the caller supplies. Any signed-in user (or
chat-scoped API key) can point the server at an arbitrary URL — including internal/LAN endpoints such
as an unauthenticated vLLM — and relay traffic through it. Meanwhile the frontend has to fabricate a
dummy provider just to satisfy the schema. This spec deletes the client-supplied provider entirely:
the server-configured provider (admin runtime settings, spec 019, with the env default as fallback) is
the only model source.

Single responsibility: **the chat runs only against the server-configured provider.**

## Finding & evidence

- `apps/explorer-api/src/routes/chat.ts:35` — `chatRequestSchema` has `provider: providerConfigSchema`
  as a required field; `apps/explorer-api/src/chat/providers.ts:12-20` shows that schema accepts an
  arbitrary `baseUrl` and `apiKey`.
- `apps/explorer-api/src/chat/providers.ts:78-100` — `selectModel` with `useServerDefault` unset
  builds a client against the caller's config (line 99 → `build(config.kind, config.model,
  config.baseUrl …)`), i.e. request-controlled `baseURL` reaches `createOpenAI`/`createAnthropic`.
  The only guard is that some `apiKey` string must be present (lines 93-98) — trivially satisfied.
  Wiring: `apps/explorer-api/src/app.ts:218` passes the request's provider straight to `selectModel`.
- `apps/explorer-web/src/chat/ChatPanel.tsx:25-31` — the client fabricates `SERVER_DEFAULT_PROVIDER`
  (model `'server-default'`, `useServerDefault: true`) purely to satisfy the required schema field —
  dead weight that documents the design smell.
- Impact: with LAN-reachable model endpoints (project context: unauthenticated vLLM hosts), any
  chat-capable caller gets server-side request forgery into the internal network plus free use of
  internal GPUs; with a paid provider key configured client-side, the server launders arbitrary
  egress.

## Requirements

- **FR-170**: The `provider` field MUST be removed from the chat request schema. The schema stays
  `.strict()`, so a request still sending `provider` fails validation with 400 — an intentional,
  visible break for any stale client. (Considered alternative: keep the field optional-and-ignored for
  a deprecation window; rejected — the only known client is our SPA, shipped from the same process, so
  a silent-ignore window would just hide bugs.)
- **FR-171**: The backend MUST resolve the language model exclusively from server-side configuration:
  admin runtime settings (spec 019) with the `EXPLORER_DEFAULT_*` env default as fallback. No value
  derived from the request body may reach client construction (`baseURL`, `apiKey`, `model`, `kind`).
  `selectModel`'s client-supplied branch (providers.ts:93-99) is deleted; the `ProviderConfig`
  request type disappears from the route contract.
- **FR-172**: The frontend `SERVER_DEFAULT_PROVIDER` sentinel (`ChatPanel.tsx:25-31`) and the
  `provider` argument threading through `sendChat` MUST be deleted; the SPA sends no provider.
- **FR-173**: When no server provider is configured, the route MUST still fail with the typed
  `provider_unconfigured` error over the SSE `error` event, with no fabricated content (preserves the
  008/017 anti-fabrication guarantee).
- **FR-174**: The contract doc (`specs/008-map-data-explorer/contracts/http-api.md` chat request) and
  the chat-route tests MUST be updated to the provider-less request shape; a regression test MUST
  assert that a request containing `provider` is rejected.

## Success criteria

- **SC-1**: A signed-in user (and a chat-scoped API key) POSTing a chat request with
  `provider.baseUrl` pointing at a test listener gets 400 and the listener records zero connections.
- **SC-2**: `grep` finds no code path from the chat request body to `createOpenAI`/`createAnthropic`
  arguments; `selectModel` accepts only server-derived config.
- **SC-3**: The SPA chat works unchanged end-to-end against the admin-configured provider; changing
  the provider in admin settings takes effect without a client change.
- **SC-4**: `bun run eval:agentic` (spec 018/024) passes against the provider-less API.

## Out of scope / dependencies

- Admin runtime LLM settings stay as-is (**spec 019**); token metering (**spec 021**) and API-key
  scopes (**spec 027**/**038**) are unaffected. UI removal history: **spec 022**.
- Per-tenant provider config (a tenant-scoped model choice via `platform_settings`, **spec 029**
  FR-131) remains a server-side concern and is not blocked by this removal.
