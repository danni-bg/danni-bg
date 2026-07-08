import type { EntityCandidate, ExtractContext, Extractor } from '../extractor.ts';

export class CkanGroupsExtractor implements Extractor {
  readonly id: string;

  constructor() {
    this.id = 'ckan_groups';
  }

  async extract(ctx: ExtractContext): Promise<EntityCandidate[]> {
    const groups = JSON.parse(ctx.dataset.groups_json) as string[];
    return groups.map((g) => ({
      id: `group:${g}`,
      kind: 'group',
      canonicalLabelBg: g,
      evidence: { source: 'ckan.groups' },
      confidence: 1.0,
    }));
  }
}
