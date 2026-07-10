// Admin MCP (spec 062) — hermetic. Drives buildAdminMcpServer via the SDK Client (tier filtering,
// every tool, confirm-gating, audit incl. the error path) + a createApp mount test for the guards
// (human-only, mcp:admin scope, anon).
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { AdminAuditRepo } from '../../../src/store/repos/admin-audit.ts';
import { ApiKeyRepo } from '../../../src/store/repos/api-keys.ts';
import {
  OAuthClientsRepo,
  OAuthCodesRepo,
  OAuthRevocationsRepo,
} from '../../../src/store/repos/oauth.ts';
import { PlatformSettingsRepo } from '../../../src/store/repos/platform-settings.ts';
import { TenantsRepo } from '../../../src/store/repos/tenants.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import type { SessionResolver } from '../src/auth/kratos-session.ts';
import { type AdminMcpDeps, type AdminPrincipal, buildAdminMcpServer } from '../src/mcp/admin.ts';
import { signAccessToken } from '../src/oauth/tokens.ts';
import { ReadBridge } from '../src/read-bridge.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const deps: AdminMcpDeps = {
    apiKeys: new ApiKeyRepo(db),
    tenants: new TenantsRepo(db),
    settings: new PlatformSettingsRepo(db),
    users: new UsersRepo(db),
    audit: new AdminAuditRepo(db),
  };
  const user = deps.users.findOrCreateByKratosId({
    kratosIdentityId: 'k1',
    email: 'u@example.com',
  });
  return { db, deps, user };
}

async function connect(principal: AdminPrincipal, deps: AdminMcpDeps) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildAdminMcpServer(principal, deps).connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };

