// Pure display helpers (T031). Bulgarian-locale number/date formatting, name→initials, and freshness
// rendering — the SPA's single home for presentation formatting (spec 060 FR-434). Authoritative
// Bulgarian text is shown verbatim (Constitution X).

import type { FreshnessBlock } from '../types.ts';

const numberFmt = new Intl.NumberFormat('bg-BG');
/** Group-separated number in the Bulgarian locale (e.g. 12345 → "12 345"). */
export function formatNumber(n: number): string {
  return numberFmt.format(n);
}

const dateFmt = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'medium' });
/** A medium bg-BG date from an ISO string; `null` (or unset) renders as an em dash. */
export function formatDate(iso: string | null): string {
  return iso ? dateFmt.format(new Date(iso)) : '—';
}

/** Up to two initials from a display name or email (first + last token, uppercased). */
export function initials(nameOrEmail: string): string {
  const parts = nameOrEmail.split(/[\s@._-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '';
  const b = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return ((a + b).toUpperCase() || nameOrEmail[0]?.toUpperCase()) ?? '?';
}

export interface FreshnessDisplay {
  label: string;
  isStale: boolean;
}

export function freshnessDisplay(f: FreshnessBlock): FreshnessDisplay {
  const date = f.lastSyncedAt.slice(0, 10);
  return {
    label: f.isStale ? `остаряло · последно ${date}` : `актуално · ${date}`,
    isStale: f.isStale,
  };
}
