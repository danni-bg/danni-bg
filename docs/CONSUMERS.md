# Consuming the danni-bg mirror

danni-bg is built for **machine consumers** — LLM agents, analytics jobs, retrieval systems — that
want Bulgarian open-government data without depending on the live portal. There are three ways in:

1. **The MCP server** (`danni mcp`) — for LLM agents. Read-only, over stdio.
2. **Directly off disk** — the curated files + SQLite store, with machine-readable contracts.
3. **The explorer HTTP API** (`apps/explorer-api`) — a JSON/SSE web API behind the map explorer.

All are **read-only**: the store on disk is the source of truth, produced by the sync→curate→
enrich→index pipeline. Every search result carries a `sourceUrl` (back to data.egov.bg) and a
`curatedDatasetPath` (under `store/curated/`) for one-hop traceability (FR-013).

## 1. MCP server (`danni mcp`)

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server over stdio
(newline-delimited JSON-RPC 2.0). Point any MCP client at it:

```jsonc
// claude_desktop_config.json / mcp.json
{
  "mcpServers": {
    "danni-bg": {
      "command": "bun",
      "args": ["run", "danni", "mcp"],
      "cwd": "/path/to/danni-bg",                       // so ./store resolves; or…
      "env": { "DANNI_CONFIG": "/path/to/danni.config.json" }  // …point at an absolute store.root
    }
  }
}
```

(Equivalently, run the bin directly: `command: "/path/to/danni-bg/bin/danni"`, `args: ["mcp"]`.)

### Hosted (remote) — `POST /mcp` (spec 061)

The deployed explorer also serves MCP over the network at **`/mcp`** using the Streamable-HTTP
transport, so an agent can reach the live mirror (with real semantic search) without a local store.
Authenticate with a danni **API key** that has the `read` scope (create one under the account
"API ключове" section); an anonymous request is `401`, a key without `read` is `403`.

```jsonc
// an MCP client that supports a remote Streamable-HTTP server + a bearer token
{
  "mcpServers": {
    "danni-bg": {
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer dnk_live_…" }
    }
  }
}
```

Same four tools, same request/response shapes as the stdio server (it reuses the identical tool
definitions) — only the transport differs. The tools are scoped to the API key's tenant.

#### Auth options for the hosted `/mcp`

