// Spec 056 SC-2: the `chatEnabled` kill-switch is wired. With the toggle false (set via PUT
// /api/admin/settings), POST /api/chat refuses with a typed 503 `chat_disabled` and makes NO LLM call;
// flipping it back re-enables chat without a restart (resolved per request). Hermetic — injected model.

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
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { PlatformSettingsRepo } from '../../../src/store/repos/platform-settings.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import { SessionStore } from '../src/chat/session.ts';
import { ReadBridge } from '../src/read-bridge.ts';

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
const textModel = () =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Здравей.' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: 'stop', usage },
      ] as LanguageModelV3StreamPart[]),
    }),
  });

const ADMIN = {
  'content-type': 'application/json',
  'x-user-id': 'admin-k',
  'x-user-email': 'admin@example.com',
  'x-user-verified': 'true',
};
const USER = { ...ADMIN, 'x-user-id': 'user-k', 'x-user-email': 'user@example.com' };

describe('spec 056 FR-386: chatEnabled kill-switch', () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let llmCalls: number;

  beforeEach(async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    new DatasetsRepo(db).upsert({
      id: 'd1',
      slug: 'd1',
      titleBg: 'Качество на въздуха',
      tags: ['въздух'],
      groups: [],
      sourceUrl: 'https://data.egov.bg/d1',
    });
    const embedder = new LocalOnnxEmbedder({ dimension: 8 });
    await runIndex({ db, embedder });
    const bridge = new ReadBridge({ db, storeRoot, embedder, freshnessSloSeconds: 86400 });
    const users = new UsersRepo(db);
    users.findOrCreateByKratosId({ kratosIdentityId: 'admin-k', email: 'admin@example.com' });
    users.setRoleByEmail('admin@example.com', 'admin');
    llmCalls = 0;
    const selectModel: () => LanguageModel = () => {
      llmCalls++;
      return textModel() as unknown as LanguageModel;
    };
    const ctx: AppContext = {
      bridge,
      crosswalk: new Crosswalk(loadCrosswalk()),
      users,
      settings: new PlatformSettingsRepo(db),
      health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
      chat: { sessions: new SessionStore(() => 'sess-1'), serverDefault: null, selectModel },
    };
    app = createApp(ctx);
  });
  afterEach(() => db.close());

  const setToggle = (chatEnabled: boolean) =>
    app.request('/api/admin/settings', {
      method: 'PUT',
      headers: ADMIN,
      body: JSON.stringify({ toggles: { chatEnabled } }),
    });
  const chat = () =>
    app.request('/api/chat', {
      method: 'POST',
      headers: USER,
      body: JSON.stringify({ message: 'здр' }),
    });

  it('refuses with 503 chat_disabled and makes no LLM call when the toggle is false', async () => {
    expect((await setToggle(false)).status).toBe(200);
    const res = await chat();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('chat_disabled');
    expect(llmCalls).toBe(0);
  });

  it('is enabled by default (unset toggle) and re-enables without a restart', async () => {
    // Default (never set): chat streams.
    const first = await chat();
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    expect(llmCalls).toBeGreaterThan(0);

    // Disable, then re-enable on the SAME app instance — the toggle is read per request.
    await setToggle(false);
    expect((await chat()).status).toBe(503);
    await setToggle(true);
    const again = await chat();
    expect(again.status).toBe(200);
    expect(again.headers.get('content-type')).toContain('text/event-stream');
  });
});
