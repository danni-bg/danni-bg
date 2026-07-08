import type { EntityCandidate, ExtractContext, Extractor } from '../extractor.ts';

export class CkanTagsExtractor implements Extractor {
  readonly id: string;

  constructor() {
    this.id = 'ckan_tags';
  }

  async extract(ctx: ExtractContext): Promise<EntityCandidate[]> {
    const tags = JSON.parse(ctx.dataset.tags_json) as string[];
    return tags.map((t) => ({
      id: `tag:${t}`,
      kind: 'tag',
      canonicalLabelBg: t,
      evidence: { source: 'ckan.tags' },
      confidence: 0.6,
    }));
  }
}
