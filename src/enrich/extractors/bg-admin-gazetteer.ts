import type { EntityCandidate, ExtractContext, Extractor } from '../extractor.ts';
import { findGazetteerMatches } from '../gazetteer/bg-admin.ts';

export class BgAdminGazetteerExtractor implements Extractor {
  readonly id: string;

  constructor() {
    this.id = 'bg_admin_gazetteer';
  }

  async extract(ctx: ExtractContext): Promise<EntityCandidate[]> {
    const haystack = [
      ctx.dataset.title_bg,
      ctx.dataset.description_bg ?? '',
      ...ctx.resources.map((r) => r.name ?? ''),
      ...ctx.resources.map((r) => r.description_bg ?? ''),
    ].join('\n');
    const matches = findGazetteerMatches(haystack);
    return matches.map((m) => ({
      id: m.id,
      kind: 'geographic_unit',
      canonicalLabelBg: m.labelBg,
      canonicalLabelEn: m.labelEn,
      attributes: m.attributes,
      evidence: { matchType: m.matchType, kind: m.kind },
      confidence: m.matchType === 'canonical' ? 0.95 : 0.75,
    }));
  }
}
