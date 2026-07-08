# Text curated schema

Plain-text resources (declared `txt`/`text`/`md`, a `text/*` content type, or anything no other
curator claims — `TextCurator` is the terminal `canHandle: true` curator before the uncurated
fallback) curate to `data.txt` + `schema.json` under
`store/curated/<dataset_id>/<resource_id>/`. The schema is the `TextSchema` in
`src/curate/curator.ts`.

**Detection**: `text` is also the sniffer's `fallback` kind (`src/curate/sniff.ts`) when no magic
byte, extension, declared format, or content type matches.

**Encoding**: always UTF-8 (FR-008). CP1251 source bytes are decoded
(`src/curate/encoding.ts`) and recorded in `schema.transformRules` as a
`utf8-from-windows1251` rule; UTF-8 sources pass through byte-identically.

**Artifact shape**: the decoded text verbatim — the encoding decode is the only transform.

**Invariants**: `store/raw/` keeps the verbatim source bytes (spec 049); curation never fails on
content (any byte sequence decodes), so `text` is the safety net that keeps a resource curatable.

**Round-trip parity test**: `tests/contract/curated-artifact-families.test.ts` —
"Text curator round-trips text-cp1251.txt: CP1251 bytes decode to UTF-8 Cyrillic and the
transform rule is declared" (fixture `tests/fixtures/resources/text-cp1251.txt`, CP1251-encoded
Cyrillic) — registered in `tests/parity-matrix.json#datasetSchemas[name=text]`. Unit coverage:
`tests/unit/curate/text.test.ts`.

**Cyrillic preservation**: the CP1251→UTF-8 decode maps code points only — no transliteration
(Principle X); the fixture round-trip asserts the exact Cyrillic output.
