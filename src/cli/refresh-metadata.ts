import { resolve } from 'node:path';
import { loadConfig } from '../config/loader.ts';
import { EgovBgClient } from '../crawler/egov-bg-client.ts';
import { buildPortalHttp } from '../crawler/portal-sync.ts';
import { refreshMetadata } from '../crawler/refresh-metadata.ts';
import { openDb } from '../store/db.ts';
import { DatasetsRepo } from '../store/repos/datasets.ts';

/**
 * `danni refresh-metadata` — re-fetch each dataset's portal details and backfill its source
 * timestamps (metadata_created/metadata_modified) without re-downloading resources. The cheap way
 * to fix freshness across the whole mirror; a full content refresh is `danni sync`.
 */
/** Injectable seam (tests): the networked metadata backfill. Defaults to the real implementation. */
export interface RefreshMetadataRunDeps {
  refreshMetadata?: typeof refreshMetadata;
}

export async function run(args: string[], deps: RefreshMetadataRunDeps = {}): Promise<number> {
  const refreshMetadataFn = deps.refreshMetadata ?? refreshMetadata;
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('danni refresh-metadata\n');
    return 0;
  }
  const config = loadConfig();
  const storeRoot = resolve(process.cwd(), config.store.root);
  const db = openDb({ storeRoot, loadVec: false });
  try {
    if (config.portal.api !== 'egov-bg') {
      process.stderr.write('refresh-metadata supports the egov-bg portal only\n');
      return 2;
    }
    const http = buildPortalHttp(config);
    const apiKey = config.portal.apiKeyEnv ? process.env[config.portal.apiKeyEnv] : undefined;
    const client = new EgovBgClient({ baseUrl: config.portal.baseUrl, http, apiKey });
    const result = await refreshMetadataFn({ repo: new DatasetsRepo(db), client });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    // Fail only if nothing refreshed at all (total failure); partial failures are reported in the JSON.
    return result.total > 0 && result.refreshed === 0 ? 4 : 0;
  } finally {
    db.close();
  }
}
