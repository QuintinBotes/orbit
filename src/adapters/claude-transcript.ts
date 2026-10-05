/**
 * Reading a `claude -p --output-format stream-json --verbose` transcript:
 * classification of how the worker ended, usage, and progress events.
 * Pure functions over parsed lines, so fixture transcripts test them.
 *
 * Rules from the verified notes (claude-headless-and-sandbox.md 1.2-1.4 and
 * 7.2; gaps-and-contradictions.md V1, V2, V9 and section 6.3):
 *   - Success needs all of: a `type:"result"` line, exit 0, is_error false,
 *     subtype "success", and structured output that validates. Auth failures
 *     arrive as subtype "success" with is_error true.
 *   - Authentication failure is read from structured fields, never from the
 *     message text (which changed between probes): api_error_status 401 or
 *     403, an `authentication_failed` api_retry or assistant error, or the
 *     "Not logged in" result, which has a null status.
 *   - No result line means the run was interrupted or crashed, whatever the
 *     exit code: SIGINT exits 0 without one.
 *   - Accounting comes from modelUsage (all models, including a content
 *     fallback model), not from `usage`, which covers the main loop only.
 */
import { schemaErrors } from '../core/schema.ts';
import type { ExitRecord } from './shim.ts';
import type { ProviderEvent, TaskResult, TaskStatus, UsageReport } from './types.ts';

/** `system/api_retry` and `assistant.error` values that mean the credential or account must be fixed by a person. */
export const CLAUDE_AUTH_ERRORS: readonly string[] = ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold'];
/** Values worth an infrastructure retry with backoff. */
export const CLAUDE_TRANSIENT_ERRORS: readonly string[] = ['rate_limit', 'overloaded', 'server_error'];

/** Why a Claude task ended, finer than TaskStatus, for the evidence record and routing. */
export const CLAUDE_END_REASONS = [
  'success',
  'auth',
  'max_turns',
  'max_budget',
  'structured_output_retries',
  'structured_output_invalid',
  'structured_output_missing',
  'transient_api_error',
  'api_error',
  'execution_error',
  'interrupted',
  'timeout',
  'malformed_transcript',
  'crashed',
  'spawn_failed',
  'unsafe_session',
] as const;
export type ClaudeEndReason = (typeof CLAUDE_END_REASONS)[number];

export interface ClaudeTaskResult extends TaskResult {
  reason: ClaudeEndReason;
  sessionId: string | null;
  /** Every model that served the session, from modelUsage keys. */
  models: string[];
  permissionDenials: { tool_name: string; tool_use_id: string }[];
  numTurns: number | null;
  terminalReason: string | null;
}

export interface ClassifyInput {
  events: Record<string, unknown>[];
  malformedTail: boolean;
  exit: ExitRecord;
  outputSchema: object;
  /** The --session-id Orbit launched with (pid.json); a transcript of another session is not this worker's. */
  expectedSessionId?: string | null;
}

