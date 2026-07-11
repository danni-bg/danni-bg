// The signed-in user's account page, routed at /auth/settings (spec 060 FR-431). Owns the whole
// account composition — profile picture, appearance, token usage, API keys, and the Kratos-owned
// settings sections (Профил / Парола / Passkeys, rendered by `KratosSettingsSections`). Behaviour and
// strings are unchanged from when this lived inside KratosFlow's `kind === 'settings'` branch; the
// difference is only that account concerns no longer hide inside the auth-flow component.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { KratosSettingsSections } from '../auth/KratosFlow.tsx';
import { Card } from '../components/ui/card.tsx';
import {
  type Theme,
  applyResolvedTheme,
  loadTheme,
  resolveTheme,
  saveTheme,
} from '../lib/theme.ts';
import { ApiKeys } from './ApiKeys.tsx';
import { AvatarUpload } from './AvatarUpload.tsx';
import { Organizations } from './Organizations.tsx';
import { SelfUsage } from './SelfUsage.tsx';

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Светъл' },
  { value: 'dark', label: 'Тъмен' },
  { value: 'system', label: 'Системен' },
];

// Appearance is a purely client-side preference (localStorage + a `.dark` class on <html>) applied
// by App via lib/theme.ts — it is not part of the Kratos flow.
function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme(localStorage));
  function choose(next: Theme) {
    setTheme(next);
    saveTheme(localStorage, next);
    applyResolvedTheme(
      document.documentElement,
      resolveTheme(next, window.matchMedia('(prefers-color-scheme: dark)').matches),
    );
  }
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">Облик</h2>
        <p className="text-xs text-muted-foreground">Тема на приложението</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {THEME_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => choose(o.value)}
            className={
              theme === o.value
                ? 'rounded-md border border-primary bg-primary/10 px-3 py-2 text-sm font-medium text-primary'
                : 'rounded-md border border-border px-3 py-2 text-sm transition hover:bg-accent'
            }
          >
            {o.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function AccountPage() {
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md space-y-6 p-8">
        <h1 className="text-xl font-semibold tracking-tight">Настройки</h1>
        <AvatarUpload />
        <AppearanceSection />
        <SelfUsage />
        <Organizations />
        <ApiKeys />
        <KratosSettingsSections />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link to="/" className="text-primary hover:underline">
            Към началото
          </Link>
        </div>
      </Card>
    </div>
  );
}
