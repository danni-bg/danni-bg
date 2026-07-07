// Per-user token-usage section for the settings page (token metering). Shows the caller's own usage
// against their effective quota with a small progress bar.

import { ErrorState, Loading } from '../components/StatusMessage.tsx';
import { formatNumber } from '../lib/format.ts';
import { getMyUsage } from '../lib/meApi.ts';
import { useServerState } from '../lib/useServerState.ts';

export function SelfUsage() {
  const { data: usage, status, refetch } = useServerState('me:usage', getMyUsage);

  const unlimited = usage != null && usage.limit <= 0;
  const pct =
    usage && usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">Употреба на токени</h2>
        <p className="text-xs text-muted-foreground">Изразходвани токени за чата</p>
      </div>
      {status === 'error' ? (
        <ErrorState message="Неуспешно зареждане." onRetry={refetch} />
      ) : usage == null ? (
        <Loading />
      ) : (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between text-sm">
            <span>{formatNumber(usage.used)} токена</span>
            <span className="text-muted-foreground">
              {unlimited ? 'без лимит' : `от ${formatNumber(usage.limit)}`}
            </span>
          </div>
          {unlimited ? null : (
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={usage.exceeded ? 'h-full bg-destructive' : 'h-full bg-primary'}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Вход</dt>
              <dd>{formatNumber(usage.input)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Изход</dt>
              <dd>{formatNumber(usage.output)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Кеш</dt>
              <dd>{formatNumber(usage.cached)}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            {usage.requests} заявки
            {usage.exceeded ? ' · лимитът е достигнат' : ''}
          </p>
        </div>
      )}
    </section>
  );
}
