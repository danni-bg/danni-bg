#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const matrixPath = join(ROOT, 'tests', 'parity-matrix.json');
const matrix = JSON.parse(readFileSync(matrixPath, 'utf-8')) as Record<string, unknown>;

const errors: string[] = [];

const entriesOf = (section: string): { name: string; testId: string }[] => {
  const v = matrix[section];
  return Array.isArray(v) ? (v as { name: string; testId: string }[]) : [];
};

// 1) Completeness: every consumed portal endpoint / cataloged dataset family has a matrix entry.
const portalDir = join(ROOT, 'specs', 'portal-api');
if (existsSync(portalDir)) {
  const consumed = readdirSync(portalDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'scale.md')
    .map((f) => f.replace(/\.md$/, ''));
  for (const ep of consumed) {
    if (!entriesOf('endpoints').some((e) => e.name === ep)) {
      errors.push(`portal-api endpoint '${ep}' has no entry in parity-matrix.json#endpoints`);
    }
  }
}

const schemaDir = join(ROOT, 'specs', 'dataset-schemas');
if (existsSync(schemaDir)) {
  const schemas = readdirSync(schemaDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => f.replace(/\.md$/, ''));
  for (const s of schemas) {
    if (!entriesOf('datasetSchemas').some((e) => e.name === s)) {
      errors.push(`dataset-schemas entry '${s}' has no entry in parity-matrix.json#datasetSchemas`);
    }
  }
}

// 2) Resolution: every entry in every section must point at a real test — the file exists AND
//    contains the literal test title (titles are plain string literals repo-wide), so a renamed
//    or deleted test breaks the gate instead of leaving a dangling matrix row.
const fileCache = new Map<string, string | null>();
const readTestFile = (rel: string): string | null => {
  const cached = fileCache.get(rel);
  if (cached !== undefined) return cached;
  const abs = join(ROOT, rel);
  const text = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
  fileCache.set(rel, text);
  return text;
};

const sections = Object.keys(matrix).filter((k) => Array.isArray(matrix[k]));
for (const section of sections) {
  for (const { name, testId } of entriesOf(section)) {
    const hash = testId.indexOf('#');
    if (hash <= 0 || hash === testId.length - 1) {
      errors.push(`${section} '${name}': testId '${testId}' is not of the form <file>#<test name>`);
      continue;
    }
    const file = testId.slice(0, hash);
    const testName = testId.slice(hash + 1);
    const text = readTestFile(file);
    if (text === null) {
      errors.push(`${section} '${name}': test file '${file}' does not exist`);
    } else if (!text.includes(testName)) {
      errors.push(`${section} '${name}': '${file}' has no test titled '${testName}'`);
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`Parity matrix gate FAILED:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(
  `Parity matrix gate OK (${sections.map((s) => `${s}: ${entriesOf(s).length}`).join(', ')})\n`,
);
