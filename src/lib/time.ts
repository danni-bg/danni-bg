export function nowIso(now: () => Date = () => new Date()): string {
  return now().toISOString();
}

export function toIso(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`toIso: invalid date ${String(d)}`);
  }
  return date.toISOString();
}

export function parseIso(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`parseIso: invalid ISO-8601 string ${s}`);
  }
  return d;
}

export function diffSeconds(a: string, b: string): number {
  return (parseIso(a).getTime() - parseIso(b).getTime()) / 1000;
}

/**
 * Whether `lastSyncedAt` is older than the freshness SLO (`sloSeconds`) — the single source of the
 * staleness rule shared by every read path (spec 055 FR-373). `now` (epoch ms) defaults to
 * `Date.now()`; pass a fixed value to project a whole batch against one timestamp (ReadBridge's
 * `listLite`) and to make the check unit-testable without clock mocking. A nullish timestamp (a
 * dataset/catalog with no sync yet) is treated as stale, matching the health probe's `!lastSyncedAt`
 * short-circuit. The comparison is strict `>`, so exactly-`sloSeconds`-old is NOT yet stale.
 */
export function isStale(
  lastSyncedAt: string | null | undefined,
  sloSeconds: number,
  now: number = Date.now(),
): boolean {
  if (lastSyncedAt == null) return true;
  return (now - new Date(lastSyncedAt).getTime()) / 1000 > sloSeconds;
}

const SOFIA_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Sofia',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatSofia(d: Date | string | number): string {
  const date = typeof d === 'string' || typeof d === 'number' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`formatSofia: invalid date ${String(d)}`);
  }
  return SOFIA_FORMATTER.format(date);
}
