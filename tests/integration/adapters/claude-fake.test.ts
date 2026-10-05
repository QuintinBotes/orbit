import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import { readExitRecord, readPidRecord } from '../../../src/adapters/shim.ts';
import { archiveAttempt, nextSessionId } from '../../../src/adapters/supervise.ts';
import { FAKE_CLAUDE, IMPLEMENTER_OUTPUT, alive, implementerSpec, makeFixture, waitFor, writeScenario, type Fixture } from './helpers.ts';

// The shim and fake-claude run as real detached processes; the shim runs from
// source, which needs Node's type stripping.
const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const fixtures: Fixture[] = [];
function fixture(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f.base, { recursive: true, force: true });
});

function adapter(extra: Partial<ConstructorParameters<typeof ClaudeAdapter>[0]> = {}): ClaudeAdapter {
  return new ClaudeAdapter({
    command: [process.execPath, FAKE_CLAUDE],
    tier: 'claude-sandbox',
    graceMs: 300,
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: 'ghp_shouldnotleak', SSH_AUTH_SOCK: '/tmp/agent.sock', AWS_SECRET_ACCESS_KEY: 'nope', ANTHROPIC_API_KEY: 'sk-ant-fake-000' },
    ...extra,
  });
}

async function collect(a: ClaudeAdapter, handle: Parameters<ClaudeAdapter['collectResult']>[0], f: Fixture) {
  return waitFor(() => a.collectResult(handle, implementerSpec(f)), 30_000);
}

