# Holistic review — 2026-07-03 (SaaS best practices · architecture patterns · DRY · YAGNI)

A four-lens re-evaluation of the implementation as of `564a737` (post open-core split, specs
001–029 shipped): the SaaS platform layer (`apps/explorer-api`), the core pipeline (`src/`), the
frontend (`apps/explorer-web`), and cross-cutting operational readiness. Every finding was
verified against the code before being spec'd; each remediation spec re-verified its file:line
evidence again at writing time and corrected the review where it drifted (corrections are noted
inside the specs).

**Overall verdict.** Layering, migration/secret hygiene, per-user isolation, and the tested pure
lib layers are genuinely strong; nearly every single-node shortcut is documented in code with its
upgrade path. The debt concentrates at the edges of the newest layers (019–029): four security
holes on the SaaS surface, a multi-tenancy control plane that shipped as schema without behavior,
and a tail of DRY/YAGNI hygiene. Nothing requires a rewrite.

Each finding became (part of) a **single-responsibility spec**, numbered `034`–`060`
(030–033 live in the private deploy repo). FR numbering continues the global sequence from
`FR-160` (the deploy repo ends at `FR-159`), in per-spec blocks of ten (055/056: fifteen).

## Fix first — security (exposure beyond a trusted LAN is unsafe until these land)

| Spec | Single responsibility | Finding |
|---|---|---|
| [034-identity-trust-boundary](../../specs/034-identity-trust-boundary/spec.md) | backend only accepts verifiable identity assertions | Spoofable `X-User-*` headers beat the Kratos session check in single-port mode; bootstrap email → super-admin; bootstrap ignores `verified` |
| [035-chat-provider-lockdown](../../specs/035-chat-provider-lockdown/spec.md) | chat runs only against the server-configured provider | `/api/chat` accepts arbitrary client `baseUrl`+`apiKey` → authenticated SSRF/egress proxy (UI override was removed in 022; API surface remained) |
| [036-org-role-integrity](../../specs/036-org-role-integrity/spec.md) | org role changes follow explicit rules on every path | `addMember` upsert lets an org admin demote the owner; PATCH bypasses owner/last-owner guards |
| [037-production-mail-delivery](../../specs/037-production-mail-delivery/spec.md) | prod account emails reach a real SMTP relay | Kratos courier hardwired to Mailpit; recovery links (takeover material) publicly readable on `:14438` in prod |
| [038-api-key-scope-coverage](../../specs/038-api-key-scope-coverage/spec.md) | every `/api/me` surface declares human-vs-key access | `read`-scoped keys can delete chat sessions, stop generations, set avatars |

## SaaS control plane — correctness & completion

| Spec | Single responsibility | Finding |
|---|---|---|
| [039-chat-metering-integrity](../../specs/039-chat-metering-integrity/spec.md) | every billed token is metered; quota 429s are correct | Usage recorded only on success (mid-turn throw = unmetered spend); no `Retry-After`; concurrent pre-check race |
| [040-request-quota-semantics](../../specs/040-request-quota-semantics/spec.md) | quotas/limits attribute to a defined principal with a settable limit | Per-key `quota_limit` compared against per-owner counts and unsettable by any route; gate-vs-record semantics undocumented; `tenants.plan` drives nothing |
| [041-tenant-activation](../../specs/041-tenant-activation/spec.md) | a non-default org is actually reachable | Active tenant is hard-wired to the oldest (= `default`) membership; no switch endpoint; created orgs are permanently empty |
| [042-tenant-scoped-settings](../../specs/042-tenant-scoped-settings/spec.md) | per-tenant runtime config is resolvable and manageable | Migration 017's `(tenant_id,key)` pivot + repo fallback exist but every caller reads/writes the global row (029 FR-131 dead) |

## Operations & self-hosting

| Spec | Single responsibility | Finding |
|---|---|---|
| [043-store-operational-safety](../../specs/043-store-operational-safety/spec.md) | the production store tolerates concurrent writers and is recoverable | No `busy_timeout` (sync vs live serving = instant `SQLITE_BUSY`); no backup/restore story for the file holding identity+billing+mirror; every gated read is a write (last-seen bumps) |
| [044-runtime-image-hardening](../../specs/044-runtime-image-hardening/spec.md) | the shipped container is minimal and unprivileged | Runtime image = full build stage copy, runs as root |
| [045-saas-observability](../../specs/045-saas-observability/spec.md) | tail latency, per-tenant attribution, quota exhaustion are observable | Avg-only durations (no p95/p99), no tenant label, token-quota 429s uncounted; `/metrics` exposure undecided |
| [046-ci-e2e-gate](../../specs/046-ci-e2e-gate/spec.md) | the browser e2e suite gates CI | Playwright configured (hermetic fixtures already stub API+Kratos) but never runs in CI |
| [047-self-host-parity](../../specs/047-self-host-parity/spec.md) | everything this repo references or promises exists here | Dangling deploy-repo pointers (observability config + operations runbook); example config can't sync data.egov.bg as shipped |

