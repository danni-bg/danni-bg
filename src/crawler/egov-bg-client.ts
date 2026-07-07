import { ZodError, type ZodTypeAny, type z } from 'zod';
import { PortalApiError } from '../lib/errors.ts';
import {
  DatasetDetailsResponseSchema,
  EgovErrorEnvelopeSchema,
  ListDatasetsResponseSchema,
  ListOrganisationsResponseSchema,
  ListResourcesResponseSchema,
} from './egov-bg-schema.ts';
import type { PortalHttp } from './http.ts';

export interface EgovBgClientOptions {
  /** Portal API base, e.g. "https://data.egov.bg/api/". */
  baseUrl: string;
  http: PortalHttp;
  /** Optional api_key (read endpoints are public; key is sent when provided). */
  apiKey?: string | undefined;
}

function joinUrl(base: string, method: string): string {
  return new URL(method, base.endsWith('/') ? base : `${base}/`).toString();
}

/**
 * Client for data.egov.bg's custom API (governmentbg/data-gov-bg): every method
 * is a POST to `<base>/<method>` with a JSON body and a `{success, ...}` envelope.
 */
export class EgovBgClient {
  private readonly baseUrl: string;
  private readonly http: PortalHttp;
  private readonly apiKey: string | undefined;

  constructor(opts: EgovBgClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.http = opts.http;
    this.apiKey = opts.apiKey;
  }

  private async call<S extends ZodTypeAny>(
    method: string,
    body: Record<string, unknown>,
    schema: S,
  ): Promise<z.infer<S>> {
    const url = joinUrl(this.baseUrl, method);
    // Configured api_key is authoritative — spread body first so it can't override.
    const payload = this.apiKey ? { ...body, api_key: this.apiKey } : body;
    const res = await this.http.postJson<unknown>(url, payload);
    const err = EgovErrorEnvelopeSchema.safeParse(res.body);
    if (err.success) throw this.errorFromEnvelope(method, res.status, err.data);
    try {
      return schema.parse(res.body);
    } catch (e) {
      if (e instanceof ZodError) {
        throw new PortalApiError(`egov-bg ${method} schema violation`, res.status, {
          action: method,
          issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      throw e;
    }
  }

  /** Build the `PortalApiError` for a `{success:false}` envelope (shared by `call` + `getResourceData`). */
  private errorFromEnvelope(
    method: string,
    status: number,
    data: z.infer<typeof EgovErrorEnvelopeSchema>,
  ): PortalApiError {
    const errObj = data.error;
    const type =
      errObj && typeof errObj === 'object' && 'type' in errObj
        ? String((errObj as { type: unknown }).type)
        : typeof errObj === 'string'
          ? errObj
          : 'error';
    const fieldErrors = data.errors ? ` ${JSON.stringify(data.errors)}` : '';
    return new PortalApiError(`egov-bg ${method} failed: ${type}${fieldErrors}`, status, {
      action: method,
    });
  }

  listDatasets(params: { recordsPerPage?: number; pageNumber?: number } = {}) {
    return this.call(
      'listDatasets',
      { records_per_page: params.recordsPerPage ?? 100, page_number: params.pageNumber ?? 1 },
      ListDatasetsResponseSchema,
    );
  }

  getDatasetDetails(datasetUri: string, locale = 'bg') {
    return this.call(
      'getDatasetDetails',
      { dataset_uri: datasetUri, locale },
      DatasetDetailsResponseSchema,
    );
  }

  listResources(datasetUri: string) {
    return this.call(
      'listResources',
      { criteria: { dataset_uri: datasetUri } },
      ListResourcesResponseSchema,
    );
  }

  /**
   * Fetch a resource's datastore content and return the VERBATIM response body text — the exact
   * bytes the portal sent, for a byte-faithful `store/raw/` capture (spec 049 FR-310). The envelope
   * is parsed ONLY to surface an error envelope (or a non-JSON body) as a thrown failure; a
   * successful body is returned untouched — no field extraction, defaulting, or re-serialization.
   * Shape handling (array-of-arrays → CSV, absent data, etc.) is the datastore-JSON curator's job.
   * (Kept non-`async` so the constitution endpoint-parity gate still matches `getResourceData(`.)
   */
  getResourceData(resourceUri: string): Promise<string> {
    return this.captureResourceData(resourceUri);
  }

  private async captureResourceData(resourceUri: string): Promise<string> {
    const url = joinUrl(this.baseUrl, 'getResourceData');
    const body = { resource_uri: resourceUri };
    const payload = this.apiKey ? { ...body, api_key: this.apiKey } : body;
    const res = await this.http.postText(url, payload);
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new PortalApiError(
        `egov-bg getResourceData returned non-JSON (status ${res.status}): ${res.text.slice(0, 200)}`,
        res.status,
        { action: 'getResourceData' },
      );
    }
    const err = EgovErrorEnvelopeSchema.safeParse(parsed);
    if (err.success) throw this.errorFromEnvelope('getResourceData', res.status, err.data);
    return res.text;
  }

  listOrganisations(params: { recordsPerPage?: number; pageNumber?: number } = {}) {
    return this.call(
      'listOrganisations',
      {
        criteria: {},
        records_per_page: params.recordsPerPage ?? 100,
        page_number: params.pageNumber ?? 1,
      },
      ListOrganisationsResponseSchema,
    );
  }
}
