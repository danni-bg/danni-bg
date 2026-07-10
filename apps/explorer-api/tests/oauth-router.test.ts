// OAuth 2.1 AS endpoints (spec 063 P3) — hermetic, drives the Hono router via app.request with a mock
// Kratos session resolver + an in-memory store. Covers metadata, DCR, authorize (validation, login
// redirect, consent, auto-consent), token (PKCE + all error branches), and revoke.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../../src/store/migrate.ts';
import {
  OAuthClientsRepo,
  OAuthCodesRepo,
  OAuthRevocationsRepo,
} from '../../../src/store/repos/oauth.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import type { ResolvedIdentity, SessionResolver } from '../src/auth/kratos-session.ts';
import { s256Challenge } from '../src/oauth/pkce.ts';
import { type OAuthConfig, oauthRoutes } from '../src/oauth/router.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SECRET = new TextEncoder().encode('router-secret-0123456789');
const T0 = 1_800_000_000_000;
const REDIRECT = 'https://client.example/cb';
const IDENTITY: ResolvedIdentity = {
  userId: 'kratos-1',
  email: 'u@example.com',
  verified: true,
  displayName: null,
};

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const clients = new OAuthClientsRepo(db);
  const codes = new OAuthCodesRepo(db);
  const revocations = new OAuthRevocationsRepo(db);
  const users = new UsersRepo(db);
  // Any cookie → logged in as IDENTITY; no cookie → anonymous.
  const sessionResolver: SessionResolver = async (cookie) => (cookie ? IDENTITY : null);
  const config: OAuthConfig = {
    issuer: 'https://host',
    resource: 'https://host/mcp',
    signingSecret: SECRET,
    accessTokenTtlSec: 3600,
    codeTtlSec: 60,
    loginPath: '/auth/login',
    scopesSupported: ['mcp:read', 'mcp:admin'],
  };
  const app = oauthRoutes({
    clients,
    codes,
    revocations,
    users,
    sessionResolver,
    config,
    now: () => T0,
  });
  return { db, clients, codes, revocations, users, app };
}

const form = (body: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

async function authorizeQuery(
  s: ReturnType<typeof setup>,
  over: Record<string, string> = {},
  challenge?: string,
) {
  const chal = challenge ?? (await s256Challenge(VERIFIER));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: over.client_id ?? '',
    redirect_uri: REDIRECT,
    code_challenge: chal,
    code_challenge_method: 'S256',
    scope: 'mcp:read',
    state: 'xyz',
    ...over,
  });
  return q.toString();
}

