# Feature Specification: Chat session lifecycle extraction

**Feature Branch**: `058-chat-session-lifecycle`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation):
`ChatPanel.tsx` is a 676-line god-component whose mount-time resume re-implements the tested
streaming path without its error handling.

## Overview

The chat's transport layer is exemplary — `chat/sse.ts` (pure decoder) → `dispatchSSEEvent` (pure
router) → thin `sendChat`/`resumeChat` wrappers with injectable `fetchImpl`/`AbortSignal`, all
unit-tested. Everything above it collapsed into one component: session persistence, resume, live
meters, message patching, history CRUD, and all rendering live in `ChatPanel.tsx`. The cost is
already visible: the mount-time resume duplicates the streaming lifecycle minus its try/catch, so
aborting a resume throws an uncaught `AbortError` and a network failure during resume surfaces
nothing.

Single responsibility: **the chat session lifecycle lives in one tested state machine, not in the
component.** The transport layer below it is preserved unchanged.

## Finding & evidence

- **God-component.** `apps/explorer-web/src/chat/ChatPanel.tsx` (676 lines) owns localStorage
  session persistence (`:20,268-272`), mount-time restore + mid-stream resume (`:173-265`), live
  token/elapsed meters (`:142-150,164-170`), message patching (`:280-301`), history CRUD
  (`:412-453`), and all rendering (`:457-676`). The session-message → `ChatMessage` mapper is
  duplicated inside the file (`:187-194` vs `:423-430`).
- **Mount-resume bypasses `attachStream`.** The restore effect re-implements ~55 lines of what
  `attachStream` (`:305-358`) already does — controller, `startAt`, `text`/`cites`/`finalUsage`
  accumulators, `patch`, `onDone` stamping — but WITHOUT its try/catch: `void resumeChat(...)`
  `.finally(() => setStreaming(false))` at `:218-255`. Aborting mid-resume (clicking
  `'Нов разговор'`, opening another session, or unmount) rejects `reader.read()` with an uncaught
  `AbortError`, and a genuine network failure surfaces no error (the `onError` callback only covers
  server-sent `error` events, not a rejected fetch/read).
- **Resumed-turn duration is fabricated.** Duration is measured from re-attach, not generation
  start: `startAt = Date.now()` at `:204` (mount resume) and inside `attachStream` at `:312` (used
  by `openSession`'s resume, `:435`). The `durationMs` stamped at `:240-247`/`:343` under-reports —
  a 60s generation resumed at second 55 records ~5s, and that wrong value is what the turn displays.
- **Dead `tool` event plumbing.** `chat/sendChat.ts:12` declares `onTool` and `:46-50` routes the
  `tool` SSE event to it; the server emits it (`apps/explorer-api/src/routes/chat.ts:337-340`), but
  no `ChatCallbacks` instance in the app provides `onTool` (only the unit test does). Verdict:
  **drop** `onTool` and the `tool` dispatch case until a tool-status UI is actually designed —
  unknown events fall through the switch harmlessly, so the server contract is untouched.
- **To preserve:** `chat/sse.ts`, `dispatchSSEEvent`, and the `sendChat`/`resumeChat` wrappers with
  their tests (`sse.test.ts`, `sendChat.test.ts`) — the new hook composes them, never reaches
  around them.

## Requirements

- **FR-410**: A `useChatSession()` hook (or equivalent module under `apps/explorer-web/src/chat/`)
  MUST own the session state machine: messages, streaming flag, live usage/elapsed meters, session
  id + localStorage persistence, send/stop/new/open/delete/resume operations, and the
  message-mapper. `ChatPanel` keeps only layout, rendering, and input handling.
- **FR-411**: Mount-time restore MUST route its mid-stream resume through the same `attachStream`
  path as `send` and `openSession` — the duplicated block at `ChatPanel.tsx:197-255` and the second
  mapper copy are deleted; exactly one attach lifecycle and one mapper exist.
- **FR-412**: Aborting a resume (new chat, switching sessions, unmount) MUST NOT produce an
  unhandled rejection, and a genuine network failure during resume MUST surface the same error
  affordance as a failed send (`'мрежова грешка'`), distinguishable from a user-initiated stop.
- **FR-413**: A resumed turn MUST NOT display or persist a duration measured from re-attach.
  Either the server includes the generation's start time in the resume payload (e.g. `startedAt` on
  `GET /api/me/sessions/:id` `streaming` or as an SSE event) and the client computes true duration,
  or the client omits `durationMs` for resumed turns. **Recommendation: omit unless the server
  provides `startedAt`** — an absent metric beats a wrong one; the server change is a follow-on.
- **FR-414**: `onTool` (`sendChat.ts:12`) and the `tool` case (`sendChat.ts:46-50`) are removed,
  along with their test assertions; the SSE router ignores unrecognized events by construction.
- **FR-415**: The hook MUST be unit-testable like the layer beneath it: injectable transport
  (`sendChat`/`resumeChat`/session API) and storage, with `bun:test` coverage for send, resume,
  abort-during-resume, network-failure-during-resume, and new/open/delete transitions. Existing
  `sse.ts`/`sendChat.ts` tests pass unchanged (minus the deleted `tool` case).

## Success criteria

- **SC-1**: `ChatPanel.tsx` contains no `AbortController`, `resumeChat`, `localStorage`, or
  message-mapping logic; the session mapper and attach lifecycle each exist exactly once.
- **SC-2**: Reload during a generation, then click `'Нов разговор'` mid-resume: no unhandled
  rejection; kill the API mid-resume: the error affordance appears (both as automated hook tests).
- **SC-3**: A resumed turn shows either the true duration (server-provided start) or no duration —
  never a from-re-attach value (test with a mocked resume at a known offset).
- **SC-4**: `grep -rn "onTool" apps/explorer-web/src` returns nothing; full suite green.

## Out of scope / dependencies

- Request/response server state (sessions list uses spec **057**'s layer where it is a plain GET).
- Shared SSE payload types between server and client — **spec 059**.
- Replacing the `onSelectDataset` citation callback with a store action — **spec 060** (the hook
  should not bake the prop-drilled callback into its API).
- Server-side `GenerationManager` semantics and token metering (specs **020/021/026**) unchanged;
  the optional `startedAt` addition is the only server follow-on and is non-blocking.
