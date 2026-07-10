// OAuth 2.1 Authorization-Server endpoints for MCP (spec 063 P3), hand-rolled in Hono (the SDK's auth
// router is Express-only). danni is its own AS + RS: metadata + DCR + authorize (Kratos-session auth →
// consent → code) + token (code+PKCE→JWT) + revoke. Access tokens are stateless JWTs (tokens.ts); the
// human is authenticated via the EXISTING Kratos session (sessionResolver) — no credential store here.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import type {
  OAuthClient,
  OAuthClientsRepo,
  OAuthCodesRepo,
  OAuthRevocationsRepo,
} from '../../../../src/store/repos/oauth.ts';
import type { UsersRepo } from '../../../../src/store/repos/users.ts';
import type { SessionResolver } from '../auth/kratos-session.ts';
import { verifyPkceS256 } from './pkce.ts';
import { signAccessToken } from './tokens.ts';

export interface OAuthConfig {
  issuer: string; // AS base URL / origin, e.g. https://host (no trailing slash required)
  resource: string; // the MCP resource URI (RFC 8707 audience), e.g. https://host/mcp
  signingSecret: Uint8Array;
  accessTokenTtlSec: number;
  codeTtlSec: number;
  loginPath: string; // SPA login route, e.g. /auth/login
  scopesSupported: string[]; // e.g. ['mcp:read','mcp:admin']
}

export interface OAuthRouterDeps {
  clients: OAuthClientsRepo;
  codes: OAuthCodesRepo;
  revocations: OAuthRevocationsRepo;
  users: UsersRepo;
  sessionResolver: SessionResolver;
  config: OAuthConfig;
  now?: () => number;
}

const base = (issuer: string) => issuer.replace(/\/$/, '');

