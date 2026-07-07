// Admin per-user token usage + quota table (token metering). Shows everyone's usage against their
// effective limit; an admin can set/clear each user's per-user limit and reset their counter.

import { useState } from 'react';
import { ErrorState, Loading } from '../components/StatusMessage.tsx';
import { Input } from '../components/ui/input.tsx';
import { type AdminUsageRow, getUsage, resetUserUsage, setUserLimit } from '../lib/adminApi.ts';
import { formatNumber } from '../lib/format.ts';
import { useServerState } from '../lib/useServerState.ts';
import { resetUsage, saveUserLimit } from './adminUsageActions.ts';

const fmtLimit = (limit: number) => (limit <= 0 ? '∞' : formatNumber(limit));
const api = { setUserLimit, resetUserUsage };

export function AdminUsage() {
  const usageQuery = useServerState('admin:usage', getUsage);
  const rows = usageQuery.data?.users ?? null;
  const defaultLimit = usageQuery.data?.defaultLimit ?? 0;
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  async function onSave(row: AdminUsageRow) {
    const res = await saveUserLimit(api, row.userId, edits[row.userId] ?? '');
    if (res.ok) {
      setSaveError(null);
      // Drop the just-saved edit so the row reflects the refetched server value.
      setEdits((m) => {
        const { [row.userId]: _saved, ...rest } = m;
        return rest;
      });
      usageQuery.refetch();
    } else if (res.reason === 'error') {
      // Surface the failure and KEEP the attempted value in the input (FR-404).
      setSaveError(`Неуспешно записване на лимит за ${row.email}.`);
    }
  }
  async function onReset(row: AdminUsageRow) {
    if (await resetUsage(api, row.userId)) {
      setSaveError(null);
      usageQuery.refetch();
    } else {
      setSaveError(`Неуспешно нулиране на употребата за ${row.email}.`);
    }
  }

  if (usageQuery.status === 'error')
    return <ErrorState message="Неуспешно зареждане на употребата." onRetry={usageQuery.refetch} />;
  if (rows == null) return <Loading />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Употреба на токени по потребител</h2>
        <span className="text-xs text-muted-foreground">
          По подразбиране: {fmtLimit(defaultLimit)}
        </span>
      </div>
      {saveError && <p className="text-sm text-destructive">{saveError}</p>}
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-left text-sm">
          <thead className="border-border border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Потребител</th>
              <th className="px-3 py-2 text-right font-medium">Употреба</th>
              <th className="px-3 py-2 text-right font-medium">Вход</th>
              <th className="px-3 py-2 text-right font-medium">Изход</th>
              <th className="px-3 py-2 text-right font-medium">Кеш</th>
              <th className="px-3 py-2 text-right font-medium">Заявки</th>
              <th className="px-3 py-2 font-medium">Личен лимит</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId} className="border-border border-b last:border-0">
                <td className="px-3 py-2">
                  <div className="font-medium">{r.displayName?.trim() || r.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.email}
                    {r.role === 'admin' ? ' · админ' : ''}
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <span className={r.exceeded ? 'font-medium text-destructive' : ''}>
                    {formatNumber(r.used)}
                  </span>
                  <span className="text-muted-foreground"> / {fmtLimit(r.limit)}</span>
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {formatNumber(r.input)}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {formatNumber(r.output)}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {formatNumber(r.cached)}
                </td>
                <td className="px-3 py-2 text-right">{formatNumber(r.requests)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Input
                      aria-label={`Лимит за ${r.email}`}
                      className="h-8 w-24 px-2"
                      placeholder="по подразб."
                      value={edits[r.userId] ?? r.tokenLimit?.toString() ?? ''}
                      onChange={(e) => setEdits((m) => ({ ...m, [r.userId]: e.target.value }))}
                    />
                    <button
                      type="button"
                      onClick={() => void onSave(r)}
                      className="rounded border border-border px-2 py-1 text-xs transition hover:bg-accent"
                    >
                      Запази
                    </button>
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => void onReset(r)}
                    className="rounded border border-border px-2 py-1 text-xs text-destructive transition hover:bg-destructive/10"
                  >
                    Нулирай
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Празно поле = лимит по подразбиране; 0 = без лимит. „Нулирай" започва нов период на
        отчитане.
      </p>
    </div>
  );
}
