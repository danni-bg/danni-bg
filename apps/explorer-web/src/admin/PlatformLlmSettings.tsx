// Platform LLM + chat toggles (spec 019; spec 066 moved it into the settings sidebar as its own
// category). Edits the chat's default LLM provider + runtime toggles. The API key is write-only:
// shown masked, left blank to keep the existing one. Super-admin only (mounted behind RequireAdmin).

import { useEffect, useState } from 'react';
import { Input } from '../components/ui/input.tsx';
import { type AdminSettings, type SettingsPut, getSettings, putSettings } from '../lib/adminApi.ts';
import { useServerState } from '../lib/useServerState.ts';

const SELECT =
  'w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

export function PlatformLlmSettings() {
  const [data, setData] = useState<AdminSettings | null>(null);
  const [kind, setKind] = useState('openai-compatible');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [chatEnabled, setChatEnabled] = useState(true);
  const [defaultTokenLimit, setDefaultTokenLimit] = useState('');
  const [cachedTokenWeight, setCachedTokenWeight] = useState('');
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function hydrate(s: AdminSettings) {
    setData(s);
    setKind(s.llm?.kind ?? 'openai-compatible');
    setModel(s.llm?.model ?? '');
    setBaseUrl(s.llm?.baseUrl ?? '');
    setApiKey('');
    setChatEnabled(s.toggles.chatEnabled ?? true);
    setDefaultTokenLimit(s.toggles.defaultTokenLimit ? String(s.toggles.defaultTokenLimit) : '');
    setCachedTokenWeight(
      s.toggles.cachedTokenWeight != null ? String(s.toggles.cachedTokenWeight) : '',
    );
    setMaxOutputTokens(s.toggles.maxOutputTokens ? String(s.toggles.maxOutputTokens) : '');
  }

  const settingsQuery = useServerState('admin:settings', getSettings);
  useEffect(() => {
    if (settingsQuery.data) hydrate(settingsQuery.data);
    else if (settingsQuery.status === 'error') setError('Неуспешно зареждане на настройките.');
  }, [settingsQuery.data, settingsQuery.status]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    setError(null);
    const body: SettingsPut = {
      llm: { kind, model, baseUrl: baseUrl || null, ...(apiKey ? { apiKey } : {}) },
      toggles: {
        chatEnabled,
        ...(defaultTokenLimit ? { defaultTokenLimit: Number.parseInt(defaultTokenLimit, 10) } : {}),
        ...(cachedTokenWeight ? { cachedTokenWeight: Number.parseFloat(cachedTokenWeight) } : {}),
        ...(maxOutputTokens ? { maxOutputTokens: Number.parseInt(maxOutputTokens, 10) } : {}),
      },
    };
    try {
      hydrate(await putSettings(body));
      setStatus('Записано.');
    } catch {
      setError('Записът неуспешен.');
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-border p-4">
      <h2 className="text-sm font-semibold">LLM и чат</h2>
      <form onSubmit={onSave} className="space-y-4">
        <fieldset className="space-y-3 rounded border border-border p-4">
          <legend className="px-1 text-sm font-medium">LLM доставчик (chat)</legend>
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">Тип</span>
            <select className={SELECT} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="openai-compatible">openai-compatible</option>
              <option value="anthropic">anthropic</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">Модел</span>
            <Input value={model} onChange={(e) => setModel(e.target.value)} required />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">Base URL</span>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">
              API ключ{' '}
              {data?.llm?.apiKeyMasked
                ? `(текущ: ${data.llm.apiKeyHint}; празно = без промяна)`
                : ''}
            </span>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={data?.llm?.apiKeyHint ?? ''}
            />
          </label>
        </fieldset>

        <fieldset className="space-y-3 rounded border border-border p-4">
          <legend className="px-1 text-sm font-medium">Платформа</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={chatEnabled}
              onChange={(e) => setChatEnabled(e.target.checked)}
            />
            Чатът е активен
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">
              Лимит токени по подразбиране (0 = без лимит)
            </span>
            <Input
              type="number"
              value={defaultTokenLimit}
              onChange={(e) => setDefaultTokenLimit(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">
              Тегло на кеширани токени (0–1; празно = 0.1)
            </span>
            <Input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={cachedTokenWeight}
              onChange={(e) => setCachedTokenWeight(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">
              Макс. изходни токени на отговор (празно = 4096)
            </span>
            <Input
              type="number"
              value={maxOutputTokens}
              onChange={(e) => setMaxOutputTokens(e.target.value)}
            />
          </label>
        </fieldset>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Запиши
          </button>
          {status ? <span className="text-sm text-green-600">{status}</span> : null}
          {error ? <span className="text-sm text-destructive">{error}</span> : null}
          {data ? (
            <span className="text-xs text-muted-foreground">източник: {data.source}</span>
          ) : null}
        </div>
      </form>
    </section>
  );
}
