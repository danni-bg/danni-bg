// Auth guards (spec 019) — hermetic: no live Kratos. requireAuth trusts the X-User-* headers
// Oathkeeper injects only behind the TRUST_PROXY_AUTH_HEADERS opt-in (spec 034), so header-driven
// suites enable it in their setup and drive auth by setting the headers (Constitution VI). The
// trust-boundary suite below asserts the default-off posture.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { runMigrations } from '../../../src/store/migrate.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import type { SessionResolver } from '../src/auth/kratos-session.ts';
import { type AuthEnv, requireAdmin, requireAuth } from '../src/middleware/require-auth.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  const app = new Hono<AuthEnv>();
  app.use('/me', requireAuth(users));
  app.get('/me', (c) => c.json(c.get('user')));
  app.use('/admin', requireAuth(users), requireAdmin);
  app.get('/admin', (c) => c.json({ ok: true }));
  return { db, users, app };
}

const authed = (over: Record<string, string> = {}) => ({
  'x-user-id': 'k1',
  'x-user-email': 'u@example.com',
  'x-user-verified': 'true',
  ...over,
});

describe('requireAuth / requireAdmin', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    process.env.TRUST_PROXY_AUTH_HEADERS = 'true'; // header-driven suite (spec 034 FR-164)
    s = setup();
  });
  afterEach(() => {
    s.db.close();
    delete process.env.TRUST_PROXY_AUTH_HEADERS;
    delete process.env.ADMIN_BOOTSTRAP_EMAILS;
  });

  it('401s when no identity headers are present', async () => {
    const res = await s.app.request('/me');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('401s on the Oathkeeper anonymous subject', async () => {
    const res = await s.app.request('/me', { headers: { 'x-user-id': 'anonymous' } });
    expect(res.status).toBe(401);
  });

  it('passes through, find-or-creates the user (role user), and is idempotent', async () => {
    const r1 = await s.app.request('/me', { headers: authed() });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { role: string }).role).toBe('user');
    await s.app.request('/me', { headers: authed() });
    expect(s.users.listAll()).toHaveLength(1); // same identity → one row
  });

  it('403s a normal user on an admin route; 200 after promotion', async () => {
    const forbidden = await s.app.request('/admin', { headers: authed() });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: { code: string } }).error.code).toBe('forbidden');

    s.users.setRoleByEmail('u@example.com', 'admin');
    const ok = await s.app.request('/admin', { headers: authed() });
    expect(ok.status).toBe(200);
  });

  it('auto-promotes a bootstrap email to admin on first login', async () => {
    process.env.ADMIN_BOOTSTRAP_EMAILS = 'boss@example.com, other@example.com';
    const res = await s.app.request('/admin', {
      headers: authed({ 'x-user-id': 'kboss', 'x-user-email': 'boss@example.com' }),
    });
    expect(res.status).toBe(200);
    expect(s.users.findByEmail('boss@example.com')?.role).toBe('admin');
  });
});

function appWith(resolver?: SessionResolver) {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  const app = new Hono<AuthEnv>();
  app.use('/me', requireAuth(users, resolver));
  app.get('/me', (c) => c.json(c.get('user')));
  return { db, users, app };
}

