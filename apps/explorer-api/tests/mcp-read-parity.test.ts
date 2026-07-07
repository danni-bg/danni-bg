// Spec 053 — MCP read parity (FR-353). The chat `readResource` tool and the MCP `read_resource`
// tool are the two front doors over the same read substrate (`src/read`). This asserts that the
// grid capabilities exposed by the chat door (spec-017 value-filter → GridQuery) are reachable
// through the MCP door too: the same (datasetId, resourceId, filters) request through BOTH doors
// returns the same matching rows from the shared substrate — no parallel filtering implementation.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCallOptions, ToolSet } from 'ai';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import { type JsonRpcResponse, type McpContext, handleRpc } from '../../../src/mcp/server.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { CuratedArtifactsRepo } from '../../../src/store/repos/curated-artifacts.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { ResourcesRepo } from '../../../src/store/repos/resources.ts';
import { buildTools } from '../src/chat/tools.ts';
import { ReadBridge } from '../src/read-bridge.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../migrations', import.meta.url));
const opts = { toolCallId: 't', messages: [] } as unknown as ToolCallOptions;

const ROWS = [
  { rayon: 'Панчарево', name: 'ДГ 1' },
  { rayon: 'Лозенец', name: 'ДГ 2' },
  { rayon: 'Панчарево', name: 'ДГ 3' },
  { rayon: 'Средец', name: 'ДГ 4' },
];

function callTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const t = tools[name];
  if (!t?.execute) throw new Error(`tool ${name} is not executable`);
  return (t.execute as (i: unknown, o: ToolCallOptions) => Promise<unknown>)(input, opts);
}

function mcpRead(ctx: McpContext, args: Record<string, unknown>): Promise<JsonRpcResponse | null> {
  return handleRpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'read_resource',
        arguments: { datasetId: 'd1', resourceId: 'r1', ...args },
      },
    },
    ctx,
  );
}

function mcpRows(resp: JsonRpcResponse | null): unknown[] {
  const result = (resp as JsonRpcResponse).result as { content: Array<{ text: string }> };
  return (JSON.parse(result.content[0]?.text ?? '{}') as { rows: unknown[] }).rows;
}

describe('MCP ↔ chat read_resource parity (spec 053)', () => {
  let db: Database;
  let ctx: McpContext;
  let tools: ToolSet;

  beforeEach(async () => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db, MIGRATIONS);
    new DatasetsRepo(db).upsert({
      id: 'd1',
      slug: 'd1',
      titleBg: 'Детски градини',
      tags: [],
      groups: [],
      sourceUrl: 'https://data.egov.bg/d1',
    });
    new ResourcesRepo(db).upsert({
      id: 'r1',
      datasetId: 'd1',
      sourceUrl: 'https://data.egov.bg/d1/r1',
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
      `${ROWS.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );

    const embedder = new LocalOnnxEmbedder({ dimension: 8 });
    ctx = { db, storeRoot, embedder, freshnessSloSeconds: 86400 };
    // Empty scope = full-mirror scope, so the chat door doesn't block d1 (parity is about the
    // shared grid substrate, not scope — the MCP door is unscoped by design).
    tools = buildTools(
      new ReadBridge({ db, storeRoot, embedder, freshnessSloSeconds: 86400 }),
      {},
    ).tools;
  });
  afterEach(() => db.close());

  it('the same (datasetId, resourceId, filters) request returns the same matching rows through both doors', async () => {
    const args = { datasetId: 'd1', resourceId: 'r1', filters: { rayon: 'Панчарево' } };
    const chatRows = (await callTool(tools, 'readResource', args)) as { rows: unknown[] };
    const mcpResult = mcpRows(await mcpRead(ctx, { filters: { rayon: 'Панчарево' } }));

    // Both doors return exactly the two Панчарево rows, byte-identical (SC-1).
    expect(mcpResult).toEqual([
      { rayon: 'Панчарево', name: 'ДГ 1' },
      { rayon: 'Панчарево', name: 'ДГ 3' },
    ]);
    expect(mcpResult).toEqual(chatRows.rows);
  });

  it('a no-filter read is identical through both doors (baseline parity)', async () => {
    const chatRows = (await callTool(tools, 'readResource', {
      datasetId: 'd1',
      resourceId: 'r1',
    })) as { rows: unknown[] };
    expect(mcpRows(await mcpRead(ctx, {}))).toEqual(chatRows.rows);
    expect(chatRows.rows).toEqual(ROWS);
  });
});
