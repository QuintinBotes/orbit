import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import { outputBudgetInstruction } from '../../../src/adapters/prompt.ts';
import { DEFAULT_OUTPUT_BUDGETS } from '../../../src/policy/config.ts';
import { LOG_FILE, macProcesses, readExitRecord, readPidRecord } from '../../../src/adapters/shim.ts';
import { archiveAttempt, nextSessionId } from '../../../src/adapters/supervise.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { canonicalPath } from '../../../src/isolation/util.ts';
import type { IsolationProvider, SandboxProfile } from '../../../src/isolation/types.ts';
import { FAKE_CLAUDE, IMPLEMENTER_OUTPUT, alive, implementerSpec, makeFixture, waitFor, writeScenario, type Fixture } from './helpers.ts';

// The shim and fake-claude run as real detached processes; the shim runs from
// source, which needs Node's type stripping.
const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
// This uses macOS's real process table to prove that a child created a new
// session. Restricted test sandboxes can deny `ps`, where exercising that
// lifecycle would be misleading, so skip there as well as on other platforms.
const macProcessTableAvailable =
  process.platform === 'darwin' && spawnSync('ps', ['-A', '-o', 'pid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).status === 0;

const fixtures: Fixture[] = [];
const detachedPids: number[] = [];
function fixture(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}
function stopDetached(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already stopped by the shim */
  }
}
afterEach(() => {
  for (const pid of detachedPids.splice(0)) stopDetached(pid);
  for (const f of fixtures.splice(0)) {
    const detachedPidPath = join(f.base, 'detached.pid');
    if (existsSync(detachedPidPath)) stopDetached(Number(readFileSync(detachedPidPath, 'utf8').trim()));
    rmSync(f.base, { recursive: true, force: true });
  }
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
  it('resolves $CANDIDATE and $FINGERPRINT in the scenario from the prompt, in structured output and edits, and leaves them alone when the prompt has none', async () => {
    const f = fixture();
    const sha = '0123456789abcdef0123456789abcdef01234567';
    writeScenario(f, { roles: { implementer: [{ edits: [{ op: 'write', path: 'apps/note.txt', content: 'for $CANDIDATE' }], structured: { ...IMPLEMENTER_OUTPUT, summary: 'rev $CANDIDATE fp $FINGERPRINT' } }] } });
    const a = adapter();
    const spec = implementerSpec(f, { prompt: `Review.\n- revision: ${sha}\nFailure fingerprint: fp-test-1\n` });
    const result = await collect(a, await a.startTask(spec), f);
    expect(result.status).toBe('succeeded');
    expect((result.structured as { summary: string }).summary).toBe(`rev ${sha} fp fp-test-1`);
    expect(readFileSync(join(f.repo, 'apps', 'note.txt'), 'utf8')).toBe(`for ${sha}`);

    archiveAttempt('claude', f.workerDir);
    const bare = await collect(a, await a.startTask(implementerSpec(f, { prompt: 'No identifiers here.', sessionId: nextSessionId('w1', f.workerDir) })), f);
    expect((bare.structured as { summary: string }).summary).toBe('rev $CANDIDATE fp $FINGERPRINT');
  });

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
    expect(call.promptBytes).toBe(`Change apps/a.ts.\n\n${outputBudgetInstruction(DEFAULT_OUTPUT_BUDGETS.implementer)}\n`.length);
    expect(call.argv).toEqual(expect.arrayContaining(['--session-id', handle.sessionId, '--permission-mode', 'dontAsk', '--strict-mcp-config']));

    const { events, nextOffset } = await a.streamEvents(handle, 0);
    expect(events[0]?.type).toBe('started');
    expect(events.some((e) => e.type === 'tool')).toBe(true);
    expect(events.at(-1)?.type).toBe('finished');
    expect((await a.streamEvents(handle, nextOffset)).events).toEqual([]);
  });

  it.skipIf(!macProcessTableAvailable)('ends a real detached child before collecting the worker result, so it cannot keep writing the worktree', async () => {
    const f = fixture();
    const pidFile = join(f.base, 'detached.pid');
    const markerPath = join(f.base, 'detached.started');
    const writePath = join(f.repo, 'apps', 'detached.txt');
    writeScenario(
      f,
      {
        roles: {
          implementer: [
            {
              detachedChild: { pidFile, markerPath, writePath, waitMs: 500, intervalMs: 20 },
              structured: IMPLEMENTER_OUTPUT,
            },
          ],
        },
      },
    );
    const a = adapter();
    const handle = await a.startTask(implementerSpec(f));
    const detached = Number(await waitFor(() => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() || null : null)));
    detachedPids.push(detached);
    await waitFor(() => (existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() || null : null));
    const detachedProcess = macProcesses()?.find((entry) => entry.pid === detached);
    // Node's detached option creates a new session and therefore a new group.
    expect(detachedProcess).toMatchObject({ pid: detached, pgid: detached });
    expect(detachedProcess?.pgid).not.toBe(handle.pgid);
    expect(readFileSync(writePath, 'utf8').length).toBeGreaterThan(0);

    const result = await collect(a, handle, f);
    expect(result.status).toBe('succeeded');
    await waitFor(() => (!alive(detached) ? true : null), 10_000);
    const settled = readFileSync(writePath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readFileSync(writePath, 'utf8')).toBe(settled);
  }, 30_000);

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
    // startTask returns once the shim has spawned the provider, not once the provider has started: the count below needs its argv line to exist.
    await waitFor(() => existsSync(f.argvLog) || null);
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
    // SIGINT ends the turn only once the provider is up: before it installs its handler the signal ends the process (code null, signal SIGINT).
    // The init line is written after the handler is installed, so it marks the provider as ready for the signal.
    await waitFor(() => (existsSync(join(f.workerDir, LOG_FILE)) && readFileSync(join(f.workerDir, LOG_FILE), 'utf8').includes('"subtype":"init"')) || null);
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

  it('puts the CLI\'s stderr into the error of a run that ended without a transcript, redacted, so the block names the real cause', async () => {
    // P13: "exited 1 without a result line" alone hid "An unknown error occurred (Unexpected)", which was in stderr.log only.
    const f = fixture();
    writeScenario(f, { roles: { '*': [{ outcome: 'acme-unexpected key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }] } });
    const a = adapter();
    const result = await collect(a, await a.startTask(implementerSpec(f)), f);
    expect(result).toMatchObject({ status: 'failed', reason: 'crashed', exitCode: 1 });
    expect(result.error).toMatch(/^exited 1 without a result line; stderr: fake-claude: unknown outcome acme-unexpected key=/);
    expect(result.error).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
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

  // Issue #31: neither sandbox can limit a listener to loopback on macOS (srt's and Claude Code's allowLocalBinding admit
  // every address of the machine, measured), and a worker runs model-driven commands, so no Claude worker may listen, in
  // either tier, whatever profile a caller hands the adapter.
  it('never lets a Claude worker listen, in either tier, even when the profile it is given asks for it', async () => {
    const roles: [string, { readOnly: boolean; experiments?: boolean }][] = [
      ['implementer', { readOnly: false }],
      ['diagnosis', { readOnly: true, experiments: true }],
      ['reviewer', { readOnly: true }],
    ];
    for (const [role, grant] of roles) {
      const f = fixture();
      writeScenario(f, { roles: { '*': [{ structured: IMPLEMENTER_OUTPUT }] } });
      const cs = adapter();
      await collect(cs, await cs.startTask(implementerSpec(f, { ...grant, sandbox: { ...implementerSpec(f).sandbox, allowLocalBinding: true } })), f);
      const settings = JSON.parse(readFileSync(join(f.workerDir, 'settings.json'), 'utf8')) as { sandbox: { network: { allowLocalBinding: boolean } } };
      expect(settings.sandbox.network.allowLocalBinding, `${role} claude-sandbox`).toBe(false);

      const seen: SandboxProfile[] = [];
      const none = new NoIsolation();
      const recording: IsolationProvider = { kind: 'sandbox-runtime', available: async () => ({ ok: true, detail: 'recording' }), wrap: (argv, profile, o) => (seen.push(profile), none.wrap(argv, profile, o)) };
      const g = fixture();
      writeScenario(g, { roles: { '*': [{ structured: IMPLEMENTER_OUTPUT }] } });
      const os = adapter({ tier: 'os-sandbox', isolation: recording });
      const handle = await os.startTask(implementerSpec(g, { ...grant, sandbox: { ...implementerSpec(g).sandbox, allowLocalBinding: true } }));
      expect(handle.tier).toBe('os-sandbox');
      await collect(os, handle, g);
      expect(seen.map((p) => p.allowLocalBinding === true), `${role} os-sandbox`).toEqual([false]);
      expect(JSON.parse(readFileSync(join(g.workerDir, 'settings.json'), 'utf8')).sandbox).toEqual({ enabled: false });
    }
  });

  // Review of #31: the IDE lock directory of the config dir the CLI runs with (CLAUDE_CONFIG_DIR, else ~/.claude) holds
  // the token of an IDE extension's MCP server on loopback; Read must not reach it in either tier.
  it('denies Read on the IDE lock directory of every Claude login the worker CLI knows of', async () => {
    const home = canonicalPath(process.env.HOME!);
    for (const custom of [false, true]) {
      const f = fixture();
      const dir = custom ? join(f.base, 'claude-acme') : join(home, '.claude');
      writeScenario(f, { roles: { '*': [{ structured: IMPLEMENTER_OUTPUT }] } });
      const a = adapter({ baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: 'sk-ant-fake-000', ...(custom ? { CLAUDE_CONFIG_DIR: dir } : {}) } });
      await collect(a, await a.startTask(implementerSpec(f)), f);
      const deny = (JSON.parse(readFileSync(join(f.workerDir, 'settings.json'), 'utf8')) as { permissions: { deny: string[] } }).permissions.deny;
      expect(deny, dir).toContain(`Read(/${dir}/ide/**)`);
      // Final review: with a config dir of its own, the default login (where Claude Code also looks for IDE lock files) is denied whole.
      if (custom) expect(deny, dir).toEqual(expect.arrayContaining([`Read(/${home}/.claude/**)`, `Read(/${home}/.claude.json)`]));
      else expect(deny.filter((r) => r.startsWith(`Read(/${home}/.claude`)), dir).toEqual([`Read(/${home}/.claude/ide/**)`]);
    }
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
