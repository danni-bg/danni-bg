import { readFileSync, statSync } from 'node:fs';
import { CsvCurator } from './csv.ts';
import type { CurateContext, CuratedArtifactOutput, Curator } from './curator.ts';
import { DatastoreJsonCurator } from './datastore-json.ts';
import { GeoJsonCurator } from './geojson.ts';
import { JsonCurator } from './json.ts';
import { sniff } from './sniff.ts';
import { TextCurator } from './text.ts';
import { UncuratedMarker } from './uncurated.ts';
import { XlsxCurator } from './xlsx.ts';
import { XmlCurator } from './xml.ts';

export interface RegistryOptions {
  fallback?: Curator;
}

export class CuratorRegistry {
  private readonly curators: Curator[];
  private readonly fallback: Curator;

  constructor(opts: RegistryOptions = {}) {
    this.curators = [
      // First: an egov datastore capture is a verbatim JSON envelope that sniffs as `json`. This
      // gate-guarded curator claims only resources carrying the datastore hint (spec 049 FR-312),
      // and being ahead of `JsonCurator` it wins the sniffed-`json` probe for those captures while
      // a plain JSON resource falls through to `JsonCurator`.
      new DatastoreJsonCurator(),
      new CsvCurator(),
      new XlsxCurator(),
      new GeoJsonCurator(),
      new JsonCurator(),
      new XmlCurator(),
      new TextCurator(),
    ];
    this.fallback = opts.fallback ?? new UncuratedMarker('no curator matched');
  }

  async select(ctx: CurateContext): Promise<Curator> {
    const head = readHead(ctx.rawAbsPath);
    const sniffed = sniff({
      fileName: ctx.resource.source_url,
      declaredFormat: ctx.resource.declared_format,
      declaredContentType: ctx.resource.detected_content_type,
      head,
    });
    const preferred = this.curators.find((c) => c.kind === sniffed.kind);
    if (preferred && (await preferred.canHandle(ctx))) return preferred;
    for (const c of this.curators) {
      if (await c.canHandle(ctx)) return c;
    }
    return this.fallback;
  }

  async curate(ctx: CurateContext): Promise<CuratedArtifactOutput> {
    const curator = await this.select(ctx);
    return curator.curate(ctx);
  }
}

function readHead(path: string): Buffer {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
  const buf = readFileSync(path);
  return buf.subarray(0, Math.min(buf.length, 4096));
}
