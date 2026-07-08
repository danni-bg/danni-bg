// Chat metering integrity (spec 039): every token the provider bills is metered, and the token-quota
// 429 is a correct HTTP citizen. Hermetic — the provider seam is a stubbed MockLanguageModelV3 with
// scripted per-step usage (no live LLM, Constitution VI); the store is a real in-memory SQLite.

import type { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { runIndex } from '../../../src/index/run-index.ts';
import { openDb } from '../../../src/store/db.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { ApiKeyRepo } from '../../../src/store/repos/api-keys.ts';
import { ApiUsageRepo } from '../../../src/store/repos/api-usage.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../../src/store/repos/entities.ts';
import { ResourcesRepo } from '../../../src/store/repos/resources.ts';
import { TokenUsageRepo } from '../../../src/store/repos/token-usage.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import { GenerationManager } from '../src/chat/generation-manager.ts';
import { maxConcurrentOverrun } from '../src/chat/quota.ts';
import { SessionStore } from '../src/chat/session.ts';
import { Metrics } from '../src/metrics.ts';
import { ReadBridge } from '../src/read-bridge.ts';

beforeAll(() => {
  process.env.TRUST_PROXY_AUTH_HEADERS = 'true';
});
afterAll(() => {
  delete process.env.TRUST_PROXY_AUTH_HEADERS;
});

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Provider-shaped usage for a mock finish part; input/output totals flow through to step.usage. */
const usageOf = (input: number, output: number, cached = 0) => ({
  inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

function streamOf(parts: LanguageModelV3StreamPart[]) {
  return { stream: convertArrayToReadableStream(parts) };
}
const toolCallStep = (input: number, output: number) =>
  streamOf([
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'mirrorSearch',
      input: JSON.stringify({ query: 'въздух' }),
    },
    { type: 'finish', finishReason: 'tool-calls', usage: usageOf(input, output) },
  ] as LanguageModelV3StreamPart[]);
const textStep = (text: string, input: number, output: number) =>
  streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage: usageOf(input, output) },
  ] as LanguageModelV3StreamPart[]);
const errorStep = () =>
  streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'error', error: new Error('upstream blew up mid-turn') },
  ] as LanguageModelV3StreamPart[]);

/** A model that returns each scripted step on successive doStream calls. */
function mockModel(steps: Array<{ stream: ReadableStream<LanguageModelV3StreamPart> }>) {
  let i = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const step = steps[i++];
      if (!step) throw new Error('mock model exhausted');
      return step;
    },
  });
}

