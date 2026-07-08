# Dataset Schema Catalog

This directory is the **authoritative per-dataset schema catalog** required
by Constitution Principle III. It grows as the crawler encounters new
datasets and the curator infers their canonical schema.

## Status

**Bootstrapped on 2026-05-08** as part of feature `001-egov-data-sync` (Phase
1 design). Each entry is added once the corresponding curated artifact has
been produced and a fixture-based round-trip test exists for it
(Constitution VIII: Dataset Schema Parity). As of 2026-07-08 every curator
family in `src/curate/registry.ts` is cataloged.

## Index

One `<family>.md` per curator family (`src/curate/registry.ts`), each citing
its fixture-based round-trip test and its `tests/parity-matrix.json#datasetSchemas`
entry:

| entry | source formats | curated artifact |
|---|---|---|
| [tabular.md](tabular.md) | CSV, TSV, XLSX | `data.ndjson` + tabular `schema.json` |
| [datastore-json.md](datastore-json.md) | egov `getResourceData` envelope (spec 049, `EGOV_DATASTORE_FORMAT` hint) | dispatches to tabular / json / text |
| [json.md](json.md) | JSON, JSONL, NDJSON | `data.json` + json-shape `schema.json` |
| [geojson.md](geojson.md) | GeoJSON | `data.json` + geojson-shape `schema.json` |
| [xml.md](xml.md) | XML | `data.xml` + xml `schema.json` |
| [text.md](text.md) | plain text + sniff fallback | `data.txt` + text `schema.json` |

## Catalog entry layout

Family-level entries are single `<family>.md` files (the table above); each
MUST have a matching `datasetSchemas` row in `tests/parity-matrix.json`
(enforced by `tests/parity-matrix-check.ts`). Dataset-specific entries, when
a single dataset warrants its own schema documentation, use the directory
layout below:

```
specs/dataset-schemas/<dataset-slug>/
├── README.md             # Human-readable description of the dataset
├── schema.json           # Conforms to contracts/curated-tabular-artifact.schema.json
│                         # (or a curated-non-tabular variant when added)
├── fixtures/
│   ├── source.<ext>      # Original byte-faithful sample (small)
│   └── curated.ndjson    # Curated round-trip output for that sample
└── notes.md              # Quirks, encoding history, normalization decisions
```

## Inclusion rule

A dataset enters the catalog **only after**:

1. The crawler has captured at least one resource for it.
2. The curator has produced a curated artifact (i.e. `kind != 'uncurated'`).
3. A round-trip parity test exists under `tests/contract/dataset-parity/`
   that loads `fixtures/source.<ext>`, runs it through the curator, and
   asserts the output equals `fixtures/curated.ndjson` byte-for-byte.

The parity matrix (`tests/parity-matrix.json`) MUST list every catalog entry
with its parity test path; CI fails if an entry has no test.

## Cyrillic preservation

Schema entries that include sample values MUST preserve Cyrillic exactly
(Principle X). Tests assert byte-exact equality; transliteration in fixtures
is forbidden.
