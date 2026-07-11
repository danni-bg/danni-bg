// Appearance (theme) settings section (spec 066 — extracted from AccountPage for the settings sidebar).
// A purely client-side preference: localStorage + a `.dark` class on <html>, applied by App via
// lib/theme.ts. Not part of the Kratos flow.

import { useState } from 'react';
import {
  type Theme,
  applyResolvedTheme,
  loadTheme,
  resolveTheme,
  saveTheme,
} from '../lib/theme.ts';

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Светъл' },
  { value: 'dark', label: 'Тъмен' },
  { value: 'system', label: 'Системен' },
];

export function AppearanceSection() {
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
