import type { EntityCandidate, ExtractContext, Extractor } from '../extractor.ts';

const KEYWORDS: Array<{
  id: string;
  labelBg: string;
  labelEn: string;
  matches: string[];
  confidence: number;
}> = [
  {
    id: 'subject:budget',
    labelBg: 'Бюджет',
    labelEn: 'Budget',
    matches: ['бюджет', 'budget'],
    confidence: 0.7,
  },
  {
    id: 'subject:population',
    labelBg: 'Население',
    labelEn: 'Population',
    matches: ['население', 'population'],
    confidence: 0.7,
  },
  {
    id: 'subject:education',
    labelBg: 'Образование',
    labelEn: 'Education',
    matches: ['образование', 'education'],
    confidence: 0.65,
  },
  {
    id: 'subject:health',
    labelBg: 'Здравеопазване',
    labelEn: 'Health',
    matches: ['здраве', 'медицина', 'health'],
    confidence: 0.65,
  },
  {
    id: 'subject:transport',
    labelBg: 'Транспорт',
    labelEn: 'Transport',
    matches: ['транспорт', 'transport'],
    confidence: 0.6,
  },
  {
    id: 'subject:environment',
    labelBg: 'Околна среда',
    labelEn: 'Environment',
    matches: ['околна среда', 'environment', 'екология'],
    confidence: 0.6,
  },
];

export class ColumnNameHeuristicsExtractor implements Extractor {
  readonly id: string;

  constructor() {
    this.id = 'column_name_heuristics';
  }

  async extract(ctx: ExtractContext): Promise<EntityCandidate[]> {
    const haystack = [ctx.dataset.title_bg, ctx.dataset.description_bg ?? '']
      .concat(ctx.resources.map((r) => `${r.name ?? ''} ${r.description_bg ?? ''}`))
      .join(' ')
      .toLowerCase();
    const out: EntityCandidate[] = [];
    for (const k of KEYWORDS) {
      if (k.matches.some((m) => haystack.includes(m))) {
        out.push({
          id: k.id,
          kind: 'named_subject',
          canonicalLabelBg: k.labelBg,
          canonicalLabelEn: k.labelEn,
          evidence: { source: 'column-name-heuristics' },
          confidence: k.confidence,
        });
      }
    }
    return out;
  }
}