interface SseEvent {
  event: string;
  data: unknown;
}
function parseSSE(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const data = block.match(/^data:\s*(.+)$/m)?.[1]?.trim();
    if (event && data) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

function seed(db: Database): void {
  const ds = new DatasetsRepo(db);
  ds.upsert({
    id: 'd1',
    slug: 'd1',
    titleBg: 'Качество на въздуха',
    tags: ['въздух'],
    groups: [],
    sourceUrl: 'https://data.egov.bg/d1',
  });
  new ResourcesRepo(db).upsert({
    id: 'r1',
    datasetId: 'd1',
    sourceUrl: 'https://data.egov.bg/d1/r1',
    name: 'rows',
  });
  const ents = new EntitiesRepo(db);
  ents.upsert({
    id: 'geo:bg-oblast-sofia-grad',
    kind: 'geographic_unit',
    canonicalLabelBg: 'София (град)',
  });
  ents.attach({
    datasetId: 'd1',
    entityId: 'geo:bg-oblast-sofia-grad',
    extractor: 'gaz',
    confidence: 0.9,
  });
}

const AUTH_HEADERS = {
  'content-type': 'application/json',
  'x-user-id': 'kratos-id-1',
  'x-user-email': 'user@example.com',
  'x-user-verified': 'true',
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('chat metering integrity (spec 039)', () => {
  let db: Database;
  let bridge: ReadBridge;
  let users: UsersRepo;
  let tokenUsage: TokenUsageRepo;
  let userId: string;

  beforeEach(async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    seed(db);
    const embedder = new LocalOnnxEmbedder({ dimension: 8 });
    await runIndex({ db, embedder });
    bridge = new ReadBridge({ db, storeRoot, embedder, freshnessSloSeconds: 86400 });
    users = new UsersRepo(db);
    tokenUsage = new TokenUsageRepo(db);
    userId = users.findOrCreateByKratosId({
      kratosIdentityId: 'kratos-id-1',
      email: 'user@example.com',
    }).id;
  });
  afterEach(() => db.close());

  function appWith(
    model: LanguageModel,
    generations?: GenerationManager,
    metrics?: Metrics,
  ): ReturnType<typeof createApp> {
    const ctx: AppContext = {
      bridge,
      crosswalk: new Crosswalk(loadCrosswalk()),
      users,
      tokenUsage,
      health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
      chat: {
        sessions: new SessionStore(() => 'sess-1'),
        serverDefault: null,
        selectModel: () => model,
      },
      ...(generations ? { generations } : {}),
      ...(metrics ? { metrics } : {}),
    };
    return createApp(ctx);
  }
  const post = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request('/api/chat', { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(body) });

  it('SC-1: a turn that throws after a completed step still records the tokens billed so far', async () => {
    // Step 1 (tool call) bills 100/10; step 2 errors before finishing. The provider already charged for
    // step 1, so its usage must land in token_usage — not be dropped by the throw path.
    const model = mockModel([toolCallStep(100, 10), errorStep()]);
    const res = await post(appWith(model), { message: 'q' });
    const events = parseSSE(await res.text());
    expect(events.find((e) => e.event === 'error')).toBeTruthy();

    const u = tokenUsage.usageForUser(userId, null);
    expect(u.requests).toBe(1); // exactly one row (FR-211)
    expect(u.input).toBe(100);
    expect(u.output).toBe(10);
    expect(u.used).toBe(110);
  });

  it('records nothing extra and keeps a single authoritative row on a fully successful turn', async () => {
    // Regression guard for FR-211: per-step accumulation + the final reconciled total must not
    // double-count. totalUsage aggregates the two steps → one row of 150/30.
    const model = mockModel([toolCallStep(100, 10), textStep('Има данни за въздуха.', 50, 20)]);
    const res = await post(appWith(model), { message: 'q' });
    const events = parseSSE(await res.text());
    expect(events.at(-1)?.event).toBe('done');

    const u = tokenUsage.usageForUser(userId, null);
    expect(u.requests).toBe(1);
    expect(u.input).toBe(150);
    expect(u.output).toBe(30);
    expect(u.used).toBe(180);
  });

  it('SC-2: stopping mid-stream records the streamed-so-far usage; reconnect does not double it', async () => {
    // Step 1 bills 100/10 and finishes; step 2 blocks until the server-side stop aborts it. The stop
    // travels the same throw path as an error, so the streamed-so-far usage must be metered exactly once
    // — and re-attaching to the finished generation must NOT write a second row (FR-214).
    const gens = new GenerationManager();
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        const i = calls++;
        if (i === 0) return toolCallStep(100, 10);
        // Second step: hang until aborted, then throw as streamText does on abort.
        await new Promise<never>((_, reject) => {
          const sig = options.abortSignal;
          const fail = () => reject(new DOMException('aborted', 'AbortError'));
          if (sig?.aborted) fail();
          else sig?.addEventListener('abort', fail, { once: true });
        });
        throw new Error('unreachable');
      },
    });

    const app = appWith(model as unknown as LanguageModel, gens);
    // Fire the turn; its SSE resolves only once the turn ends, so don't await it yet.
    const streamed = post(app, { message: 'q' });

    // Wait until step 1's usage is visible in the live snapshot, then stop.
    let messageId: string | undefined;
    for (let n = 0; n < 200 && !messageId; n++) {
      const mid = gens.activeForSession('sess-1');
      if (mid && gens.snapshot(mid)?.usage) messageId = mid;
      else await delay(10);
    }
    expect(messageId).toBeTruthy();
    if (!messageId) return;
    gens.stop(messageId);
    await (await streamed).text();

    const after = tokenUsage.usageForUser(userId, null);
    expect(after.requests).toBe(1);
    expect(after.used).toBe(110);

    // Re-attach to the (now finished) generation — pure replay, no re-metering.
    const replay = await app.request(`/api/me/generations/${messageId}/stream`, {
      headers: AUTH_HEADERS,
    });
    await replay.text();
    expect(tokenUsage.usageForUser(userId, null).requests).toBe(1);
  });

  it('SC-3: the token-quota 429 carries a no-auto-reset marker and no Retry-After', async () => {
    users.setTokenLimit(userId, 50);
    tokenUsage.record({ userId, inputTokens: 0, outputTokens: 0, totalTokens: 60 });
    const res = await post(appWith(mockModel([textStep('unused', 1, 1)])), { message: 'hi' });
    expect(res.status).toBe(429);
    // No scheduled reset is computable, so no Retry-After — but the body says so explicitly.
    expect(res.headers.get('Retry-After')).toBeNull();
    const body = (await res.json()) as {
      error: { code: string; details: { used: number; limit: number; resetsAt: string | null } };
    };
    expect(body.error.code).toBe('quota_exceeded');
    expect(body.error.details.limit).toBe(50);
    expect(body.error.details.resetsAt).toBeNull();
  });

  it('a keyed chat request passes through the chatMeter (data-API config resolves rateChat)', async () => {
    // Wiring an api-usage repo mounts chatMeter on /api/chat; a chat-scoped API key travels it, so the
    // app's meterConfig.rateChat closure runs and the chat request is recorded against the key.
    const apiKeys = new ApiKeyRepo(db);
    const apiUsage = new ApiUsageRepo(db);
    const { plaintext, view } = apiKeys.create({ userId, name: 'chat-key', scopes: ['chat'] });
    const ctx: AppContext = {
      bridge,
      crosswalk: new Crosswalk(loadCrosswalk()),
      users,
      tokenUsage,
      apiKeys,
      apiUsage,
      health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
      chat: {
        sessions: new SessionStore(() => 'sess-keyed'),
        serverDefault: null,
        selectModel: () => mockModel([textStep('Има данни.', 5, 3)]) as unknown as LanguageModel,
      },
    };
    const app = createApp(ctx);
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ message: 'има ли данни' }),
    });
    expect(res.status).toBe(200);
    await res.text();
    // chatMeter recorded the keyed chat request (proving the middleware — and rateChat — ran).
    expect(apiUsage.countSinceForKey(view.id, '2000-01-01T00:00:00.000Z', 'chat')).toBe(1);
  });

  // Spec 045 SC-3 / FR-272: the token-quota 429 increments danni_quota_rejections_total{kind="tokens"}
  // by exactly the rejection count, distinct from the rate-limit counter.
  it('spec 045: the token-quota 429 increments the tokens quota-rejection counter', async () => {
    users.setTokenLimit(userId, 50);
    tokenUsage.record({ userId, inputTokens: 0, outputTokens: 0, totalTokens: 60 });
    const metrics = new Metrics();
    const app = appWith(mockModel([textStep('unused', 1, 1)]), undefined, metrics);
    expect((await post(app, { message: 'hi' })).status).toBe(429);
    expect((await post(app, { message: 'hi again' })).status).toBe(429);
    const snap = metrics.snapshot();
    expect(snap.quotaRejections).toEqual({ tokens: 2 });
    expect(snap.rateLimitRejections).toBe(0);
  });
});

describe('maxConcurrentOverrun (spec 039 FR-213)', () => {
  it('bounds the accepted overrun at (concurrentTurns − 1) × per-turn cost', () => {
    // The first concurrent turn is legitimately admitted; only the rest can overrun.
    expect(maxConcurrentOverrun(1, 4096)).toBe(0);
    expect(maxConcurrentOverrun(3, 4096)).toBe(8192);
    expect(maxConcurrentOverrun(0, 4096)).toBe(0);
    expect(maxConcurrentOverrun(5, 0)).toBe(0);
  });
});
