// Chat turn orchestration (T049). Default path: an AI-SDK tool-use loop over the four scoped tools.
// Fallback path (runRagTurn): when the provider can't do tool-calling (many self-hosted vLLM/Gemma
// deployments aren't started with --enable-auto-tool-choice), the backend does the retrieval itself
// and feeds the scoped datasets to the model as context — so grounded chat works with ANY
// OpenAI-compatible model. Either way the model is injected so tests drive it with a stub (no LLM).

import { type LanguageModel, type ModelMessage, stepCountIs, streamText } from 'ai';
import type { CuratedDatasetView } from '../../../../src/read/dataset-view.ts';
import type { ReadBridge } from '../read-bridge.ts';
import type { ScopeDescriptor } from '../schemas.ts';
import { capResourceContent } from './cap.ts';
import {
  type Citation,
  GEO_SCOPE_NOTE,
  type MapAnchor,
  NO_DATA_REPLY,
  SYSTEM_PROMPT,
  buildAnchors,
  buildCitations,
} from './grounding.ts';
import { inScope } from './scope.ts';
import { GEO_SCOPED_SEARCH_LIMIT, buildTools } from './tools.ts';

export interface ChatTurnEvents {
  onToken?: (delta: string) => void;
  onTool?: (name: string, status: 'start' | 'done') => void;
  /** Cumulative token usage, emitted per step (live ↑input/↓output) and once more, exact, at the end. */
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  }) => void;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Portion of inputTokens served from the provider's prompt cache. */
  cachedInputTokens: number;
}

export interface ChatTurnResult {
  text: string;
  citations: Citation[];
  anchors: MapAnchor;
  /**
   * The grounding context actually injected into the model this turn (focused-dataset rows on the
   * tool path; the retrieved-candidate rows block on the RAG path). Surfaced for observability /
   * offline faithfulness evals — emitted to clients only on explicit debug request.
   */
  groundingText?: string | undefined;
  /** Token usage for the turn (summed across tool steps), for per-user metering. */
  usage?: TokenUsage | undefined;
}

/** Read token usage off a streamText result; tolerates providers that omit fields. */
async function readUsage(result: { totalUsage: PromiseLike<unknown> }): Promise<TokenUsage> {
  try {
    const u = (await result.totalUsage) as
      | {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
          cachedInputTokens?: number;
        }
      | undefined;
    const inputTokens = u?.inputTokens ?? 0;
    const outputTokens = u?.outputTokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: u?.totalTokens ?? inputTokens + outputTokens,
      cachedInputTokens: u?.cachedInputTokens ?? 0,
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 };
  }
}

export interface RunChatTurnOptions {
  model: LanguageModel;
  bridge: ReadBridge;
  scope: ScopeDescriptor;
  messages: ModelMessage[];
  /**
   * Datasets to pre-read as grounded context this turn (sticky focus). Drives buildFocusContext ONLY
   * — it does NOT restrict tool scope — so follow-ups stay grounded without narrowing what tools may
   * read. Defaults to `scope.datasetIds` when omitted.
   */
  groundingDatasetIds?: string[];
  maxSteps?: number;
  /** Max tokens the model may generate; defaults to MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
  /** Abort the generation (e.g. a server-side stop). Forwarded to streamText. */
  abortSignal?: AbortSignal;
  events?: ChatTurnEvents;
}

const EMPTY_ANCHOR: MapAnchor = { geoEntityIds: [], datasetIds: [] };
const RAG_LIMIT = 6;
// How many of the top retrieved candidates to pre-read rows for on the RAG path. Bounded so the
// per-turn read + prompt size stay reasonable; the rest are still listed by title as an index.
const RAG_GROUNDING_DATASETS = 3;
// Always reserve output room so a borderline-large input can't make the provider compute a
// non-positive output budget (vLLM reports "requested 0 output tokens"). Cyrillic is token-heavy, so
// keep this generous enough that a detailed enumerated answer isn't truncated mid-sentence.
const MAX_OUTPUT_TOKENS = 4096;
// A comparison-across-periods question needs one readResource per period (each a separate dataset)
// plus the initial search/info; 6 steps ran out after reading a single year. Tool results are now
// size-capped, so a deeper loop stays well within the context window.
const DEFAULT_MAX_STEPS = 16;

const resolver =
  (bridge: ReadBridge) =>
  (id: string): CuratedDatasetView | null => {
    try {
      return bridge.view(id);
    } catch {
      return null;
    }
  };

