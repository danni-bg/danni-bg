import { describe, expect, it } from 'bun:test';
import {
  type StorageLike,
  applyResolvedTheme,
  loadTheme,
  resolveTheme,
  saveTheme,
} from './theme.ts';

function mem(initial: Record<string, string> = {}): StorageLike {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe('theme', () => {
  it('loads system by default and valid stored values', () => {
    expect(loadTheme(mem())).toBe('system');
    expect(loadTheme(mem({ 'danni.theme': 'dark' }))).toBe('dark');
    expect(loadTheme(mem({ 'danni.theme': 'nonsense' }))).toBe('system');
  });

  it('round-trips a saved theme', () => {
    const s = mem();
    saveTheme(s, 'light');
    expect(loadTheme(s)).toBe('light');
  });

  it('resolves system against the OS preference, explicit otherwise', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('toggles the dark class on the root element', () => {
    const calls: Array<[string, boolean]> = [];
    const root = { classList: { toggle: (c: string, f: boolean) => void calls.push([c, f]) } };
    applyResolvedTheme(root, 'dark');
    applyResolvedTheme(root, 'light');
    expect(calls).toEqual([
      ['dark', true],
      ['dark', false],
    ]);
  });
});
