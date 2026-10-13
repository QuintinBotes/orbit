/**
 * How deep a review went. A reviewer that answers from the packet alone, with no tool call and a few reasoning tokens,
 * has not looked at the code, however independent its provider is. Each review session's tool calls and reasoning tokens
 * are read from its provider transcript when it ends and recorded as a `review.depth` decision (they survive the removal
 * of the worker directory); the final report shows them in its review table and flags a review that made no tool calls.
 * A transcript that cannot be read leaves both unknown (null), never zero.
 */
import { join } from 'node:path';
import { codexDepth } from '../adapters/codex-events.ts';
import { LOG_FILE } from '../adapters/shim.ts';
import { readLogLines } from '../adapters/supervise.ts';
import { getDecision, recordDecision } from '../storage/decisions.ts';
import type { WorkerRecord } from '../storage/workers.ts';
import type { RunContext } from './context.ts';

export const REVIEW_DEPTH_KIND = 'review.depth';

/** The tool Claude calls to hand back the structured answer the output schema asks for. */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

export interface ReviewDepth {
  review_id: string;
  worker_id: string;
  provider: string;
  model: string | null;
  /** Null: the transcript was not available. */
  tool_calls: number | null;
  /** Null: the transcript does not report them. */
  reasoning_tokens: number | null;
}

/**
 * Tool calls and reasoning tokens in one Claude transcript (stream-json). The StructuredOutput tool_use is how a worker
 * delivers its answer, not a look at anything, so a review that only answered counts none.
 */
export function claudeDepth(events: readonly Record<string, unknown>[]): { toolCalls: number; reasoningTokens: number | null } {
  const calls = new Set<string>();
  let anonymous = 0;
  let reasoning: number | null = null;
  for (const e of events) {
    if (e.type === 'assistant' && isObject(e.message) && Array.isArray(e.message.content)) {
      for (const b of e.message.content as unknown[]) {
        if (!isObject(b) || b.type !== 'tool_use' || b.name === STRUCTURED_OUTPUT_TOOL) continue;
        if (typeof b.id === 'string') calls.add(b.id);
        else anonymous++;
      }
    } else if (e.type === 'result' && isObject(e.usage) && isObject(e.usage.output_tokens_details)) {
      const t = e.usage.output_tokens_details.thinking_tokens;
      if (typeof t === 'number' && Number.isFinite(t)) reasoning = t;
    }
  }
  return { toolCalls: calls.size + anonymous, reasoningTokens: reasoning };
}

/** The depth of one worker's session, from its transcript; nulls when there is none. */
export function readReviewDepth(worker: Pick<WorkerRecord, 'provider' | 'workerDir'>): { toolCalls: number | null; reasoningTokens: number | null } {
  let events: Record<string, unknown>[];
  try {
    events = readLogLines(join(worker.workerDir, LOG_FILE)).events;
  } catch {
    return { toolCalls: null, reasoningTokens: null };
  }
  if (events.length === 0) return { toolCalls: null, reasoningTokens: null };
  return worker.provider === 'codex' ? codexDepth(events) : claudeDepth(events);
}

/** Record the depth of a review session once; a restart that records the review again finds the decision and keeps it. */
export function recordReviewDepth(ctx: RunContext, worker: Pick<WorkerRecord, 'id' | 'provider' | 'model' | 'workerDir'>, reviewId: string): void {
  const id = `dec-${ctx.run.id}-review-depth-${reviewId}`;
  if (getDecision(ctx.db, id)) return;
  const d = readReviewDepth(worker);
  const data: ReviewDepth = { review_id: reviewId, worker_id: worker.id, provider: worker.provider, model: worker.model, tool_calls: d.toolCalls, reasoning_tokens: d.reasoningTokens };
  recordDecision(ctx.db, ctx.runDir, { id, runId: ctx.run.id, kind: REVIEW_DEPTH_KIND, summary: `${worker.provider}/${worker.model ?? 'default'} review ${reviewId}: ${describeDepth(data)}`, data }, ctx.clock, { actor: ctx.ownerId });
}

/** `3 tool calls, 1204 reasoning tokens`, with the no-tool-call case said in words. */
export function describeDepth(d: Pick<ReviewDepth, 'tool_calls' | 'reasoning_tokens'>): string {
  const calls = d.tool_calls === null ? 'tool calls unavailable' : d.tool_calls === 0 ? 'NO TOOL CALLS (judged from the packet alone)' : `${d.tool_calls} tool call${d.tool_calls === 1 ? '' : 's'}`;
  const tokens = d.reasoning_tokens === null ? 'reasoning tokens unavailable' : `${d.reasoning_tokens} reasoning tokens`;
  return `${calls}, ${tokens}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
