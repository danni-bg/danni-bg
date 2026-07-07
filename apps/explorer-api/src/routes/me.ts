// Per-user self endpoints. All mounted behind requireAuth (any tier — no admin), and every route
// additionally declares an explicit access class (spec 038 FR-200) enforced by the spec-027 guards:
//   - human-only (requireHuman): API-key CRUD + PUT /avatar — account mutations, no machine use case.
//   - chat scope (requireScope('chat')): sessions list/read/delete + generation stream/stop — chat
//     surfaces; a read-only key gets 403 insufficient_scope.
//   - any-key (allowAnyKey): GET /usage + GET /api-usage — self-introspection of quota/usage so a
//     machine client can throttle itself.
// A human Kratos session passes every class; keys are gated per the matrix.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ApiKeyRepo } from '../../../../src/store/repos/api-keys.ts';
import type { ApiUsageRepo } from '../../../../src/store/repos/api-usage.ts';
import type { TenantsRepo } from '../../../../src/store/repos/tenants.ts';
import type { TokenUsageRepo } from '../../../../src/store/repos/token-usage.ts';
import type { UsersRepo } from '../../../../src/store/repos/users.ts';
import type { SessionResolver } from '../auth/kratos-session.ts';
import type { GenerationManager } from '../chat/generation-manager.ts';
import { billableTokens, effectiveLimit, quotaView } from '../chat/quota.ts';
import type { PersistentSessionStore } from '../chat/sessions-repo.ts';
import {
  type AuthEnv,
  allowAnyKey,
  requireAuth,
  requireHuman,
  requireScope,
} from '../middleware/require-auth.ts';
import { streamGeneration } from './chat.ts';

// API-key management (spec 027). Keys are created/listed/revoked by a HUMAN session only (a key can
// never mint or list keys); the secret is returned once on creation and never again.
const createKeyBody = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z
    .array(z.enum(['read', 'chat']))
    .nonempty()
    .optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

// Profile picture: a small data: image URL (the client resizes first). Cap the size so a base64 blob
// can't bloat the row / the session callback payload.
const MAX_AVATAR_CHARS = 600_000;
const avatarBody = z.object({
  avatarUrl: z
    .string()
    .regex(/^data:image\/(png|jpeg|webp);base64,/, 'must be a data:image URL')
    .max(MAX_AVATAR_CHARS)
    .nullable(),
});

export interface MeRoutesOpts {
  defaultTokenLimit: () => number | undefined;
  cacheWeight: () => number | undefined;
  sessionResolver?: SessionResolver | undefined;
  chatSessions?: PersistentSessionStore | undefined;
  generations?: GenerationManager | undefined;
  apiKeys?: ApiKeyRepo | undefined;
  apiUsage?: ApiUsageRepo | undefined;
  apiQuotaWindowSec?: (() => number) | undefined;
  tenants?: TenantsRepo | undefined;
}