describe('OAuth AS endpoints (spec 063)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  describe('metadata', () => {
    it('serves authorization-server metadata', async () => {
      const m = await (await s.app.request('/.well-known/oauth-authorization-server')).json();
      expect(m.issuer).toBe('https://host');
      expect(m.authorization_endpoint).toBe('https://host/oauth/authorize');
      expect(m.token_endpoint).toBe('https://host/oauth/token');
      expect(m.code_challenge_methods_supported).toEqual(['S256']);
      expect(m.scopes_supported).toEqual(['mcp:read', 'mcp:admin']);
    });
    it('serves protected-resource metadata', async () => {
      const m = await (await s.app.request('/.well-known/oauth-protected-resource')).json();
      expect(m.resource).toBe('https://host/mcp');
      expect(m.authorization_servers).toEqual(['https://host']);
    });
  });

  describe('dynamic client registration', () => {
    it('registers a public client (no secret)', async () => {
      const res = await s.app.request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'agent' }),
      });
      expect(res.status).toBe(201);
      const b = await res.json();
      expect(b.client_id).toBeString();
      expect(b.client_secret).toBeUndefined();
      expect(b.token_endpoint_auth_method).toBe('none');
    });
    it('registers a confidential client (secret returned once)', async () => {
      const res = await s.app.request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
          grant_types: ['authorization_code'],
          scope: 'mcp:read',
        }),
      });
      const b = await res.json();
      expect(b.client_secret).toBeString();
    });
    it('rejects missing redirect_uris and non-JSON', async () => {
      expect(
        (
          await s.app.request('/oauth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await s.app.request('/oauth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: 'not json',
          })
        ).status,
      ).toBe(400);
    });
  });

  describe('authorize', () => {
    async function publicClient(firstParty = false) {
      return s.clients.register({ redirectUris: [REDIRECT], firstParty }).client;
    }

    it('400s an unknown client or unregistered redirect_uri (never redirects)', async () => {
      expect(
        (await s.app.request(`/oauth/authorize?${await authorizeQuery(s, { client_id: 'nope' })}`))
          .status,
      ).toBe(400);
      const c = await publicClient();
      const res = await s.app.request(
        `/oauth/authorize?${await authorizeQuery(s, { client_id: c.id, redirect_uri: 'https://evil/cb' })}`,
      );
      expect(res.status).toBe(400);
    });

    it('redirects with an error for bad response_type / challenge / resource / scope', async () => {
      const c = await publicClient();
      const cases = [
        { response_type: 'token', err: 'unsupported_response_type' },
        { code_challenge_method: 'plain', err: 'invalid_request' },
        { resource: 'https://host/other', err: 'invalid_target' },
        { scope: 'mcp:write', err: 'invalid_scope' },
      ];
      for (const { err, ...over } of cases) {
        const res = await s.app.request(
          `/oauth/authorize?${await authorizeQuery(s, { client_id: c.id, ...over })}`,
        );
        expect(res.status).toBe(302);
        expect(new URL(res.headers.get('location') as string).searchParams.get('error')).toBe(err);
      }
    });

    it('redirects to login when there is no session', async () => {
      const c = await publicClient();
      const res = await s.app.request(
        `/oauth/authorize?${await authorizeQuery(s, { client_id: c.id })}`,
      );
      expect(res.status).toBe(302);
      const loc = res.headers.get('location') as string;
      expect(loc.startsWith('/auth/login?return_to=')).toBe(true);
    });

    it('auto-consents a first-party client and issues a code', async () => {
      const c = await publicClient(true);
      const res = await s.app.request(
        `/oauth/authorize?${await authorizeQuery(s, { client_id: c.id })}`,
        { headers: { cookie: 'ok' } },
      );
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location') as string);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get('state')).toBe('xyz');
      expect(loc.searchParams.get('code')).toBeString();
    });

    it('shows a consent page for a non-first-party client with a session', async () => {
      const c = await publicClient(false);
      const res = await s.app.request(
        `/oauth/authorize?${await authorizeQuery(s, { client_id: c.id })}`,
        { headers: { cookie: 'ok' } },
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Approve');
    });

    it('consent POST: approve issues a code, deny returns access_denied, anon 401, bad params surface', async () => {
      const c = await publicClient(false);
      const chal = await s256Challenge(VERIFIER);
      const fields = {
        response_type: 'code',
        client_id: c.id,
        redirect_uri: REDIRECT,
        code_challenge: chal,
        code_challenge_method: 'S256',
        scope: 'mcp:read',
        state: 'xyz',
        resource: '',
      };
      // approve
      const ap = await s.app.request('/oauth/authorize', {
        ...form({ ...fields, decision: 'approve' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'ok' },
      });
      expect(new URL(ap.headers.get('location') as string).searchParams.get('code')).toBeString();
      // deny
      const dn = await s.app.request('/oauth/authorize', {
        ...form({ ...fields, decision: 'deny' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'ok' },
      });
      expect(new URL(dn.headers.get('location') as string).searchParams.get('error')).toBe(
        'access_denied',
      );
      // anon
      expect(
        (await s.app.request('/oauth/authorize', form({ ...fields, decision: 'approve' }))).status,
      ).toBe(401);
      // bad client → 400 error page
      expect(
        (
          await s.app.request('/oauth/authorize', {
            ...form({ ...fields, client_id: 'nope', decision: 'approve' }),
            headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'ok' },
          })
        ).status,
      ).toBe(400);
      // error_redirect branch on POST (bad response_type)
      const bad = await s.app.request('/oauth/authorize', {
        ...form({ ...fields, response_type: 'token', decision: 'approve' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'ok' },
      });
      expect(new URL(bad.headers.get('location') as string).searchParams.get('error')).toBe(
        'unsupported_response_type',
      );
    });
  });

  describe('token', () => {
    async function getCode(firstParty = true, client_id?: string) {
      const c = client_id
        ? { id: client_id }
        : s.clients.register({ redirectUris: [REDIRECT], firstParty }).client;
      const res = await s.app.request(
        `/oauth/authorize?${await authorizeQuery(s, { client_id: c.id })}`,
        { headers: { cookie: 'ok' } },
      );
      const code = new URL(res.headers.get('location') as string).searchParams.get(
        'code',
      ) as string;
      return { clientId: c.id, code };
    }

    it('exchanges a code (with PKCE) for an access token', async () => {
      const { clientId, code } = await getCode();
      const res = await s.app.request(
        '/oauth/token',
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: VERIFIER,
        }),
      );
      expect(res.status).toBe(200);
      const b = await res.json();
      expect(b.token_type).toBe('Bearer');
      expect(b.access_token).toBeString();
      expect(b.expires_in).toBe(3600);
      expect(b.scope).toBe('mcp:read');
    });

    it('rejects a bad grant_type, unknown client, bad PKCE, code reuse, and mismatches', async () => {
      const { clientId, code } = await getCode();
      // bad grant_type
      expect(
        (await s.app.request('/oauth/token', form({ grant_type: 'password', client_id: clientId })))
          .status,
      ).toBe(400);
      // unknown client
      expect(
        (
          await s.app.request(
            '/oauth/token',
            form({
              grant_type: 'authorization_code',
              code,
              redirect_uri: REDIRECT,
              client_id: 'nope',
              code_verifier: VERIFIER,
            }),
          )
        ).status,
      ).toBe(401);
      // wrong PKCE verifier
      const badPkce = await s.app.request(
        '/oauth/token',
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: 'wrong',
        }),
      );
      expect(badPkce.status).toBe(400);
      // code already consumed by the failed-PKCE attempt above → reuse is invalid_grant
      expect(
        (
          await s.app.request(
            '/oauth/token',
            form({
              grant_type: 'authorization_code',
              code,
              redirect_uri: REDIRECT,
              client_id: clientId,
              code_verifier: VERIFIER,
            }),
          )
        ).status,
      ).toBe(400);
      // redirect_uri mismatch
      const fresh = await getCode();
      expect(
        (
          await s.app.request(
            '/oauth/token',
            form({
              grant_type: 'authorization_code',
              code: fresh.code,
              redirect_uri: 'https://client.example/other',
              client_id: fresh.clientId,
              code_verifier: VERIFIER,
            }),
          )
        ).status,
      ).toBe(400);
    });

    it('requires the confidential client secret', async () => {
      const { client, clientSecret } = s.clients.register({
        redirectUris: [REDIRECT],
        tokenEndpointAuthMethod: 'client_secret_post',
        firstParty: true,
      });
      const { code } = await getCode(true, client.id);
      // wrong secret
      expect(
        (
          await s.app.request(
            '/oauth/token',
            form({
              grant_type: 'authorization_code',
              code,
              redirect_uri: REDIRECT,
              client_id: client.id,
              client_secret: 'wrong',
              code_verifier: VERIFIER,
            }),
          )
        ).status,
      ).toBe(401);
      // correct secret
      const ok = await s.app.request(
        '/oauth/token',
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: client.id,
          client_secret: clientSecret as string,
          code_verifier: VERIFIER,
        }),
      );
      expect(ok.status).toBe(200);
    });
  });

  describe('revoke', () => {
    it('denylists the token jti and 200s even for an invalid token', async () => {
      const { clientId, code } = await (async () => {
        const c = s.clients.register({ redirectUris: [REDIRECT], firstParty: true }).client;
        const res = await s.app.request(
          `/oauth/authorize?${await authorizeQuery(s, { client_id: c.id })}`,
          { headers: { cookie: 'ok' } },
        );
        return {
          clientId: c.id,
          code: new URL(res.headers.get('location') as string).searchParams.get('code') as string,
        };
      })();
      const tok = await (
        await s.app.request(
          '/oauth/token',
          form({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT,
            client_id: clientId,
            code_verifier: VERIFIER,
          }),
        )
      ).json();
      const res = await s.app.request('/oauth/revoke', form({ token: tok.access_token }));
      expect(res.status).toBe(200);
      // invalid token → still 200
      expect((await s.app.request('/oauth/revoke', form({ token: 'garbage' }))).status).toBe(200);
    });
  });
});
