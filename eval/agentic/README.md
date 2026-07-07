# Agentic quality evals (DeepEval)

Offline, real-model quality evals for the grounded chat. Complements — does **not**
replace — `apps/explorer-api/tests/grounding-benchmark.test.ts`:

| Layer | Runner | Model | Gates? | Proves |
|-------|--------|-------|--------|--------|
| Enforcement benchmark | `bun:test` | **mocked** (hermetic, Constitution VI) | ✅ per-PR | the pipeline *drops* fabrications |
| **Agentic eval (this)** | DeepEval / pytest | **real** LAN gemma | ❌ on-demand/nightly | the real model behaves: grounds, picks tools, refuses honestly |

It drives the **real** chat API over HTTP (`POST /api/chat`) and grades three axes:
faithfulness / anti-fabrication, tool-use correctness, and refusal calibration.

## Run

```bash
bun run explorer:api          # the system-under-test must be up (port 8790)
bun run eval:agentic          # or, from here: uv run pytest
```

If the API is down the suite **skips** with a clear message (not an error).

## Configuration

Every LLM is configurable; defaults inherit the repo-root `.env`
(`EXPLORER_DEFAULT_*`), so out of the box gemma is both subject and judge. To
override (e.g. an independent judge), copy `.env.example` → `eval/agentic/.env`.
See that file for all `EVAL_*` keys.

- **Subject** = the model the chat runs under — the server-configured provider
  (admin settings → `EXPLORER_DEFAULT_*`). Since spec 035 the request carries no
  provider block, so repoint the server (not the eval) to grade a different model.
- **Judge** = the G-Eval grader. Using gemma to judge gemma is convenient but
  correlated — point `EVAL_JUDGE_*` at a stronger/different endpoint for rigour.

> **Judge reliability.** The local `gemma-4-26b` is **not a trustworthy judge** for the
> long-enumeration cases (questions that legitimately list 20–30 datasets): it can't track
> a 16–32K-char grounding context and false-flags grounded datasets as "fabricated".
> Verified by hand-adjudicating its failures against the exact injected grounding — its
> verdicts didn't hold up. **Use a frontier judge** for any verdict you act on. Qwen via
> **Alibaba Model Studio** is OpenAI-compatible and needs no code change — see the
> `EVAL_JUDGE_*` Qwen block in `.env.example`. The deterministic guards below need no judge
> at all, so a weak judge can't fool them.

The judge constrains its output with `response_format=json_schema` (falling back
to `json_object`) so a local model returns schema-valid scores — note that vLLM
`guided_json` via `extra_body` is silently ignored by some servers, which is why
we use `response_format`. Set `EVAL_JUDGE_STRUCTURED=0` to force `json_object` only.

## What's graded

- **Deterministic** (no judge): no-data answers match the exact reply and cite
  nothing; fabricated ids never reach citations; grounded answers cite ≥1 dataset.
- **Grounding invariants** (`guards.py`, no judge): every dataset id stated in the
  answer must appear in the injected grounding (no ghost ids), and a "над N набора" /
  "over N datasets" claim must not exceed the number of datasets grounded (no count
  inflation). This catches the chat's one real, intermittent failure mode mechanically —
  independent of the LLM judge, which on a weak model both misses and over-flags it.
- **Tool correctness** (`ToolCorrectnessMetric`): the right mirror tool was called.
- **Judge-graded** (`G-Eval`): faithfulness (claims traceable to cited rows) and
  refusal quality (honest "no data" vs improvisation).

## Grounding transparency

Faithfulness is judged against the **exact** context the model was injected with, not a
reconstruction: the chat API emits a `grounding` SSE event (only when the request sets
`debug: true`) carrying the precise grounded text. The eval requests it and judges against
that, so a verdict can't be a context-mismatch artifact.

## Known model limitation (tracked as xfail)

`pancharevo-kindergartens` (always) and `budget-grounded` (intermittently) are marked
`known_model_fabrication` in `cases.py`. The RAG path now correctly injects the real rows
(verified: the genuine Панчарево record reaches the model), yet `gemma-4-26b-uncensored`
still fabricates specifics from partial grounding. This is a **model/guardrail** issue, not
a grounding one — recorded as xfail so the suite stays green and the case auto-surfaces if a
model swap or guardrail fixes it. Clear it once the underlying behavior improves.

## Scope & next steps

This is a **thin slice** (6 cases in `cases.py`) against live data, so exact cited
ids are intentionally not pinned. Grow `cases.py` after the first run; consider
Ragas synthetic-question generation to scale the set, and a nightly `at`/cron run
mirroring the metadata-refresh job. A full spec belongs in `specs/018-agentic-evals/`.
