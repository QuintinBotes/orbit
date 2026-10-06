#!/usr/bin/env node
// Scenario-driven stand-in for the `claude` CLI. Accepts the argv Orbit's
// ClaudeAdapter builds and answers with a realistic stream-json transcript
// (shapes from docs/interfaces/claude-headless-and-sandbox.md 1.3-1.4 and
// observed runs). See README.md for the scenario format.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyEdits, attemptWrite, crashMidEdit, flagValue, loadStep, logArgv, readStdin, renderPlaceholders, roleFromSchema, sleep, spawnGrandchild } from './scenario.mjs';

const argv = process.argv.slice(2);
const env = process.env;

function out(o) {
  process.stdout.write(`${JSON.stringify(o)}\n`);
}

if (argv[0] === '--version') {
  process.stdout.write(`${env.ORBIT_FAKE_CLAUDE_VERSION ?? '2.1.288'} (Claude Code)\n`);
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  const auth = scenarioAuth();
  process.stdout.write(`${JSON.stringify({ loggedIn: auth.loggedIn, authMethod: auth.loggedIn ? auth.authMethod : 'none', apiProvider: 'firstParty' })}\n`);
  process.exit(auth.loggedIn ? 0 : 1);
}

if (argv[0] === 'plugin' && argv[1] === 'list' && argv.includes('--json')) {
  // The verified shape of `claude plugin list --json` (2.1.291): one entry per installed plugin.
  process.stdout.write(`${JSON.stringify(scenarioPlugins().map((p) => ({ id: p.id, version: p.version ?? '1.0.0', scope: p.scope, enabled: p.enabled !== false, installPath: `/opt/acme/plugins/${p.id.replace('@', '/')}` })), null, 2)}\n`);
  process.exit(0);
}

if (!argv.includes('-p') && !argv.includes('--print')) {
  process.stderr.write('fake-claude: only -p, --version, auth status and plugin list are supported\n');
  process.exit(1);
}
if (flagValue(argv, '--output-format') === 'stream-json' && !argv.includes('--verbose')) {
  process.stderr.write('Error: When using --print, --output-format=stream-json requires --verbose\n');
  process.exit(1);
}

const schemaText = flagValue(argv, '--json-schema');
let schema = null;
if (schemaText !== null) {
  try {
    schema = JSON.parse(schemaText);
  } catch {
    process.stderr.write('Error: --json-schema is not a valid JSON Schema\n');
    process.exit(1);
  }
}
const role = roleFromSchema(schema);
const loaded = loadStep(role, env);
const call = loaded.call;
const prompt = readStdin();
const step = renderPlaceholders(loaded.step, prompt);
const sessionId = flagValue(argv, '--session-id') ?? randomUUID();
const model = step.model ?? resolveModel(flagValue(argv, '--model'));
const cwd = process.cwd();
logArgv(env, { tool: 'claude', role, call, argv, envKeys: Object.keys(env).sort(), cwd, promptBytes: prompt.length });

let interrupted = false;
process.on('SIGINT', () => {
  if (step.ignoreSignals) return;
  // Mirrors the verified behaviour: SIGINT ends the turn, exit 0, no result line.
  interrupted = true;
  out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, session_id: sessionId });
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (step.ignoreSignals) return;
  process.exit(143);
});

let n = 0;
const ts = () => new Date().toISOString();
function assistant(content) {
  n++;
  out({ type: 'assistant', message: { id: `msg_fake${n}`, type: 'message', role: 'assistant', model, content, stop_reason: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, session_id: sessionId, timestamp: ts() });
}
function toolResult(id, content, isError = false) {
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, session_id: sessionId, timestamp: ts() });
}

out({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  cwd,
  model,
  permissionMode: flagValue(argv, '--permission-mode') ?? 'default',
  tools: (flagValue(argv, '--tools') ?? 'Read,Glob,Grep').split(',').filter(Boolean).concat(schema ? ['StructuredOutput'] : []),
  mcp_servers: [],
  apiKeySource: env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none',
  claude_code_version: '2.1.288',
  ...initPlugins(),
  timestamp: ts(),
});

let grandchild = null;
if (step.grandchildPidFile) grandchild = spawnGrandchild(step.grandchildPidFile);

for (const [i, e] of (step.edits ?? []).entries()) {
  const id = `toolu_edit${i}`;
  assistant([{ type: 'tool_use', id, name: e.op === 'delete' ? 'Bash' : e.op === 'replace' ? 'Edit' : 'Write', input: { file_path: e.path } }]);
  applyEdits(cwd, [e]);
  toolResult(id, 'ok');
}
if (step.forbiddenWrite) {
  const r = attemptWrite(cwd, step.forbiddenWrite);
  assistant([{ type: 'tool_use', id: 'toolu_forbidden', name: 'Bash', input: { command: `echo x > ${r.path}` } }]);
  toolResult('toolu_forbidden', r.written ? 'written' : `denied: ${r.error}`, !r.written);
}
if (step.crash) crashMidEdit(cwd, step.crash);
if (step.sleepMs) await sleep(step.sleepMs);
if (interrupted) process.exit(0);
if (grandchild) grandchild.unref();

