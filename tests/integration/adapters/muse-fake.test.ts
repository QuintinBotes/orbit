import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { cleanupCandidateCheckout, materializeCandidate } from '../../../src/evidence/candidate.ts';
import { join } from 'node:path';
import { FakeAdapter } from '../../../src/adapters/fake.ts';
import { createAdapter } from '../../../src/adapters/index.ts';
import { MUSE_FORBIDDEN_ARGS, MUSE_REQUIRED_FLAGS, MuseAdapter } from '../../../src/adapters/muse.ts';
import { readExitRecord } from '../../../src/adapters/shim.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';
import type { ProviderAdapter, TaskSpec } from '../../../src/adapters/types.ts';
import type { ProviderConfig } from '../../../src/policy/types.ts';
import { FAKES, REVIEW_OUTPUT, alive, implementerSpec, makeFixture, waitFor, writeScenario, type Fixture } from './helpers.ts';

const FAKE_MUSE = join(FAKES, 'fake-muse.mjs');
const MODEL = 'muse-wonder-full-1.0';
const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
type ReviewFixture = Fixture & { checkout: string };
const fixtures: ReviewFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    // The review checkout is write-protected; cleanupCandidateCheckout makes it removable again, as a run does.
    await cleanupCandidateCheckout(f.repo, f.checkout).catch(() => {});
    rmSync(f.base, { recursive: true, force: true });
  }
});

/**
 * The review checkout exactly as a run makes it (evidence/candidate.ts materializeCandidate, reviewing.ts
 * prepareReview): a detached worktree of the commit, write-protected throughout when `writeProtected`.
 */
async function fixture(writeProtected = true): Promise<ReviewFixture> {
  const f = makeFixture();
  const checkout = join(f.base, 'review-1');
  await materializeCandidate(f.repo, 'HEAD', checkout, { readOnly: writeProtected });
  const rf = { ...f, checkout };
  fixtures.push(rf);
  return rf;
}

function reviewSpec(f: ReviewFixture, over: Partial<TaskSpec> = {}): TaskSpec {
  return { ...implementerSpec(f), cwd: f.checkout, role: 'reviewer', model: MODEL, effort: 'high', readOnly: true, outputSchema: MODEL_OUTPUT_SCHEMAS.review, prompt: 'Review candidate abc123.', systemPrompt: 'You are the reviewer.', ...over };
}

function baseEnv(f: Fixture, env: Record<string, string> = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: f.scenarioPath, ORBIT_FAKE_ARGV_LOG: f.argvLog, GH_TOKEN: 'ghp_nope', MUSE_PERMISSION_PROFILE_FAIL_OPEN: '1', ...env };
}

/** The Muse reviewer as a run builds it: through the registry, which points the real adapter at the fake. */
function muse(f: Fixture, env: Record<string, string> = {}): ProviderAdapter {
  const config: ProviderConfig = { command: FAKE_MUSE, data_policy_eligible: true, model: MODEL, reasoning_effort: 'high', extra_args: [], tier: 'muse-sandbox' };
  return createAdapter('muse', config, { graceMs: 300, baseEnv: baseEnv(f, env) });
}

async function run(a: ProviderAdapter, spec: TaskSpec) {
  const handle = await a.startTask(spec);
  return { handle, result: await waitFor(() => a.collectResult(handle, spec), 30_000) };
}

