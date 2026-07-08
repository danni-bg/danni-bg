# XML curated schema

XML resources (declared `xml`, `*xml*` content type, or a `.xml` URL) curate to `data.xml` +
`schema.json` under `store/curated/<dataset_id>/<resource_id>/`. The schema is the `XmlSchema` in
`src/curate/curator.ts`.

**Detection**: magic sniff (`src/curate/sniff.ts`) — a leading `<` in the ≤4096-byte head sniffs
`xml`; extension/declared format/content type are fallbacks. `XmlCurator.canHandle` accepts
declared `xml` or a `.xml` source URL.

**Encoding**: always UTF-8 (FR-008); CP1251 decode is recorded as a `utf8-from-windows1251`
transform rule. A source that is already UTF-8 curates byte-identically.

**Artifact shape**: the decoded document verbatim (no re-serialization, no structural transform);
`schema.rootElement` records the first element name (skipping the XML declaration and comments),
falling back to `unknown` on a degenerate document rather than failing.

**Invariants**: `store/raw/` keeps the verbatim source bytes (spec 049); the only transform is the
encoding decode.

**Round-trip parity test**: `tests/contract/curated-artifact-families.test.ts` —
"XML curator round-trips xml-sample.xml: schema validates the xml contract with the root element
identified and Cyrillic attributes intact" (fixture `tests/fixtures/resources/xml-sample.xml`;
asserts curated bytes equal the UTF-8 source) — registered in
`tests/parity-matrix.json#datasetSchemas[name=xml]`. Unit coverage:
`tests/unit/curate/xml.test.ts`.

**Cyrillic preservation**: element/attribute text is untouched (Principle X).
