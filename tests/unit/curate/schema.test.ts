import { describe, expect, it } from 'bun:test';
import {
  canonicalizeName,
  inferColumnType,
  transliterateCyrillic,
} from '../../../src/curate/schema.ts';

describe('curate.schema', () => {
  it('canonicalizeName turns Cyrillic header into snake_case', () => {
    const taken = new Set<string>();
    const c = canonicalizeName('Бюджет 2025', taken);
    expect(/^[a-z][a-z0-9_]*$/.test(c)).toBe(true);
  });

  it('canonicalizeName transliterates Bulgarian into readable Latin identifiers', () => {
    const t = new Set<string>();
    expect(canonicalizeName('Бюджет 2025', t)).toBe('byudzhet_2025');
    expect(canonicalizeName('Час на тръгване', t)).toBe('chas_na_tragvane');
    expect(canonicalizeName('Пореден №', t)).toBe('poreden_no');
  });

  it('transliterateCyrillic maps multigraphs and preserves non-Cyrillic text/case', () => {
    expect(transliterateCyrillic('Щъркел ABC 7')).toBe('Shtarkel ABC 7');
    expect(transliterateCyrillic('жчшщюя')).toBe('zhchshshtyuya');
  });

  it('canonicalizeName de-duplicates', () => {
    const taken = new Set<string>();
    expect(canonicalizeName('foo', taken)).toBe('foo');
    expect(canonicalizeName('foo', taken)).toBe('foo_1');
    expect(canonicalizeName('foo', taken)).toBe('foo_2');
  });

  it('canonicalizeName prefixes a leading non-letter', () => {
    const taken = new Set<string>();
    const c = canonicalizeName('123', taken);
    expect(c.startsWith('c_')).toBe(true);
  });

  it('canonicalizeName strips a residual non-latin letter that survives normalization', () => {
    // The Greek α is a \p{Letter} so it survives the strip-to-underscore pass, but it is
    // not [a-z0-9_], so the identifier guard rewrites the candidate.
    expect(canonicalizeName('aα', new Set())).toBe('c_a');
  });

  it('inferColumnType returns string on empty samples', () => {
    expect(inferColumnType([]).type).toBe('string');
    expect(inferColumnType([null, '', null]).nullable).toBe(true);
  });

  it('inferColumnType picks integer when most samples are integers', () => {
    const inf = inferColumnType(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(inf.type).toBe('integer');
  });

  it('inferColumnType picks decimal when mostly decimals', () => {
    const inf = inferColumnType([
      '1.5',
      '2.5',
      '3.5',
      '4.5',
      '5.5',
      '6.5',
      '7.5',
      '8.5',
      '9.5',
      '10.5',
    ]);
    expect(inf.type).toBe('decimal');
  });

  it('inferColumnType picks date when most are ISO dates', () => {
    const inf = inferColumnType([
      '2024-01-01',
      '2024-02-01',
      '2024-03-01',
      '2024-04-01',
      '2024-05-01',
      '2024-06-01',
      '2024-07-01',
      '2024-08-01',
      '2024-09-01',
      '2024-10-01',
    ]);
    expect(['date', 'datetime']).toContain(inf.type);
    expect(inf.format).toBe('iso8601');
  });

  it('inferColumnType picks datetime when timestamps are present', () => {
    const inf = inferColumnType([
      '2024-01-01T00:00:00Z',
      '2024-02-01T00:00:00Z',
      '2024-03-01T00:00:00Z',
      '2024-04-01T00:00:00Z',
      '2024-05-01T00:00:00Z',
      '2024-06-01T00:00:00Z',
      '2024-07-01T00:00:00Z',
      '2024-08-01T00:00:00Z',
      '2024-09-01T00:00:00Z',
      '2024-10-01T00:00:00Z',
    ]);
    expect(inf.type).toBe('datetime');
  });

  it('inferColumnType picks boolean when most are bool-like', () => {
    const inf = inferColumnType([
      'да',
      'не',
      'true',
      'false',
      'yes',
      'no',
      'да',
      'не',
      'true',
      'false',
    ]);
    expect(inf.type).toBe('boolean');
  });

  it('inferColumnType falls back to string when mixed', () => {
    const inf = inferColumnType(['hello', 'world', '2024-01-01']);
    expect(inf.type).toBe('string');
  });
});
