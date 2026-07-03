# Feature Specification: Chat metering integrity

**Feature Branch**: `039-chat-metering-integrity`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): chat token
usage is recorded only on fully-successful turns, so errored/aborted turns consume unmetered provider
tokens, and quota 429s are poor HTTP citizens.

## Overview

The chat token quota (spec 021) is enforced check-then-record: the gate runs before the turn, the
usage write runs after it. Every path between the two — provider error, tool failure, user-initiated
stop, process-level abort — consumes real provider tokens that never reach `token_usage`. A user can
also fan out N concurrent turns that all pass the same pre-check. Billing correctness of a metered
SaaS depends on closing these gaps deliberately.

Single responsibility: **every token the provider bills is metered, and quota rejections are correct
HTTP citizens.** Request-count metering semantics are spec 040; rejection observability is spec 045.

## Finding & evidence

- **Unmetered error paths** — `apps/explorer-api/src/routes/chat.ts:80-96` checks the quota up front;
  the only `usage.record(...)` call is at `chat.ts:241-252`, inside the success path after
  `runChatTurn` returns. The `catch` at `chat.ts:194-198` re-throws without recording, although by
  then the provider has already billed the tokens of every completed step. A user-initiated stop
  (`/api/me/generations/:id/stop`) aborts via the same throw path — stopping just before `done` yields
  a free turn.
- **Partial usage IS available** — the runner accumulates per-step usage in `onStepFinish` and emits
  it via `events.onUsage` (`apps/explorer-api/src/chat/run.ts:250-254`, final reconcile at `287`), so
  the accumulated count exists at the moment of any failure; it is simply discarded.
- **Check-then-record race** — the pre-check at `chat.ts:80-96` reads `token_usage`; N concurrent
  turns from one user all read the same total and all pass, so a user at 99% of quota can overrun by
  up to (N−1) × per-turn max. Nothing in the code acknowledges or bounds this.
- **Quota 429 lacks retry semantics** — the token-quota rejection (`chat.ts:85-95`) returns a body
  with `used`/`limit` but no `Retry-After`; compare `middleware/api-metering.ts:35-38`, which sets it
  on rate-limit 429s. *Correction to the review finding:* the token window end is currently **not**
  computable — `users.usage_reset_at` (`src/store/repos/users.ts:17`) marks the window **start** and
  only moves on manual admin reset, so there is no scheduled reset time to advertise. The requirement
  below is therefore conditional.
- No rejection counter is incremented on the quota-429 path (no `deps.metrics` call before the
  return at `chat.ts:85-95`) — the metric itself is **spec 045**; this spec only guarantees the
  rejection path is reachable/testable for it.

## Requirements

- **FR-210**: A chat turn MUST record its accumulated token usage to `token_usage` when the turn ends
  for **any** reason — success, provider/tool error, user stop, or abort — using the per-step usage
  already surfaced by `onStepFinish`/`onUsage`. Tokens billed by the provider before the failure MUST
  NOT be lost.
- **FR-211**: Exactly one `token_usage` record MUST be written per turn regardless of outcome
  (no double-count when the final reconciled usage arrives after per-step accumulation; the final
  authoritative total wins when both exist).
- **FR-212**: The token-quota 429 MUST keep its machine-readable body (`used`, `limit`) and MUST set
  `Retry-After` whenever a quota reset time is known. While resets remain manual/admin-only (no
  computable window end), the response MUST instead state that the quota does not auto-reset
  (e.g. a `resetsAt: null` field) — silently omitting retry semantics is not acceptable.
- **FR-213**: The concurrent check-then-record overrun MUST be a conscious, bounded decision: either
  (a) concurrent turns per user are capped (a second in-flight turn is rejected or queued), or
  (b) the overrun is accepted and its bound — (concurrent turns − 1) × `maxOutputTokens`-derived
  per-turn cost — is documented in `chat/quota.ts` and asserted by a test. The choice MUST be recorded
  in the code, not left implicit.
- **FR-214**: An aborted-then-resumed generation (spec 020 `GenerationManager`) MUST NOT meter twice:
  reconnecting to a live generation replays events without re-recording usage.

## Success criteria

- **SC-1**: A turn whose provider call throws after ≥1 completed step leaves a `token_usage` row whose
  totals equal the per-step accumulation at the moment of failure (integration test with a failing
  fake provider).
- **SC-2**: Stopping a generation mid-stream via the stop endpoint records the streamed-so-far usage;
  repeating stop/reconnect does not create a second row.
- **SC-3**: The quota 429 response either carries `Retry-After` or an explicit no-auto-reset marker;
  asserted by a route test.
- **SC-4**: A test launching concurrent turns for one near-quota user demonstrates the chosen FR-213
  behavior (cap enforced, or overrun within the documented bound).

## Out of scope / dependencies

- Quota-rejection **counters/metrics** — spec **045** (observability); this spec only makes the paths
  deterministic enough to count.
- Request-count metering semantics of `chatMeter` (what counts as a chat *request*) — spec **040**.
- Quota math and limits themselves (spec **021**) and tenant attribution of usage (spec **029/041**)
  are unchanged; this spec changes *when* the existing record is written, not its shape.
