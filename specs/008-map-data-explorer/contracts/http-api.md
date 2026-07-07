# Contract: Explorer HTTP API

**Feature**: 008-map-data-explorer · **Service**: `apps/explorer-api` (Bun + Hono)

Contract-first per Constitution III. Every endpoint here MUST have a contract test (`bun:test`, mirror fixtures) registered in `tests/parity-matrix.json` before implementation (Constitution VIII). All inputs validated with Zod (Constitution VII). All responses are UTF-8 JSON unless noted (SSE for chat). Authoritative Bulgarian fields are returned verbatim; freshness blocks are mandatory on dataset/resource payloads (Constitution IX/X).

Base path: `/api`. Errors use a shared envelope:
```json
{ "error": { "code": "string", "message": "string", "details": {} } }
```
Error codes: `bad_request` (400, Zod failure), `not_found` (404), `provider_error` (502, LLM/provider), `provider_unconfigured` (400), `upstream_stale` (200 with `is_stale` flags — not an error), `internal` (500).

---

## GET /api/facets
Returns available filter options with in-scope counts (drives the filter panel).

**Query**: same filter params as `/api/datasets` (all optional). Counts reflect the supplied filters.

**200**:
```json
{
  "tags": [{ "id": "tag:въздух", "labelBg": "въздух", "labelEn": null, "count": 12 }],
  "publishers": [{ "id": "org:egov-org-61", "labelBg": "Граждански профил", "count": 3 }],
  "freshnessBuckets": [{ "id": "fresh", "count": 980 }, { "id": "stale", "count": 41 }]
}
```

## GET /api/regions
Choropleth aggregates for all administrative units at a level.

**Query**:
| param | type | default | notes |
|-------|------|---------|-------|
| `level` | `oblast \| municipality` | `oblast` | which layer to aggregate |
| filter params | — | — | same as `/api/datasets`; counts are in-scope (FR-014) |

**200**: `{ "regions": RegionSummary[] }` — see data-model. Units without a gazetteer/crosswalk link are returned with `entityId: null`, `hasData: false`, `flagged: "unlinked"`.

## GET /api/regions/:entityId
Datasets linked to one administrative unit.

**Path**: `entityId` = `geo:bg-*`.
**Query**: `limit` (default 50, max 200), `offset`, plus filter params.
**200**: `{ "region": RegionSummary, "datasets": DatasetPointer[], "total": number }`
**404**: unknown/unlinked `entityId` → `not_found`.
Empty linkage returns `200` with `datasets: []` (FR-004 empty state, not an error).

## GET /api/datasets
Filtered + searched dataset list (the core discovery endpoint). Backed by `search` / `searchByEntity` (free-text/entity) and curated filters.

**Query**:
| param | type | notes |
|-------|------|-------|
| `q` | string? | free-text BG/EN → ranked (FR-011) |
| `tags` | string[]? | repeatable; AND with other types (FR-007/FR-012) |
| `publisherIds` | string[]? | (FR-008) |
| `geoUnitIds` | string[]? | (FR-009) |
| `freshness` | `fresh \| stale \| any`? | default `any` (FR-010) |
| `includeWithdrawn` | boolean? | default false |
| `limit` | int? | default 50, max 200 (FR-030 pagination) |
| `offset` | int? | |
| `lang` | `bg \| en \| auto`? | search language hint |

**200**: `{ "datasets": DatasetPointer[], "total": number, "limit": number, "offset": number }`. `total` enables pagination/virtualization for large result sets (SC-010).

## GET /api/datasets/:datasetId
Full dataset detail (FR-005).
**200**: `DatasetDetailView` (description, resources w/ schema + freshness, entities, related links, lifecycleState, sourceUrl).
**404**: unknown id.

## GET /api/datasets/:datasetId/resources/:resourceId/rows
Paginated/sampled resource rows (never bulk-loads million-row resources — Scale constraint). Thin pass-through to `readResourceRows`.
**Query**: `limit` (default 100, max 1000), `offset`. Optional server-side grid (applied to the whole resource before pagination, so sort/filter cover the full dataset, capped at `MAX_GRID_SCAN`=100k rows):
- `sort` — column name to sort by; `dir` — `asc` (default) | `desc`. Numeric-aware ordering (numbers numerically, blanks last, else Bulgarian locale).
- `filters` — URL-encoded JSON object `{ "<col>": "<substring>" }`; case-insensitive substring, ANDed across columns. Malformed JSON is ignored.

**200**: `{ kind, rows?, document?, text?, total, limit, offset, truncated, gridTruncated? }` (mirrors `readResourceRows` output) + resource `freshness`. With a grid, `total` is the filtered count; `gridTruncated: true` when sort/filter saw only the first `MAX_GRID_SCAN` rows of a larger resource.

## POST /api/chat  (Server-Sent Events)
Backend-mediated, grounded, streaming chat (FR-015–FR-020, FR-025–FR-028). The browser never calls the LLM provider or mirror tools directly (clarification, FR-016).

**Request body** (Zod-validated, strict — unknown fields are rejected):
```json
{
  "sessionId": "string|null",        // null → server creates one (session-only, in-memory)
  "message": "string",
  "scope": { /* ScopeDescriptor: encoded FilterState, see chat-tools.md */ }
}
```

The LLM provider is resolved **server-side only** (spec 035 FR-170/171): admin runtime settings
(spec 019), falling back to the `EXPLORER_DEFAULT_*` env seed. There is no client-supplied
`provider` — a request still sending the pre-035 field fails validation with 400 (`bad_request`),
and nothing request-derived ever reaches provider-client construction.

**Response**: `text/event-stream`. Event types:
| event | data |
|-------|------|
| `session` | `{ "sessionId": "..." }` (first event) |
| `token` | `{ "delta": "..." }` streamed answer text |
| `tool` | `{ "name": "mirrorSearch|mirrorEntitySearch|mirrorInfo|readResource", "status": "start|done" }` (observability; no raw secrets) |
| `citations` | `{ "citations": Citation[] }` — each validated to exist in the mirror (SC-005) |
| `anchors` | `{ "geoEntityIds": [], "datasetIds": [] }` — map highlight/focus (FR-026/FR-027) |
| `done` | `{}` |
| `error` | `{ "code": "...", "message": "..." }` (e.g. `provider_unconfigured`, `provider_error`) |

**Grounding guarantees** (contract-tested):
- Every factual claim about Bulgarian public data is backed by a tool result; uncited/non-existent dataset references are stripped or flagged (FR-016, SC-004/SC-005).
- When tools return nothing in-scope, the stream yields an explicit "no relevant public data found" answer, not a fabrication (FR-018, SC-006).
- The model only sees datasets within `scope`; cited datasets ⊆ scope (FR-025, SC-008).
- Provider failure/timeout → `error` event with retryable code; no partial fabricated answer persisted (FR-023, Edge Cases).

## GET /healthz
Operational health (Constitution IV). **200**:
```json
{
  "status": "ok|degraded",
  "lastSyncedAt": "ISO-8601|null",
  "isStale": false,
  "components": { "store": "ok", "boundaries": "ok", "defaultProvider": "configured|absent" }
}
```
`degraded` (still 200) when the mirror is stale or the default provider is absent — graceful degradation, never a crash (Constitution IV).

---

## Parity matrix obligations

Each endpoint above is one row in `tests/parity-matrix.json` with its contract test id. The four chat tool wrappers have their own parity rows (see `chat-tools.md`). CI fails if any endpoint or tool lacks a contract test.
