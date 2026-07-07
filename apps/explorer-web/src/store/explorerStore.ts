// Shared explorer state (T017): the single FilterState plus map selection and the chat/map highlight
// anchor. Map selection and geoUnit filters are kept mutually consistent (FR-009/FR-014); clearing
// filters expands the chat scope back to the full mirror (FR-028). Built on zustand/vanilla so the
// state logic is unit-testable without React; components subscribe via the useExplorer hook.

import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { EMPTY_FILTERS, type FilterState, type MapAnchor } from '../types.ts';
import { clearAll } from '../lib/filters.ts';

/** A single dataset the chat is focused on ("ask about this dataset"); scopes chat retrieval to it. */
export interface ChatFocus {
  datasetId: string;
  titleBg: string;
}

/** The resource opened in the centre document reader (replaces the map while set). */
export interface ReaderTarget {
  datasetId: string;
  resourceId: string;
  name: string;
  /** Parent dataset title, shown as the reader's breadcrumb. */
  titleBg: string;
}

export interface ExplorerState {
  filters: FilterState;
  highlight: MapAnchor;
  chatFocus: ChatFocus | null;
  reader: ReaderTarget | null;
  /** The dataset whose detail is open in the sidebar (null = the list). Beside reader/chatFocus so a
   * chat citation opens it via a store action instead of a prop callback chain (FR-430). */
  selectedDataset: string | null;
  setFilters: (f: FilterState) => void;
  updateFilters: (fn: (f: FilterState) => FilterState) => void;
  clearFilters: () => void;
  /**
   * Set the map's selected regions. The selection IS `filters.geoUnitIds` (single source of
   * truth — map highlight and filter chips stay consistent). The map computes the next set
   * (shift-click = additive union; plain click = replace; drilling refines to municipalities);
   * pass `[]` to clear.
   */
  selectRegions: (entityIds: string[]) => void;
  setHighlight: (anchor: MapAnchor) => void;
  setChatFocus: (focus: ChatFocus | null) => void;
  openReader: (target: ReaderTarget) => void;
  closeReader: () => void;
  /** Open a dataset's detail in the sidebar (e.g. from a list row or a chat citation). */
  openDataset: (datasetId: string) => void;
  /** Return the sidebar to the dataset list. */
  closeDataset: () => void;
}

const NO_HIGHLIGHT: MapAnchor = { geoEntityIds: [], datasetIds: [] };

export const explorerStore = createStore<ExplorerState>((set) => ({
  filters: { ...EMPTY_FILTERS },
  highlight: NO_HIGHLIGHT,
  chatFocus: null,
  reader: null,
  selectedDataset: null,
  setFilters: (filters) => set({ filters }),
  updateFilters: (fn) => set((s) => ({ filters: fn(s.filters) })),
  clearFilters: () => set({ filters: clearAll(), highlight: NO_HIGHLIGHT }),
  // Region selection constrains the geo filter so map and lists stay consistent (FR-009).
  // Only geoUnitIds changes — the other filter arrays keep their refs so the choropleth layers
  // (memoized on those refs in App.tsx) are not refetched on selection.
  selectRegions: (entityIds) =>
    set((s) => ({ filters: { ...s.filters, geoUnitIds: entityIds } })),
  setHighlight: (highlight) => set({ highlight }),
  setChatFocus: (chatFocus) => set({ chatFocus }),
  openReader: (reader) => set({ reader }),
  closeReader: () => set({ reader: null }),
  openDataset: (selectedDataset) => set({ selectedDataset }),
  closeDataset: () => set({ selectedDataset: null }),
}));

export function useExplorer<T>(selector: (s: ExplorerState) => T): T {
  return useStore(explorerStore, selector);
}
