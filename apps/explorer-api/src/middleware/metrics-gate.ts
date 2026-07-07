// /metrics exposure gate (spec 045 FR-273). `/healthz` + `/readyz` stay public probes; `/metrics`
// leaks traffic volumes, per-tenant labels, and LLM spend, so it is gated by a bearer token AND/OR a
// CIDR allowlist supplied via env (the deploy repo sets these on the scrape path). The posture when NO
// gate is configured depends on the profile: a dev-like profile defaults OPEN (local scrapes / tests),
// while any non-dev profile (e.g. `production`) FAILS CLOSED — an unset gate returns 404, never leaking.

import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';
import { DEV_PROFILES } from '../../../../src/lib/secret-scan.ts';

export interface MetricsGateConfig {
  /** Bearer token; a request presenting `Authorization: Bearer <token>` is admitted. */
  token?: string;
  /** CIDR allowlist (IPv4 `a.b.c.d/n` or a bare IP); a client IP inside any range is admitted. */
  allowCidrs?: readonly string[];
  /** When neither token nor CIDR is configured: dev profiles serve openly, non-dev fails closed. */
  failClosedWhenUnset: boolean;
  /** Resolve the client IP (injectable for hermetic tests); defaults to the socket peer via Bun. */
  clientIp?: (c: Context) => string | undefined;
}

/** Build the gate config from the process environment + `DANNI_PROFILE` (production ⇒ fail closed). */
export function metricsGateFromEnv(env: NodeJS.ProcessEnv): MetricsGateConfig {
  const profile = (env.DANNI_PROFILE ?? 'dev').toLowerCase();
  const token = env.METRICS_TOKEN?.trim() || undefined;
  const allowCidrs = (env.METRICS_ALLOW_CIDR ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ...(token ? { token } : {}),
    ...(allowCidrs.length ? { allowCidrs } : {}),
    failClosedWhenUnset: !DEV_PROFILES.has(profile),
  };
}

/** Constant-time string comparison so a bearer-token check can't be timed byte-by-byte. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function defaultClientIp(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined; // no Bun socket (e.g. app.request() in tests) — CIDR simply doesn't match
  }
}

/** True when `ip` (IPv4) falls inside `a.b.c.d/n`; a bare IP is treated as /32. IPv6 → exact match. */
function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  if (!range) return false;
  const bits = bitsRaw === undefined ? 32 : Number.parseInt(bitsRaw, 10);
  const ipN = ipv4ToInt(ip);
  const rangeN = ipv4ToInt(range);
  if (ipN === null || rangeN === null) return ip === range; // non-IPv4 (e.g. IPv6) → exact compare
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1) >>> 0) >>> 0;
  return (ipN & mask) === (rangeN & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number.parseInt(p, 10);
    if (!Number.isInteger(o) || o < 0 || o > 255 || String(o) !== p) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

/** Decide whether this `/metrics` request is admitted under the gate config. */
export function metricsAllowed(cfg: MetricsGateConfig, c: Context): boolean {
  const hasGate = !!cfg.token || (cfg.allowCidrs?.length ?? 0) > 0;
  if (cfg.token) {
    const authz = c.req.header('authorization') ?? '';
    const presented = authz.startsWith('Bearer ') ? authz.slice('Bearer '.length).trim() : '';
    if (presented && constantTimeEqual(presented, cfg.token)) return true;
  }
  if (cfg.allowCidrs?.length) {
    const ip = (cfg.clientIp ?? defaultClientIp)(c);
    if (ip && cfg.allowCidrs.some((cidr) => ipInCidr(ip, cidr))) return true;
  }
  // A gate is configured but this request satisfied none of it → refuse.
  if (hasGate) return false;
  // No gate configured: dev serves openly; a non-dev profile fails closed (FR-273).
  return !cfg.failClosedWhenUnset;
}
