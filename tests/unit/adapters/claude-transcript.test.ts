import { describe, expect, it } from 'vitest';
import { classifyClaudeTranscript, claudeEvents, claudeUsage, sessionProblems, subtractUsage } from '../../../src/adapters/claude-transcript.ts';
import { parseJsonLines } from '../../../src/adapters/supervise.ts';
import type { ExitRecord } from '../../../src/adapters/shim.ts';

const SCHEMA = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const INIT = { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5-5', permissionMode: 'dontAsk', mcp_servers: [], tools: ['Read'] };

function exit(over: Partial<ExitRecord> = {}): ExitRecord {
  return { version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 1000, endedAt: 3000, ...over };
}

function classify(lines: object[], ex: Partial<ExitRecord> = {}, tail = '') {
  const parsed = parseJsonLines(lines.map((l) => JSON.stringify(l)).join('\n') + tail);
  return classifyClaudeTranscript({ events: parsed.events, malformedTail: parsed.malformedTail, exit: exit(ex), outputSchema: SCHEMA });
}

const MODEL_USAGE = {
  'claude-sonnet-5-5': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 300, cacheCreationInputTokens: 50, costUSD: 0.01 },
  'claude-opus-5': { inputTokens: 500, outputTokens: 400, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.02 },
};

// Shapes from claude-headless-and-sandbox.md 1.3 and gaps-and-contradictions.md V1, V2, V9.
const SUCCESS = { type: 'result', subtype: 'success', is_error: false, api_error_status: null, session_id: 's1', num_turns: 2, result: '{"answer":"hi"}', structured_output: { answer: 'hi' }, total_cost_usd: 0.03, modelUsage: MODEL_USAGE, permission_denials: [{ tool_name: 'Write', tool_use_id: 't1', tool_input: {} }], terminal_reason: 'completed', duration_ms: 47 };
const AUTH_401 = { type: 'result', subtype: 'success', is_error: true, api_error_status: 401, terminal_reason: 'api_error', result: 'Invalid API key · Fix external API key', total_cost_usd: 0, modelUsage: {}, permission_denials: [] };
const NOT_LOGGED_IN = { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', api_error_status: null, terminal_reason: 'api_error' };
const MAX_TURNS = { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 3, terminal_reason: 'max_turns', stop_reason: 'tool_use', errors: ['Reached maximum number of turns (2)'] };
const MAX_BUDGET = { type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 1, terminal_reason: 'budget_exhausted', errors: ['Reached maximum budget ($0.5)'], total_cost_usd: 1.2 };
const SO_RETRIES = { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, terminal_reason: 'structured_output_retry_exhausted', errors: ['Failed to provide valid structured output after 5 attempts'] };

describe('classifyClaudeTranscript', () => {
  it('succeeds only with a result line, exit 0, is_error false, subtype success and valid structured output', () => {
    const r = classify([INIT, SUCCESS]);
    expect(r).toMatchObject({ status: 'succeeded', reason: 'success', structured: { answer: 'hi' }, sessionId: 's1', numTurns: 2, error: null });
    expect(r.permissionDenials).toEqual([{ tool_name: 'Write', tool_use_id: 't1' }]);
  });

  it('treats a success-shaped result with a non-zero exit as a failure', () => {
    expect(classify([INIT, SUCCESS], { code: 1 }).status).not.toBe('succeeded');
  });

  it('rejects structured output that is missing or fails the role schema', () => {
    const { structured_output: _drop, ...noOutput } = SUCCESS;
    expect(classify([INIT, noOutput])).toMatchObject({ status: 'malformed_output', reason: 'structured_output_missing' });
    expect(classify([INIT, { ...SUCCESS, structured_output: { answer: 3 } }])).toMatchObject({ status: 'malformed_output', reason: 'structured_output_invalid' });
  });

  it('detects auth failure from api_error_status 401 even though subtype is success', () => {
    expect(classify([INIT, AUTH_401], { code: 1 })).toMatchObject({ status: 'auth_failed', reason: 'auth' });
  });

  it('detects auth failure from the api_retry event before any result (shim abort)', () => {
    const retry = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 4, retry_delay_ms: 592, error_status: 401, error: 'authentication_failed' };
    const r = classify([INIT, retry], { code: 0, cancelled: false, aborted: '{"error":"authentication_failed"}', escalation: ['SIGINT'] });
    expect(r.status).toBe('auth_failed');
    expect(classify([INIT, { type: 'assistant', error: 'authentication_failed', message: { content: [] } }], { code: 1 }).status).toBe('auth_failed');
  });

  it('detects "Not logged in", which carries no status', () => {
    expect(classify([NOT_LOGGED_IN], { code: 1 }).status).toBe('auth_failed');
  });

  it('does not read "Failed to authenticate" text alone as structured evidence of anything else', () => {
    const r = classify([INIT, { ...SUCCESS, is_error: true, api_error_status: 500, structured_output: undefined, result: 'Failed to authenticate maybe' }], { code: 1 });
    expect(r.status).toBe('transient_error');
  });

  it('maps max turns, max budget and structured-output retry exhaustion', () => {
    expect(classify([INIT, MAX_TURNS], { code: 1 })).toMatchObject({ status: 'max_turns', reason: 'max_turns' });
    expect(classify([INIT, MAX_BUDGET], { code: 1 })).toMatchObject({ status: 'failed', reason: 'max_budget' });
    expect(classify([INIT, SO_RETRIES], { code: 1 })).toMatchObject({ status: 'malformed_output', reason: 'structured_output_retries' });
  });

  it('classifies retryable API errors as transient', () => {
    const retry = { type: 'system', subtype: 'api_retry', error_status: 529, error: 'overloaded' };
    expect(classify([INIT, retry, { ...AUTH_401, api_error_status: 529, result: 'overloaded' }], { code: 1 }).status).toBe('transient_error');
    expect(classify([INIT, { ...AUTH_401, api_error_status: 400, result: 'bad request' }], { code: 1 })).toMatchObject({ status: 'failed', reason: 'api_error' });
  });

  it('never reads exit 0 without a result line as success: SIGINT interrupts are cancelled', () => {
    const interrupted = { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
    expect(classify([INIT, interrupted], { code: 0, cancelled: true })).toMatchObject({ status: 'cancelled', reason: 'interrupted' });
    expect(classify([INIT, interrupted], { code: 0, escalation: ['SIGINT'], aborted: null })).toMatchObject({ status: 'cancelled', reason: 'interrupted' });
    // The same exit with no signal from Orbit is a crash (retryable), never a
    // cancellation that would end the worker for good, and never success.
    expect(classify([INIT, interrupted], { code: 0 })).toMatchObject({ status: 'failed', reason: 'crashed' });
    expect(classify([INIT], { code: 143 })).toMatchObject({ status: 'failed', reason: 'crashed' });
    expect(classify([INIT], { code: null, signal: 'SIGTERM', escalation: ['SIGINT', 'SIGTERM'] }).status).toBe('cancelled');
    // A signal Orbit did not send (an OOM kill) is a crash, not a cancellation.
    expect(classify([INIT], { code: null, signal: 'SIGKILL' })).toMatchObject({ status: 'failed', reason: 'crashed' });
    expect(classify([INIT, SUCCESS], { cancelled: true }).status).toBe('cancelled');
  });

  it('reports timeouts, crashes, torn output and spawn failures distinctly', () => {
    expect(classify([INIT], { code: null, signal: 'SIGKILL', timedOut: true, escalation: ['SIGINT', 'SIGTERM', 'SIGKILL'] })).toMatchObject({ status: 'timeout' });
    expect(classify([INIT], { code: 1 })).toMatchObject({ status: 'failed', reason: 'crashed' });
    expect(classify([INIT], { code: 137 })).toMatchObject({ status: 'failed', reason: 'crashed', exitCode: 137 });
    expect(classify([INIT], { code: 1 }, '\n{"type":"result","subt')).toMatchObject({ status: 'malformed_output', reason: 'malformed_transcript' });
    expect(classify([], { code: null, error: 'could not start claude: ENOENT' })).toMatchObject({ status: 'failed', reason: 'spawn_failed' });
  });

  it('refuses a session that did not run in dontAsk or loaded MCP servers', () => {
    expect(classify([{ ...INIT, permissionMode: 'default' }, SUCCESS])).toMatchObject({ status: 'failed', reason: 'unsafe_session' });
    expect(classify([{ ...INIT, mcp_servers: [{ name: 'repo', status: 'pending' }] }, SUCCESS])).toMatchObject({ status: 'failed', reason: 'unsafe_session' });
  });

  it('refuses success when system/init is missing, names another session, or shows a non-built-in plugin', () => {
    expect(classify([SUCCESS])).toMatchObject({ status: 'failed', reason: 'unsafe_session' });
    expect(sessionProblems(undefined)).toMatch(/no system\/init/);
    expect(classify([{ ...INIT, mcp_servers: undefined }, SUCCESS])).toMatchObject({ status: 'failed', reason: 'unsafe_session' });
    const builtins = [
      { name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' },
      { name: 'cc-plugin-plugin-authoring', path: 'builtin', source: 'cc-plugin-plugin-authoring@builtin' },
    ];
    expect(classify([{ ...INIT, plugins: builtins }, SUCCESS]).status).toBe('succeeded');
    expect(classify([{ ...INIT, plugins: [...builtins, { name: 'codex', path: '/home/acme/.claude/plugins/cache/codex', source: 'codex@openai-codex' }] }, SUCCESS])).toMatchObject({ status: 'failed', reason: 'unsafe_session' });
    expect(classify([{ ...INIT, plugins: 'all' }, SUCCESS])).toMatchObject({ status: 'failed', reason: 'unsafe_session' });
    const parsed = parseJsonLines([INIT, SUCCESS].map((l) => JSON.stringify(l)).join('\n'));
    const run = (expectedSessionId: string) => classifyClaudeTranscript({ events: parsed.events, malformedTail: false, exit: exit(), outputSchema: SCHEMA, expectedSessionId });
    expect(run('s1').status).toBe('succeeded');
    expect(run('s2')).toMatchObject({ status: 'failed', reason: 'unsafe_session', error: expect.stringContaining('not s2') });
  });
});

describe('claudeUsage', () => {
  it('sums modelUsage over every model and names the one that cost most (content fallback switches models)', () => {
    const u = claudeUsage([INIT as Record<string, unknown>, SUCCESS]);
    expect(u).toEqual({ provider: 'claude', model: 'claude-opus-5', inputTokens: 1500, outputTokens: 600, cacheReadTokens: 300, cacheWriteTokens: 50, costUsd: 0.03, costSource: 'reported' });
  });

  it('without a result line counts assistant message usage once per message id and leaves cost unknown, not zero', () => {
    const msg = (id: string, out: number) => ({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 }, content: [] } });
    const u = claudeUsage([INIT, msg('m1', 5), msg('m1', 7), msg('m2', 3)]);
    expect(u).toMatchObject({ model: 'claude-sonnet-5-5', inputTokens: 20, outputTokens: 10, costUsd: null, costSource: 'unavailable' });
    expect(claudeUsage([])).toMatchObject({ inputTokens: null, costUsd: null, costSource: 'unavailable' });
  });

  it('subtracts an earlier cumulative report for a resumed session', () => {
    const now = claudeUsage([SUCCESS]);
    const before = { ...now, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 50, costUsd: 0.01 };
    expect(subtractUsage(now, before)).toMatchObject({ inputTokens: 500, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(subtractUsage(now, before).costUsd).toBeCloseTo(0.02);
  });
});

describe('claudeEvents', () => {
  it('maps init, tool use, text, retries and the result to progress events, summarizing tool input', () => {
    const lines = [
      INIT,
      { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }, { type: 'tool_use', name: 'Write', input: { file_path: '/w/apps/a.ts', content: 'secret body' } }] } },
      { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 4, error: 'overloaded' },
      { type: 'some_future_event' },
      SUCCESS,
    ] as Record<string, unknown>[];
    const events = claudeEvents(lines, 5);
    expect(events.map((e) => e.type)).toEqual(['started', 'message', 'tool', 'error', 'usage', 'finished']);
    expect(events[2]).toMatchObject({ tool: 'Write', summary: '/w/apps/a.ts' });
    expect(JSON.stringify(events)).not.toContain('secret body');
  });
});