// Focused-dataset context block: fetch generously (so value-filter questions like "the rows for
// район Панчарево" see the relevant rows, not just the first page), bounded by a TOTAL character
// budget across all focused datasets/resources so the system prompt can't overflow the context.
const FOCUS_ROWS = 1000;
const GROUNDING_TOTAL_CHARS = 90_000;
const FOCUS_HEADER =
  'ДАННИ (ground truth) — потребителят разглежда следните набори. Отговаряй от тези редове; ако ' +
  'извадката е частична (отбелязано) или търсиш конкретни стойности в дадена колона, извикай ' +
  'readResource с filters (име на колона → подниз), за да получиш точните редове:';
// RAG-path variant: tools are NOT available here, so the model can't fetch more rows — it must
// answer from this sample or say there is no data. No readResource hint (it can't call it).
const RAG_GROUNDING_HEADER =
  'ДАННИ (ground truth) — извадка от редовете на най-релевантните набори по-долу. Отговаряй САМО ' +
  'въз основа на тези редове и заглавия; НЕ измисляй стойности (имена, ЕИК, адреси, дати, числа). ' +
  'Ако извадката не съдържа търсеното, кажи че няма такива данни в портала:';

/**
 * Build a grounded context block for the datasets the user has focused ("ask about this dataset").
 * The focus id only *scopes* the tools; the model is never told what it is or shown its rows — so it
 * confabulates. We pre-read a capped sample of each focused dataset's resources and hand it over as
 * ground truth, so the answer is grounded by construction (and the RAG fallback works at all).
 */
export function buildFocusContext(
  bridge: ReadBridge,
  datasetIds: string[],
  resolve: (id: string) => CuratedDatasetView | null,
): { text: string; ids: string[] } | null {
  const blocks: string[] = [];
  const ids: string[] = [];
  let budget = GROUNDING_TOTAL_CHARS;
  for (const id of datasetIds) {
    if (budget <= 0) break;
    const view = resolve(id);
    if (!view) continue;
    ids.push(view.datasetId);
    const parts = [`Набор от данни „${view.title.bg}“ (id: ${view.datasetId}).`];
    for (const r of view.resources) {
      if (budget <= 0) break;
      try {
        // Cap each resource to the remaining budget, so the whole block stays bounded.
        const c = capResourceContent(
          bridge.rows(view.datasetId, r.resourceId, FOCUS_ROWS, 0),
          budget,
        );
        const note = c.truncated ? ' (частична извадка)' : '';
        let body = '';
        if (c.rows.length > 0) {
          body = JSON.stringify(c.rows);
          // Surface the exact column keys so the model can target readResource filters precisely.
          const cols = Object.keys((c.rows[0] ?? {}) as Record<string, unknown>);
          parts.push(
            `Ресурс „${r.name ?? r.resourceId}“ (resourceId: ${r.resourceId}) — ${c.total} реда общо, показани ${c.rows.length}${note}. Колони: ${cols.join(', ')}.`,
            body,
          );
        } else if (c.document !== undefined) {
          body = JSON.stringify(c.document);
          parts.push(`Ресурс „${r.name ?? r.resourceId}“ (документ)${note}:`, body);
        } else if (c.text !== undefined) {
          body = c.text;
          parts.push(`Ресурс „${r.name ?? r.resourceId}“ (текст)${note}:`, body);
        }
        budget -= body.length;
      } catch {
        // Unreadable resource (no successful capture) — skip; the model can still readResource.
      }
    }
    blocks.push(parts.join('\n'));
  }
  return blocks.length > 0 ? { text: blocks.join('\n\n'), ids } : null;
}

/** True when the provider rejected tool-calling (so we should retry without tools). */
export function isToolChoiceUnsupported(error: unknown): boolean {
  const m = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    m.includes('tool choice') ||
    m.includes('tool_choice') ||
    m.includes('enable-auto-tool-choice') ||
    m.includes('does not support tools') ||
    m.includes('tools are not supported')
  );
}

function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return typeof m.content === 'string' ? m.content : '';
  }
  return '';
}

export async function runChatTurn(opts: RunChatTurnOptions): Promise<ChatTurnResult> {
  try {
    return await runToolLoop(opts);
  } catch (error) {
    if (isToolChoiceUnsupported(error)) return runRagTurn(opts);
    throw error;
  }
}

