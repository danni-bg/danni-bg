// The four grounding tools given to the model (T045). Each is a 1:1 server-side wrapper over the
// in-process read API (per contracts/chat-tools.md), and each applies the request scope so the model
// can only retrieve in-scope datasets (FR-025). Every dataset id a tool returns is recorded in
// `citedDatasetIds` so grounding can validate citations afterwards.

import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { CuratedDatasetView } from '../../../../src/read/dataset-view.ts';
import type { ReadBridge } from '../read-bridge.ts';
import { viewToDetail, viewToPointer } from '../read-bridge.ts';
import type { ScopeDescriptor } from '../schemas.ts';
import { capDatasetDetail, capResourceContent } from './cap.ts';
import { inScope } from './scope.ts';

export interface BuildToolsResult {
  tools: ToolSet;
  citedDatasetIds: Set<string>;
}

// Under a geo-scope, global ranked search rarely puts a small region's datasets in the top-10, so a
// scope filter applied AFTER ranking starves retrieval (FR-100). Over-fetch the ranking, then backfill
// straight from the region's datasets so a tight scope can't return empty when the region has data.
// Shared with the RAG fallback path (run.ts).
export const GEO_SCOPED_SEARCH_LIMIT = 200;

// The chat tool payload is a deliberate MINIMAL projection over the shared `viewToPointer`
// (read-bridge.ts) — only the fields the model needs, keeping the per-result payload small for
// context-size reasons (FR-376). Derived from `viewToPointer` so a pointer-shape change lands in
// exactly one mapper; the `translationConfidence`/`tags`/`geoEntityIds` it also computes are dropped
// here on purpose.
function pointer(view: CuratedDatasetView, score: number | null) {
  const { datasetId, titleBg, titleEn, publisher, sourceUrl, freshness } = viewToPointer(
    view,
    score,
  );
  return { datasetId, titleBg, titleEn, publisher, sourceUrl, freshness, score };
}

export function buildTools(bridge: ReadBridge, scope: ScopeDescriptor): BuildToolsResult {
  const citedDatasetIds = new Set<string>();
  const within = (v: CuratedDatasetView) => inScope(v, scope);

  const resolveScoped = (id: string): CuratedDatasetView | null => {
    let view: CuratedDatasetView;
    try {
      view = bridge.view(id);
    } catch {
      return null;
    }
    return within(view) ? view : null;
  };

  const tools: ToolSet = {
    mirrorSearch: tool({
      description:
        'Hybrid keyword + semantic search over the curated mirror. Returns in-scope datasets.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ query, limit }) => {
        const want = limit ?? 10;
        const geoScoped = (scope.geoUnitIds?.length ?? 0) > 0;
        const results: ReturnType<typeof pointer>[] = [];
        const seen = new Set<string>();
        const take = (view: CuratedDatasetView | null, score: number | null): boolean => {
          if (!view || seen.has(view.datasetId)) return false;
          seen.add(view.datasetId);
          citedDatasetIds.add(view.datasetId);
          results.push(pointer(view, score));
          return true;
        };
        // Over-fetch under a geo-scope so in-region datasets that rank lower globally still surface.
        const hits = await bridge.search(query, geoScoped ? GEO_SCOPED_SEARCH_LIMIT : want);
        for (const hit of hits) {
          if (results.length >= want) break;
          take(resolveScoped(hit.datasetId), hit.score);
        }
        // Still short under a geo-scope? Backfill straight from the region's datasets (the scope's
        // geoUnitIds are already rolled up to oblast + municipalities) so a tight scope never starves.
        if (geoScoped && results.length < want) {
          for (const geoId of scope.geoUnitIds ?? []) {
            if (results.length >= want) break;
            for (const hit of await bridge.entityDatasets(geoId, want)) {
              if (results.length >= want) break;
              take(resolveScoped(hit.datasetId), hit.score);
            }
          }
        }
        return { results };
      },
    }),

    mirrorEntitySearch: tool({
      description: 'Find in-scope datasets linked to an entity id (geo/org/tag/time).',
      inputSchema: z.object({
        entityId: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ entityId, limit }) => {
        const hits = await bridge.entityDatasets(entityId, limit ?? 50);
        const results = [];
        for (const hit of hits) {
          const view = resolveScoped(hit.datasetId);
          if (!view) continue;
          citedDatasetIds.add(view.datasetId);
          results.push(pointer(view, hit.score));
        }
        return { entityId, results };
      },
    }),

    mirrorInfo: tool({
      description:
        'The full curated record for one datasetId (returns outOfScope when not in scope).',
      inputSchema: z.object({ datasetId: z.string().min(1) }),
      execute: async ({ datasetId }) => {
        const view = resolveScoped(datasetId);
        if (!view) return { outOfScope: true, datasetId };
        citedDatasetIds.add(view.datasetId);
        // Cap related-dataset links/entities so a high-degree dataset can't overflow the context.
        return capDatasetDetail(viewToDetail(view));
      },
    }),

    readResource: tool({
      description:
        'Read rows (or a document) of a resource within an in-scope dataset. To answer a question ' +
        'about specific values (e.g. "kindergartens in район Панчарево"), pass `filters` — a map of ' +
        'EXACT column name → case-insensitive substring, e.g. {"rayon":"Панчарево"}. Filtering scans ' +
        'the whole resource (up to a cap) and returns ONLY matching rows, so prefer it over paging. ' +
        'Column names are listed in the dataset context block and in mirrorInfo.',
      inputSchema: z.object({
        datasetId: z.string().min(1),
        resourceId: z.string().min(1),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
        filters: z.record(z.string(), z.string()).optional(),
      }),
      execute: async ({ datasetId, resourceId, limit, offset, filters }) => {
        const view = resolveScoped(datasetId);
        if (!view) return { outOfScope: true, datasetId };
        citedDatasetIds.add(view.datasetId);
        const grid =
          filters && Object.keys(filters).length > 0 ? { sort: null, filters } : undefined;
        // Cap the payload so a large artifact can't overflow the model's context window.
        return capResourceContent(bridge.rows(datasetId, resourceId, limit, offset, grid));
      },
    }),
  };

  return { tools, citedDatasetIds };
}
