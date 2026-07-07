import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import municipalitiesRaw from '../../../packages/geo-boundaries/data/municipalities.geojson?raw';
import oblastsRaw from '../../../packages/geo-boundaries/data/oblasts.geojson?raw';
import { AuthWidget } from './auth/AuthWidget.tsx';
import { ChatPanel } from './chat/ChatPanel.tsx';
import { ErrorState } from './components/StatusMessage.tsx';
import { Button } from './components/ui/button.tsx';
import { DatasetDetail } from './datasets/DatasetDetail.tsx';
import { DatasetList } from './datasets/DatasetList.tsx';
import { ResourceReader } from './datasets/ResourceReader.tsx';
import { FilterPanel } from './filters/FilterPanel.tsx';
import { SearchBar } from './filters/SearchBar.tsx';
import { fetchDatasets, fetchNational, fetchRegions } from './lib/api.ts';
import type { BoundaryCollection } from './lib/choropleth.ts';
import { hasMore, mergePage } from './lib/pagination.ts';
import { type Theme, applyResolvedTheme, loadTheme, resolveTheme } from './lib/theme.ts';
import { useServerState } from './lib/useServerState.ts';
import { MapErrorBoundary } from './map/MapErrorBoundary.tsx';
import { MapView } from './map/MapView.tsx';
import { useExplorer } from './store/explorerStore.ts';
import type { DatasetPointer, FilterState } from './types.ts';

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setDark(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return dark;
}

