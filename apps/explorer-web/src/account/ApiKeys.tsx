// API-key management section for the settings page (spec 027). Create a named key (the secret is
// shown ONCE), list active keys (prefix + last used), and revoke. Human-session only — these calls
// 403 for an API-key caller.

import { useState } from 'react';
import { ErrorState, Loading } from '../components/StatusMessage.tsx';
import { createApiKey, getApiUsage, listApiKeys, revokeApiKey } from '../lib/meApi.ts';
import { useServerState } from '../lib/useServerState.ts';

const dt = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'medium' });
const fmtDate = (iso: string | null) => (iso ? dt.format(new Date(iso)) : '—');

export function ApiKeys() {
  const keysQuery = useServerState('me:api-keys', listApiKeys);
  // Per-key request counts are supplementary — a failure just omits the counts, not the key list.
  const usageQuery = useServerState('me:api-usage', getApiUsage);
  const keys = keysQuery.data ?? null;
  const usageByKey: Record<string, number> = usageQuery.data
    ? Object.fromEntries(usageQuery.data.byKey.map((k) => [k.keyId, k.count]))
    : {};
  const [error, setError] = useState<string | null>(null); // mutation (create/revoke) error only
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null); // plaintext shown once after creation
  const [copied, setCopied] = useState(false);

  function reload() {
    keysQuery.refetch();
    usageQuery.refetch();
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const k = await createApiKey(trimmed);
      setFresh(k.key);
      setCopied(false);
      setName('');
      reload();
    } catch {
      setError('Неуспешно създаване на ключ.');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    try {
      await revokeApiKey(id);
      reload();
    } catch {
      setError('Неуспешно анулиране.');
    }
  }

  const active = (keys ?? []).filter((k) => !k.revokedAt);

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">API ключове</h2>
        <p className="text-xs text-muted-foreground">
          Достъп до API-то с програма: <code>Authorization: Bearer …</code>
        </p>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {/* The secret is shown only once, right after creation. */}
      {fresh ? (
        <div className="space-y-2 rounded-md border border-orange-500 bg-card/95 p-3 ring-1 ring-orange-500/30">
          <p className="text-xs font-medium">Копирайте ключа сега — няма да бъде показан отново.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
              {fresh}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(fresh).then(() => setCopied(true));
              }}
              className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
            >
              {copied ? 'Копирано' : 'Копирай'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setFresh(null)}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Скрий
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <input
          aria-label="Име на ключа"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
          placeholder="Име (напр. ETL скрипт)"
          maxLength={80}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={!name.trim() || creating}
          className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          Създай
        </button>
      </div>

      {keysQuery.status === 'error' ? (
        <ErrorState message="Неуспешно зареждане на ключовете." onRetry={keysQuery.refetch} />
      ) : keys == null ? (
        <Loading />
      ) : active.length === 0 ? (
        <p className="text-xs text-muted-foreground">Няма активни ключове.</p>
      ) : (
        <ul className="space-y-1.5">
          {active.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="truncate font-medium">{k.name}</div>
                <div className="truncate text-muted-foreground">
                  <code>{k.prefix}…</code> · {k.scopes.join(', ')} · ползван {fmtDate(k.lastUsedAt)}
                  {usageByKey[k.id] ? ` · ${usageByKey[k.id]} заявки` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void revoke(k.id)}
                className="shrink-0 rounded-md px-2 py-1 text-destructive hover:bg-destructive/10"
              >
                Анулирай
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
