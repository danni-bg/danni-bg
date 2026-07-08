import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../config/loader.ts';
import { buildEmbedder } from '../index/embedders/factory.ts';
import { type RecallQuery, evaluateRecall } from '../index/eval.ts';
import { openDb } from '../store/db.ts';

const QuerySetSchema = z.object({
  queries: z
    .array(
      z.object({
        query: z.string().min(1),
        lang: z.enum(['bg', 'en']),
        expected: z.array(z.string().min(1)).min(1),
        rationale: z.string().optional(),
      }),
    )
    .min(1),
});

interface EvalFlags {
  querySet?: string | undefined;
  limit?: number;
  minRecall?: number;
  json?: boolean;
}

export function parseFlags(args: string[]): EvalFlags {
  const flags: EvalFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--query-set') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) throw new Error('--query-set requires a path');
      flags.querySet = v;
      i++;
    } else if (a === '--limit') {
      const v = Number.parseInt(args[i + 1] ?? '', 10);
      if (!Number.isFinite(v) || v < 1 || v > 50) throw new Error('--limit must be 1..50');
      flags.limit = v;
      i++;
    } else if (a === '--min-recall') {
      const v = Number(args[i + 1]);
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error('--min-recall must be 0..1');
      flags.minRecall = v;
      i++;
    } else if (a === '--json') {
      flags.json = true;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'danni eval --query-set <path> [--limit N] [--min-recall R] [--json]\n' +
          '  --query-set <path>  JSON { queries: [{ query, lang: bg|en, expected: [datasetId], rationale? }] }\n' +
          '  --limit N           top-K cutoff for a hit (default 5 = SC-004 top-5)\n' +
          '  --min-recall R      exit 3 if recall@K < R (0..1), e.g. 0.9 to gate on SC-004\n' +
          '  --json              emit the full report as JSON\n',
      );
      throw new Error('__HELP__');
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!flags.querySet) throw new Error('--query-set <path> is required');
  return flags;
}

function loadQueries(path: string): RecallQuery[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(
      `could not read query set ${path}: ${err instanceof Error ? err.message : err}`,
    );
  }
  const result = QuerySetSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `query set failed validation: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return result.data.queries;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export async function run(args: string[]): Promise<number> {
  let flags: EvalFlags;
  try {
    flags = parseFlags(args);
  } catch (err) {
    if (err instanceof Error && err.message === '__HELP__') return 0;
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  let queries: RecallQuery[];
  try {
    queries = loadQueries(resolve(process.cwd(), flags.querySet as string));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const config = loadConfig();
  const storeRoot = resolve(process.cwd(), config.store.root);
  const db = openDb({ storeRoot, loadVec: false });
  try {
    const embedder = buildEmbedder(config.enrichment.embedder);
    const report = await evaluateRecall({
      db,
      embedder,
      queries,
      ...(flags.limit ? { limit: flags.limit } : {}),
      freshnessSloSeconds: config.store.freshnessSloSeconds,
    });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `recall@${report.limit}: ${pct(report.recallAtK)} (${report.hits}/${report.total})  ` +
          `embedder=${embedder.id}\n` +
          `  bg: ${pct(report.byLang.bg.recall)} (${report.byLang.bg.hits}/${report.byLang.bg.total})  ` +
          `en: ${pct(report.byLang.en.recall)} (${report.byLang.en.hits}/${report.byLang.en.total})\n`,
      );
      if (report.misses.length > 0) {
        process.stdout.write(`misses (${report.misses.length}):\n`);
        for (const m of report.misses) {
          process.stdout.write(
            `  [${m.lang}] "${m.query}" → expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.got.slice(0, report.limit))}\n`,
          );
        }
      }
    }

    if (flags.minRecall !== undefined && report.recallAtK < flags.minRecall) {
      process.stderr.write(
        `recall@${report.limit} ${pct(report.recallAtK)} is below --min-recall ${pct(flags.minRecall)}\n`,
      );
      return 3;
    }
    return 0;
  } finally {
    db.close();
  }
}