export function meRoutes(
  users: UsersRepo,
  tokenUsage: TokenUsageRepo,
  opts: MeRoutesOpts,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', requireAuth(users, opts.sessionResolver, opts.apiKeys, opts.tenants));

  // API-key management (spec 027) — human-session-only (a key can't manage keys).
  const apiKeys = opts.apiKeys;
  if (apiKeys) {
    app.get('/api-keys', requireHuman, (c) =>
      c.json({ keys: apiKeys.listForUser(c.get('user').id) }),
    );
    app.post('/api-keys', requireHuman, async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: { code: 'bad_request', message: 'invalid JSON body' } }, 400);
      }
      const parsed = createKeyBody.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'bad_request', message: 'invalid API key request' } }, 400);
      }
      const created = apiKeys.create({
        userId: c.get('user').id,
        tenantId: c.get('tenant').id, // the key belongs to the caller's active org (spec 029)
        name: parsed.data.name,
        ...(parsed.data.scopes ? { scopes: parsed.data.scopes } : {}),
        expiresAt: parsed.data.expiresAt ?? null,
      });
      // The plaintext secret is returned ONCE here and is never retrievable again.
      return c.json({ key: created.plaintext, ...created.view }, 201);
    });
    app.delete('/api-keys/:id', requireHuman, (c) => {
      const ok = apiKeys.revoke(c.req.param('id'), c.get('user').id);
      return ok
        ? c.json({ revoked: true })
        : c.json({ error: { code: 'not_found', message: 'key not found' } }, 404);
    });
  }

  // API request usage (spec 028) over the current quota window — total + per route class + per key.
  const apiUsage = opts.apiUsage;
  if (apiUsage) {
    // Any-key (spec 038 FR-203): self-introspection so a machine client can throttle itself.
    app.get('/api-usage', allowAnyKey, (c) => {
      const windowSec = opts.apiQuotaWindowSec?.() ?? 86_400;
      const since = new Date(Date.now() - windowSec * 1000).toISOString();
      return c.json({ windowSec, ...apiUsage.summaryForUser(c.get('user').id, since) });
    });
  }

  // Any-key (spec 038 FR-203): self-introspection of token quota so a machine client can throttle itself.
  app.get('/usage', allowAnyKey, (c) => {
    const user = c.get('user');
    const u = tokenUsage.usageForUser(user.id, user.usage_reset_at);
    const limit = effectiveLimit(user.token_limit, opts.defaultTokenLimit());
    // `used` is the billable total (cache hits discounted); the breakdown stays raw.
    return c.json({
      ...quotaView(billableTokens(u.used, u.cached, opts.cacheWeight()), limit),
      input: u.input,
      output: u.output,
      cached: u.cached,
      requests: u.requests,
      lastUsedAt: u.lastUsedAt,
    });
  });

  // Set or clear (null) the caller's profile picture. Human-only (spec 038 FR-201): a pure account
  // mutation with no machine use case — an API key (any scope) is refused.
  app.put('/avatar', requireHuman, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'invalid JSON body' } }, 400);
    }
    const parsed = avatarBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'bad_request', message: 'invalid avatar' } }, 400);
    }
    users.setAvatar(c.get('user').id, parsed.data.avatarUrl);
    return c.json({ avatarUrl: parsed.data.avatarUrl });
  });

  // Resumable chat history (only when a persistent store is wired). All scoped to the caller. Chat
  // scope required (spec 038 FR-202): a key that may hold conversations may manage/resume its own; a
  // read-only key gets 403 insufficient_scope.
  const sessions = opts.chatSessions;
  const chatScope = requireScope('chat');
  if (sessions) {
    app.get('/sessions', chatScope, (c) =>
      c.json({ sessions: sessions.listForUser(c.get('user').id) }),
    );

    app.get('/sessions/:id', chatScope, (c) => {
      const id = c.req.param('id');
      const conv = sessions.getForUser(id, c.get('user').id);
      if (!conv) return c.json({ error: { code: 'not_found', message: 'no such session' } }, 404);
      // If a generation is still running for this conversation, tell the client so it can re-attach.
      const activeId = opts.generations?.activeForSession(id);
      return c.json({ ...conv, ...(activeId ? { streaming: { messageId: activeId } } : {}) });
    });

    app.delete('/sessions/:id', chatScope, (c) => {
      if (!sessions.deleteForUser(c.req.param('id'), c.get('user').id)) {
        return c.json({ error: { code: 'not_found', message: 'no such session' } }, 404);
      }
      return c.json({ ok: true });
    });
  }

  // Mid-stream resume: re-attach to an in-flight generation's live token stream, or replay its result
  // if it just finished. Stop aborts it server-side. Both are ownership-checked via the generation's
  // recorded userId.
  // Chat scope required (spec 038 FR-202): attaching to / killing a live generation is a chat surface;
  // a read-only key gets 403 insufficient_scope.
  const generations = opts.generations;
  if (generations) {
    app.get('/generations/:id/stream', chatScope, (c) => {
      const snap = generations.snapshot(c.req.param('id'));
      if (!snap || snap.userId !== c.get('user').id) {
        return c.json({ error: { code: 'not_found', message: 'no such generation' } }, 404);
      }
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: 'session',
          data: JSON.stringify({ sessionId: snap.sessionId }),
        });
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({ messageId: snap.messageId }),
        });
        await streamGeneration(stream, generations, snap.messageId);
      });
    });

    app.post('/generations/:id/stop', chatScope, (c) => {
      const snap = generations.snapshot(c.req.param('id'));
      if (!snap || snap.userId !== c.get('user').id) {
        return c.json({ error: { code: 'not_found', message: 'no such generation' } }, 404);
      }
      generations.stop(snap.messageId);
      return c.json({ ok: true });
    });
  }

  return app;
}
