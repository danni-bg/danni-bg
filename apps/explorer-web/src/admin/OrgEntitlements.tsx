// Super-admin org entitlements (spec 065 FR-650): assign each org's token pool + toggle BYOM — the
// platform's side of a manual B2B contract. Lists every org (adminApi.listTenants) with an editable
// pool (save on blur/Enter) and a BYOM switch. Human/super-admin only; the routes 403 otherwise.

import { useState } from 'react';
import { ErrorState, Loading } from '../components/StatusMessage.tsx';
import { Input } from '../components/ui/input.tsx';
import { type AdminTenant, listTenants, setTenantByom, setTenantPool } from '../lib/adminApi.ts';
import { formatNumber } from '../lib/format.ts';
import { useServerState } from '../lib/useServerState.ts';

function OrgRow({ org, onChange }: { org: AdminTenant; onChange: () => void }) {
  const [pool, setPool] = useState(org.token_pool == null ? '' : String(org.token_pool));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, fail: string) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch {
      setErr(fail);
    } finally {
      setBusy(false);
    }
  }

  function savePool() {
    const trimmed = pool.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next != null && (!Number.isFinite(next) || next < 0)) return;
    if (next === (org.token_pool ?? null)) return;
    void run(() => setTenantPool(org.id, next), 'Пулът е под вече разпределеното.');
  }

  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <div className="min-w-0">
        <div className="truncate font-medium">{org.name}</div>
        <div className="truncate text-muted-foreground">
          {org.slug} · {formatNumber(org.memberCount)} членове
        </div>
        {err ? <div className="text-destructive">{err}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          aria-label={`Пул токени за ${org.name}`}
          value={pool}
          onChange={(e) => setPool(e.target.value)}
          onBlur={savePool}
          onKeyDown={(e) => {
            if (e.key === 'Enter') savePool();
          }}
          placeholder="без пул"
          inputMode="numeric"
          disabled={busy}
          className="h-7 w-24 px-1 text-right"
        />
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={org.byom_enabled === 1}
            disabled={busy}
            onChange={(e) =>
              void run(() => setTenantByom(org.id, e.target.checked), 'Неуспешна промяна.')
            }
          />
          BYOM
        </label>
      </div>
    </li>
  );
}

export function OrgEntitlements() {
  const query = useServerState('admin:tenants', listTenants);
  const orgs = query.data ?? null;

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">Организации — пул от токени и BYOM</h2>
        <p className="text-xs text-muted-foreground">
          Ръчно назначаване по договор: пул токени за модел-рутирането на danni и разрешаване на
          собствен модел (BYOM). Празен пул = без ограничение (наследено поведение).
        </p>
      </div>
      {query.status === 'error' ? (
        <ErrorState message="Неуспешно зареждане на организациите." onRetry={query.refetch} />
      ) : orgs == null ? (
        <Loading />
      ) : (
        <ul className="space-y-1.5">
          {orgs.map((org) => (
            <OrgRow key={org.id} org={org} onChange={query.refetch} />
          ))}
        </ul>
      )}
    </section>
  );
}
