import type { Database } from 'bun:sqlite';
import { withTransaction } from '../store/db.ts';
import type { EntitiesRepo } from '../store/repos/entities.ts';
import type { EntityCandidate, ExtractContext, Extractor } from './extractor.ts';

export interface RegisterEntitiesOptions {
  db: Database;
  repo: EntitiesRepo;
  extractors: Extractor[];
}

export interface RegisterEntitiesResult {
  candidates: Array<{ extractor: string; candidate: EntityCandidate }>;
  attached: number;
}

export async function registerEntities(
  opts: RegisterEntitiesOptions,
  ctx: ExtractContext,
): Promise<RegisterEntitiesResult> {
  const all: Array<{ extractor: string; candidate: EntityCandidate }> = [];
  for (const ex of opts.extractors) {
    const candidates = await ex.extract(ctx);
    for (const c of candidates) all.push({ extractor: ex.id, candidate: c });
  }
  let attached = 0;
  for (const { extractor, candidate } of all) {
    // One logical unit = the entity row plus its attachment to this dataset. Persist both in a single
    // transaction (spec 052 FR-340) so an interrupt can't leave an attached entity that was never
    // upserted (or vice versa).
    withTransaction(opts.db, () => {
      opts.repo.upsert({
        id: candidate.id,
        kind: candidate.kind,
        canonicalLabelBg: candidate.canonicalLabelBg,
        canonicalLabelEn: candidate.canonicalLabelEn ?? null,
        attributes: candidate.attributes ?? {},
      });
      opts.repo.attach({
        datasetId: ctx.dataset.id,
        entityId: candidate.id,
        extractor,
        confidence: candidate.confidence,
        evidence: candidate.evidence,
      });
    });
    attached++;
  }
  return { candidates: all, attached };
}