describe('admin MCP (spec 062)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  const member = (): AdminPrincipal => ({ user: s.user, tenantId: 't1', tenantRole: 'member' });
  const orgAdmin = (): AdminPrincipal => ({ user: s.user, tenantId: 't1', tenantRole: 'admin' });
  const superAdmin = (): AdminPrincipal => ({
    user: { ...s.user, role: 'admin' },
    tenantId: 't1',
    tenantRole: 'admin',
  });

  it('tier-filters tools/list by the principal', async () => {
    const m = await connect(member(), s.deps);
    expect((await m.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'create_api_key',
      'list_my_api_keys',
      'revoke_api_key',
    ]);
    await m.close();
    const o = await connect(orgAdmin(), s.deps);
    expect((await o.listTools()).tools.map((t) => t.name)).toContain('set_tenant_settings');
    expect((await o.listTools()).tools.map((t) => t.name)).not.toContain('list_tenants');
    await o.close();
    const a = await connect(superAdmin(), s.deps);
    const names = (await a.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_tenants');
    expect(names).toContain('set_user_role');
    expect(names).toContain('list_audit');
    await a.close();
  });

  it('create + revoke API key: audits, confirm-gates the revoke', async () => {
    const c = await connect(member(), s.deps);
    const created = JSON.parse(
      (await call(c, 'create_api_key', { name: 'k', scopes: ['read'] })).content[0]?.text ?? '',
    ) as { plaintext: string; view: { id: string } };
    expect(created.plaintext).toBeString();
    // list_my_api_keys returns the metadata (never the secret)
    const listed = JSON.parse(
      (await call(c, 'list_my_api_keys', {})).content[0]?.text ?? '',
    ) as Array<{
      id: string;
    }>;
    expect(listed.some((k) => k.id === created.view.id)).toBe(true);
    // revoke without confirm → error, no change
    expect((await call(c, 'revoke_api_key', { keyId: created.view.id })).isError).toBe(true);
    // revoke with confirm → ok
    const revoked = await call(c, 'revoke_api_key', { keyId: created.view.id, confirm: true });
    expect(revoked.isError).toBe(false);
    await c.close();
    // both the create and the confirmed revoke are audited
    const actions = s.deps.audit.list({ limit: 10, offset: 0 }).items.map((r) => r.action);
    expect(actions).toContain('create_api_key');
    expect(actions).toContain('revoke_api_key');
  });

  it('super-admin: set_user_role (confirm), list_tenants, set_api_key_quota, list_audit', async () => {
    const c = await connect(superAdmin(), s.deps);
    // set_user_role needs confirm
    expect(
      (await call(c, 'set_user_role', { email: 'u@example.com', role: 'admin' })).isError,
    ).toBe(true);
    expect(
      (await call(c, 'set_user_role', { email: 'u@example.com', role: 'admin', confirm: true }))
        .isError,
    ).toBe(false);
    // list_tenants
    const tenants = JSON.parse((await call(c, 'list_tenants', {})).content[0]?.text ?? '') as {
      total: number;
    };
    expect(typeof tenants.total).toBe('number');
    // set_api_key_quota (on a key we create first)
    const key = JSON.parse(
      (await call(c, 'create_api_key', { name: 'q' })).content[0]?.text ?? '',
    ) as {
      view: { id: string };
    };
    expect((await call(c, 'set_api_key_quota', { keyId: key.view.id, limit: 100 })).isError).toBe(
      false,
    );
    // list_audit shows the mutations
    const audit = JSON.parse((await call(c, 'list_audit', {})).content[0]?.text ?? '') as {
      items: Array<{ action: string }>;
    };
    expect(audit.items.map((a) => a.action)).toContain('set_user_role');
    await c.close();
  });

  it('org-admin: list_members, get + set tenant settings', async () => {
    const c = await connect(orgAdmin(), s.deps);
    expect((await call(c, 'list_members', {})).isError).toBe(false);
    expect((await call(c, 'get_tenant_settings', {})).isError).toBe(false);
    const set = await call(c, 'set_tenant_settings', { toggles: { defaultTokenLimit: 5000 } });
    expect(set.isError).toBe(false);
    await c.close();
  });

  it('unknown/unauthorized tool + the audit-on-error path', async () => {
    const c = await connect(member(), s.deps);
    // a super-admin tool is not exposed to a member → unknown/unauthorized
    expect((await call(c, 'list_tenants', {})).isError).toBe(true);
    await c.close();
    // audit-on-error: a mutation whose repo call throws is recorded with outcome 'error'
    const throwing: AdminMcpDeps = {
      ...s.deps,
      apiKeys: {
        ...s.deps.apiKeys,
        create: () => {
          throw new Error('boom');
        },
      } as unknown as ApiKeyRepo,
    };
    const c2 = await connect(member(), throwing);
    expect((await call(c2, 'create_api_key', { name: 'x' })).isError).toBe(true);
    await c2.close();
    const errRow = s.deps.audit
      .list({ limit: 10, offset: 0 })
      .items.find((r) => r.outcome === 'error');
    expect(errRow?.action).toBe('create_api_key');
  });

  describe('mount guards (createApp)', () => {
    const RESOURCE = 'https://host/mcp';
    const SECRET = new TextEncoder().encode('sec-0123456789');
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });
    const headers = (extra: Record<string, string>) => ({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extra,
    });

    function app() {
      const db = s.db;
      const users = new UsersRepo(db);
      const apiKeys = new ApiKeyRepo(db);
      const tenants = new TenantsRepo(db);
      const sessionResolver: SessionResolver = async () => null;
      const oauth = {
        clients: new OAuthClientsRepo(db),
        codes: new OAuthCodesRepo(db),
        revocations: new OAuthRevocationsRepo(db),
        users,
        sessionResolver,
        config: {
          issuer: 'https://host',
          resource: RESOURCE,
          signingSecret: SECRET,
          accessTokenTtlSec: 3600,
          codeTtlSec: 60,
          loginPath: '/auth/login',
          scopesSupported: ['mcp:read', 'mcp:admin'],
        },
      };
      const embedder = new LocalOnnxEmbedder({});
      const ctx: AppContext = {
        bridge: new ReadBridge({
          db,
          storeRoot: join(ROOT, 'store'),
          embedder,
          freshnessSloSeconds: 86400,
        }),
        crosswalk: new Crosswalk(loadCrosswalk()),
        users,
        apiKeys,
        tenants,
        adminMcp: {
          apiKeys,
          tenants,
          settings: s.deps.settings,
          users,
          audit: new AdminAuditRepo(db),
        },
        oauth,
        health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
      };
      return { app: createApp(ctx), apiKeys, users };
    }

    async function token(scope: string) {
      const { token } = await signAccessToken(
        { userId: s.user.id, scope, audience: RESOURCE, clientId: 'c' },
        SECRET,
        { issuer: 'https://host', ttlSec: 600, jti: crypto.randomUUID() },
      );
      return token;
    }

    it('rejects API keys (403), an mcp:read token (403), anon (401); an mcp:admin token reaches it', async () => {
      const { app: a, apiKeys, users } = app();
      const owner = users.findOrCreateByKratosId({
        kratosIdentityId: 'k1',
        email: 'u@example.com',
      });
      const { plaintext } = apiKeys.create({ userId: owner.id, name: 'k' });
      // API key → 403 (requireHuman)
      expect(
        (
          await a.request('/admin/mcp', {
            method: 'POST',
            headers: headers({ authorization: `Bearer ${plaintext}` }),
            body: initBody,
          })
        ).status,
      ).toBe(403);
      // OAuth mcp:read → 403 (requireMcpAdminScope)
      expect(
        (
          await a.request('/admin/mcp', {
            method: 'POST',
            headers: headers({ authorization: `Bearer ${await token('mcp:read')}` }),
            body: initBody,
          })
        ).status,
      ).toBe(403);
      // anon → 401
      expect(
        (await a.request('/admin/mcp', { method: 'POST', headers: headers({}), body: initBody }))
          .status,
      ).toBe(401);
      // OAuth mcp:admin → reaches the transport
      const ok = await a.request('/admin/mcp', {
        method: 'POST',
        headers: headers({ authorization: `Bearer ${await token('mcp:admin')}` }),
        body: initBody,
      });
      expect(ok.status).not.toBe(401);
      expect(ok.status).not.toBe(403);
    });
  });
});
