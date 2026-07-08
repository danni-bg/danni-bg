# egov datastore envelope curated schema

data.egov.bg datastore captures are the VERBATIM `getResourceData` response envelope
(`{success, data}`) written byte-faithfully to `store/raw/` (spec 049 FR-310). The
`DatastoreJsonCurator` (`src/curate/datastore-json.ts`) owns all transformation and dispatches on
the `data` shape, producing the SAME artifact the generic curators would:

- **array-of-arrays** (header first) → CSV serialization + gated 2-row merged-header flattening
  (`flattenHeader`) → the CSV curator's tabular path (`data.ndjson` + tabular `schema.json`,
  see [tabular.md](tabular.md))
- **array-of-objects / structured document** → the JSON curator's normalized `data.json`
  (see [json.md](json.md))
- **plain string** → the text curator's verbatim `data.txt` (see [text.md](text.md))
- **absent/`null` `data`** → an empty JSON array artifact (the live API answers
  `{"success":true}` for an empty datastore)

**Detection**: not sniffed — the envelope sniffs as `json`, so the registry places this curator
ahead of `JsonCurator` and gates it on the recorded `EGOV_DATASTORE_FORMAT` hint in the
resource's `declared_format`/`detected_format` (spec 049 FR-312). Plain JSON resources fall
through to `JsonCurator`; legacy pre-049 `raw.{csv,json,txt}` captures keep their old hints and
curate via the generic curators (FR-313).

**Encoding**: the envelope is UTF-8 JSON; curated output is always UTF-8 (FR-008).

**Invariants**: `store/raw/` is byte-faithful (a header-flatten fix re-runs from raw alone,
FR-314); the dispatch is deterministic on the serialized `data` shape; delegated outputs are
byte-identical to the generic curators' on the same value (SC-2 parity).

**Round-trip parity test**: `tests/contract/curated-artifact-families.test.ts` —
"Datastore envelope (egov getResourceData.json) curates to a contract-valid tabular artifact:
header flattened, NDJSON rows, Cyrillic preserved" (fixture
`tests/fixtures/egov/getResourceData.json`, a recorded live envelope) — registered in
`tests/parity-matrix.json#datasetSchemas[name=datastore-json]`. Unit coverage (all four dispatch
shapes + SC-2 parity + registry selection): `tests/unit/curate/datastore-json.test.ts`.

**Cyrillic preservation**: header cells become byte-exact column `sourceName`s
(e.g. `РЕГИОН`); cell values pass through unmodified (Principle X).
