// Organization profile editor (spec 067): the active org's picture, contact email, and description.
// Shown to owner/admins in the Organizations console. The picture reuses the client-side resize →
// data: URL flow (lib/image.ts), the same as the user avatar.

import { useRef, useState } from 'react';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { initials } from '../lib/format.ts';
import { toSquareDataUrl } from '../lib/image.ts';
import { type ActiveOrg, setOrgAvatar, setOrgProfile } from '../lib/tenantApi.ts';

export function OrgProfileSection({ org, onChange }: { org: ActiveOrg; onChange: () => void }) {
  const [contactEmail, setContactEmail] = useState(org.contactEmail ?? '');
  const [description, setDescription] = useState(org.description ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function save() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await setOrgProfile(contactEmail.trim() || null, description.trim() || null);
      setStatus('Записано.');
      onChange();
    } catch {
      setError('Записът неуспешен — проверете имейла.');
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      await setOrgAvatar(await toSquareDataUrl(file));
      onChange();
    } catch {
      setError('Неуспешно качване на снимката.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function removeAvatar() {
    setError(null);
    try {
      await setOrgAvatar(null);
      onChange();
    } catch {
      setError('Неуспешно премахване.');
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="text-xs font-semibold">Профил на „{org.name}“</h3>

      <div className="flex items-center gap-3">
        <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-sm font-semibold text-muted-foreground">
          {org.avatarUrl ? (
            <img src={org.avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(org.name)
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
          >
            Смени снимка
          </button>
          {org.avatarUrl ? (
            <button
              type="button"
              onClick={() => void removeAvatar()}
              className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
            >
              Премахни
            </button>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void onFile(e)}
          />
        </div>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Имейл за контакт</span>
        <Input
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          placeholder="contact@org.bg"
          className="h-8 px-2"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Описание</span>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="С какво се занимава организацията…"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          Запиши
        </button>
        {status ? <span className="text-xs text-green-600">{status}</span> : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </section>
  );
}
