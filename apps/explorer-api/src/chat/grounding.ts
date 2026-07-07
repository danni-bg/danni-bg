// Grounding & citation logic (T047). The chat answers strictly from tool results; the backend then
// validates every dataset the model relied on: it MUST exist in the mirror (existence validation,
// SC-005) and MUST be within the request scope (scope validation, SC-008). Surviving datasets become
// Citations; their geo entities become a MapAnchor for the frontend to highlight/focus
// (FR-026/FR-027). All logic here is pure and unit-tested against fixtures.

import type { CuratedDatasetView } from '../../../../src/read/dataset-view.ts';
import { geoEntityIdsOf } from '../read-bridge.ts';
// Citation & MapAnchor are owned by the leaf SSE-events module (single source, shared with the SPA —
// spec 059 FR-420). Re-exported here so existing `from './grounding.ts'` imports keep working.
export type { Citation, MapAnchor } from './sse-events.ts';
import type { Citation, MapAnchor } from './sse-events.ts';

export const SYSTEM_PROMPT = [
  'You are the danni-bg open-data assistant for Bulgaria.',
  'Answer ONLY from the results of the provided tools (mirrorSearch, mirrorEntitySearch, mirrorInfo, readResource)',
  'and from any dataset rows/documents given to you under a "ДАННИ" / "DATA" context block below.',
  'NEVER invent or guess datasets, row values, names, codes (e.g. ЕИК/EIK), numbers, publishers, or source URLs.',
  'State a specific value ONLY if it appears verbatim in a tool result or the provided context; otherwise say you',
  'cannot see it. Do NOT fabricate data to agree with the user — if you have not actually read the rows, say so and',
  'read them (readResource) rather than describing their contents from the title.',
  'If the tools/context return nothing relevant, reply exactly that no relevant public data was found.',
  'When LISTING or ENUMERATING (e.g. "what datasets/registers/data exist for X"), the tool results are',
  'the COMPLETE and CLOSED set: list ONLY datasets that appear in them. Do NOT add, infer, or "round out"',
  'the list with datasets, publishers, municipalities, regions, or institutions you know of from prior',
  'knowledge but did NOT retrieve — every named entity in your answer must come from a tool result. If',
  'the results seem partial, say so plainly instead of filling the gaps from memory.',
  'When a question spans several datasets (e.g. comparing periods or regions), call readResource on',
  'EACH relevant dataset to extract the actual figures before answering — do not summarize from titles',
  'alone or stop after the first one. If you genuinely cannot read a value, say so rather than implying it.',
  'Cite the specific datasets you used — by their Bulgarian title, in prose. Do NOT print dataset ids,',
  'UUIDs, or other technical identifiers in the answer (no "datasetId" columns, no "(id: …)"): the',
  'interface already links every cited dataset for the user, so raw ids are noise, not actionable',
  'information. Identifiers are for your tool calls only, never for the reader.',
  'Surface data freshness, and flag values that are coded or',
  'machine-translated so the user does not over-trust them.',
  'Authoritative Bulgarian fields are shown verbatim; never translate or rewrite them.',
].join(' ');

// Appended only when the turn carries a geo-scope. The tools already restrict results to the selected
// region, but a model asked to "list" tends to pad the answer from its priors with well-known
// out-of-region institutions (e.g. Столична община, Община Пловдив) that aren't in the grounding.
// This hard-stops that cross-region fabrication (spec 023, FR-101).
export const GEO_SCOPE_NOTE = [
  'A geographic filter is active for this turn: the tools return ONLY datasets within the selected',
  'region. List and describe ONLY datasets that appear in the tool results / context. Do NOT add',
  'datasets, publishers, or institutions from any other region (other oblasti or municipalities),',
  'even if you know they exist — they are out of scope. If the in-scope results are few, say exactly',
  'that; never supplement from outside the region.',
].join(' ');

export const NO_DATA_REPLY = 'No relevant public data was found in the mirror for this question.';

/**
 * Validate the dataset ids the model relied on (from tool results) and build citations:
 * drop ids that do not resolve (hallucinated) or fall outside scope. Deterministic + deduped.
 */
export function buildCitations(
  datasetIds: Iterable<string>,
  resolve: (id: string) => CuratedDatasetView | null,
  inScope: (view: CuratedDatasetView) => boolean,
): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const id of datasetIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const view = resolve(id);
    if (!view || !inScope(view)) continue;
    out.push({
      datasetId: view.datasetId,
      titleBg: view.title.bg,
      sourceUrl: view.sourceUrl,
      freshness: view.freshness,
    });
  }
  return out;
}

/** The oblast an entity id belongs to: an oblast id is itself; a municipality maps via the part_of
 * graph; anything else has no oblast. */
function oblastOf(geoId: string, parentOf: Map<string, string>): string | undefined {
  if (geoId.startsWith('geo:bg-oblast-')) return geoId;
  if (geoId.startsWith('geo:bg-municipality-')) return parentOf.get(geoId);
  return undefined;
}

/**
 * Aggregate the cited datasets' geo into a single map anchor, rolled up to **oblast** level so the
 * chat-driven map selection matches a manual oblast pick (spec 023, FR-107/FR-108). A cited dataset
 * contributes its oblast ONLY if it is about a single oblast (after mapping municipalities up via
 * `parentOf`); a dataset spanning multiple oblasti is cross-region context, not a regional focus, and
 * is excluded — otherwise an NSI "by oblast" massive (all 28) or a multi-region thematic dataset would
 * balloon the selection beyond the region the user asked about.
 */
export function buildAnchors(
  citations: Citation[],
  resolve: (id: string) => CuratedDatasetView | null,
  parentOf: Map<string, string> = new Map(),
): MapAnchor {
  const geo = new Set<string>();
  for (const c of citations) {
    const view = resolve(c.datasetId);
    if (!view) continue;
    const oblasti = new Set<string>();
    for (const g of geoEntityIdsOf(view)) {
      const o = oblastOf(g, parentOf);
      if (o) oblasti.add(o);
    }
    // Single-oblast datasets define the focus; multi-oblast (cross-region) ones don't.
    if (oblasti.size === 1) for (const o of oblasti) geo.add(o);
  }
  return { geoEntityIds: [...geo], datasetIds: citations.map((c) => c.datasetId) };
}