export function App() {
  const filters = useExplorer((s) => s.filters);
  const highlight = useExplorer((s) => s.highlight);
  const selectRegions = useExplorer((s) => s.selectRegions);

  // The theme is chosen in user settings (Облик); here we only apply the saved preference (re-read on
  // mount, so returning from settings reflects a change) and keep it live with the OS in `system` mode.
  const [theme] = useState<Theme>(() => loadTheme(localStorage));
  const prefersDark = usePrefersDark();
  const resolved = resolveTheme(theme, prefersDark);
  useEffect(() => {
    applyResolvedTheme(document.documentElement, resolved);
  }, [resolved]);

  const [selectedDataset, setSelectedDataset] = useState<string | null>(null);
  const [showNational, setShowNational] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const boundaries = useMemo(() => JSON.parse(oblastsRaw) as BoundaryCollection, []);
  const muniBoundaries = useMemo(() => JSON.parse(municipalitiesRaw) as BoundaryCollection, []);
  const PAGE = 50;
  const loader = showNational ? fetchNational : fetchDatasets;

  // The choropleth aggregates ignore the map's own region selection (geoUnitIds): selecting or
  // drilling into a region must NOT re-scope the map itself (that re-scoping made the municipality
  // layer go stale/empty for a click). Selection scopes only the dataset list + chat. Memoized on
  // the non-geo filter fields — whose array refs selectRegion preserves — so selecting a region
  // leaves regionFilters identity unchanged and the layers are not refetched.
  const { tags, publisherIds, freshness, query, includeWithdrawn } = filters;
  const regionFilters = useMemo<FilterState>(
    () => ({ tags, publisherIds, freshness, query, includeWithdrawn, geoUnitIds: [] }),
    [tags, publisherIds, freshness, query, includeWithdrawn],
  );

  // Region choropleth layers (oblast + municipality drill-down), selection-independent. Each layer is
  // a keyed query; a failure surfaces a retry affordance instead of silently rendering an empty map.
  const regionKey = JSON.stringify(regionFilters);
  const oblastQuery = useServerState(`regions:oblast:${regionKey}`, () =>
    fetchRegions(regionFilters, 'oblast'),
  );
  const muniQuery = useServerState(`regions:municipality:${regionKey}`, () =>
    fetchRegions(regionFilters, 'municipality'),
  );
  const regions = oblastQuery.data?.regions ?? [];
  const muniRegions = muniQuery.data?.regions ?? [];
  const regionsError = oblastQuery.status === 'error' || muniQuery.status === 'error';
  const retryRegions = () => {
    oblastQuery.refetch();
    muniQuery.refetch();
  };
  const geoLabel = useMemo(() => {
    const m = new Map(
      regions.filter((r) => r.entityId).map((r) => [r.entityId as string, r.labelBg]),
    );
    return (id: string) => m.get(id) ?? id;
  }, [regions]);

  // Dataset list — honors the full filters, including the region selection. Page 0 is owned by the
  // query hook; further pages ("load more") accumulate in `more` and reset when the base query changes.
  const datasetsKey = JSON.stringify({ filters, national: showNational });
  const datasetsQuery = useServerState(datasetsKey, () => loader(filters, PAGE, 0));
  const [more, setMore] = useState<DatasetPointer[]>([]);
  const [moreError, setMoreError] = useState(false);
  useEffect(() => {
    setMore([]);
    setMoreError(false);
  }, [datasetsKey]);

  const basePage = datasetsQuery.data?.datasets ?? [];
  const datasets = more.length ? mergePage(basePage, more) : basePage;
  const total = datasetsQuery.data?.total ?? 0;
  const loading = datasetsQuery.loading;

  async function loadMore() {
    try {
      const r = await loader(filters, PAGE, datasets.length);
      setMore((prev) => mergePage(mergePage(basePage, prev), r.datasets).slice(basePage.length));
      setMoreError(false);
    } catch {
      setMoreError(true);
    }
  }

  return (
    <div className="grid h-screen grid-rows-[auto_1fr]">
      <header className="flex items-center gap-3 bg-primary px-5 py-2 text-primary-foreground">
        <h1 className="text-base font-semibold tracking-tight">danni.bg</h1>
        <span className="text-xs opacity-80">
          Интерактивна карта на отворените данни на България
        </span>
        <div className="ml-auto flex items-center gap-4">
          <a
            href="https://github.com/feedback-loop-ai/danni-bg"
            target="_blank"
            rel="noreferrer noopener"
            title="GitHub"
            className="flex h-8 w-8 items-center justify-center text-primary-foreground/80 transition hover:text-primary-foreground"
          >
            <svg className="h-7 w-7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            <span className="sr-only">GitHub</span>
          </a>
          <AuthWidget />
        </div>
      </header>
      <div className="flex min-h-0">
        <aside
          className="shrink-0 overflow-hidden border-r bg-card transition-[width] duration-200 ease-in-out"
          style={{ width: leftOpen ? 340 : 0 }}
        >
          <div className="h-full w-[340px] space-y-3 overflow-y-auto p-4">
            <SearchBar loading={loading} />
            <FilterPanel geoLabel={geoLabel} />
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              aria-pressed={showNational}
              onClick={() => setShowNational((v) => !v)}
            >
              {showNational ? '← Към регионите' : 'Национални набори (без регион)'}
            </Button>
            {selectedDataset ? (
              <DatasetDetail datasetId={selectedDataset} onClose={() => setSelectedDataset(null)} />
            ) : datasetsQuery.status === 'error' ? (
              <ErrorState
                message="Неуспешно зареждане на наборите от данни."
                onRetry={datasetsQuery.refetch}
              />
            ) : (
              <>
                <DatasetList
                  datasets={datasets}
                  total={total}
                  hasMore={hasMore(datasets.length, total)}
                  onSelect={setSelectedDataset}
                  onLoadMore={loadMore}
                />
                {moreError && (
                  <ErrorState message="Неуспешно зареждане на още набори." onRetry={loadMore} />
                )}
              </>
            )}
          </div>
        </aside>
        <main className="relative min-w-0 flex-1">
          <button
            type="button"
            aria-label={leftOpen ? 'Скрий филтрите' : 'Покажи филтрите'}
            onClick={() => setLeftOpen((v) => !v)}
            className="-translate-y-1/2 absolute top-1/2 left-2 z-10 flex h-12 w-6 items-center justify-center rounded-md border bg-card/90 text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-accent-foreground"
          >
            {leftOpen ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
          <button
            type="button"
            aria-label={rightOpen ? 'Скрий чата' : 'Покажи чата'}
            onClick={() => setRightOpen((v) => !v)}
            className="-translate-y-1/2 absolute top-1/2 right-2 z-10 flex h-12 w-6 items-center justify-center rounded-md border bg-card/90 text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-accent-foreground"
          >
            {rightOpen ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
          </button>
          <MapErrorBoundary>
            <MapView
              boundaries={boundaries}
              regions={regions}
              municipalities={muniBoundaries}
              municipalityRegions={muniRegions}
              highlightGeoIds={highlight.geoEntityIds}
              selectedGeoIds={filters.geoUnitIds}
              onSelect={selectRegions}
              isDark={resolved === 'dark'}
            />
          </MapErrorBoundary>
          {regionsError && (
            <div className="-translate-x-1/2 absolute top-3 left-1/2 z-10 rounded-md border bg-card/95 px-3 py-2 shadow-md backdrop-blur">
              <ErrorState message="Неуспешно зареждане на картата." onRetry={retryRegions} />
            </div>
          )}
          {/* Centre document reader — overlays the map when a resource is opened. */}
          <ResourceReader />
        </main>
        <aside
          className="shrink-0 overflow-hidden border-l bg-card transition-[width] duration-200 ease-in-out"
          style={{ width: rightOpen ? 380 : 0 }}
        >
          <div className="h-full w-[380px] p-4">
            <ChatPanel onSelectDataset={setSelectedDataset} />
          </div>
        </aside>
      </div>
    </div>
  );
}
