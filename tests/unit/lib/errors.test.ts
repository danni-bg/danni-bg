import { describe, expect, it } from 'bun:test';
import {
  CkanApiError,
  ConfigError,
  DanniError,
  EmbedderHttpError,
  MigrationError,
  PortalApiError,
  RetryExhausted,
} from '../../../src/lib/errors.ts';

describe('errors.DanniError', () => {
  it('captures code, message, and details', () => {
    const e = new DanniError('X', 'oops', { foo: 1 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('DanniError');
    expect(e.code).toBe('X');
    expect(e.message).toBe('oops');
    expect(e.details).toEqual({ foo: 1 });
  });

  it('serializes to JSON for logging', () => {
    const e = new DanniError('X', 'oops', { foo: 1 });
    expect(e.toJSON()).toEqual({
      name: 'DanniError',
      code: 'X',
      message: 'oops',
      details: { foo: 1 },
    });
  });

  it('defaults details to an empty object', () => {
    const e = new DanniError('X', 'm');
    expect(e.details).toEqual({});
  });
});

describe('errors specializations', () => {
  it('ConfigError carries CONFIG_INVALID code', () => {
    const e = new ConfigError('bad');
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.name).toBe('ConfigError');
  });

  it('PortalApiError carries httpStatus and PORTAL_API_ERROR code (spec 056 FR-390)', () => {
    const e = new PortalApiError('bad', 503, { x: 1 });
    expect(e).toBeInstanceOf(DanniError);
    expect(e.name).toBe('PortalApiError');
    expect(e.code).toBe('PORTAL_API_ERROR');
    expect(e.httpStatus).toBe(503);
    expect(e.details['httpStatus']).toBe(503);
    expect(e.details['x']).toBe(1);
  });

  it('deprecated CkanApiError alias resolves to PortalApiError (spec 056 FR-390)', () => {
    // Kept one release for external importers; a value thrown as CkanApiError is a PortalApiError.
    expect(CkanApiError).toBe(PortalApiError);
    const e = new CkanApiError('bad', 500);
    expect(e).toBeInstanceOf(PortalApiError);
    expect(e.code).toBe('PORTAL_API_ERROR');
  });

  it('EmbedderHttpError carries httpStatus (spec 054 FR-362)', () => {
    const e = new EmbedderHttpError('Embedder https://api/x returned HTTP 429', 429);
    expect(e).toBeInstanceOf(DanniError);
    expect(e.name).toBe('EmbedderHttpError');
    expect(e.code).toBe('EMBEDDER_HTTP_ERROR');
    expect(e.httpStatus).toBe(429);
    expect(e.details['httpStatus']).toBe(429);
  });

  it('RetryExhausted is a DanniError', () => {
    const e = new RetryExhausted('done');
    expect(e.code).toBe('RETRY_EXHAUSTED');
  });

  it('MigrationError exposes its code', () => {
    const e = new MigrationError('m');
    expect(e.code).toBe('MIGRATION_FAILED');
  });
});
