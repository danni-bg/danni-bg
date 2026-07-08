// Focused unit coverage for otherwise-unexercised branches: RateLimiter.reset, Metrics.reset, the
// metrics-gate default client-IP resolver (no Bun socket), the readiness DB/migrations catch paths,
// and the Kratos proxy's request-body forwarding branch. Hermetic.

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Hono } from 'hono';
import { runMigrations } from '../../../src/store/migrate.ts';
import { kratosProxy } from '../src/auth/kratos-session.ts';
import { Metrics } from '../src/metrics.ts';
import { metricsAllowed } from '../src/middleware/metrics-gate.ts';
import { RateLimiter } from '../src/middleware/rate-limiter.ts';
import { checkReadiness } from '../src/readiness.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

describe('RateLimiter.reset', () => {
  it('clears one principal by prefix, and clears everything when no key is given', () => {
    const rl = new RateLimiter(() => 0);
    // Exhaust two principals at rate 1 (capacity 1): first take ok, second denied.
    expect(rl.take('alice:data', 1).ok).toBe(true);
    expect(rl.take('alice:data', 1).ok).toBe(false);
    expect(rl.take('bob:chat', 1).ok).toBe(true);

    // Reset only alice → alice gets a fresh bucket, bob's is untouched.
    rl.reset('alice');
    expect(rl.take('alice:data', 1).ok).toBe(true);
    expect(rl.take('bob:chat', 1).ok).toBe(false);

    // Reset everything.
    rl.reset();
    expect(rl.take('bob:chat', 1).ok).toBe(true);
  });
});

describe('Metrics.reset', () => {
  it('zeroes every counter', () => {
    const m = new Metrics();
    m.recordRequest('data', 200, 5, 't1');
    m.recordLlm({ inputTokens: 10, outputTokens: 5 }, 0.1, 't1');
    m.recordRateLimitRejection('data');
    m.recordQuotaRejection('tokens');
    m.recordChatOutcome('grounded');
    expect(m.snapshot().requestsTotal).toBe(1);

    m.reset();
    const s = m.snapshot();
    expect(s.requestsTotal).toBe(0);
    expect(s.llmTokens).toEqual({ input: 0, output: 0, cached: 0 });
    expect(s.rateLimitRejections).toBe(0);
    expect(s.quotaRejections).toEqual({});
    expect(s.chatOutcomes).toEqual({});
    // A previously-seen tenant series is forgotten (cardinality bound reset).
    expect(m.prometheus()).not.toContain('tenant="t1"');
  });
});

describe('metricsAllowed default client IP', () => {
  it('falls back to the socket resolver, which yields undefined without a Bun socket (no CIDR match)', () => {
    // No clientIp override → defaultClientIp runs getConnInfo, which throws for a plain Request; the
    // catch returns undefined, so the CIDR leg simply does not match and the gated request is refused.
    const req = new Request('http://localhost/metrics');
    const c = new Context(req);
    expect(metricsAllowed({ allowCidrs: ['10.0.0.0/8'], failClosedWhenUnset: true }, c)).toBe(
      false,
    );
  });
});

describe('checkReadiness failure paths', () => {
  it('reports db + migrations false when the DB handle is unusable', () => {
    const db = new Database(':memory:');
    db.close(); // every query now throws → both try/catch fallbacks fire
    const r = checkReadiness({ db, migrationsDir: MIGRATIONS });
    expect(r.checks.db).toBe(false);
    expect(r.checks.migrationsCurrent).toBe(false);
    expect(r.ready).toBe(false);
  });
});

describe('checkReadiness provider-resolution failure', () => {
  it('reports providerConfigured false when the settings lookup throws', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS);
    // A settings repo whose read throws → resolveServerDefault throws → the providerConfigured
    // try/catch swallows it (readiness.ts catch), leaving readiness itself unaffected.
    const settings = {
      get() {
        throw new Error('settings unavailable');
      },
    } as unknown as import('../../../src/store/repos/platform-settings.ts').PlatformSettingsRepo;
    const r = checkReadiness({ db, migrationsDir: MIGRATIONS, settings });
    expect(r.checks.providerConfigured).toBe(false);
    expect(r.checks.db).toBe(true);
    expect(r.ready).toBe(true); // provider does not gate readiness
    db.close();
  });
});

describe('kratosProxy body forwarding', () => {
  it('forwards a POST body with the half-duplex flag', async () => {
    const seen: { method?: string | undefined; body: unknown; duplex?: string | undefined } = {
      body: null,
    };
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.method = init?.method;
      seen.body = init?.body ?? null;
      seen.duplex = (init as { duplex?: string } | undefined)?.duplex;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const app = new Hono();
    app.all('/kratos/*', kratosProxy('http://kratos:4433', impl));
    const res = await app.request('/kratos/self-service/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(200);
    expect(seen.method).toBe('POST');
    expect(seen.body).not.toBeNull(); // the request body stream was forwarded
    expect(seen.duplex).toBe('half');
  });
});
