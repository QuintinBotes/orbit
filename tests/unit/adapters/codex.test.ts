import { describe, expect, it } from 'vitest';
import { buildCodexArgv, parseDoctorChecks, parseHelpFlags, CODEX_REQUIRED_FLAGS } from '../../../src/adapters/codex.ts';
import { classifyCodexTranscript, codexEvents, codexUsage } from '../../../src/adapters/codex-events.ts';
import { parseJsonLines } from '../../../src/adapters/supervise.ts';
import type { ExitRecord } from '../../../src/adapters/shim.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';

const SCHEMA = MODEL_OUTPUT_SCHEMAS.review;
const REVIEW = { verdict: 'APPROVE', candidate_revision: 'abc1234', findings: [] };

function exit(over: Partial<ExitRecord> = {}): ExitRecord {
  return { version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 0, endedAt: 1000, ...over };
}

function classify(jsonl: string, ex: Partial<ExitRecord> = {}) {
  const p = parseJsonLines(jsonl);
  return classifyCodexTranscript({ events: p.events, malformedTail: p.malformedTail, exit: exit(ex), outputSchema: SCHEMA, model: 'gpt-6-astra' });
}

// Verbatim shapes from docs/interfaces/codex-cli.md section 3 (samples A, B, C, D').
const STARTED = '{"type":"thread.started","thread_id":"01a10135-b266-7493-be87-a577cbd9146b"}';
const WARNING = '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `mock-model` not found. Defaulting to fallback metadata; ..."}}';
const TURN = '{"type":"turn.started"}';
const USAGE = '{"input_tokens":1234,"cached_input_tokens":1000,"cache_write_input_tokens":0,"output_tokens":56,"reasoning_output_tokens":7}';
const message = (text: string) => JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
const completed = `{"type":"turn.completed","usage":${USAGE}}`;

