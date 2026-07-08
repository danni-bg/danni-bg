import { normalizeDate } from '../../curate/normalize.ts';
import type { EntityCandidate, ExtractContext, Extractor } from '../extractor.ts';

const RE =
  /(\d{1,2})\s+(януари|февруари|март|април|май|юни|юли|август|септември|октомври|ноември|декември)\s+(\d{4})/gi;

export class BgMonthDatesExtractor implements Extractor {
  readonly id: string;

  constructor() {
    this.id = 'bg_month_dates';
  }

  async extract(ctx: ExtractContext): Promise<EntityCandidate[]> {
    const haystack = `${ctx.dataset.title_bg}\n${ctx.dataset.description_bg ?? ''}`;
    const seen = new Set<string>();
    const out: EntityCandidate[] = [];
    for (const m of haystack.matchAll(RE)) {
      const matched = m[0];
      if (!matched) continue;
      const norm = normalizeDate(matched);
      if (!norm || seen.has(norm.iso)) continue;
      seen.add(norm.iso);
      out.push({
        id: `time:${norm.iso}`,
        kind: 'time_period',
        canonicalLabelBg: norm.iso,
        evidence: { source: 'bg-month-name', original: matched },
        confidence: 0.85,
      });
    }
    return out;
  }
}
