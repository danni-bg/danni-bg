// Resumable chat-history endpoints under /api/me/sessions — hermetic via createApp + injected
// identity headers. Sessions are seeded through the persistent store; ownership is enforced.

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
import { PersistentSessionStore } from '../src/chat/sessions-repo.ts';
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

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  const chatSessions = new PersistentSessionStore(db);
  const ctx: AppContext = {
    bridge: {} as ReadBridge,
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    users,
    tokenUsage: new TokenUsageRepo(db),
    chatSessions,
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
  return { db, chatSessions, user, other, app: createApp(ctx) };
}

const USER = { 'x-user-id': 'user-k', 'x-user-email': 'user@example.com' };

describe('/api/me/sessions', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  it('lists the caller’s sessions and resumes one with its messages', async () => {
    const conv = s.chatSessions.getOrCreate(null, s.user.id);
    s.chatSessions.append(conv.sessionId, { role: 'user', content: 'Въздух?' });
    s.chatSessions.append(conv.sessionId, { role: 'assistant', content: 'Ето.' });

    const list = (await (await s.app.request('/api/me/sessions', { headers: USER })).json()) as {
      sessions: { id: string; title: string }[];
    };
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]).toMatchObject({ id: conv.sessionId, title: 'Въздух?' });

    const got = await s.app.request(`/api/me/sessions/${conv.sessionId}`, { headers: USER });
    expect(got.status).toBe(200);
    const conv2 = (await got.json()) as { messages: { role: string; content: string }[] };
    expect(conv2.messages.map((m) => m.content)).toEqual(['Въздух?', 'Ето.']);
  });

  it('does not expose another user’s session (404)', async () => {
    const conv = s.chatSessions.getOrCreate(null, s.other.id);
    s.chatSessions.append(conv.sessionId, { role: 'user', content: 'secret' });
    expect(
      (await s.app.request(`/api/me/sessions/${conv.sessionId}`, { headers: USER })).status,
    ).toBe(404);
    const list = (await (await s.app.request('/api/me/sessions', { headers: USER })).json()) as {
      sessions: unknown[];
    };
    expect(list.sessions).toHaveLength(0);
  });

  it('deletes own session, 404s a foreign/missing one, 401s anon', async () => {
    const conv = s.chatSessions.getOrCreate(null, s.user.id);
    s.chatSessions.append(conv.sessionId, { role: 'user', content: 'x' });
    const foreign = s.chatSessions.getOrCreate(null, s.other.id);

    expect(
      (
        await s.app.request(`/api/me/sessions/${foreign.sessionId}`, {
          method: 'DELETE',
          headers: USER,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await s.app.request(`/api/me/sessions/${conv.sessionId}`, {
          method: 'DELETE',
          headers: USER,
        })
      ).status,
    ).toBe(200);
    expect(s.chatSessions.getForUser(conv.sessionId, s.user.id)).toBeNull();
    expect((await s.app.request('/api/me/sessions')).status).toBe(401);
  });
});