describe.skipIf(!canStripTypes)('ClaudeAdapter + shim + fake-claude', () => {
  it('runs a worker end to end: edits applied, pid and exit files, validated output, usage from modelUsage', async () => {
    const f = fixture();
    writeScenario(f, { roles: { implementer: [{ edits: [{ op: 'replace', path: 'apps/a.ts', find: '1', replace: '2' }], structured: IMPLEMENTER_OUTPUT }] } });
    const a = adapter();
    const handle = await a.startTask(implementerSpec(f));
    expect(handle.tier).toBe('claude-sandbox');
    expect(handle.limitations.length).toBeGreaterThan(0);
    const result = await collect(a, handle, f);
    expect(result.status).toBe('succeeded');
    expect(result.structured).toEqual(IMPLEMENTER_OUTPUT);
    expect(result.usage).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', inputTokens: 1200, outputTokens: 340, costUsd: 0.0123, costSource: 'reported' });
    expect(readFileSync(join(f.repo, 'apps', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(readPidRecord(f.workerDir)).toMatchObject({ shimPid: handle.pid, pgid: handle.pgid, sessionId: handle.sessionId });
    expect(readExitRecord(f.workerDir)).toMatchObject({ code: 0, timedOut: false, cancelled: false });
    expect(existsSync(join(f.workerDir, 'result.json'))).toBe(true);

    const call = JSON.parse(readFileSync(f.argvLog, 'utf8').trim().split('\n')[0]!) as { argv: string[]; envKeys: string[]; promptBytes: number };
    expect(call.envKeys).not.toContain('GH_TOKEN');
    expect(call.envKeys).not.toContain('SSH_AUTH_SOCK');
    expect(call.envKeys).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(call.envKeys).toEqual(expect.arrayContaining(['ORBIT_POLICY_PATH', 'ORBIT_POLICY_HASH', 'ORBIT_WORKTREE', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'GIT_OPTIONAL_LOCKS']));
    expect(call.promptBytes).toBe('Change apps/a.ts.'.length);
    expect(call.argv).toEqual(expect.arrayContaining(['--session-id', handle.sessionId, '--permission-mode', 'dontAsk', '--strict-mcp-config']));

    const { events, nextOffset } = await a.streamEvents(handle, 0);
    expect(events[0]?.type).toBe('started');
    expect(events.some((e) => e.type === 'tool')).toBe(true);
    expect(events.at(-1)?.type).toBe('finished');
    expect((await a.streamEvents(handle, nextOffset)).events).toEqual([]);
  });

  it('is idempotent per worker directory: a second startTask reattaches instead of spawning', async () => {
    const f = fixture();
    writeScenario(f, { roles: { '*': [{ sleepMs: 1500, structured: IMPLEMENTER_OUTPUT }] } });
    const a = adapter();
    const first = await a.startTask(implementerSpec(f));
    const second = await a.startTask(implementerSpec(f));
    expect(second.pid).toBe(first.pid);
    expect((await collect(a, first, f)).status).toBe('succeeded');
    await expect(a.startTask(implementerSpec(f))).rejects.toMatchObject({ code: 'TRANSITION_INVALID' });
    expect(archiveAttempt('claude', f.workerDir)).toContain('attempts');
    expect(readFileSync(f.argvLog, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('survives the death of the process that started it; a new controller reattaches from pid.json', async () => {
    const f = fixture();
    writeScenario(f, { roles: { '*': [{ sleepMs: 2000, structured: IMPLEMENTER_OUTPUT }] } });
    const starter = fileURLToPath(new URL('./start-worker.ts', import.meta.url));
    const child = spawn(process.execPath, ['--no-warnings', starter, JSON.stringify({ spec: implementerSpec(f), command: [process.execPath, FAKE_CLAUDE] })], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    await waitFor(() => out.includes('started'), 20_000);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    const a = adapter();
    const handle = a.reattach(f.workerDir);
    expect(handle).not.toBeNull();
    expect(alive(handle!.pid)).toBe(true);
    expect(await a.collectResult(handle!, implementerSpec(f))).toBeNull();
    const result = await collect(a, handle!, f);
    expect(result.status).toBe('succeeded');
  });

  it('reports a shim killed with SIGKILL as lost: no exit.json, and cancelTask ends the orphaned provider', async () => {
    const f = fixture();
    writeScenario(f, { roles: { '*': [{ sleepMs: 30_000, structured: IMPLEMENTER_OUTPUT }] } });
    const a = adapter();
    const handle = await a.startTask(implementerSpec(f));
    const pid = readPidRecord(f.workerDir)!;
    process.kill(handle.pid, 'SIGKILL');
    await waitFor(() => !alive(handle.pid) || null);
    const result = await collect(a, handle, f);
    expect(result.status).toBe('lost');
    expect(result.error).toMatch(/still running/);
    expect(existsSync(join(f.workerDir, 'exit.json'))).toBe(false);
    await a.cancelTask(handle);
    await waitFor(() => !alive(pid.childPid!) || null);
  });

  it('refuses to archive a lost attempt while its orphaned provider still runs, so a restart cannot start a second worker beside it', async () => {
    const f = fixture();
    writeScenario(f, { roles: { '*': [{ sleepMs: 30_000, structured: IMPLEMENTER_OUTPUT }, { structured: IMPLEMENTER_OUTPUT }] } });
    const a = adapter();
    const spec = implementerSpec(f);
    const handle = await a.startTask(spec);
    const pid = readPidRecord(f.workerDir)!;
    process.kill(handle.pid, 'SIGKILL');
    await waitFor(() => !alive(handle.pid) || null);
    expect((await collect(a, handle, f)).status).toBe('lost');
    expect(() => archiveAttempt('claude', f.workerDir)).toThrow(/still running/);
    await expect(a.startTask(spec)).rejects.toThrow(/archive the attempt/);
    expect(readFileSync(f.argvLog, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(alive(pid.childPid!)).toBe(true);

    await a.cancelTask(handle);
    await waitFor(() => !alive(pid.childPid!) || null);
    const archived = archiveAttempt('claude', f.workerDir)!;
    // Nothing of the lost attempt stays where the next attempt's files go.
    for (const name of ['result.json', 'log.jsonl', 'pid.json', 'launch.json', 'cancel.json', 'settings.json', 'prompt.md']) {
      expect(existsSync(join(f.workerDir, name))).toBe(false);
      expect(existsSync(join(archived, name))).toBe(true);
    }
    const second = await a.startTask(spec);
    expect(second.sessionId).not.toBe(handle.sessionId);
    expect((await collect(a, second, f)).status).toBe('succeeded');
  });

  it('treats helpers left in the group of a lost shim as orphans: archive refuses, cancelTask ends them', async () => {
    const f = fixture();
    const gc = join(f.base, 'grandchild.pid');
    writeScenario(f, { roles: { '*': [{ sleepMs: 30_000, grandchildPidFile: gc, structured: IMPLEMENTER_OUTPUT }] } });
    const a = adapter();
    const handle = await a.startTask(implementerSpec(f));
    const grandchild = Number(await waitFor(() => (existsSync(gc) ? readFileSync(gc, 'utf8') || null : null)));
    const pid = readPidRecord(f.workerDir)!;
    process.kill(handle.pid, 'SIGKILL');
    process.kill(pid.childPid!, 'SIGKILL');
    await waitFor(() => (!alive(handle.pid) && !alive(pid.childPid!)) || null);
    expect(alive(grandchild)).toBe(true);
    const result = await collect(a, handle, f);
    expect(result.status).toBe('lost');
    expect(result.error).toMatch(/still running/);
    expect(() => archiveAttempt('claude', f.workerDir)).toThrow(/still running/);
    await a.cancelTask(handle);
    await waitFor(() => !alive(grandchild) || null, 10_000);
    expect(archiveAttempt('claude', f.workerDir)).not.toBeNull();
  });

  it('cancels through the process group: SIGINT ends the turn, exit 0 without a result line is cancelled, not success', async () => {
    const f = fixture();
    writeScenario(f, { roles: { '*': [{ sleepMs: 30_000, structured: IMPLEMENTER_OUTPUT }] } });
    const a = adapter();
    const handle = await a.startTask(implementerSpec(f));
    await a.cancelTask(handle);
    const result = await collect(a, handle, f);
    expect(result.status).toBe('cancelled');
    expect(readExitRecord(f.workerDir)).toMatchObject({ code: 0, cancelled: true });
    expect(existsSync(join(f.workerDir, 'cancel.json'))).toBe(true);
  });

  it('enforces the timeout by escalating to SIGKILL over the whole group, grandchildren included', async () => {
    const f = fixture();
    const gc = join(f.base, 'grandchild.pid');
    writeScenario(f, { roles: { '*': [{ sleepMs: 60_000, ignoreSignals: true, grandchildPidFile: gc, structured: IMPLEMENTER_OUTPUT }] } });
    const a = adapter();
    const handle = await a.startTask(implementerSpec(f, { timeoutMs: 800 }));
    const grandchild = Number(await waitFor(() => (existsSync(gc) ? readFileSync(gc, 'utf8') || null : null)));
    expect(alive(grandchild)).toBe(true);
    const result = await collect(a, handle, f);
    expect(result.status).toBe('timeout');
    expect(readExitRecord(f.workerDir)).toMatchObject({ timedOut: true, signal: 'SIGKILL', escalation: ['SIGINT', 'SIGTERM', 'SIGKILL'] });
    await waitFor(() => !alive(grandchild) || null, 5_000);
  });

  it('aborts on the first authentication_failed retry event and blocks as auth_failed', async () => {
    const f = fixture();
    writeScenario(f, { roles: { '*': [{ outcome: 'auth_failure', hangAfterRetry: 30_000 }] } });
    const a = adapter();
    const started = Date.now();
    const handle = await a.startTask(implementerSpec(f));
    const result = await collect(a, handle, f);
    expect(result.status).toBe('auth_failed');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(readExitRecord(f.workerDir)?.aborted).toContain('authentication_failed');
  });

  it('classifies a crash mid-edit (exit 137 after a partial write) as failed, leaving the partial file for diff inspection', async () => {
    const f = fixture();
    writeScenario(f, { roles: { '*': [{ crash: { path: 'apps/b.ts', content: 'export const b = 12345;\n' } }] } });
    const a = adapter();
    const result = await collect(a, await a.startTask(implementerSpec(f)), f);
    expect(result).toMatchObject({ status: 'failed', exitCode: 137 });
    expect(readFileSync(join(f.repo, 'apps', 'b.ts'), 'utf8')).toBe('export const');
  });

  it('classifies malformed output, structured output that fails the schema, and max turns', async () => {
    const f = fixture();
    const spec = implementerSpec(f);
    const a = adapter();
    const cases: [object, string][] = [
      [{ outcome: 'malformed' }, 'malformed_output'],
      [{ structured: { summary: 'missing everything else' } }, 'malformed_output'],
      [{ outcome: 'max_turns' }, 'max_turns'],
      [{ outcome: 'transient' }, 'transient_error'],
    ];
    for (const [step, status] of cases) {
      writeScenario(f, { roles: { '*': [step] } });
      archiveAttempt('claude', f.workerDir);
      const result = await collect(a, await a.startTask(spec), f);
      expect(result.status, JSON.stringify(step)).toBe(status);
    }
  });

  it('refuses to start when the provider command does not exist, without leaving a running process', async () => {
    const f = fixture();
    writeScenario(f, {});
    const a = adapter({ command: [join(f.base, 'no-such-claude')] });
    const handle = await a.startTask(implementerSpec(f));
    const result = await collect(a, handle, f);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/ENOENT|could not start/);
  });

  it('records the isolation tier in launch.json before the spawn, so a launch that never comes up still reports it', async () => {
    const f = fixture();
    writeScenario(f, { roles: { '*': [{ structured: IMPLEMENTER_OUTPUT }] } });
    const a = adapter({ shimCommand: ['/usr/bin/false'] });
    await expect(a.startTask(implementerSpec(f))).rejects.toThrow(/did not start/);
    const launch = JSON.parse(readFileSync(join(f.workerDir, 'launch.json'), 'utf8')) as { meta?: { tier?: string; limitations?: string[] } };
    expect(launch.meta?.tier).toBe('claude-sandbox');
    expect(launch.meta?.limitations?.length).toBeGreaterThan(0);
  });

  it('does not turn a timeout beyond the 24.8-day timer limit into an immediate kill', async () => {
    const f = fixture();
    writeScenario(f, { roles: { '*': [{ sleepMs: 300, structured: IMPLEMENTER_OUTPUT }] } });
    const a = adapter();
    const handle = await a.startTask(implementerSpec(f, { timeoutMs: 3_000_000_000 }));
    const result = await collect(a, handle, f);
    expect(result.status).toBe('succeeded');
    expect(readExitRecord(f.workerDir)).toMatchObject({ timedOut: false, escalation: [] });
  });

  describe('TaskSpec.sessionId and TaskSpec.policyHash', () => {
    const GIVEN_SESSION = '7d1f0b8e-2c55-4a1d-9a77-1f0c2b3d4e5f';

    it('uses the session id the controller persisted before spawn', async () => {
      const f = fixture();
      writeScenario(f, { roles: { '*': [{ structured: IMPLEMENTER_OUTPUT }] } });
      const a = adapter();
      const handle = await a.startTask(implementerSpec(f, { sessionId: GIVEN_SESSION }));
      expect(handle.sessionId).toBe(GIVEN_SESSION);
      expect(readPidRecord(f.workerDir)).toMatchObject({ sessionId: GIVEN_SESSION });
      const result = await collect(a, handle, f);
      expect(result.status).toBe('succeeded');
      expect(result.sessionId).toBe(GIVEN_SESSION);
      const call = JSON.parse(readFileSync(f.argvLog, 'utf8').trim().split('\n')[0]!) as { argv: string[] };
      expect(call.argv).toEqual(expect.arrayContaining(['--session-id', GIVEN_SESSION]));
    });

    it('derives the session id from the worker and its attempt when none is given', async () => {
      const f = fixture();
      writeScenario(f, { roles: { '*': [{ structured: IMPLEMENTER_OUTPUT }] } });
      const expected = nextSessionId('w1', f.workerDir);
      const a = adapter();
      const handle = await a.startTask(implementerSpec(f));
      expect(handle.sessionId).toBe(expected);
      expect(handle.sessionId).not.toBe(GIVEN_SESSION);
      expect((await collect(a, handle, f)).status).toBe('succeeded');
    });

    it('verifies the policy hash it is given instead of deriving one, and derives it only when absent', async () => {
      const f = fixture();
      writeScenario(f, { roles: { '*': [{ structured: IMPLEMENTER_OUTPUT }] } });
      const a = adapter();
      // A well-formed hash that is not the snapshot's: if the adapter silently re-derived, this would start.
      await expect(a.startTask(implementerSpec(f, { policyHash: `sha256:${'0'.repeat(64)}` }))).rejects.toMatchObject({ code: 'POLICY_TAMPERED' });
      expect(existsSync(join(f.workerDir, 'launch.json'))).toBe(false);

      const handle = await a.startTask(implementerSpec(f, { policyHash: undefined }));
      expect((await collect(a, handle, f)).status).toBe('succeeded');
    });
  });
});
