import { describe, expect, it } from 'bun:test';
import { ColumnNameHeuristicsExtractor } from '../../../../src/enrich/extractors/column-name-heuristics.ts';
import type { DatasetRow } from '../../../../src/store/repos/datasets.ts';
import type { ResourceRow } from '../../../../src/store/repos/resources.ts';

function fakeResource(name: string | null, descriptionBg: string | null): ResourceRow {
  return {
    id: 'r1',
    dataset_id: 'd1',
    position: 0,
    name,
    description_bg: descriptionBg,
    declared_format: null,
    detected_content_type: null,
    detected_format: null,
    source_url: 'https://x/r1',
    bytes: null,
    sha256: null,
    raw_path: null,
    etag: null,
    last_modified: null,
    first_seen_at: '2026-05-08T00:00:00Z',
    last_synced_at: '2026-05-08T00:00:00Z',
    last_outcome: 'success',
    last_failure_reason: null,
    lifecycle_state: 'active',
  };
}

function fakeDataset(title: string): DatasetRow {
  return {
    id: 'd1',
    slug: 'd1',
    title_bg: title,
    description_bg: null,
    publisher_id: null,
    license_id: null,
    tags_json: '[]',
    groups_json: '[]',
    source_url: 'https://x/d1',
    metadata_created: null,
    metadata_modified: null,
    first_seen_at: '2026-05-08T00:00:00Z',
    last_synced_at: '2026-05-08T00:00:00Z',
    source_etag_or_hash: null,
    lifecycle_state: 'active',
    lifecycle_changed_at: null,
    withdrawn_reason: null,
  };
}

describe('enrich.extractors.column-name-heuristics', () => {
  it('matches subject keywords in BG/EN', async () => {
    const out = await new ColumnNameHeuristicsExtractor().extract({
      dataset: fakeDataset('Образование - бюджет за 2025'),
      resources: [],
    });
    const ids = out.map((c) => c.id);
    expect(ids).toContain('subject:budget');
    expect(ids).toContain('subject:education');
  });

  it('matches keywords found in resource name and description', async () => {
    const out = await new ColumnNameHeuristicsExtractor().extract({
      dataset: fakeDataset('Общ регистър'),
      resources: [
        fakeResource('Транспортна мрежа', null),
        fakeResource(null, 'данни за здраве в региона'),
      ],
    });
    const ids = out.map((c) => c.id);
    expect(ids).toContain('subject:transport');
    expect(ids).toContain('subject:health');
  });

  it('returns empty when no keywords', async () => {
    const out = await new ColumnNameHeuristicsExtractor().extract({
      dataset: fakeDataset('Random title'),
      resources: [],
    });
    expect(out.length).toBe(0);
  });
});
