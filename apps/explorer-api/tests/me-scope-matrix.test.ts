// Access-class matrix for the personal /api/me surface (spec 038). Every route declares who may touch
// it — human-only, `chat` scope, or any-key — and this suite asserts the exact status + error code for
// a human session, a `read`-only key, and a `chat`-scoped key against each surface (FR-204). Hermetic
// via createApp with all repos wired + injected identity headers (Constitution VI).

import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { ApiKeyRepo } from '../../../src/store/repos/api-keys.ts';
import { ApiUsageRepo } from '../../../src/store/repos/api-usage.ts';
import { PlatformSettingsRepo } from '../../../src/store/repos/platform-settings.ts';
import { TokenUsageRepo } from '../../../src/store/repos/token-usage.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import { GenerationManager } from '../src/chat/generation-manager.ts';
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
const tick = () => new Promise((r) => setTimeout(r, 20));

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  const chatSessions = new PersistentSessionStore(db);
  const generations = new GenerationManager(500);
  const apiKeys = new ApiKeyRepo(db);
  const apiUsage = new ApiUsageRepo(db);
  const ctx: AppContext = {
    bridge: {} as ReadBridge,
    crosswalk: new Crosswalk(loadCrosswalk()),
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
    users,
    tokenUsage: new TokenUsageRepo(db),
    chatSessions,
    generations,
    apiKeys,
    apiUsage,
    settings: new PlatformSettingsRepo(db),
  };
  const owner = users.findOrCreateByKratosId({
    kratosIdentityId: 'user-k',
    email: 'user@example.com',
  });
  const readKey = apiKeys.create({ userId: owner.id, name: 'ro', scopes: ['read'] }).plaintext;
  const chatKey = apiKeys.create({ userId: owner.id, name: 'chat', scopes: ['chat'] }).plaintext;
  return {
    db,
    users,
    chatSessions,
    generations,
    apiKeys,
    owner,
    readKey,
    chatKey,
    app: createApp(ctx),
  };
}

const HUMAN = { 'x-user-id': 'user-k', 'x-user-email': 'user@example.com' };
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

type Caller = 'human' | 'read' | 'chat';
const errCode = async (res: Response) =>
  ((await res.json()) as { error?: { code?: string } }).error?.code;

