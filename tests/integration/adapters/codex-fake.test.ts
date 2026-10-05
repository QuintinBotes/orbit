import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter } from '../../../src/adapters/codex.ts';
import { FakeAdapter } from '../../../src/adapters/fake.ts';
import { createAdapter, createAdapters, providerKind } from '../../../src/adapters/index.ts';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import { readExitRecord } from '../../../src/adapters/shim.ts';
import { archiveAttempt } from '../../../src/adapters/supervise.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';
import type { TaskSpec } from '../../../src/adapters/types.ts';
import { FAKE_CLAUDE, FAKE_CODEX, IMPLEMENTER_OUTPUT, REVIEW_OUTPUT, implementerSpec, makeFixture, waitFor, writeScenario, type Fixture } from './helpers.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f.base, { recursive: true, force: true });
});

function fixture(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}

function reviewSpec(f: Fixture, over: Partial<TaskSpec> = {}): TaskSpec {
  return { ...implementerSpec(f), role: 'reviewer', model: 'gpt-6-astra', effort: 'high', readOnly: true, outputSchema: MODEL_OUTPUT_SCHEMAS.review, prompt: 'Review candidate abc123.', systemPrompt: 'You are the reviewer.', ...over };
}

function codex(f: Fixture, env: Record<string, string> = {}) {
  return new FakeAdapter({ provider: 'codex', script: FAKE_CODEX, graceMs: 300, baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: f.scenarioPath, ORBIT_FAKE_ARGV_LOG: f.argvLog, GH_TOKEN: 'ghp_nope', ...env } });
}

async function run(a: FakeAdapter, spec: TaskSpec) {
  const handle = await a.startTask(spec);
  return { handle, result: await waitFor(() => a.collectResult(handle, spec), 30_000) };
}

