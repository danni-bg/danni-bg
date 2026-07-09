// OAuth crypto core (spec 063) — JWT access tokens + PKCE S256. Hermetic, deterministic (injected
// `now`/`jti`). No DB, no network.
import { describe, expect, it } from 'bun:test';
import { s256Challenge, verifyPkceS256 } from '../src/oauth/pkce.ts';
import { signAccessToken, verifyAccessTokenJwt } from '../src/oauth/tokens.ts';

const secret = new TextEncoder().encode('test-signing-secret-0123456789abcdef');
const ISSUER = 'https://danni.example/';
const RESOURCE = 'https://danni.example/mcp';
const T0 = 1_800_000_000_000; // fixed epoch ms

describe('PKCE S256 (RFC 7636)', () => {
  // The canonical RFC 7636 Appendix B vector.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  it('computes the canonical challenge for a verifier', async () => {
    expect(await s256Challenge(verifier)).toBe(challenge);
  });
  it('verifies a matching verifier/challenge', async () => {
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
  });
  it('rejects a mismatched verifier', async () => {
    expect(await verifyPkceS256('wrong-verifier', challenge)).toBe(false);
  });
  it('rejects an empty verifier or challenge', async () => {
    expect(await verifyPkceS256('', challenge)).toBe(false);
    expect(await verifyPkceS256(verifier, '')).toBe(false);
  });
});

describe('access-token JWT', () => {
  const input = {
    userId: 'user-1',
    scope: 'mcp:read mcp:admin',
    audience: RESOURCE,
    clientId: 'client-1',
  };
  const opts = { issuer: ISSUER, ttlSec: 600, jti: 'jti-1', now: T0 };

  it('round-trips subject, scope, jti, client, audience', async () => {
    const { token, jti, expiresInSec } = await signAccessToken(input, secret, opts);
    expect(jti).toBe('jti-1');
    expect(expiresInSec).toBe(600);
    const v = await verifyAccessTokenJwt(token, secret, {
      issuer: ISSUER,
      audience: RESOURCE,
      now: T0,
    });
    expect(v.sub).toBe('user-1');
    expect(v.scope).toEqual(['mcp:read', 'mcp:admin']);
    expect(v.jti).toBe('jti-1');
    expect(v.clientId).toBe('client-1');
    expect(v.exp).toBe(Math.floor(T0 / 1000) + 600);
  });

  it('rejects a token presented at a different resource (RFC 8707 audience binding)', async () => {
    const { token } = await signAccessToken(input, secret, opts);
    await expect(
      verifyAccessTokenJwt(token, secret, {
        issuer: ISSUER,
        audience: 'https://danni.example/other',
        now: T0,
      }),
    ).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const { token } = await signAccessToken(input, secret, { ...opts, ttlSec: 60 });
    // 61s later → past exp.
    await expect(
      verifyAccessTokenJwt(token, secret, { issuer: ISSUER, audience: RESOURCE, now: T0 + 61_000 }),
    ).rejects.toThrow();
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await signAccessToken(input, secret, opts);
    await expect(
      verifyAccessTokenJwt(token, new TextEncoder().encode('other-secret'), {
        issuer: ISSUER,
        audience: RESOURCE,
        now: T0,
      }),
    ).rejects.toThrow();
  });

  it('rejects a token from a different issuer', async () => {
    const { token } = await signAccessToken(input, secret, opts);
    await expect(
      verifyAccessTokenJwt(token, secret, {
        issuer: 'https://evil.example/',
        audience: RESOURCE,
        now: T0,
      }),
    ).rejects.toThrow();
  });

  it('defaults `now` to the wall clock when omitted', async () => {
    const { token } = await signAccessToken(input, secret, {
      issuer: ISSUER,
      ttlSec: 600,
      jti: 'j2',
    });
    const v = await verifyAccessTokenJwt(token, secret, { issuer: ISSUER, audience: RESOURCE });
    expect(v.sub).toBe('user-1');
  });
});
