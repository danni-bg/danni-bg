import { z } from 'zod';

export const PortalConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    // 'ckan' — standard CKAN Action API (default; documented contract + fixtures).
    // 'egov-bg' — data.egov.bg's custom POST API (governmentbg/data-gov-bg).
    api: z.enum(['ckan', 'egov-bg']).default('ckan'),
    // Optional env var holding an api_key, sent to the portal when present.
    // The data.egov.bg read endpoints are public, so this is usually unset.
    apiKeyEnv: z.string().min(1).nullable().optional(),
  })
  .strict();

export const RateLimitConfigSchema = z
  .object({
    requestsPerSecondPerHost: z.number().positive().max(10),
  })
  .strict();

export const ConcurrencyConfigSchema = z
  .object({
    maxConcurrentRequestsPerHost: z.number().int().min(1).max(8),
  })
  .strict();

export const BackoffConfigSchema = z
  .object({
    initialMs: z.number().int().min(100),
    maxMs: z.number().int().min(1000),
    failureBudget: z.number().int().min(1),
  })
  .strict();

export const RobotsConfigSchema = z
  .object({
    recheckIntervalSeconds: z.number().int().min(60),
    // When false, robots.txt is not consulted at all (operator opt-out for
    // authorized crawling of sites whose robots.txt blanket-disallows, e.g.
    // an official API meant for programmatic use). Default true.
    obey: z.boolean().default(true),
    // Hosts exempted from robots.txt even when `obey` is true (allowlist).
    allowHosts: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const CrawlerConfigSchema = z
  .object({
    userAgent: z.string().min(1),
    rateLimit: RateLimitConfigSchema,
    concurrency: ConcurrencyConfigSchema,
    backoff: BackoffConfigSchema,
    robots: RobotsConfigSchema,
  })
  .strict();

export const StoreConfigSchema = z
  .object({
    root: z.string().min(1),
    freshnessSloSeconds: z.number().int().min(60).default(86400),
  })
  .strict();

export const NotifierConfigSchema = z
  .object({
    kind: z.enum(['stderr', 'webhook']),
    webhookUrl: z.string().url().nullable().optional(),
    webhookBearerEnv: z.string().min(1).nullable().optional(),
  })
  .strict();

export const ScheduleConfigSchema = z
  .object({
    enabled: z.boolean(),
    cron: z.string().nullable().optional(),
    // Cron fires in the SERVER's local time (`nextFire` computes on process-local `Date`); there is no
    // `timezone` knob (spec 056 FR-388 — the old option silently lied when server TZ ≠ configured TZ).
    // The schema is `.strict()`, so a config still carrying `timezone` fails loudly on load.
    // Only `'skip'` overlap handling exists (spec 056 FR-389 removed `'queue'`, which was
    // indistinguishable from `'skip'` — both threw `LockContentionError`); real queueing is a future
    // spec. A config with `onOverlap: 'queue'` fails validation, naming `'skip'` as the valid value.
    onOverlap: z.enum(['skip']),
    failureRateThreshold: z.number().min(0).max(1),
    notifier: NotifierConfigSchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.enabled && !val.cron) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'schedule.cron is required when schedule.enabled=true',
        path: ['cron'],
      });
    }
  });

export const ScopeConfigSchema = z
  .object({
    publishers: z.array(z.string().min(1)).optional(),
    categories: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    datasetIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const TranslatorConfigSchema = z
  .object({
    provider: z.enum(['local-marianmt', 'hosted-api']),
    modelId: z.string().nullable().optional(),
    endpointUrl: z.string().url().nullable().optional(),
    apiKeyEnv: z.string().min(1).nullable().optional(),
  })
  .strict();

export const EmbedderConfigSchema = z
  .object({
    provider: z.enum(['local-onnx', 'hosted-api']),
    modelId: z.string().nullable().optional(),
    endpointUrl: z.string().url().nullable().optional(),
    apiKeyEnv: z.string().min(1).nullable().optional(),
    // FR-002 / clarification Q2: number of texts per embedder request. Default 32, range 1–256.
    batchSize: z.number().int().min(1).max(256).default(32),
    // Optional provider-request cap; effective size = min(batchSize, maxBatchSize, providerCap).
    // `maxBatchSize === 1` forces single-text mode (FR-005). Unset/null means no cap.
    maxBatchSize: z.number().int().min(1).max(256).nullable().optional(),
    // The model's embedding vector dimension (recorded in embeddings_meta; a change vs the
    // stored value drives a full vector re-embed in run-index). Set it to match the configured
    // model (e.g. 384 for paraphrase-multilingual-MiniLM-L12-v2, 4096 for Qwen3-Embedding-8B).
    // Unset → the provider default (local-onnx: 32 stub; hosted-api: 384).
    dimension: z.number().int().min(1).max(8192).nullable().optional(),
  })
  .strict();

/**
 * Resolve the effective embedding batch size (FR-002, data-model §2): the smallest of the
 * configured `batchSize`, the optional config `maxBatchSize` cap, and the optional provider
 * capability cap (`Embedder.maxBatchSize`). A `null`/`undefined` cap is treated as no cap
 * (`Infinity`), so omitting both caps yields `batchSize` unchanged. A cap of 1 (config or
 * provider) yields 1, statically forcing single-text mode (FR-005).
 */
export function effectiveBatchSize(
  batchSize: number,
  configMax?: number | null,
  providerMax?: number | null,
): number {
  return Math.min(
    batchSize,
    configMax ?? Number.POSITIVE_INFINITY,
    providerMax ?? Number.POSITIVE_INFINITY,
  );
}

export const EnrichmentConfigSchema = z
  .object({
    translator: TranslatorConfigSchema,
    embedder: EmbedderConfigSchema,
  })
  .strict();

export const IndexConfigSchema = z
  .object({
    incremental: z.boolean(),
  })
  .strict();

export const DanniConfigSchema = z
  .object({
    portal: PortalConfigSchema,
    crawler: CrawlerConfigSchema,
    store: StoreConfigSchema,
    schedule: ScheduleConfigSchema,
    scope: ScopeConfigSchema,
    enrichment: EnrichmentConfigSchema,
    index: IndexConfigSchema,
  })
  .strict();

export type DanniConfig = z.infer<typeof DanniConfigSchema>;
export type PortalConfig = z.infer<typeof PortalConfigSchema>;
export type CrawlerConfig = z.infer<typeof CrawlerConfigSchema>;
export type StoreConfig = z.infer<typeof StoreConfigSchema>;
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;
export type ScopeConfig = z.infer<typeof ScopeConfigSchema>;
export type NotifierConfig = z.infer<typeof NotifierConfigSchema>;
export type EnrichmentConfig = z.infer<typeof EnrichmentConfigSchema>;
export type TranslatorConfig = z.infer<typeof TranslatorConfigSchema>;
export type EmbedderConfig = z.infer<typeof EmbedderConfigSchema>;
export type IndexConfig = z.infer<typeof IndexConfigSchema>;
