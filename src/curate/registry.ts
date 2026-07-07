import { closeSync, openSync, readSync, statSync } from 'node:fs';
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

/** Bytes sniffed to pick a curator — a bounded prefix, never the whole file (FR-360). */
export const SNIFF_BYTES = 4096;

/**
 * Read at most {@link SNIFF_BYTES} from `path` to pick a curator (FR-360). The chosen curator
 * re-reads the file in full itself, so sniffing MUST NOT `readFileSync` the whole file — on the
 * ~16k-resource mirror that doubled curate I/O and fed the ~20GB full-curate RSS. Open the fd,
 * read a single ≤4KB head buffer, then close. Short files, non-files, and missing paths return an
 * empty/short buffer exactly as before.
 */
export function readHead(path: string): Buffer {
  let fd: number;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return Buffer.alloc(0);
    fd = openSync(path, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const bytesRead = readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}
