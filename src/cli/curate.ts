import { resolve } from 'node:path';
import { loadConfig } from '../config/loader.ts';
import { runCurate } from '../curate/run-curate.ts';
import type { Translator } from '../enrich/translator.ts';
import { HostedApiTranslator } from '../enrich/translators/hosted-api.ts';
import { LocalMarianMtTranslator } from '../enrich/translators/local-marianmt.ts';
import { openDb } from '../store/db.ts';

interface CurateFlags {
  datasets?: string[];
  since?: string;
  curatorVersion?: string;
  entitiesOnly?: boolean;
}

export function parseFlags(args: string[]): CurateFlags {
  const flags: CurateFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--datasets') {
      const v = args[i + 1];
      if (!v) throw new Error('--datasets requires a comma-separated value');
      flags.datasets = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      i++;
    } else if (a === '--since') {
      const v = args[i + 1];
      if (!v) throw new Error('--since requires a value');
      flags.since = v;
      i++;
    } else if (a === '--curator-version') {
      const v = args[i + 1];
      if (!v) throw new Error('--curator-version requires a value');
      flags.curatorVersion = v;
      i++;
    } else if (a === '--entities-only') {
      flags.entitiesOnly = true;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'danni curate [--datasets <id1,id2,...>] [--since <iso>] [--curator-version <v>] [--entities-only]\n',
      );
      throw new Error('__HELP__');
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return flags;
}

export function buildTranslator(config: ReturnType<typeof loadConfig>): Translator {
  const t = config.enrichment.translator;
  if (t.provider === 'hosted-api') {
    if (!t.endpointUrl) throw new Error('translator.endpointUrl is required for hosted-api');
    const bearer = t.apiKeyEnv ? process.env[t.apiKeyEnv] : undefined;
    return new HostedApiTranslator({
      endpointUrl: t.endpointUrl,
      ...(bearer ? { bearer } : {}),
      ...(t.modelId ? { model: t.modelId } : {}),
    });
  }
  return new LocalMarianMtTranslator(t.modelId ? { modelVersion: t.modelId } : {});
}

export async function run(args: string[]): Promise<number> {
  let flags: CurateFlags;
  try {
    flags = parseFlags(args);
  } catch (err) {
    if (err instanceof Error && err.message === '__HELP__') return 0;
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const config = loadConfig();
  const storeRoot = resolve(process.cwd(), config.store.root);
  const db = openDb({ storeRoot, loadVec: false });
  try {
    const result = await runCurate({
      db,
      storeRoot,
      curatorVersion: flags.curatorVersion ?? '0.1.0',
      ...(flags.datasets ? { datasetIds: flags.datasets } : {}),
      ...(flags.since ? { since: flags.since } : {}),
      // Entities-only skips translation, so don't construct a translator (avoids needless LAN/config).
      ...(flags.entitiesOnly ? { entitiesOnly: true } : { translator: buildTranslator(config) }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 4;
  } finally {
    db.close();
  }
}
