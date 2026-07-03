# Feature Specification: MCP read parity (filters + sort on read_resource)

**Feature Branch**: `053-mcp-read-parity`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the two
front doors over the shared read substrate drifted — the chat `readResource` tool gained the
spec-017 value-filter (server-side GridQuery) but the MCP `read_resource` tool still only pages.

## Overview

The explorer chat and the MCP server are the two front doors over the same read substrate
(`src/read`). Spec 017 taught the chat's `readResource` tool to filter rows server-side (exact
column → case-insensitive substring over the whole resource, via `GridQuery`), which is what makes
value questions ("kindergartens in район Панчарево") answerable without paging the entire artifact
through the model. An MCP agent gets none of that: `read_resource` can only page. Bring the MCP
tool up to the same capability by passing the same parameters through to the same substrate call,
and keep the documented MCP contract in sync.

Single responsibility: **both front doors expose the same read capabilities from the shared
substrate.** Search-path performance is spec 050; the substrate's grid semantics (specs 009/010)
are unchanged.

## Finding & evidence

- **(a) `read_resource` never grew grid parameters.** The MCP tool schema + handler accept only
  `datasetId`/`resourceId`/`limit`/`offset` (`src/mcp/server.ts:134-167`) and call
  `readResourceRows` without a `grid` (`server.ts:162-165`). The capability lives one layer down
  in the shared substrate: `readResourceRows` accepts `opts.grid: GridQuery` (sort + per-column
  filters applied to the whole resource before pagination, `src/read/resource-rows.ts:8-13`,
  applied at `resource-rows.ts:87-125` with the `MAX_GRID_SCAN` cap and a `gridTruncated` flag).
- **(b) The chat front door already exposes it.** The chat `readResource` tool takes `filters`
  (map of exact column name → case-insensitive substring), maps them to a `GridQuery`
  (`{ sort: null, filters }`) and instructs the model to prefer filtering over paging
  (`apps/explorer-api/src/chat/tools.ts:126-149`); the explorer HTTP grid additionally uses the
  substrate's `sort`. An MCP agent asking the same value question must page blind.
- **(c) The documented MCP contract omits it.** `docs/CONSUMERS.md:42` documents `read_resource`
  with only `limit`/`offset` — the doc must grow with the tool (and the schema tables at
  `CONSUMERS.md:76-82` reference `ResourceContent`, which already carries `gridTruncated`).
- **(d) `mirror_search` parity — verified, no schema drift.** The MCP tool exposes
  `query`/`lang`/`limit` (`src/mcp/server.ts:54-67`), the same options as the chat `mirrorSearch`
  input schema (`apps/explorer-api/src/chat/tools.ts:56-60`). Residual differences are defaults
  and context, not capability: default limit 5 vs 10, and the chat tool's geo-scope over-fetch +
  entity backfill (`tools.ts:74-89`) exists because chat requests carry a scope — MCP has no
  scope, so nothing to mirror. (Noted in passing: `lang` is accepted by both doors but never read
  by the shared `search()` — a shared-substrate gap, not front-door drift; out of scope here.)

## Requirements

- **FR-350**: The MCP `read_resource` tool MUST accept optional `filters` (object: exact column
  name → case-insensitive substring) and `sort` (column + direction) parameters, passed through
  as the same `GridQuery` the chat/explorer use — identical matching semantics, `MAX_GRID_SCAN`
  cap, and pagination-after-filter behavior, with no parallel filtering implementation.
- **FR-351**: The tool's advertised `inputSchema` and its runtime validation MUST both cover the
  new parameters (including rejecting a malformed `sort`/`filters` with a tool-level error, per
  the existing isError convention), and the response MUST surface `gridTruncated` so an agent
  knows a filter saw only the first `MAX_GRID_SCAN` rows.
- **FR-352**: `docs/CONSUMERS.md` MUST document the extended `read_resource` contract (parameters,
  filter semantics, the scan cap / `gridTruncated`) in the tool table and keep the schema notes
  accurate — the doc ships in the same change as the tool.
- **FR-353**: A parity test MUST assert that the grid capabilities exposed by the chat
  `readResource` tool are also reachable through the MCP tool: the same
  (datasetId, resourceId, filters) request through both front doors returns the same matching
  rows from the shared substrate.

## Success criteria

- **SC-1**: An MCP agent can answer a value question by filtering (e.g.
  `filters: {"rayon": "Панчарево"}`) and receives only matching rows — byte-identical row content
  to the chat tool's result for the same arguments (parity test, FR-353).
- **SC-2**: `tools/list` advertises the new parameters; invalid `filters`/`sort` shapes return an
  `isError: true` tool result, not a protocol error or crash.
- **SC-3**: A filtered read of a resource larger than `MAX_GRID_SCAN` reports
  `gridTruncated: true` through MCP exactly as through the chat tool.
- **SC-4**: `docs/CONSUMERS.md` describes the extended contract; a reader can construct a working
  filtered `read_resource` call from the doc alone.

## Out of scope / dependencies

- Search-path scale + `IndexEntry` contract unification → **spec 050** (shared substrate; both
  front doors inherit it).
- Grid semantics themselves (matching rules, `MAX_GRID_SCAN`) — locked by **specs 009/010/017**;
  this spec only exposes them, it does not change them.
- The `lang` option accepted by both doors but never read by the shared `search()` — **spec 056**
  (FR-385) deletes that plumbing end-to-end; both tool schemas lose the parameter there, not here.
- MCP scope/tenancy (the MCP server is a local, unscoped consumer by design — specs 027/029 gate
  the HTTP surface, not stdio MCP).
