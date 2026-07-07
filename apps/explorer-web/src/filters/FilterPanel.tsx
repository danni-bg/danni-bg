import { ChevronDown } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ErrorState } from '../components/StatusMessage.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Input } from '../components/ui/input.tsx';
import { fetchFacets } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { removeChip, setFreshness, toChips, toggleValue } from '../lib/filters.ts';
import { useServerState } from '../lib/useServerState.ts';
import { useExplorer } from '../store/explorerStore.ts';
import type { Facets, FreshnessFilter } from '../types.ts';

const EMPTY_FACETS: Facets = { tags: [], publishers: [], freshnessBuckets: [] };
const FRESHNESS: { value: FreshnessFilter; label: string }[] = [
  { value: 'any', label: 'Всички' },
  { value: 'fresh', label: 'Актуални' },
  { value: 'stale', label: 'Остарели' },
];
const FRESHNESS_LABEL: Record<FreshnessFilter, string> = {
  any: 'Всички',
  fresh: 'актуални',
  stale: 'остарели',
};
const TOP_N = 8;

/** Collapsible facet section (accordion) so a long sidebar stays scannable. */
function FacetSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-t pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        <span>{title}</span>
        <ChevronDown className={cn('size-4 transition-transform', !open && '-rotate-90')} />
      </button>
      {open && <div className="mt-2 space-y-1">{children}</div>}
    </div>
  );
}

interface FilterPanelProps {
  /** Resolve a geo entity id to its Bulgarian label for the active-filter chip (from the map). */
  geoLabel?: (entityId: string) => string;
}

export function FilterPanel({ geoLabel }: FilterPanelProps = {}) {
  const filters = useExplorer((s) => s.filters);
  const updateFilters = useExplorer((s) => s.updateFilters);
  const clearFilters = useExplorer((s) => s.clearFilters);

  const [tagQuery, setTagQuery] = useState('');
  const [showAllTags, setShowAllTags] = useState(false);
  const [showAllPublishers, setShowAllPublishers] = useState(false);
  const [open, setOpen] = useState({ freshness: true, tags: true, publishers: false });

  // Available facets reflect the current filters (counts narrow as you refine — conjunctive faceting).
  const facetsQuery = useServerState(`facets:${JSON.stringify(filters)}`, () =>
    fetchFacets(filters),
  );
  // Keep the last-good facets shape for rendering; a failure is surfaced separately (FR-403) rather
  // than collapsing into an empty panel indistinguishable from a genuinely empty result.
  const facets: Facets = facetsQuery.data ?? EMPTY_FACETS;

  const chips = toChips(filters);
  const chipLabel = (chip: ReturnType<typeof toChips>[number]): string => {
    if (chip.kind === 'publisher')
      return `издател: ${facets.publishers.find((p) => p.id === chip.value)?.labelBg ?? chip.value}`;
    if (chip.kind === 'freshness')
      return `актуалност: ${FRESHNESS_LABEL[chip.value as FreshnessFilter]}`;
    if (chip.kind === 'geo') return `регион: ${geoLabel?.(chip.value) ?? chip.value}`;
    return chip.label;
  };

  const freshCount = (id: string) => facets.freshnessBuckets.find((b) => b.id === id)?.count;
  const tagMatches = facets.tags.filter((t) =>
    t.labelBg.toLowerCase().includes(tagQuery.trim().toLowerCase()),
  );
  const tagsShown = showAllTags ? tagMatches : tagMatches.slice(0, TOP_N);
  const pubsShown = showAllPublishers ? facets.publishers : facets.publishers.slice(0, TOP_N);

  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Филтри
      </h2>
      {facetsQuery.status === 'error' && (
        <ErrorState message="Неуспешно зареждане на филтрите." onRetry={facetsQuery.refetch} />
      )}
      {chips.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Активни</span>
            <button
              type="button"
              onClick={() => clearFilters()}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Изчисти всички
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {chips.map((chip) => (
              <Badge key={`${chip.kind}:${chip.value}`}>
                {chipLabel(chip)}
                <button
                  type="button"
                  aria-label={`Премахни ${chipLabel(chip)}`}
                  className="ml-0.5 flex size-4 items-center justify-center rounded-full bg-primary/15 leading-none hover:bg-primary/25"
                  onClick={() => updateFilters((f) => removeChip(f, chip))}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        </div>
      )}

      <FacetSection
        title="Актуалност"
        open={open.freshness}
        onToggle={() => setOpen((o) => ({ ...o, freshness: !o.freshness }))}
      >
        <div className="flex gap-1" aria-label="Актуалност">
          {FRESHNESS.map(({ value, label }) => {
            const n = freshCount(value);
            return (
              <button
                key={value}
                type="button"
                aria-pressed={filters.freshness === value}
                onClick={() => updateFilters((f) => setFreshness(f, value))}
                className={cn(
                  'flex-1 rounded-md border px-2 py-1 text-xs',
                  filters.freshness === value
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-accent',
                )}
              >
                {label}
                {value !== 'any' && n !== undefined ? ` (${n})` : ''}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 rounded border-input accent-primary"
            checked={filters.includeWithdrawn}
            onChange={(e) => updateFilters((f) => ({ ...f, includeWithdrawn: e.target.checked }))}
          />
          Включи оттеглени набори
        </label>
      </FacetSection>

      {facets.tags.length > 0 && (
        <FacetSection
          title="Тагове"
          open={open.tags}
          onToggle={() => setOpen((o) => ({ ...o, tags: !o.tags }))}
        >
          {facets.tags.length > TOP_N && (
            <Input
              aria-label="Търси таг"
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
              placeholder="намери таг…"
              className="mb-1 h-7 rounded px-2 text-xs focus-visible:ring-1"
            />
          )}
          {tagsShown.map((t) => (
            <label
              key={t.id}
              className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent/50"
            >
              <span className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 rounded border-input accent-primary"
                  checked={filters.tags.includes(t.labelBg)}
                  onChange={() => updateFilters((f) => toggleValue(f, 'tags', t.labelBg))}
                />
                <span className="truncate">{t.labelBg}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t.count}</span>
            </label>
          ))}
          {tagMatches.length > TOP_N && (
            <button
              type="button"
              onClick={() => setShowAllTags((v) => !v)}
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              {showAllTags ? 'Покажи по-малко' : `Покажи още ${tagMatches.length - TOP_N}`}
            </button>
          )}
        </FacetSection>
      )}

      {facets.publishers.length > 0 && (
        <FacetSection
          title="Издатели"
          open={open.publishers}
          onToggle={() => setOpen((o) => ({ ...o, publishers: !o.publishers }))}
        >
          {pubsShown.map((p) => (
            <label
              key={p.id}
              className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent/50"
            >
              <span className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 rounded border-input accent-primary"
                  checked={filters.publisherIds.includes(p.id)}
                  onChange={() => updateFilters((f) => toggleValue(f, 'publisherIds', p.id))}
                />
                <span className="truncate" title={p.labelBg}>
                  {p.labelBg}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{p.count}</span>
            </label>
          ))}
          {facets.publishers.length > TOP_N && (
            <button
              type="button"
              onClick={() => setShowAllPublishers((v) => !v)}
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              {showAllPublishers
                ? 'Покажи по-малко'
                : `Покажи още ${facets.publishers.length - TOP_N}`}
            </button>
          )}
        </FacetSection>
      )}
    </section>
  );
}