/** Tool-use loop for providers with native function-calling. */
export async function runToolLoop(opts: RunChatTurnOptions): Promise<ChatTurnResult> {
  const { model, bridge, scope, messages, events } = opts;
  const { tools, citedDatasetIds } = buildTools(bridge, scope);
  const resolve = resolver(bridge);
  // Pre-read focused datasets so the model is grounded in real rows, not the title alone.
  const focus = buildFocusContext(
    bridge,
    opts.groundingDatasetIds ?? scope.datasetIds ?? [],
    resolve,
  );
  // Under a geo-scope, reinforce that the model must not pad the list with out-of-region datasets.
  const geoScoped = (scope.geoUnitIds?.length ?? 0) > 0;
  const base = geoScoped ? `${SYSTEM_PROMPT}\n\n${GEO_SCOPE_NOTE}` : SYSTEM_PROMPT;
  const system = focus ? `${base}\n\n${FOCUS_HEADER}\n${focus.text}` : base;

  // Accumulate usage across tool steps so the client gets a live ↑input/↓output readout (each step is
  // a separate provider call; its usage is per-step, so we sum). The exact total is re-emitted at the end.
  const acc = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const result = streamText({
    model,
    system,
    messages,
    tools,
    maxOutputTokens: opts.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    stopWhen: stepCountIs(opts.maxSteps ?? DEFAULT_MAX_STEPS),
    onStepFinish: (step) => {
      acc.inputTokens += step.usage?.inputTokens ?? 0;
      acc.outputTokens += step.usage?.outputTokens ?? 0;
      acc.cachedInputTokens += step.usage?.cachedInputTokens ?? 0;
      events?.onUsage?.({ ...acc });
    },
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });

  let text = '';
  // Capture the tool results the model actually received — this IS the grounding on the tool path
  // (the analogue of the focus/RAG row block). Surfaced via groundingText for observability/evals so
  // a faithfulness check sees exactly what the model saw. Bounded so a big result can't grow unbounded.
  const toolResults: string[] = [];
  let toolResultsChars = 0;
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      text += part.text;
      events?.onToken?.(part.text);
    } else if (part.type === 'tool-call') {
      events?.onTool?.(part.toolName, 'start');
    } else if (part.type === 'tool-result') {
      events?.onTool?.(part.toolName, 'done');
      if (toolResultsChars < GROUNDING_TOTAL_CHARS) {
        const line = `Резултат от ${part.toolName}: ${JSON.stringify(part.output ?? null)}`.slice(
          0,
          GROUNDING_TOTAL_CHARS - toolResultsChars,
        );
        toolResults.push(line);
        toolResultsChars += line.length;
      }
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }

  const usage = await readUsage(result);
  events?.onUsage?.(usage); // authoritative final total (reconciles the per-step estimate, adds cached)
  if (text.trim() === '') {
    return { text: NO_DATA_REPLY, citations: [], anchors: EMPTY_ANCHOR, usage };
  }
  // Cite the focused datasets (their rows were the ground truth) plus any the model read via tools.
  const citations = buildCitations([...(focus?.ids ?? []), ...citedDatasetIds], resolve, (v) =>
    inScope(v, scope),
  );
  const groundingText = [focus?.text, ...toolResults].filter(Boolean).join('\n\n') || undefined;
  return {
    text,
    citations,
    anchors: buildAnchors(citations, resolve, bridge.partOfParents()),
    usage,
    ...(groundingText ? { groundingText } : {}),
  };
}

