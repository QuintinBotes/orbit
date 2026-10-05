import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import type { TaskHandle, TaskSpec } from '../../../src/adapters/types.ts';
import type { IsolationProvider, SandboxProfile } from '../../../src/isolation/types.ts';
import { implementerSpec, makeFixture, type Fixture } from '../../integration/adapters/helpers.ts';

const execMock = vi.hoisted(() => ({ execCapture: vi.fn() }));
const supMock = vi.hoisted(() => ({ launchShim: vi.fn(), reattachLaunch: vi.fn(), cancelShim: vi.fn() }));

vi.mock('../../../src/core/exec.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/core/exec.ts')>()), execCapture: execMock.execCapture }));
vi.mock('../../../src/adapters/supervise.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/adapters/supervise.ts')>()), ...supMock }));

const { ClaudeAdapter, compareVersions, knownEfforts } = await import('../../../src/adapters/claude.ts');
const { CodexAdapter, parseDoctorChecks, parseHelpFlags } = await import('../../../src/adapters/codex.ts');
const { LAUNCH_FILE } = await import('../../../src/adapters/supervise.ts');

const fixtures: Fixture[] = [];
function fixture(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}

function exec(stdout: string, over: Record<string, unknown> = {}) {
  return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, durationMs: 5, ...over };
}

const handleFor = (f: Fixture, over: Partial<TaskHandle> = {}): TaskHandle => ({ provider: 'claude', workerId: 'w1', workerDir: f.workerDir, pid: 4242, pgid: 4242, procStart: null, logPath: join(f.workerDir, 'log.jsonl'), exitPath: join(f.workerDir, 'exit.json'), ...over });

beforeEach(() => {
  execMock.execCapture.mockReset();
  supMock.launchShim.mockReset();
  supMock.reattachLaunch.mockReset();
  supMock.cancelShim.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f.base, { recursive: true, force: true });
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return isOrbitError(err) ? err.code : String(err);
  }
  return 'no error';
}

