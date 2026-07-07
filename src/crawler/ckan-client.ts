import { ZodError, type ZodTypeAny, type z } from 'zod';
import { PortalApiError } from '../lib/errors.ts';
import {
  CkanErrorEnvelopeSchema,
  type GroupListResponse,
  GroupListResponseSchema,
  type GroupShowResponse,
  GroupShowResponseSchema,
  type OrganizationListResponse,
  OrganizationListResponseSchema,
  type OrganizationShowResponse,
  OrganizationShowResponseSchema,
  type PackageListResponse,
  PackageListResponseSchema,
  type PackageSearchResponse,
  PackageSearchResponseSchema,
  type PackageShowResponse,
  PackageShowResponseSchema,
  type TagListResponse,
  TagListResponseSchema,
} from './ckan-schema.ts';
import type { PortalHttp } from './http.ts';

export interface CkanClientOptions {
  baseUrl: string;
  http: PortalHttp;
}

export interface PackageSearchParams {
  q?: string;
  start?: number;
  rows?: number;
  sort?: string;
  fq?: string;
}

function buildUrl(
  base: string,
  action: string,
  params: Record<string, string | number | undefined>,
): string {
  const url = new URL(action, base.endsWith('/') ? base : `${base}/`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export class CkanClient {
  private readonly baseUrl: string;
  private readonly http: PortalHttp;

  constructor(opts: CkanClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.http = opts.http;
  }

  private async call<S extends ZodTypeAny>(
    action: string,
    params: Record<string, string | number | undefined>,
    schema: S,
  ): Promise<z.infer<S>> {
    const url = buildUrl(this.baseUrl, action, params);
    const res = await this.http.getJson<unknown>(url);
    const errParse = CkanErrorEnvelopeSchema.safeParse(res.body);
    if (errParse.success) {
      throw new PortalApiError(
        `CKAN ${action} returned ${errParse.data.error.__type}: ${errParse.data.error.message ?? ''}`,
        res.status,
        { action, type: errParse.data.error.__type },
      );
    }
    try {
      return schema.parse(res.body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new PortalApiError(`CKAN ${action} schema violation`, res.status, {
          action,
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      throw err;
    }
  }

  packageList(): Promise<PackageListResponse> {
    return this.call('package_list', {}, PackageListResponseSchema);
  }

  packageSearch(params: PackageSearchParams = {}): Promise<PackageSearchResponse> {
    return this.call(
      'package_search',
      {
        q: params.q ?? '*:*',
        start: params.start ?? 0,
        rows: params.rows ?? 100,
        sort: params.sort,
        fq: params.fq,
      },
      PackageSearchResponseSchema,
    );
  }

  packageShow(id: string): Promise<PackageShowResponse> {
    return this.call('package_show', { id }, PackageShowResponseSchema);
  }

  organizationList(): Promise<OrganizationListResponse> {
    return this.call('organization_list', { all_fields: 'true' }, OrganizationListResponseSchema);
  }

  organizationShow(id: string): Promise<OrganizationShowResponse> {
    return this.call('organization_show', { id }, OrganizationShowResponseSchema);
  }

  groupList(): Promise<GroupListResponse> {
    return this.call('group_list', { all_fields: 'true' }, GroupListResponseSchema);
  }

  groupShow(id: string): Promise<GroupShowResponse> {
    return this.call('group_show', { id }, GroupShowResponseSchema);
  }

  tagList(): Promise<TagListResponse> {
    return this.call('tag_list', { all_fields: 'true' }, TagListResponseSchema);
  }
}
