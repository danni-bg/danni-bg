# Feature Specification: API-key scope coverage for personal (/api/me) surfaces

**Feature Branch**: `038-api-key-scope-coverage`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): a read-only
API key passes `requireAuth` on all of `/api/me` — it can read/delete the owner's chat sessions, stop
live generations, and mutate the profile; only key management is human-gated.

## Overview

Spec 027 defined the scope model (`read`/`chat`) and correctly barred keys from admin and from key
management — but the rest of `/api/me` was mounted behind bare `requireAuth`, which resolves a key to
its owning user and then treats it like a human session. A leaked read-only key therefore reaches chat
history (deletion included), live-generation control, and the avatar mutation — all outside anything
"read" scope should mean. This spec declares an access class for every personal surface and enforces
it with the existing spec-027 guards (`requireHuman`/`requireScope`).

Single responsibility: **every `/api/me` surface declares and enforces who may touch it (human vs key
scope).**

## Finding & evidence

All in `apps/explorer-api/src/routes/me.ts` (mounted behind `requireAuth` with the key repo wired,
line 60, so keys authenticate everywhere below):

- Lines 65-94 — API-key CRUD is correctly `requireHuman` (the only guarded surfaces in the file).
- Line 100-104 — `GET /api-usage` and line 107-120 — `GET /usage`: any key reads the owner's API/token
  usage (acceptable for self-introspection, but currently accidental, not declared).
- Lines 123-136 — `PUT /avatar`: ANY key (including read-only) can overwrite or clear the owner's
  profile picture — a pure account mutation with no machine use case.
- Lines 141-157 — `GET /sessions`, `GET /sessions/:id`, `DELETE /sessions/:id`: a read-only key lists,
  reads, and DELETES the owner's chat history.
- Lines 165-190 — `GET /generations/:id/stream` and `POST /generations/:id/stop`: a read-only key can
  attach to or kill the owner's live chat generations.
- Contrast: keys are blocked from admin (`middleware/require-auth.ts:133-135`) and the chat route
  itself is `requireScope('chat')`-gated — the gap is only `/api/me`.

## Requirements

- **FR-200**: Every `/api/me` route MUST carry an explicit access class — `human-only`, `chat` scope,
  or `any-key` — enforced by the existing guards (`requireHuman`, `requireScope`; spec 027 model, no
  new scope vocabulary). No `/api/me` route may remain behind bare `requireAuth` alone.
- **FR-201**: Human-only: API-key CRUD (`/api-keys*`, already enforced) and `PUT /avatar` (account
  profile mutation). An API-key caller gets the existing 403 `forbidden` "requires a signed-in
  session".
- **FR-202**: `chat` scope required: `GET /sessions`, `GET /sessions/:id`, `DELETE /sessions/:id`,
  `GET /generations/:id/stream`, `POST /generations/:id/stop`. These are chat surfaces — a key that
  may hold conversations may also manage/resume its own; a `read`-only key gets 403
  `insufficient_scope`.
- **FR-203**: Any valid key: `GET /usage` and `GET /api-usage` — self-introspection of quota and
  request usage so machine clients can throttle themselves (consistent with spec 028 surfacing
  per-key usage). Human sessions keep full access to everything, unchanged.
- **FR-204**: The access matrix MUST be covered by tests: for each surface, a human session, a
  `read`-scoped key, and a `chat`-scoped key, asserting the exact status (200/403) and error code.
  Adding a new `/api/me` route without declaring a class MUST be visible in review (e.g. routes are
  registered through a helper/table that requires the class, or a test enumerates routes).

## Success criteria

- **SC-1**: A `read`-scoped key gets 403 on session list/read/delete, generation stream/stop, and
  avatar; a `chat`-scoped key succeeds on session/generation surfaces but still gets 403 on avatar
  and key CRUD — all asserted by the FR-204 matrix tests.
- **SC-2**: Any valid key can `GET /usage` and `GET /api-usage` for its owner (200) — machine
  self-throttling keeps working.
- **SC-3**: Human-session behavior across `/api/me` is byte-identical (existing me-routes tests pass
  unmodified except where they asserted the old key leniency).

## Out of scope / dependencies

- Builds on **spec 027** (key auth + `read`/`chat` scopes + guards) and **spec 020** (sessions,
  generations); usage surfaces from **specs 021/028**. Admin gating is already correct and untouched.
- New scopes (e.g. a write/manage scope) and per-key session ownership (keys currently act as their
  owning user; tenant attribution is spec 029) are deferred.