/** Retrieval-augmented fallback: the backend retrieves scoped datasets and feeds them as context. */
export async function runRagTurn(opts: RunChatTurnOptions): Promise<ChatTurnResult> {
  const { model, bridge, scope, messages, events } = opts;
  const query = lastUserText(messages);
  const resolve = resolver(bridge);

  // Retrieve scoped candidates ourselves (the model never sees out-of-scope data).
  events?.onTool?.('mirrorSearch', 'start');
  const candidates: CuratedDatasetView[] = [];
  const seen = new Set<string>();
  const add = (view: CuratedDatasetView | null): void => {
    if (
      view &&
      !seen.has(view.datasetId) &&
      inScope(view, scope) &&
      candidates.length < RAG_LIMIT
    ) {
      seen.add(view.datasetId);
      candidates.push(view);
    }
  };
  // Seed any explicitly focused datasets ("ask about this dataset") first.
  for (const id of scope.datasetIds ?? []) add(resolve(id));
  const geoScoped = (scope.geoUnitIds?.length ?? 0) > 0;
  // Over-fetch under a geo-scope so in-region datasets that rank lower globally still surface.
  for (const hit of await bridge.search(query, geoScoped ? GEO_SCOPED_SEARCH_LIMIT : 12)) {
    add(resolve(hit.datasetId));
  }
  // Scope-aware backfill: ranked search under a geo-scope under-surfaces a small region's datasets, so
  // pull the region's datasets directly (the geoUnitIds are rolled up to oblast + municipalities) to
  // fill out the candidates — scoping should narrow, not empty.
  if (geoScoped && candidates.length < RAG_LIMIT) {
    for (const geoId of scope.geoUnitIds ?? []) {
      for (const hit of await bridge.entityDatasets(geoId, RAG_LIMIT)) add(resolve(hit.datasetId));
    }
  }
  events?.onTool?.('mirrorSearch', 'done');

  if (candidates.length === 0) {
    return { text: NO_DATA_REPLY, citations: [], anchors: EMPTY_ANCHOR };
  }

  const context = candidates
    .map(
      (v, i) =>
        `${i + 1}. ${v.title.bg} (издател: ${v.publisher?.title.bg ?? '—'}; ${v.freshness.isStale ? 'остарели' : 'актуални'} данни)`,
    )
    .join('\n');
  // Ground the answer in REAL rows, not just titles. The model can't call tools on this path, so we
  // pre-read a sample of the top retrieved candidates (plus any explicitly focused dataset, which
  // takes budget priority) and hand it over as ground truth — otherwise the model confabulates
  // specific values (names, dates, ids) from the titles alone.
  const explicitFocusIds = opts.groundingDatasetIds ?? scope.datasetIds ?? [];
  const groundingIds = [
    ...new Set([
      ...explicitFocusIds,
      ...candidates.slice(0, RAG_GROUNDING_DATASETS).map((v) => v.datasetId),
    ]),
  ];
  const grounding = buildFocusContext(bridge, groundingIds, resolve);
  const geoNote = geoScoped
    ? ' Активен е географски филтър: описвай САМО наборите по-долу за избрания регион; НЕ добавяй набори, издатели или институции от други региони (други области/общини), дори да съществуват.'
    : '';
  const system = `${SYSTEM_PROMPT}\nОтговаряй само въз основа на данните по-долу. Позовавай се на наборите по заглавие; НЕ показвай технически идентификатори. Не измисляй стойности (имена, ЕИК, числа) — ако данните не ги съдържат, кажи го. Ако никой не е релевантен на въпроса, отговори, че няма релевантни публични данни.${geoNote} Форматирай отговора с Markdown.`;
  const userMsg = `${grounding ? `${RAG_GROUNDING_HEADER}\n${grounding.text}\n\n` : ''}Налични набори от данни:\n${context}\n\nВъпрос: ${query}`;

  const result = streamText({
    model,
    system,
    messages: [{ role: 'user', content: userMsg }],
    maxOutputTokens: opts.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    onStepFinish: (step) => {
      events?.onUsage?.({
        inputTokens: step.usage?.inputTokens ?? 0,
        outputTokens: step.usage?.outputTokens ?? 0,
        cachedInputTokens: step.usage?.cachedInputTokens ?? 0,
      });
    },
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });
  let text = '';
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      text += part.text;
      events?.onToken?.(part.text);
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }

  const usage = await readUsage(result);
  events?.onUsage?.(usage); // authoritative final total
  if (text.trim() === '') {
    return { text: NO_DATA_REPLY, citations: [], anchors: EMPTY_ANCHOR, usage };
  }
  // Cite the candidates the answer actually referenced (by id or title); fall back to the top hit so a
  // substantive answer always carries ≥1 citation (SC-004). All are retrieved + in-scope (SC-005/008).
  const mentioned = candidates.filter(
    (v) => text.includes(v.datasetId) || text.includes(v.title.bg),
  );
  const chosen = mentioned.length > 0 ? mentioned : candidates.slice(0, 1);
  const citations = buildCitations(
    chosen.map((v) => v.datasetId),
    resolve,
    (v) => inScope(v, scope),
  );
  return {
    text,
    citations,
    anchors: buildAnchors(citations, resolve, bridge.partOfParents()),
    usage,
    ...(grounding ? { groundingText: grounding.text } : {}),
  };
}
