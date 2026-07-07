import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { runIndex } from '../../../src/index/run-index.ts';
import {
  type JsonRpcResponse,
  type McpContext,
  SERVER_INFO,
  TOOLS,
  handleRpc,
} from '../../../src/mcp/server.ts';
import { MAX_GRID_SCAN } from '../../../src/read/resource-grid.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { CuratedArtifactsRepo } from '../../../src/store/repos/curated-artifacts.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../../src/store/repos/entities.ts';
import { ResourcesRepo } from '../../../src/store/repos/resources.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../migrations', import.meta.url));

async function setup(): Promise<McpContext> {
  const storeRoot = globalThis.__TEST_TMP_DIR__;
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db, MIGRATIONS);
  new DatasetsRepo(db).upsert({
    id: 'd1',
    slug: 'd1',
    titleBg: 'Бюджет на София',
    tags: [],
    groups: [],
    sourceUrl: 'https://data.egov.bg/data/view/d1',
  });
  new ResourcesRepo(db).upsert({
    id: 'r1',
    datasetId: 'd1',
    sourceUrl: 'https://x/r1',
    declaredFormat: 'csv',
  });
  const rel = join('d1', 'r1', 'data.ndjson');
  new CuratedArtifactsRepo(db).upsert({
    datasetId: 'd1',
    resourceId: 'r1',
    kind: 'tabular',
    path: rel,
    schemaJson: '{}',
    transformRulesJson: '[]',
    curatorVersion: 'v1',
  });
  mkdirSync(join(storeRoot, 'curated', 'd1', 'r1'), { recursive: true });
  writeFileSync(
    join(storeRoot, 'curated', rel),
    `${JSON.stringify({ col: 'v1' })}\n${JSON.stringify({ col: 'v2' })}\n`,
  );
  const entities = new EntitiesRepo(db);
  entities.upsert({
    id: 'org:e1',
    kind: 'organization',
    canonicalLabelBg: 'Столична община',
    canonicalLabelEn: 'Sofia Municipality',
  });
  entities.attach({ datasetId: 'd1', entityId: 'org:e1', extractor: 'test', confidence: 0.95 });
  const embedder = new LocalOnnxEmbedder({ dimension: 8 });
  await runIndex({ db, embedder });
  return { db, storeRoot, embedder, freshnessSloSeconds: 86400 };
}

function callResult(resp: JsonRpcResponse | null): { isError: boolean; data: unknown } {
  const result = (resp as JsonRpcResponse).result as {
    isError: boolean;
    content: Array<{ text: string }>;
  };
  const text = result.content[0]?.text ?? 'null';
  // Success payloads are JSON; error payloads are a plain message string.
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep raw text for error results */
  }
  return { isError: result.isError, data };
}

