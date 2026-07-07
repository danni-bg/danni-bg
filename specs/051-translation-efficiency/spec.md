# Feature Specification: Translation efficiency (skip unchanged, honor force, bypass the stub)

**Feature Branch**: `051-translation-efficiency`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): the
translate stage re-invokes the translator for every subject on every curate run even when nothing
changed, its documented `force` option is dead, and the default stub translator burns a full
catalog loop producing empty rows.

## Overview

Make the enrich/translate stage incremental: invoke the translator only for subjects whose source
text is new or changed under the configured translator, implement (or delete) the phantom `force`
escape hatch, and skip the stage entirely when the configured translator is the no-op
local-marianmt stub. With a real hosted translator, today's behavior is a full-catalog re-translate
(cost + wall-clock) on **every** `danni curate`.

Single responsibility: **translation work happens only when it can produce new value.** Translator
providers/quality and the curate pipeline's other stages are untouched.

## Finding & evidence

- **(a) Unconditional re-translate per curate run.** `translateSubjects` loops every input and
  calls `opts.translator.translate(...)` + `repo.upsert(...)` unconditionally
  (`src/enrich/translate.ts:31-46`); its caller runs it for every curated dataset's title +
  description on every non-`--entities-only` curate (`src/curate/run-curate.ts:152-170`). No
  compare against the stored row — yet `TranslationsRepo.findExact(subjectKind, subjectId,
  translator)` (`src/store/repos/translations.ts:63-75`) already returns the stored `text_bg`, so
  a compare-and-skip on (subject, translator, unchanged `text_bg`) is one query.
- **(b) The `force` option is documentation fiction.** `TranslateRunOptions.force` is declared and
  documented ("If `force` is false (default) …", `src/enrich/translate.ts:13-17`) but never read
  anywhere in the function body; the caller never passes it (`run-curate.ts:165-168`). The
  "unless explicitly forced" comment in `TranslationsRepo.upsert`
  (`src/store/repos/translations.ts:38-39`) refers to this parameter that does not exist —
  implement it or delete both the option and the comment.
- **(c) The default translator is a stub that yields nothing.** `danni curate` builds
  `LocalMarianMtTranslator` whenever `enrichment.translator.provider` is not `hosted-api`
  (`src/cli/curate.ts:52-64`; the config enum is `local-marianmt | hosted-api`,
  `src/config/schema.ts:103`), and without a custom `translateFn` the stub returns
  `{ text: '', confidence: 0 }` (`src/enrich/translators/local-marianmt.ts:26-31`). A default full
  curate therefore loops the whole catalog "translating" into rows that add nothing. The stage
  should be skipped outright (with a log line) when the effective translator is the stub, keeping
  the config seam for a real hosted-api translator.

## Requirements

- **FR-330**: The translate stage MUST skip a subject — no translator invocation, no row write —
  when a stored translation already exists for the same (subject kind, subject id, translator)
  with an identical `text_bg`. A changed `text_bg`, a new subject, or a different translator id
  MUST still translate.
- **FR-331**: The `force` option MUST become real: `force: true` bypasses the FR-330 skip and
  re-invokes the translator for every subject (and permits overwriting a non-empty `text_en` with
  the fresh result, aligning `TranslationsRepo.upsert`'s comment with behavior) — or, if forcing
  is deemed YAGNI, the option, its doc comment, and the stale `upsert` comment MUST all be
  removed. Dead documented parameters MUST NOT remain.
- **FR-332**: When the effective translator is the local-marianmt stub with no `translateFn`
  (i.e. it can only produce empty output), curate MUST skip the translation stage entirely and
  emit one log line saying so; configuring a `hosted-api` translator (or a stub `translateFn`
  override) re-enables the stage with no other changes.
- **FR-333**: The curate summary MUST report translation work honestly: counts of translated,
  skipped-unchanged, and empty-source subjects (extending the existing `translationsWritten` in
  the `curate.completed` log), so an operator can verify FR-330/332 from the log alone.

## Success criteria

- **SC-1**: Two consecutive full curate runs over an unchanged catalog with a (mock) hosted
  translator: the second run performs **zero** translator invocations (asserted via a counting
  mock) and reports all subjects as skipped.
- **SC-2**: Changing one dataset's title between runs re-translates exactly that subject; the
  translator invocation count equals the number of changed/new subjects.
- **SC-3**: A default (stub-translator) full curate performs zero translator invocations and zero
  translation-row writes, and logs the stage skip once.
- **SC-4**: If `force` is kept: a forced run re-invokes the translator for every non-empty
  subject. If removed: no reference to `force` remains in `src/enrich/translate.ts` or
  `src/store/repos/translations.ts`.

## Out of scope / dependencies

- Translator quality/providers (real MarianMT or a new hosted API) — the `Translator` seam and
  `hosted-api` implementation are unchanged (spec 001's enrichment stage).
- `--entities-only` curate (spec 015) already bypasses translation; unaffected.
- Where EN titles are consumed (search results, explorer UI — specs 008/050) — read side untouched.