- **API key** (above) — a machine credential, simplest for scripts/agents you run yourself.
- **User-delegated OAuth 2.1** (spec 063) — the agent acts *on a signed-in human's behalf*, inheriting
  their role/tenant (resolved fresh per request). Enable it by setting `OAUTH_ISSUER` (the app's public
  origin) + `OAUTH_SIGNING_SECRET` on the server; the app then serves the standard discovery documents
  (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`) and the
  authorization-code + PKCE flow at `/oauth/{authorize,token,register,revoke}`. An MCP client that
  supports remote OAuth discovers these automatically; the human logs in via the existing session and
  the client receives a short-lived Bearer token (scope `mcp:read`, or `mcp:admin` for the admin MCP
  below). This is the required auth for the admin MCP (spec 062), where a machine key is not accepted.

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `mirror_search` | `query` (string, bg/en), `limit?` (1–50, default 5) | Ranked `IndexEntry[]` — `datasetId`, `title` (bg/en), `publisher`, `matchKind`, `sourceUrl`, `curatedDatasetPath`, `freshness`. |
| `mirror_entity_search` | `entityId` (string), `limit?` (1–50, default 50) | Datasets linked to that entity, with the matched entity label. |
| `mirror_info` | `datasetId` (string) | The full curated-dataset record: title/description (bg+en), publisher, resources (with `curatedPath` + schema), entities, cross-dataset links, freshness. |
| `read_resource` | `datasetId`, `resourceId`, `limit?` (1–1000, default 100), `offset?`, `filters?` (object: EXACT column → case-insensitive substring), `sort?` (`{col, dir?}`, `dir` = `asc`\|`desc`, default `asc`) | The resource's curated content: paginated `rows` (tabular/NDJSON or JSON array), a single `document` (JSON/GeoJSON object), or `text` (XML/text). |

Tool failures (unknown dataset, bad arguments) come back as a result with `isError: true` and a
message — they do not crash the session. A typical agent flow: `mirror_search` → `mirror_info` to
inspect resources → `read_resource` to pull the rows it needs, citing the `sourceUrl` it found.

To answer a value question without paging the whole artifact through the model, pass `filters` — a
map of **exact column name → case-insensitive substring** (e.g. `{"rayon": "Панчарево"}`). Every
entry must match (AND), and the tool returns only matching `rows`. An optional `sort` orders the
whole resource before pagination (`{"col": "name", "dir": "asc"}`). `filters`/`sort` apply only to
tabular/JSON-array rows and are the same server-side grid the explorer chat and HTTP API use (specs
009/010/017): the scan is capped at `MAX_GRID_SCAN` (100 000) rows, and when a filter/sort saw only
that prefix of a larger resource the response sets `gridTruncated: true`. A malformed `filters`/`sort`
shape returns `isError: true`, not a crash.

> The semantic half of `mirror_search` is only as good as the configured embedder — wire a real one
> (see [`semantic-search.md`](./semantic-search.md)); otherwise only the keyword leg is meaningful.

### Admin MCP — `POST /admin/mcp` (spec 062)

The management counterpart to the read `/mcp`: a thin, role-guarded projection of the same admin
surface the web console uses (manage your API keys, your org's members/settings, and — for a
super-admin — tenants, user roles, key quotas, and the audit trail). It is **human-delegated only** —
a machine `dnk_live_…` API key is rejected (403); reach it with a **user-delegated OAuth token
carrying the `mcp:admin` scope** (the same discovery/PKCE flow as `/mcp`, above). The caller's role +
active org are resolved *fresh per request*, so tools are **tier-filtered**: `tools/list` shows only
the tools the caller may run.

| Tier | Tools |
|---|---|
| Any signed-in human | `list_my_api_keys`, `create_api_key` `{name, scopes?}`, `revoke_api_key` `{keyId, confirm}` |
| Org owner/admin (active org) | `list_members`, `get_tenant_settings`, `set_tenant_settings` `{llm?, toggles?}` |
| Super-admin (app role `admin`) | `list_tenants` `{limit?, offset?}`, `set_user_role` `{email, role, confirm}`, `set_api_key_quota` `{keyId, limit}`, `list_audit` `{limit?, offset?}` |

Destructive tools (`revoke_api_key`, `set_user_role`) require an explicit `confirm: true` — a call
without it returns `isError: true` and makes no change. `create_api_key` returns the plaintext secret
**once**. Every mutation is written to the audit trail (`list_audit`, super-admin) with actor, action,
target, and outcome (`ok`/`error`). Calling a tool above your tier returns `isError: true`
(`unknown or unauthorized tool`), never a silent escalation.

## 2. Directly off disk

The store is a plain, browsable layout — a consumer can read it without any danni code:

```
store/
 ├─ raw/      <dataset_id>/<resource_id>/raw.*            byte-faithful source archive
 ├─ curated/  <dataset_id>/<resource_id>/data.* + schema.json   normalized, UTF-8, declared schema
 └─ danni.sqlite                                          metadata, entities, links, translations, index
```

- **Curated data**: `store/curated/<dataset_id>/<resource_id>/data.ndjson` (tabular, one JSON object
  per line), `data.json` (JSON/GeoJSON), `data.xml`, or `data.txt`, alongside a `schema.json`.
- **Metadata + index**: `store/danni.sqlite` (`datasets`, `resources`, `curated_artifacts`,
  `entities`, `dataset_entities`, `entity_relations`, `dataset_links`, `translations`, `datasets_fts`,
  `dataset_embeddings`).

### Contracts

The machine-readable shapes are JSON Schemas under
[`specs/001-egov-data-sync/contracts/`](../specs/001-egov-data-sync/contracts/):

| Schema | Describes |
|---|---|
| `curated-dataset.schema.json` | the `mirror_info` record |
| `index-entry.schema.json` | a `mirror_search` result |
| `curated-tabular-artifact.schema.json` | a tabular curated artifact + its column schema |
| `manifest.schema.json` / `sync-run.schema.json` | per-run provenance |

These are validated in CI against the real output (`tests/contract/`), so a consumer can rely on
them. The `danni mcp` tool outputs reuse these shapes: `mirror_info` → curated-dataset,
`mirror_search` / `mirror_entity_search` → index-entry. `read_resource` returns a `ResourceContent`
shape (`rows` / `document` / `text` + pagination), documented in the tool table above rather than as
a published JSON-Schema contract.

## 3. The explorer HTTP API (`apps/explorer-api`)

The interactive map explorer is backed by a Bun + Hono JSON API that projects the same store. It is
the human-facing front door, but the endpoints are a clean programmatic interface in their own right:

| Endpoint | Returns |
|---|---|
| `GET /api/datasets` | Filterable, paginated dataset pointers (free-text `q` runs hybrid search). |
| `GET /api/datasets/:id` | The curated-dataset detail (resources, entities, related-dataset links — links/entities capped). |
| `GET /api/entities/:id` | An entity's knowledge-graph node: canonical labels (bg/en), kind, its outgoing + incoming typed `entity_relations` (e.g. a municipality's parent oblast via `part_of`, an oblast's child municipalities), and its direct dataset count. 404 for an unknown id. |
| `GET /api/datasets/:id/resources/:rid/rows` | Paginated curated rows / document / text for a resource. Supports server-side sort + per-column filters (`sort`/`dir`/`filters` query params). |
| `GET /api/regions?level=oblast\|municipality` | Choropleth aggregates: a hierarchical roll-up where an oblast's count is the de-duplicated union of its own + its municipalities' datasets (municipality summaries carry `oblastEntityId`). |
| `GET /api/national`, `GET /api/facets` | Non-georeferenced datasets; filter facets with in-scope counts. |
| `POST /api/chat` | **SSE** grounded chat: streams tokens + validated `citations` + map `anchors`. |

### Pagination

Every list endpoint takes `limit` + `offset` and returns `total` alongside the page. `limit` is
clamped to a per-endpoint hard cap (`/api/datasets`: default 50, cap 200; the self/admin lists
`/api/me/sessions`, `/api/admin/usage`, `/api/admin/tenants`, `/api/admin/api-usage`: default 100,
cap 200), so no endpoint ever returns an unbounded full-table dump. `offset` is clamped to `≥ 0`; an
absent or invalid value falls back to the default. Page through by advancing `offset` until it
reaches `total`.

### Versioning & compatibility

The API is served under `/api` with **no version prefix** — treat it as an implicit **v1**. The
compatibility promise: changes under `/api` are **additive only** (new endpoints, new optional fields,
new optional query params); a field or endpoint that exists will not change shape or be removed under
`/api`. Any breaking change would be introduced under a new `/api/v2` prefix served alongside the
existing one — so a client written against today's `/api` keeps working. (There is deliberately no
`/api/v1` alias: introducing one would break every existing client, SPA, and MCP consumer for no
functional gain.)

All inputs are Zod-validated; responses are UTF-8 JSON (SSE for chat) with mandatory `freshness`
blocks. The chat is grounded by construction: the focused/open dataset's real rows are injected as
ground-truth context (sticky across follow-ups, hardened against fabrication), not just answered
from the four scoped read tools — and every citation is still validated against what those tools
returned. Full shapes:
[`specs/008-map-data-explorer/contracts/http-api.md`](../specs/008-map-data-explorer/contracts/http-api.md)
and [`chat-tools.md`](../specs/008-map-data-explorer/contracts/chat-tools.md); the entities endpoint
has its own contract at
[`specs/016-entity-knowledge-graph/contracts/entities-get.md`](../specs/016-entity-knowledge-graph/contracts/entities-get.md).

## Freshness

Every record carries a `freshness` block (`lastSyncedAt`, `sourceLastModified`, `isStale`,
`freshnessSloSeconds`) so a consumer can decide how much to trust it. `danni status` reports the
last successful sync and the freshness SLO for the mirror as a whole.
