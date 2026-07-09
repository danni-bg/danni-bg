// Resource-server token verification (spec 063 P2) — including the fresh-authority property (FR-484).
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../../src/store/migrate.ts';
import { OAuthRevocationsRepo } from '../../../src/store/repos/oauth.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { createAccessTokenVerifier } from '../src/oauth/resource-server.ts';
import { signAccessToken } from '../src/oauth/tokens.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SECRET = new TextEncoder().encode('rs-secret-0123456789');
const ISSUER = 'https://danni.example/';
const RESOURCE = 'https://danni.example/mcp';
const T0 = 1_800_000_000_000;

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  const revocations = new OAuthRevocationsRepo(db);
  const user = users.findOrCreateByKratosId({ kratosIdentityId: 'k1', email: 'a@example.com' });
  const verify = createAccessTokenVerifier({
    secret: SECRET,
    issuer: ISSUER,
    resource: RESOURCE,
    revocations,
    users,
  });
  return { db, users, revocations, user, verify };
}

async function mint(userId: string, scope = 'mcp:read', jti = 'j1') {
  const { token } = await signAccessToken(
    { userId, scope, audience: RESOURCE, clientId: 'c1' },
    SECRET,
    { issuer: ISSUER, ttlSec: 600, jti, now: T0 },
  );
  return token;
}

describe('OAuth resource-server verify (spec 063)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  it('resolves the fresh principal for a valid token', async () => {
    const p = await s.verify(await mint(s.user.id), T0 + 1000);
    expect(p?.user.id).toBe(s.user.id);
    expect(p?.scopes).toEqual(['mcp:read']);
    expect(p?.clientId).toBe('c1');
  });

  it('rejects a revoked token (jti denylist)', async () => {
    const token = await mint(s.user.id, 'mcp:read', 'jrev');
    s.revocations.revoke('jrev', new Date(T0 + 600_000).toISOString());
    expect(await s.verify(token, T0 + 1000)).toBeNull();
  });

  it('rejects a token whose subject no longer exists', async () => {
    const token = await mint('ghost-user');
    expect(await s.verify(token, T0 + 1000)).toBeNull();
  });

  it('rejects an expired or wrong-audience token', async () => {
    expect(await s.verify(await mint(s.user.id), T0 + 601_000)).toBeNull(); // expired
    const { token } = await signAccessToken(
      {
        userId: s.user.id,
        scope: 'mcp:read',
        audience: 'https://danni.example/other',
        clientId: 'c1',
      },
      SECRET,
      { issuer: ISSUER, ttlSec: 600, jti: 'jx', now: T0 },
    );
    expect(await s.verify(token, T0 + 1000)).toBeNull(); // wrong audience
  });

  it('resolves ROLE fresh — a token minted while admin loses admin after a demotion (FR-484)', async () => {
    s.users.setRoleByEmail('a@example.com', 'admin');
    const token = await mint(s.user.id, 'mcp:admin', 'jfresh');
    expect((await s.verify(token, T0 + 1000))?.user.role).toBe('admin');
    // Demote — the SAME still-valid token now resolves a non-admin principal.
    s.users.setRoleByEmail('a@example.com', 'user');
    expect((await s.verify(token, T0 + 2000))?.user.role).toBe('user');
  });
});
