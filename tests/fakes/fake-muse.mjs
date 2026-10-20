#!/usr/bin/env node
// Scenario-driven stand-in for the `muse` CLI (1.4.11 surface, from
// docs/interfaces/muse.md). Accepts the argv Orbit's MuseAdapter builds and
// answers with `--json` JSONL envelopes. See README.md for the scenario format.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { attemptWrite, flagValue, loadStep, logArgv, renderPlaceholders, roleFromSchema, sleep, spawnGrandchild } from './scenario.mjs';

const argv = process.argv.slice(2);
const env = process.env;

let sequence = 0;
const out = (payloadType, payload) => {
  const envelope = {
    schema_version: 1,
    id: randomUUID(),
    stream: 'run',
    sequence: sequence++,
    recorded_at: new Date().toISOString(),
    record_type: 'event',
    durability: 'ephemeral',
    causation_id: null,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
};

const HELP = `Run Muse non-interactively

Usage: muse exec [OPTIONS] [PROMPT]

Options:
      --model <MODEL>
      --reasoning-effort <EFFORT>
      --workspace <DIR>
      --permission-profile <PROFILE>
      --disable-request-user-input
      --disable-write
      --disable-shell
      --no-foreign-personal-context
      --disable-web-tools
      --no-session-log
      --json
      --output-schema <FILE>
      --max-model-steps <N>
      --prompt-file <FILE>
  -h, --help
`;

if (argv[0] === '--version') {
  const v = env.ORBIT_FAKE_MUSE_VERSION ?? '1.4.11';
  process.stdout.write(`Muse Code ${v} (${v}-R6667.1)\n`);
  process.exit(0);
}
const scenarioTop = (() => {
  try {
    return env.ORBIT_FAKE_SCENARIO ? JSON.parse(readFileSync(env.ORBIT_FAKE_SCENARIO, 'utf8')) : {};
  } catch {
    return {};
  }
})();
const auth = { loggedIn: true, ...(scenarioTop.auth ?? {}) };

if (argv[0] !== 'exec') {
  process.stderr.write('fake-muse: unsupported command\n');
  process.exit(2);
}
if (argv[1] === '--help') {
  process.stdout.write(HELP);
  process.exit(0);
}
for (const bad of ['--yolo', '--disable-sandbox', '--disable-approval', '--trust-workspace']) {
  if (argv.includes(bad) || argv.some((a) => a.startsWith(`${bad}=`))) {
    process.stderr.write(`error: unexpected argument '${bad}' found\n`);
    process.exit(2);
  }
}

const workspace = flagValue(argv, '--workspace') ?? process.cwd();
const model = flagValue(argv, '--model') ?? 'muse-wonder-full-1.0';
const promptFile = flagValue(argv, '--prompt-file');
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
let prompt = '';
if (promptFile) {
  try {
    prompt = readFileSync(promptFile, 'utf8');
  } catch (err) {
    process.stderr.write(`Failed to read prompt file ${promptFile}: ${err.code ?? err.message}\n`);
    process.exit(1);
  }
} else {
  // The credential check: no prompt file, the prompt is the last argument.
  prompt = argv.at(-1) ?? '';
}
const role = roleFromSchema(schema);

const missingCredentials = () => {
  const where = env.XDG_CONFIG_HOME ? `${env.XDG_CONFIG_HOME}/muse/auth.json` : '~/.config/muse/auth.json';
  process.stderr.write(`missing meta credentials: run \`muse login\` or set META_API_KEY, or save credentials at ${where}\n`);
  process.exit(1);
};

if (!promptFile) {
  // The adapter's one-step credential check. It consumes no scenario step: it
  // answers ok, or reports the missing login the way Muse 1.4.11 does.
  logArgv(env, { tool: 'muse', role, call: 0, argv, envKeys: Object.keys(env).sort(), cwd: workspace, promptBytes: prompt.length });
  // META_API_KEY wins over the login file, as with the real CLI.
  if (auth.loggedIn === false && !env.META_API_KEY) missingCredentials();
  out('runtime.command.accepted', {});
  out('run.lifecycle.started', {});
  out('run.model.configured', { model_id: model });
  out('run.usage', { models: [{ model_id: model, input_tokens: 10, cached_tokens: 0, output_tokens: 1, reasoning_tokens: 0, calls: 1 }] });
  out('run.terminal.completed', { text: 'ok', reason: null });
  process.exit(0);
}

const loaded = loadStep(role, env);
const call = loaded.call;
const step = renderPlaceholders(loaded.step, prompt);
logArgv(env, { tool: 'muse', role, call, argv, envKeys: Object.keys(env).sort(), cwd: workspace, promptBytes: prompt.length });

process.on('SIGINT', () => {
  if (step.ignoreSignals) return;
  process.exit(1);
});
process.on('SIGTERM', () => {
  if (step.ignoreSignals) return;
  process.exit(143);
});

if ((auth.loggedIn === false && !env.META_API_KEY) || step.missingCredentials || step.outcome === 'missing_credentials' || step.outcome === 'auth_failure') missingCredentials();
if (step.exitBeforeOutput) process.exit(step.exitCode ?? 1);

let grandchild = null;
if (step.grandchildPidFile) grandchild = spawnGrandchild(step.grandchildPidFile);

out('runtime.command.accepted', {});
out('session.run.linked', {});
out('run.lifecycle.started', {});
out('run.model.configured', { model_id: model });
out('turn.input.user', {});

const writeSpec = step.forbiddenWrite ?? step.attemptWrite;
if (writeSpec) {
  const r = attemptWrite(workspace, writeSpec);
  out('tool.result', { correlation_facts: { tool_name: 'Write' }, text: r.written ? `wrote ${r.path}` : `denied: ${r.error}` });
}
// A review that answers from the packet alone (no tool call) is a step with inspect: false.
if (step.inspect !== false) out('tool.result', { correlation_facts: { tool_name: 'Read' }, text: 'read the checkout' });

if (step.sleepMs) await sleep(step.sleepMs);
if (grandchild) grandchild.unref();

const usageModel = { model_id: model, input_tokens: 1234, cached_tokens: 1000, output_tokens: 56, reasoning_tokens: 7, calls: 1, ...(step.usage ?? {}) };

if (step.outcome === 'no_result') process.exit(step.exitCode ?? 1);
if (step.failReason !== undefined || step.outcome === 'run_failed' || step.outcome === 'step_cap') {
  out('run.usage', { models: [usageModel] });
  const reason = step.failReason ?? (step.outcome === 'step_cap' ? 'model did not reach a terminal state within 200 step(s)' : 'run failed');
  out('run.terminal.failed', { text: '', reason });
  process.exit(step.exitCode ?? 1);
}

out('run.usage', { models: [usageModel] });
const text = step.outcome === 'malformed' ? 'not json at all' : (step.text ?? JSON.stringify(step.structured ?? {}));
out('run.terminal.completed', { text, reason: null });
process.exit(step.exitCode ?? 0);
