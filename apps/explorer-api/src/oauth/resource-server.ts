// Resource-server side of MCP OAuth (spec 063). Validates an access token and resolves the app
// principal FRESH — the token carries only `sub`/`scope`/`jti` (no role/tenant), so a demoted admin's
// still-valid token loses admin authority immediately (FR-484). Returns null on any failure (bad
// signature/audience/expiry, revoked jti, or a subject whose user row is gone); the caller maps null
// to `401`. Role + active tenant are read off the returned `user` by the downstream guard, exactly as
// requireAuth does for sessions/keys.
import type { OAuthRevocationsRepo } from '../../../../src/store/repos/oauth.ts';
import type { UserRow, UsersRepo } from '../../../../src/store/repos/users.ts';
import { verifyAccessTokenJwt } from './tokens.ts';

export interface OAuthPrincipal {
  user: UserRow;
  scopes: string[];
  clientId: string;
  jti: string;
}

export interface AccessTokenVerifierDeps {
  secret: Uint8Array;
  issuer: string;
  resource: string; // the MCP resource URI this server is (RFC 8707 audience)
  revocations: OAuthRevocationsRepo;
  users: UsersRepo;
}

export type AccessTokenVerifier = (token: string, now?: number) => Promise<OAuthPrincipal | null>;

export function createAccessTokenVerifier(deps: AccessTokenVerifierDeps): AccessTokenVerifier {
  return async (token, now) => {
    let claims: Awaited<ReturnType<typeof verifyAccessTokenJwt>>;
    try {
      claims = await verifyAccessTokenJwt(token, deps.secret, {
        issuer: deps.issuer,
        audience: deps.resource,
        ...(now !== undefined ? { now } : {}),
      });
    } catch {
      return null; // bad signature / wrong audience / expired / malformed
    }
    if (deps.revocations.isRevoked(claims.jti)) return null;
    const user = deps.users.get(claims.sub); // resolve FRESH — never trust a role/tenant baked in a token
    if (!user) return null;
    return { user, scopes: claims.scope, clientId: claims.clientId, jti: claims.jti };
  };
}
