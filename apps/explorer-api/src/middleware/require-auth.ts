// Auth guards (spec 019). `requireAuth` enforces a valid session (401 otherwise), find-or-creates the
// app user row for the Kratos identity, and stashes it on the request context. `requireAdmin` (run
// after requireAuth) enforces the admin tier (403 otherwise). RBAC is application-layer off
// `users.role`; Oathkeeper/Kratos do not hold the role.

import type { MiddlewareHandler } from 'hono';
import {
  API_KEY_NAMESPACE,
  type ApiKeyRepo,
  type ApiKeyScope,
  parseScopes,
} from '../../../../src/store/repos/api-keys.ts';
import {
  DEFAULT_TENANT_ID,
  type TenantRole,
  type TenantsRepo,
} from '../../../../src/store/repos/tenants.ts';
import type { UserRow, UsersRepo } from '../../../../src/store/repos/users.ts';
import type { SessionResolver } from '../auth/kratos-session.ts';
import { readAuth } from './auth.ts';

/** The active tenant for a gated request (spec 029): which org the caller is acting within + their role. */
export interface ActiveTenant {
  id: string;
  role: TenantRole;
}

/**
 * Hono environment for routes behind the auth guards: the resolved app user is on the context.
 * `apiKey` is set ONLY when the caller authenticated with an API key (machine client, spec 027) —
 * absent for human Kratos sessions; it drives scope checks and the admin/human-only guards.
 * `tenant` is the active org (spec 029): always set by requireAuth (the default tenant when no
 * TenantsRepo is wired), so downstream handlers can scope reads/writes by tenant.
 */
export type AuthEnv = {
  Variables: {
    user: UserRow;
    apiKey?: { id: string; scopes: ApiKeyScope[] };
    tenant: ActiveTenant;
  };
};