export function classifyClaudeTranscript(input: ClassifyInput): ClaudeTaskResult {
  const { events, exit } = input;
  const result = lastOf(events, (e) => e.type === 'result');
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const sessionId = str(result?.session_id) ?? str(init?.session_id) ?? null;
  const usage = claudeUsage(events);
  const base = {
    structured: null,
    text: result ? str(result.result) : null,
    exitCode: exit.code,
    usage,
    durationMs: num(result?.duration_ms) ?? Math.max(0, exit.endedAt - exit.startedAt),
    sessionId,
    models: modelUsageKeys(result),
    permissionDenials: denials(result),
    numTurns: num(result?.num_turns),
    terminalReason: str(result?.terminal_reason),
  };
  const end = (status: TaskStatus, reason: ClaudeEndReason, error: string | null, structured: unknown = null): ClaudeTaskResult => ({
    ...base,
    status,
    reason,
    error,
    structured,
  });

  if (exit.error) return end('failed', 'spawn_failed', exit.error);

  // Authentication first: an auth failure aborted by the shim also looks
  // cancelled, and it must block, not be retried.
  const auth = authEvidence(events, result);
  if (auth) return end('auth_failed', 'auth', auth);

  if (exit.timedOut) return end('timeout', 'timeout', `timed out; the shim sent ${exit.escalation.join(', ') || 'no signal'}`);
  if (exit.cancelled) return end('cancelled', 'interrupted', 'cancelled by a signal to the worker');

  if (!result) {
    // Exit 0, 130 or 143 without a result is how claude ends on SIGINT or
    // SIGTERM, but only a signal Orbit sent makes that a cancellation. The
    // same exit with no signal from Orbit (a stray SIGINT to the provider,
    // a CLI that quit early) is a crash, which may be retried; calling it
    // cancelled would end the worker for good. Death by a signal nobody in
    // Orbit sent (an OOM kill) is a crash too.
    if (exit.escalation.length > 0) {
      return end('cancelled', 'interrupted', `no result line (exit ${exit.code ?? exit.signal}) after ${exit.escalation.join(', ')}; the run was interrupted`);
    }
    if (exit.signal !== null) return end('failed', 'crashed', `killed by ${exit.signal} without a result line`);
    if (input.malformedTail) return end('malformed_output', 'malformed_transcript', `transcript ends in a line that is not JSON (exit ${exit.code})`);
    return end('failed', 'crashed', `exited ${exit.code} without a result line`);
  }

  const subtype = str(result.subtype);
  const isError = result.is_error === true;
  const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === 'string') : [];
  const detail = errors[0] ?? str(result.result) ?? null;
  switch (subtype) {
    case 'error_max_turns':
      return end('max_turns', 'max_turns', detail ?? 'reached the maximum number of turns');
    case 'error_max_budget_usd':
      return end('failed', 'max_budget', detail ?? 'reached the maximum budget');
    case 'error_max_structured_output_retries':
      return end('malformed_output', 'structured_output_retries', detail ?? 'structured output retries exhausted');
    case 'error_during_execution':
      return end('failed', 'execution_error', detail ?? 'error during execution');
    default:
      break;
  }
  if (isError || exit.code !== 0 || subtype !== 'success') {
    const status = num(result.api_error_status);
    const retryErrors = apiErrors(events);
    if ((status !== null && (status === 429 || status >= 500)) || retryErrors.some((e) => CLAUDE_TRANSIENT_ERRORS.includes(e))) {
      return end('transient_error', 'transient_api_error', detail ?? `API error ${status ?? ''}`.trim());
    }
    if (str(result.terminal_reason) === 'api_error' || status !== null) return end('failed', 'api_error', detail ?? 'API error');
    return end('failed', 'execution_error', detail ?? `exit ${exit.code}, subtype ${subtype ?? 'missing'}`);
  }

  // A session that did not start the way Orbit launched it (another
  // permission mode, MCP servers loaded) ran without the intended policy;
  // its output is not accepted even when it looks fine.
  const unsafe = sessionProblems(init, input.expectedSessionId ?? null);
  if (unsafe) return end('failed', 'unsafe_session', unsafe);

  if (!('structured_output' in result) || result.structured_output === undefined) {
    return end('malformed_output', 'structured_output_missing', 'the result has no structured_output');
  }
  const problems = schemaErrors(input.outputSchema, result.structured_output);
  if (problems.length > 0) {
    return end('malformed_output', 'structured_output_invalid', `structured output does not match the role schema: ${problems.slice(0, 5).join('; ')}`);
  }
  return end('succeeded', 'success', null, result.structured_output);
}

/**
 * Checks on system/init from gaps-and-contradictions.md section 6.1:
 * dontAsk, no MCP servers, and no plugin other than Claude Code's built-ins
 * (whose init entries carry source "<name>@builtin", verified with 2.1.288).
 * A transcript without an init line proves none of this, so it fails too,
 * as does one whose session is not the one Orbit launched.
 */
