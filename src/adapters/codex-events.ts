/**
 * Reading `codex exec --json` output (codex-cli.md sections 3-5 and 7,
 * gaps-and-contradictions.md V6). Pure functions over parsed lines.
 *
 *   - Unknown event and item types are ignored, never fatal (the docs and the
 *     0.153.4 source already disagree on the set).
 *   - Top-level `error` events are retries ("Reconnecting... 2/5"), not
 *     failures. Only turn.completed and turn.failed are terminal; a process
 *     that exits with neither was interrupted or crashed.
 *   - The final message is the last agent_message before turn.completed.
 *     Codex does not validate it against --output-schema, so Orbit parses and
 *     validates it with its own copy of the schema; invalid JSON is a
 *     malformed review, never "no findings".
 *   - Usage exists only on turn.completed. Anything else reports null, not 0.
 */
import { schemaErrors } from '../core/schema.ts';
import type { ExitRecord } from './shim.ts';
import type { ProviderEvent, TaskResult, TaskStatus, UsageReport } from './types.ts';

export const CODEX_END_REASONS = [
  'success',
  'auth',
  'turn_failed',
  'transient_api_error',
  'invalid_json',
  'schema_mismatch',
  'no_agent_message',
  'interrupted',
  'timeout',
  'crashed',
  'malformed_transcript',
  'spawn_failed',
] as const;
export type CodexEndReason = (typeof CODEX_END_REASONS)[number];

export interface CodexTaskResult extends TaskResult {
  reason: CodexEndReason;
  threadId: string | null;
  /** Non-fatal warnings and retry notices seen on the way. */
  warnings: string[];
}

/**
 * Credential failures as Codex prints them. Codex has no structured auth
 * field in its JSONL, so this is text: the 401 status line the verified
 * probes produced (missing bearer, invalid API key) and the refresh-token
 * failures from its source ("... Please log out and sign in again").
 */
const AUTH_PATTERNS = [/\b401 Unauthorized\b/, /auth error: 401/, /auth error code: invalid_api_key/, /sign in again/i, /could not be refreshed/i];
const TRANSIENT_PATTERNS = [/"status":\s*(429|5\d\d)\b/, /\bstatus (429|5\d\d)\b/, /\b(429|5\d\d) (Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/, /overloaded/i];

export interface CodexClassifyInput {
  events: Record<string, unknown>[];
  malformedTail: boolean;
  exit: ExitRecord;
  outputSchema: object;
  /** The model Orbit asked for (Codex does not echo it). */
  model: string | null;
}

export function classifyCodexTranscript(input: CodexClassifyInput): CodexTaskResult {
  const { events, exit } = input;
  const threadId = str(events.find((e) => e.type === 'thread.started')?.thread_id);
  const terminalIndex = lastIndex(events, (e) => e.type === 'turn.completed' || e.type === 'turn.failed');
  const terminal = terminalIndex >= 0 ? events[terminalIndex]! : undefined;
  const warnings = codexWarnings(events);
  const usage = codexUsage(events, input.model);
  const end = (status: TaskStatus, reason: CodexEndReason, error: string | null, structured: unknown = null, text: string | null = null): CodexTaskResult => ({
    status,
    reason,
    error,
    structured,
    text,
    exitCode: exit.code,
    usage,
    durationMs: Math.max(0, exit.endedAt - exit.startedAt),
    threadId,
    warnings,
  });

  if (exit.error) return end('failed', 'spawn_failed', exit.error);
  const failure = terminal?.type === 'turn.failed' ? failureMessage(terminal) : null;
  // Retry notices can mention a 401 that a later attempt recovered from, so
  // they count only when the turn did not complete.
  const authText = terminal?.type === 'turn.completed' ? undefined : [failure, ...warnings].find((m) => m !== null && AUTH_PATTERNS.some((p) => p.test(m)));
  if (authText) return end('auth_failed', 'auth', `authentication failed: ${clip(authText, 300)}; not retried`);
  if (exit.timedOut) return end('timeout', 'timeout', `timed out; the shim sent ${exit.escalation.join(', ') || 'no signal'}`);
  if (exit.cancelled) return end('cancelled', 'interrupted', 'cancelled by a signal to the worker');

  if (!terminal) {
    // SIGINT makes codex exit 1 with no terminal event; SIGTERM kills it.
    if (exit.escalation.length > 0) return end('cancelled', 'interrupted', `ended after ${exit.escalation.join(', ')} with no terminal event`);
    if (exit.signal !== null) return end('failed', 'crashed', `killed by ${exit.signal} with no terminal event`);
    if (input.malformedTail) return end('malformed_output', 'malformed_transcript', `output ends in a line that is not JSON (exit ${exit.code})`);
    return end('failed', 'crashed', `exited ${exit.code} without turn.completed or turn.failed`);
  }
  if (terminal.type === 'turn.failed') {
    const msg = failure ?? 'turn failed';
    if (TRANSIENT_PATTERNS.some((p) => p.test(msg))) return end('transient_error', 'transient_api_error', clip(msg, 500));
    return end('failed', 'turn_failed', clip(msg, 500));
  }
  if (exit.code !== 0) return end('failed', 'crashed', `turn.completed but exit ${exit.code}`);

  const message = lastAgentMessage(events.slice(0, terminalIndex));
  if (message === null) return end('malformed_output', 'no_agent_message', 'the turn completed without an agent message');
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return end('malformed_output', 'invalid_json', 'the final agent message is not JSON', null, clip(message, 2000));
  }
  const problems = schemaErrors(input.outputSchema, parsed);
  if (problems.length > 0) return end('malformed_output', 'schema_mismatch', `the final message does not match the schema: ${problems.slice(0, 5).join('; ')}`, null, clip(message, 2000));
  return end('succeeded', 'success', null, parsed, message);
}