// Optional convenience: emails auto-promoted to admin on FIRST login (existing rows keep their role).
// Spec 034 FR-163: promotion additionally requires a VERIFIED email. An unverified match creates a
// plain `user` row, and promotion is evaluated on first creation only — so verify before first login
// (a later verified login does NOT upgrade the row; use `danni admin grant <email>` instead).
// Read per call so it's configurable + testable.
function isBootstrapAdmin(email: string): boolean {
  const list = (process.env.ADMIN_BOOTSTRAP_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

/**
 * Resolve the request identity from Oathkeeper's injected X-User-* headers (ONLY behind the
 * TRUST_PROXY_AUTH_HEADERS opt-in — spec 034) OR, when those yield nothing and a `resolveSession`
 * is configured, by validating the Kratos session cookie directly (single-port mode — the default,
 * no Oathkeeper needed). 401 if neither yields one.
 */
export function requireAuth(
  users: UsersRepo,
  resolveSession?: SessionResolver,
  apiKeys?: ApiKeyRepo,
  tenants?: TenantsRepo,
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    // API key (machine client, spec 027): `Authorization: Bearer dnk_live_…`. Resolves to the owning
    // user — same `user` context as a session — plus an `apiKey` marker carrying its scopes.
    const authz = c.req.header('authorization');
    if (apiKeys && authz?.startsWith('Bearer ')) {
      const secret = authz.slice('Bearer '.length).trim();
      if (secret.startsWith(API_KEY_NAMESPACE)) {
        const res = apiKeys.resolveBySecret(secret);
        const owner = res.status === 'ok' ? users.get(res.key.user_id) : null;
        if (res.status === 'ok' && owner) {
          c.set('user', owner);
          c.set('apiKey', { id: res.key.id, scopes: parseScopes(res.key) });
          // A key belongs to an org (spec 029): the request acts within the key's tenant.
          c.set('tenant', { id: res.key.tenant_id ?? DEFAULT_TENANT_ID, role: 'member' });
          await next();
          return undefined;
        }
        const code =
          res.status === 'revoked'
            ? 'api_key_revoked'
            : res.status === 'expired'
              ? 'api_key_expired'
              : 'unauthorized';
        return c.json({ error: { code, message: 'invalid API key' } }, 401);
      }
    }

    const header = readAuth(c);
    let identity: {
      userId: string;
      email: string;
      verified: boolean;
      displayName: string | null;
    } | null =
      header.isAuthenticated && header.userId && header.email
        ? {
            userId: header.userId,
            email: header.email,
            verified: header.verified,
            displayName: header.displayName,
          }
        : null;
    if (!identity && resolveSession) identity = await resolveSession(c.req.header('cookie'));
    if (!identity) {
      return c.json({ error: { code: 'unauthorized', message: 'authentication required' } }, 401);
    }
    const createRole = identity.verified && isBootstrapAdmin(identity.email) ? 'admin' : 'user';
    const user = users.findOrCreateByKratosId({
      kratosIdentityId: identity.userId,
      email: identity.email,
      emailVerified: identity.verified,
      displayName: identity.displayName,
      createRole,
    });
    c.set('user', user);
    // Resolve the active org (spec 029 + 041 FR-230): a freshly self-registered user is auto-joined to
    // the default tenant. The active org is the user's PERSISTED selection (`active_tenant_id`) when it
    // is still a membership, else their primary (oldest) membership — so a user who never switched
    // stays on default with no behavior change (FR-235). Without a TenantsRepo (focused tests), fall
    // back to the default tenant so downstream tenant-scoping still has a value.
    const membership = tenants?.activeMembership(user.id, user.active_tenant_id);
    c.set('tenant', {
      id: membership?.tenantId ?? DEFAULT_TENANT_ID,
      role: membership?.role ?? 'member',
    });
    await next();
    return undefined;
  };
}

/** The one canonical dependency set the auth gate needs (spec 055 FR-375). */
export interface AuthGateDeps {
  users: UsersRepo;
  sessionResolver?: SessionResolver | undefined;
  apiKeys?: ApiKeyRepo | undefined;
  tenants?: TenantsRepo | undefined;
}

/**
 * Compose the `requireAuth` middleware from one canonical dep set (spec 055 FR-375). Built ONCE in
 * `app.ts` and handed to every gated router so each receives the identical argument set — closing the
 * `routes/auth.ts` divergence where an API key on `/api/auth/*` got a generic session 401 instead of
 * the same key-aware handling (and 403-vs-401 semantics) every other gated route gives it.
 */
export function authGate(deps: AuthGateDeps): MiddlewareHandler<AuthEnv> {
  return requireAuth(deps.users, deps.sessionResolver, deps.apiKeys, deps.tenants);
}

/** Must run after requireAuth (reads the resolved user). API keys can NEVER reach admin (spec 027). */
export const requireAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.get('apiKey')) {
    return c.json({ error: { code: 'forbidden', message: 'API keys cannot access admin' } }, 403);
  }
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: { code: 'forbidden', message: 'admin access required' } }, 403);
  }
  await next();
  return undefined;
};

/** Run after requireAuth: an API-key caller must hold `scope`; human sessions pass any scope. */
export function requireScope(scope: ApiKeyScope): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const key = c.get('apiKey');
    if (key && !key.scopes.includes(scope)) {
      return c.json(
        { error: { code: 'insufficient_scope', message: `API key lacks '${scope}' scope` } },
        403,
      );
    }
    await next();
    return undefined;
  };
}

/**
 * Run after requireAuth: the explicit "any-key" access class (spec 038) — a valid session OR any
 * valid key may pass, no scope required. A documented pass-through so self-introspection routes
 * (usage/quota) declare their class rather than sit behind bare requireAuth by accident (FR-200).
 */
export const allowAnyKey: MiddlewareHandler<AuthEnv> = async (_c, next) => {
  await next();
  return undefined;
};

/** Run after requireAuth: reject API-key callers (human-only routes, e.g. managing keys themselves). */
export const requireHuman: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.get('apiKey')) {
    return c.json(
      { error: { code: 'forbidden', message: 'this action requires a signed-in session' } },
      403,
    );
  }
  await next();
  return undefined;
};

/**
 * Run after requireAuth (spec 029): the caller must be an owner/admin of their active org. Human-only
 * (an API key can never administer its org). Org admins manage their own members/keys/plan (FR-132).
 */
export const requireTenantAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.get('apiKey')) {
    return c.json(
      { error: { code: 'forbidden', message: 'this action requires a signed-in session' } },
      403,
    );
  }
  const role = c.get('tenant')?.role;
  if (role !== 'owner' && role !== 'admin') {
    return c.json(
      { error: { code: 'forbidden', message: 'organization admin access required' } },
      403,
    );
  }
  await next();
  return undefined;
};