describe.skipIf(!canStripTypes)('CodexAdapter + shim + fake-codex', () => {
  it('runs a read-only review: verified flags, prompt on stdin, output validated with Orbit\'s schema copy', async () => {
    const f = fixture();
    writeScenario(f, { roles: { reviewer: [{ structured: REVIEW_OUTPUT }] } });
    const a = codex(f);
    const { handle, result } = await run(a, reviewSpec(f));
    expect(result.status).toBe('succeeded');
    expect(result.structured).toEqual(REVIEW_OUTPUT);
    expect(result.usage).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', inputTokens: 1234, outputTokens: 56, cacheReadTokens: 1000, costUsd: null, costSource: 'unavailable' });
    const call = JSON.parse(readFileSync(f.argvLog, 'utf8').trim()) as { argv: string[]; envKeys: string[]; promptBytes: number; role: string };
    expect(call.role).toBe('reviewer');
    expect(call.argv).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--json', '-m', 'gpt-6-astra', '-']));
    expect(call.envKeys).not.toContain('GH_TOKEN');
    expect(call.promptBytes).toBe('You are the reviewer.\n\nReview candidate abc123.'.length);
    expect(existsSync(join(f.workerDir, 'last-message.json'))).toBe(true);
    expect((await a.streamEvents(handle, 0)).events.at(-1)?.type).toBe('finished');
    expect(await a.reportUsage(handle)).toMatchObject({ inputTokens: 1234 });
  });

  it('resolves $CANDIDATE in the scenario from the prompt, so a static scenario can echo the revision under review', async () => {
    const f = fixture();
    writeScenario(f, { roles: { reviewer: [{ structured: { ...REVIEW_OUTPUT, candidate_revision: '$CANDIDATE' } }] } });
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const { result } = await run(codex(f), reviewSpec(f, { prompt: `Review candidate.\n- revision: ${sha}\n` }));
    expect(result.status).toBe('succeeded');
    expect((result.structured as { candidate_revision: string }).candidate_revision).toBe(sha);
  });

  it('records the shim pid and start time in launch.json at spawn time and marks the worker environment', async () => {
    const f = fixture();
    writeScenario(f, { roles: { reviewer: [{ sleepMs: 1500, structured: REVIEW_OUTPUT }] } });
    const a = codex(f);
    const spec = reviewSpec(f);
    const handle = await a.startTask(spec);
    const launch = JSON.parse(readFileSync(join(f.workerDir, 'launch.json'), 'utf8')) as { pid?: number; procStart?: string | null; workerId: string };
    expect(launch.pid).toBe(handle.pid);
    expect(launch.procStart ?? null).toBe(handle.procStart);
    expect(typeof launch.pid).toBe('number');
    expect((await waitFor(() => a.collectResult(handle, spec), 30_000)).status).toBe('succeeded');
    const call = JSON.parse(readFileSync(f.argvLog, 'utf8').trim()) as { envKeys: string[] };
    expect(call.envKeys).toContain('ORBIT_WORKER');
  });

  it('classifies invalid JSON at exit 0 as malformed, an auth failure as auth_failed, and SIGINT as cancelled', async () => {
    const f = fixture();
    const a = codex(f);
    writeScenario(f, { roles: { '*': [{ outcome: 'malformed' }] } });
    expect((await run(a, reviewSpec(f))).result).toMatchObject({ status: 'malformed_output', reason: 'invalid_json', exitCode: 0 });

    archiveAttempt('codex', f.workerDir);
    writeScenario(f, { roles: { '*': [{ outcome: 'auth_failure' }] } });
    expect((await run(a, reviewSpec(f))).result.status).toBe('auth_failed');

    archiveAttempt('codex', f.workerDir);
    writeScenario(f, { roles: { '*': [{ sleepMs: 30_000, structured: REVIEW_OUTPUT }] } });
    const handle = await a.startTask(reviewSpec(f));
    await a.cancelTask(handle);
    const result = await waitFor(() => a.collectResult(handle, reviewSpec(f)), 30_000);
    expect(result.status).toBe('cancelled');
    expect(result.usage.inputTokens).toBeNull();
    expect(readExitRecord(f.workerDir)).toMatchObject({ code: 1, cancelled: true });
  });

  it('verifies the policy hash it is given instead of deriving one, and derives it only when absent', async () => {
    const f = fixture();
    writeScenario(f, { roles: { reviewer: [{ structured: REVIEW_OUTPUT }] } });
    const a = codex(f);
    await expect(a.startTask(reviewSpec(f, { policyHash: `sha256:${'0'.repeat(64)}` }))).rejects.toMatchObject({ code: 'POLICY_TAMPERED' });
    expect(existsSync(join(f.workerDir, 'launch.json'))).toBe(false);
    const { result } = await run(a, reviewSpec(f, { policyHash: undefined }));
    expect(result.status).toBe('succeeded');
  });

  it('refuses writer tasks and implicit models', async () => {
    const f = fixture();
    const a = codex(f);
    await expect(a.startTask(reviewSpec(f, { readOnly: false }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(a.startTask(reviewSpec(f, { model: null }))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(a.startTask(reviewSpec(f, { effort: 'ultra' }))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('discovers capabilities from --version, exec --help and debug models', async () => {
    const f = fixture();
    writeScenario(f, {});
    const caps = await codex(f).discoverCapabilities();
    expect(caps).toMatchObject({ available: true, version: '0.153.4', models: ['gpt-6-astra'], structuredOutput: true, readOnlySandbox: true, usageReporting: 'partial', costReporting: false });
  });

  it('validates credentials with login status and doctor, and skips login status for CODEX_API_KEY', async () => {
    const f = fixture();
    writeScenario(f, { auth: { loggedIn: true, method: 'chatgpt', valid: true } });
    expect(await codex(f).validateCredentials()).toMatchObject({ state: 'valid', method: 'chatgpt' });
    writeScenario(f, { auth: { loggedIn: false } });
    expect(await codex(f).validateCredentials()).toMatchObject({ state: 'missing' });
    expect(await codex(f, { CODEX_API_KEY: 'sk-fake' }).validateCredentials()).toMatchObject({ state: 'valid', method: 'api_key_env' });
    writeScenario(f, { auth: { loggedIn: true, valid: false } });
    expect((await codex(f).validateCredentials()).state).toBe('invalid');
  });
});

describe.skipIf(!canStripTypes)('ClaudeAdapter probes against fake-claude', () => {
  it('reports a present credential as unverified, and a missing one as missing', async () => {
    const f = fixture();
    writeScenario(f, { auth: { loggedIn: true, authMethod: 'claude.ai' } });
    const a = new FakeAdapter({ provider: 'claude', script: FAKE_CLAUDE, baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: f.scenarioPath } });
    const present = await a.validateCredentials();
    expect(present).toMatchObject({ state: 'unknown', method: 'claude.ai' });
    expect(present.detail).toMatch(/cannot detect an expired/);
    expect(present.detail).toMatch(/claude-sandbox tier/);
    writeScenario(f, { auth: { loggedIn: false } });
    expect((await a.validateCredentials()).state).toBe('missing');
    expect(await a.discoverCapabilities()).toMatchObject({ available: true, version: '2.1.288' });
  });

  it('probeCredentials is a separate opt-in live check', async () => {
    const f = fixture();
    const a = new ClaudeAdapter({ command: [process.execPath, FAKE_CLAUDE], passEnv: ['ORBIT_FAKE_SCENARIO'], baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: f.scenarioPath } });
    writeScenario(f, { roles: { '*': [{ outcome: 'auth_failure' }] } });
    expect((await a.probeCredentials()).state).toBe('invalid');
    writeScenario(f, { roles: { '*': [{ structured: {} }] } });
    expect((await a.probeCredentials()).state).toBe('valid');
  });

  it('probeCredentials runs from an empty directory with CLAUDE.md loading off, so no repository text reaches the API', async () => {
    const f = fixture();
    const a = new ClaudeAdapter({
      command: [process.execPath, FAKE_CLAUDE],
      passEnv: ['ORBIT_FAKE_SCENARIO', 'ORBIT_FAKE_ARGV_LOG'],
      baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: f.scenarioPath, ORBIT_FAKE_ARGV_LOG: f.argvLog, GH_TOKEN: 'ghp_nope' },
    });
    writeScenario(f, { roles: { '*': [{ structured: {} }] } });
    expect((await a.probeCredentials()).state).toBe('valid');
    const call = JSON.parse(readFileSync(f.argvLog, 'utf8').trim().split('\n')[0]!) as { cwd: string; envKeys: string[] };
    expect(call.cwd).not.toBe(process.cwd());
    expect(call.cwd).toMatch(/orbit-probe-/);
    expect(existsSync(call.cwd)).toBe(false);
    expect(call.envKeys).toContain('CLAUDE_CODE_DISABLE_CLAUDE_MDS');
    expect(call.envKeys).not.toContain('GH_TOKEN');
  });
});

describe('adapter registry', () => {
  const cfg = (command: string, extra_args: string[] = []) => ({ command, data_policy_eligible: true, model: null, reasoning_effort: null, extra_args });

  it('returns real adapters for real commands and fakes for the fake scripts', () => {
    expect(createAdapter('claude', cfg('claude'))).toBeInstanceOf(ClaudeAdapter);
    expect(createAdapter('codex', cfg('/usr/local/bin/codex'))).toBeInstanceOf(CodexAdapter);
    const fake = createAdapter('claude', cfg(FAKE_CLAUDE));
    expect(fake).toBeInstanceOf(FakeAdapter);
    expect((fake as FakeAdapter).inner).toBeInstanceOf(ClaudeAdapter);
    expect((createAdapter('codex-review', cfg(FAKE_CODEX)) as FakeAdapter).provider).toBe('codex');
    expect(Object.keys(createAdapters({ providers: { claude: cfg('claude'), codex: cfg('codex') } }))).toEqual(['claude', 'codex']);
  });

  it('rejects unknown providers, mismatched fakes and unsafe extra args', () => {
    expect(() => providerKind('gemini')).toThrow(/unknown provider/);
    expect(() => createAdapter('claude', cfg(FAKE_CODEX))).toThrow(/codex fake/);
    expect(() => createAdapter('claude', cfg('claude', ['--dangerously-skip-permissions']))).toThrow(/not allowed/);
    expect(() => createAdapter('codex', cfg('codex', ['--yolo']))).toThrow(/not allowed/);
  });

  it('runs a fake implementer through the registry exactly like the real adapter', async () => {
    if (!canStripTypes) return;
    const f = fixture();
    writeScenario(f, { roles: { implementer: [{ structured: IMPLEMENTER_OUTPUT }] } });
    const a = createAdapter('claude', cfg(FAKE_CLAUDE), { baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: f.scenarioPath }, claudeTier: 'claude-sandbox' });
    const spec = { ...implementerSpec(f), env: {} };
    const handle = await a.startTask(spec);
    expect((await waitFor(() => a.collectResult(handle, spec), 30_000)).status).toBe('succeeded');
  });
});
