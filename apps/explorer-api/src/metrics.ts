// In-process metrics registry (spec 032, FR-149; deepens the spec-030 RED snapshot). Records RED
// (rate/errors/duration) per route class + status class plus domain signals — LLM tokens + cost (from
// the 026 usage signal), rate-limit/quota 429s (028), and chat outcomes — and exposes them in the
// Prometheus text exposition format for a scraper. Single-node/in-memory; an OTel collector (part of
// the commercial deploy repo, danni-bg/deploy) scrapes /metrics and fans out to the metrics backend.
// snapshot() is kept for the quick JSON view + tests.
//
// Spec 045 adds the three SaaS signals: request-duration HISTOGRAMS per route class (tail latency, so
// histogram_quantile yields p95/p99), a bounded-cardinality `tenant` label on the token/cost/request
// counters (per-tenant attribution, spec 029), and a `danni_quota_rejections_total{kind}` counter that
// is distinct from the rate-limit counter (quota-exhaustion is the churn/upsell signal).

export type RouteClass = 'data' | 'chat' | 'admin' | 'other';
export type ChatOutcome = 'grounded' | 'no_data' | 'error';
export type QuotaKind = 'tokens' | 'requests';

const ROUTE_CLASSES: readonly RouteClass[] = ['data', 'chat', 'admin', 'other'];

// Fixed histogram bucket boundaries in milliseconds (FR-270). One shared ladder spans the public API
// (single-digit-ms reads) and chat/SSE turns (tens of seconds), so `histogram_quantile` is computable
// for every route class from the same buckets. Upper edge (120 s) covers a slow model's full turn; the
// implicit +Inf bucket catches anything slower. Fixed + code-owned so a scraper's recording rules are
// stable across restarts.
export const DURATION_BUCKETS_MS: readonly number[] = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000,
];

// Bounded tenant cardinality (FR-271): label token/cost/request series by tenant id up to this many
// DISTINCT real tenants; the (N+1)th and beyond fold into `tenant="other"` so a burst of new orgs can
// never blow up Prometheus series cardinality. `default` (single-tenant / unattributed traffic) and
// `other` (the overflow sink) are always available and do not count against the cap.
export const MAX_TENANT_SERIES = 100;
export const DEFAULT_TENANT_LABEL = 'default';
export const OTHER_TENANT_LABEL = 'other';

export interface MetricsSnapshot {
  requestsTotal: number;
  errorsTotal: number; // 5xx responses
  avgLatencyMs: number;
  byStatusClass: Record<string, number>;
  llmTokens: { input: number; output: number; cached: number };
  llmCostUsd: number;
  rateLimitRejections: number;
  quotaRejections: Record<string, number>;
  chatOutcomes: Record<string, number>;
}

const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;
const inc = (m: Map<string, number>, key: string, by = 1) => m.set(key, (m.get(key) ?? 0) + by);

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

interface TokenCounts {
  input: number;
  output: number;
  cached: number;
}

export class Metrics {
  // RED: request counts keyed by `${route}|${statusClass}|${tenant}`; per-route latency sum/count +
  // histogram buckets (route only — the histogram stays low-cardinality; the count carries the tenant).
  private readonly reqTotal = new Map<string, number>();
  private readonly durSumMs = new Map<string, number>(); // per route
  private readonly durCount = new Map<string, number>(); // per route
  private readonly durBuckets = new Map<string, number[]>(); // per route: non-cumulative per-bucket counts
  // Domain, tenant-attributed (FR-271).
  private readonly llmTokens = new Map<string, TokenCounts>(); // per tenant
  private readonly llmCostUsd = new Map<string, number>(); // per tenant
  private readonly rateLimitRejections = new Map<string, number>(); // per route
  private readonly quotaRejections = new Map<string, number>(); // per quota kind
  private readonly chatOutcomes = new Map<string, number>();
  // Distinct real tenants that have been assigned their own series (bounds cardinality, FR-271).
  private readonly seenTenants: Set<string>;

  constructor() {
    this.seenTenants = new Set<string>();
  }

