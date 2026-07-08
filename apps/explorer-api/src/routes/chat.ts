// POST /api/chat — backend-mediated, grounded, streaming chat (T049). SSE event types per
// contracts/http-api.md: session, token, tool, citations, anchors, done, error. The browser never
// calls the LLM or the mirror tools directly (FR-016). The provider is resolved server-side only
// (admin runtime settings → env default, spec 035 FR-170/171): the strict request schema rejects a
// client-supplied `provider` with 400. Secrets live in the provider seam and are never logged
// (FR-024).

import type { LanguageModel, ModelMessage } from 'ai';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { estimateCost, pricingFor } from '../../../../src/lib/llm-cost.ts';
import type { TokenUsageRepo } from '../../../../src/store/repos/token-usage.ts';
import type { UserRow } from '../../../../src/store/repos/users.ts';
import type {
  GenEvent,
  GenSnapshot,
  GenerationManager,
  UsageInfo,
} from '../chat/generation-manager.ts';
import { billableTokens, effectiveLimit, quotaView } from '../chat/quota.ts';
import { runChatTurn } from '../chat/run.ts';
import { type ConversationStore, MAX_CONTEXT_DATASETS, windowMessages } from '../chat/session.ts';
import { chatSSE } from '../chat/sse-events.ts';
import { expandGeoUnitIds } from '../geo-rollup.ts';
import type { Metrics } from '../metrics.ts';
import { parseBody } from '../middleware/parse-body.ts';
import type { ReadBridge } from '../read-bridge.ts';
import { scopeDescriptorSchema } from '../schemas.ts';
import { Tracer } from '../trace.ts';
import { ProviderError } from './../chat/providers.ts';

export const chatRequestSchema = z
  .object({
    sessionId: z.string().nullable().optional(),
    message: z.string().min(1),
    scope: scopeDescriptorSchema.optional(),
    /**
     * Datasets to ground the turn in (their rows are injected as context) WITHOUT restricting tool
     * scope — e.g. the dataset currently open in the reader. Distinct from `scope.datasetIds`, which
     * is a hard focus that also narrows what tools may read.
     */
    groundingDatasetIds: z.array(z.string()).optional(),
    /** When true, emit a `grounding` SSE event with the exact context injected into the model.
     * For observability / offline faithfulness evals; clients don't set it in normal use. */
    debug: z.boolean().optional(),
  })
  .strict();

export interface ChatRouteDeps {
  bridge: ReadBridge;
  sessions: ConversationStore;
  /** Runs turns detached so they survive a client disconnect (mid-stream resume). */
  generations: GenerationManager;
  /** Resolves the language model from server-side configuration only (spec 035 FR-171), through the
   * caller's active org so a per-tenant LLM override applies (spec 042 FR-240). */
  selectModel: (tenantId?: string) => LanguageModel;
  /** Per-user token metering (optional; omitted in focused unit tests). */
  usage?: TokenUsageRepo;
  /** Resolve the platform default token quota (0/undefined = unlimited) per request, through the
   * caller's active org (spec 042 FR-240): a per-tenant `defaultTokenLimit` override applies. */
  defaultTokenLimit?: (tenantId?: string) => number | undefined;
  /** Resolve the cache-hit token weight (0–1) per request; undefined = default. */
  cacheWeight?: () => number | undefined;
  /** Resolve the max output tokens per answer; undefined = built-in default. */
  maxOutputTokens?: () => number | undefined;
  /** Kill-switch (spec 056 FR-386): resolve whether chat is enabled per request, through the caller's
   * active org (spec 042 tenant→global fallback). Returns `false` → the route refuses with 503
   * `chat_disabled` before any model/quota work. Undefined (unwired) or an unset toggle = enabled. */
  chatEnabled?: (tenantId?: string) => boolean;
  /** Telemetry registry (spec 032): chat outcome + LLM tokens/cost are recorded when wired. */
  metrics?: Metrics;
  /** When the user's token window next resets, if that time is knowable — else null. Injectable seam
   * for FR-212 (spec 039): the built-in default always returns null (token resets are manual/admin-only),
   * so no Retry-After is advertised; a future scheduled-reset feature supplies a real time here without
   * touching the 429 shape. Overridable in tests to exercise the Retry-After path. */
  quotaResetsAt?: (user: UserRow) => string | null;
}

/**
 * When the user's token window next resets to zero, if that time is knowable — else null. Token resets
 * are currently manual/admin-only (spec 021: `usage_reset_at` records the window START and only moves
 * on an admin reset), so there is no scheduled end to advertise and this returns null. The seam stays
 * so a future scheduled-reset feature sets a real Retry-After without touching the 429 shape (FR-212).
 */