export function sessionProblems(init: Record<string, unknown> | undefined, expectedSessionId: string | null = null): string | null {
  if (!init) return 'the transcript has no system/init line, so the permission mode and loaded servers cannot be checked';
  if (init.permissionMode !== 'dontAsk') return `the session ran in permission mode ${String(init.permissionMode)}, not dontAsk`;
  if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length > 0) {
    return Array.isArray(init.mcp_servers) ? `the session loaded ${init.mcp_servers.length} MCP server(s)` : 'system/init does not list its MCP servers';
  }
  if (init.plugins !== undefined) {
    const plugins = Array.isArray(init.plugins) ? init.plugins : [null];
    const foreign = plugins.filter((p) => !(isObject(p) && typeof (p as Record<string, unknown>).source === 'string' && ((p as Record<string, unknown>).source as string).endsWith('@builtin')));
    if (foreign.length > 0) return `the session loaded ${foreign.length} plugin(s) that are not Claude Code built-ins`;
  }
  if (expectedSessionId !== null && init.session_id !== expectedSessionId) {
    return `the transcript is of session ${String(init.session_id)}, not ${expectedSessionId}`;
  }
  return null;
}

function authEvidence(events: Record<string, unknown>[], result: Record<string, unknown> | undefined): string | null {
  for (const e of events) {
    if (e.type === 'system' && e.subtype === 'api_retry' && typeof e.error === 'string' && CLAUDE_AUTH_ERRORS.includes(e.error)) {
      return `authentication failed (${e.error}, HTTP ${String(e.error_status ?? 'unknown')}); not retried`;
    }
    if (e.type === 'assistant' && typeof e.error === 'string' && CLAUDE_AUTH_ERRORS.includes(e.error)) {
      return `authentication failed (${e.error}); not retried`;
    }
  }
  if (result) {
    const status = num(result.api_error_status);
    if (status === 401 || status === 403) return `authentication failed (HTTP ${status}); not retried`;
    const text = str(result.result);
    if (result.is_error === true && text !== null && text.startsWith('Not logged in')) return 'not logged in; not retried';
  }
  return null;
}

function apiErrors(events: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === 'system' && e.subtype === 'api_retry' && typeof e.error === 'string') out.push(e.error);
    if (e.type === 'assistant' && typeof e.error === 'string') out.push(e.error);
  }
  return out;
}

/**
 * Usage of one session. With a result line, modelUsage is authoritative and
 * covers every model (costUSD is Claude Code's estimate, so the source is
 * still "reported" by the provider). Without one (interrupted, crashed),
 * the assistant messages' own usage is summed once per message id: tokens
 * are then a lower bound and cost is unknown, never zero.
 *
 * modelUsage and total_cost_usd are cumulative across `--resume`; Orbit
 * starts every attempt as a new session (nextSessionId), so one session's
 * figures are counted once. A caller that resumes must subtract the
 * previous attempt's figures (subtractUsage).
 */
export function claudeUsage(events: Record<string, unknown>[]): UsageReport {
  const result = lastOf(events, (e) => e.type === 'result');
  const mu = result && isObject(result.modelUsage) ? (result.modelUsage as Record<string, unknown>) : null;
  if (mu && Object.keys(mu).length > 0) {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let costKnown = true;
    let main: { model: string; weight: number } | null = null;
    for (const [model, raw] of Object.entries(mu)) {
      if (!isObject(raw)) continue;
      const u = raw as Record<string, unknown>;
      const out = num(u.outputTokens) ?? 0;
      input += num(u.inputTokens) ?? 0;
      output += out;
      cacheRead += num(u.cacheReadInputTokens) ?? 0;
      cacheWrite += num(u.cacheCreationInputTokens) ?? 0;
      const c = num(u.costUSD);
      if (c === null) costKnown = false;
      else cost += c;
      const weight = c ?? out;
      if (!main || weight > main.weight) main = { model, weight };
    }
    return {
      provider: 'claude',
      model: main?.model ?? null,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: costKnown ? cost : (num(result?.total_cost_usd) ?? null),
      costSource: costKnown || num(result?.total_cost_usd) !== null ? 'reported' : 'unavailable',
    };
  }
  if (result && num(result.total_cost_usd) !== null && num(result.total_cost_usd)! > 0) {
    return { ...emptyUsage(), model: assistantModel(events), costUsd: num(result.total_cost_usd), costSource: 'reported' };
  }
  const seen = new Map<string, Record<string, unknown>>();
  for (const e of events) {
    if (e.type !== 'assistant' || !isObject(e.message)) continue;
    const m = e.message as Record<string, unknown>;
    if (!isObject(m.usage)) continue;
    // stream-json repeats a message per content block; the last copy wins.
    seen.set(str(m.id) ?? `#${seen.size}`, m.usage as Record<string, unknown>);
  }
  if (seen.size === 0) return { ...emptyUsage(), model: assistantModel(events) };
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const u of seen.values()) {
    input += num(u.input_tokens) ?? 0;
    output += num(u.output_tokens) ?? 0;
    cacheRead += num(u.cache_read_input_tokens) ?? 0;
    cacheWrite += num(u.cache_creation_input_tokens) ?? 0;
  }
  return { provider: 'claude', model: assistantModel(events), inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, costUsd: null, costSource: 'unavailable' };
}