describe('ClaudeAdapter probes', () => {
  const adapter = (over: Record<string, unknown> = {}) => new ClaudeAdapter({ command: ['claude'], baseEnv: { PATH: '/usr/bin', HOME: '/h', EMPTY: '' }, ...over });

  it('reads the version, and describes a failed, timed-out or unrunnable CLI', async () => {
    execMock.execCapture.mockResolvedValueOnce(exec('2.1.300 (Claude Code)\n'));
    const ok = await adapter({ models: () => ['m1'] }).discoverCapabilities();
    expect(ok).toMatchObject({ available: true, version: '2.1.300', models: ['m1'], detail: 'claude 2.1.300' });
    execMock.execCapture.mockResolvedValueOnce(exec('no version here'));
    expect(await adapter().discoverCapabilities()).toMatchObject({ available: false, version: null, detail: 'claude unknown version' });
    execMock.execCapture.mockResolvedValueOnce(exec('', { exitCode: 1, stderr: 'boom\n' }));
    expect((await adapter().discoverCapabilities()).detail).toBe('claude --version failed: exit 1: boom');
    execMock.execCapture.mockResolvedValueOnce(exec('', { exitCode: null, signal: 'SIGKILL' }));
    expect((await adapter().discoverCapabilities()).detail).toBe('claude --version failed: exit SIGKILL');
    execMock.execCapture.mockResolvedValueOnce(exec('', { timedOut: true, exitCode: null }));
    expect((await adapter().discoverCapabilities()).detail).toBe('claude --version failed: timed out');
    execMock.execCapture.mockRejectedValueOnce(new Error('spawn ENOENT'));
    expect((await adapter().discoverCapabilities()).detail).toBe('claude --version failed: spawn ENOENT');
    execMock.execCapture.mockRejectedValueOnce('weird');
    expect((await adapter().discoverCapabilities()).detail).toBe('claude --version failed: weird');
    expect(execMock.execCapture.mock.calls[0]![1].env).toMatchObject({ PATH: '/usr/bin', HOME: '/h', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    expect(execMock.execCapture.mock.calls[0]![1].env).not.toHaveProperty('EMPTY');
  });

  it('turns `claude auth status` into a credential state without claiming it was verified', async () => {
    const a = adapter({ baseEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test' } });
    execMock.execCapture.mockResolvedValueOnce(exec('{"loggedIn":true,"authMethod":"api_key"}'));
    const withKey = await a.validateCredentials();
    expect(withKey).toMatchObject({ state: 'unknown', method: 'api_key' });
    expect(withKey.detail).toContain('ANTHROPIC_API_KEY is set');
    execMock.execCapture.mockResolvedValueOnce(exec('{"loggedIn":true}'));
    const noKey = await adapter().validateCredentials();
    expect(noKey.detail).toContain('credential present (unknown method)');
    expect(noKey.detail).toContain('claude-sandbox tier');
    execMock.execCapture.mockResolvedValueOnce(exec('{"loggedIn":false,"authMethod":7}'));
    expect(await adapter().validateCredentials()).toMatchObject({ state: 'missing', method: null });
    execMock.execCapture.mockResolvedValueOnce(exec('{"loggedIn":true}', { exitCode: 1 }));
    expect((await adapter().validateCredentials()).state).toBe('missing');
    for (const bad of ['not json', '[1]', 'null']) {
      execMock.execCapture.mockResolvedValueOnce(exec(bad));
      expect((await adapter().validateCredentials()).detail).toMatch(/gave no JSON/);
    }
  });

  it('uses the process environment when none is injected', async () => {
    execMock.execCapture.mockResolvedValueOnce(exec('{"loggedIn":true}'));
    const detail = (await new ClaudeAdapter().validateCredentials()).detail;
    expect(detail).toMatch(/credential present/);
  });

  describe('probeCredentials', () => {
    const lines = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n');
    const INIT = { type: 'system', subtype: 'init', apiKeySource: 'env', session_id: 's', permissionMode: 'dontAsk', mcp_servers: [] };

    it('classifies a live request that works, a rejected key, a missing login and an inconclusive run', async () => {
      execMock.execCapture.mockResolvedValueOnce(exec(lines(INIT, { type: 'result', subtype: 'success', is_error: false, structured_output: {} }), { durationMs: 10 }));
      expect(await adapter().probeCredentials({ model: 'sonnet', timeoutMs: 5 })).toMatchObject({ state: 'valid', method: 'env' });
      execMock.execCapture.mockResolvedValueOnce(exec(lines(INIT, { type: 'result', subtype: 'success', is_error: false })));
      expect((await adapter().probeCredentials()).state).toBe('valid');
      execMock.execCapture.mockResolvedValueOnce(exec(lines(INIT, { type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid API key' }), { exitCode: 1 }));
      expect(await adapter().probeCredentials()).toMatchObject({ state: 'invalid', method: 'env' });
      execMock.execCapture.mockResolvedValueOnce(exec(lines({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }), { exitCode: 1 }));
      expect(await adapter().probeCredentials()).toMatchObject({ state: 'missing', method: null });
      execMock.execCapture.mockResolvedValueOnce(exec('', { exitCode: 1, durationMs: 3 }));
      const inconclusive = await adapter().probeCredentials();
      expect(inconclusive.state).toBe('unknown');
      expect(inconclusive.detail).toMatch(/live check inconclusive: /);
    });

    it('runs in an empty directory and removes it, even when the process fails to start', async () => {
      let cwd = '';
      execMock.execCapture.mockImplementationOnce(async (_argv: string[], opts: { cwd: string }) => {
        cwd = opts.cwd;
        expect(existsSync(cwd)).toBe(true);
        throw new Error('spawn failed');
      });
      await expect(adapter().probeCredentials()).rejects.toThrow('spawn failed');
      expect(existsSync(cwd)).toBe(false);
    });
  });
});

describe('ClaudeAdapter startTask', () => {
  const launched = (f: Fixture, over: Partial<TaskHandle> = {}) => supMock.launchShim.mockResolvedValue(handleFor(f, over));
  const adapter = (over: Record<string, unknown> = {}) =>
    new ClaudeAdapter({ command: ['claude'], baseEnv: { PATH: '/usr/bin', HOME: '/h' }, shimCommand: ['node', 'shim'], clock: new ManualClock(), ...over });

  it('rejects specs that are malformed before touching anything', async () => {
    const f = fixture();
    const a = adapter();
    const spec = (over: Record<string, unknown>) => ({ ...implementerSpec(f), ...over }) as never;
    expect(await code(a.startTask(spec({ cwd: 'relative/dir' })))).toBe('CONFIG_INVALID');
    expect(await code(a.startTask(spec({ workerDir: 'rel' })))).toBe('CONFIG_INVALID');
    expect(await code(a.startTask(spec({ cwd: join(f.base, 'missing') })))).toBe('NOT_FOUND');
    expect(await code(a.startTask(spec({ cwd: join(f.repo, 'apps', 'a.ts') })))).toBe('NOT_FOUND');
    expect(await code(a.startTask(spec({ maxTurns: 0 })))).toBe('CONFIG_INVALID');
    expect(await code(a.startTask(spec({ timeoutMs: 1.5 })))).toBe('CONFIG_INVALID');
    expect(await code(a.startTask(spec({ model: 'bad model!' })))).toBe('CONFIG_INVALID');
    expect(await code(a.startTask(spec({ maxBudgetUsd: 0 })))).toBe('CONFIG_INVALID');
    expect(await code(a.startTask(spec({ outputSchema: { type: 'string' } })))).toBe('SCHEMA_INVALID');
    expect(supMock.launchShim).not.toHaveBeenCalled();
  });

  it('refuses a snapshot that is missing', async () => {
    const f = fixture();
    const spec = implementerSpec(f, { policyPath: join(f.base, 'nope.json') });
    delete (spec as { policyHash?: string }).policyHash;
    expect(await code(adapter().startTask(spec))).toBe('POLICY_TAMPERED');
  });

  it('launches a claude-sandbox worker and derives the policy hash from the snapshot when none is given', async () => {
    const f = fixture();
    launched(f);
    const spec = implementerSpec(f, { model: 'haiku', effort: 'high' });
    delete (spec as { policyHash?: string }).policyHash;
    const handle = await adapter().startTask({ ...spec, maxBudgetUsd: 2 } as never);
    expect(handle.tier).toBe('claude-sandbox');
    expect(handle.limitations[0]).toBe("effort high is not supported by haiku; the model's default effort applies");
    const call = supMock.launchShim.mock.calls[0]![0];
    expect(call.argv).not.toContain('--effort');
    expect(call.argv).toContain('--max-budget-usd');
    expect(call.meta).toMatchObject({ tier: 'claude-sandbox' });
    expect(call.shimCommand).toEqual(['node', 'shim']);
    expect(existsSync(join(f.workerDir, 'settings.json'))).toBe(true);
    expect(readFileSync(join(f.workerDir, 'prompt.md'), 'utf8')).toContain('Change apps/a.ts.');
  });

  it('passes an effort on an unrecognized model, refuses an unknown effort, and omits the budget line when none applies', async () => {
    const f = fixture();
    launched(f);
    await adapter().startTask(implementerSpec(f, { model: 'some-custom-model', effort: 'low', outputTokens: null }) as never);
    expect(supMock.launchShim.mock.calls[0]![0].argv).toContain('low');
    expect(readFileSync(join(f.workerDir, 'prompt.md'), 'utf8')).toBe('Change apps/a.ts.');
    const g = fixture();
    expect(await code(adapter().startTask(implementerSpec(g, { effort: 'ludicrous' }) as never))).toBe('CONFIG_INVALID');
    const h = fixture();
    launched(h);
    await adapter({ modelEfforts: () => ['medium'] }).startTask(implementerSpec(h, { model: 'sonnet', effort: 'medium' }) as never);
    expect(supMock.launchShim.mock.calls[1]![0].argv).toContain('medium');
    const i = fixture();
    launched(i);
    await adapter({ tier: 'claude-sandbox', cliVersion: '2.1.100' }).startTask(implementerSpec(i, { model: null, effort: null }) as never);
    expect(supMock.launchShim.mock.calls[2]![0].argv).not.toContain('--permission-prompts');
  });

  it('reattaches to a worker that was already launched instead of starting another', async () => {
    const f = fixture();
    writeFileSync(join(f.workerDir, LAUNCH_FILE), JSON.stringify({ version: 1, provider: 'claude', workerId: 'w1', sessionId: 'sess-prior', meta: { tier: 'os-sandbox', limitations: ['x'] } }));
    supMock.reattachLaunch.mockResolvedValue(handleFor(f));
    const handle = await adapter().startTask(implementerSpec(f) as never);
    expect(handle).toMatchObject({ tier: 'os-sandbox', limitations: ['x'], sessionId: 'sess-prior' });
    writeFileSync(join(f.workerDir, LAUNCH_FILE), JSON.stringify({ version: 1, provider: 'claude', workerId: 'w1' }));
    const bare = await adapter().startTask({ ...implementerSpec(f), sessionId: 'given' } as never);
    expect(bare).toMatchObject({ tier: 'claude-sandbox', limitations: [], sessionId: 'given' });
    expect(supMock.launchShim).not.toHaveBeenCalled();
  });

  describe('worker tier', () => {
    const fakeIsolation = (available: boolean, argv: string[] = ['/tmp/orbit-srt-abc/settings.json', 'wrapped']): IsolationProvider & { availableCalls: number; profiles: SandboxProfile[] } => {
      const iso = {
        kind: 'sandbox-runtime' as const,
        availableCalls: 0,
        profiles: [] as SandboxProfile[],
        async available() {
          iso.availableCalls++;
          return { ok: available, detail: '' };
        },
        wrap(_argv: string[], profile: SandboxProfile) {
          iso.profiles.push(profile);
          return { argv, env: { WRAPPED: '1' }, cleanup() {}, limitations: ['srt limitation'] };
        },
      };
      return iso as never;
    };
    const keyEnv = { PATH: '/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-test' };

    it('demands the credential and the isolation provider for an explicit os-sandbox tier', async () => {
      const f = fixture();
      expect(await code(adapter({ tier: 'os-sandbox' }).startTask(implementerSpec(f) as never))).toBe('AUTH_MISSING');
      expect(await code(adapter({ tier: 'os-sandbox', baseEnv: keyEnv }).startTask(implementerSpec(f) as never))).toBe('ISOLATION_UNAVAILABLE');
      expect(await code(adapter({ tier: 'os-sandbox', baseEnv: keyEnv, isolation: { kind: 'none' } }).startTask(implementerSpec(f) as never))).toBe('ISOLATION_UNAVAILABLE');
    });

    it('wraps the process under srt when it can, probing availability once per adapter, and keeps read-only roles out of the worktree', async () => {
      const f = fixture();
      launched(f);
      const iso = fakeIsolation(true);
      const a = adapter({ baseEnv: keyEnv, isolation: iso });
      const handle = await a.startTask(implementerSpec(f, { readOnly: true }) as never);
      expect(handle.tier).toBe('os-sandbox');
      expect(handle.limitations).toEqual(expect.arrayContaining(['srt limitation']));
      expect(iso.profiles[0]!.writablePaths).not.toContain(f.repo);
      const call = supMock.launchShim.mock.calls[0]![0];
      expect(call.argv).toEqual(['/tmp/orbit-srt-abc/settings.json', 'wrapped']);
      expect(call.env).toEqual({ WRAPPED: '1' });
      expect(call.cleanupPaths).toEqual(['/tmp/orbit-srt-abc']);
      const g = fixture();
      await a.startTask(implementerSpec(g) as never);
      expect(iso.availableCalls).toBe(1);
      expect(iso.profiles[1]!.writablePaths).toContain(g.repo);
    });

    it('falls back to the claude-sandbox tier when srt is unavailable, or no env credential exists', async () => {
      const f = fixture();
      launched(f);
      expect((await adapter({ baseEnv: keyEnv, isolation: fakeIsolation(false) }).startTask(implementerSpec(f) as never)).tier).toBe('claude-sandbox');
      const g = fixture();
      expect((await adapter({ isolation: fakeIsolation(true) }).startTask(implementerSpec(g) as never)).tier).toBe('claude-sandbox');
    });
  });
});

describe('ClaudeAdapter results', () => {
  const adapter = () => new ClaudeAdapter({ command: ['claude'], baseEnv: {}, clock: new ManualClock() });
  const LOST_PID = 2_147_483_000;

  it('reports nothing while the shim is running, and a lost worker as cancelled or crashed', async () => {
    const f = fixture();
    expect(await adapter().collectResult(handleFor(f, { pid: process.pid, pgid: process.pid }), { outputSchema: {} })).toBeNull();
    const lost = await adapter().collectResult(handleFor(f, { pid: LOST_PID, pgid: LOST_PID }), { outputSchema: {} });
    expect(lost).toMatchObject({ status: 'lost', reason: 'crashed', sessionId: null });
    expect(lost?.error).toBe('the worker shim ended without writing exit.json');
    writeFileSync(join(f.workerDir, 'cancel.json'), '{"version":1}');
    expect(await adapter().collectResult(handleFor(f, { pid: LOST_PID, pgid: LOST_PID }), { outputSchema: {} })).toMatchObject({ status: 'cancelled', reason: 'interrupted' });
    expect(existsSync(join(f.workerDir, 'result.json'))).toBe(true);
  });

  it('classifies an exited worker from its transcript and writes result.json', async () => {
    const f = fixture();
    writeFileSync(join(f.workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: LOST_PID, shimStart: null, pgid: LOST_PID, childPid: null, childStart: null, sessionId: 's1', argvHash: 'x', startedAt: 1 }));
    writeFileSync(join(f.workerDir, 'exit.json'), JSON.stringify({ version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 1, endedAt: 2 }));
    writeFileSync(join(f.workerDir, 'log.jsonl'), '{"type":"system","subtype":"init","session_id":"s1","permissionMode":"dontAsk","mcp_servers":[]}\n{"type":"result","subtype":"success","is_error":false,"structured_output":{"answer":"x"},"session_id":"s1"}\n');
    const schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
    const result = await adapter().collectResult(handleFor(f, { pid: LOST_PID, pgid: LOST_PID }), { outputSchema: schema });
    expect(result).toMatchObject({ status: 'succeeded', structured: { answer: 'x' } });
    expect(JSON.parse(readFileSync(join(f.workerDir, 'result.json'), 'utf8')).status).toBe('succeeded');
  });

  it('reports usage from the log, empty usage without one, and reattaches from files', async () => {
    const f = fixture();
    const a = adapter();
    expect(await a.reportUsage(handleFor(f))).toMatchObject({ provider: 'claude', inputTokens: null });
    writeFileSync(join(f.workerDir, 'log.jsonl'), `${JSON.stringify({ type: 'result', modelUsage: { m: { inputTokens: 3, outputTokens: 4, costUSD: 0.5 } } })}\n`);
    expect(await a.reportUsage(handleFor(f))).toMatchObject({ inputTokens: 3, outputTokens: 4, costUsd: 0.5, timeToFirstEventMs: null });
    expect(a.reattach(f.workerDir)).toBeNull();
    writeFileSync(join(f.workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: 7, shimStart: 'x', pgid: 7, childPid: null, childStart: null, sessionId: null, argvHash: 'x', startedAt: 1 }));
    expect(a.reattach(f.workerDir)).toMatchObject({ provider: 'claude', pid: 7 });
  });

  it('streams new log lines as events and cancels through the shim with its grace period', async () => {
    const f = fixture();
    const a = new ClaudeAdapter({ command: ['claude'], baseEnv: {}, graceMs: 123, clock: new ManualClock(5) });
    writeFileSync(join(f.workerDir, 'log.jsonl'), '{"type":"system","subtype":"init"}\n');
    const { events, nextOffset } = await a.streamEvents(handleFor(f), 0);
    expect(events).toEqual([{ type: 'started', at: 1_700_000_000_000 + 0 || 5 }].map((e) => ({ ...e, at: expect.any(Number) })));
    expect(nextOffset).toBeGreaterThan(0);
    await a.cancelTask(handleFor(f));
    expect(supMock.cancelShim).toHaveBeenCalledWith(expect.anything(), 123, expect.anything());
    await adapter().cancelTask(handleFor(f));
    expect(supMock.cancelShim.mock.calls[1]![1]).toBe(5_000);
  });
});

describe('claude helpers', () => {
  it('compares versions with unequal lengths and recognizes model families', () => {
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('2.1.9', '2.1.10')).toBe(-1);
    expect(compareVersions('2.2', '2.1.99')).toBe(1);
    expect(knownEfforts('claude-haiku-4-5')).toEqual([]);
    expect(knownEfforts('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max']);
    expect(knownEfforts('sonnet')).toHaveLength(5);
    expect(knownEfforts('claude-opus-4-7')).toHaveLength(5);
    expect(knownEfforts('mystery')).toBeNull();
  });
});

describe('CodexAdapter', () => {
  const adapter = (over: Record<string, unknown> = {}) => new CodexAdapter({ command: ['codex'], baseEnv: { PATH: '/usr/bin', CODEX_HOME: '/h/.codex' }, shimCommand: ['node', 'shim'], clock: new ManualClock(), ...over });
  const FLAGS = '--sandbox --ephemeral --ignore-user-config --json --output-schema --output-last-message --model --cd --full-auto';
  const reviewSpec = (f: Fixture, over: Partial<TaskSpec> = {}) => implementerSpec(f, { role: 'reviewer', readOnly: true, model: 'codex-alpha', effort: 'high', ...over }) as TaskSpec;

  it('defaults its command and refuses extra flags', () => {
    expect(new CodexAdapter().id).toBe('codex');
    expect(() => new CodexAdapter({ extraArgs: ['--yolo'] })).toThrow(/not allowed/);
    expect(() => new CodexAdapter({ extraArgs: ['value-only'] })).not.toThrow();
  });

  it('describes what discovery found, from the version, the exec help and the model catalog', async () => {
    const catalog = JSON.stringify({ models: [{ slug: 'codex-alpha', display_name: 'A', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }, { slug: 'hidden', display_name: 'H', visibility: 'hide', supported_reasoning_levels: [] }] });
    execMock.execCapture.mockResolvedValueOnce(exec('codex-cli 0.153.4')).mockResolvedValueOnce(exec(`Usage\n  ${FLAGS}`)).mockResolvedValueOnce(exec(catalog));
    const ok = await adapter().discoverCapabilities();
    expect(ok).toMatchObject({ available: true, version: '0.153.4', models: ['codex-alpha'], structuredOutput: true, readOnlySandbox: true });
    expect(ok.detail).toBe('codex 0.153.4; exec lists --full-auto; Orbit never passes it');

    execMock.execCapture.mockResolvedValueOnce(exec('codex-cli')).mockResolvedValueOnce(exec(FLAGS)).mockResolvedValueOnce(exec('not json'));
    expect((await adapter().discoverCapabilities()).detail).toMatch(/^codex unknown version; codex debug models was not parseable \(/);
    execMock.execCapture.mockResolvedValueOnce(exec('codex-cli 1.0.0')).mockResolvedValueOnce(exec(FLAGS)).mockResolvedValueOnce(exec('', { exitCode: 1 }));
    expect((await adapter().discoverCapabilities()).detail).toBe('codex 1.0.0; codex debug models failed (exit 1); exec lists --full-auto; Orbit never passes it');
    execMock.execCapture.mockResolvedValueOnce(exec('codex-cli 1.0.0')).mockResolvedValueOnce(exec('--json')).mockResolvedValueOnce(exec('{}', { exitCode: 1 }));
    const lacking = await adapter().discoverCapabilities();
    expect(lacking.available).toBe(false);
    expect(lacking.detail).toMatch(/^codex exec lacks --sandbox/);
    execMock.execCapture.mockResolvedValueOnce(exec('', { exitCode: 1, stderr: 'bad' })).mockResolvedValueOnce(exec('', { exitCode: 2 })).mockRejectedValueOnce(new Error('gone'));
    const broken = await adapter().discoverCapabilities();
    expect(broken.detail).toBe('codex --version failed: exit 1');
    expect(broken.models).toEqual([]);
    execMock.execCapture.mockResolvedValueOnce(exec('', { timedOut: true, exitCode: null })).mockRejectedValueOnce('odd').mockResolvedValueOnce(exec('', { exitCode: null, signal: 'SIGTERM' }));
    expect((await adapter().discoverCapabilities()).detail).toBe('codex --version failed: timed out');
  });

  it('checks credentials through login status and doctor, skipping the status check for an API key in the environment', async () => {
    const doctor = (checks: object) => exec(JSON.stringify({ checks }));
    execMock.execCapture.mockResolvedValueOnce(exec('', { exitCode: 1, stderr: 'Not logged in' }));
    expect(await adapter().validateCredentials()).toMatchObject({ state: 'missing', detail: 'codex reports: Not logged in' });
    execMock.execCapture.mockResolvedValueOnce(exec('', { exitCode: 1, stderr: 'weird' }));
    expect((await adapter().validateCredentials()).detail).toBe('codex login status failed: exit 1');
    execMock.execCapture.mockResolvedValueOnce(exec('Logged in using ChatGPT')).mockResolvedValueOnce(doctor({ 'auth.credentials': { status: 'ok' }, 'network.websocket_reachability': { status: 'ok' } }));
    expect(await adapter().validateCredentials()).toMatchObject({ state: 'valid', method: 'chatgpt' });
    execMock.execCapture.mockResolvedValueOnce(exec('Logged in using an API key')).mockResolvedValueOnce(doctor({ 'auth.credentials': { status: 'fail' } }));
    expect(await adapter().validateCredentials()).toMatchObject({ state: 'invalid', method: 'api_key' });
    execMock.execCapture.mockResolvedValueOnce(exec('Logged in')).mockResolvedValueOnce(exec('not json'));
    expect(await adapter().validateCredentials()).toMatchObject({ state: 'unknown', method: 'unknown' });
    execMock.execCapture.mockResolvedValueOnce(doctor({ 'auth.credentials': { status: 'ok' } }));
    const withKey = await adapter({ baseEnv: { PATH: '/usr/bin', CODEX_API_KEY: 'sk' } }).validateCredentials();
    expect(withKey).toMatchObject({ state: 'unknown', method: 'api_key_env' });
    expect(withKey.detail).toBe('codex doctor: auth.credentials ok, network.websocket_reachability missing');
    expect(execMock.execCapture).toHaveBeenCalledTimes(9);
  });

  it('refuses anything but a read-only review with a usable model, effort and checkout', async () => {
    const f = fixture();
    const a = adapter();
    const spec = (over: Partial<TaskSpec>) => reviewSpec(f, over);
    expect(await code(a.startTask(spec({ readOnly: false })))).toBe('POLICY_DENIED');
    expect(await code(a.startTask(spec({ model: null })))).toBe('CONFIG_INVALID');
    expect(await code(a.startTask(spec({ model: 'bad model' })))).toBe('CONFIG_INVALID');
    expect(await code(a.startTask(spec({ effort: 'ultra' })))).toBe('CONFIG_INVALID');
    expect(await code(a.startTask(spec({ cwd: 'rel' })))).toBe('CONFIG_INVALID');
    expect(await code(a.startTask(spec({ cwd: join(f.base, 'missing') })))).toBe('NOT_FOUND');
    expect(await code(a.startTask(spec({ cwd: join(f.repo, 'apps', 'a.ts') })))).toBe('NOT_FOUND');
    expect(await code(a.startTask(spec({ outputSchema: { type: 'array' } })))).toBe('SCHEMA_INVALID');
    const noHash = spec({ policyPath: join(f.base, 'nope.json') });
    delete (noHash as { policyHash?: string }).policyHash;
    expect(await code(a.startTask(noHash))).toBe('POLICY_TAMPERED');
  });

  it('launches under codex own sandbox, or wrapped in isolation, and reattaches a worker that already ran', async () => {
    const f = fixture();
    supMock.launchShim.mockResolvedValue(handleFor(f, { provider: 'codex' }));
    const plain = await adapter().startTask(reviewSpec(f, { effort: null, outputTokens: null }));
    expect(plain.tier).toBe('codex-sandbox');
    expect(plain.limitations.some((l) => l.startsWith('No OS isolation'))).toBe(true);
    expect(plain.limitations.some((l) => l.startsWith('Output budget'))).toBe(false);
    const first = supMock.launchShim.mock.calls[0]![0];
    expect(first.argv).not.toContain('model_reasoning_effort="high"');
    expect(readFileSync(join(f.workerDir, 'prompt.md'), 'utf8')).not.toContain('token');

    const g = fixture();
    // wrap() puts the command it was given last, like srt does; the adapter refuses a wrapper that did not.
    const wrap = vi.fn((argv: string[]) => ({ argv: ['/opt/srt', '--settings', '/tmp/orbit-srt-q/settings.json', '--', ...argv], env: { W: '1' }, cleanup() {}, limitations: ['srt'] }));
    const iso = { kind: 'sandbox-runtime' as const, wrap, available: async () => ({ ok: true, detail: '' }) };
    const withIso = await adapter({ isolation: iso }).startTask(reviewSpec(g));
    expect(withIso.tier).toBe('os-sandbox');
    expect(withIso.limitations).toEqual(expect.arrayContaining(['srt']));
    expect(withIso.limitations.some((l) => l.startsWith('Output budget'))).toBe(true);
    expect(supMock.launchShim.mock.calls[1]![0]).toMatchObject({ argv: wrap.mock.results[0]!.value.argv, env: { W: '1' }, cleanupPaths: ['/tmp/orbit-srt-q'] });
    const none = fixture();
    const noneIso = { kind: 'none' as const, wrap: vi.fn() };
    expect((await adapter({ isolation: noneIso }).startTask(reviewSpec(none))).tier).toBe('codex-sandbox');
    expect(noneIso.wrap).not.toHaveBeenCalled();

    const h = fixture();
    writeFileSync(join(h.workerDir, LAUNCH_FILE), JSON.stringify({ version: 1, provider: 'codex', workerId: 'w1', meta: { tier: 'os-sandbox', limitations: ['kept'] } }));
    supMock.reattachLaunch.mockResolvedValue(handleFor(h, { provider: 'codex' }));
    expect(await adapter().startTask(reviewSpec(h))).toMatchObject({ tier: 'os-sandbox', limitations: ['kept'] });
    writeFileSync(join(h.workerDir, LAUNCH_FILE), JSON.stringify({ version: 1, provider: 'codex', workerId: 'w1' }));
    expect(await adapter().startTask(reviewSpec(h))).toMatchObject({ tier: 'codex-sandbox', limitations: [] });
  });

  it('collects results for a lost worker, reports usage with the launch model and reattaches from files', async () => {
    const f = fixture();
    const a = adapter();
    const LOST = 2_147_483_000;
    expect(await a.collectResult(handleFor(f, { pid: process.pid, pgid: process.pid }), { outputSchema: {} })).toBeNull();
    writeFileSync(join(f.workerDir, LAUNCH_FILE), JSON.stringify({ version: 1, meta: { model: 'codex-alpha' } }));
    const lost = await a.collectResult(handleFor(f, { pid: LOST, pgid: LOST }), { outputSchema: {} });
    expect(lost).toMatchObject({ status: 'lost', reason: 'crashed', usage: { model: 'codex-alpha' } });
    writeFileSync(join(f.workerDir, 'cancel.json'), '{"version":1}');
    expect((await a.collectResult(handleFor(f, { pid: LOST, pgid: LOST }), { outputSchema: {} }))?.status).toBe('cancelled');

    const g = fixture();
    writeFileSync(join(g.workerDir, 'exit.json'), JSON.stringify({ version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 1, endedAt: 2 }));
    writeFileSync(join(g.workerDir, 'log.jsonl'), '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"answer\\":\\"ok\\"}"}}\n{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}\n');
    const schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
    const done = await a.collectResult(handleFor(g, { pid: LOST, pgid: LOST }), { outputSchema: schema });
    expect(done).toMatchObject({ status: 'succeeded', structured: { answer: 'ok' }, usage: { inputTokens: 5 } });
    expect(await a.reportUsage(handleFor(g))).toMatchObject({ inputTokens: 5, model: null });
    expect(await a.reportUsage(handleFor(fixture()))).toMatchObject({ inputTokens: null });
    expect(a.reattach(g.workerDir)).toBeNull();
    const { events } = await a.streamEvents(handleFor(g), 0);
    expect(events.map((e) => e.type)).toEqual(['message', 'usage', 'finished']);
    await a.cancelTask(handleFor(g));
    expect(supMock.cancelShim).toHaveBeenCalledTimes(1);
    await new CodexAdapter({ graceMs: 9, baseEnv: {} }).cancelTask(handleFor(g));
    expect(supMock.cancelShim.mock.calls[1]![1]).toBe(9);
    expect(a.reattach(f.workerDir)).toBeNull();
  });

  it('reads the process environment when none is injected', async () => {
    execMock.execCapture.mockResolvedValueOnce(exec('', { exitCode: 1 })).mockResolvedValueOnce(exec('', { exitCode: 1 })).mockResolvedValueOnce(exec('', { exitCode: 1 }));
    const detail = (await new CodexAdapter({ command: [] }).discoverCapabilities()).detail;
    expect(detail).toMatch(/failed/);
    expect(execMock.execCapture.mock.calls[0]![0][0]).toBe('codex');
  });

  it('parses help flags and doctor reports leniently', () => {
    expect([...parseHelpFlags('  --json  --a-b-9\n-x --Bad')].sort()).toEqual(['--a-b-9', '--json']);
    expect(parseDoctorChecks('not json')).toBeNull();
    expect(parseDoctorChecks('5')).toBeNull();
    expect(parseDoctorChecks('null')).toBeNull();
    expect(parseDoctorChecks('{"checks":5}')).toBeNull();
    expect(parseDoctorChecks('{}')).toBeNull();
    expect(parseDoctorChecks('{"checks":[{"id":"a","status":"ok"},{"id":1},null,{"id":"b"}]}')).toEqual({ a: 'ok' });
    expect(parseDoctorChecks('{"checks":{"a":{"status":"fail"},"b":"x","c":null}}')).toEqual({ a: 'fail' });
  });
});