  /**
   * Normalise a caller's tenant to a bounded label (FR-271): empty/absent → `default`; a known tenant
   * keeps its own series; a new tenant gets one until the cap, after which it folds into `other`.
   */
  private tenantLabel(tenant?: string): string {
    const t = tenant && tenant.length > 0 ? tenant : DEFAULT_TENANT_LABEL;
    if (t === DEFAULT_TENANT_LABEL || t === OTHER_TENANT_LABEL) return t;
    if (this.seenTenants.has(t)) return t;
    if (this.seenTenants.size < MAX_TENANT_SERIES) {
      this.seenTenants.add(t);
      return t;
    }
    return OTHER_TENANT_LABEL;
  }

  private observeDuration(route: RouteClass, durationMs: number): void {
    let counts = this.durBuckets.get(route);
    if (!counts) {
      counts = new Array<number>(DURATION_BUCKETS_MS.length + 1).fill(0); // +1 for the +Inf overflow
      this.durBuckets.set(route, counts);
    }
    let idx = DURATION_BUCKETS_MS.findIndex((le) => durationMs <= le);
    if (idx === -1) idx = DURATION_BUCKETS_MS.length; // slower than the last edge → +Inf
    counts[idx] = (counts[idx] ?? 0) + 1;
  }

  /** Record one completed HTTP request (tenant defaults to `default` for anonymous/unattributed traffic). */
  recordRequest(route: RouteClass, status: number, durationMs: number, tenant?: string): void {
    const d = Math.max(0, durationMs);
    inc(this.reqTotal, `${route}|${statusClass(status)}|${this.tenantLabel(tenant)}`);
    inc(this.durSumMs, route, d);
    inc(this.durCount, route);
    this.observeDuration(route, d);
  }

  /** Record an LLM turn's tokens + computed cost (USD), attributed to the caller's tenant. */
  recordLlm(
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
    costUsd: number,
    tenant?: string,
  ): void {
    const t = this.tenantLabel(tenant);
    let counts = this.llmTokens.get(t);
    if (!counts) {
      counts = { input: 0, output: 0, cached: 0 };
      this.llmTokens.set(t, counts);
    }
    counts.input += Math.max(0, usage.inputTokens || 0);
    counts.output += Math.max(0, usage.outputTokens || 0);
    counts.cached += Math.max(0, usage.cachedInputTokens || 0);
    this.llmCostUsd.set(t, (this.llmCostUsd.get(t) ?? 0) + Math.max(0, costUsd || 0));
  }

  recordRateLimitRejection(route: RouteClass): void {
    inc(this.rateLimitRejections, route);
  }

  /**
   * Record a quota-exhaustion 429 (FR-272), kept DISTINCT from rate-limit rejections: `tokens` at the
   * chat token-quota 429 (spec 021/039), `requests` at the data-API request-quota 429 (spec 028/040).
   */
  recordQuotaRejection(kind: QuotaKind): void {
    inc(this.quotaRejections, kind);
  }

  recordChatOutcome(outcome: ChatOutcome): void {
    inc(this.chatOutcomes, outcome);
  }

  snapshot(): MetricsSnapshot {
    let requestsTotal = 0;
    let errorsTotal = 0;
    const byStatusClass: Record<string, number> = {};
    let durSum = 0;
    for (const [key, n] of this.reqTotal) {
      const cls = key.split('|')[1] as string;
      requestsTotal += n;
      byStatusClass[cls] = (byStatusClass[cls] ?? 0) + n;
      if (cls === '5xx') errorsTotal += n;
    }
    for (const v of this.durSumMs.values()) durSum += v;
    const tokens = { input: 0, output: 0, cached: 0 };
    for (const c of this.llmTokens.values()) {
      tokens.input += c.input;
      tokens.output += c.output;
      tokens.cached += c.cached;
    }
    let costUsd = 0;
    for (const v of this.llmCostUsd.values()) costUsd += v;
    return {
      requestsTotal,
      errorsTotal,
      avgLatencyMs: requestsTotal === 0 ? 0 : durSum / requestsTotal,
      byStatusClass,
      llmTokens: tokens,
      llmCostUsd: costUsd,
      rateLimitRejections: [...this.rateLimitRejections.values()].reduce((a, b) => a + b, 0),
      quotaRejections: Object.fromEntries(this.quotaRejections),
      chatOutcomes: Object.fromEntries(this.chatOutcomes),
    };
  }

