# Feature Specification: SaaS observability (tail latency, tenant attribution, quota signals)

**Feature Branch**: `045-saas-observability`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the
metrics registry can say "requests are slow on average" but not "p99 regressed", "tenant X did it",
or "users are hitting their quotas" — the three signals a SaaS actually alerts on.

## Overview

Spec 030/032 built a solid in-process registry (`apps/explorer-api/src/metrics.ts`): RED per route
class, LLM tokens + estimated USD cost, rate-limit 429s, chat outcomes, Prometheus exposition,
request-id-correlated metadata-only spans (`trace.ts`). This spec adds the three missing SaaS
signals without disturbing what works, and settles who may scrape `/metrics`.

Single responsibility: **tail latency, per-tenant attribution, and quota-exhaustion are observable.**

## Finding & evidence

- **No histograms** — `apps/explorer-api/src/metrics.ts:42-43` keeps only per-route duration
  `durSumMs`/`durCount` (exported at metrics.ts:119-131 as `_sum`/`_count`). Average only: p95/p99
  cannot be computed, so no tail-latency alerting for chat or the public API.
- **No tenant label anywhere** — despite tenancy (spec 029) attributing keys/usage/sessions to a
  tenant, no metric in `metrics.ts` carries one; per-tenant cost/traffic is invisible at the
  telemetry layer (only queryable via the `api_usage`/`token_usage` tables).
- **Token-quota 429s uncounted** — rate-limit rejections are recorded
  (`middleware/api-metering.ts:47-50` calls `recordRateLimitRejection` in `chatMeter`; likewise the
  `dataApiGate` path), but the spec-021 token-quota rejection
  (`apps/explorer-api/src/routes/chat.ts:84-95`, `quota_exceeded` → 429) increments **no** counter —
  quota exhaustion, the churn/upsell signal, is invisible.
- **Unauthenticated exposure** — `/healthz`, `/readyz`, `/metrics` are all registered on the public
  app port with no gate (`apps/explorer-api/src/app.ts:282-317`); `/metrics` leaks traffic volumes,
  tenant labels (after this spec), and LLM spend to anyone.
- **Preserve**: request-id correlation, LLM token+cost counters, chat outcomes, Prometheus text
  format, and the privacy stance of `trace.ts` (metadata only, never message content).

## Requirements

- **FR-270**: HTTP request duration MUST be exported as a Prometheus histogram per route class
  (`danni_http_request_duration_ms_bucket{route,le}` + `_sum`/`_count`) with a fixed bucket set
  spanning both API (~5 ms) and chat/SSE (~60 s+) latencies, so `histogram_quantile` yields p95/p99.
- **FR-271**: LLM token, LLM cost, and HTTP request counters MUST carry a `tenant` label with
  bounded cardinality: label by tenant slug/id up to a fixed cap (e.g. 100 series), overflow
  aggregating into `tenant="other"`. Single-tenant deployments see one `default` series.
- **FR-272**: Quota rejections MUST be counted distinctly from rate limits:
  `danni_quota_rejections_total{kind="tokens"|"requests"}` — `tokens` incremented at the spec-021
  429 in the chat route (see spec 039 for the exact chat-metering emission point), `requests` at the
  spec-028 request-quota 429 in `dataApiGate`. `danni_rate_limit_rejections_total` keeps its meaning.
- **FR-273**: `/metrics` exposure MUST be decided and enforced: `/healthz` + `/readyz` stay public;
  `/metrics` is gated by a bearer token or CIDR allowlist configured via env. In the `production`
  profile an unset gate MUST fail closed (404/401); dev profiles may default open.
- **FR-274**: Existing signals (request-id correlation, LLM token/cost counters, chat outcomes,
  Prometheus format, metadata-only spans) MUST be preserved and covered by regression tests.

## Success criteria

- **SC-1**: A scrape after mixed traffic yields buckets from which p95/p99 per route class is
  computable (test asserts monotone cumulative buckets + correct counts).
- **SC-2**: Two tenants generating chat traffic produce separately attributable token/cost/request
  series; a 101st tenant lands in `other` (cardinality stays bounded).
- **SC-3**: Driving a user over the token quota and a key over the request quota increments
  `danni_quota_rejections_total{kind="tokens"}` / `{kind="requests"}` respectively by exactly the
  rejection count.
- **SC-4**: In the production profile, an unauthenticated `GET /metrics` is refused while
  `/healthz`/`/readyz` still answer.

## Out of scope / dependencies

- Dashboards, alert rules, the OTel collector and metrics backend — private deploy repo (spec 032);
  this repo only **emits**. The dangling `infra/observability` comment references are spec **047**.
- Spec **039** (chat metering) defines the chat quota-429 emission point FR-272 hooks into; spec
  **021**/**028** define the quotas themselves; tenancy labels come from spec **029**'s resolution.
- Exemplars, native OTLP export, per-endpoint (not route-class) latency — deferred. Consciously
  accepted: an in-process, reset-on-restart registry is fine for a single-node product.
