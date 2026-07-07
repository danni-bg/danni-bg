// /metrics exposure gate (spec 045 FR-273 / SC-4) — hermetic. /healthz + /readyz stay public probes;
// /metrics is gated by a bearer token / CIDR allowlist, and a non-dev profile with no gate fails closed.

import { describe, expect, it } from 'bun:test';
import { Context } from 'hono';
import type { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import type { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import { Metrics } from '../src/metrics.ts';
import {
  type MetricsGateConfig,
  metricsAllowed,
  metricsGateFromEnv,
} from '../src/middleware/metrics-gate.ts';
import type { ReadBridge } from '../src/read-bridge.ts';

/** A minimal Hono Context carrying just an Authorization header — enough for metricsAllowed. */
function ctxWithAuth(authorization?: string): Context {
  const req = new Request('http://localhost/metrics', {
    headers: authorization ? { authorization } : {},
  });
  return new Context(req);
}

describe('metricsGateFromEnv (spec 045 FR-273)', () => {
  it('a dev-like profile with no gate defaults OPEN', () => {
    const cfg = metricsGateFromEnv({ DANNI_PROFILE: 'dev' } as NodeJS.ProcessEnv);
    expect(cfg.failClosedWhenUnset).toBe(false);
    expect(cfg.token).toBeUndefined();
    expect(cfg.allowCidrs).toBeUndefined();
  });

  it('a production profile with no gate FAILS CLOSED', () => {
    const cfg = metricsGateFromEnv({ DANNI_PROFILE: 'production' } as NodeJS.ProcessEnv);
    expect(cfg.failClosedWhenUnset).toBe(true);
  });

  it('parses the bearer token + CIDR allowlist from env', () => {
    const cfg = metricsGateFromEnv({
      DANNI_PROFILE: 'production',
      METRICS_TOKEN: '  secret-123  ',
      METRICS_ALLOW_CIDR: '10.0.0.0/8, 192.168.1.5',
    } as NodeJS.ProcessEnv);
    expect(cfg.token).toBe('secret-123');
    expect(cfg.allowCidrs).toEqual(['10.0.0.0/8', '192.168.1.5']);
  });
});

describe('metricsAllowed (spec 045 FR-273 / SC-4)', () => {
  it('admits a matching bearer token, refuses a wrong/absent one', () => {
    const cfg: MetricsGateConfig = { token: 'sekret', failClosedWhenUnset: true };
    expect(metricsAllowed(cfg, ctxWithAuth('Bearer sekret'))).toBe(true);
    expect(metricsAllowed(cfg, ctxWithAuth('Bearer nope'))).toBe(false);
    expect(metricsAllowed(cfg, ctxWithAuth())).toBe(false);
  });

  it('no gate configured: dev serves open, non-dev fails closed', () => {
    expect(metricsAllowed({ failClosedWhenUnset: false }, ctxWithAuth())).toBe(true);
    expect(metricsAllowed({ failClosedWhenUnset: true }, ctxWithAuth())).toBe(false);
  });

  it('admits an IP inside the CIDR allowlist, refuses one outside', () => {
    const base: MetricsGateConfig = {
      allowCidrs: ['10.0.0.0/8', '192.168.1.42'],
      failClosedWhenUnset: true,
    };
    const withIp = (ip: string): MetricsGateConfig => ({ ...base, clientIp: () => ip });
    expect(metricsAllowed(withIp('10.5.6.7'), ctxWithAuth())).toBe(true); // in /8
    expect(metricsAllowed(withIp('192.168.1.42'), ctxWithAuth())).toBe(true); // exact /32
    expect(metricsAllowed(withIp('192.168.1.43'), ctxWithAuth())).toBe(false); // outside
    expect(metricsAllowed(withIp('11.0.0.1'), ctxWithAuth())).toBe(false); // outside /8
    // No resolvable IP (e.g. app.request in tests) → CIDR simply doesn't match.
    expect(metricsAllowed({ ...base, clientIp: () => undefined }, ctxWithAuth())).toBe(false);
  });

  it('token OR CIDR: either satisfies the gate', () => {
    const cfg: MetricsGateConfig = {
      token: 'tok',
      allowCidrs: ['10.0.0.0/8'],
      failClosedWhenUnset: true,
      clientIp: () => '10.1.1.1',
    };
    expect(metricsAllowed(cfg, ctxWithAuth('Bearer tok'))).toBe(true); // token path
    expect(metricsAllowed(cfg, ctxWithAuth('Bearer wrong'))).toBe(true); // CIDR path still admits
  });
});

describe('/metrics exposure on the app (spec 045 SC-4)', () => {
  function appWith(metricsGate: MetricsGateConfig): ReturnType<typeof createApp> {
    const ctx: AppContext = {
      bridge: {} as ReadBridge,
      crosswalk: {} as Crosswalk,
      users: {} as UsersRepo,
      metrics: new Metrics(),
      metricsGate,
      health: () => ({ lastSyncedAt: null, isStale: false, defaultProvider: 'configured' }),
      readiness: () => ({
        ready: true,
        checks: { db: true, migrationsCurrent: true, providerConfigured: true },
      }),
    };
    return createApp(ctx);
  }

  it('production profile, no gate: /metrics is refused while /healthz + /readyz answer', async () => {
    const app = appWith({ failClosedWhenUnset: true });
    expect((await app.request('/metrics')).status).toBe(404);
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/readyz')).status).toBe(200);
  });

  it('a bearer-token gate admits the scraper with the token, refuses without', async () => {
    const app = appWith({ token: 'scrape-me', failClosedWhenUnset: true });
    expect((await app.request('/metrics')).status).toBe(404);
    const ok = await app.request('/metrics', { headers: { authorization: 'Bearer scrape-me' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/plain');
  });

  it('a dev profile with no gate serves /metrics openly', async () => {
    const app = appWith({ failClosedWhenUnset: false });
    expect((await app.request('/metrics')).status).toBe(200);
  });
});
