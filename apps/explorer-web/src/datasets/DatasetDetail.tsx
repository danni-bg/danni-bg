import { ErrorState } from '../components/StatusMessage.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { fetchDataset } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { bilingualLabel, freshnessDisplay } from '../lib/format.ts';
import { useServerState } from '../lib/useServerState.ts';
import { useExplorer } from '../store/explorerStore.ts';

interface DatasetDetailProps {
  datasetId: string;
  onClose: () => void;
}

export function DatasetDetail({ datasetId, onClose }: DatasetDetailProps) {
  const {
    data: detail,
    status,
    refetch,
  } = useServerState(datasetId, () => fetchDataset(datasetId));
  const setChatFocus = useExplorer((s) => s.setChatFocus);
  const openReader = useExplorer((s) => s.openReader);
  const reader = useExplorer((s) => s.reader);

  return (
    <section className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onClose}>
        ← обратно
      </Button>
      {status === 'error' && (
        <ErrorState message="Грешка при зареждане на набора." onRetry={refetch} />
      )}
      {detail && (
        <Card className="space-y-2 p-4">
          <h2 className="font-semibold leading-snug">
            {bilingualLabel(detail.titleBg, detail.titleEn, 'bg')}
          </h2>
          <p className="text-sm text-muted-foreground">{detail.descriptionBg}</p>
          <p className="text-sm">
            <span className={cn(freshnessDisplay(detail.freshness).isStale && 'text-warning')}>
              {freshnessDisplay(detail.freshness).label}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">Тагове: {detail.tags.join(', ') || '—'}</p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setChatFocus({ datasetId: detail.datasetId, titleBg: detail.titleBg })}
          >
            Питай чата за този набор
          </Button>
          <h3 className="pt-1 text-sm font-semibold">Ресурси</h3>
          <ul className="space-y-1">
            {detail.resources.map((r) => {
              const label = r.name ?? r.resourceId;
              return (
                <li key={r.resourceId}>
                  <button
                    type="button"
                    onClick={() =>
                      openReader({
                        datasetId,
                        resourceId: r.resourceId,
                        name: label,
                        titleBg: detail.titleBg,
                      })
                    }
                    className={cn(
                      'w-full rounded-md border px-2 py-1.5 text-left text-sm transition-colors hover:border-primary hover:bg-accent/40',
                      reader?.datasetId === datasetId &&
                        reader?.resourceId === r.resourceId &&
                        'border-primary bg-accent/40',
                    )}
                  >
                    {label}{' '}
                    <span className="text-xs text-muted-foreground">
                      ({r.kind ?? 'неизвестен'})
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <a
            className="inline-block text-sm text-primary underline-offset-4 hover:underline"
            href={detail.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Източник: data.egov.bg ↗
          </a>
        </Card>
      )}
    </section>
  );
}