/** Per-session delta of two cumulative reports (a resumed session repeats the earlier figures). */
export function subtractUsage(cumulative: UsageReport, previous: UsageReport): UsageReport {
  const d = (a: number | null, b: number | null) => (a === null ? null : Math.max(0, a - (b ?? 0)));
  return {
    ...cumulative,
    inputTokens: d(cumulative.inputTokens, previous.inputTokens),
    outputTokens: d(cumulative.outputTokens, previous.outputTokens),
    cacheReadTokens: d(cumulative.cacheReadTokens, previous.cacheReadTokens),
    cacheWriteTokens: d(cumulative.cacheWriteTokens, previous.cacheWriteTokens),
    costUsd: d(cumulative.costUsd, previous.costUsd),
  };
}

export function emptyUsage(provider = 'claude'): UsageReport {
  return { provider, model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' };
}

/** Progress events for streamEvents. Tool inputs are summarized, never copied whole. */
export function claudeEvents(lines: Record<string, unknown>[], now: number): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (const e of lines) {
    const at = Date.parse(str(e.timestamp) ?? '') || now;
    if (e.type === 'system' && e.subtype === 'init') out.push({ type: 'started', at });
    else if (e.type === 'system' && e.subtype === 'api_retry') out.push({ type: 'error', at, message: `API retry ${String(e.attempt ?? '?')}/${String(e.max_retries ?? '?')}: ${String(e.error ?? 'unknown')}` });
    else if (e.type === 'assistant' && isObject(e.message)) {
      const content = (e.message as Record<string, unknown>).content;
      for (const block of Array.isArray(content) ? content : []) {
        if (!isObject(block)) continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'message', at, text: clip(b.text, 2000) });
        if (b.type === 'tool_use' && typeof b.name === 'string') out.push({ type: 'tool', at, tool: b.name, summary: toolSummary(b.input) });
      }
      if (typeof e.error === 'string') out.push({ type: 'error', at, message: e.error });
    } else if (e.type === 'result') {
      out.push({ type: 'usage', at, usage: claudeUsage([e]) });
      out.push({ type: 'finished', at });
    }
  }
  return out;
}

function toolSummary(input: unknown): string {
  if (!isObject(input)) return '';
  const i = input as Record<string, unknown>;
  const pick = i.file_path ?? i.notebook_path ?? i.command ?? i.pattern ?? i.path;
  return typeof pick === 'string' ? clip(pick, 200) : '';
}

function assistantModel(events: Record<string, unknown>[]): string | null {
  const a = lastOf(events, (e) => e.type === 'assistant' && isObject(e.message) && typeof (e.message as Record<string, unknown>).model === 'string');
  if (a) return (a.message as Record<string, unknown>).model as string;
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  return str(init?.model);
}

function modelUsageKeys(result: Record<string, unknown> | undefined): string[] {
  return result && isObject(result.modelUsage) ? Object.keys(result.modelUsage as object) : [];
}

function denials(result: Record<string, unknown> | undefined): { tool_name: string; tool_use_id: string }[] {
  const list = result && Array.isArray(result.permission_denials) ? result.permission_denials : [];
  return list.filter(isObject).map((d) => ({ tool_name: String((d as Record<string, unknown>).tool_name ?? ''), tool_use_id: String((d as Record<string, unknown>).tool_use_id ?? '') }));
}

function lastOf<T>(items: T[], pred: (t: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return items[i];
  return undefined;
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
