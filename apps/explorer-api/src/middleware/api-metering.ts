// API metering + rate limits + request quota (spec 028; principal/limit semantics amended by spec 040).
// Two entry points:
//   chatMeter   — runs AFTER requireAuth on the gated chat route: rate-limit + record. (The chat
//                 TOKEN quota stays in spec 021/039; this adds a request rate limit + usage record.)
//   dataApiGate — standalone on the public read API: anonymous browser traffic stays free; an
//                 API-key caller is authenticated, rate-limited, request-quota'd, and recorded.
//
// Recording semantic (spec 040 FR-222): a request is counted in `api_usage` IFF it is admitted past
// its gate — i.e. all of {auth, scope, rate, request-quota} that the gate checks have passed. Once
// admitted, the handler's OWN outcome is irrelevant: a 400 (invalid body), 404/5xx, or the chat
// token-quota 429 (routes/chat.ts, spec 021/039) still counts, because it consumed an admitted slot.
// Both gates therefore record BEFORE `next()`, after the same class of gate checks, so "one request"
// means the same thing on the data and chat routes.
//
// Attribution unit (spec 040 FR-220): for keyed data-API traffic the rate bucket and the request-quota
// count both key off the API KEY (`key.id`), matching the per-key `quota_limit` the gate caps against —
// a key is throttled by its own traffic only, never its owner's other keys.

import type { MiddlewareHandler } from 'hono';
import {
  API_KEY_NAMESPACE,
  type ApiKeyRepo,
  parseScopes,
} from '../../../../src/store/repos/api-keys.ts';
import type { ApiUsageRepo } from '../../../../src/store/repos/api-usage.ts';
import type { Metrics } from '../metrics.ts';
import type { RateLimiter } from './rate-limiter.ts';
import type { AuthEnv } from './require-auth.ts';

export interface ApiMeterConfig {
  rateData: () => number; // req/min, 0 = unlimited
  rateChat: () => number;
  quotaData: () => number; // requests per window, 0 = unlimited
  quotaWindowSec: () => number;
}

export interface ApiMeterDeps {
  usage: ApiUsageRepo;
  limiter: RateLimiter;
  config: ApiMeterConfig;
  now?: () => number;
  /** Telemetry registry (spec 032): rate-limit/quota 429s are counted when wired. */
  metrics?: Metrics;
}

const windowStart = (sec: number, now: number): string => new Date(now - sec * 1000).toISOString();
const rateLimited = (c: Parameters<MiddlewareHandler>[0], retryAfterSec: number) => {
  c.header('Retry-After', String(retryAfterSec));
  return c.json({ error: { code: 'rate_limited', message: 'too many requests' } }, 429);
};

/** Chat route metering (after requireAuth). Token-quota stays in spec 021; here we rate-limit + record. */
export function chatMeter(deps: ApiMeterDeps): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = c.get('user');
    const key = c.get('apiKey');
    const tenantId = c.get('tenant')?.id;
    const rl = deps.limiter.take(`${user.id}:chat`, deps.config.rateChat());
    if (!rl.ok) {
      deps.metrics?.recordRateLimitRejection('chat');
      return rateLimited(c, rl.retryAfterSec);
    }
    // FR-222: record here — admitted past the gate (auth + scope upstream, rate above). The handler's
    // own outcome (bad body → 400, or the token-quota 429 in routes/chat.ts) still counts, matching
    // dataApiGate: both gates record before `next()`, after the same class of gate checks.
    try {
      deps.usage.record({
        principalKind: key ? 'apiKey' : 'user',
        principalId: user.id,
        ...(tenantId ? { tenantId } : {}),
        keyId: key?.id ?? null,
        routeClass: 'chat',
      });
    } catch {
      // metering is best-effort — never fail the request on a usage write
    }
    await next();
    return undefined;
  };
}

/** Public read API gate: anonymous traffic is free; an API-key caller is auth'd + limited + metered. */
export function dataApiGate(
  apiKeys: ApiKeyRepo | undefined,
  deps: ApiMeterDeps,
): MiddlewareHandler {
  const now = deps.now ?? Date.now;
  return async (c, next) => {
    // Overlapping path registrations (`/api/datasets` + `/api/datasets/*`) can both match one request;
    // meter/limit it exactly once.
    if (c.get('apiMetered')) {
      await next();
      return undefined;
    }
    c.set('apiMetered', true);
    const authz = c.req.header('authorization');
    const secret = authz?.startsWith('Bearer ') ? authz.slice('Bearer '.length).trim() : '';
    // No (or non-ours) credential → anonymous public read: free, unmetered, unlimited.
    if (!apiKeys || !secret.startsWith(API_KEY_NAMESPACE)) {
      await next();
      return undefined;
    }
    const res = apiKeys.resolveBySecret(secret);
    if (res.status !== 'ok') {
      const code =
        res.status === 'revoked'
          ? 'api_key_revoked'
          : res.status === 'expired'
            ? 'api_key_expired'
            : 'unauthorized';
      return c.json({ error: { code, message: 'invalid API key' } }, 401);
    }
    if (!parseScopes(res.key).includes('read')) {
      return c.json(
        { error: { code: 'insufficient_scope', message: "API key lacks 'read' scope" } },
        403,
      );
    }
    const key = res.key;
    // FR-220: rate + quota attribute to the KEY (not its owner), so the per-key `quota_limit` the gate
    // caps against compares against that same key's own usage.
    const rl = deps.limiter.take(`${key.id}:data`, deps.config.rateData());
    if (!rl.ok) {
      deps.metrics?.recordRateLimitRejection('data');
      return rateLimited(c, rl.retryAfterSec);
    }
    const cap = key.quota_limit ?? deps.config.quotaData();
    if (cap > 0) {
      const windowSec = deps.config.quotaWindowSec();
      const used = deps.usage.countSinceForKey(key.id, windowStart(windowSec, now()), 'data');
      if (used >= cap) {
        deps.metrics?.recordRateLimitRejection('data');
        // FR-223: the request-quota 429 is a correct HTTP citizen — advertise Retry-After from the
        // rolling window, matching the rate-limit 429 above.
        c.header('Retry-After', String(windowSec));
        return c.json(
          { error: { code: 'quota_exceeded', message: 'request quota exceeded' } },
          429,
        );
      }
    }
    try {
      deps.usage.record({
        principalKind: 'apiKey',
        principalId: key.user_id,
        ...(key.tenant_id ? { tenantId: key.tenant_id } : {}),
        keyId: key.id,
        routeClass: 'data',
      });
    } catch {
      // best-effort
    }
    await next();
    return undefined;
  };
}
