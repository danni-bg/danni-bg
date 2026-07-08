# JSON curated schema

JSON resources (declared `json`/`jsonl`/`ndjson`, or a `.json`-family URL/content type) curate to
`data.json` + `schema.json` under `store/curated/<dataset_id>/<resource_id>/`. The schema is the
`JsonShapeSchema` (`kind: 'json'`) in `src/curate/curator.ts`.

**Detection**: magic sniff of a bounded ≤4096-byte head (`src/curate/sniff.ts` via
`registry.readHead`, FR-360) — a leading `{`/`[` sniffs `json` unless the head carries a GeoJSON
`"type"` marker; extension, declared format, and content type are fallbacks.
`JsonCurator.canHandle` accepts declared `json`/`jsonl`/`ndjson` or a `.json(l|nd)` source URL.

**Encoding**: always UTF-8 (FR-008). CP1251 source bytes are decoded and recorded in
`schema.transformRules` as a `utf8-from-windows1251` rule.

**Artifact shape**: the parsed value re-serialized as 2-space-indented JSON;
`schema.rootShape` records `array` vs `object`.

**Invariants**: `store/raw/` keeps the verbatim source bytes (spec 049); malformed JSON throws —
the resource stays uncurated rather than producing a mangled artifact.

**Round-trip parity test**: `tests/contract/curated-artifact-families.test.ts` —
"JSON curator round-trips json-array.json: schema validates the json contract and data.json
preserves the Cyrillic fixture value" (fixture `tests/fixtures/resources/json-array.json`) —
registered in `tests/parity-matrix.json#datasetSchemas[name=json]`. Unit coverage:
`tests/unit/curate/json.test.ts`.

**Cyrillic preservation**: string values pass through `JSON.parse`/`stringify` unescaped —
`"София"` in the source is `"София"` in `data.json` (Principle X).
