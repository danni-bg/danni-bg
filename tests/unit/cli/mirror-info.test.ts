import { describe, expect, it } from 'bun:test';
import { parseFlags, run } from '../../../src/cli/mirror-info.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { TranslationsRepo } from '../../../src/store/repos/translations.ts';
import {
  baseConfig,
  captureIO,
  tmpStore,
  withConfig,
  withMigratedStore,
  writeConfig,
} from './_cli-fixture.ts';

function seededConfig(withEn = false): string {
  const storeRoot = tmpStore();
  withMigratedStore(storeRoot, (db) => {
    new DatasetsRepo(db).upsert({
      id: 'd-1',
      slug: 'd-1',
      titleBg: 'Тестов набор',
      tags: [],
      groups: [],
      sourceUrl: 'https://data.egov.bg/data/view/d-1',
    });
    if (withEn) {
      new TranslationsRepo(db).upsert({
        subjectKind: 'dataset_title',
        subjectId: 'd-1',
        textBg: 'Тестов набор',
        textEn: 'Test dataset',
        translator: 't-1',
        confidence: 0.9,
      });
    }
  });
  return writeConfig(baseConfig(storeRoot));
}

describe('cli.mirror-info parseFlags', () => {
  it('parses id and --json', () => {
    expect(parseFlags(['d-1']).id).toBe('d-1');
    expect(parseFlags(['d-1', '--json']).flags.json).toBe(true);
  });
  it('throws __HELP__ on --help', () => {
    expect(() => parseFlags(['--help'])).toThrow('__HELP__');
  });
  it('throws on a missing id and on an unknown flag', () => {
    expect(() => parseFlags([])).toThrow(/missing <dataset_id>/);
    expect(() => parseFlags(['--nope'])).toThrow(/unknown flag/);
  });
});

describe('cli.mirror-info run()', () => {
  it('returns 0 on --help', async () => {
    const io = captureIO();
    try {
      expect(await run(['--help'])).toBe(0);
    } finally {
      io.restore();
    }
  });

  it('returns 2 on a parse error', async () => {
    const io = captureIO();
    try {
      expect(await run(['--nope'])).toBe(2);
    } finally {
      io.restore();
    }
  });

  it('returns 4 when the dataset is not found', async () => {
    const cfg = seededConfig();
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['nope']))).toBe(4);
    } finally {
      io.restore();
    }
    expect(io.err.join('')).toContain('not found');
  });

  it('prints the human view (incl. the en title line)', async () => {
    const cfg = seededConfig(true);
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['d-1']))).toBe(0);
    } finally {
      io.restore();
    }
    const out = io.out.join('');
    expect(out).toContain('Dataset: d-1');
    expect(out).toContain('Тестов набор');
    expect(out).toContain('Title (en): Test dataset');
  });

  it('emits JSON with --json', async () => {
    const cfg = seededConfig();
    const io = captureIO();
    try {
      expect(await withConfig(cfg, () => run(['d-1', '--json']))).toBe(0);
    } finally {
      io.restore();
    }
    const view = JSON.parse(io.out.join('')) as { datasetId: string };
    expect(view.datasetId).toBe('d-1');
  });
});
