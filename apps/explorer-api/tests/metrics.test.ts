// Metrics registry + request-log middleware (spec 030 RED, deepened in 032) — hermetic.

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { DURATION_BUCKETS_MS, MAX_TENANT_SERIES, Metrics, routeClassOf } from '../src/metrics.ts';
import { requestLog } from '../src/middleware/request-log.ts';

/** Parse `name{labels} value` lines from an exposition into a lookup keyed by the full series id. */
function parseSeries(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const sp = line.lastIndexOf(' ');
    if (sp === -1) continue;
    out.set(line.slice(0, sp), Number(line.slice(sp + 1)));
  }
  return out;
}

describe('Metrics (spec 032)', () => {
  it('aggregates RED across route classes for the snapshot', () => {
    const m = new Metrics();
    m.recordRequest('data', 200, 10);
    m.recordRequest('chat', 404, 20);
    m.recordRequest('chat', 500, 30);
    const s = m.snapshot();
    expect(s.requestsTotal).toBe(3);
    expect(s.errorsTotal).toBe(1);
    expect(s.avgLatencyMs).toBe(20);
    expect(s.byStatusClass).toEqual({ '2xx': 1, '4xx': 1, '5xx': 1 });
  });

  it('records domain signals: llm tokens/cost, 429s, chat outcomes', () => {
    const m = new Metrics();
    m.recordLlm({ inputTokens: 100, outputTokens: 40, cachedInputTokens: 25 }, 0.0123);
    m.recordRateLimitRejection('data');
    m.recordChatOutcome('grounded');
    m.recordChatOutcome('no_data');
    const s = m.snapshot();
    expect(s.llmTokens).toEqual({ input: 100, output: 40, cached: 25 });
    expect(s.llmCostUsd).toBeCloseTo(0.0123);
    expect(s.rateLimitRejections).toBe(1);
    expect(s.chatOutcomes).toEqual({ grounded: 1, no_data: 1 });
  });

  it('emits Prometheus exposition with labels + scrape-time gauges', () => {
    const m = new Metrics();
    m.recordRequest('data', 200, 5);
    m.recordLlm({ inputTokens: 10, outputTokens: 5 }, 0.5);
    m.recordChatOutcome('error');
    const text = m.prometheus({ danni_active_generations: 2, danni_index_stale_datasets: 7 });
    expect(text).toContain('# TYPE danni_http_requests_total counter');
    expect(text).toContain(
      'danni_http_requests_total{route="data",status="2xx",tenant="default"} 1',
    );
    expect(text).toContain('danni_llm_cost_usd_total{tenant="default"} 0.5');
    expect(text).toContain('danni_chat_outcomes_total{outcome="error"} 1');
    expect(text).toContain('danni_active_generations 2');
    expect(text).toContain('danni_index_stale_datasets 7');
  });

  it('routeClassOf maps paths to classes', () => {
    expect(routeClassOf('/api/chat')).toBe('chat');
    expect(routeClassOf('/api/admin/usage')).toBe('admin');
    expect(routeClassOf('/api/datasets')).toBe('data');
    expect(routeClassOf('/assets/x.js')).toBe('other');
  });

  it('reset clears everything', () => {
    const m = new Metrics();
    m.recordRequest('data', 200, 5);
    m.recordLlm({ inputTokens: 1, outputTokens: 1 }, 1);
    m.recordQuotaRejection('tokens');
    m.reset();
    const s = m.snapshot();
    expect(s.requestsTotal).toBe(0);
    expect(s.llmCostUsd).toBe(0);
    expect(s.quotaRejections).toEqual({});
  });
});