const usage = { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 800, cacheCreationInputTokens: 100, costUSD: 0.0123, ...(step.usage ?? {}) };
const modelUsage = { [model]: { webSearchRequests: 0, contextWindow: 1000000, maxOutputTokens: 128000, canonicalModel: model, provider: 'firstParty', costBasis: 'list', ...usage } };
const baseResult = {
  type: 'result',
  session_id: sessionId,
  duration_ms: 1234,
  duration_api_ms: 1000,
  num_turns: (step.edits ?? []).length + 1,
  total_cost_usd: usage.costUSD,
  usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
  modelUsage,
  permission_denials: [],
  uuid: randomUUID(),
};

switch (step.outcome ?? 'success') {
  case 'success': {
    const structured = step.structured ?? {};
    assistant([{ type: 'tool_use', id: 'toolu_so', name: 'StructuredOutput', input: structured }]);
    toolResult('toolu_so', 'Structured output provided successfully');
    out({ ...baseResult, subtype: 'success', is_error: false, api_error_status: null, terminal_reason: 'completed', result: JSON.stringify(structured), structured_output: structured });
    process.exit(step.exitCode ?? 0);
    break;
  }
  case 'auth_failure':
    out({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 4, retry_delay_ms: 500, error_status: 401, error: 'authentication_failed', session_id: sessionId });
    if (step.hangAfterRetry) await sleep(step.hangAfterRetry);
    out({ type: 'assistant', error: 'authentication_failed', is_api_error_message: true, message: { id: 'msg_err', model, role: 'assistant', content: [{ type: 'text', text: 'Invalid API key · Fix external API key' }] }, session_id: sessionId });
    out({ ...baseResult, total_cost_usd: 0, modelUsage: {}, subtype: 'success', is_error: true, api_error_status: 401, terminal_reason: 'api_error', result: 'Invalid API key · Fix external API key' });
    process.exit(1);
    break;
  case 'not_logged_in':
    out({ ...baseResult, total_cost_usd: 0, modelUsage: {}, subtype: 'success', is_error: true, api_error_status: null, terminal_reason: 'api_error', result: 'Not logged in · Please run /login' });
    process.exit(1);
    break;
  case 'max_turns':
    out({ ...baseResult, subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', errors: ['Reached maximum number of turns (2)'] });
    process.exit(1);
    break;
  case 'max_budget':
    out({ ...baseResult, subtype: 'error_max_budget_usd', is_error: true, terminal_reason: 'budget_exhausted', errors: ['Reached maximum budget ($0.5)'] });
    process.exit(1);
    break;
  case 'structured_retries':
    out({ ...baseResult, subtype: 'error_max_structured_output_retries', is_error: true, terminal_reason: 'structured_output_retry_exhausted', errors: ['Failed to provide valid structured output after 5 attempts'] });
    process.exit(1);
    break;
  case 'transient':
    out({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 4, retry_delay_ms: 500, error_status: 529, error: 'overloaded', session_id: sessionId });
    out({ ...baseResult, subtype: 'success', is_error: true, api_error_status: 529, terminal_reason: 'api_error', result: 'API Error: 529 overloaded' });
    process.exit(1);
    break;
  case 'malformed':
    process.stdout.write('{"type":"result","subtype":"succ\n');
    process.exit(1);
    break;
  case 'no_result':
    process.exit(step.exitCode ?? 0);
    break;
  default:
    process.stderr.write(`fake-claude: unknown outcome ${step.outcome}\n`);
    process.exit(1);
}

function resolveModel(m) {
  const aliases = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-4-5-20251001', fable: 'claude-fable-5-1' };
  if (!m) return 'claude-opus-5-5';
  return aliases[m] ?? m;
}

/** The scenario's installed plugins: [{ id: "name@marketplace", scope, enabled? }]. */
function scenarioPlugins() {
  try {
    const s = env.ORBIT_FAKE_SCENARIO ? JSON.parse(readFileSync(env.ORBIT_FAKE_SCENARIO, 'utf8')) : {};
    return Array.isArray(s.plugins) ? s.plugins : [];
  } catch {
    return [];
  }
}

/**
 * system/init's plugins, as the real CLI lists them ({name, path, source}, no scope): a built-in, plus every enabled
 * scenario plugin the session would load. `--setting-sources ""` leaves out user, project and local plugins; managed
 * ones load whatever the setting sources. Without scenario plugins the key is left out, as before.
 */
function initPlugins() {
  const installed = scenarioPlugins();
  if (installed.length === 0) return {};
  const noSources = flagValue(argv, '--setting-sources') === '';
  const loaded = installed.filter((p) => p.enabled !== false && !(noSources && ['user', 'project', 'local'].includes(p.scope)));
  return {
    plugins: [
      { name: 'cc-plugin-agents-md', path: '/opt/claude/builtin/agents-md', source: 'cc-plugin-agents-md@builtin' },
      ...loaded.map((p) => ({ name: p.id.split('@')[0], path: `/opt/acme/plugins/${p.id.replace('@', '/')}`, source: p.id })),
    ],
  };
}

function scenarioAuth() {
  try {
    const s = env.ORBIT_FAKE_SCENARIO ? JSON.parse(readFileSync(env.ORBIT_FAKE_SCENARIO, 'utf8')) : {};
    return { loggedIn: true, authMethod: 'api_key', ...(s.auth ?? {}) };
  } catch {
    return { loggedIn: true, authMethod: 'api_key' };
  }
}
