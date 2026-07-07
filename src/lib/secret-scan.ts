// Secret-placeholder guard (spec 030, FR-136 / SC-D3). A deployment must never ship the committed dev
// placeholders (e.g. Kratos `PLEASE-CHANGE-ME-I-AM-VERY-INSECURE`) to a non-dev profile. This is the
// pure audit core; `scripts/check-secrets.ts` wraps it as a CI/release gate that exits non-zero.
//
// Scope: it inspects the resolved ENVIRONMENT (the deploy's source of truth — prod overrides the YAML
// placeholders via env). For a dev/test/ci/local profile, placeholders are allowed and it is a no-op.

/** Profiles where the committed placeholders are acceptable (local development + CI). */
export const DEV_PROFILES = new Set(['dev', 'development', 'test', 'local', 'ci']);

/** Values that betray an unset/insecure placeholder rather than a real secret. */
export const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /change[\s_-]?me/i,
  /please[\s_-]?change/i,
  /insecure/i,
  /not[\s_-]?secure/i,
  /placeholder/i,
  /\bexample\b/i,
  /^empty$/i,
  /^kratos$/i, // the dev Kratos Postgres password / DSN credential
];

/** Env var NAMES that carry a secret (so we only flag placeholder VALUES on secret-bearing vars). */
const SECRET_NAME =
  /(SECRET|PASSWORD|PASSWD|CIPHER|COOKIE|API_?KEY|TOKEN|PRIVATE_?KEY|DSN|DATABASE_URL)/i;

/** An SMTP URI pointing at the dev Mailpit catcher or any loopback host — never a real relay. */
const DEV_SMTP_HOST =
  /\/\/(?:[^@/\s]*@)?(?:mailpit|localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?]|$)/i;

/**
 * Per-variable VALUE validators for vars the generic `SECRET_NAME` regex does not cover (spec 037,
 * FR-191). Returns true when the value is a placeholder / non-production value.
 */
const VALUE_CHECKS: Readonly<Record<string, (value: string) => boolean>> = {
  // Kratos courier: recovery/verification mail is account-takeover material, so the URI must point
  // at a real operator-configured relay — never the dev Mailpit sink or a loopback host.
  COURIER_SMTP_CONNECTION_URI: (value) => isPlaceholder(value) || DEV_SMTP_HOST.test(value.trim()),
};

/** Secrets that MUST be present (and non-placeholder) on a non-dev profile. */
export const REQUIRED_SECRETS: readonly string[] = [
  'KRATOS_SECRETS_COOKIE',
  'KRATOS_SECRETS_CIPHER',
  // Spec 037 (FR-190): production account mail needs a real SMTP relay, not the dev Mailpit.
  'COURIER_SMTP_CONNECTION_URI',
];

export interface SecretViolation {
  name: string;
  reason: 'placeholder' | 'missing';
}

export interface SecretAudit {
  profile: string;
  isDev: boolean;
  violations: SecretViolation[];
}

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value.trim()));
}

/**
 * Audit a resolved environment for placeholder/missing secrets. Returns no violations for a dev-like
 * profile; for any other profile, flags required secrets that are missing, any secret-named var
 * still holding a placeholder value, and any var whose `VALUE_CHECKS` validator rejects its value
 * (e.g. a Mailpit-shaped courier SMTP URI, spec 037).
 */
export function auditSecrets(
  env: Record<string, string | undefined>,
  opts: { profile?: string; required?: readonly string[] } = {},
): SecretAudit {
  const profile = (opts.profile ?? env.DANNI_PROFILE ?? 'dev').toLowerCase();
  const isDev = DEV_PROFILES.has(profile);
  if (isDev) return { profile, isDev, violations: [] };

  const required = opts.required ?? REQUIRED_SECRETS;
  const violations: SecretViolation[] = [];
  const flagged = new Set<string>();

  for (const name of required) {
    const v = env[name];
    if (v == null || v.trim() === '') {
      violations.push({ name, reason: 'missing' });
      flagged.add(name);
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (flagged.has(name) || !value) continue;
    const badValue = VALUE_CHECKS[name]
      ? VALUE_CHECKS[name](value)
      : SECRET_NAME.test(name) && isPlaceholder(value);
    if (badValue) {
      violations.push({ name, reason: 'placeholder' });
      flagged.add(name);
    }
  }
  return { profile, isDev, violations };
}
