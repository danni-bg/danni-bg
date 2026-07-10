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
  resource: string; // the READ MCP resource URI (RFC 8707 audience), e.g. https://host/mcp
  adminResource: string; // the ADMIN MCP resource URI, e.g. https://host/admin/mcp (spec 062)
  signingSecret: Uint8Array;
  accessTokenTtlSec: number;
  codeTtlSec: number;
  loginPath: string; // SPA login route, e.g. /auth/login
  scopesSupported: string[]; // e.g. ['mcp:read','mcp:admin']
}

/** The RFC-8707 resources this AS can bind a token to — the read + admin MCP endpoints (spec 062). */
export function knownResources(cfg: OAuthConfig): string[] {
  return [cfg.resource, cfg.adminResource];
}

/** The RFC-9728 protected-resource-metadata URL for a door — used in the `WWW-Authenticate` challenge. */
export function resourceMetadataUrl(cfg: OAuthConfig, kind: 'read' | 'admin'): string {
  const b = cfg.issuer.replace(/\/$/, '');
  return kind === 'admin'
    ? `${b}/.well-known/oauth-protected-resource/admin/mcp`
    : `${b}/.well-known/oauth-protected-resource/mcp`;
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

/**
 * RFC 9728 protected-resource metadata. Each MCP door is a distinct protected resource with its OWN
 * required scope, so a client that discovers it requests the right scope (spec 062): the read `/mcp`
 * door advertises `mcp:read`, the admin `/admin/mcp` door advertises `mcp:admin`. This is what makes an
 * MCP client escalate to `mcp:admin` for the admin server instead of reusing its read grant.
 */
export function protectedResourceMetadata(cfg: OAuthConfig, kind: 'read' | 'admin' = 'read') {
  const admin = kind === 'admin';
  return {
    resource: admin ? cfg.adminResource : cfg.resource,
    authorization_servers: [base(cfg.issuer)],
    scopes_supported: [admin ? 'mcp:admin' : 'mcp:read'],
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
      resource: string; // the effective RFC-8707 audience the token will be bound to
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
  // RFC 8707: the requested resource must be one this AS serves (read or admin MCP). Absent → the
  // read resource (back-compat default). The token is bound to this exact audience.
  if (p.resource && !knownResources(deps.config).includes(p.resource)) return err('invalid_target');
  const resource = p.resource || deps.config.resource;
  const requested = p.scope ? p.scope.split(' ').filter(Boolean) : ['mcp:read'];
  if (!requested.every((s) => deps.config.scopesSupported.includes(s))) return err('invalid_scope');
  return {
    kind: 'ok',
    client,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    scope: requested.join(' '),
    state: p.state,
    resource,
  };
}

function redirectWith(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

/** Human-readable copy for each grantable scope, shown on the consent screen. */
const SCOPE_COPY: Record<string, { title: string; detail: string }> = {
  'mcp:read': {
    title: 'Достъп за четене',
    detail: 'Търсене и четене на публичното огледало на данни — набори от данни, ресурси и обекти.',
  },
  'mcp:admin': {
    title: 'Администриране',
    detail:
      'Управление на API ключове, организации, членове и настройки и четене на одитния дневник — ограничено до това, което ролята ви вече позволява.',
  },
};

export function scopeRows(scope: string): string {
  const scopes = scope.split(/\s+/).filter(Boolean);
  return scopes
    .map((s) => {
      const copy = SCOPE_COPY[s];
      const title = copy ? escapeHtml(copy.title) : `<code>${escapeHtml(s)}</code>`;
      const detail = copy ? `<span class="scope-detail">${escapeHtml(copy.detail)}</span>` : '';
      return `<li class="scope"><span class="scope-check" aria-hidden="true">✓</span><span class="scope-text"><span class="scope-title">${title} <code>${escapeHtml(s)}</code></span>${detail}</span></li>`;
    })
    .join('');
}

function consentPage(clientName: string, scope: string, params: AuthorizeParams): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const name = escapeHtml(clientName);
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Оторизиране на ${name} · danni</title>
<style>
:root{color-scheme:light dark;--bg:#f8fafc;--card:#ffffff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#1d4ed8;--accent-fg:#f8fafc;--chip:#f1f5f9;--danger:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#020617;--card:#0f172a;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--accent:#3b82f6;--accent-fg:#f8fafc;--chip:#1e293b;--danger:#f87171}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;
background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.card{width:100%;max-width:26rem;background:var(--card);border:1px solid var(--line);border-radius:16px;
padding:1.75rem;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px -12px rgba(0,0,0,.18)}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:600;letter-spacing:.02em;margin-bottom:1.25rem}
.brand .dot{width:.65rem;height:.65rem;border-radius:50%;background:var(--accent)}
.brand .sub{color:var(--muted);font-weight:400}
h1{font-size:1.3rem;line-height:1.3;margin:0 0 .35rem}
h1 b{color:var(--accent)}
.lede{color:var(--muted);margin:0 0 1.25rem}
.scopes{list-style:none;margin:0 0 1.25rem;padding:.5rem .25rem;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.scope{display:flex;gap:.7rem;padding:.6rem .25rem;align-items:flex-start}
.scope-check{flex:0 0 auto;width:1.35rem;height:1.35rem;border-radius:50%;background:var(--accent);color:var(--accent-fg);
display:grid;place-items:center;font-size:.8rem;margin-top:.1rem}
.scope-text{display:flex;flex-direction:column;gap:.15rem}
.scope-title{font-weight:600}
.scope-detail{color:var(--muted);font-size:.9rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82em;background:var(--chip);
padding:.1rem .35rem;border-radius:6px;color:var(--muted);font-weight:500}
.actions{display:flex;gap:.6rem;margin-top:.25rem}
button{flex:1;font:inherit;font-weight:600;padding:.7rem 1rem;border-radius:10px;cursor:pointer;border:1px solid transparent;transition:filter .12s,background .12s}
button:hover{filter:brightness(1.05)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.approve{background:var(--accent);color:var(--accent-fg)}
.deny{background:transparent;color:var(--muted);border-color:var(--line)}
.deny:hover{color:var(--danger);border-color:var(--danger);filter:none}
.note{margin:1.25rem 0 0;font-size:.82rem;color:var(--muted);line-height:1.5}
</style></head>
<body>
<main class="card">
<div class="brand"><span class="dot"></span>danni<span class="sub">· оторизация</span></div>
<h1>Оторизиране на <b>${name}</b></h1>
<p class="lede">${name} иска достъп до danni от ваше име. Ще получи:</p>
<ul class="scopes">${scopeRows(scope)}</ul>
<form method="post" action="/oauth/authorize">
${hidden('response_type', params.responseType)}${hidden('client_id', params.clientId)}${hidden('redirect_uri', params.redirectUri)}
${hidden('code_challenge', params.codeChallenge)}${hidden('code_challenge_method', params.codeChallengeMethod)}
${hidden('scope', params.scope)}${hidden('state', params.state)}${hidden('resource', params.resource)}
<div class="actions">
<button type="submit" class="approve" name="decision" value="approve">Разреши</button>
<button type="submit" class="deny" name="decision" value="deny">Откажи</button>
</div>
</form>
<p class="note">Разрешете само ако току-що сте инициирали това от ${name}. Достъпът е ограничен до посочения обхват и можете да го отмените по всяко време.</p>
</main>
</body></html>`;
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
  // Read MCP (`/mcp`) protected-resource metadata: the bare well-known path + the RFC 9728 path-based
  // variant (`/.well-known/oauth-protected-resource/mcp`) that a client derives from the resource URL.
  const readPrm = (c: Context) => c.json(protectedResourceMetadata(deps.config, 'read'));
  app.get('/.well-known/oauth-protected-resource', readPrm);
  app.get('/.well-known/oauth-protected-resource/mcp', readPrm);
  // Admin MCP (`/admin/mcp`) protected-resource metadata (spec 062) — advertises `mcp:admin`, so a
  // client connecting to the admin door requests that scope instead of reusing a read grant.
  app.get('/.well-known/oauth-protected-resource/admin/mcp', (c) =>
    c.json(protectedResourceMetadata(deps.config, 'admin')),
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
      resource: r.resource, // the requested audience (read or admin MCP), bound into the token below
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
      {
        userId: code.userId,
        scope: code.scope ?? '',
        // Bind the token to the resource the code was issued for (read or admin MCP), falling back to
        // the read resource for codes issued before the field existed.
        audience: code.resource ?? deps.config.resource,
        clientId,
      },
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
