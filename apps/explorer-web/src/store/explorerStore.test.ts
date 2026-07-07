import { beforeEach, describe, expect, it } from 'bun:test';
import { EMPTY_FILTERS } from '../types.ts';
import { explorerStore } from './explorerStore.ts';

describe('explorerStore', () => {
  beforeEach(() => {
    explorerStore.setState({
      filters: { ...EMPTY_FILTERS },
      highlight: { geoEntityIds: [], datasetIds: [] },
      chatFocus: null,
      reader: null,
      selectedDataset: null,
    });
  });

  it('opens and closes a dataset selection (FR-430 — replaces the App-local prop drill)', () => {
    const s = explorerStore.getState();
    expect(s.selectedDataset).toBeNull();
    // A list row OR a chat citation calls the same store action instead of an onSelectDataset prop.
    s.openDataset('d1');
    expect(explorerStore.getState().selectedDataset).toBe('d1');
    s.openDataset('d2');
    expect(explorerStore.getState().selectedDataset).toBe('d2');
    s.closeDataset();
    expect(explorerStore.getState().selectedDataset).toBeNull();
  });

  it('dataset selection is independent of the reader/chatFocus siblings', () => {
    const s = explorerStore.getState();
    s.openReader({ datasetId: 'd1', resourceId: 'r1', name: 'r', titleBg: 'T' });
    s.setChatFocus({ datasetId: 'd1', titleBg: 'T' });
    s.openDataset('d1');
    // Opening a dataset does not disturb the reader or the chat focus (behaviour preserved).
    expect(explorerStore.getState().reader?.resourceId).toBe('r1');
    expect(explorerStore.getState().chatFocus?.datasetId).toBe('d1');
    s.closeDataset();
    expect(explorerStore.getState().reader?.resourceId).toBe('r1');
    expect(explorerStore.getState().chatFocus?.datasetId).toBe('d1');
  });

  it('sets and clears the chat focus', () => {
    explorerStore.getState().setChatFocus({ datasetId: 'd1', titleBg: 'Качество' });
    expect(explorerStore.getState().chatFocus).toEqual({ datasetId: 'd1', titleBg: 'Качество' });
    explorerStore.getState().setChatFocus(null);
    expect(explorerStore.getState().chatFocus).toBeNull();
  });

  it('updateFilters applies an immutable transform', () => {
    explorerStore.getState().updateFilters((f) => ({ ...f, tags: ['въздух'] }));
    expect(explorerStore.getState().filters.tags).toEqual(['въздух']);
  });

  it('selectRegions syncs the geo filter (FR-009) and clears on []', () => {
    explorerStore.getState().selectRegions(['geo:bg-oblast-ruse']);
    expect(explorerStore.getState().filters.geoUnitIds).toEqual(['geo:bg-oblast-ruse']);
    explorerStore.getState().selectRegions([]);
    expect(explorerStore.getState().filters.geoUnitIds).toEqual([]);
  });

  it('selectRegions sets a multi-region union (geoUnitIds is OR-matched downstream)', () => {
    explorerStore.getState().selectRegions(['geo:bg-oblast-ruse', 'geo:bg-oblast-varna']);
    expect(explorerStore.getState().filters.geoUnitIds).toEqual([
      'geo:bg-oblast-ruse',
      'geo:bg-oblast-varna',
    ]);
  });

  it('setHighlight stores the anchor; clearFilters resets filters + highlight (FR-028)', () => {
    explorerStore.getState().setHighlight({ geoEntityIds: ['geo:bg-oblast-ruse'], datasetIds: ['d1'] });
    expect(explorerStore.getState().highlight.datasetIds).toEqual(['d1']);
    explorerStore.getState().updateFilters((f) => ({ ...f, tags: ['x'] }));
    explorerStore.getState().clearFilters();
    expect(explorerStore.getState().filters).toEqual(EMPTY_FILTERS);
    expect(explorerStore.getState().highlight.geoEntityIds).toEqual([]);
  });

  it('setFilters replaces the whole filter object', () => {
    explorerStore.getState().setFilters({ ...EMPTY_FILTERS, freshness: 'stale' });
    expect(explorerStore.getState().filters.freshness).toBe('stale');
  });
});
