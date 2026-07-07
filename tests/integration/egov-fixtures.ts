import type { EgovBgClient } from '../../src/crawler/egov-bg-client.ts';

/**
 * In-memory, instrumented multi-dataset fake `EgovBgClient` for the 004 resume / bounded-session /
 * edge-case integration tests. Serves a configurable multi-page `listDatasets` set, per-dataset
 * details (with mutable `updated_at`/`version` validators) + resources, and counts every call so a
 * test can assert "no fetch on resume" (SC-001) and "no discovery once completed" (SC-005).
 */

export interface FakeResource {
  uri: string;
  /** array-of-arrays (tabular → CSV) or a single object (structured → JSON). */
  data: unknown[] | Record<string, unknown>;
  /** When set, getResourceData throws this message (persistent failure). */
  fail?: string;
}

export interface FakeDataset {
  uri: string;
  name: string;
  orgId: number;
  updatedAt: string;
  version: string;
  resources: FakeResource[];
}

export interface FakeCallCounts {
  listDatasets: number;
  getDatasetDetails: Record<string, number>;
  getResourceData: Record<string, number>;
}

export class FakeEgovCatalog {
  private datasets: FakeDataset[];
  readonly calls: FakeCallCounts = {
    listDatasets: 0,
    getDatasetDetails: {},
    getResourceData: {},
  };
  /** uris removed from discovery (still resolvable by details if requested). */
  private hidden = new Set<string>();

  constructor(
    datasets: FakeDataset[],
    private readonly pageSize = 100,
  ) {
    this.datasets = datasets;
  }

  /** Bump one dataset's validator (updated_at/version) to force a re-fetch on resume. */
  bump(uri: string, updatedAt: string, version: string): void {
    const d = this.datasets.find((x) => x.uri === uri);
    if (!d) throw new Error(`bump: unknown dataset ${uri}`);
    d.updatedAt = updatedAt;
    d.version = version;
  }

  /** Add a new dataset to the catalog (catalog-change reconciliation). */
  add(d: FakeDataset): void {
    this.datasets.push(d);
  }

  /** Hide a dataset from discovery (it vanished upstream). */
  hide(uri: string): void {
    this.hidden.add(uri);
  }

  resourceDataCalls(uri: string): number {
    return this.calls.getResourceData[uri] ?? 0;
  }

  private visible(): FakeDataset[] {
    return this.datasets.filter((d) => !this.hidden.has(d.uri));
  }

  client(): EgovBgClient {
    return {
      listDatasets: async ({ pageNumber }: { recordsPerPage?: number; pageNumber?: number }) => {
        this.calls.listDatasets++;
        const all = this.visible();
        const page = pageNumber ?? 1;
        const slice = all.slice((page - 1) * this.pageSize, page * this.pageSize);
        return {
          success: true,
          total_records: all.length,
          datasets: slice.map((d) => ({ id: d.orgId, uri: d.uri, name: d.name, org_id: d.orgId })),
        };
      },
      getDatasetDetails: async (datasetUri: string) => {
        this.calls.getDatasetDetails[datasetUri] =
          (this.calls.getDatasetDetails[datasetUri] ?? 0) + 1;
        const d = this.datasets.find((x) => x.uri === datasetUri);
        if (!d) throw new Error(`getDatasetDetails: unknown ${datasetUri}`);
        return {
          success: true,
          data: {
            uri: d.uri,
            name: d.name,
            org_id: d.orgId,
            updated_at: d.updatedAt,
            version: d.version,
            tags: [{ name: 'данни' }],
          },
        };
      },
      listResources: async (datasetUri: string) => {
        const d = this.datasets.find((x) => x.uri === datasetUri);
        if (!d) throw new Error(`listResources: unknown ${datasetUri}`);
        return {
          success: true,
          resources: d.resources.map((r) => ({
            uri: r.uri,
            dataset_uri: d.uri,
            name: r.uri,
            file_format: Array.isArray(r.data) ? 'CSV' : 'JSON',
          })),
        };
      },
      getResourceData: async (resourceUri: string) => {
        this.calls.getResourceData[resourceUri] =
          (this.calls.getResourceData[resourceUri] ?? 0) + 1;
        for (const d of this.datasets) {
          const r = d.resources.find((x) => x.uri === resourceUri);
          if (r) {
            if (r.fail) throw new Error(r.fail);
            // Verbatim response body (spec 049): capture stores these exact bytes as raw.json.
            return JSON.stringify({ success: true, data: r.data });
          }
        }
        throw new Error(`getResourceData: unknown ${resourceUri}`);
      },
      listOrganisations: async () => ({
        success: true,
        total_records: 1,
        organisations: [{ id: 1, uri: 'org-1', name: 'Тестова организация' }],
      }),
    } as unknown as EgovBgClient;
  }
}

let seq = 0;
function tabular(): unknown[] {
  return [
    ['ОБЛАСТ', 'СТОЙНОСТ'],
    ['София', String(++seq)],
    ['Пловдив', String(++seq)],
  ];
}

/** Build N datasets, each with `resourcesPer` tabular resources, deterministic uris (sorted). */
export function makeCatalog(n: number, resourcesPer = 2, pageSize = 100): FakeEgovCatalog {
  seq = 0;
  const datasets: FakeDataset[] = [];
  for (let i = 0; i < n; i++) {
    const uri = `ds-${String(i).padStart(3, '0')}`;
    const resources: FakeResource[] = [];
    for (let j = 0; j < resourcesPer; j++) {
      resources.push({ uri: `${uri}-r${j}`, data: tabular() });
    }
    datasets.push({
      uri,
      name: `Набор ${i}`,
      orgId: 1,
      updatedAt: `2026-06-01 10:00:0${i % 10}`,
      version: '1.0',
      resources,
    });
  }
  return new FakeEgovCatalog(datasets, pageSize);
}
