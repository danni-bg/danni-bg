// API metering + rate limits + request quota (spec 028) — hermetic. The public read API is free for
// anonymous callers and metered/limited/quota'd for API-key callers; the chat route is rate-limited.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type MiddlewareHandler } from 'hono';
import { runMigrations } from '../../../src/store/migrate.ts';
import { ApiKeyRepo } from '../../../src/store/repos/api-keys.ts';
import { ApiUsageRepo } from '../../../src/store/repos/api-usage.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { Metrics } from '../src/metrics.ts';
import { chatMeter, dataApiGate } from '../src/middleware/api-metering.ts';
import { RateLimiter } from '../src/middleware/rate-limiter.ts';
import { requireAuth, requireScope } from '../src/middleware/require-auth.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function setup(
  over: Partial<{ rateData: number; rateChat: number; quotaData: number; metrics: Metrics }> = {},
) {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  const apiKeys = new ApiKeyRepo(db);
  const apiUsage = new ApiUsageRepo(db);
  const owner = users.findOrCreateByKratosId({ kratosIdentityId: 'k1', email: 'u@example.com' });
  const limiter = new RateLimiter(() => 1_000_000);
  const cfg = {
    rateData: over.rateData ?? 1000,
    rateChat: over.rateChat ?? 1000,
    quotaData: over.quotaData ?? 1_000_000,
    quotaWindowSec: 86_400,
  };
  const deps = {
    usage: apiUsage,
    limiter,
    config: {
      rateData: () => cfg.rateData,
      rateChat: () => cfg.rateChat,
      quotaData: () => cfg.quotaData,
      quotaWindowSec: () => cfg.quotaWindowSec,
    },
    ...(over.metrics ? { metrics: over.metrics } : {}),
  };
  const app = new Hono();
  app.use('/data', dataApiGate(apiKeys, deps));
  app.get('/data', (c) => c.json({ ok: true }));
  // A gated route whose HANDLER rejects with 400 — for the record-vs-gate semantic (spec 040 FR-222):
  // the request was admitted past the gate, so it must still be counted despite the handler's 400.
  app.use('/data-reject', dataApiGate(apiKeys, deps));
  app.get('/data-reject', (c) => c.json({ error: { code: 'bad_request' } }, 400));
  app.use(
    '/chat',
    requireAuth(users, undefined, apiKeys) as MiddlewareHandler,
    requireScope('chat') as MiddlewareHandler,
    chatMeter(deps) as MiddlewareHandler,
  );
  app.get('/chat', (c) => c.json({ ok: true }));
  app.use(
    '/chat-reject',
    requireAuth(users, undefined, apiKeys) as MiddlewareHandler,
    requireScope('chat') as MiddlewareHandler,
    chatMeter(deps) as MiddlewareHandler,
  );
  app.get('/chat-reject', (c) => c.json({ error: { code: 'bad_request' } }, 400));
  return { db, users, apiKeys, apiUsage, owner, app };
}

const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

