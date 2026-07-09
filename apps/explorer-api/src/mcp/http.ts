// Hosted MCP server (spec 061) — the first-class, networked front door for LLM-agent consumers,
// mounted in the explorer-api at /mcp. Uses the official @modelcontextprotocol/sdk over the
// Web-Standard Streamable-HTTP transport (Request/Response — runs natively on Bun/Hono, no Node
// http shim), STATELESS (a fresh Server + transport per request), which fits a read-only tool
// server with no per-session state. Auth is the caller's danni API key (scope `read`, enforced by
// the route's requireScope before this handler runs — spec 027).
//
// The tool set is the SAME `TOOLS` array the stdio `danni mcp` server uses (src/mcp/server.ts), so
// the hosted and local doors can never drift (spec 053 read-parity, now transport-parity too): this
// module only adapts those defs to the SDK's request handlers, reusing each tool's description,
// inputSchema, and run() verbatim.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from 'hono';
import { type McpContext, SERVER_INFO, TOOLS } from '../../../../src/mcp/server.ts';

/** Build an SDK Server that serves the shared read TOOLS against `ctx`. Exported for direct testing. */
export function buildMcpServer(ctx: McpContext): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    // Tool-level problems come back as a result with isError:true (MCP convention), never a thrown
    // JSON-RPC error — matching the stdio handler exactly.
    if (!tool) {
      return {
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.run(req.params.arguments ?? {}, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Hono handler for POST/GET/DELETE /mcp. Stateless: connect a fresh Server to a fresh transport and
 * hand it the raw Request; the transport returns the Response (JSON or an SSE stream). The route
 * mounts this behind the auth gate + requireScope('read'), so a request reaching here is already an
 * authenticated `read`-scoped principal.
 */
export function mcpHttpHandler(ctx: McpContext): (c: Context) => Promise<Response> {
  return async (c) => {
    const server = buildMcpServer(ctx);
    // No sessionIdGenerator → stateless mode (a fresh transport per request, no session state).
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  };
}