describe('requireAuth session-resolver fallback (single-port, no Oathkeeper)', () => {
  beforeEach(() => {
    process.env.TRUST_PROXY_AUTH_HEADERS = 'true';
  });
  afterEach(() => {
    delete process.env.TRUST_PROXY_AUTH_HEADERS;
  });

  it('resolves the session from the cookie when no X-User-* headers are present', async () => {
    const resolver: SessionResolver = async (cookie) =>
      cookie === 'ory_kratos_session=ok'
        ? { userId: 'k9', email: 'cookie@example.com', verified: true, displayName: 'Cookie User' }
        : null;
    const { db, users, app } = appWith(resolver);
    const res = await app.request('/me', { headers: { cookie: 'ory_kratos_session=ok' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBe('cookie@example.com');
    const row = users.findByKratosId('k9');
    expect(row?.role).toBe('user');
    expect(row?.display_name).toBe('Cookie User'); // the resolved name is persisted
    db.close();
  });

  it('401s when neither headers nor the resolver yield an identity', async () => {
    const { db, app } = appWith(async () => null);
    expect((await app.request('/me')).status).toBe(401);
    db.close();
  });

  it('prefers Oathkeeper headers over the resolver when trust is on (resolver not called)', async () => {
    let called = false;
    const resolver: SessionResolver = async () => {
      called = true;
      return null;
    };
    const { db, app } = appWith(resolver);
    const res = await app.request('/me', {
      headers: { 'x-user-id': 'kh', 'x-user-email': 'hdr@example.com', 'x-user-verified': 'true' },
    });
    expect(res.status).toBe(200);
    expect(called).toBe(false);
    db.close();
  });
});

describe('identity trust boundary — headers off by default (spec 034 FR-160/161)', () => {
  // These assert the shipped DEFAULT posture, so the opt-in is explicitly unset.
  beforeEach(() => {
    delete process.env.TRUST_PROXY_AUTH_HEADERS;
  });
  afterEach(() => {
    delete process.env.ADMIN_BOOTSTRAP_EMAILS;
  });

  it('SC-1: forged X-User-* headers (even a bootstrap email) get 401 and mint no user row', async () => {
    process.env.ADMIN_BOOTSTRAP_EMAILS = 'boss@example.com';
    const { db, users, app } = appWith();
    const res = await app.request('/me', {
      headers: authed({ 'x-user-id': 'forged', 'x-user-email': 'boss@example.com' }),
    });
    expect(res.status).toBe(401);
    expect(users.listAll()).toHaveLength(0);
    db.close();
  });

  it('FR-161: forged headers alongside a valid cookie resolve to the COOKIE identity', async () => {
    const resolver: SessionResolver = async (cookie) =>
      cookie === 'ory_kratos_session=ok'
        ? { userId: 'k9', email: 'cookie@example.com', verified: true, displayName: null }
        : null;
    const { db, users, app } = appWith(resolver);
    const res = await app.request('/me', {
      headers: {
        ...authed({ 'x-user-id': 'forged', 'x-user-email': 'attacker@example.com' }),
        cookie: 'ory_kratos_session=ok',
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBe('cookie@example.com');
    expect(users.findByKratosId('forged')).toBeNull();
    db.close();
  });

  it('honors the headers again once TRUST_PROXY_AUTH_HEADERS opts in', async () => {
    process.env.TRUST_PROXY_AUTH_HEADERS = 'true';
    const { db, app } = appWith();
    expect((await app.request('/me', { headers: authed() })).status).toBe(200);
    db.close();
  });
});

describe('bootstrap promotion requires a verified email (spec 034 FR-163)', () => {
  beforeEach(() => {
    process.env.TRUST_PROXY_AUTH_HEADERS = 'true';
    process.env.ADMIN_BOOTSTRAP_EMAILS = 'boss@example.com';
  });
  afterEach(() => {
    delete process.env.TRUST_PROXY_AUTH_HEADERS;
    delete process.env.ADMIN_BOOTSTRAP_EMAILS;
  });

  it('an unverified bootstrap match creates a plain user, not an admin', async () => {
    const { db, users, app } = appWith();
    const res = await app.request('/me', {
      headers: authed({ 'x-user-email': 'boss@example.com', 'x-user-verified': 'false' }),
    });
    expect(res.status).toBe(200);
    expect(users.findByEmail('boss@example.com')?.role).toBe('user');
    db.close();
  });

  it('a verified session for a bootstrap email is promoted (resolver path too)', async () => {
    const resolver: SessionResolver = async () => ({
      userId: 'kboss',
      email: 'boss@example.com',
      verified: true,
      displayName: null,
    });
    const { db, users, app } = appWith(resolver);
    const res = await app.request('/me', { headers: { cookie: 'ory_kratos_session=ok' } });
    expect(res.status).toBe(200);
    expect(users.findByEmail('boss@example.com')?.role).toBe('admin');
    db.close();
  });

  it('promotion is evaluated on first creation only: a later verified login does not upgrade', async () => {
    const { db, users, app } = appWith();
    const first = authed({ 'x-user-email': 'boss@example.com', 'x-user-verified': 'false' });
    expect((await app.request('/me', { headers: first })).status).toBe(200);
    // Now verified — but the row already exists as a plain user (verify before first login).
    const second = authed({ 'x-user-email': 'boss@example.com' });
    expect((await app.request('/me', { headers: second })).status).toBe(200);
    expect(users.findByEmail('boss@example.com')?.role).toBe('user');
    db.close();
  });
});
