# Contract: Chat Grounding Tools & Scope

**Feature**: 008-map-data-explorer · **Module**: `apps/explorer-api/src/chat`

The chat is a retrieval-augmented tool-use loop (research R7). The model is given exactly four tools, each a 1:1 server-side wrapper over the existing in-process read API. Wrappers apply the request `scope` so the model can only ever retrieve in-scope datasets (FR-025). Each tool wrapper MUST have a contract test referencing the underlying read function and its parity-matrix row (Constitution VIII). Inputs/outputs are Zod-validated (Constitution VII).

## ScopeDescriptor
Deterministic encoding of `FilterState`, sent with every chat request and applied as a server-side post-filter.

```ts
ScopeDescriptor = {
  tags?: string[];            // tag ids/labels
  publisherIds?: string[];    // org:egov-org-*
  geoUnitIds?: string[];      // geo:bg-*
  freshness?: "fresh" | "stale" | "any";
  includeWithdrawn?: boolean; // default false
  query?: string;             // free-text context (not a hard filter)
}
```
**Rule**: an empty descriptor = full-mirror scope. Post-filter is applied to results returned by the underlying read functions; the curated store itself is never mutated (Constitution I/V).

## Tool: mirrorSearch
Wraps `search(...)` from `src/index/query.ts` (hybrid keyword+semantic).
- **Input**: `{ query: string, lang?: "bg"|"en"|"auto", limit?: number(<=50) }`
- **Behavior**: runs search, then drops any result outside `scope`. Returns dataset pointers `{ datasetId, titleBg, titleEn, publisher, sourceUrl, freshness, score }`.
- **Maps to**: data.egov.bg mirror search; same ranking as MCP `mirror_search`.

## Tool: mirrorEntitySearch
Wraps `searchByEntity(...)`.
- **Input**: `{ entityId: string, limit?: number(<=50) }`
- **Behavior**: finds datasets linked to an entity (geo/org/tag/time), intersected with `scope`. Returns pointers + matched entity label.

## Tool: mirrorInfo
Wraps `datasetView(...)`.
- **Input**: `{ datasetId: string }`
- **Behavior**: returns the full curated record (bilingual title/description, publisher, resources w/ schema, entities, links, freshness, sourceUrl). If the dataset is outside `scope`, the wrapper returns a `{ outOfScope: true, datasetId }` marker rather than the record (keeps the model inside scope).

## Tool: readResource
Wraps `readResourceRows(...)`.
- **Input**: `{ datasetId: string, resourceId: string, limit?: number(<=1000), offset?: number }`
- **Behavior**: returns paginated/sampled rows or a single document/text, plus resource freshness. Never returns whole million-row resources (Scale constraint); always paginated.

## Grounding & citation contract
Implemented in `grounding.ts`, contract-tested against fixtures:

1. **System prompt** instructs: answer only from tool results; never invent datasets, values, or URLs; cite every factual claim; reply "no relevant public data found" when tools yield nothing in-scope; surface freshness and flag machine-translated/coded values (FR-016, FR-018, FR-020).
2. **Citation extraction**: the backend collects dataset ids the model relied on and emits `Citation[] = {datasetId, titleBg, sourceUrl, freshness}`.
3. **Existence validation**: every cited `datasetId` MUST resolve via `datasetView`; unknown/hallucinated ids are dropped and the corresponding claim flagged (SC-005 → 0% fabricated sources).
4. **Scope validation**: cited datasets MUST be ⊆ `scope` (SC-008). Violations are filtered before the `citations` event is emitted.
5. **Anchors**: from cited datasets' `geoEntityIds`, emit a `MapAnchor` for map highlight/focus (FR-026/FR-027).

## Provider seam
`providers.ts` selects a model client from the **server-configured default only** (spec 035: admin runtime settings → `EXPLORER_DEFAULT_*` env; requests carry no provider):
- `kind: "openai-compatible"` → AI SDK OpenAI adapter with configurable `baseUrl` (OpenAI, self-hosted/local vLLM).
- `kind: "anthropic"` → AI SDK Anthropic adapter.
- No default configured → `provider_unconfigured`; runtime failure → `provider_error` — both surfaced as an SSE `error` event with no fabricated content (FR-023).
- The provider seam is the test boundary: contract/integration tests inject a stub model returning scripted tool calls + text, so the inner loop needs no live LLM (Constitution VI).

**Secrets**: `apiKey` comes from server config only, is used only to construct the client, and is never logged or persisted (FR-024, Constitution IV).