/** Token usage from turn.completed; null fields when the turn did not complete. Codex reports no cost. */
export function codexUsage(events: Record<string, unknown>[], model: string | null): UsageReport {
  const done = events.findLast((e) => e.type === 'turn.completed');
  const u = done && isObject(done.usage) ? (done.usage as Record<string, unknown>) : null;
  if (!u) return { provider: 'codex', model, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' };
  return {
    provider: 'codex',
    model,
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cached_input_tokens),
    // Present in 0.153.4 but absent from the doc sample; the SDK defaults it to 0.
    cacheWriteTokens: num(u.cache_write_input_tokens) ?? 0,
    costUsd: null,
    costSource: 'unavailable',
  };
}

export function codexEvents(lines: Record<string, unknown>[], now: number, model: string | null = null): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (const e of lines) {
    const at = now;
    switch (e.type) {
      case 'thread.started':
        out.push({ type: 'started', at });
        break;
      case 'error':
        out.push({ type: 'error', at, message: clip(String(e.message ?? ''), 500) });
        break;
      case 'item.completed': {
        const item = isObject(e.item) ? (e.item as Record<string, unknown>) : null;
        if (!item) break;
        if (item.type === 'agent_message' && typeof item.text === 'string') out.push({ type: 'message', at, text: clip(item.text, 2000) });
        else if (item.type === 'command_execution') out.push({ type: 'tool', at, tool: 'exec', summary: clip(String(item.command ?? ''), 200) });
        else if (item.type === 'file_change') out.push({ type: 'tool', at, tool: 'file_change', summary: clip(JSON.stringify(item.changes ?? []), 200) });
        else if (item.type === 'mcp_tool_call') out.push({ type: 'tool', at, tool: `mcp:${String(item.server)}/${String(item.tool)}`, summary: '' });
        else if (item.type === 'error') out.push({ type: 'error', at, message: clip(String(item.message ?? ''), 500) });
        break;
      }
      case 'turn.completed':
        out.push({ type: 'usage', at, usage: codexUsage([e], model) });
        out.push({ type: 'finished', at });
        break;
      case 'turn.failed':
        out.push({ type: 'error', at, message: clip(failureMessage(e) ?? 'turn failed', 500) });
        out.push({ type: 'finished', at });
        break;
      default:
        break;
    }
  }
  return out;
}

function codexWarnings(events: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === 'error' && typeof e.message === 'string') out.push(e.message);
    if (e.type === 'item.completed' && isObject(e.item) && (e.item as Record<string, unknown>).type === 'error') out.push(String((e.item as Record<string, unknown>).message ?? ''));
  }
  return out;
}

function failureMessage(e: Record<string, unknown>): string | null {
  const err = isObject(e.error) ? (e.error as Record<string, unknown>) : null;
  return err && typeof err.message === 'string' ? err.message : null;
}

function lastAgentMessage(events: Record<string, unknown>[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'item.completed' || !isObject(e.item)) continue;
    const item = e.item as Record<string, unknown>;
    if (item.type === 'agent_message' && typeof item.text === 'string') return item.text;
  }
  return null;
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