describe('mcp.server handleRpc', () => {
  let ctx: McpContext;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(() => ctx.db.close());

  it('initialize returns serverInfo + tools capability', async () => {
    const r = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      ctx,
    );
    expect(r?.result).toMatchObject({
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      protocolVersion: '2024-11-05',
    });
  });

  it('tools/list advertises the four read tools', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
    const names = (r?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'mirror_entity_search',
      'mirror_info',
      'mirror_search',
      'read_resource',
    ]);
    expect(TOOLS.length).toBe(4);
  });

  it('tools/call mirror_info returns the dataset record', async () => {
    const r = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'mirror_info', arguments: { datasetId: 'd1' } },
      },
      ctx,
    );
    const { isError, data } = callResult(r);
    expect(isError).toBe(false);
    const view = data as { datasetId: string; resources: unknown[] };
    expect(view.datasetId).toBe('d1');
    expect(view.resources.length).toBe(1);
  });

  it('tools/call mirror_search finds the dataset by keyword', async () => {
    const r = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'mirror_search', arguments: { query: 'бюджет', limit: 5 } },
      },
      ctx,
    );
    const hits = callResult(r).data as Array<{ datasetId: string }>;
    expect(hits.some((h) => h.datasetId === 'd1')).toBe(true);
  });

  it('tools/call mirror_entity_search returns datasets linked to the entity, with its label', async () => {
    const r = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'mirror_entity_search', arguments: { entityId: 'org:e1' } },
      },
      ctx,
    );
    expect(callResult(r).isError).toBe(false);
    const hits = callResult(r).data as Array<{
      datasetId: string;
      matchedEntities?: Array<{ entityId: string; kind: string; label: { bg: string } }>;
    }>;
    expect(hits.some((h) => h.datasetId === 'd1')).toBe(true);
    const matched = hits[0]?.matchedEntities?.[0];
    expect(matched?.kind).toBe('organization');
    expect(matched?.label.bg).toBe('Столична община');
  });

  it('tools/call read_resource returns paginated rows', async () => {
    const r = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'read_resource',
          arguments: { datasetId: 'd1', resourceId: 'r1', limit: 1 },
        },
      },
      ctx,
    );
    const out = callResult(r).data as { total: number; rows: unknown[]; truncated: boolean };
    expect(out.total).toBe(2);
    expect(out.rows.length).toBe(1);
    expect(out.truncated).toBe(true);
  });

  // Rewrite the curated d1/r1 artifact (registered by setup) with richer rows so the grid
  // params have something to filter/sort. Same on-disk path readResourceRows reads from.
  function seedRows(rows: unknown[]): void {
    const rel = join('d1', 'r1', 'data.ndjson');
    writeFileSync(
      join(globalThis.__TEST_TMP_DIR__, 'curated', rel),
      `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
  }

  function readResource(args: Record<string, unknown>): Promise<JsonRpcResponse | null> {
    return handleRpc(
      {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'read_resource',
          arguments: { datasetId: 'd1', resourceId: 'r1', ...args },
        },
      },
      ctx,
    );
  }

  it('read_resource filters rows via the shared GridQuery (exact column → case-insensitive substring)', async () => {
    seedRows([
      { rayon: 'Панчарево', name: 'A' },
      { rayon: 'Лозенец', name: 'B' },
      { rayon: 'Панчарево', name: 'C' },
    ]);
    // Lowercase query proves the case-insensitive substring match of spec 017.
    const out = callResult(await readResource({ filters: { rayon: 'панчарево' } })).data as {
      rows: Array<{ name: string }>;
      total: number;
    };
    expect(out.total).toBe(2);
    expect(out.rows.map((r) => r.name)).toEqual(['A', 'C']);
  });

  it('read_resource sorts rows via the shared GridQuery (sort col + dir)', async () => {
    seedRows([{ n: 2 }, { n: 1 }, { n: 3 }]);
    const desc = callResult(await readResource({ sort: { col: 'n', dir: 'desc' } })).data as {
      rows: Array<{ n: number }>;
    };
    expect(desc.rows.map((r) => r.n)).toEqual([3, 2, 1]);
    // dir defaults to asc.
    const asc = callResult(await readResource({ sort: { col: 'n' } })).data as {
      rows: Array<{ n: number }>;
    };
    expect(asc.rows.map((r) => r.n)).toEqual([1, 2, 3]);
  });

  it('read_resource still pages after filtering (limit/offset over the filtered view)', async () => {
    seedRows([
      { rayon: 'Панчарево', name: 'A' },
      { rayon: 'Лозенец', name: 'B' },
      { rayon: 'Панчарево', name: 'C' },
      { rayon: 'Панчарево', name: 'D' },
    ]);
    const page = callResult(
      await readResource({ filters: { rayon: 'Панчарево' }, limit: 1, offset: 1 }),
    ).data as { rows: Array<{ name: string }>; total: number; truncated: boolean };
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.name)).toEqual(['C']);
    expect(page.truncated).toBe(true);
  });

  it('read_resource surfaces gridTruncated when a filter sees only the first MAX_GRID_SCAN rows', async () => {
    seedRows(Array.from({ length: MAX_GRID_SCAN + 1 }, (_, i) => ({ rayon: 'Панчарево', i })));
    const out = callResult(await readResource({ filters: { rayon: 'Панчарево' }, limit: 1 }))
      .data as {
      gridTruncated?: boolean;
      total: number;
    };
    expect(out.gridTruncated).toBe(true);
    // Only the first MAX_GRID_SCAN rows were scanned, so the filtered total caps there.
    expect(out.total).toBe(MAX_GRID_SCAN);
  });

  it('read_resource rejects a malformed filters/sort shape with isError (not a crash)', async () => {
    seedRows([{ n: 1 }]);
    expect(callResult(await readResource({ filters: ['not', 'a', 'map'] })).isError).toBe(true);
    expect(callResult(await readResource({ filters: { rayon: 5 } })).isError).toBe(true);
    expect(callResult(await readResource({ sort: { dir: 'asc' } })).isError).toBe(true);
    expect(callResult(await readResource({ sort: { col: 'n', dir: 'sideways' } })).isError).toBe(
      true,
    );
  });

  it('tools/list advertises the read_resource filters + sort parameters', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 21, method: 'tools/list' }, ctx);
    const tool = (
      r?.result as {
        tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
      }
    ).tools.find((t) => t.name === 'read_resource');
    expect(tool?.inputSchema.properties).toHaveProperty('filters');
    expect(tool?.inputSchema.properties).toHaveProperty('sort');
  });

  it('surfaces tool failures as isError (unknown dataset, bad args, unknown tool)', async () => {
    const notFound = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'mirror_info', arguments: { datasetId: 'nope' } },
      },
      ctx,
    );
    expect(callResult(notFound).isError).toBe(true);
    const badArgs = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'mirror_search', arguments: {} },
      },
      ctx,
    );
    expect(callResult(badArgs).isError).toBe(true);
    const badTool = await handleRpc(
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'bogus' } },
      ctx,
    );
    expect(callResult(badTool).isError).toBe(true);
    const badResource = await handleRpc(
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'read_resource', arguments: { datasetId: 'd1', resourceId: 'nope' } },
      },
      ctx,
    );
    expect(callResult(badResource).isError).toBe(true);
  });

  it('unknown method → -32601; notifications (incl. initialize-as-notification) → no response; ping → {}', async () => {
    const unknown = await handleRpc({ jsonrpc: '2.0', id: 9, method: 'frobnicate' }, ctx);
    expect(unknown?.error?.code).toBe(-32601);
    const notif = await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx);
    expect(notif).toBeNull();
    // A request-method arriving WITHOUT an id is a notification and must get no response.
    const initAsNotif = await handleRpc({ jsonrpc: '2.0', method: 'initialize' }, ctx);
    expect(initAsNotif).toBeNull();
    const ping = await handleRpc({ jsonrpc: '2.0', id: 10, method: 'ping' }, ctx);
    expect(ping?.result).toEqual({});
  });
});
