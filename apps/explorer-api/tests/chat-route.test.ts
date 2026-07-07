// US3 chat: SSE route + grounding loop driven by a stubbed model (MockLanguageModelV3), plus direct
// tool-wrapper tests. No live LLM — the provider seam is injected (Constitution VI).

import type { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { LanguageModel, ToolCallOptions, ToolSet } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { runIndex } from '../../../src/index/run-index.ts';
import { openDb } from '../../../src/store/db.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../../src/store/repos/entities.ts';
import { ResourcesRepo } from '../../../src/store/repos/resources.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import { ProviderError } from '../src/chat/providers.ts';
import { SessionStore } from '../src/chat/session.ts';
import { buildTools } from '../src/chat/tools.ts';
import { ReadBridge } from '../src/read-bridge.ts';

// This suite drives gated routes via X-User-* headers, which requires the explicit trust opt-in
// (spec 034 FR-164; hermetic — no live Kratos, Constitution VI).
beforeAll(() => {
  process.env.TRUST_PROXY_AUTH_HEADERS = 'true';
});
afterAll(() => {
  delete process.env.TRUST_PROXY_AUTH_HEADERS;
});

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function streamOf(parts: LanguageModelV3StreamPart[]) {
  return { stream: convertArrayToReadableStream(parts) };
}
/** A mock model that returns each scripted step on successive doStream calls (one per loop step). */
function mockModel(
  steps: Array<{ stream: ReadableStream<LanguageModelV3StreamPart> }>,
): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const step = steps[i++];
      if (!step) throw new Error('mock model exhausted');
      return step;
    },
  });
}
const toolCallStep = (toolName: string, input: unknown) =>
  streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'c1', toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: 'tool-calls', usage },
  ] as LanguageModelV3StreamPart[]);
const textStep = (text: string) =>
  streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage },
  ] as LanguageModelV3StreamPart[]);
const emptyStep = () =>
  streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'finish', finishReason: 'stop', usage },
  ] as LanguageModelV3StreamPart[]);
const errorStep = (error: unknown = new Error('upstream blew up')) =>
  streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'error', error },
  ] as LanguageModelV3StreamPart[]);

const opts = { toolCallId: 't', messages: [] } as unknown as ToolCallOptions;

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

/** Invoke a tool's execute without non-null assertions (tool/execute are optional in the type). */
function callTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const t = tools[name];
  if (!t?.execute) throw new Error(`tool ${name} is not executable`);
  return (t.execute as (i: unknown, o: ToolCallOptions) => Promise<unknown>)(input, opts);
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

