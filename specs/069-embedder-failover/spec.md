# Spec 069 — Embedder failover chain

## Context

Embedding is stateless and ephemeral, so the cost-optimal operating point is: serve embeddings from a
**cheap/local** endpoint when it's up, and pay a **hosted pay-per-token** endpoint only for the gap.
The go-live tension ("cheap LAN box vs. reliable hosted") dissolves into a **configurable ordered
failover chain** — *if* it's homogeneous.

The one real hazard is not downtime (the chain fixes that) but **vector-space consistency**: search is
cosine similarity between the *query* vector and the *stored corpus* vectors, so they must live in the
**same space** — same model, same dimension. A fallback to a *different* model silently returns wrong
answers, not an error. So the chain is safe only as a **homogeneous** chain (same model, different
hosts), and the system must enforce what it can (dimension) and document what it can't (identical
checkpoint).

Confirmed feasible: Scaleway offers `qwen/qwen3-embedding-8b:bf16` (tag `embeddings`, up to **4096**
dims) — the **same Qwen3-Embedding-8B** the LAN `spark` box runs — on its per-token Generative API. So
the primary (spark) + a Scaleway fallback are the same space, and the fallback tier is genuinely
pay-per-use.

This slots onto the existing seam: an `Embedder` interface (`embed()` + `id`/`dimension`),
`buildEmbedder(config)`, and `classifyEmbedError` (spec 054) that already separates **transient**
(429/5xx/network, by typed `httpStatus`) from **content** faults.

## Functional requirements

- **FR-500** A `FailoverEmbedder implements Embedder` wraps an **ordered** list of embedders. `embed()`
  tries them in order; on a **transient** fault (`classifyEmbedError → transient`) it moves to the next
  endpoint; on a **content** fault (bad input / length or dimension mismatch — fails everywhere) it
  **rethrows** without wasting the fallback. If every endpoint fails transiently it throws an
  `AggregateError`.
- **FR-501 (consistency contract)** Every endpoint must produce the **same dimension**. Build-time:
  `buildEmbedder` rejects a chain whose endpoints declare unequal `dimension`. Runtime: a returned
  vector whose length ≠ the chain dimension is a hard error (the detectable half of vector-space
  drift). Identical *model* across endpoints is the operator's documented contract (cross-provider
  model *names* differ, so it can't be auto-enforced).
- **FR-502 (circuit breaker)** A transiently-failed endpoint is **tripped** for a cooldown; subsequent
  `embed()` calls try healthy endpoints **first** and only fall back to tripped ones as a last resort —
  so a sleeping `spark` doesn't cost every query its timeout. A success closes the breaker.
- **FR-503 (stable identity)** The chain reports ONE `id` + `dimension` (the primary's / the logical
  model), so `embeddings_meta` records a stable model id and a failover doesn't thrash the
  model-change re-embed (spec 050). `maxBatchSize` is the **min** of the endpoints' caps (respect the
  most restrictive).
- **FR-504 (config)** `enrichment.embedder` gains an optional `fallbacks: [<embedder>...]` — each a
  full single-embedder config (`provider`/`endpointUrl`/`modelId`/`apiKeyEnv`/`dimension`). Absent →
  a single embedder exactly as today (backward-compatible). Applies to BOTH index-time (batch) and
  query-time (the same `buildEmbedder` result is used by `danni index` + the read bridge).

## Success criteria

- **SC-1** With `[spark, scaleway]`, a query embeds on spark when it's up and transparently on Scaleway
  when spark is down; index and search keep working; billing is only the covered gap.
- **SC-2** A dimension-mismatched endpoint hard-fails (build or runtime), never silently corrupts
  results.
- **SC-3** 100% line + function coverage on the new embedder + factory wiring.
