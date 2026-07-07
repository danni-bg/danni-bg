// Spec 056 (backend surface cleanup) guards: the removed affordances stay removed. Grep-style source
// assertions (SC-1) + dead-export absence (SC-4). Hermetic — no DB, no network.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as vecModule from '../../src/index/vec.ts';
import { TOOLS } from '../../src/mcp/server.ts';
import * as dbModule from '../../src/store/db.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf-8');

describe('spec 056 SC-1: the `lang` search plumbing is gone end-to-end', () => {
  const files = [
    'src/index/query.ts',
    'src/mcp/server.ts',
    'apps/explorer-api/src/read-bridge.ts',
    'apps/explorer-api/src/chat/tools.ts',
  ];
  for (const f of files) {
    it(`${f} carries no \`lang\` search option`, () => {
      expect(read(f)).not.toMatch(/lang/i);
    });
  }

  it('the MCP mirror_search tool no longer advertises a `lang` field', () => {
    const search = TOOLS.find((t) => t.name === 'mirror_search');
    expect(search).toBeDefined();
    const props = (search?.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(['query', 'limit']);
    expect('lang' in props).toBe(false);
  });
});

describe('spec 056 SC-4: dead exports are gone', () => {
  it('src/index/vec.ts no longer exports upsertEmbeddingFor', () => {
    expect('upsertEmbeddingFor' in vecModule).toBe(false);
    // The composer it wrapped is still exported (run-index.ts calls it).
    expect(typeof vecModule.composeEmbeddingText).toBe('function');
  });

  it('src/store/db.ts no longer exports vecVersion', () => {
    expect('vecVersion' in dbModule).toBe(false);
    expect(typeof dbModule.openDb).toBe('function');
  });
});