describe('classifyCodexTranscript', () => {
  it('accepts a final agent message that parses and validates against Orbit\'s own schema copy', () => {
    const r = classify([STARTED, WARNING, TURN, message(`${JSON.stringify(REVIEW)}\n`), completed].join('\n'));
    expect(r).toMatchObject({ status: 'succeeded', structured: REVIEW, threadId: '01a10135-b266-7493-be87-a577cbd9146b' });
    expect(r.usage).toEqual({ provider: 'codex', model: 'gpt-6-astra', inputTokens: 1234, outputTokens: 56, cacheReadTokens: 1000, cacheWriteTokens: 0, costUsd: null, costSource: 'unavailable' });
    expect(r.warnings[0]).toMatch(/Model metadata/);
  });

  it('ignores unknown event and item types and treats top-level error events as retries, not failures', () => {
    const lines = [STARTED, '{"type":"turn.started"}', '{"type":"error","message":"Reconnecting... 2/5 (stream disconnected)"}', '{"type":"item.completed","item":{"type":"collab_tool_call","tool":"wait"}}', '{"type":"brand.new.event","x":1}', message(JSON.stringify(REVIEW)), completed];
    expect(classify(lines.join('\n')).status).toBe('succeeded');
  });

  it('treats exit 0 with invalid JSON or a schema mismatch as malformed, never as "no findings" (gaps V6)', () => {
    expect(classify([STARTED, TURN, message('not json at all'), completed].join('\n'))).toMatchObject({ status: 'malformed_output', reason: 'invalid_json', structured: null });
    expect(classify([STARTED, TURN, message('{"verdict":"MAYBE","extra":1}'), completed].join('\n'))).toMatchObject({ status: 'malformed_output', reason: 'schema_mismatch' });
    expect(classify([STARTED, TURN, completed].join('\n'))).toMatchObject({ status: 'malformed_output', reason: 'no_agent_message' });
  });

  it('uses the last agent message before turn.completed', () => {
    const r = classify([STARTED, TURN, message('{"draft":true}'), message(JSON.stringify(REVIEW)), completed].join('\n'));
    expect(r.structured).toEqual(REVIEW);
  });

  it('blocks on authentication failures (samples B and C)', () => {
    const missing = [STARTED, TURN, '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}', '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"}}'];
    expect(classify(missing.join('\n'), { code: 1 })).toMatchObject({ status: 'auth_failed', reason: 'auth' });
    const invalid = '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Incorrect API key provided: sk-inval***. url: https://api.openai.com/v1/responses, auth error: 401, auth error code: invalid_api_key"}}';
    expect(classify([STARTED, TURN, invalid].join('\n'), { code: 1 }).status).toBe('auth_failed');
    const refresh = '{"type":"turn.failed","error":{"message":"Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again."}}';
    expect(classify([STARTED, TURN, refresh].join('\n'), { code: 1 }).status).toBe('auth_failed');
  });

  it('does not call a run that recovered from a 401 retry an auth failure', () => {
    const r = classify([STARTED, TURN, '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized)"}', message(JSON.stringify(REVIEW)), completed].join('\n'));
    expect(r.status).toBe('succeeded');
  });

  it('separates model rejections (sample A) from transient server errors', () => {
    const rejected = '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The model is not supported.\\"}}"}}';
    expect(classify([STARTED, TURN, rejected].join('\n'), { code: 1 })).toMatchObject({ status: 'failed', reason: 'turn_failed' });
    const overloaded = '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":503,\\"error\\":{\\"type\\":\\"server_error\\"}}"}}';
    expect(classify([STARTED, TURN, overloaded].join('\n'), { code: 1 }).status).toBe('transient_error');
  });

  it('reports usage as null, not zero, when the turn did not complete', () => {
    const r = classify([STARTED, TURN].join('\n'), { code: 1, cancelled: true, escalation: ['SIGINT'] });
    expect(r.status).toBe('cancelled');
    expect(r.usage).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null, costUsd: null });
    expect(codexUsage([], null).inputTokens).toBeNull();
  });

  it('classifies interrupts, external kills, crashes, timeouts and torn output', () => {
    expect(classify([STARTED, TURN].join('\n'), { code: null, signal: 'SIGTERM', escalation: ['SIGINT', 'SIGTERM'] }).status).toBe('cancelled');
    expect(classify([STARTED, TURN].join('\n'), { code: null, signal: 'SIGKILL' })).toMatchObject({ status: 'failed', reason: 'crashed' });
    expect(classify([STARTED, TURN].join('\n'), { code: 1 })).toMatchObject({ status: 'failed', reason: 'crashed' });
    expect(classify(STARTED, { timedOut: true, code: null, signal: 'SIGKILL', escalation: ['SIGINT', 'SIGTERM', 'SIGKILL'] }).status).toBe('timeout');
    expect(classify(`${STARTED}\n{"type":"turn.compl`, { code: 1 })).toMatchObject({ status: 'malformed_output', reason: 'malformed_transcript' });
    expect(classify([STARTED, TURN, message(JSON.stringify(REVIEW)), completed].join('\n'), { code: 1 })).toMatchObject({ status: 'failed' });
  });
});

describe('codexEvents', () => {
  it('maps thread, items, retries and terminal events; unknown types are skipped', () => {
    const p = parseJsonLines([STARTED, WARNING, TURN, '{"type":"item.completed","item":{"type":"command_execution","command":"bash -lc ls","status":"completed"}}', '{"type":"unknown"}', message('{}'), completed].join('\n'));
    const events = codexEvents(p.events, 1, 'gpt-6-astra');
    expect(events.map((e) => e.type)).toEqual(['started', 'error', 'tool', 'message', 'usage', 'finished']);
  });
});

