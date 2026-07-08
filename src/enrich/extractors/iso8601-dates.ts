import type { EntityCandidate, ExtractContext, Extractor } from '../extractor.ts';

const ISO_RE =
  /\b(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

export class Iso8601DatesExtractor implements Extractor {
  readonly id: string;

  constructor() {
    this.id = 'iso8601_dates';
  }

  async extract(ctx: ExtractContext): Promise<EntityCandidate[]> {
    const haystack = `${ctx.dataset.title_bg}\n${ctx.dataset.description_bg ?? ''}`;
    const seen = new Set<string>();
    const out: EntityCandidate[] = [];
    for (const m of haystack.matchAll(ISO_RE)) {
      const iso = m[1];
      if (!iso || seen.has(iso)) continue;
      seen.add(iso);
      out.push({
        id: `time:${iso}`,
        kind: 'time_period',
        canonicalLabelBg: iso,
        evidence: { source: 'iso8601-regex' },
        confidence: 0.95,
      });
    }
    return out;
  }
}
