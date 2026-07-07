// Mid-stream resume endpoints: re-attach to a live/just-finished generation and stop it. Hermetic via
// createApp with an injected GenerationManager seeded directly.

import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { PlatformSettingsRepo } from '../../../src/store/repos/platform-settings.ts';
import { TokenUsageRepo } from '../../../src/store/repos/token-usage.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import { GenerationManager } from '../src/chat/generation-manager.ts';
import type { ReadBridge } from '../src/read-bridge.ts';

// This suite drives gated routes via X-User-* headers, which requires the explicit trust opt-in
// (spec 034 FR-164; hermetic — no live Kratos, Constitution VI).
beforeAll(() => {
  process.env.TRUST_PROXY_AUTH_HEADERS = 'true';
});
afterAll(() => {
  delete process.env.TRUST_PROXY_AUTH_HEADERS;
});

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const tick = () => new Promise((r) => setTimeout(r, 20));

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  const generations = new GenerationManager(500);
  const ctx: AppContext = {
    bridge: {} as ReadBridge,
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    users,
    tokenUsage: new TokenUsageRepo(db),
    generations,
    settings: new PlatformSettingsRepo(db),
  };
  const user = users.findOrCreateByKratosId({
    kratosIdentityId: 'user-k',
    email: 'user@example.com',
  });
  const other = users.findOrCreateByKratosId({
    kratosIdentityId: 'oth-k',
    email: 'oth@example.com',
  });
  return { db, generations, user, other, app: createApp(ctx) };
}

const USER = { 'x-user-id': 'user-k', 'x-user-email': 'user@example.com' };
const OTHER = { 'x-user-id': 'oth-k', 'x-user-email': 'oth@example.com' };

describe('/api/me/generations', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  it('re-attaches to a generation and replays its produced text + done', async () => {
    s.generations.start({
      messageId: 'g1',
      sessionId: 's1',
      userId: s.user.id,
      run: async (h) => {
        h.onToken('Здравей');
        h.onCitations([{ datasetId: 'd1' }] as never);
      },
    });
    await tick();
    const res = await s.app.request('/api/me/generations/g1/stream', { headers: USER });
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt).toContain('event: token');
    expect(txt).toContain('Здравей');
    expect(txt).toContain('event: citations');
    expect(txt).toContain('event: done');
  });

  it('404s a foreign or unknown generation', async () => {
    s.generations.start({
      messageId: 'gx',
      sessionId: 's1',
      userId: s.other.id,
      run: async () => {},
    });
    await tick();
    expect((await s.app.request('/api/me/generations/gx/stream', { headers: USER })).status).toBe(
      404,
    );
    expect((await s.app.request('/api/me/generations/none/stream', { headers: USER })).status).toBe(
      404,
    );
  });

  it('stops a running generation (owner only)', async () => {
    s.generations.start({
      messageId: 'g2',
      sessionId: 's1',
      userId: s.user.id,
      run: (_h, signal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('stopped')));
        }),
    });
    await tick();
    expect(
      (await s.app.request('/api/me/generations/g2/stop', { method: 'POST', headers: OTHER }))
        .status,
    ).toBe(404);
    expect(
      (await s.app.request('/api/me/generations/g2/stop', { method: 'POST', headers: USER }))
        .status,
    ).toBe(200);
  });
});
