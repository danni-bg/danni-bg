import { resolve } from 'node:path';
import { loadConfig } from '../config/loader.ts';
import { buildEmbedder } from '../index/embedders/factory.ts';
import { type JsonRpcResponse, type McpContext, handleRpc } from '../mcp/server.ts';
import { openDb } from '../store/db.ts';

/** Parse one line as JSON-RPC and dispatch it; a malformed line yields a -32700 parse error. */
export async function dispatchLine(line: string, ctx: McpContext): Promise<JsonRpcResponse | null> {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
  }
  return handleRpc(msg as Parameters<typeof handleRpc>[0], ctx);
}

/**
 * The newline-delimited JSON-RPC 2.0 stdio loop. Reads messages (one per line) from `input` and
 * writes responses via `write` (one per line). Notifications produce no output. Both are injectable
 * so the loop is testable without real stdio.
 */
export async function runStdio(
  ctx: McpContext,
  input?: AsyncIterable<Uint8Array>,
  write: (s: string) => void = (s) => {
    process.stdout.write(s);
  },
): Promise<void> {
  const src = input ?? (Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>);
  const decoder = new TextDecoder();
  let buf = '';
  const flush = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const resp = await dispatchLine(trimmed, ctx);
    if (resp) write(`${JSON.stringify(resp)}\n`);
  };
  for await (const chunk of src) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      await flush(line);
      nl = buf.indexOf('\n');
    }
  }
  await flush(buf);
}

export async function run(args: string[], input?: AsyncIterable<Uint8Array>): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(
      'danni mcp\n' +
        '  Read-only Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).\n' +
        '  Tools: mirror_search, mirror_entity_search, mirror_info, read_resource.\n' +
        '  Point an MCP client at `bun run danni mcp` (or the `danni` bin). See docs/CONSUMERS.md.\n',
    );
    return 0;
  }
  const config = loadConfig();
  const storeRoot = resolve(process.cwd(), config.store.root);
  const db = openDb({ storeRoot, loadVec: false });
  try {
    const ctx: McpContext = {
      db,
      storeRoot,
      embedder: buildEmbedder(config.enrichment.embedder),
      freshnessSloSeconds: config.store.freshnessSloSeconds,
    };
    await runStdio(ctx, input);
    return 0;
  } finally {
    db.close();
  }
}