function quotaResetsAt(_user: UserRow): string | null {
  return null;
}

export function chatHandler(deps: ChatRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const body = await parseBody(c, chatRequestSchema, {
      message: 'invalid chat request',
      details: 'string',
    });
    if (body instanceof Response) return body;

    // Enforce the per-user token quota up front (token metering): an over-quota user is rejected with
    // 429 before any model work. `user` is set by requireAuth; metering is skipped if no repo is wired.
    const user = c.get('user') as UserRow | undefined;
    // Active org (spec 029): session + usage are attributed to the caller's tenant.
    const tenantId = (c.get('tenant') as { id: string } | undefined)?.id;
    // Kill-switch (spec 056 FR-386): when the resolved toggle is false, refuse BEFORE any model or
    // quota work. Read per request so flipping the admin toggle takes effect without a restart; an
    // unset toggle (or no resolver wired) stays enabled.
    if (deps.chatEnabled && !deps.chatEnabled(tenantId)) {
      return c.json(
        { error: { code: 'chat_disabled', message: 'chat is currently disabled' } },
        503,
      );
    }
    // Telemetry (spec 032): correlate this turn's spans/logs by request id; the metrics registry
    // records the outcome + LLM tokens/cost below.
    const requestId = c.get('requestId') as string | undefined;
    if (deps.usage && user) {
      const limit = effectiveLimit(user.token_limit, deps.defaultTokenLimit?.(tenantId));
      const { used, cached } = deps.usage.usageForUser(user.id, user.usage_reset_at);
      const billable = billableTokens(used, cached, deps.cacheWeight?.());
      if (quotaView(billable, limit).exceeded) {
        // FR-212 (spec 039): a quota 429 must be a correct HTTP citizen. Set Retry-After whenever the
        // reset time is knowable; while token resets stay manual/admin-only (`users.usage_reset_at`
        // marks the window START, not a scheduled end — spec 021), no such time exists, so state that
        // explicitly via `resetsAt: null` rather than silently omitting retry semantics.
        const resetsAt = (deps.quotaResetsAt ?? quotaResetsAt)(user);
        if (resetsAt) {
          const secs = Math.max(1, Math.ceil((Date.parse(resetsAt) - Date.now()) / 1000));
          c.header('Retry-After', String(secs));
        }
        // Count the token-quota exhaustion distinctly from rate limits (spec 045 FR-272) — the
        // churn/upsell signal. Emitted here, the spec-021/039 chat token-quota rejection point.
        deps.metrics?.recordQuotaRejection('tokens');
        return c.json(
          {
            error: {
              code: 'quota_exceeded',
              message: 'token quota exceeded',
              details: { used: billable, limit, resetsAt },
            },
          },
          429,
        );
      }
    }

    const conv = deps.sessions.getOrCreate(body.sessionId ?? null, user?.id ?? '', tenantId);
    // Snapshot the prior transcript BEFORE appending this turn's question: the persistent store's
    // `append` doesn't mutate the returned snapshot (unlike the in-memory one), so build the model's
    // message list from prior history + the new question explicitly.
    const priorMessages = [...conv.messages];
    deps.sessions.append(conv.sessionId, { role: 'user', content: body.message });
    const rawScope = body.scope ?? {};
    // Expand an oblast geo-scope to its municipalities (mirrors the explorer list + the choropleth
    // roll-up, spec 013): scoping chat to Стара Загора must see its municipalities' datasets too,
    // both for the hard scope filter (inScope) and the geo fallback that pulls a region's datasets.
    const scope =
      rawScope.geoUnitIds && rawScope.geoUnitIds.length > 0
        ? {
            ...rawScope,
            geoUnitIds: expandGeoUnitIds(rawScope.geoUnitIds, deps.bridge.partOfChildren()),
          }
        : rawScope;
    // Grounding precedence (row injection only — never narrows tool scope): an explicit hard focus
    // (scope.datasetIds) > the dataset open in the reader (body.groundingDatasetIds) > whatever the
    // conversation was already about (sticky session context from the previous turn).
    const explicitFocus = scope.datasetIds ?? [];
    const readerFocus = body.groundingDatasetIds ?? [];
    const groundingDatasetIds =
      explicitFocus.length > 0
        ? explicitFocus
        : readerFocus.length > 0
          ? readerFocus
          : conv.contextDatasetIds;

    // Resolve the model up front — from server config only — so provider misconfig becomes a clean
    // error event (FR-023/FR-173).
    let model: LanguageModel;
    try {
      model = deps.selectModel(tenantId);
    } catch (e) {
      const code = e instanceof ProviderError ? e.code : 'provider_error';
      deps.metrics?.recordChatOutcome('error');
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: 'session',
          data: JSON.stringify({ sessionId: conv.sessionId }),
        });
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            code,
            message: e instanceof Error ? e.message : 'provider error',
          }),
        });
      });
    }
    const modelId =
      typeof model === 'string' ? model : ((model as { modelId?: string }).modelId ?? null);
    const maxOut = deps.maxOutputTokens?.();

    // Replay only the recent window so a long conversation can't overflow the context (grounding
    // rows live in the system prompt, not the transcript).
    const messages: ModelMessage[] = windowMessages([
      ...priorMessages,
      { role: 'user', content: body.message },
    ]).map((m) => ({ role: m.role, content: m.content }));

    // Run the turn DETACHED via the generation manager so a client disconnect/reload doesn't kill it
    // (mid-stream resume). The SSE below just subscribes to the live generation.
    const messageId = crypto.randomUUID();
    deps.generations.start({
      messageId,
      sessionId: conv.sessionId,
      userId: user?.id ?? '',
      run: async (h, signal) => {
        const startedAt = Date.now();
        // Span trace (spec 032): a 'chat.turn' span for provider latency + a span per tool-loop step,
        // all correlated by request id. Metadata only — never prompt/answer text (FR-148).
        const tracer = new Tracer(requestId);
        const turnSpan = tracer.startSpan('chat.turn', { ...(modelId ? { model: modelId } : {}) });
        const toolSpans = new Map<string, ReturnType<Tracer['startSpan']>>();
        const onTool = (name: string, status: 'start' | 'done') => {
          if (status === 'start')
            toolSpans.set(name, tracer.startSpan('chat.tool', { tool: name }));
          else {
            toolSpans.get(name)?.end({ tool: name });
            toolSpans.delete(name);
          }
          h.onTool(name, status);
        };
        // FR-210/211 (spec 039): meter the tokens the provider actually billed on EVERY exit — success,
        // provider/tool error, user stop, abort — not just the success path. `onStepFinish` already
        // accumulates per-step usage (surfaced via onUsage), so keep the latest here and record it if
        // the turn throws; the success path records the authoritative reconciled total instead. `meter`
        // fires at most once per turn so the two never double-count (FR-211). This `run` executes once
        // per generation, and reconnect/stream only replays events, so a resumed turn can't re-meter
        // (FR-214).
        let lastUsage: UsageInfo | undefined;
        let metered = false;
        const meter = (usage: (UsageInfo & { totalTokens?: number }) | undefined): void => {
          if (metered || !deps.usage || !user || !usage) return;
          metered = true;
          deps.usage.record({
            userId: user.id,
            ...(tenantId ? { tenantId } : {}),
            sessionId: conv.sessionId,
            model: modelId,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
          });
        };
        const onUsage = (usage: UsageInfo): void => {
          // Keep the PEAK accumulation, not merely the latest: run.ts re-emits an authoritative final
          // total after the stream, but a graceful abort resolves that to 0 — which must not erase the
          // tokens already streamed/billed (FR-210).
          const total = usage.inputTokens + usage.outputTokens;
          const prev = (lastUsage?.inputTokens ?? 0) + (lastUsage?.outputTokens ?? 0);
          if (!lastUsage || total >= prev) lastUsage = usage;
          h.onUsage(usage);
        };
        let result: Awaited<ReturnType<typeof runChatTurn>>;
        try {
          result = await runChatTurn({
            model,
            bridge: deps.bridge,
            scope,
            messages,
            groundingDatasetIds,
            abortSignal: signal,
            ...(maxOut ? { maxOutputTokens: maxOut } : {}),
            events: { onToken: h.onToken, onTool, onUsage },
          });
        } catch (e) {
          deps.metrics?.recordChatOutcome('error');
          turnSpan.end({ ok: false });
          // Record the tokens billed before the failure — the provider already charged for every
          // completed step; dropping them is the metering leak this spec closes.
          meter(lastUsage);
          throw e;
        }
        const durationMs = Date.now() - startedAt;
        // Outcome + LLM tokens/cost for the metrics registry (margin monitoring, FR-149/153).
        const outcome = result.citations.length > 0 ? 'grounded' : 'no_data';
        deps.metrics?.recordChatOutcome(outcome);
        if (result.usage) {
          deps.metrics?.recordLlm(
            result.usage,
            estimateCost(result.usage, pricingFor(modelId), deps.cacheWeight?.() ?? 0.1),
            tenantId,
          );
        }
        turnSpan.end({
          ok: true,
          outcome,
          ...(result.usage
            ? {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
              }
            : {}),
        });
        if (body.debug && result.groundingText) h.onGrounding(result.groundingText);
        h.onCitations(result.citations);
        h.onAnchors(result.anchors);
        // Persist the reply, meter usage, and carry grounding forward — all before 'done' fires, so a
        // reload immediately after completion finds the saved assistant message. Keep per-message token
        // usage + reply duration so the chat shows "tokens consumed" + "how long it took" on reload.
        deps.sessions.append(conv.sessionId, {
          role: 'assistant',
          content: result.text,
          citations: result.citations,
          anchors: result.anchors,
          ...(result.usage
            ? {
                usage: {
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                  cachedInputTokens: result.usage.cachedInputTokens,
                },
              }
            : {}),
          durationMs,
        });
        // The reconciled total wins over the per-step accumulation (FR-211) — but never meter LESS than
        // what the provider already streamed: a user stop that streamText resolves gracefully can report
        // totalUsage 0 while steps were already billed, so fall back to the accumulation then (FR-210).
        const finalTotal = result.usage?.totalTokens ?? 0;
        const accTotal = (lastUsage?.inputTokens ?? 0) + (lastUsage?.outputTokens ?? 0);
        meter(result.usage && finalTotal >= accTotal ? result.usage : lastUsage);
        const nextContext =
          explicitFocus.length > 0
            ? explicitFocus
            : readerFocus.length > 0
              ? readerFocus
              : result.citations.map((cite) => cite.datasetId);
        if (nextContext.length > 0) {
          deps.sessions.setContext(conv.sessionId, nextContext.slice(0, MAX_CONTEXT_DATASETS));
        }
      },
    });

    return streamSSE(c, async (stream) => {
      await stream.writeSSE(chatSSE('session', { sessionId: conv.sessionId }));
      await stream.writeSSE(chatSSE('message', { messageId }));
      await streamGeneration(stream, deps.generations, messageId);
    });
  };
}

