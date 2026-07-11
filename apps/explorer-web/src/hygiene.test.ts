// Structure-hygiene guards (spec 060). These assert the wire-or-delete verdicts stay enforced:
// dataset selection lives in the store (no onSelectDataset prop), the shadcn input/textarea primitives
// are used (no hand-rolled input class blobs), formatting is centralised in lib/format.ts, and the dead
// exports are gone. Hermetic: it reads the source tree via import.meta.dir — no DOM harness, matching
// the useServerState/useChatSession logic-level precedent.

import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = import.meta.dir;
const rel = readdirSync(SRC, { recursive: true })
  .map(String)
  .filter((f) => /\.(ts|tsx)$/.test(f));
// Production files only — the greps in the success criteria target real code, and excluding tests
// keeps this spec's own pattern strings (below) from self-matching.
const prod = rel.filter((f) => !/\.test\.tsx?$/.test(f));
const sources = new Map(prod.map((f) => [f, readFileSync(join(SRC, f), 'utf8')]));
const filesWith = (re: RegExp) => prod.filter((f) => re.test(sources.get(f) ?? ''));

describe('spec 060 structure hygiene', () => {
  it('SC-1: dataset selection has no onSelectDataset prop drilling', () => {
    expect(filesWith(/onSelectDataset/)).toEqual([]);
  });

  it('SC-4: locale formatting lives only in lib/format.ts', () => {
    const offenders = filesWith(/Intl\.NumberFormat|Intl\.DateTimeFormat|toLocaleString/).filter(
      (f) => f !== join('lib', 'format.ts'),
    );
    expect(offenders).toEqual([]);
  });

  it('SC-4: exactly one initials definition exists', () => {
    expect(filesWith(/function initials\b/)).toEqual([join('lib', 'format.ts')]);
  });

  it('SC-5: the dead exports are deleted', () => {
    for (const name of [
      /\bcycleTheme\b/,
      /\bRequireAuth\b/,
      /\bfetchRegion\b/, // word-boundary: must NOT flag the surviving fetchRegions
      /\bisEmptyFilter\b/,
      /\btranslationNote\b/,
      /\bbilingualLabel\b/,
      /\bLang\b/,
    ]) {
      expect(filesWith(name)).toEqual([]);
    }
  });

  it('SC-3: the input/textarea primitives each have ≥1 importer', () => {
    expect(filesWith(/components\/ui\/input\.tsx/).length).toBeGreaterThan(0);
    expect(filesWith(/components\/ui\/textarea\.tsx/).length).toBeGreaterThan(0);
  });

  it('SC-3: the input class blob appears only in the primitives', () => {
    const blob = /rounded.*border.*border-input bg-background px-/;
    const offenders = filesWith(blob).filter(
      (f) =>
        f !== join('components', 'ui', 'input.tsx') &&
        f !== join('components', 'ui', 'textarea.tsx'),
    );
    expect(offenders).toEqual([]);
  });

  it('SC-2: KratosFlow imports nothing from account/', () => {
    const kratos = sources.get(join('auth', 'KratosFlow.tsx')) ?? '';
    expect(kratos).not.toMatch(/from '\.\.\/account\//);
  });

  it('spec 066: the routed settings shell mounts every account + platform section', () => {
    const main = sources.get('main.tsx') ?? '';
    // The routed SettingsLayout shell replaces the old monolithic AccountPage (spec 060 FR-431 superseded).
    expect(main).toContain('SettingsLayout');
    expect(main).toContain('path="/auth/settings"');
    expect(main).toContain('path="/admin/settings"'); // platform is its own page (spec 066b)
    for (const section of [
      'ProfileSection',
      'SecuritySection',
      'AppearanceSection',
      'SelfUsage',
      'ApiKeys',
      'Organizations',
      'PlatformLlmSettings',
      'AdminUsage',
      'OrgEntitlements',
    ]) {
      expect(main).toContain(section);
    }
    // The old single-page composition is gone; profile identity still composes the Kratos sections.
    expect(sources.has(join('account', 'AccountPage.tsx'))).toBe(false);
    expect(sources.get(join('account', 'ProfileSection.tsx')) ?? '').toContain(
      'KratosSettingsSections',
    );
  });
});
