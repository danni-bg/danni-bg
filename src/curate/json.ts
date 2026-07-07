import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ensureDir } from '../lib/fs.ts';
import type {
  CurateContext,
  CuratedArtifactOutput,
  Curator,
  JsonShapeSchema,
  TransformRule,
} from './curator.ts';
import { curatedRelDir } from './curator.ts';
import { decodeBytes, detectEncoding } from './encoding.ts';

export class JsonCurator implements Curator {
  readonly kind = 'json' as const;

  canHandle(ctx: CurateContext): boolean {
    const fmt = (ctx.resource.declared_format ?? '').toLowerCase();
    if (fmt === 'json' || fmt === 'jsonl' || fmt === 'ndjson') return true;
    return /\.json(?:l|nd)?$/.test(ctx.resource.source_url.toLowerCase());
  }

  async curate(ctx: CurateContext): Promise<CuratedArtifactOutput> {
    const bytes = readFileSync(ctx.rawAbsPath);
    const detection = detectEncoding(bytes);
    const text = decodeBytes(bytes, detection.encoding);
    const preRules: TransformRule[] = [];
    if (detection.encoding === 'cp1251') {
      preRules.push({ rule: 'utf8-from-windows1251', appliedTo: '*' });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `JsonCurator failed to parse ${ctx.resource.source_url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return curateJsonFromValue(parsed, ctx, preRules);
  }
}

/**
 * Write an already-parsed JSON value as a normalized `data.json` + schema. Split from
 * `JsonCurator.curate` so the datastore-JSON curator (spec 049), which already holds the parsed
 * value from the verbatim envelope, produces the identical artifact without a serialize/re-parse
 * round-trip. `preRules` carries any transform applied to reach this value.
 */
export function curateJsonFromValue(
  parsed: unknown,
  ctx: CurateContext,
  preRules: TransformRule[] = [],
): CuratedArtifactOutput {
  const transformRules: TransformRule[] = [...preRules];
  const root: JsonShapeSchema['rootShape'] = Array.isArray(parsed) ? 'array' : 'object';
  const schema: JsonShapeSchema = {
    kind: 'json',
    encoding: 'utf-8',
    rootShape: root,
    transformRules,
  };
  const dir = join(ctx.storeRoot, 'curated', curatedRelDir(ctx.resource));
  ensureDir(dir);
  writeFileSync(join(dir, 'data.json'), `${JSON.stringify(parsed, null, 2)}\n`);
  writeFileSync(join(dir, 'schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
  return {
    kind: 'json',
    path: relative(join(ctx.storeRoot, 'curated'), join(dir, 'data.json')),
    schema,
    transformRules,
  };
}
