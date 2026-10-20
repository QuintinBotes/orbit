/**
 * Reading `muse exec --json` output (docs/interfaces/muse.md). Pure functions over parsed lines.
 *
 *   - Each line is an envelope whose `payload_type` names the event; unknown types are ignored, never fatal.
 *   - Only run.terminal.completed and run.terminal.failed are terminal; a process that exits with neither was
 *     interrupted or crashed. A step cap ends the run as run.terminal.failed with a reason naming the steps.
 *   - The final answer is run.terminal.completed's `text`. Muse shapes it with --output-schema but Orbit still parses
 *     and validates it with its own copy of the schema; invalid JSON is a malformed review, never "no findings".
 *   - Usage exists only on run.usage. Anything else reports null, not 0.
 */
import { schemaErrors } from '../core/schema.ts';
import type { ExitRecord } from './shim.ts';
import type { ProviderEvent, TaskResult, TaskStatus, UsageReport } from './types.ts';

export const MUSE_END_REASONS = [
  'success',
  'auth',
  'run_failed',
  'step_cap',
  'invalid_json',
  'schema_mismatch',
  'no_answer',
  'interrupted',
  'timeout',
  'crashed',
  'malformed_transcript',
  'spawn_failed',
] as const;
export type MuseEndReason = (typeof MUSE_END_REASONS)[number];

export interface MuseTaskResult extends TaskResult {
  reason: MuseEndReason;
}

/** How Muse 1.4.11 says it has no usable login (probed with an empty config directory) or a rejected key. */
export const MUSE_AUTH_PATTERNS: readonly RegExp[] = [/missing meta credentials/i, /\b401\b/, /unauthori[sz]ed/i, /run `muse login`/i];
const STEP_CAP = /did not reach a terminal state within \d+ step/i;

export interface MuseClassifyInput {
  events: Record<string, unknown>[];
  malformedTail: boolean;
  exit: ExitRecord;
  outputSchema: object;
  model: string | null;
  /** stderr of the session, where Muse prints a missing login before any event. */
  stderr?: string;
}

export function classifyMuseTranscript(input: MuseClassifyInput): MuseTaskResult {
  const { events, exit } = input;
  const terminalIndex = lastIndex(events, (e) => e.payload_type === 'run.terminal.completed' || e.payload_type === 'run.terminal.failed');
  const terminal = terminalIndex >= 0 ? payloadOf(events[terminalIndex]!) : null;
  const completed = terminalIndex >= 0 && events[terminalIndex]!.payload_type === 'run.terminal.completed';
  const usage = museUsage(events, input.model);
  const end = (status: TaskStatus, reason: MuseEndReason, error: string | null, structured: unknown = null, text: string | null = null): MuseTaskResult => ({
    status,
    reason,
    error,
    structured,
    text,
    exitCode: exit.code,
    usage,
    durationMs: Math.max(0, exit.endedAt - exit.startedAt),
  });

  if (exit.error) return end('failed', 'spawn_failed', exit.error);
  const failure = terminal && !completed ? (str(terminal.reason) ?? 'run failed') : null;
  const authText = completed ? undefined : [failure, input.stderr ?? null].find((m) => m !== null && MUSE_AUTH_PATTERNS.some((p) => p.test(m)));
  if (authText) return end('auth_failed', 'auth', `authentication failed: ${clip(firstMatchingLine(authText), 300)}; not retried`);
  if (exit.timedOut) return end('timeout', 'timeout', `timed out; the shim sent ${exit.escalation.join(', ') || 'no signal'}`);
  if (exit.cancelled) return end('cancelled', 'interrupted', 'cancelled by a signal to the worker');

  if (!terminal) {
    if (exit.escalation.length > 0) return end('cancelled', 'interrupted', `ended after ${exit.escalation.join(', ')} with no terminal event`);
    if (exit.signal !== null) return end('failed', 'crashed', `killed by ${exit.signal} with no terminal event`);
    if (input.malformedTail) return end('malformed_output', 'malformed_transcript', `output ends in a line that is not JSON (exit ${exit.code})`);
    const said = lastStderrLine(input.stderr);
    return end('failed', 'crashed', `exited ${exit.code} without run.terminal.completed or run.terminal.failed${said ? `: ${clip(said, 300)}` : ''}`);
  }
  if (!completed) {
    if (STEP_CAP.test(failure!)) return end('failed', 'step_cap', clip(failure!, 500));
    return end('failed', 'run_failed', clip(failure!, 500));
  }
  if (exit.code !== 0) return end('failed', 'crashed', `run.terminal.completed but exit ${exit.code}`);

  const message = str(terminal.text);
  if (message === null || message.trim() === '') return end('malformed_output', 'no_answer', 'the run completed without a final answer');
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return end('malformed_output', 'invalid_json', 'the final answer is not JSON', null, clip(message, 2000));
  }
  const problems = schemaErrors(input.outputSchema, parsed);
  if (problems.length > 0) return end('malformed_output', 'schema_mismatch', `the final answer does not match the schema: ${problems.slice(0, 5).join('; ')}`, null, clip(message, 2000));
  return end('succeeded', 'success', null, parsed, message);
}