export function authServerMetadata(cfg: OAuthConfig) {
  const b = base(cfg.issuer);
  return {
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    revocation_endpoint: `${b}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: cfg.scopesSupported,
  };
}

export function protectedResourceMetadata(cfg: OAuthConfig) {
  return {
    resource: cfg.resource,
    authorization_servers: [base(cfg.issuer)],
    scopes_supported: cfg.scopesSupported,
    bearer_methods_supported: ['header'],
  };
}

const dcrSchema = z
  .object({
    redirect_uris: z.array(z.string().url()).min(1),
    token_endpoint_auth_method: z.enum(['none', 'client_secret_post']).optional(),
    grant_types: z.array(z.string()).optional(),
    scope: z.string().optional(),
    client_name: z.string().optional(),
  })
  .passthrough();

interface AuthorizeParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string;
  resource: string;
  decision?: string;
}

function readAuthorizeParams(src: Record<string, string | undefined>): AuthorizeParams {
  return {
    responseType: src.response_type ?? '',
    clientId: src.client_id ?? '',
    redirectUri: src.redirect_uri ?? '',
    codeChallenge: src.code_challenge ?? '',
    codeChallengeMethod: src.code_challenge_method ?? '',
    scope: src.scope ?? '',
    state: src.state ?? '',
    resource: src.resource ?? '',
    ...(src.decision !== undefined ? { decision: src.decision } : {}),
  };
}

type AuthorizeResolution =
  | { kind: 'error_page'; message: string } // bad client / redirect_uri — MUST NOT redirect (OAuth 2.1)
  | { kind: 'error_redirect'; redirectUri: string; error: string; state: string }
  | {
      kind: 'ok';
      client: OAuthClient;
      redirectUri: string;
      codeChallenge: string;
      scope: string;
      state: string;
    };

/** Validate the authorize request up to (not including) authentication. Shared by GET + the consent POST. */
export function resolveAuthorize(deps: OAuthRouterDeps, p: AuthorizeParams): AuthorizeResolution {
  const client = deps.clients.get(p.clientId);
  if (!client) return { kind: 'error_page', message: 'unknown client_id' };
  if (!client.redirectUris.includes(p.redirectUri)) {
    return { kind: 'error_page', message: 'redirect_uri is not registered for this client' };
  }
  const err = (error: string): AuthorizeResolution => ({
    kind: 'error_redirect',
    redirectUri: p.redirectUri,
    error,
    state: p.state,
  });
  if (p.responseType !== 'code') return err('unsupported_response_type');
  if (p.codeChallengeMethod !== 'S256' || !p.codeChallenge) return err('invalid_request');
  if (p.resource && p.resource !== deps.config.resource) return err('invalid_target');
  const requested = p.scope ? p.scope.split(' ').filter(Boolean) : ['mcp:read'];
  if (!requested.every((s) => deps.config.scopesSupported.includes(s))) return err('invalid_scope');
  return {
    kind: 'ok',
    client,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    scope: requested.join(' '),
    state: p.state,
  };
}

function redirectWith(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

function consentPage(clientName: string, scope: string, params: AuthorizeParams): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<!doctype html><meta charset="utf-8"><title>Authorize</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
<h2>Authorize ${escapeHtml(clientName)}</h2>
<p>grants scope <code>${escapeHtml(scope)}</code> to act on your behalf.</p>
<form method="post" action="/oauth/authorize">
${hidden('response_type', params.responseType)}${hidden('client_id', params.clientId)}${hidden('redirect_uri', params.redirectUri)}
${hidden('code_challenge', params.codeChallenge)}${hidden('code_challenge_method', params.codeChallengeMethod)}
${hidden('scope', params.scope)}${hidden('state', params.state)}${hidden('resource', params.resource)}
<button name="decision" value="approve">Approve</button>
<button name="decision" value="deny">Deny</button>
</form></body>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function oauthRoutes(deps: OAuthRouterDeps): Hono {
  const app = new Hono();
  const now = () => deps.now?.() ?? Date.now();

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json(authServerMetadata(deps.config)),
  );
  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json(protectedResourceMetadata(deps.config)),
  );

  // Dynamic Client Registration (RFC 7591).
  app.post('/oauth/register', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: 'invalid_client_metadata', error_description: 'body must be JSON' },
        400,
      );
    }
    const parsed = dcrSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_client_metadata', error_description: 'redirect_uris required' },
        400,
      );
    }
    const { client, clientSecret } = deps.clients.register({
      redirectUris: parsed.data.redirect_uris,
      tokenEndpointAuthMethod: parsed.data.token_endpoint_auth_method ?? 'none',
      ...(parsed.data.grant_types ? { grantTypes: parsed.data.grant_types } : {}),
      scope: parsed.data.scope ?? null,
      clientName: parsed.data.client_name ?? null,
    });
    return c.json(
      {
        client_id: client.id,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        ...(client.scope ? { scope: client.scope } : {}),
        ...(client.clientName ? { client_name: client.clientName } : {}),
      },
      201,
    );
  });

  // Issue an auth code for an authenticated + consented request and redirect back to the client.
  async function issueCode(
    c: Context,
    r: Extract<AuthorizeResolution, { kind: 'ok' }>,
    userId: string,
  ): Promise<Response> {
    const code = deps.codes.issue({
      clientId: r.client.id,
      userId,
      redirectUri: r.redirectUri,
      codeChallenge: r.codeChallenge,
      scope: r.scope,
      resource: deps.config.resource,
      ttlSec: deps.config.codeTtlSec,
      now: now(),
    });
    return c.redirect(redirectWith(r.redirectUri, { code, state: r.state }), 302);
  }

  // GET /oauth/authorize — validate → authenticate (Kratos session) → consent → code.
  app.get('/oauth/authorize', async (c) => {
    const p = readAuthorizeParams(Object.fromEntries(new URL(c.req.url).searchParams));
    const r = resolveAuthorize(deps, p);
    if (r.kind === 'error_page') return c.text(r.message, 400);
    if (r.kind === 'error_redirect')
      return c.redirect(redirectWith(r.redirectUri, { error: r.error, state: r.state }), 302);

    const identity = await deps.sessionResolver(c.req.header('cookie'));
    if (!identity) {
      const returnTo = new URL(c.req.url).pathname + new URL(c.req.url).search;
      return c.redirect(`${deps.config.loginPath}?return_to=${encodeURIComponent(returnTo)}`, 302);
    }
    const user = deps.users.findOrCreateByKratosId({
      kratosIdentityId: identity.userId,
      email: identity.email,
      emailVerified: identity.verified,
    });
    if (r.client.firstParty) return issueCode(c, r, user.id); // pre-registered → auto-consent
    return c.html(
      consentPage(r.client.clientName ?? r.client.id, r.scope, { ...p, scope: r.scope }),
    );
  });

  // POST /oauth/authorize — the consent decision for a non-first-party client.
  app.post('/oauth/authorize', async (c) => {
    const body = await c.req.parseBody();
    const flat: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(body)) flat[k] = typeof v === 'string' ? v : undefined;
    const p = readAuthorizeParams(flat);
    const r = resolveAuthorize(deps, p);
    if (r.kind === 'error_page') return c.text(r.message, 400);
    if (r.kind === 'error_redirect')
      return c.redirect(redirectWith(r.redirectUri, { error: r.error, state: r.state }), 302);

    const identity = await deps.sessionResolver(c.req.header('cookie'));
    if (!identity) return c.text('not authenticated', 401);
    if (p.decision !== 'approve')
      return c.redirect(
        redirectWith(r.redirectUri, { error: 'access_denied', state: r.state }),
        302,
      );
    const user = deps.users.findOrCreateByKratosId({
      kratosIdentityId: identity.userId,
      email: identity.email,
      emailVerified: identity.verified,
    });
    return issueCode(c, r, user.id);
  });

  // POST /oauth/token — authorization_code grant with PKCE.
  app.post('/oauth/token', async (c) => {
    const body = await c.req.parseBody();
    const get = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string) : '');
    if (get('grant_type') !== 'authorization_code')
      return c.json({ error: 'unsupported_grant_type' }, 400);
    const clientId = get('client_id');
    const client = deps.clients.get(clientId);
    if (!client) return c.json({ error: 'invalid_client' }, 401);
    if (
      client.tokenEndpointAuthMethod === 'client_secret_post' &&
      !deps.clients.verifySecret(clientId, get('client_secret'))
    ) {
      return c.json({ error: 'invalid_client' }, 401);
    }
    const code = deps.codes.consume(get('code'), now());
    if (!code || code.clientId !== clientId || code.redirectUri !== get('redirect_uri')) {
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (!(await verifyPkceS256(get('code_verifier'), code.codeChallenge))) {
      return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
    }
    const { token, expiresInSec } = await signAccessToken(
      { userId: code.userId, scope: code.scope ?? '', audience: deps.config.resource, clientId },
      deps.config.signingSecret,
      {
        issuer: base(deps.config.issuer),
        ttlSec: deps.config.accessTokenTtlSec,
        jti: crypto.randomUUID(),
        now: now(),
      },
    );
    return c.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresInSec,
      scope: code.scope ?? '',
    });
  });

  // POST /oauth/revoke (RFC 7009) — denylist the token's jti; always 200, even for an invalid token.
  app.post('/oauth/revoke', async (c) => {
    const body = await c.req.parseBody();
    const token = typeof body.token === 'string' ? body.token : '';
    try {
      const claims = decodeJwt(token);
      if (claims.jti && typeof claims.exp === 'number') {
        deps.revocations.revoke(claims.jti, new Date(claims.exp * 1000).toISOString());
      }
    } catch {
      // invalid token → nothing to revoke (RFC 7009 still returns 200)
    }
    return c.body(null, 200);
  });

  return app;
}
