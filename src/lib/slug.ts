// URL-safe slug derivation (spec 064 FR-501). Lowercase, collapse whitespace to `-`, drop anything
// that isn't a letter/digit/`-`, and trim stray dashes. Unicode letters are KEPT — Cyrillic slugs are
// the norm in this store (dataset/publisher slugs like `община-елена`), so a Bulgarian org name yields
// a readable Cyrillic slug rather than being stripped to empty.

const MAX_SLUG_LEN = 64;

export function slugify(input: string): string {
  return input
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '') // keep Unicode letters/digits + dash
    .replace(/-+/g, '-') // collapse dash runs
    .replace(/^-+|-+$/g, '') // trim leading/trailing dashes
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, ''); // re-trim if the slice landed on a dash
}
