# Spec 061 — First-class hosted MCP server

## Problem

The MCP server (`danni mcp`, spec 007/053) is **stdio-only, local-store**: an LLM agent must spawn it
as a subprocess against a copy of the mirror on disk. There is no way for a remote agent to reach the
**deployed** mirror over MCP — the only networked consumer path is the HTTP read API + chat. MCP should
be a first-class, networked, authenticated front door alongside them.

## Solution

Mount a hosted MCP server in `apps/explorer-api` at **`POST/GET/DELETE /mcp`**, using the official
`@modelcontextprotocol/sdk` over the **Web-Standard Streamable-HTTP transport** (Request/Response —
runs natively on Bun/Hono, no Node `http` shim). It reuses the deployed read substrate (the same DB +
the tailnet embedder, so semantic `mirror_search` works remotely) and the **exact same `TOOLS` array**
the stdio server uses — the two doors differ only in transport.

## Functional requirements

- **FR-450** `GET/POST/DELETE /mcp` speaks MCP over the Streamable-HTTP transport via the official SDK.
  Stateless (a fresh `Server` + transport per request) — a read-only tool server needs no session state.
- **FR-451** The hosted tools ARE the stdio `TOOLS` (`src/mcp/server.ts`): `mirror_search`,
  `mirror_entity_search`, `mirror_info`, `read_resource` — same descriptions, input schemas, and `run()`.
  A tool-level failure returns `isError: true` content (MCP convention), never a JSON-RPC crash, exactly
  as the stdio handler does. (Extends spec-053 read-parity to transport-parity.)
- **FR-452** `/mcp` is gated by a danni **API key** (`Authorization: Bearer dnk_live_…`) with the
  **`read` scope** (spec 027): the route runs `authGate` → `requireScope('read')` before the handler, so
  an anonymous request is `401` and a key lacking `read` is `403`. A human Kratos session also passes
  (any scope), matching the rest of the API.
- **FR-453** The hosted server is wired only when `AppContext.mcp` is present (the composition root
  passes the shared `{db, storeRoot, embedder, freshnessSloSeconds}`); with it absent, `/mcp` is not
  mounted (`404`). The stdio `danni mcp` mode is unchanged (offline/local agents keep working).

## Non-goals / deferred

- **Metering & quota** (spec 028) on `/mcp` — the gate authenticates + scopes but does not yet record
  per-key usage or rate-limit MCP calls. Fast-follow: give `/mcp` the same `dataApiGate` treatment.
- **MCP OAuth 2.1** — API-key bearer is the v1 auth; native MCP OAuth (discovery metadata) is a later
  interop enhancement for generic remote-MCP clients.

## Testing (Constitution VIII — 100%)

`apps/explorer-api/tests/mcp-http.test.ts`: the SDK `Client` over an in-memory transport exercises
`buildMcpServer` (tools/list = the four tools; tools/call success, unknown-tool, bad-args → `isError`);
a Hono mount + the real `createApp` mount assert the API-key gate (`401` anon, reaches the transport
with a `read` key, `404` when unwired). `src/mcp/http.ts` is 100% funcs/lines.
