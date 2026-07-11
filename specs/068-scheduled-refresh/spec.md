# Spec 068 — Scheduled full refresh (`danni pipeline`)

## Context

Go-live blocker #1 for the public explorer is **live data**: the mirror is refreshed by hand today
(no scheduled sync anywhere — the only cronjob on the cluster is the Kratos DB backup, and the last
sync was days old). The explorer serves *curated + indexed* data, so a refresh is the whole pipeline
— **sync → curate → index** — not just a crawl.

The existing `danni schedule` runs an in-process daemon whose cron fire calls only the **sync** stage
(`runPortalSync`). That's the wrong shape for k8s and only a third of the pipeline. The right shape is
a **k8s CronJob** (the cluster owns the schedule + retries + alerting) invoking a **one-shot**
full-refresh command.

This adds that command. The CronJob manifest itself lives in the deploy repo overlays (commercial
layer); this spec is the app-side entrypoint it calls.

## Functional requirements

- **FR-500** `danni pipeline` runs the full refresh **sync → curate → index**, in order, in one
  process, and exits `0` iff every stage succeeded.
- **FR-501** **Fail-fast**: if a stage exits non-zero, the pipeline stops and returns *that stage's*
  exit code — later stages are skipped, so a failed sync is never curated/indexed into a half-updated
  mirror. The non-zero exit is the job-failure signal the cluster (CronJob `backoffLimit` + alerts)
  reacts to.
- **FR-502** Each stage opens/closes its own store + loads config exactly as the standalone CLI does
  (`danni sync`/`curate`/`index`), so `pipeline` is behaviorally identical to running the three by
  hand — it only makes the sequence one atomic, alertable unit. The stage runners are injectable for
  tests.
- **FR-503** Stage progress + a stage-failure line are logged with the shared logger
  (`component: pipeline`) for run correlation.

## Out of scope / notes

- The **CronJob** (schedule, volume mount to the shared store, `backoffLimit`, resource limits) is a
  deploy-repo artifact — the store is a single RWO volume (spec 043 `busy_timeout` already lets the
  refresh write while the app serves reads; the CronJob co-schedules with the app on the volume's node).
- The **hosted embedder** the `index` stage needs in prod (go-live decision: hosted LLM + hosted
  embedder) is deploy config (`enrichment.embedder`), not app code — the embedder factory already
  takes any provider.
- `danni schedule` (the in-process daemon) is left as-is for non-k8s single-host operators.

## Success criteria

- **SC-1** A CronJob invoking `danni pipeline` refreshes the mirror end-to-end; a failure in any stage
  fails the job with the right exit code and skips the rest.
- **SC-2** 100% line + function coverage on the new command (stage order + fail-fast at each stage).
