import { describe, expect, it } from 'bun:test';
import type { ScopeConfig } from '../../src/config/schema.ts';
import { SCOPE_SEMANTICS_VERSION, computeScopeHash } from '../../src/crawler/scope-hash.ts';
import { sha256Hex } from '../../src/lib/hash.ts';

describe('crawler.scope-hash', () => {
  it('an empty scope hashes to the fixed "all" sentinel', () => {
    const { scopeHash, canonical } = computeScopeHash({});
    expect(canonical).toEqual({ all: true });
    expect(scopeHash).toBe(sha256Hex(JSON.stringify({ all: true })));
  });

  it('a scope whose arrays are all empty also hashes to the "all" sentinel', () => {
    const { scopeHash, canonical } = computeScopeHash({
      publishers: [],
      categories: [],
      tags: [],
      datasetIds: [],
    });
    expect(canonical).toEqual({ all: true });
    expect(scopeHash).toBe(sha256Hex(JSON.stringify({ all: true })));
  });

  it('is case-insensitive: {publishers:["A","a"]} === {publishers:["a"]}', () => {
    expect(computeScopeHash({ publishers: ['A', 'a'] }).scopeHash).toBe(
      computeScopeHash({ publishers: ['a'] }).scopeHash,
    );
  });

  it('is order-insensitive: arrays are sorted before hashing', () => {
    expect(computeScopeHash({ tags: ['zeta', 'alpha', 'mu'] }).scopeHash).toBe(
      computeScopeHash({ tags: ['mu', 'alpha', 'zeta'] }).scopeHash,
    );
  });

  it('trims whitespace and dedupes', () => {
    expect(computeScopeHash({ categories: [' x ', 'x', 'X'] }).canonical).toEqual({
      publishers: [],
      categories: ['x'],
      tags: [],
      datasetIds: [],
    });
  });

  it('a scope change yields a different hash', () => {
    const a = computeScopeHash({ publishers: ['mvr'] }).scopeHash;
    const b = computeScopeHash({ publishers: ['mvr', 'nra'] }).scopeHash;
    const c = computeScopeHash({ tags: ['mvr'] }).scopeHash;
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('canonical keeps the four arrays in a fixed key order', () => {
    const { canonical } = computeScopeHash({
      datasetIds: ['d1'],
      tags: ['t1'],
      categories: ['c1'],
      publishers: ['p1'],
    });
    expect(Object.keys(canonical)).toEqual(['publishers', 'categories', 'tags', 'datasetIds']);
  });

  it('the hash equals sha256 of the versioned canonical JSON (deterministic encoding)', () => {
    const scope: ScopeConfig = { publishers: ['B', 'a'], datasetIds: ['z', 'a'] };
    const { scopeHash, canonical } = computeScopeHash(scope);
    // A scoped campaign versions the hash INPUT (FR-304) while `scope_json` stays `canonical`.
    expect(scopeHash).toBe(sha256Hex(JSON.stringify({ v: SCOPE_SEMANTICS_VERSION, ...canonical })));
    expect(canonical).toEqual({
      publishers: ['a', 'b'],
      categories: [],
      tags: [],
      datasetIds: ['a', 'z'],
    });
  });

  it('the "all" sentinel hash is UNVERSIONED so full-portal campaigns resume (FR-304)', () => {
    // A pre-fix full-portal campaign keyed on sha256({all:true}) must resume untouched (SC-3).
    expect(computeScopeHash({}).scopeHash).toBe(sha256Hex(JSON.stringify({ all: true })));
  });

  it('a scoped hash is versioned, so a pre-fix scoped campaign is NOT resumed (FR-304)', () => {
    // Before spec 048 the hash input was the bare canonical; versioning re-keys every scoped run.
    const { scopeHash, canonical } = computeScopeHash({ publishers: ['egov-org-113'] });
    const preFix = sha256Hex(JSON.stringify(canonical));
    expect(scopeHash).not.toBe(preFix);
  });

  it('lowercases ids/slugs but a Cyrillic title field is never an input (Constitution X)', () => {
    // The function only consumes ScopeConfig's ASCII id/slug arrays; passing a Cyrillic
    // value still round-trips byte-exact in canonical (lowercased), never silently mangled.
    const { canonical } = computeScopeHash({ tags: ['Транспорт'] });
    expect(canonical).toEqual({
      publishers: [],
      categories: [],
      tags: ['транспорт'],
      datasetIds: [],
    });
  });
});
