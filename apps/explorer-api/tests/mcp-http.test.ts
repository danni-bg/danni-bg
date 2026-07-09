// Hosted MCP server (spec 061) — hermetic. Drives the SAME `buildMcpServer` the /mcp route uses via
// the official SDK Client over an in-memory transport (proves the tool handlers), and mounts
// `mcpHttpHandler` behind requireAuth + requireScope('read') to prove the API-key gate.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hono } from 'hono';
import { Crosswalk } from '../../../packages/geo-boundaries/src/crosswalk.ts';
import { loadCrosswalk } from '../../../packages/geo-boundaries/src/load.ts';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import type { McpContext } from '../../../src/mcp/server.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { ApiKeyRepo } from '../../../src/store/repos/api-keys.ts';
import { UsersRepo } from '../../../src/store/repos/users.ts';
import { type AppContext, createApp } from '../src/app.ts';
import { buildMcpServer, mcpHttpHandler } from '../src/mcp/http.ts';
import { type AuthEnv, requireAuth, requireScope } from '../src/middleware/require-auth.ts';
import { ReadBridge } from '../src/read-bridge.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, join(ROOT, 'migrations'));
  const ctx: McpContext = {
    db,
    storeRoot: join(ROOT, 'store'),
    embedder: new LocalOnnxEmbedder({}),
    freshnessSloSeconds: 86400,
  };
  return { db, ctx };
}

/** Connect an SDK Client to a fresh server over a linked in-memory transport pair. */
async function connectClient(ctx: McpContext) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(ctx).connect(serverT);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientT);
  return client;
}

describe('hosted MCP server (spec 061)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.db.close());

  it('lists the same four read tools as the stdio server', async () => {
    const client = await connectClient(s.ctx);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'mirror_entity_search',
      'mirror_info',
      'mirror_search',
      'read_resource',
    ]);
    // Each advertises a JSON-Schema object with the expected required fields.
    const search = tools.find((t) => t.name === 'mirror_search');
    expect(search?.inputSchema?.required).toEqual(['query']);
    await client.close();
  });

  it('calls a tool and returns its result as text content (isError:false)', async () => {
    const client = await connectClient(s.ctx);
    const res = (await client.callTool({
      name: 'mirror_search',
      arguments: { query: 'вода' },
    })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBe(false);
    // Empty mirror → an empty ranked array, but valid JSON the agent can parse.
    const first = res.content[0];
    if (!first) throw new Error('expected a content block');
    expect(JSON.parse(first.text)).toEqual([]);
    await client.close();
  });

  it('reports an unknown tool as isError, not a protocol crash', async () => {
    const client = await connectClient(s.ctx);
    const res = (await client.callTool({ name: 'nope', arguments: {} })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    const first = res.content[0];
    if (!first) throw new Error('expected a content block');
    expect(first.text).toContain('unknown tool');
    await client.close();
  });

  it('reports bad tool arguments as isError (the tool run throws on a zod parse)', async () => {
    const client = await connectClient(s.ctx);
    const res = (await client.callTool({ name: 'mirror_search', arguments: {} })) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    await client.close();
  });

  describe('HTTP mount — API-key gate', () => {
    function mountedApp(ctx: McpContext) {
      const db = ctx.db;
      const users = new UsersRepo(db);
      const apiKeys = new ApiKeyRepo(db);
      const owner = users.findOrCreateByKratosId({
        kratosIdentityId: 'k1',
        email: 'u@example.com',
      });
      const app = new Hono<AuthEnv>();
      const handler = mcpHttpHandler(ctx);
      app.all('/mcp', requireAuth(users, undefined, apiKeys), requireScope('read'), (c) =>
        handler(c),
      );
      return { app, apiKeys, owner };
    }

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
    const mcpHeaders = (extra: Record<string, string>) => ({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extra,
    });

    it('rejects an unauthenticated request with 401', async () => {
      const { app } = mountedApp(s.ctx);
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: mcpHeaders({}),
        body: initBody,
      });
      expect(res.status).toBe(401);
    });

    it('lets a read-scoped API key reach the transport (initialize succeeds)', async () => {
      const { app, apiKeys, owner } = mountedApp(s.ctx);
      const { plaintext } = apiKeys.create({ userId: owner.id, name: 'k' });
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: mcpHeaders({ authorization: `Bearer ${plaintext}` }),
        body: initBody,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    // The real createApp mount (exercises the `if (ctx.mcp)` branch + the gate composed in app.ts).
    it('createApp mounts /mcp only when ctx.mcp is wired, gated by the API key', async () => {
      const db = s.ctx.db;
      const base: Omit<AppContext, 'mcp'> = {
        bridge: new ReadBridge({
          db,
          storeRoot: s.ctx.storeRoot,
          embedder: s.ctx.embedder,
          freshnessSloSeconds: 86400,
        }),
        crosswalk: new Crosswalk(loadCrosswalk()),
        users: new UsersRepo(db),
        apiKeys: new ApiKeyRepo(db),
        health: () => ({ lastSyncedAt: null, isStale: true, defaultProvider: 'absent' }),
      };
      // Not wired → no /mcp route (404).
      const off = await createApp(base).request('/mcp', {
        method: 'POST',
        headers: mcpHeaders({}),
        body: initBody,
      });
      expect(off.status).toBe(404);
      // Wired → mounted + gated: anon is 401.
      const on = await createApp({ ...base, mcp: s.ctx }).request('/mcp', {
        method: 'POST',
        headers: mcpHeaders({}),
        body: initBody,
      });
      expect(on.status).toBe(401);
    });
  });
});
