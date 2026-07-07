import { Button } from '../components/ui/button.tsx';
import { cn } from '../lib/cn.ts';
import { freshnessDisplay } from '../lib/format.ts';
import type { DatasetPointer } from '../types.ts';

interface DatasetListProps {
  datasets: DatasetPointer[];
  total?: number;
  hasMore?: boolean;
  onSelect: (datasetId: string) => void;
  onLoadMore?: () => void;
}

export function DatasetList({ datasets, total, hasMore, onSelect, onLoadMore }: DatasetListProps) {
  if (datasets.length === 0) {
    return <p className="text-sm text-muted-foreground">Няма набори от данни за текущия изглед.</p>;
  }
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Набори от данни ({datasets.length}
        {total !== undefined && total > datasets.length ? ` от ${total}` : ''})
      </h2>
      <ul className="space-y-2">
        {datasets.map((d) => {
          const fresh = freshnessDisplay(d.freshness);
          return (
            <li key={d.datasetId}>
              <button
                type="button"
                onClick={() => onSelect(d.datasetId)}
                className="w-full rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary hover:bg-accent/40"
              >
                <strong className="block font-medium leading-snug">{d.titleBg}</strong>
                <small className="text-muted-foreground">
                  {d.publisher?.titleBg ?? 'без издател'} ·{' '}
                  <span className={cn(fresh.isStale && 'text-warning')}>{fresh.label}</span>
                </small>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && onLoadMore && (
        <Button variant="outline" size="sm" className="w-full" onClick={onLoadMore}>
          Зареди още
        </Button>
      )}
    </section>
  );
}