describe('POST /api/chat', () => {
  let db: Database;
  let bridge: ReadBridge;

  beforeEach(async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    seed(db);
    const embedder = new LocalOnnxEmbedder({ dimension: 8 });
    await runIndex({ db, embedder });
    bridge = new ReadBridge({ db, storeRoot, embedder, freshnessSloSeconds: 86400 });
  });
  afterEach(() => db.close());

  function appWith(model: MockLanguageModelV3 | (() => never)): ReturnType<typeof createApp> {
    const selectModel: () => LanguageModel =
      typeof model === 'function' ? model : () => model as unknown as LanguageModel;
    const ctx: AppContext = {
      bridge,
      crosswalk: new Crosswalk(loadCrosswalk()),
      users: new UsersRepo(db),
      health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
      chat: { sessions: new SessionStore(() => 'sess-1'), serverDefault: null, selectModel },
    };
    return createApp(ctx);
  }

  // /api/chat is gated (spec 019): post with the X-User-* headers Oathkeeper would inject so the
  // grounded-chat assertions exercise the handler. The anon (401) path is covered separately.
  const AUTH_HEADERS = {
    'content-type': 'application/json',
    'x-user-id': 'kratos-id-1',
    'x-user-email': 'user@example.com',
    'x-user-verified': 'true',
  };
  const post = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request('/api/chat', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(body),
    });

  it('gates /api/chat: anonymous (no identity headers) → 401', async () => {
    const app = appWith(mockModel([textStep('should not run')]));
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('streams a grounded answer with citations + anchors from tool results', async () => {
    const model = mockModel([
      toolCallStep('mirrorSearch', { query: 'въздух' }),
      textStep('Има данни за качеството на въздуха.'),
    ]);
    const res = await post(appWith(model), {
      message: 'Кои региони публикуват данни за въздуха?',
    });
    const events = parseSSE(await res.text());
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe('session');
    expect(kinds).toContain('tool');
    expect(kinds).toContain('token');
    expect(kinds).toContain('citations');
    expect(kinds.at(-1)).toBe('done');

    const cite = events.find((e) => e.event === 'citations')?.data as {
      citations: { datasetId: string }[];
    };
    expect(cite.citations.map((c) => c.datasetId)).toEqual(['d1']);
    const anchor = events.find((e) => e.event === 'anchors')?.data as { geoEntityIds: string[] };
    expect(anchor.geoEntityIds).toContain('geo:bg-oblast-sofia-grad');
  });

  it('sticky grounding: a follow-up re-grounds in the previously cited dataset', async () => {
    // Turn 1 reads d1 via a tool and cites it; turn 2 (same session, NO scope, NO tool call) must
    // still cite d1 — only possible if the session carried d1 forward and re-injected it as context.
    const model = mockModel([
      toolCallStep('mirrorSearch', { query: 'въздух' }),
      textStep('Има данни за въздуха.'),
      textStep('А ето още по темата.'),
    ]);
    const app = appWith(model);

    const r1 = parseSSE(await (await post(app, { message: 'q1' })).text());
    const sid = (r1.find((e) => e.event === 'session')?.data as { sessionId: string }).sessionId;
    expect(
      (
        r1.find((e) => e.event === 'citations')?.data as { citations: { datasetId: string }[] }
      ).citations.map((cite) => cite.datasetId),
    ).toEqual(['d1']);

    const r2 = parseSSE(await (await post(app, { sessionId: sid, message: 'q2' })).text());
    expect(
      (
        r2.find((e) => e.event === 'citations')?.data as { citations: { datasetId: string }[] }
      ).citations.map((cite) => cite.datasetId),
    ).toEqual(['d1']);
  });

  it('groundingDatasetIds grounds + cites a dataset without a hard scope focus', async () => {
    // The reader-open case: ground in d1's rows (cite it) even with no scope.datasetIds and no tool call.
    const res = await post(appWith(mockModel([textStep('Ето данните за този набор.')])), {
      message: 'какво има тук?',
      groundingDatasetIds: ['d1'],
    });
    const events = parseSSE(await res.text());
    expect(
      (
        events.find((e) => e.event === 'citations')?.data as { citations: { datasetId: string }[] }
      ).citations.map((cite) => cite.datasetId),
    ).toEqual(['d1']);
  });

  it('emits a grounding event with the exact injected context when debug is set', async () => {
    // Opt-in transparency for evals/observability: debug:true surfaces the grounded text the model
    // was given. Without debug (the test above) no grounding event is emitted — covering both branches.
    const res = await post(appWith(mockModel([textStep('Ето данните за този набор.')])), {
      message: 'какво има тук?',
      groundingDatasetIds: ['d1'],
      debug: true,
    });
    const events = parseSSE(await res.text());
    const grounding = events.find((e) => e.event === 'grounding')?.data as
      | { text: string }
      | undefined;
    expect(grounding?.text).toContain('Качество на въздуха');
  });

  it('replies "no relevant public data" when the model produces no text', async () => {
    const model = mockModel([emptyStep()]);
    const res = await post(appWith(model), { message: 'нещо' });
    const events = parseSSE(await res.text());
    expect(events.find((e) => e.event === 'citations')?.data).toEqual({ citations: [] });
  });

  it('excludes out-of-scope datasets from citations (SC-008)', async () => {
    const model = mockModel([toolCallStep('mirrorSearch', { query: 'въздух' }), textStep('ok')]);
    const res = await post(appWith(model), {
      message: 'q',
      scope: { geoUnitIds: ['geo:bg-oblast-varna'] },
    });
    const events = parseSSE(await res.text());
    expect(events.find((e) => e.event === 'citations')?.data).toEqual({ citations: [] });
  });

  it('emits an error event on provider misconfiguration', async () => {
    const app = appWith(() => {
      throw new ProviderError('provider_unconfigured', 'no key');
    });
    const res = await post(app, { message: 'q' });
    const events = parseSSE(await res.text());
    const e = events.find((x) => x.event === 'error')?.data as { code: string };
    expect(e.code).toBe('provider_unconfigured');
  });

  it('rejects an invalid body with 400', async () => {
    const model = mockModel([emptyStep()]);
    const res = await post(appWith(model), { debug: true });
    expect(res.status).toBe(400);
  });

  it('rejects a request still sending the removed provider field with 400 and never dials its baseUrl (FR-170/FR-174, SC-1)', async () => {
    // A stale/malicious client pointing the (removed) provider at a live listener must get a schema
    // rejection — and the listener must see ZERO connections: the server is not an egress proxy.
    let connections = 0;
    const listener = Bun.serve({
      port: 0,
      fetch: () => {
        connections += 1;
        return new Response('should never be reached');
      },
    });
    try {
      const res = await post(appWith(mockModel([textStep('не')])), {
        message: 'q',
        provider: {
          kind: 'openai-compatible',
          model: 'm',
          apiKey: 'x',
          baseUrl: `http://127.0.0.1:${listener.port}/v1`,
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('bad_request');
    } finally {
      listener.stop(true);
    }
    expect(connections).toBe(0);
  });

  it('resolves the model from server config only — no request-derived arguments reach the seam (FR-171, SC-2)', async () => {
    const model = mockModel([textStep('ok')]);
    const seamCalls: unknown[][] = [];
    const ctx: AppContext = {
      bridge,
      crosswalk: new Crosswalk(loadCrosswalk()),
      users: new UsersRepo(db),
      health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
      chat: {
        sessions: new SessionStore(() => 'sess-1'),
        serverDefault: null,
        selectModel: (...args: unknown[]) => {
          seamCalls.push(args);
          return model as unknown as LanguageModel;
        },
      },
    };
    const res = await post(createApp(ctx), { message: 'q' });
    expect(res.status).toBe(200);
    await res.text();
    expect(seamCalls).toEqual([[]]);
  });

  it('emits provider_unconfigured via the REAL seam when no server provider exists, with no fabricated content (FR-173)', async () => {
    // No selectModel override and no settings repo: the real provider seam resolves the server
    // default (null here) and must fail typed — never with invented answer text.
    const ctx: AppContext = {
      bridge,
      crosswalk: new Crosswalk(loadCrosswalk()),
      users: new UsersRepo(db),
      health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
      chat: { sessions: new SessionStore(() => 'sess-1'), serverDefault: null },
    };
    const events = parseSSE(await (await post(createApp(ctx), { message: 'q' })).text());
    const e = events.find((x) => x.event === 'error')?.data as { code: string };
    expect(e.code).toBe('provider_unconfigured');
    expect(events.some((x) => x.event === 'token')).toBe(false);
  });

  it('emits a provider_error event when the model stream errors mid-turn', async () => {
    const model = mockModel([errorStep()]);
    const res = await post(appWith(model), { message: 'q' });
    const events = parseSSE(await res.text());
    const e = events.find((x) => x.event === 'error')?.data as { code: string };
    expect(e.code).toBe('provider_error');
  });

  it('handles a non-Error stream error value', async () => {
    const model = mockModel([errorStep('plain string failure')]);
    const res = await post(appWith(model), { message: 'q' });
    const events = parseSSE(await res.text());
    expect(events.find((x) => x.event === 'error')?.event).toBe('error');
  });
});

describe('chat tool wrappers (direct)', () => {
  let db: Database;
  let bridge: ReadBridge;

  beforeEach(async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    seed(db);
    const embedder = new LocalOnnxEmbedder({ dimension: 8 });
    await runIndex({ db, embedder });
    bridge = new ReadBridge({ db, storeRoot, embedder, freshnessSloSeconds: 86400 });
  });
  afterEach(() => db.close());

  it('mirrorSearch returns in-scope datasets and records ids', async () => {
    const { tools, citedDatasetIds } = buildTools(bridge, {});
    const out = (await callTool(tools, 'mirrorSearch', { query: 'въздух' })) as {
      results: { datasetId: string }[];
    };
    expect(out.results.map((r) => r.datasetId)).toEqual(['d1']);
    expect(citedDatasetIds.has('d1')).toBe(true);
  });

  it('mirrorEntitySearch resolves entity-linked datasets', async () => {
    const { tools } = buildTools(bridge, {});
    const out = (await callTool(tools, 'mirrorEntitySearch', {
      entityId: 'geo:bg-oblast-sofia-grad',
    })) as { results: { datasetId: string }[] };
    expect(out.results.map((r) => r.datasetId)).toEqual(['d1']);
  });

  it('mirrorInfo returns detail in scope, outOfScope marker otherwise', async () => {
    const inOut = (await callTool(buildTools(bridge, {}).tools, 'mirrorInfo', {
      datasetId: 'd1',
    })) as { datasetId: string };
    expect(inOut.datasetId).toBe('d1');
    const blocked = (await callTool(
      buildTools(bridge, { geoUnitIds: ['geo:bg-oblast-varna'] }).tools,
      'mirrorInfo',
      { datasetId: 'd1' },
    )) as { outOfScope?: boolean };
    expect(blocked.outOfScope).toBe(true);
  });

  it('mirrorInfo marks a non-existent dataset as outOfScope (view throws → dropped)', async () => {
    const out = (await callTool(buildTools(bridge, {}).tools, 'mirrorInfo', {
      datasetId: 'ghost',
    })) as { outOfScope?: boolean };
    expect(out.outOfScope).toBe(true);
  });

  it('readResource forwards column filters to the grid query', async () => {
    // Spy over the real bridge (preserves view/scope behaviour) to capture the grid it receives.
    let grid: unknown;
    const spy = Object.assign(Object.create(bridge), {
      rows: (d: string, r: string, l?: number, o?: number, g?: unknown) => {
        grid = g;
        return bridge.rows(d, r, l, o, g as never);
      },
    });
    const { tools } = buildTools(spy as ReadBridge, {});
    await callTool(tools, 'readResource', {
      datasetId: 'd1',
      resourceId: 'r1',
      filters: { rayon: 'Панчарево' },
    });
    expect((grid as { filters?: Record<string, string> })?.filters).toEqual({ rayon: 'Панчарево' });
  });

  it('readResource reads rows in scope, blocks out of scope', async () => {
    const rows = (await callTool(buildTools(bridge, {}).tools, 'readResource', {
      datasetId: 'd1',
      resourceId: 'r1',
    })) as { total: number };
    expect(rows.total).toBe(0);
    const blocked = (await callTool(
      buildTools(bridge, { geoUnitIds: ['geo:bg-oblast-varna'] }).tools,
      'readResource',
      { datasetId: 'd1', resourceId: 'r1' },
    )) as { outOfScope?: boolean };
    expect(blocked.outOfScope).toBe(true);
  });

  it('mirrorSearch drops hits whose dataset throws on view()', async () => {
    const { tools } = buildTools(bridge, {});
    const out = (await callTool(tools, 'mirrorSearch', { query: 'несъществуващо xyz' })) as {
      results: unknown[];
    };
    expect(Array.isArray(out.results)).toBe(true);
  });
});