## Pipeline correctness & scale

| Spec | Single responsibility | Finding |
|---|---|---|
| [048-egov-scope-fidelity](../../specs/048-egov-scope-fidelity/spec.md) | `scope` means the same thing on every portal adapter | egov campaign honors only `datasetIds`; publishers/tags silently dropped (CKAN honors all four) |
| [049-byte-faithful-capture](../../specs/049-byte-faithful-capture/spec.md) | `store/raw/` is byte-faithful; all transformation lives in curate | egov captures CSV-converted, header-flattened, re-serialized output as "raw" — fixes require re-crawling |
| [050-search-scale](../../specs/050-search-scale/spec.md) | search scales to the full corpus with a consistent contract | Full embedding corpus (~190 MB) deserialized per query on the hot path; search route resurrects the per-hit view fan-out; `IndexEntry` halves disagree |
| [051-translation-efficiency](../../specs/051-translation-efficiency/spec.md) | translation runs only when it can produce new value | Full-catalog re-translate every curate even when unchanged; stub translator loops the catalog writing empty rows; dead `force` option |
| [052-pipeline-write-atomicity](../../specs/052-pipeline-write-atomicity/spec.md) | multi-table writes are atomic; repos share one upsert idiom | egov capture/enrich write unwrapped; ~10⁵ single-statement implicit transactions in linking; two racy upsert idioms coexist |
| [053-mcp-read-parity](../../specs/053-mcp-read-parity/spec.md) | both front doors expose the same read capabilities | MCP `read_resource` lacks the 017 value-filter/sort the chat tool has |
| [054-pipeline-robustness](../../specs/054-pipeline-robustness/spec.md) | failure/efficiency behavior is explicit, not incidental | Sniff reads whole files; embed backoff keyed to an error-message regex; org paging silently caps at 1200 |

## DRY & YAGNI

| Spec | Single responsibility | Finding |
|---|---|---|
| [055-backend-dry-consolidation](../../specs/055-backend-dry-consolidation/spec.md) | one shared implementation per repeated backend idiom | Body-parse block ×9, sync-runner epilogue ×2 verbatim, staleness ×5, LLM-config shape ×3, inconsistent `requireAuth` wiring, pointer duplication |
| [056-backend-surface-cleanup](../../specs/056-backend-surface-cleanup/spec.md) | no dead or inconsistent affordances — wire or delete | `lang` plumbed through 4 layers unread (delete); `chatEnabled` never consulted (wire as kill-switch); dead `freshnessSloSeconds`/`timezone`/`'queue'`/exports; unbounded admin lists; `/api/me` mount coupled to metering; v1 policy |
| [057-frontend-data-layer](../../specs/057-frontend-data-layer/spec.md) | one way to fetch, cache, and surface server state | ~10 hand-rolled fetch effects, 15 hand-rolled wrappers in two conventions, outages swallowed into plausible empty states |
| [058-chat-session-lifecycle](../../specs/058-chat-session-lifecycle/spec.md) | chat session lifecycle lives in one tested state machine | 676-line `ChatPanel` re-implements stream attach without error handling; resumed-turn duration wrong; dead `tool` event |
| [059-frontend-api-types](../../specs/059-frontend-api-types/spec.md) | every API payload type has exactly one definition | `types.ts` hand-mirrors backend schemas (plus a third inline copy) in the same repo |
| [060-frontend-structure-hygiene](../../specs/060-frontend-structure-hygiene/spec.md) | every frontend concern has one home, no dead affordances | Split-brain dataset selection; account page inside `KratosFlow`; unused shadcn inputs beside 7 hand-rolled class blobs; duplicated formatters; dead exports |

## What the review confirmed as strengths (do not regress)

- Build/serve layering: the serve layer never writes to the mirror; `src/read` is a real shared
  substrate for MCP and the explorer.
- The migrate-on-release loop (checksum-guarded runner, migrate-on-boot abort, `/readyz` gate).
- API-key and chat-session isolation; masked-secret admin settings; the redacting logger and
  placeholder-audit secret gate.
- The tested pure `lib/*` layers on both frontend and backend; the SSE protocol layering;
  documented-in-code single-node constraints with named upgrade paths.

## Suggested implementation order

1. **034–038** (security; small diffs, big exposure), then **043** (busy_timeout + backup).
2. **041 → 042** (make tenancy real — or explicitly freeze 029 as schema-only), **039/040**
   (metering semantics), **045/046** (observe + gate).
3. **048/049** (adapter fidelity before the raw archive grows), **050** (search hot path), **051/052**.
4. **055–060** hygiene, opportunistically or as prerequisites when touching the same files.
