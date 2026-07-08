import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ensureDir } from '../lib/fs.ts';
import type {
  CurateContext,
  CuratedArtifactOutput,
  Curator,
  TransformRule,
  XmlSchema,
} from './curator.ts';
import { curatedRelDir } from './curator.ts';
import { decodeBytes, detectEncoding } from './encoding.ts';

function findRootElement(text: string): string {
  // Skip declarations / comments / whitespace, then capture the first element name.
  const m = /<([A-Za-z_][\w:.-]*)/m.exec(
    text.replace(/<\?xml[^?]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, ''),
  );
  return m?.[1] ?? 'unknown';
}

export class XmlCurator implements Curator {
  readonly kind: 'xml';

  constructor() {
    this.kind = 'xml';
  }

  canHandle(ctx: CurateContext): boolean {
    const fmt = (ctx.resource.declared_format ?? '').toLowerCase();
    if (fmt === 'xml') return true;
    return ctx.resource.source_url.toLowerCase().endsWith('.xml');
  }

  async curate(ctx: CurateContext): Promise<CuratedArtifactOutput> {
    const bytes = readFileSync(ctx.rawAbsPath);
    const detection = detectEncoding(bytes);
    const text = decodeBytes(bytes, detection.encoding);
    const transformRules: TransformRule[] = [];
    if (detection.encoding === 'cp1251') {
      transformRules.push({ rule: 'utf8-from-windows1251', appliedTo: '*' });
    }
    const rootElement = findRootElement(text);
    const schema: XmlSchema = {
      kind: 'xml',
      encoding: 'utf-8',
      rootElement,
      transformRules,
    };
    const dir = join(ctx.storeRoot, 'curated', curatedRelDir(ctx.resource));
    ensureDir(dir);
    writeFileSync(join(dir, 'data.xml'), text);
    writeFileSync(join(dir, 'schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
    return {
      kind: 'xml',
      path: relative(join(ctx.storeRoot, 'curated'), join(dir, 'data.xml')),
      schema,
      transformRules,
    };
  }
}
