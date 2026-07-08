// Edge branches of the chat turn orchestration (run.ts): readUsage's defensive fallback, the focus
// resolver's unreadable-dataset catch, buildFocusContext's document/text resource shapes, and the
// non-string last-user-message branch on the RAG path. Hermetic — stub bridge + scripted mock model.

import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalOnnxEmbedder } from '../../../src/index/embedders/local-onnx.ts';
import type { ResourceContent } from '../../../src/read/resource-rows.ts';
import { openDb } from '../../../src/store/db.ts';
import { runMigrations } from '../../../src/store/migrate.ts';
import { DatasetsRepo } from '../../../src/store/repos/datasets.ts';
import { EntitiesRepo } from '../../../src/store/repos/entities.ts';
import { buildFocusContext, readUsage, runChatTurn } from '../src/chat/run.ts';
import { ReadBridge } from '../src/read-bridge.ts';
import { errorStep, mockModel, textStep, toolCallStep } from './helpers/mock-model.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TOOL_ERR = new Error('"auto" tool choice requires --enable-auto-tool-choice');

describe('readUsage', () => {
  it('returns zeros when the usage promise rejects', async () => {
    const u = await readUsage({ totalUsage: Promise.reject(new Error('no usage')) });
    expect(u).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 });
  });

  it('derives totalTokens from input+output when the provider omits it', async () => {
    const u = await readUsage({ totalUsage: Promise.resolve({ inputTokens: 3, outputTokens: 4 }) });
    expect(u.totalTokens).toBe(7);
  });
});

describe('buildFocusContext resource shapes', () => {
  it('surfaces a document-typed resource (no tabular rows)', () => {
    const bridge = {
      view: (id: string) => ({
        datasetId: id,
        title: { bg: 'GeoJSON набор' },
        resources: [{ resourceId: 'r1', name: 'Карта' }],
      }),
      rows: (): ResourceContent =>
        ({
          rows: [],
          total: 0,
          document: { type: 'FeatureCollection' },
        }) as unknown as ResourceContent,
    } as unknown as ReadBridge;
    const focus = buildFocusContext(bridge, ['d'], (id) => bridge.view(id) as never);
    expect(focus?.text).toContain('(документ)');
    expect(focus?.text).toContain('FeatureCollection');
  });

  it('surfaces a text-typed resource (no rows, no document)', () => {
    const bridge = {
      view: (id: string) => ({
        datasetId: id,
        title: { bg: 'Текстов набор' },
        resources: [{ resourceId: 'r1', name: 'Бележка' }],
      }),
      rows: (): ResourceContent =>
        ({ rows: [], total: 0, text: 'свободен текст' }) as unknown as ResourceContent,
    } as unknown as ReadBridge;
    const focus = buildFocusContext(bridge, ['d'], (id) => bridge.view(id) as never);
    expect(focus?.text).toContain('(текст)');
    expect(focus?.text).toContain('свободен текст');
  });
});

describe('runChatTurn edge branches (real bridge)', () => {
  let db: Database;
  let bridge: ReadBridge;
  beforeEach(() => {
    const storeRoot = globalThis.__TEST_TMP_DIR__;
    db = openDb({ storeRoot, loadVec: false });
    runMigrations(db, join(ROOT, 'migrations'));
    new DatasetsRepo(db).upsert({
      id: 'd1',
      slug: 'd1',
      titleBg: 'Качество на въздуха',
      tags: ['въздух'],
      groups: [],
      sourceUrl: 'https://data.egov.bg/d1',
    });
    // Link d1 to an oblast so a geo-scoped tool search can backfill from the region (tools.ts).
    const ents = new EntitiesRepo(db);
    ents.upsert({
      id: 'geo:bg-oblast-sofia-grad',
      kind: 'geographic_unit',
      canonicalLabelBg: 'София (град)',
    });
    ents.attach({
      datasetId: 'd1',
      entityId: 'geo:bg-oblast-sofia-grad',
      extractor: 'gaz',
      confidence: 0.9,
    });
    bridge = new ReadBridge({
      db,
      storeRoot,
      embedder: new LocalOnnxEmbedder({ dimension: 8 }),
      freshnessSloSeconds: 86400,
    });
  });
  afterEach(() => db.close());

  it('tolerates an unreadable focus dataset (resolver catch → skipped, no throw)', async () => {
    // 'ghost' has no dataset row → bridge.view throws → the focus resolver catches and returns null.
    const result = await runChatTurn({
      model: mockModel([textStep('Отговор.')]),
      bridge,
      scope: { datasetIds: ['ghost'] },
      groundingDatasetIds: ['ghost'],
      messages: [{ role: 'user', content: 'нещо' }],
    });
    expect(result.text).toBe('Отговор.');
    expect(result.citations).toEqual([]); // the unreadable focus contributed no citation
  });

  it('handles a non-string last user message on the RAG path (empty query)', async () => {
    const result = await runChatTurn({
      model: mockModel([errorStep(TOOL_ERR), textStep('Няма конкретен въпрос.')]),
      bridge,
      scope: {},
      // Array (multi-part) content → lastUserText yields '' (its non-string branch).
      messages: [{ role: 'user', content: [{ type: 'text', text: 'въздух' }] }],
    });
    expect(typeof result.text).toBe('string');
  });

  it('handles a conversation with no user message on the RAG path (lastUserText loop-complete)', async () => {
    // Only an assistant message → lastUserText scans to exhaustion and returns '' (its final return).
    const result = await runChatTurn({
      model: mockModel([errorStep(TOOL_ERR), textStep('Няма въпрос.')]),
      bridge,
      scope: {},
      messages: [{ role: 'assistant', content: 'предишен отговор' }],
    });
    expect(typeof result.text).toBe('string');
  });

  it('propagates a RAG-turn stream error (fullStream error part rethrown)', async () => {
    // Step 1 forces the RAG fallback; the RAG streamText then emits an `error` part, which the
    // fullStream loop rethrows (run.ts).
    await expect(
      runChatTurn({
        model: mockModel([errorStep(TOOL_ERR), errorStep(new Error('rag boom'))]),
        bridge,
        scope: { datasetIds: ['d1'] },
        groundingDatasetIds: ['d1'],
        messages: [{ role: 'user', content: 'въздух' }],
      }),
    ).rejects.toThrow('rag boom');
  });

  it('geo-scoped tool search backfills from region datasets when ranked search is short', async () => {
    // The model calls mirrorSearch with a query that matches nothing; under a geo scope the tool
    // backfills straight from the region via bridge.entityDatasets (tools.ts backfill take).
    const result = await runChatTurn({
      model: mockModel([
        toolCallStep('mirrorSearch', { query: 'няманищотакова' }),
        textStep('Готово.'),
      ]),
      bridge,
      scope: { geoUnitIds: ['geo:bg-oblast-sofia-grad'] },
      messages: [{ role: 'user', content: 'въздух' }],
    });
    expect(result.citations.some((c) => c.datasetId === 'd1')).toBe(true);
  });
});
