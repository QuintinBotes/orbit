import { describe, expect, it } from 'vitest';
import { classifyClaudeTranscript, claudeEvents, claudeUsage, sessionProblems, subtractUsage } from '../../../src/adapters/claude-transcript.ts';
import { classifyCodexTranscript, codexEvents, codexUsage } from '../../../src/adapters/codex-events.ts';
import type { ExitRecord } from '../../../src/adapters/shim.ts';

const SCHEMA = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const INIT = { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5-5', permissionMode: 'dontAsk', mcp_servers: [], tools: [] };

function exit(over: Partial<ExitRecord> = {}): ExitRecord {
  return { version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 1000, endedAt: 3000, ...over };
}

const claude = (events: object[], ex: Partial<ExitRecord> = {}, tail = false) => classifyClaudeTranscript({ events: events as Record<string, unknown>[], malformedTail: tail, exit: exit(ex), outputSchema: SCHEMA });

describe('classifyClaudeTranscript: reasons and their fallback wording', () => {
  it('says "no signal" for a timeout the shim ended without sending one', () => {
    expect(claude([INIT], { timedOut: true }).error).toBe('timed out; the shim sent no signal');
    expect(claude([INIT], { timedOut: true, escalation: ['SIGINT', 'SIGTERM'] }).error).toBe('timed out; the shim sent SIGINT, SIGTERM');
  });

  it.each([
    ['error_max_turns', 'max_turns', 'reached the maximum number of turns'],
    ['error_max_budget_usd', 'max_budget', 'reached the maximum budget'],
    ['error_max_structured_output_retries', 'structured_output_retries', 'structured output retries exhausted'],
    ['error_during_execution', 'execution_error', 'error during execution'],
  ])('%s without a message reads as a plain reason, and with one quotes it', (subtype, reason, fallback) => {
    const bare = claude([INIT, { type: 'result', subtype, is_error: true }]);
    expect(bare).toMatchObject({ reason, error: fallback });
    const withResult = claude([INIT, { type: 'result', subtype, is_error: true, result: 'from the result text' }]);
    expect(withResult.error).toBe('from the result text');
    const withErrors = claude([INIT, { type: 'result', subtype, is_error: true, errors: ['first', 2, 'third'], result: 'ignored' }]);
    expect(withErrors.error).toBe('first');
  });

  it('classifies transient API failures by status or by a retry notice, and names the status when it has no message', () => {
    expect(claude([INIT, { type: 'result', subtype: 'success', is_error: true, api_error_status: 429 }], { code: 1 })).toMatchObject({ status: 'transient_error', error: 'API error 429' });
    expect(claude([INIT, { type: 'result', subtype: 'success', is_error: true, api_error_status: 503, result: 'busy' }], { code: 1 })).toMatchObject({ status: 'transient_error', error: 'busy' });
    const retry = { type: 'system', subtype: 'api_retry', error: 'overloaded' };
    expect(claude([INIT, retry, { type: 'result', subtype: 'success', is_error: true }], { code: 1 })).toMatchObject({ status: 'transient_error', error: 'API error' });
    const assistant = { type: 'assistant', error: 'rate_limit', message: { content: [] } };
    expect(claude([INIT, assistant, { type: 'result', subtype: 'success', is_error: true }], { code: 1 }).status).toBe('transient_error');
  });

  it('classifies other API failures and anything else as execution errors, with a default message', () => {
    expect(claude([INIT, { type: 'result', subtype: 'success', is_error: true, api_error_status: 400 }], { code: 1 })).toMatchObject({ reason: 'api_error', error: 'API error' });
    expect(claude([INIT, { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error' }], { code: 1 })).toMatchObject({ reason: 'api_error' });
    expect(claude([INIT, { type: 'result', is_error: true }], { code: 2 })).toMatchObject({ reason: 'execution_error', error: 'exit 2, subtype missing' });
    expect(claude([INIT, { type: 'result', subtype: 'weird', is_error: false }], { code: 0 })).toMatchObject({ reason: 'execution_error', error: 'exit 0, subtype weird' });
  });

  it('names an authentication failure from a retry notice without a status', () => {
    const retry = { type: 'system', subtype: 'api_retry', error: 'account_on_hold' };
    expect(claude([INIT, retry], { code: 1 }).error).toBe('authentication failed (account_on_hold, HTTP unknown); not retried');
  });

  it('tells apart no result line with and without a signal, a torn tail and a plain early exit', () => {
    expect(claude([INIT], { escalation: ['SIGINT'], code: 0 }).reason).toBe('interrupted');
    expect(claude([INIT], { signal: 'SIGKILL', code: null }).error).toBe('killed by SIGKILL without a result line');
    expect(claude([INIT], {}, true).reason).toBe('malformed_transcript');
    expect(claude([INIT], { code: 3 }).error).toBe('exited 3 without a result line');
    expect(claude([], { error: 'spawn ENOENT' })).toMatchObject({ reason: 'spawn_failed', error: 'spawn ENOENT' });
  });

  it('falls back to wall time for duration and to the init line for the session id', () => {
    const r = claude([INIT, { type: 'result', subtype: 'success', is_error: false, structured_output: { answer: 'x' } }]);
    expect(r.durationMs).toBe(2000);
    expect(r.sessionId).toBe('s1');
    expect(r.permissionDenials).toEqual([]);
    expect(r.models).toEqual([]);
    expect(r.numTurns).toBeNull();
  });

  it('summarizes a malformed permission denial without failing', () => {
    const r = claude([INIT, { type: 'result', subtype: 'success', is_error: false, structured_output: { answer: 'x' }, permission_denials: [{}, 'junk', { tool_name: 'Write' }] }]);
    expect(r.permissionDenials).toEqual([{ tool_name: '', tool_use_id: '' }, { tool_name: 'Write', tool_use_id: '' }]);
  });
});

describe('sessionProblems', () => {
  it('names each way a session can differ from the one Orbit launched', () => {
    expect(sessionProblems(undefined)).toMatch(/no system\/init line/);
    expect(sessionProblems({ ...INIT, permissionMode: 'default' })).toMatch(/permission mode default/);
    expect(sessionProblems({ ...INIT, mcp_servers: [{ name: 'x' }] })).toBe('the session loaded 1 MCP server(s)');
    expect(sessionProblems({ ...INIT, mcp_servers: undefined })).toBe('system/init does not list its MCP servers');
    expect(sessionProblems({ ...INIT, plugins: [{ source: 'x@builtin' }] })).toBeNull();
    expect(sessionProblems({ ...INIT, plugins: [{ source: 'x@market' }, 'junk'] })).toMatch(/2 plugin\(s\)/);
    expect(sessionProblems({ ...INIT, plugins: 'not a list' })).toMatch(/1 plugin\(s\)/);
    expect(sessionProblems(INIT, 's2')).toBe('the transcript is of session s1, not s2');
    expect(sessionProblems(INIT, 's1')).toBeNull();
  });
});

describe('claudeUsage', () => {
  it('sums modelUsage across models, skipping malformed entries, and picks the model that cost most', () => {
    const usage = claudeUsage([
      { type: 'result', modelUsage: { a: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, costUSD: 0.5 }, b: 'junk', c: { outputTokens: 4, costUSD: 1 } } },
    ] as never);
    expect(usage).toMatchObject({ model: 'c', inputTokens: 10, outputTokens: 9, cacheReadTokens: 2, cacheWriteTokens: 1, costUsd: 1.5, costSource: 'reported' });
  });

  it('falls back to the result total when a model has no cost, and says unavailable when nothing has one', () => {
    const noCost = { type: 'result', modelUsage: { a: { inputTokens: 1, outputTokens: 7 }, b: { outputTokens: 3, costUSD: 2 } }, total_cost_usd: 2.5 };
    expect(claudeUsage([noCost] as never)).toMatchObject({ costUsd: 2.5, costSource: 'reported', model: 'a' });
    const none = { type: 'result', modelUsage: { a: { outputTokens: 1 }, b: { outputTokens: 9 } } };
    expect(claudeUsage([none] as never)).toMatchObject({ costUsd: null, costSource: 'unavailable', model: 'b' });
    expect(claudeUsage([{ type: 'result', modelUsage: { x: 'junk' } }] as never).model).toBeNull();
  });

  it('reads a cost-only result, and sums assistant messages once per id when there is no result', () => {
    expect(claudeUsage([{ type: 'assistant', message: { model: 'm1', content: [] } }, { type: 'result', total_cost_usd: 0.2 }] as never)).toMatchObject({ costUsd: 0.2, model: 'm1', inputTokens: null });
    const events = [
      { type: 'system', subtype: 'init', model: 'init-model' },
      { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } },
      { type: 'assistant', message: { usage: {} } },
      { type: 'assistant', message: { content: [] } },
      { type: 'user' },
    ];
    expect(claudeUsage(events as never)).toMatchObject({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: null, costSource: 'unavailable', model: 'init-model' });
    expect(claudeUsage([{ type: 'user' }] as never)).toMatchObject({ model: null, inputTokens: null });
  });

  it('subtracts a previous report, keeping unknowns unknown and never going negative', () => {
    const base = { provider: 'claude', model: 'm', costSource: 'reported' as const };
    const cumulative = { ...base, inputTokens: 100, outputTokens: null, cacheReadTokens: 5, cacheWriteTokens: 1, costUsd: 0.5 };
    const previous = { ...base, inputTokens: 40, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: 9, costUsd: null };
    expect(subtractUsage(cumulative, previous)).toMatchObject({ inputTokens: 60, outputTokens: null, cacheReadTokens: 5, cacheWriteTokens: 0, costUsd: 0.5 });
  });
});

describe('claudeEvents', () => {
  it('describes each kind of line, with placeholders for missing retry fields', () => {
    const events = claudeEvents(
      [
        { type: 'system', subtype: 'init' },
        { type: 'system', subtype: 'api_retry' },
        { type: 'assistant', timestamp: '2026-10-03T00:00:00.000Z', message: { content: [{ type: 'text', text: 'x'.repeat(2100) }, { type: 'tool_use', name: 'Read', input: { file_path: '/a' } }, 'junk', { type: 'tool_use', name: 'Bash', input: 'not an object' }, { type: 'tool_use', name: 'Grep', input: { pattern: 7 } }] }, error: 'rate_limit' },
        { type: 'assistant', message: { content: 'not a list' } },
        { type: 'result', modelUsage: { m: { outputTokens: 1, costUSD: 1 } } },
        { type: 'user' },
      ] as never,
      5,
    );
    expect(events.map((e) => e.type)).toEqual(['started', 'error', 'message', 'tool', 'tool', 'tool', 'error', 'usage', 'finished']);
    expect(events[1]).toMatchObject({ message: 'API retry ?/?: unknown' });
    expect(events[2]).toMatchObject({ at: Date.parse('2026-10-03T00:00:00.000Z') });
    expect((events[2] as { text: string }).text).toHaveLength(2003);
    expect(events.filter((e) => e.type === 'tool').map((e) => (e as { summary: string }).summary)).toEqual(['/a', '', '']);
    expect(events[0]).toMatchObject({ at: 5 });
  });
});

const codex = (events: object[], ex: Partial<ExitRecord> = {}, over: { malformedTail?: boolean } = {}) =>
  classifyCodexTranscript({ events: events as Record<string, unknown>[], malformedTail: over.malformedTail ?? false, exit: exit(ex), outputSchema: SCHEMA, model: 'codex-x' });

const DONE = { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 } };
const MESSAGE = { type: 'item.completed', item: { type: 'agent_message', text: '{"answer":"ok"}' } };

describe('classifyCodexTranscript', () => {
  it('reports a spawn failure, a timeout without a signal and a turn that failed without a message', () => {
    expect(codex([], { error: 'ENOENT' })).toMatchObject({ reason: 'spawn_failed', error: 'ENOENT' });
    expect(codex([{ type: 'thread.started', thread_id: 't1' }], { timedOut: true }).error).toBe('timed out; the shim sent no signal');
    expect(codex([{ type: 'turn.failed' }])).toMatchObject({ reason: 'turn_failed', error: 'turn failed' });
    expect(codex([{ type: 'turn.failed', error: { message: 7 } }]).error).toBe('turn failed');
    expect(codex([{ type: 'turn.failed', error: 'plain' }]).error).toBe('turn failed');
  });

  it('recognizes an authentication failure in a warning or in the failure, but not after a completed turn', () => {
    expect(codex([{ type: 'error', message: 'unexpected status 401 Unauthorized' }])).toMatchObject({ status: 'auth_failed', reason: 'auth' });
    expect(codex([{ type: 'turn.failed', error: { message: 'Please sign in again' } }]).status).toBe('auth_failed');
    expect(codex([{ type: 'item.completed', item: { type: 'error', message: 'refresh token could not be refreshed' } }]).status).toBe('auth_failed');
    expect(codex([{ type: 'error', message: '401 Unauthorized' }, MESSAGE, DONE]).status).toBe('succeeded');
  });

  it('tells apart no terminal event with and without a signal, a torn tail and a plain exit', () => {
    expect(codex([], { escalation: ['SIGINT'] }).reason).toBe('interrupted');
    expect(codex([], { signal: 'SIGKILL', code: null }).error).toBe('killed by SIGKILL with no terminal event');
    expect(codex([], {}, { malformedTail: true }).reason).toBe('malformed_transcript');
    expect(codex([], { code: 4 }).error).toBe('exited 4 without turn.completed or turn.failed');
  });

  it('classifies transient failures, completed turns with a bad exit, and unusable final messages', () => {
    expect(codex([{ type: 'turn.failed', error: { message: 'unexpected status 503 Service Unavailable' } }]).reason).toBe('transient_api_error');
    expect(codex([MESSAGE, DONE], { code: 1 }).error).toBe('turn.completed but exit 1');
    expect(codex([DONE]).reason).toBe('no_agent_message');
    expect(codex([{ type: 'item.completed', item: { type: 'agent_message', text: 'not json' } }, DONE])).toMatchObject({ reason: 'invalid_json', text: 'not json' });
    expect(codex([{ type: 'item.completed', item: { type: 'agent_message', text: '{"answer":1}' } }, DONE]).reason).toBe('schema_mismatch');
    expect(codex([{ type: 'thread.started', thread_id: 9 }, MESSAGE, DONE])).toMatchObject({ status: 'succeeded', threadId: null, structured: { answer: 'ok' } });
  });
});

describe('codexUsage and codexEvents', () => {
  it('reports unknown tokens when no turn completed, and a missing optional count as zero or unknown', () => {
    expect(codexUsage([], 'm')).toMatchObject({ inputTokens: null, costSource: 'unavailable' });
    expect(codexUsage([{ type: 'turn.completed', usage: { input_tokens: 'many', output_tokens: Number.NaN, cache_write_input_tokens: 3 } }], 'm')).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: 3 });
    expect(codexUsage([{ type: 'turn.completed', usage: [] }], null).inputTokens).toBeNull();
  });

  it('describes each kind of line and ignores the rest', () => {
    const long = 'y'.repeat(600);
    const events = codexEvents(
      [
        { type: 'thread.started' },
        { type: 'error', message: long },
        { type: 'error' },
        { type: 'item.completed' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'hello' } },
        { type: 'item.completed', item: { type: 'command_execution', command: 'ls' } },
        { type: 'item.completed', item: { type: 'command_execution' } },
        { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a' }] } },
        { type: 'item.completed', item: { type: 'file_change' } },
        { type: 'item.completed', item: { type: 'mcp_tool_call', server: 's', tool: 't' } },
        { type: 'item.completed', item: { type: 'error', message: 'boom' } },
        { type: 'item.completed', item: { type: 'error' } },
        { type: 'item.completed', item: { type: 'reasoning' } },
        { type: 'turn.completed', usage: { input_tokens: 1 } },
        { type: 'turn.failed', error: { message: 'bad' } },
        { type: 'turn.failed' },
        { type: 'turn.started' },
      ] as never,
      9,
      'codex-x',
    );
    expect(events.map((e) => e.type)).toEqual(['started', 'error', 'error', 'message', 'tool', 'tool', 'tool', 'tool', 'tool', 'error', 'error', 'usage', 'finished', 'error', 'finished', 'error', 'finished']);
    expect((events[1] as { message: string }).message).toBe(`${'y'.repeat(500)}...`);
    expect((events[2] as { message: string }).message).toBe('');
    expect(events[6]).toMatchObject({ tool: 'file_change', summary: '[{"path":"a"}]' });
    expect(events[8]).toMatchObject({ tool: 'mcp:s/t' });
    expect(events[13]).toMatchObject({ message: 'bad' });
    expect(events[15]).toMatchObject({ message: 'turn failed' });
  });
});