describe('API metering (spec 028; principal/limit semantics spec 040)', () => {
  let s: ReturnType<typeof setup>;
  afterEach(() => s.db.close());

  it('anonymous read is free + unmetered; an API-key read is metered', async () => {
    s = setup();
    expect((await s.app.request('/data')).status).toBe(200);
    expect(s.apiUsage.countSince(s.owner.id, '2000-01-01T00:00:00.000Z')).toBe(0);

    const { plaintext } = s.apiKeys.create({ userId: s.owner.id, name: 'k' });
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(200);
    expect(s.apiUsage.countSince(s.owner.id, '2000-01-01T00:00:00.000Z', 'data')).toBe(1);
  });

  it('rate-limits an API-key caller with 429 + Retry-After', async () => {
    s = setup({ rateData: 1 });
    const { plaintext } = s.apiKeys.create({ userId: s.owner.id, name: 'k' });
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(200);
    const res = await s.app.request('/data', bearer(plaintext));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('enforces the data request quota with 429 quota_exceeded', async () => {
    s = setup({ quotaData: 2 });
    const { plaintext } = s.apiKeys.create({ userId: s.owner.id, name: 'k' });
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(200);
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(200);
    const res = await s.app.request('/data', bearer(plaintext));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('quota_exceeded');
  });

  it('a per-key quota override (set via the repo path) beats the plan default', async () => {
    s = setup({ quotaData: 1000 });
    const { plaintext, view } = s.apiKeys.create({ userId: s.owner.id, name: 'k' });
    expect(s.apiKeys.setQuotaLimit(view.id, 1)).toBe(true); // spec 040 FR-221: settable, no SQL
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(200);
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(429);
    // FR-221: the override is visible wherever the key is listed.
    expect(s.apiKeys.listForUser(s.owner.id).find((k) => k.id === view.id)?.quotaLimit).toBe(1);
    // FR-221: clearing it (null) falls the key back to the plan default (SC-2).
    expect(s.apiKeys.setQuotaLimit(view.id, null)).toBe(true);
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(200);
  });

  // SC-1: two keys of ONE user meter independently. The quota/rate principal is the KEY (FR-220), so
  // exhausting key A must not throttle key B, and key B's cap counts only key B's own requests.
  it('two keys of one user meter independently (per-key quota principal)', async () => {
    s = setup({ quotaData: 1000 });
    const a = s.apiKeys.create({ userId: s.owner.id, name: 'A' });
    const b = s.apiKeys.create({ userId: s.owner.id, name: 'B' });
    s.apiKeys.setQuotaLimit(a.view.id, 1);
    s.apiKeys.setQuotaLimit(b.view.id, 1);
    // Exhaust key A.
    expect((await s.app.request('/data', bearer(a.plaintext))).status).toBe(200);
    expect((await s.app.request('/data', bearer(a.plaintext))).status).toBe(429);
    // Key B is unaffected — its cap sees only B's (zero) prior requests.
    expect((await s.app.request('/data', bearer(b.plaintext))).status).toBe(200);
    expect((await s.app.request('/data', bearer(b.plaintext))).status).toBe(429);
    // Each key's own usage was counted, not the owner's aggregate.
    expect(s.apiUsage.countSinceForKey(a.view.id, '2000-01-01T00:00:00.000Z', 'data')).toBe(1);
    expect(s.apiUsage.countSinceForKey(b.view.id, '2000-01-01T00:00:00.000Z', 'data')).toBe(1);
  });

  // SC-1 (rate): the rate bucket is keyed by the KEY, so a rate-exhausted key A doesn't throttle key B.
  it('the rate bucket is keyed by the API key, not the owner', async () => {
    s = setup({ rateData: 1 });
    const a = s.apiKeys.create({ userId: s.owner.id, name: 'A' });
    const b = s.apiKeys.create({ userId: s.owner.id, name: 'B' });
    expect((await s.app.request('/data', bearer(a.plaintext))).status).toBe(200);
    expect((await s.app.request('/data', bearer(a.plaintext))).status).toBe(429); // A rate-limited
    expect((await s.app.request('/data', bearer(b.plaintext))).status).toBe(200); // B unaffected
  });

  // SC-4: the request-quota 429 carries a Retry-After consistent with the configured window (FR-223).
  it('the request-quota 429 sets Retry-After from the window', async () => {
    s = setup({ quotaData: 1 });
    const { plaintext } = s.apiKeys.create({ userId: s.owner.id, name: 'k' });
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(200);
    const res = await s.app.request('/data', bearer(plaintext));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('quota_exceeded');
    expect(res.headers.get('Retry-After')).toBe('86400');
  });

  // Spec 045 SC-3 / FR-272: a request-quota 429 increments danni_quota_rejections_total{kind="requests"}
  // (distinct from the rate-limit counter), by exactly the rejection count.
  it('request-quota 429 increments the quota-rejection counter, not the rate-limit counter', async () => {
    const metrics = new Metrics();
    s = setup({ quotaData: 1, metrics });
    const { plaintext } = s.apiKeys.create({ userId: s.owner.id, name: 'k' });
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(200);
    // Two more requests are both over-quota → two quota rejections.
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(429);
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(429);
    const snap = metrics.snapshot();
    expect(snap.quotaRejections).toEqual({ requests: 2 });
    expect(snap.rateLimitRejections).toBe(0); // a quota rejection is NOT a rate-limit rejection
  });

  // A rate-limit 429 stays on the rate-limit counter — the two signals never cross-contaminate.
  it('rate-limit 429 increments the rate-limit counter, not the quota-rejection counter', async () => {
    const metrics = new Metrics();
    s = setup({ rateData: 1, metrics });
    const { plaintext } = s.apiKeys.create({ userId: s.owner.id, name: 'k' });
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(200);
    expect((await s.app.request('/data', bearer(plaintext))).status).toBe(429);
    const snap = metrics.snapshot();
    expect(snap.rateLimitRejections).toBe(1);
    expect(snap.quotaRejections).toEqual({});
  });

  // SC-3: one recording semantic on BOTH gates — counted iff admitted past the gate; a handler-level
  // 400 still counts, but a gate-level rejection (scope/rate/quota) does not (FR-222).
  it('records iff admitted past the gate — handler 400 counts, gate rejection does not', async () => {
    s = setup();
    const since = '2000-01-01T00:00:00.000Z';
    const key = s.apiKeys.create({ userId: s.owner.id, name: 'k' });

    // Admitted past both gates, then rejected by the handler with 400 → still counted, on both routes.
    expect((await s.app.request('/data-reject', bearer(key.plaintext))).status).toBe(400);
    expect((await s.app.request('/chat-reject', bearer(key.plaintext))).status).toBe(400);
    expect(s.apiUsage.countSince(s.owner.id, since, 'data')).toBe(1);
    expect(s.apiUsage.countSince(s.owner.id, since, 'chat')).toBe(1);

    // Rejected AT the gate (missing read scope) → not counted.
    const chatOnly = s.apiKeys.create({ userId: s.owner.id, name: 'c', scopes: ['chat'] });
    expect((await s.app.request('/data', bearer(chatOnly.plaintext))).status).toBe(403);
    expect(s.apiUsage.countSince(s.owner.id, since, 'data')).toBe(1); // unchanged
  });

  it('rejects a revoked key and a key without read scope on the data API', async () => {
    s = setup();
    const revoked = s.apiKeys.create({ userId: s.owner.id, name: 'r' });
    s.apiKeys.revoke(revoked.view.id, s.owner.id);
    expect((await s.app.request('/data', bearer(revoked.plaintext))).status).toBe(401);

    const noRead = s.apiKeys.create({ userId: s.owner.id, name: 'chat-only', scopes: ['chat'] });
    const res = await s.app.request('/data', bearer(noRead.plaintext));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'insufficient_scope',
    );
  });

  it('rejects an expired key on the data API with a distinct code', async () => {
    s = setup();
    const expired = s.apiKeys.create({
      userId: s.owner.id,
      name: 'e',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const res = await s.app.request('/data', bearer(expired.plaintext));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('api_key_expired');
  });

  it('meters + rate-limits the chat route', async () => {
    s = setup({ rateChat: 1 });
    const { plaintext } = s.apiKeys.create({ userId: s.owner.id, name: 'k' });
    expect((await s.app.request('/chat', bearer(plaintext))).status).toBe(200);
    expect(s.apiUsage.countSince(s.owner.id, '2000-01-01T00:00:00.000Z', 'chat')).toBe(1);
    expect((await s.app.request('/chat', bearer(plaintext))).status).toBe(429);
  });
});