/** Forward a generation's events (snapshot replay + live) to an SSE stream until it ends. Shared by
 * the initial POST and the reconnect endpoint. */
export async function streamGeneration(
  stream: { writeSSE: (m: { event: string; data: string }) => unknown },
  generations: GenerationStream,
  messageId: string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const sub = generations.subscribe(messageId, (e) => {
      forwardEvent(stream, e);
      if (e.type === 'done' || e.type === 'error') {
        sub?.unsubscribe();
        resolve();
      }
    });
    if (!sub) {
      // Generation already evicted — nothing live to attach to.
      void stream.writeSSE(chatSSE('done', {}));
      resolve();
      return;
    }
    // Replay what's already been produced (for reconnects), then live events flow via the listener.
    const s = sub.snapshot;
    if (s.text) void stream.writeSSE(chatSSE('token', { delta: s.text }));
    if (s.citations) void stream.writeSSE(chatSSE('citations', { citations: s.citations }));
    if (s.anchors) void stream.writeSSE(chatSSE('anchors', s.anchors));
    if (s.usage) void stream.writeSSE(chatSSE('usage', s.usage));
    if (s.status === 'done') {
      void stream.writeSSE(chatSSE('done', {}));
      sub.unsubscribe();
      resolve();
    } else if (s.status === 'error') {
      void stream.writeSSE(
        chatSSE('error', { code: 'provider_error', message: s.error ?? 'chat failed' }),
      );
      sub.unsubscribe();
      resolve();
    }
  });
}

/** Minimal view of the manager that streamGeneration needs (eases testing). */
export interface GenerationStream {
  subscribe(
    messageId: string,
    listener: (e: GenEvent) => void,
  ): { snapshot: GenSnapshot; unsubscribe: () => void } | null;
}

function forwardEvent(
  stream: { writeSSE: (m: { event: string; data: string }) => unknown },
  e: GenEvent,
): void {
  if (e.type === 'token') void stream.writeSSE(chatSSE('token', { delta: e.delta }));
  else if (e.type === 'tool')
    void stream.writeSSE(chatSSE('tool', { name: e.name, status: e.status }));
  else if (e.type === 'citations')
    void stream.writeSSE(chatSSE('citations', { citations: e.citations }));
  else if (e.type === 'anchors') void stream.writeSSE(chatSSE('anchors', e.anchors));
  else if (e.type === 'grounding') void stream.writeSSE(chatSSE('grounding', { text: e.text }));
  else if (e.type === 'usage') void stream.writeSSE(chatSSE('usage', e.usage));
  else if (e.type === 'done') void stream.writeSSE(chatSSE('done', {}));
  else if (e.type === 'error')
    void stream.writeSSE(chatSSE('error', { code: 'provider_error', message: e.message }));
}