describe('codex invocation', () => {
  it('builds the verified read-only review argv and never a dangerous flag', () => {
    const argv = buildCodexArgv({ command: ['codex'], model: 'gpt-6-astra', effort: 'high', cwd: '/r', schemaPath: '/w/schema.json', lastMessagePath: '/w/last-message.json' });
    expect(argv.slice(0, 2)).toEqual(['codex', 'exec']);
    expect(argv).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--json', '--output-schema', '/w/schema.json', '-o', '/w/last-message.json', '-m', 'gpt-6-astra', '-C', '/r']));
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(argv).toContain('model_reasoning_effort="high"');
    expect(argv).toContain('web_search="disabled"');
    expect(argv.at(-1)).toBe('-');
    for (const bad of ['--full-auto', '-a', '--yolo', '--skip-git-repo-check']) expect(argv).not.toContain(bad);
    expect(argv.some((a) => a.startsWith('--dangerously'))).toBe(false);
    expect(buildCodexArgv({ command: ['codex'], model: 'm', effort: null, cwd: '/r', schemaPath: 's', lastMessagePath: 'o' }).join(' ')).not.toContain('model_reasoning_effort');
  });

  it('passes --sandbox danger-full-access only for the os-sandbox tier, inside the sandbox-runtime wrapper', () => {
    const input = { command: ['codex'], model: 'gpt-6-astra', effort: 'high', cwd: '/r', schemaPath: '/w/schema.json', lastMessagePath: '/w/last-message.json' };
    const argv = buildCodexArgv({ ...input, tier: 'os-sandbox', wrapper: 'sandbox-runtime' });
    expect(argv.filter((a) => a === '--sandbox')).toHaveLength(1);
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('danger-full-access');
    expect(argv).not.toContain('read-only');
    // Only the sandbox mode differs from the codex-sandbox tier's argv.
    expect(argv.map((a) => (a === 'danger-full-access' ? 'read-only' : a))).toEqual(buildCodexArgv(input));
    expect(buildCodexArgv({ ...input, tier: 'codex-sandbox' })).toEqual(buildCodexArgv(input));
    for (const bad of ['--full-auto', '-a', '--yolo', '--skip-git-repo-check']) expect(argv).not.toContain(bad);
    expect(argv.some((a) => a.startsWith('--dangerously'))).toBe(false);
  });

  it('refuses --sandbox danger-full-access in every combination except the sandbox-runtime wrapper', () => {
    const input = { command: ['codex'], model: 'm', effort: null, cwd: '/r', schemaPath: 's', lastMessagePath: 'o' };
    for (const wrapper of [undefined, null, 'none', 'container'] as const) {
      expect(() => buildCodexArgv({ ...input, tier: 'os-sandbox', wrapper }), String(wrapper)).toThrow(expect.objectContaining({ code: 'POLICY_DENIED', message: expect.stringContaining('danger-full-access') }));
    }
    // The codex-sandbox tier is read-only whatever wraps it.
    for (const wrapper of [undefined, null, 'none', 'container', 'sandbox-runtime'] as const) {
      expect(buildCodexArgv({ ...input, tier: 'codex-sandbox', wrapper }), String(wrapper)).toContain('read-only');
    }
  });

  it('sets only config keys verified against codex-cli 0.153.4, and no output-token cap (G53)', () => {
    // Checked for G53: `codex exec --help`, docs/interfaces/codex-cli.md and the config keys compiled into the 0.153.4 binary name no
    // setting that caps a turn's output tokens (model_context_window, model_auto_compact_token_limit and tool_output_token_limit
    // bound the context window and tool output, not the model's answer; max_output_tokens exists only as an argument of the
    // exec_command tool). A guessed `-c` key could not be shown to take effect, and unknown keys are only rejected under --strict-config.
    const argv = buildCodexArgv({ command: ['codex'], model: 'm', effort: 'high', cwd: '/r', schemaPath: 's', lastMessagePath: 'o' });
    const keys = argv.flatMap((a, i) => (argv[i - 1] === '-c' ? [a.slice(0, a.indexOf('='))] : []));
    expect(keys.sort()).toEqual(['model_reasoning_effort', 'web_search']);
    expect(argv.join(' ')).not.toMatch(/max_output|output_token|max_tokens|max_completion/);
  });

  it('parses flags from a clap help page', () => {
    const help = '  -m, --model <MODEL>\n  -s, --sandbox <SANDBOX_MODE>\n      --ephemeral\n      --ignore-user-config\n      --output-schema <FILE>\n      --json\n  -o, --output-last-message <FILE>\n  -C, --cd <DIR>\n';
    const flags = parseHelpFlags(help);
    expect(CODEX_REQUIRED_FLAGS.every((f) => flags.has(f))).toBe(true);
    expect(flags.has('--full-auto')).toBe(false);
  });

  it('reads doctor checks as an object or a list, and refuses garbage', () => {
    expect(parseDoctorChecks('{"checks":{"auth.credentials":{"status":"ok"},"network.websocket_reachability":{"status":"fail"}}}')).toEqual({ 'auth.credentials': 'ok', 'network.websocket_reachability': 'fail' });
    expect(parseDoctorChecks('{"checks":[{"id":"auth.credentials","status":"fail"}]}')).toEqual({ 'auth.credentials': 'fail' });
    expect(parseDoctorChecks('not json')).toBeNull();
    expect(parseDoctorChecks('{"other":1}')).toBeNull();
  });
});
