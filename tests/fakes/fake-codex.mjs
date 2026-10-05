#!/usr/bin/env node
// Scenario-driven stand-in for the `codex` CLI (0.153.4 surface, from
// docs/interfaces/codex-cli.md). Accepts the argv Orbit's CodexAdapter builds
// and answers with `--json` JSONL events. See README.md for the scenario format.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { applyEdits, attemptWrite, flagValue, loadStep, logArgv, readStdin, renderPlaceholders, roleFromSchema, sleep } from './scenario.mjs';

const argv = process.argv.slice(2);
const env = process.env;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const HELP = `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT] [COMMAND]

Options:
  -c, --config <key=value>
      --enable <FEATURE>
      --disable <FEATURE>
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
      --dangerously-bypass-approvals-and-sandbox
  -C, --cd <DIR>
      --skip-git-repo-check
      --ephemeral
      --ignore-user-config
      --output-schema <FILE>
      --json
  -o, --output-last-message <FILE>
  -h, --help
`;

if (argv[0] === '--version') {
  process.stdout.write(`codex-cli ${env.ORBIT_FAKE_CODEX_VERSION ?? '0.153.4'}\n`);
  process.exit(0);
}
const scenarioTop = (() => {
  try {
    return env.ORBIT_FAKE_SCENARIO ? JSON.parse(readFileSync(env.ORBIT_FAKE_SCENARIO, 'utf8')) : {};
  } catch {
    return {};
  }
})();
const auth = { loggedIn: true, method: 'api_key', valid: true, ...(scenarioTop.auth ?? {}) };

if (argv[0] === 'login' && argv[1] === 'status') {
  if (!auth.loggedIn) {
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  process.stderr.write(auth.method === 'chatgpt' ? 'Logged in using ChatGPT\n' : 'Logged in using an API key - sk-fake-***00000\n');
  process.exit(0);
}
if (argv[0] === 'doctor') {
  // exec and doctor use CODEX_API_KEY even though login status does not see it.
  const present = auth.loggedIn || Boolean(env.CODEX_API_KEY);
  const ok = present && auth.valid;
  out({ checks: { 'auth.credentials': { status: present && auth.valid !== false ? 'ok' : 'fail', details: {} }, 'network.websocket_reachability': { status: ok ? 'ok' : 'fail', details: {} } } });
  process.exit(ok ? 0 : 1);
}
if (argv[0] === 'debug' && argv[1] === 'models') {
  out({ models: [{ slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], visibility: 'list', priority: 1 }, { slug: 'codex-auto-review', visibility: 'hide', supported_reasoning_levels: [] }] });
  process.exit(0);
}
if (argv[0] !== 'exec') {
  process.stderr.write('fake-codex: unsupported command\n');
  process.exit(2);
}
if (argv[1] === '--help') {
  process.stdout.write(HELP);
  process.exit(0);
}
for (const bad of ['--full-auto', '-a', '--ask-for-approval', '--yolo']) {
  if (argv.includes(bad)) {
    process.stderr.write(`error: unexpected argument '${bad}' found\n`);
    process.exit(2);
  }
}

const schemaPath = flagValue(argv, '--output-schema');
let schema = null;
if (schemaPath) {
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`Failed to read output schema file ${schemaPath}: ${err.code ?? err.message}\n`);
    process.exit(1);
  }
}
const role = roleFromSchema(schema);
const loaded = loadStep(role, env);
const call = loaded.call;
const lastMessage = flagValue(argv, '-o') ?? flagValue(argv, '--output-last-message');
const cwd = flagValue(argv, '-C') ?? flagValue(argv, '--cd') ?? process.cwd();
process.stderr.write('Reading additional input from stdin...\n');
const prompt = argv.at(-1) === '-' ? readStdin() : '';
if (argv.at(-1) === '-' && prompt.trim() === '') {
  process.stderr.write('No prompt provided via stdin.\n');
  process.exit(1);
}
const step = renderPlaceholders(loaded.step, prompt);
logArgv(env, { tool: 'codex', role, call, argv, envKeys: Object.keys(env).sort(), cwd, promptBytes: prompt.length });

process.on('SIGINT', () => {
  if (step.ignoreSignals) return;
  // Verified: SIGINT interrupts the turn, exit 1, no terminal event.
  process.exit(1);
});

out({ type: 'thread.started', thread_id: randomUUID() });
out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `fake` not found. Defaulting to fallback metadata.' } });
out({ type: 'turn.started' });
for (const [i, e] of (step.edits ?? []).entries()) {
  applyEdits(cwd, [e]);
  out({ type: 'item.completed', item: { id: `item_e${i}`, type: 'file_change', changes: [{ path: e.path, kind: 'update' }], status: 'completed' } });
}
if (step.forbiddenWrite) {
  const r = attemptWrite(cwd, step.forbiddenWrite);
  out({ type: 'item.completed', item: { id: 'item_fw', type: 'command_execution', command: `echo x > ${r.path}`, aggregated_output: r.written ? '' : r.error, exit_code: r.written ? 0 : 1, status: r.written ? 'completed' : 'failed' } });
}
out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "git diff --stat"', aggregated_output: '', exit_code: 0, status: 'completed' } });
if (step.sleepMs) await sleep(step.sleepMs);

const usage = { input_tokens: 1234, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 56, reasoning_output_tokens: 7, ...(step.usage ?? {}) };
const finish = (text) => {
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text } });
  out({ type: 'turn.completed', usage });
  if (lastMessage) writeFileSync(lastMessage, text);
  process.exit(0);
};

switch (step.outcome ?? 'success') {
  case 'success':
    finish(`${JSON.stringify(step.structured ?? {})}\n`);
    break;
  case 'malformed':
    finish('not json at all');
    break;
  case 'auth_failure':
    out({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 Unauthorized: Incorrect API key provided)' });
    out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-fake***. url: https://api.openai.com/v1/responses, auth error: 401, auth error code: invalid_api_key' } });
    process.exit(1);
    break;
  case 'transient':
    out({ type: 'turn.failed', error: { message: '{"type":"error","status":503,"error":{"type":"server_error","message":"overloaded"}}' } });
    process.exit(1);
    break;
  case 'model_rejected':
    out({ type: 'turn.failed', error: { message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported."}}' } });
    process.exit(1);
    break;
  case 'no_result':
    process.exit(step.exitCode ?? 1);
    break;
  default:
    process.stderr.write(`fake-codex: unknown outcome ${step.outcome}\n`);
    process.exit(1);
}
