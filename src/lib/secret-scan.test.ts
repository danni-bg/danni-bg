import { describe, expect, it } from 'bun:test';
import { auditSecrets, isPlaceholder } from './secret-scan.ts';

describe('secret-scan (spec 030)', () => {
  const realSecrets = {
    KRATOS_SECRETS_COOKIE: 'b7f3c1d9e2a45f6890ab12cd34ef56a7',
    KRATOS_SECRETS_CIPHER: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    COURIER_SMTP_CONNECTION_URI: 'smtps://apikey:SG.x9y8z7@smtp.sendrelay.eu:465',
  };

  it('isPlaceholder catches the committed dev placeholders', () => {
    expect(isPlaceholder('PLEASE-CHANGE-ME-I-AM-VERY-INSECURE')).toBe(true);
    expect(isPlaceholder('32-LONG-SECRET-NOT-SECURE-AT-ALL')).toBe(true);
    expect(isPlaceholder('kratos')).toBe(true);
    expect(isPlaceholder('EMPTY')).toBe(true);
    expect(isPlaceholder('a-genuinely-random-32-char-secret-x')).toBe(false);
  });

  it('is a no-op for dev-like profiles even with placeholders present', () => {
    const env = { DANNI_PROFILE: 'dev', KRATOS_SECRETS_COOKIE: 'PLEASE-CHANGE-ME' };
    const a = auditSecrets(env);
    expect(a.isDev).toBe(true);
    expect(a.violations).toEqual([]);
    // ci is treated as dev-like too.
    expect(auditSecrets({ ...env, DANNI_PROFILE: 'ci' }).violations).toEqual([]);
  });

  it('flags placeholder values on secret-named vars for a non-dev profile', () => {
    const a = auditSecrets({
      DANNI_PROFILE: 'production',
      ...realSecrets,
      EXPLORER_DEFAULT_API_KEY: 'EMPTY',
      POSTGRES_PASSWORD: 'kratos',
    });
    expect(a.isDev).toBe(false);
    const names = a.violations.map((v) => v.name).sort();
    expect(names).toEqual(['EXPLORER_DEFAULT_API_KEY', 'POSTGRES_PASSWORD']);
    expect(a.violations.every((v) => v.reason === 'placeholder')).toBe(true);
  });

  it('flags missing required secrets for a non-dev profile', () => {
    const a = auditSecrets({ DANNI_PROFILE: 'staging' });
    const missing = a.violations.filter((v) => v.reason === 'missing').map((v) => v.name);
    expect(missing).toEqual([
      'KRATOS_SECRETS_COOKIE',
      'KRATOS_SECRETS_CIPHER',
      'COURIER_SMTP_CONNECTION_URI',
    ]);
  });

  it('passes (no violations) when a non-dev profile has real secrets', () => {
    const a = auditSecrets({ DANNI_PROFILE: 'production', ...realSecrets });
    expect(a.violations).toEqual([]);
  });

  it('does not flag a non-secret-named var that happens to contain a placeholder word', () => {
    const a = auditSecrets({
      DANNI_PROFILE: 'production',
      ...realSecrets,
      PUBLIC_HOST: 'example.com',
    });
    expect(a.violations).toEqual([]);
  });

  describe('courier SMTP URI (spec 037)', () => {
    const withCourier = (uri?: string) => ({
      DANNI_PROFILE: 'production',
      ...realSecrets,
      COURIER_SMTP_CONNECTION_URI: uri,
    });

    it('FR-190: a non-dev profile requires COURIER_SMTP_CONNECTION_URI', () => {
      for (const env of [withCourier(undefined), withCourier('')]) {
        const a = auditSecrets(env);
        expect(a.violations).toEqual([{ name: 'COURIER_SMTP_CONNECTION_URI', reason: 'missing' }]);
      }
    });

    it('FR-191: Mailpit/loopback-shaped URIs count as placeholder values', () => {
      const nonProduction = [
        'smtp://mailpit:1025/?disable_starttls=true', // the committed dev sink
        'smtp://mailpit:1025',
        'smtp://localhost:1025/?disable_starttls=true',
        'smtp://user:pass@localhost:587',
        'smtps://127.0.0.1:465',
        'smtp://relay.change-me.tld:587', // generic PLACEHOLDER_PATTERNS still apply
      ];
      for (const uri of nonProduction) {
        const a = auditSecrets(withCourier(uri));
        expect(a.violations).toEqual([
          { name: 'COURIER_SMTP_CONNECTION_URI', reason: 'placeholder' },
        ]);
      }
    });

    it('FR-191: a real relay URI passes (incl. hosts merely containing "mailpit")', () => {
      const real = [
        'smtps://apikey:SG.x9y8z7@smtp.sendrelay.eu:465',
        'smtp://postmaster%40danni.bg:s3cr3t@smtp.mailgun.org:587',
        'smtps://mailpit.corp-relay.tld:465', // subdomain label, not the bare dev host
      ];
      for (const uri of real) {
        expect(auditSecrets(withCourier(uri)).violations).toEqual([]);
      }
    });

    it('FR-193: dev profiles keep the Mailpit URI without violations', () => {
      const a = auditSecrets({
        DANNI_PROFILE: 'dev',
        COURIER_SMTP_CONNECTION_URI: 'smtp://mailpit:1025/?disable_starttls=true',
      });
      expect(a.isDev).toBe(true);
      expect(a.violations).toEqual([]);
    });
  });
});
