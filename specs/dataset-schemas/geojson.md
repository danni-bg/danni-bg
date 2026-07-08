# GeoJSON curated schema

GeoJSON resources (declared `geojson` or a `.geojson` URL) curate to `data.json` + `schema.json`
under `store/curated/<dataset_id>/<resource_id>/`. The schema is the `JsonShapeSchema`
(`kind: 'geojson'`) in `src/curate/curator.ts`.

**Detection**: magic sniff (`src/curate/sniff.ts`) — a leading `{` whose ≤4096-byte head carries a
`"type": "Feature|FeatureCollection|Point|Polygon|…"` marker sniffs `geojson` ahead of plain
`json`; `geo+json` content type and the `.geojson` extension are fallbacks.
`GeoJsonCurator.canHandle` accepts declared `geojson` or a `.geojson` source URL.

**Encoding**: always UTF-8 (FR-008); CP1251 decode is recorded as a `utf8-from-windows1251`
transform rule.

**Artifact shape**: the parsed document re-serialized as 2-space-indented JSON;
`schema.rootShape` is `feature_collection` or `feature` — a non-Feature root throws (the resource
stays uncurated), so a `geojson` artifact is always a renderable Feature/FeatureCollection.

**Invariants**: `store/raw/` keeps the verbatim source bytes (spec 049); geometry coordinates and
`properties` values round-trip unmodified.

**Round-trip parity test**: `tests/contract/curated-artifact-families.test.ts` —
"GeoJSON curator round-trips geojson-sample.geojson: schema validates the geojson contract
(feature_collection) with Cyrillic properties intact" (fixture
`tests/fixtures/resources/geojson-sample.geojson`) — registered in
`tests/parity-matrix.json#datasetSchemas[name=geojson]`. Unit coverage:
`tests/unit/curate/geojson.test.ts`.

**Cyrillic preservation**: `properties` strings pass through unescaped (Principle X).