describe('/api/me access-class matrix (spec 038)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  const headersFor = (who: Caller): Record<string, string> =>
    who === 'human' ? HUMAN : bearer(who === 'read' ? s.readKey : s.chatKey);

  // --- FR-201: human-only (API key of any scope → 403 forbidden) ---
  describe('human-only surfaces (FR-201)', () => {
    it('PUT /avatar: human 200; read/chat key 403 forbidden', async () => {
      const put = (who: Caller) =>
        s.app.request('/api/me/avatar', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...headersFor(who) },
          body: JSON.stringify({ avatarUrl: 'data:image/webp;base64,AAAA' }),
        });
      expect((await put('human')).status).toBe(200);
      for (const who of ['read', 'chat'] as const) {
        const res = await put(who);
        expect(res.status).toBe(403);
        expect(await errCode(res)).toBe('forbidden');
      }
      // The key was refused BEFORE the mutation ran — the avatar is unchanged.
      expect(s.users.get(s.owner.id)?.avatar_url).toBe('data:image/webp;base64,AAAA');
    });

    it('GET /api-keys: human 200; read/chat key 403 forbidden', async () => {
      expect((await s.app.request('/api/me/api-keys', { headers: HUMAN })).status).toBe(200);
      for (const who of ['read', 'chat'] as const) {
        const res = await s.app.request('/api/me/api-keys', { headers: headersFor(who) });
        expect(res.status).toBe(403);
        expect(await errCode(res)).toBe('forbidden');
      }
    });
  });

  // --- FR-202: chat scope required (read key → 403 insufficient_scope; chat key + human → allowed) ---
  describe('chat-scope surfaces (FR-202)', () => {
    it('GET /sessions: human + chat key 200; read key 403 insufficient_scope', async () => {
      expect((await s.app.request('/api/me/sessions', { headers: HUMAN })).status).toBe(200);
      expect((await s.app.request('/api/me/sessions', { headers: bearer(s.chatKey) })).status).toBe(
        200,
      );
      const res = await s.app.request('/api/me/sessions', { headers: bearer(s.readKey) });
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe('insufficient_scope');
    });

    it('GET /sessions/:id: chat key reaches the owner’s session (200); read key 403', async () => {
      const conv = s.chatSessions.getOrCreate(null, s.owner.id);
      s.chatSessions.append(conv.sessionId, { role: 'user', content: 'x' });
      expect(
        (await s.app.request(`/api/me/sessions/${conv.sessionId}`, { headers: bearer(s.chatKey) }))
          .status,
      ).toBe(200);
      const res = await s.app.request(`/api/me/sessions/${conv.sessionId}`, {
        headers: bearer(s.readKey),
      });
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe('insufficient_scope');
    });

    it('DELETE /sessions/:id: read key 403 (and nothing deleted); chat key deletes (200)', async () => {
      const conv = s.chatSessions.getOrCreate(null, s.owner.id);
      const del = (who: Caller) =>
        s.app.request(`/api/me/sessions/${conv.sessionId}`, {
          method: 'DELETE',
          headers: headersFor(who),
        });
      const blocked = await del('read');
      expect(blocked.status).toBe(403);
      expect(await errCode(blocked)).toBe('insufficient_scope');
      expect(s.chatSessions.getForUser(conv.sessionId, s.owner.id)).not.toBeNull();
      expect((await del('chat')).status).toBe(200);
      expect(s.chatSessions.getForUser(conv.sessionId, s.owner.id)).toBeNull();
    });

    it('GET /generations/:id/stream: chat key attaches (200); read key 403', async () => {
      s.generations.start({
        messageId: 'g1',
        sessionId: 's1',
        userId: s.owner.id,
        run: async (h) => h.onToken('Здравей'),
      });
      await tick();
      expect(
        (await s.app.request('/api/me/generations/g1/stream', { headers: bearer(s.chatKey) }))
          .status,
      ).toBe(200);
      const res = await s.app.request('/api/me/generations/g1/stream', {
        headers: bearer(s.readKey),
      });
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe('insufficient_scope');
    });

    it('POST /generations/:id/stop: read key 403 (still running); chat key stops (200)', async () => {
      s.generations.start({
        messageId: 'g2',
        sessionId: 's1',
        userId: s.owner.id,
        run: (_h, signal) =>
          new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('stopped')));
          }),
      });
      await tick();
      const stop = (who: Caller) =>
        s.app.request('/api/me/generations/g2/stop', { method: 'POST', headers: headersFor(who) });
      const blocked = await stop('read');
      expect(blocked.status).toBe(403);
      expect(await errCode(blocked)).toBe('insufficient_scope');
      expect((await stop('chat')).status).toBe(200);
    });
  });

  // --- FR-203: any valid key (self-introspection) ---
  describe('any-key surfaces (FR-203)', () => {
    it('GET /usage: human + read + chat key all 200', async () => {
      for (const who of ['human', 'read', 'chat'] as const) {
        expect((await s.app.request('/api/me/usage', { headers: headersFor(who) })).status).toBe(
          200,
        );
      }
    });

    it('GET /api-usage: human + read + chat key all 200', async () => {
      for (const who of ['human', 'read', 'chat'] as const) {
        expect(
          (await s.app.request('/api/me/api-usage', { headers: headersFor(who) })).status,
        ).toBe(200);
      }
    });
  });

  // FR-204: no /api/me route may sit behind bare requireAuth without a declared class. Enumerate the
  // app's real routes and assert every personal surface appears in the matrix below — a new route
  // added without a class fails here, forcing the author to classify it.
  it('every registered /api/me route is covered by a declared access class', () => {
    const CLASSIFIED: Record<string, 'human-only' | 'chat' | 'any-key'> = {
      'GET /api/me/api-keys': 'human-only',
      'POST /api/me/api-keys': 'human-only',
      'DELETE /api/me/api-keys/:id': 'human-only',
      'PUT /api/me/avatar': 'human-only',
      'GET /api/me/sessions': 'chat',
      'GET /api/me/sessions/:id': 'chat',
      'DELETE /api/me/sessions/:id': 'chat',
      'GET /api/me/generations/:id/stream': 'chat',
      'POST /api/me/generations/:id/stop': 'chat',
      'GET /api/me/usage': 'any-key',
      'GET /api/me/api-usage': 'any-key',
    };
    const registered = new Set(
      s.app.routes
        .filter((r) => r.path.startsWith('/api/me') && r.method !== 'ALL')
        .map((r) => `${r.method} ${r.path}`),
    );
    for (const route of registered) {
      expect(CLASSIFIED[route], `undeclared /api/me route: ${route}`).toBeDefined();
    }
  });
});
