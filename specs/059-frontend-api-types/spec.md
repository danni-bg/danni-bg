# Feature Specification: Single-source frontend API types

**Feature Branch**: `059-frontend-api-types`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): API
response types are hand-mirrored from the backend inside the same repo, so contract drift is
invisible to the compiler.

## Overview

The SPA and the API live in one repository and one type-checked codebase (`bun run typecheck` runs
a single `tsc --noEmit` from the root), yet the frontend maintains a hand-copied mirror of the
API's response shapes. A field renamed in `apps/explorer-api/src/schemas.ts` compiles cleanly while
the SPA keeps rendering `undefined`. Type-only imports are erased at build time, so the original
"decoupled web build" goal survives sharing.

Single responsibility: **every API payload type has exactly one definition shared by both sides.**

## Finding & evidence

- **The mirror is deliberate but obsolete.** `apps/explorer-web/src/types.ts:1-2` says "Kept
  independent of the backend package so the web build stays decoupled" and then structurally
  duplicates `apps/explorer-api/src/schemas.ts`: `FreshnessBlock`, `FreshnessFilter`,
  `FilterState`, `ScopeDescriptor`, `DatasetPointer` (types.ts:48-59 vs schemas.ts:64-75),
  `RegionSummary` (types.ts:61-73 vs schemas.ts:77+), `Facets`.
- **Chat types are a second mirror.** `types.ts:75-80` `Citation` and `:82-85` `MapAnchor`
  duplicate `apps/explorer-api/src/chat/grounding.ts:11-21`.
- **A third, inline copy.** `apps/explorer-web/src/datasets/DatasetDetail.tsx:10-19` declares its
  own `DetailView` for `GET /api/datasets/:id`, shadowing the API's exported `DatasetDetailView`
  (`schemas.ts:124`).
- **SSE payloads are typed twice, loosely.** The server hand-writes `JSON.stringify` payloads per
  event (`apps/explorer-api/src/routes/chat.ts:266-352`); the client re-declares each shape as an
  inline generic in `dispatchSSEEvent` (`chat/sendChat.ts:35-71`). `lib/meApi.ts:32-55` likewise
  re-declares the sessions-route shapes (`SessionMessage`, `ResumedSession`).
- **Wiring check (mechanism verified).** The root `package.json` declares **no `workspaces`** —
  this is a single package with app subdirectories, so a `packages/api-types` workspace package
  would first require introducing workspaces (unearned). Cross-directory relative imports are
  already established practice: `App.tsx:3` imports from `packages/geo-boundaries/`, and
  `grounding.ts:7` imports `../../../../src/read/dataset-view.ts`. The web tsconfig
  (`moduleResolution: "Bundler"`, `allowImportingTsExtensions: true`) type-checks imported files
  outside its `include` list. **Therefore: type-only relative imports from
  `apps/explorer-api/src` are the viable mechanism**, and the one this spec mandates.
- Note: on the API side `FilterState`/`ScopeDescriptor`/`FreshnessBlock` are already zod-inferred;
  the view models (`DatasetPointer`, `RegionSummary`, `DatasetDetailView`, `Facets`) are plain
  interfaces. Either kind is a valid single source — zod-inferring the view models is optional
  hardening, not a prerequisite.

## Requirements

- **FR-420**: Every payload type the SPA renders MUST have exactly one definition, owned by the API
  app (`schemas.ts`, `chat/grounding.ts`, or a new SSE-events module), consumed by the web app via
  `import type` only.
- **FR-421**: `apps/explorer-web/src/types.ts` becomes type-only re-exports of the API definitions
  (keeping existing import paths working) plus the genuinely client-only items (`Lang`,
  `EMPTY_FILTERS`, `ProviderConfig` if the API has no equivalent); its "kept independent" comment
  is replaced with the sharing rationale. No structural duplicate of an API type remains under
  `apps/explorer-web/src`.
- **FR-422**: `DatasetDetail.tsx:10-19` imports `DatasetDetailView` instead of declaring
  `DetailView`; `lib/meApi.ts`'s session shapes are imported from (or re-exported by) the API's
  sessions module rather than re-declared.
- **FR-423**: The chat SSE contract MUST be one shared definition — e.g. an exported
  `ChatSSEEventMap` (event name → payload type) in the API app — used by the server's `writeSSE`
  call sites and by `dispatchSSEEvent`'s `parseEventData<...>` generics, so adding/renaming an
  event or field breaks both sides at compile time.
- **FR-424**: All cross-app imports introduced by this spec MUST be type-only (`import type`), so
  the Vite build emits no API-app code; the production bundle is byte-comparable (modulo hashes) to
  the pre-change bundle. If enforcement is desired, enabling `verbatimModuleSyntax` in the web
  tsconfig is the follow-on switch — evaluate in the plan.
- **FR-425**: Drift MUST be compiler-visible: renaming or retyping a field in `schemas.ts` (or the
  SSE map) fails `bun run typecheck` via the web app's usage. Existing runtime behavior is
  unchanged; no new runtime validation is added on the client.

## Success criteria

- **SC-1**: `grep -n "interface DatasetPointer\|interface RegionSummary\|interface Citation\|interface DetailView"`
  under `apps/explorer-web/src` returns nothing — only `import type`/re-export lines reference
  these names.
- **SC-2**: Mutation test: rename `DatasetPointer.titleBg` in `schemas.ts` → `bun run typecheck`
  fails in `apps/explorer-web`; revert → green. Same for one SSE payload field.
- **SC-3**: `bun run --cwd apps/explorer-web build` succeeds and the bundle contains no code from
  `apps/explorer-api` (type-only imports erased); `bun test` green.

## Out of scope / dependencies

- Transport unification (shared `request<T>` helper) — **spec 057**; this spec is types only.
- The chat lifecycle hook — **spec 058** (it consumes the shared SSE map from here; either spec can
  land first — 058 keeps inline generics until FR-423 lands).
- Zod-inferring the API view models and validating responses at runtime — optional hardening,
  deferred.
- A `packages/api-types` workspace package — explicitly rejected while the repo has no
  `workspaces` field; revisit only if the apps are ever split into separately published packages.
