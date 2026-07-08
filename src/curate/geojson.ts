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

export class GeoJsonCurator implements Curator {
  readonly kind: 'geojson';

  constructor() {
    this.kind = 'geojson';
  }

  canHandle(ctx: CurateContext): boolean {
    const fmt = (ctx.resource.declared_format ?? '').toLowerCase();
    if (fmt === 'geojson') return true;
    return ctx.resource.source_url.toLowerCase().endsWith('.geojson');
  }

  async curate(ctx: CurateContext): Promise<CuratedArtifactOutput> {
    const bytes = readFileSync(ctx.rawAbsPath);
    const detection = detectEncoding(bytes);
    const text = decodeBytes(bytes, detection.encoding);
    const transformRules: TransformRule[] = [];
    if (detection.encoding === 'cp1251') {
      transformRules.push({ rule: 'utf8-from-windows1251', appliedTo: '*' });
    }
    const parsed = JSON.parse(text) as { type?: string };
    let rootShape: JsonShapeSchema['rootShape'] = 'object';
    if (parsed.type === 'FeatureCollection') rootShape = 'feature_collection';
    else if (parsed.type === 'Feature') rootShape = 'feature';
    if (rootShape === 'object') {
      throw new Error(
        `GeoJsonCurator: ${ctx.resource.source_url} is not a Feature/FeatureCollection root`,
      );
    }
    const schema: JsonShapeSchema = {
      kind: 'geojson',
      encoding: 'utf-8',
      rootShape,
      transformRules,
    };
    const dir = join(ctx.storeRoot, 'curated', curatedRelDir(ctx.resource));
    ensureDir(dir);
    writeFileSync(join(dir, 'data.json'), `${JSON.stringify(parsed, null, 2)}\n`);
    writeFileSync(join(dir, 'schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
    return {
      kind: 'geojson',
      path: relative(join(ctx.storeRoot, 'curated'), join(dir, 'data.json')),
      schema,
      transformRules,
    };
  }
}
