import type { Database } from 'bun:sqlite';
import type { Embedder } from './embedder.ts';
import { search } from './query.ts';

/**
 * A single labelled retrieval query: the text, its language, and the dataset id(s) that a correct
 * search should surface. `expected` is satisfied if ANY of its ids appears in the top-K results.
 */
export interface RecallQuery {
  query: string;
  lang: 'bg' | 'en';
  expected: string[];
  rationale?: string | undefined;
}

export interface QueryMiss {
  query: string;
  lang: 'bg' | 'en';
  expected: string[];
  got: string[];
}

export interface LangRecall {
  total: number;
  hits: number;
  recall: number;
}

/**
 * recall@K over a labelled query set, split by language (FR-014 cross-lingual axis), with the
 * misses surfaced so failures are diagnosable. `recallAtK` is the SC-004 metric (target ≥0.90).
 */
export interface RecallReport {
  limit: number;
  total: number;
  hits: number;
  recallAtK: number;
  byLang: { bg: LangRecall; en: LangRecall };
  misses: QueryMiss[];
}

export interface EvaluateRecallOptions {
  db: Database;
  embedder: Embedder;
  queries: RecallQuery[];
  /** Top-K cutoff for a hit (default 5 — the SC-004 "top 5" target). */
  limit?: number;
  freshnessSloSeconds?: number;
}

/**
 * Run each query through the real hybrid `search()` and score recall@K — the instrument for SC-004
 * ("locate the most relevant dataset within the top 5 for ≥90% of a representative query set",
 * Bulgarian or English). Backend-agnostic: it measures whatever embedder is wired, so it doubles as
 * the validation harness for swapping the stub for a real model.
 */
export async function evaluateRecall(opts: EvaluateRecallOptions): Promise<RecallReport> {
  const limit = opts.limit ?? 5;
  const byLang: RecallReport['byLang'] = {
    bg: { total: 0, hits: 0, recall: 0 },
    en: { total: 0, hits: 0, recall: 0 },
  };
  const misses: QueryMiss[] = [];
  let hits = 0;

  for (const q of opts.queries) {
    const results = await search({
      db: opts.db,
      embedder: opts.embedder,
      query: q.query,
      limit,
      ...(opts.freshnessSloSeconds !== undefined
        ? { freshnessSloSeconds: opts.freshnessSloSeconds }
        : {}),
    });
    const got = results.map((r) => r.datasetId);
    const hit = q.expected.some((id) => got.includes(id));
    byLang[q.lang].total += 1;
    if (hit) {
      hits += 1;
      byLang[q.lang].hits += 1;
    } else {
      misses.push({ query: q.query, lang: q.lang, expected: q.expected, got });
    }
  }

  byLang.bg.recall = byLang.bg.total ? byLang.bg.hits / byLang.bg.total : 0;
  byLang.en.recall = byLang.en.total ? byLang.en.hits / byLang.en.total : 0;
  const total = opts.queries.length;
  return { limit, total, hits, recallAtK: total ? hits / total : 0, byLang, misses };
}