function argvCalls(f: Fixture): { argv: string[]; envKeys: string[]; role: string; cwd: string }[] {
  return readFileSync(f.argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

describe.skipIf(!canStripTypes)('MuseAdapter + shim + fake-muse', () => {
  it('runs a read-only review: fixed flags, prompt in a file, output validated with Orbit\'s schema copy', async () => {
    const f = await fixture();
    writeScenario(f, { roles: { reviewer: [{ structured: REVIEW_OUTPUT }] } });
    const a = muse(f);
    expect(a).toBeInstanceOf(FakeAdapter);
    expect((a as FakeAdapter).inner).toBeInstanceOf(MuseAdapter);
    const { handle, result } = await run(a, reviewSpec(f));
    expect(result.status).toBe('succeeded');
    expect(result.structured).toEqual(REVIEW_OUTPUT);
    expect(result.usage).toMatchObject({ provider: 'muse', model: MODEL, inputTokens: 1234, outputTokens: 56, cacheReadTokens: 1000, costUsd: null, costSource: 'unavailable' });

    const call = argvCalls(f).at(-1)!;
    expect(call.role).toBe('reviewer');
    expect(call.cwd).toBe(f.checkout);
    for (const flag of MUSE_REQUIRED_FLAGS) expect(call.argv, flag).toContain(flag);
    const value = (flag: string) => call.argv[call.argv.indexOf(flag) + 1];
    expect(value('--model')).toBe(MODEL);
    expect(value('--reasoning-effort')).toBe('high');
    expect(value('--workspace')).toBe(f.checkout);
    expect(value('--permission-profile')).toBe(':read-only');
    expect(value('--max-model-steps')).toBe('200');
    expect(value('--prompt-file')).toBe(join(f.workerDir, 'prompt.md'));
    expect(value('--output-schema')).toBe(join(f.workerDir, 'schema.json'));
    for (const bad of MUSE_FORBIDDEN_ARGS) expect(call.argv, bad).not.toContain(bad);
    expect(call.argv).not.toContain('--approval-mode');
    expect(call.argv.some((x) => x.includes(':unrestricted'))).toBe(false);
    expect(call.envKeys).toContain('MUSE_NO_AUTO_UPDATE');
    expect(call.envKeys).not.toContain('GH_TOKEN');
    expect(call.envKeys).not.toContain('MUSE_PERMISSION_PROFILE_FAIL_OPEN');
    // No stdin prompt: the packet is the prompt file in the worker directory.
    expect(readFileSync(join(f.workerDir, 'prompt.md'), 'utf8')).toContain('Review candidate abc123.');
    // The worker record names the reviewer, its model and its tier, with the tier's limitations.
    const launch = JSON.parse(readFileSync(join(f.workerDir, 'launch.json'), 'utf8')) as { provider: string; meta: { tier: string; model: string; limitations: string[] } };
    expect(launch.provider).toBe('muse');
    expect(launch.meta).toMatchObject({ tier: 'muse-sandbox', model: MODEL });
    expect(launch.meta.limitations.join('\n')).toMatch(/Reads are unrestricted/);
    expect((await a.streamEvents(handle, 0)).events.at(-1)?.type).toBe('finished');
    expect(await a.reportUsage(handle)).toMatchObject({ inputTokens: 1234 });
  });

  it('classifies output that does not match the review schema as malformed, never as a verdict', async () => {
    const f = await fixture();
    writeScenario(f, { roles: { reviewer: [{ text: '{"verdict":"MAYBE","findings":[]}' }] } });
    const { result } = await run(muse(f), reviewSpec(f));
    expect(result).toMatchObject({ status: 'malformed_output', reason: 'schema_mismatch', structured: null, exitCode: 0 });
  });

  it('hangs only until the wall-clock cap: status timeout, and the whole process group is killed', async () => {
    const f = await fixture();
    const gc = join(f.base, 'grandchild.pid');
    writeScenario(f, { roles: { reviewer: [{ sleepMs: 60_000, ignoreSignals: true, grandchildPidFile: gc, structured: REVIEW_OUTPUT }] } });
    const a = muse(f);
    const spec = reviewSpec(f, { timeoutMs: 800 });
    const handle = await a.startTask(spec);
    const grandchild = Number(await waitFor(() => (existsSync(gc) ? readFileSync(gc, 'utf8') || null : null), 30_000));
    expect(alive(grandchild)).toBe(true);
    const result = await waitFor(() => a.collectResult(handle, spec), 30_000);
    expect(result).toMatchObject({ status: 'timeout', reason: 'timeout', structured: null });
    expect(readExitRecord(f.workerDir)).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    await waitFor(() => !alive(grandchild) || null, 5_000);
  });

  it('records a non-zero exit as a failed review with the run\'s reason', async () => {
    const f = await fixture();
    writeScenario(f, { roles: { reviewer: [{ failReason: 'the provider exploded', exitCode: 1 }] } });
    const { result } = await run(muse(f), reviewSpec(f));
    expect(result).toMatchObject({ status: 'failed', reason: 'run_failed', structured: null, exitCode: 1 });
    expect(result.error).toContain('the provider exploded');
  });

  it('records a step cap as its own failure reason', async () => {
    const f = await fixture();
    writeScenario(f, { roles: { reviewer: [{ failReason: 'model did not reach a terminal state within 200 step(s)', exitCode: 1 }] } });
    const { result } = await run(muse(f), reviewSpec(f));
    expect(result).toMatchObject({ status: 'failed', reason: 'step_cap', exitCode: 1 });
  });

  // The model may try any write; the write-protected checkout, not Muse's settings, is what refuses each one.
  it.each([
    ['a new file at the root', 'pwned.txt'],
    ['an existing file', 'apps/a.ts'],
    ['a new file in a subdirectory', 'apps/x.ts'],
  ])('an attempted write into the write-protected checkout is denied: %s', async (_what, path) => {
    const f = await fixture();
    const before = existsSync(join(f.checkout, path)) ? readFileSync(join(f.checkout, path), 'utf8') : null;
    writeScenario(f, { roles: { reviewer: [{ forbiddenWrite: { path, content: 'pwned' }, structured: REVIEW_OUTPUT }] } });
    const { handle, result } = await run(muse(f), reviewSpec(f));
    expect(result.status).toBe('succeeded');
    expect(existsSync(join(f.checkout, path)) ? readFileSync(join(f.checkout, path), 'utf8') : null).toBe(before);
    expect(readFileSync(handle.logPath, 'utf8')).toContain('denied:');
  });

  it('refuses a checkout whose root is write-protected but a file below it is not', async () => {
    const f = await fixture();
    chmodSync(join(f.checkout, 'apps'), 0o755);
    chmodSync(join(f.checkout, 'apps', 'a.ts'), 0o644);
    chmodSync(join(f.checkout, 'apps'), 0o555);
    writeScenario(f, { roles: { reviewer: [{ structured: REVIEW_OUTPUT }] } });
    await expect(muse(f).startTask(reviewSpec(f))).rejects.toThrow(/apps\/a\.ts is writable/);
    expect(existsSync(join(f.workerDir, 'launch.json'))).toBe(false);
  });

  it('refuses a writable checkout in the muse-sandbox tier before anything launches', async () => {
    const f = await fixture(false);
    writeScenario(f, { roles: { reviewer: [{ structured: REVIEW_OUTPUT }] } });
    await expect(muse(f).startTask(reviewSpec(f))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(muse(f).startTask(reviewSpec(f))).rejects.toThrow(/writable checkout/);
    expect(existsSync(join(f.workerDir, 'launch.json'))).toBe(false);
    expect(existsSync(f.argvLog)).toBe(false);
  });

  it('refuses a task that is not read-only, and an implicit or unsupported effort', async () => {
    const f = await fixture();
    const a = muse(f);
    await expect(a.startTask(reviewSpec(f, { readOnly: false }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(a.startTask(reviewSpec(f, { model: null }))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(a.startTask(reviewSpec(f, { effort: 'none' }))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(existsSync(join(f.workerDir, 'launch.json'))).toBe(false);
  });

  it('discovers capabilities from --version and exec --help, and refuses an old Muse', async () => {
    const f = await fixture();
    writeScenario(f, {});
    expect(await muse(f).discoverCapabilities()).toMatchObject({ available: true, version: '1.4.11', structuredOutput: true, readOnlySandbox: true, usageReporting: 'partial', costReporting: false });
    const old = await muse(f, { ORBIT_FAKE_MUSE_VERSION: '1.3.0' }).discoverCapabilities();
    expect(old.available).toBe(false);
    expect(old.detail).toMatch(/older than 1\.4\.11/);
  });

  it('validates credentials with the one-step exec: valid with a login, missing without one', async () => {
    const f = await fixture();
    writeScenario(f, { roles: { reviewer: [{ structured: REVIEW_OUTPUT }] } });
    expect(await muse(f).validateCredentials()).toMatchObject({ state: 'valid' });
    // The check consumed no scenario step: the review that follows still gets step 0.
    expect((await run(muse(f), reviewSpec(f))).result.status).toBe('succeeded');
    writeScenario(f, { auth: { loggedIn: false } });
    expect(await muse(f).validateCredentials()).toMatchObject({ state: 'missing' });
    // META_API_KEY wins over the login file.
    expect(await muse(f, { META_API_KEY: 'meta-key' }).validateCredentials()).toMatchObject({ state: 'valid', method: 'api_key_env' });
  });
});

describe('muse in the adapter registry', () => {
  const cfg = (command: string, over: Partial<ProviderConfig> = {}): ProviderConfig => ({ command, data_policy_eligible: true, model: MODEL, reasoning_effort: 'high', extra_args: [], tier: 'auto', ...over });

  it('returns the real adapter for a real command and the fake-backed one for the fake script', () => {
    expect(createAdapter('muse', cfg('muse'))).toBeInstanceOf(MuseAdapter);
    const fake = createAdapter('muse', cfg(FAKE_MUSE));
    expect(fake).toBeInstanceOf(FakeAdapter);
    expect((fake as FakeAdapter).provider).toBe('muse');
    expect((fake as FakeAdapter).inner).toBeInstanceOf(MuseAdapter);
    expect((createAdapter('muse-review', cfg(FAKE_MUSE)) as FakeAdapter).provider).toBe('muse');
  });

  it('rejects a mismatched fake, a cross-family tier and unsafe extra args', () => {
    expect(() => createAdapter('codex', cfg(FAKE_MUSE))).toThrow(/muse fake/);
    expect(() => createAdapter('muse', cfg('muse', { tier: 'codex-sandbox' }))).toThrow(/codex-sandbox is a Codex tier/);
    expect(() => createAdapter('muse', cfg('muse', { extra_args: ['--yolo'] }))).toThrow(/not allowed/);
  });
});