  /**
   * Prometheus text exposition (FR-149). `gauges` are point-in-time values computed at scrape time
   * (e.g. active detached generations, stale-dataset count) — the registry only holds counters.
   */
  prometheus(gauges: Record<string, number> = {}): string {
    const out: string[] = [];
    const help = (name: string, type: string, text: string) => {
      out.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`);
    };

    help(
      'danni_http_requests_total',
      'counter',
      'HTTP requests by route class, status class and tenant.',
    );
    for (const [key, n] of this.reqTotal) {
      const [route, cls, tenant] = key.split('|') as [string, string, string];
      out.push(
        `danni_http_requests_total{route="${route}",status="${cls}",tenant="${escapeLabel(tenant)}"} ${n}`,
      );
    }

    // Request-duration histogram (FR-270): cumulative `_bucket{le}` + `_sum`/`_count` per route class, so
    // a scraper computes p95/p99 via histogram_quantile. Buckets are cumulative (Prometheus convention):
    // bucket[le] counts observations ≤ le, and le="+Inf" equals _count.
    help(
      'danni_http_request_duration_ms',
      'histogram',
      'HTTP request duration (ms) by route class.',
    );
    for (const route of ROUTE_CLASSES) {
      const counts = this.durBuckets.get(route);
      if (!counts) continue;
      let cumulative = 0;
      for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
        cumulative += counts[i] ?? 0;
        out.push(
          `danni_http_request_duration_ms_bucket{route="${route}",le="${DURATION_BUCKETS_MS[i]}"} ${cumulative}`,
        );
      }
      cumulative += counts[DURATION_BUCKETS_MS.length] ?? 0; // +Inf overflow
      out.push(`danni_http_request_duration_ms_bucket{route="${route}",le="+Inf"} ${cumulative}`);
      out.push(
        `danni_http_request_duration_ms_sum{route="${route}"} ${this.durSumMs.get(route) ?? 0}`,
      );
      out.push(
        `danni_http_request_duration_ms_count{route="${route}"} ${this.durCount.get(route) ?? 0}`,
      );
    }

    help('danni_llm_tokens_total', 'counter', 'LLM tokens by kind and tenant.');
    for (const [tenant, counts] of this.llmTokens) {
      const t = escapeLabel(tenant);
      out.push(
        `danni_llm_tokens_total{kind="input",tenant="${t}"} ${counts.input}`,
        `danni_llm_tokens_total{kind="output",tenant="${t}"} ${counts.output}`,
        `danni_llm_tokens_total{kind="cached",tenant="${t}"} ${counts.cached}`,
      );
    }

    help('danni_llm_cost_usd_total', 'counter', 'Estimated LLM spend (USD) by tenant.');
    for (const [tenant, cost] of this.llmCostUsd) {
      out.push(`danni_llm_cost_usd_total{tenant="${escapeLabel(tenant)}"} ${cost}`);
    }

    help('danni_rate_limit_rejections_total', 'counter', 'Rate-limit 429s by route class.');
    for (const [route, n] of this.rateLimitRejections) {
      out.push(`danni_rate_limit_rejections_total{route="${route}"} ${n}`);
    }

    help(
      'danni_quota_rejections_total',
      'counter',
      'Quota-exhaustion 429s by kind (tokens = chat token quota, requests = data-API request quota).',
    );
    for (const [kind, n] of this.quotaRejections) {
      out.push(`danni_quota_rejections_total{kind="${escapeLabel(kind)}"} ${n}`);
    }

    help('danni_chat_outcomes_total', 'counter', 'Chat turn outcomes.');
    for (const [outcome, n] of this.chatOutcomes) {
      out.push(`danni_chat_outcomes_total{outcome="${escapeLabel(outcome)}"} ${n}`);
    }

    for (const [name, value] of Object.entries(gauges)) {
      if (Number.isFinite(value)) {
        help(name, 'gauge', 'Point-in-time value.');
        out.push(`${name} ${value}`);
      }
    }

    return `${out.join('\n')}\n`;
  }

  reset(): void {
    this.reqTotal.clear();
    this.durSumMs.clear();
    this.durCount.clear();
    this.durBuckets.clear();
    this.llmTokens.clear();
    this.llmCostUsd.clear();
    this.rateLimitRejections.clear();
    this.quotaRejections.clear();
    this.chatOutcomes.clear();
    this.seenTenants.clear();
  }
}

/** Map a request path to its route class for RED labelling. */
export function routeClassOf(path: string): RouteClass {
  if (path.startsWith('/api/chat')) return 'chat';
  if (path.startsWith('/api/admin')) return 'admin';
  if (path.startsWith('/api/')) return 'data';
  return 'other';
}
