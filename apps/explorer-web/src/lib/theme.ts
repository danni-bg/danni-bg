// Theme preference: light / dark / system (follows OS). Pure helpers (resolve/load/save/apply) so the
// logic is unit-tested; App applies the saved theme and the account page (Облик) selects it.

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'danni.theme';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadTheme(storage: StorageLike): Theme {
  const v = storage.getItem(KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

export function saveTheme(storage: StorageLike, theme: Theme): void {
  storage.setItem(KEY, theme);
}

export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

export function applyResolvedTheme(
  root: { classList: { toggle(token: string, force: boolean): void } },
  resolved: ResolvedTheme,
): void {
  root.classList.toggle('dark', resolved === 'dark');
}
