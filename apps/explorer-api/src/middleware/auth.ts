// Reads the identity a fronting Oathkeeper injects after validating the Kratos session (spec 019).
// Trusting these headers is an explicit operator opt-in (spec 034): they are honored ONLY when
// TRUST_PROXY_AUTH_HEADERS is set, which asserts a header-sanitizing proxy is the sole path to the
// app port. With trust off — the default, including single-port production where the app listens on
// :8790 directly — X-User-* has no effect and identity comes from the Kratos session resolver
// (cookie) or an API key. Unit tests still drive auth by setting the headers (no live Kratos,
// Constitution VI); they enable the opt-in in their setup.

import type { Context } from 'hono';

export interface AuthIdentity {
  userId: string | null; // Kratos identity id (X-User-ID subject)
  email: string | null;
  displayName: string | null;
  verified: boolean;
  sessionId: string | null;
  isAuthenticated: boolean;
}

const ANONYMOUS: AuthIdentity = {
  userId: null,
  email: null,
  displayName: null,
  verified: false,
  sessionId: null,
  isAuthenticated: false,
};

/** Operator opt-in (spec 034 FR-160): honor proxy-injected X-User-* identity headers. Default OFF. */
export function trustProxyAuthHeaders(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.TRUST_PROXY_AUTH_HEADERS ?? '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

export function readAuth(c: Context): AuthIdentity {
  // Without the opt-in the headers are spoofable by any client that can reach the port, so they
  // must have NO effect on the resolved identity (spec 034 FR-160/FR-161).
  if (!trustProxyAuthHeaders()) return ANONYMOUS;
  const userId = c.req.header('x-user-id') ?? null;
  const email = c.req.header('x-user-email') ?? null;
  const displayName = c.req.header('x-user-name') ?? null;
  const sessionId = c.req.header('x-session-id') ?? null;
  const verified = c.req.header('x-user-verified') === 'true';
  // Oathkeeper's anonymous authenticator sets the subject to "anonymous"; treat that (and a missing
  // header) as unauthenticated.
  const isAuthenticated = userId !== null && userId !== '' && userId !== 'anonymous';
  return { userId, email, displayName, verified, sessionId, isAuthenticated };
}
