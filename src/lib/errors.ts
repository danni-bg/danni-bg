export class DanniError extends Error {
  override readonly name: string = 'DanniError';
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }

  toJSON(): { name: string; code: string; message: string; details: Record<string, unknown> } {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export class ConfigError extends DanniError {
  override readonly name: string = 'ConfigError';
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('CONFIG_INVALID', message, details);
  }
}

export class PortalApiError extends DanniError {
  override readonly name: string = 'PortalApiError';
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number, details: Record<string, unknown> = {}) {
    super('PORTAL_API_ERROR', message, { ...details, httpStatus });
    this.httpStatus = httpStatus;
  }
}

/**
 * @deprecated Renamed to {@link PortalApiError} (spec 056 FR-390) — the error is thrown by every
 * portal client (CKAN and the non-CKAN egov-bg API), not just CKAN. Kept as an alias for one release
 * so any external importer (this repo is published EUPL open-core) keeps compiling; remove thereafter.
 */
export const CkanApiError = PortalApiError;
export type CkanApiError = PortalApiError;

export class EmbedderHttpError extends DanniError {
  override readonly name: string = 'EmbedderHttpError';
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number, details: Record<string, unknown> = {}) {
    super('EMBEDDER_HTTP_ERROR', message, { ...details, httpStatus });
    this.httpStatus = httpStatus;
  }
}

export class RetryExhausted extends DanniError {
  override readonly name: string = 'RetryExhausted';
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('RETRY_EXHAUSTED', message, details);
  }
}

export class MigrationError extends DanniError {
  override readonly name: string = 'MigrationError';
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('MIGRATION_FAILED', message, details);
  }
}
