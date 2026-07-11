// Profile-picture section for the settings page. Resizes the chosen image to a small square data URL
// client-side (so the stored blob stays tiny), uploads it, and refreshes the session so the header
// avatar updates immediately.

import { useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import { initials } from '../lib/format.ts';
import { toSquareDataUrl } from '../lib/image.ts';
import { setMyAvatar } from '../lib/meApi.ts';

export function AvatarUpload() {
  const { user, refresh } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user) return null;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await setMyAvatar(await toSquareDataUrl(file));
      await refresh();
    } catch {
      setError('Неуспешно качване на снимката.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await setMyAvatar(null);
      await refresh();
    } catch {
      setError('Неуспешно премахване.');
    } finally {
      setBusy(false);
    }
  }

  const BTN =
    'rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-accent disabled:opacity-50';

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">Снимка</h2>
        <p className="text-xs text-muted-foreground">Профилна снимка</p>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-base font-semibold text-muted-foreground">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(user.displayName?.trim() || user.email)
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={onFile}
          />
          <button
            type="button"
            className={BTN}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? 'Качване…' : 'Качи снимка'}
          </button>
          {user.avatarUrl ? (
            <button
              type="button"
              className={`${BTN} text-destructive`}
              disabled={busy}
              onClick={() => void remove()}
            >
              Премахни
            </button>
          ) : null}
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
