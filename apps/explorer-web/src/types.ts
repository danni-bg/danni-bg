// Frontend view-model types. The API response shapes the SPA renders have a SINGLE definition, owned
// by the API app, imported here type-only (spec 059). `import type` is erased at build, so the web
// build stays decoupled (Vite emits no API-app code) while a field renamed on the API breaks the SPA's
// typecheck instead of silently rendering `undefined`. Only genuinely client-only items are defined
// below. Sources: view models + filter/scope schemas → apps/explorer-api/src/schemas.ts; the chat
// grounding payloads (Citation/MapAnchor) → the leaf apps/explorer-api/src/chat/sse-events.ts.

export type {
  DatasetPointer,
  FilterState,
  FreshnessBlock,
  FreshnessFilter,
  RegionSummary,
  ScopeDescriptor,
} from '../../explorer-api/src/schemas.ts';
// `Facets`/`FacetItem` on the API are what the SPA rendered as `Facets`/`FacetValue` — same shape.
export type { Facets, FacetItem as FacetValue } from '../../explorer-api/src/schemas.ts';
export type { Citation, MapAnchor } from '../../explorer-api/src/chat/sse-events.ts';

// ---- Client-only ----

/** The SPA's read view of a resource's rows/document/text (GET …/resources/:id). A deliberately
 * reduced projection of the API's `ResourceContent` — the SPA never uses `curatedPath` and treats
 * `kind` as an opaque label — so it is defined here rather than shared. */
export interface ResourceContent {
  datasetId: string;
  resourceId: string;
  kind: string | null;
  rows: unknown[];
  document?: unknown;
  text?: string;
  total: number;
  limit: number;
  offset: number;
  truncated: boolean;
  /** True when a sort/filter saw only the first slice of a very large resource. */
  gridTruncated?: boolean;
}

export const EMPTY_FILTERS: import('../../explorer-api/src/schemas.ts').FilterState = {
  tags: [],
  publisherIds: [],
  geoUnitIds: [],
  freshness: 'any',
  query: '',
  includeWithdrawn: false,
};
