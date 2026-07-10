// OAuth wiring (spec 063 P4) — createApp with ctx.oauth mounts the AS discovery endpoints AND lets a
// user-delegated Bearer JWT authenticate on gated routes (/mcp): requireAuth's OAuth branch +
// requireScope's mcp:<scope> mapping + the app.ts verifier.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import {
  OAuthClientsRepo,
  OAuthCodesRepo,
  OAuthRevocationsRepo,
} from '../../../src/store/repos/oauth.ts';
import { TenantsRepo } from '../../../src/store/repos/tenants.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import type { SessionResolver } from '../src/auth/kratos-session.ts';
import type { OAuthRouterDeps } from '../src/oauth/router.ts';
import { signAccessToken } from '../src/oauth/tokens.ts';
import { ReadBridge } from '../src/read-bridge.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SECRET = new TextEncoder().encode('integ-secret-0123456789');
const ISSUER = 'https://host';
const RESOURCE = 'https://host/mcp';
const T0 = 1_800_000_000_000;

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const users = new UsersRepo(db);
  const tenants = new TenantsRepo(db);
  const storeRoot = join(ROOT, 'store');
  const embedder = new LocalOnnxEmbedder({});
  const sessionResolver: SessionResolver = async () => null;
  const oauth: OAuthRouterDeps = {
    clients: new OAuthClientsRepo(db),
    codes: new OAuthCodesRepo(db),
    revocations: new OAuthRevocationsRepo(db),
    users,
    sessionResolver,
    config: {
      issuer: ISSUER,
      resource: RESOURCE,
      signingSecret: SECRET,
      accessTokenTtlSec: 3600,
      codeTtlSec: 60,
      loginPath: '/auth/login',
      scopesSupported: ['mcp:read', 'mcp:admin'],
    },
  };
  const ctx: AppContext = {
    bridge: new ReadBridge({ db, storeRoot, embedder, freshnessSloSeconds: 86400 }),
    crosswalk: new Crosswalk(loadCrosswalk()),
    users,
    tenants,
    mcp: { db, storeRoot, embedder, freshnessSloSeconds: 86400 },
    oauth,
    health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
  };
  const user = users.findOrCreateByKratosId({ kratosIdentityId: 'k1', email: 'u@example.com' });
  return { db, app: createApp(ctx), user };
}

async function mint(userId: string, scope: string, jti = 'j1') {
  const { token } = await signAccessToken(
    { userId, scope, audience: RESOURCE, clientId: 'c1' },
    SECRET,
    { issuer: ISSUER, ttlSec: 3600, jti, now: T0 },
  );
  return token;
}

const mcpInit = {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    },
  }),
};

describe('OAuth wiring (spec 063)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  it('mounts the AS discovery endpoints', async () => {
    const m = (await (await s.app.request('/.well-known/oauth-authorization-server')).json()) as {
      issuer: string;
    };
    expect(m.issuer).toBe('https://host');
  });

  it('a user-delegated token with mcp:read authenticates on /mcp', async () => {
    const token = await mint(s.user.id, 'mcp:read');
    const res = await s.app.request('/mcp', {
      ...mcpInit,
      headers: { ...mcpInit.headers, authorization: `Bearer ${token}` },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it('a token WITHOUT mcp:read is 403 on /mcp (requireScope mapping)', async () => {
    const token = await mint(s.user.id, 'mcp:admin', 'j2');
    const res = await s.app.request('/mcp', {
      ...mcpInit,
      headers: { ...mcpInit.headers, authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('an invalid Bearer JWT is 401, and no auth is 401', async () => {
    expect(
      (
        await s.app.request('/mcp', {
          ...mcpInit,
          headers: { ...mcpInit.headers, authorization: 'Bearer not.a.jwt' },
        })
      ).status,
    ).toBe(401);
    expect((await s.app.request('/mcp', mcpInit)).status).toBe(401);
  });
});
