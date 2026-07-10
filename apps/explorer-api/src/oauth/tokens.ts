// OAuth access tokens for MCP (spec 063). Access tokens are STATELESS, app-signed JWTs (HS256 with a
// server secret — danni is both the Authorization Server and the Resource Server, so symmetric
// self-verification needs no JWKS). The token carries only identity + grant metadata — `sub` (app
// user id), `aud` (the MCP resource, RFC 8707), `scope`, `jti`, `client_id`. It deliberately carries
// NO role/tenant: the resource server resolves those FRESH per request (FR-484), so a demoted admin's
// still-valid token loses admin authority immediately. `jose` does the crypto + exp/aud/iss checks.
import { SignJWT, jwtVerify } from 'jose';

const ALG = 'HS256';

export interface SignAccessTokenInput {
  userId: string; // token subject (app user id)
  scope: string; // space-delimited granted scopes
  audience: string; // the MCP resource URI (RFC 8707)
  clientId: string;
}

export interface SignedAccessToken {
  token: string;
  jti: string;
  expiresInSec: number;
}

/** Sign a short-lived access-token JWT. `jti` + `now` are injected so callers (and tests) control them. */
export async function signAccessToken(
  input: SignAccessTokenInput,
  secret: Uint8Array,
  opts: { issuer: string; ttlSec: number; jti: string; now?: number },
): Promise<SignedAccessToken> {
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const token = await new SignJWT({ scope: input.scope, client_id: input.clientId })
    .setProtectedHeader({ alg: ALG })
    .setSubject(input.userId)
    .setAudience(input.audience)
    .setIssuer(opts.issuer)
    .setJti(opts.jti)
    .setIssuedAt(iat)
    .setExpirationTime(iat + opts.ttlSec)
    .sign(secret);
  return { token, jti: opts.jti, expiresInSec: opts.ttlSec };
}

export interface VerifiedAccessToken {
  sub: string; // app user id
  scope: string[];
  jti: string;
  clientId: string;
  aud: string;
  exp: number; // seconds since epoch
}

/**
 * Verify signature + `iss` + `aud` + `exp` and return the claims. Throws on any failure (bad
 * signature, wrong audience, expired) — the caller maps that to a 401. A wrong-audience token
 * (minted for a different resource) is rejected here, satisfying the RFC-8707 binding.
 */
export async function verifyAccessTokenJwt(
  token: string,
  secret: Uint8Array,
  opts: { issuer: string; audience: string | string[]; now?: number },
): Promise<VerifiedAccessToken> {
  // `audience` may be a SET of acceptable resources (spec 062): danni serves both the read (`/mcp`)
  // and admin (`/admin/mcp`) MCP resources, and a token bound to any of them verifies here. jose
  // accepts a `string[]` and matches if the token's `aud` is any member.
  const { payload } = await jwtVerify(token, secret, {
    algorithms: [ALG],
    issuer: opts.issuer,
    audience: opts.audience,
    ...(opts.now !== undefined ? { currentDate: new Date(opts.now) } : {}),
  });
  if (!payload.sub) throw new Error('token missing sub');
  if (!payload.jti) throw new Error('token missing jti');
  if (typeof payload.exp !== 'number') throw new Error('token missing exp');
  const scope = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
  // Report the token's ACTUAL audience (we always mint a single-string `aud`), not the accepted set.
  const aud = typeof payload.aud === 'string' ? payload.aud : (payload.aud?.[0] ?? '');
  return {
    sub: payload.sub,
    scope,
    jti: payload.jti,
    clientId: typeof payload.client_id === 'string' ? payload.client_id : '',
    aud,
    exp: payload.exp,
  };
}