/** The final answer the session gave, accepted or not (ADR 0016): its JSON value when it parses, else the text. */
export function museRawFinalAnswer(events: Record<string, unknown>[]): unknown {
  const done = events.findLast((e) => e.payload_type === 'run.terminal.completed');
  const text = done ? str(payloadOf(done)?.text) : null;
  return text === null || text.trim() === '' ? undefined : parsedOrText(text);
}

/** Token usage summed over run.usage's models; null fields when the run reported none. Muse reports no cost. */
export function museUsage(events: Record<string, unknown>[], model: string | null): UsageReport {
  const p = payloadOf(events.findLast((e) => e.payload_type === 'run.usage'));
  const models = p && Array.isArray(p.models) ? (p.models as unknown[]).filter(isObject) : null;
  if (!models) return { provider: 'muse', model, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' };
  const sum = (k: string): number | null => {
    const vals = models.map((m) => num((m as Record<string, unknown>)[k]));
    return vals.some((v) => v === null) ? null : vals.reduce<number>((a, v) => a + v!, 0);
  };
  return { provider: 'muse', model, inputTokens: sum('input_tokens'), outputTokens: sum('output_tokens'), cacheReadTokens: sum('cached_tokens'), cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' };
}

/** The tool results that look at the checkout, and the reasoning tokens run.usage reports (null when it reported none). */
export function museDepth(events: Record<string, unknown>[]): { toolCalls: number; reasoningTokens: number | null } {
  const toolCalls = events.filter((e) => e.payload_type === 'tool.result').length;
  const p = payloadOf(events.findLast((e) => e.payload_type === 'run.usage'));
  const models = p && Array.isArray(p.models) ? (p.models as unknown[]).filter(isObject) : [];
  const reasoning = models.map((m) => num((m as Record<string, unknown>).reasoning_tokens));
  return { toolCalls, reasoningTokens: reasoning.length === 0 || reasoning.some((v) => v === null) ? null : reasoning.reduce<number>((a, v) => a + v!, 0) };
}

export function museEvents(lines: Record<string, unknown>[], now: number, model: string | null = null): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (const e of lines) {
    const at = now;
    const p = payloadOf(e);
    switch (e.payload_type) {
      case 'run.lifecycle.started':
        out.push({ type: 'started', at });
        break;
      case 'tool.result': {
        const facts = p && isObject(p.correlation_facts) ? (p.correlation_facts as Record<string, unknown>) : null;
        out.push({ type: 'tool', at, tool: str(facts?.tool_name) ?? 'tool', summary: clip(str(p?.text) ?? '', 200) });
        break;
      }
      case 'run.usage':
        out.push({ type: 'usage', at, usage: museUsage([e], model) });
        break;
      case 'run.terminal.completed':
        out.push({ type: 'message', at, text: clip(str(p?.text) ?? '', 2000) });
        out.push({ type: 'finished', at });
        break;
      case 'run.terminal.failed':
        out.push({ type: 'error', at, message: clip(str(p?.reason) ?? 'run failed', 500) });
        out.push({ type: 'finished', at });
        break;
      default:
        break;
    }
  }
  return out;
}

function payloadOf(e: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return e && isObject(e.payload) ? (e.payload as Record<string, unknown>) : null;
}

function firstMatchingLine(text: string): string {
  return text.split('\n').find((l) => MUSE_AUTH_PATTERNS.some((p) => p.test(l))) ?? text;
}

function lastStderrLine(stderr: string | undefined): string | null {
  const lines = (stderr ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('muse: workspace root'));
  return lines.at(-1) ?? null;
}

function lastIndex<T>(items: T[], pred: (t: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return i;
  return -1;
}

function isObject(v: unknown): v is object {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function parsedOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