describe('Metrics duration histogram (spec 045 FR-270 / SC-1)', () => {
  it('exposes cumulative buckets + _sum/_count from which p95/p99 is computable', () => {
    const m = new Metrics();
    // Durations landing in distinct buckets: 3ms (≤5), 40ms (≤50), 800ms (≤1000), 90s (≤120000).
    for (const d of [3, 40, 800, 90_000]) m.recordRequest('chat', 200, d);
    const series = parseSeries(m.prometheus());
    const at = (le: string) =>
      series.get(`danni_http_request_duration_ms_bucket{route="chat",le="${le}"}`);
    // Cumulative + monotone non-decreasing across the ladder.
    expect(at('5')).toBe(1);
    expect(at('50')).toBe(2);
    expect(at('1000')).toBe(3);
    expect(at('120000')).toBe(4);
    expect(at('+Inf')).toBe(4);
    let prev = 0;
    for (const le of DURATION_BUCKETS_MS) {
      const v = at(String(le)) ?? 0;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // +Inf bucket equals _count; _sum is the observed total (Prometheus histogram invariants).
    expect(series.get('danni_http_request_duration_ms_count{route="chat"}')).toBe(4);
    expect(series.get('danni_http_request_duration_ms_sum{route="chat"}')).toBe(
      3 + 40 + 800 + 90_000,
    );
    expect(m.prometheus()).toContain('# TYPE danni_http_request_duration_ms histogram');
  });

  it('a duration slower than the last edge lands in +Inf only', () => {
    const m = new Metrics();
    m.recordRequest('chat', 200, 200_000); // > 120000ms top edge
    const series = parseSeries(m.prometheus());
    expect(series.get('danni_http_request_duration_ms_bucket{route="chat",le="120000"}')).toBe(0);
    expect(series.get('danni_http_request_duration_ms_bucket{route="chat",le="+Inf"}')).toBe(1);
    expect(series.get('danni_http_request_duration_ms_count{route="chat"}')).toBe(1);
  });
});

describe('Metrics tenant attribution (spec 045 FR-271 / SC-2)', () => {
  it('attributes tokens/cost/requests per tenant; absent tenant is `default`', () => {
    const m = new Metrics();
    m.recordLlm({ inputTokens: 100, outputTokens: 10 }, 0.5, 'acme');
    m.recordLlm({ inputTokens: 200, outputTokens: 20 }, 0.9, 'globex');
    m.recordRequest('chat', 200, 5, 'acme');
    m.recordRequest('chat', 200, 5); // unattributed → default
    const series = parseSeries(m.prometheus());
    expect(series.get('danni_llm_tokens_total{kind="input",tenant="acme"}')).toBe(100);
    expect(series.get('danni_llm_tokens_total{kind="input",tenant="globex"}')).toBe(200);
    expect(series.get('danni_llm_cost_usd_total{tenant="acme"}')).toBeCloseTo(0.5);
    expect(series.get('danni_llm_cost_usd_total{tenant="globex"}')).toBeCloseTo(0.9);
    expect(series.get('danni_http_requests_total{route="chat",status="2xx",tenant="acme"}')).toBe(
      1,
    );
    expect(
      series.get('danni_http_requests_total{route="chat",status="2xx",tenant="default"}'),
    ).toBe(1);
    // Snapshot totals still aggregate across tenants (preserved shape, FR-274).
    const s = m.snapshot();
    expect(s.llmTokens).toEqual({ input: 300, output: 30, cached: 0 });
    expect(s.llmCostUsd).toBeCloseTo(1.4);
  });

  it('bounds cardinality: the (cap+1)th distinct tenant folds into `other`', () => {
    const m = new Metrics();
    for (let i = 0; i < MAX_TENANT_SERIES; i++)
      m.recordLlm({ inputTokens: 1, outputTokens: 0 }, 0, `t${i}`);
    // One more distinct tenant overflows into `other`.
    m.recordLlm({ inputTokens: 7, outputTokens: 0 }, 0, 'overflow');
    const series = parseSeries(m.prometheus());
    // t0..t99 each keep their own series; `overflow` does not.
    expect(series.get('danni_llm_tokens_total{kind="input",tenant="t0"}')).toBe(1);
    expect(series.has('danni_llm_tokens_total{kind="input",tenant="overflow"}')).toBe(false);
    expect(series.get('danni_llm_tokens_total{kind="input",tenant="other"}')).toBe(7);
    // Distinct tenant series stay bounded: 100 real + `other` (default not present here).
    const tenantSeries = [...series.keys()].filter((k) =>
      k.startsWith('danni_llm_tokens_total{kind="input"'),
    );
    expect(tenantSeries.length).toBe(MAX_TENANT_SERIES + 1);
  });
});

describe('Metrics quota rejections (spec 045 FR-272 / SC-3)', () => {
  it('counts token + request quota rejections distinctly from rate limits', () => {
    const m = new Metrics();
    m.recordQuotaRejection('tokens');
    m.recordQuotaRejection('tokens');
    m.recordQuotaRejection('requests');
    m.recordRateLimitRejection('data');
    const series = parseSeries(m.prometheus());
    expect(series.get('danni_quota_rejections_total{kind="tokens"}')).toBe(2);
    expect(series.get('danni_quota_rejections_total{kind="requests"}')).toBe(1);
    expect(series.get('danni_rate_limit_rejections_total{route="data"}')).toBe(1);
    expect(m.snapshot().quotaRejections).toEqual({ tokens: 2, requests: 1 });
  });
});

describe('requestLog middleware (spec 032)', () => {
  function appWith(metrics: Metrics) {
    let t = 1000;
    const now = () => {
      t += 7;
      return t;
    };
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use('*', async (c, next) => {
      c.set('requestId', 'req-test');
      await next();
    });
    app.use('*', requestLog(metrics, now));
    app.get('/api/datasets', (c) => c.json({ ok: true }));
    app.post('/api/chat', (c) => c.json({ error: 'x' }, 500));
    app.get('/static.js', (c) => c.text('asset'));
    return app;
  }

  it('meters observed requests by route class + status, skips static', async () => {
    const m = new Metrics();
    const app = appWith(m);
    expect((await app.request('/api/datasets')).status).toBe(200);
    expect((await app.request('/api/chat', { method: 'POST' })).status).toBe(500);
    await app.request('/static.js');
    const text = m.prometheus();
    expect(text).toContain(
      'danni_http_requests_total{route="data",status="2xx",tenant="default"} 1',
    );
    expect(text).toContain(
      'danni_http_requests_total{route="chat",status="5xx",tenant="default"} 1',
    );
    const s = m.snapshot();
    expect(s.requestsTotal).toBe(2); // static skipped
    expect(s.errorsTotal).toBe(1);
  });
});
