import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';

const procMock = vi.hoisted(() => ({
  isAlive: vi.fn<(pid: number, start?: string | null) => boolean>(),
  isGroupAlive: vi.fn<(pgid: number) => boolean>(),
  processStartTime: vi.fn<(pid: number) => string | null>(),
  terminateGroup: vi.fn<(pgid: number, graceMs: number, opts?: unknown) => Promise<unknown>>(),
}));
const execMock = vi.hoisted(() => ({ spawnDetached: vi.fn<(argv: readonly string[], opts: Record<string, unknown>) => { pid: number; pgid: number }>() }));

vi.mock('../../../src/core/proc.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/core/proc.ts')>()), ...procMock }));
vi.mock('../../../src/core/exec.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/core/exec.ts')>()), ...execMock }));

const {
  ATTEMPT_FILES,
  CANCEL_FILE,
  LAUNCH_FILE,
  archiveAttempt,
  archivedAttempts,
  cancelShim,
  handleFromWorkerDir,
  launchShim,
  nextSessionId,
  parseJsonLines,
  readLogLines,
  readNewLines,
  reattachLaunch,
  recordLaunchMeta,
  sessionIdFor,
  taskState,
  timeToFirstEventMs,
  withWorkerTelemetry,
} = await import('../../../src/adapters/supervise.ts');
const { EXIT_FILE, LOG_FILE, PID_FILE } = await import('../../../src/adapters/shim.ts');

const dirs: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-sup-')));
  dirs.push(d);
  return d;
}

const pidRecord = (over: Record<string, unknown> = {}) => ({ version: 1, shimPid: 4242, shimStart: 'start-a', pgid: 4242, childPid: 4343, childStart: 'start-b', sessionId: null, argvHash: 'sha256:x', startedAt: 1, ...over });
const exitRecord = (over: Record<string, unknown> = {}) => ({ version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 1_000, firstOutputAt: 1_250, endedAt: 2_000, ...over });

beforeEach(() => {
  procMock.isAlive.mockReset().mockReturnValue(false);
  procMock.isGroupAlive.mockReset().mockReturnValue(false);
  procMock.processStartTime.mockReset().mockReturnValue('start-a');
  procMock.terminateGroup.mockReset().mockResolvedValue({});
  execMock.spawnDetached.mockReset().mockReturnValue({ pid: 4242, pgid: 4242 });
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeJson(dir: string, file: string, value: unknown): void {
  writeFileSync(join(dir, file), JSON.stringify(value));
}

describe('launchShim', () => {
  const input = (dir: string, over: Record<string, unknown> = {}) => ({
    provider: 'claude',
    workerId: 'wrk-1',
    workerDir: join(dir, 'w'),
    cwd: dir,
    shimCommand: ['node', 'orbit.mjs', 'shim'],
    argv: ['claude', '-p'],
    env: { PATH: '/usr/bin' },
    timeoutMs: 1000,
    clock: new ManualClock(),
    ...over,
  });

  it('records the intent, spawns the shim, notes its identity and returns the handle once pid.json appears', async () => {
    const dir = tmp();
    execMock.spawnDetached.mockImplementation((_argv, opts) => {
      writeJson(join(dir, 'w'), PID_FILE, pidRecord());
      expect(opts.stdoutPath).toBe(join(dir, 'w', 'shim.log'));
      return { pid: 4242, pgid: 4242 };
    });
    const handle = await launchShim(input(dir, { meta: { tier: 'os-sandbox' }, sessionId: 'sess-1', stdinPath: '/p/prompt.md' }));
    expect(handle).toMatchObject({ provider: 'claude', workerId: 'wrk-1', pid: 4242, pgid: 4242, procStart: 'start-a' });
    const launch = JSON.parse(readFileSync(join(dir, 'w', LAUNCH_FILE), 'utf8'));
    expect(launch).toMatchObject({ workerId: 'wrk-1', sessionId: 'sess-1', pid: 4242, procStart: 'start-a', meta: { tier: 'os-sandbox' } });
    const argv = execMock.spawnDetached.mock.calls[0]![0];
    expect(argv.slice(0, 3)).toEqual(['node', 'orbit.mjs', 'shim']);
    expect(argv).toContain('--stdin');
    expect(argv.slice(-3)).toEqual(['--', 'claude', '-p']);
  });

  it('copes with a start time it cannot read, and with a launch that carries no meta', async () => {
    const dir = tmp();
    procMock.processStartTime.mockImplementation(() => {
      throw new Error('no ps');
    });
    execMock.spawnDetached.mockImplementation(() => {
      writeJson(join(dir, 'w'), PID_FILE, pidRecord());
      return { pid: 4242, pgid: 4242 };
    });
    await launchShim(input(dir));
    const launch = JSON.parse(readFileSync(join(dir, 'w', LAUNCH_FILE), 'utf8'));
    expect(launch.procStart).toBeNull();
    expect(launch.meta).toBeUndefined();
    expect(launch.sessionId).toBeNull();
  });

  it('fails with a pointer to the shim log when the shim dies before writing pid.json', async () => {
    const dir = tmp();
    procMock.isAlive.mockReturnValue(false);
    try {
      await launchShim(input(dir));
      expect.unreachable();
    } catch (err) {
      expect(isOrbitError(err, 'PROVIDER_UNAVAILABLE')).toBe(true);
      expect((err as Error).message).toContain(join(dir, 'w', 'shim.log'));
    }
  });

  it('gives up waiting for a shim that stays alive but silent, after the wait budget', async () => {
    const dir = tmp();
    procMock.isAlive.mockReturnValue(true);
    const clock = new ManualClock();
    await expect(launchShim(input(dir, { clock }))).rejects.toThrow(/did not start/);
    expect(clock.now()).toBeGreaterThanOrEqual(1_700_000_000_000 + 15_000);
  });

  it('reattaches instead of spawning a second shim when a launch is already recorded', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'w'), { recursive: true });
    writeJson(join(dir, 'w'), LAUNCH_FILE, { version: 1, provider: 'claude', workerId: 'wrk-1' });
    writeJson(join(dir, 'w'), PID_FILE, pidRecord());
    procMock.isAlive.mockReturnValue(true);
    const handle = await launchShim(input(dir));
    expect(handle.pid).toBe(4242);
    expect(execMock.spawnDetached).not.toHaveBeenCalled();
  });
});

describe('reattachLaunch and handles', () => {
  it('refuses a launch whose task has ended or whose files are missing', async () => {
    const dir = tmp();
    writeJson(dir, PID_FILE, pidRecord());
    writeJson(dir, EXIT_FILE, exitRecord());
    await expect(reattachLaunch('claude', dir, 'wrk-1', new ManualClock())).rejects.toMatchObject({ code: 'TRANSITION_INVALID' });
    const empty = tmp();
    await expect(reattachLaunch('claude', empty, 'wrk-2', new ManualClock())).rejects.toMatchObject({ code: 'TRANSITION_INVALID' });
  });

  it('builds a handle from pid.json alone, with an empty worker id when no launch was recorded', () => {
    const dir = tmp();
    expect(handleFromWorkerDir('codex', dir)).toBeNull();
    writeJson(dir, PID_FILE, pidRecord());
    expect(handleFromWorkerDir('codex', dir)).toMatchObject({ provider: 'codex', workerId: '', pid: 4242, logPath: join(dir, LOG_FILE), exitPath: join(dir, EXIT_FILE) });
    writeJson(dir, LAUNCH_FILE, { workerId: 'wrk-9' });
    expect(handleFromWorkerDir('codex', dir)?.workerId).toBe('wrk-9');
  });

  it('adds reporting facts to a launch record only when one exists', () => {
    const dir = tmp();
    recordLaunchMeta(dir, { tier: 'x' });
    expect(existsSync(join(dir, LAUNCH_FILE))).toBe(false);
    writeJson(dir, LAUNCH_FILE, { version: 1, workerId: 'w' });
    recordLaunchMeta(dir, { tier: 'x' });
    expect(JSON.parse(readFileSync(join(dir, LAUNCH_FILE), 'utf8')).meta).toEqual({ tier: 'x' });
  });
});

describe('telemetry', () => {
  it('measures time to first output only from a complete record', () => {
    expect(timeToFirstEventMs(null)).toBeNull();
    expect(timeToFirstEventMs(exitRecord() as never)).toBe(250);
    expect(timeToFirstEventMs(exitRecord({ firstOutputAt: null }) as never)).toBeNull();
    expect(timeToFirstEventMs(exitRecord({ startedAt: 'x' }) as never)).toBeNull();
    expect(timeToFirstEventMs(exitRecord({ firstOutputAt: 500 }) as never)).toBe(0);
  });

  it('attaches latency and the launch budget to a usage report', () => {
    const dir = tmp();
    const usage = { provider: 'claude', model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, costSource: 'unavailable' as const };
    expect(withWorkerTelemetry(usage, dir)).toMatchObject({ timeToFirstEventMs: null, outputBudgetTokens: null });
    writeJson(dir, LAUNCH_FILE, { meta: { outputBudgetTokens: 4000 } });
    writeJson(dir, EXIT_FILE, exitRecord());
    expect(withWorkerTelemetry(usage, dir)).toMatchObject({ timeToFirstEventMs: 250, outputBudgetTokens: 4000 });
    writeJson(dir, LAUNCH_FILE, { meta: { outputBudgetTokens: 'lots' } });
    expect(withWorkerTelemetry(usage, dir).outputBudgetTokens).toBeNull();
  });
});

describe('taskState', () => {
  const handle = (dir: string) => ({ workerDir: dir, pid: 4242, pgid: 4242, procStart: 'start-a' });

  it('reports exited, running, and a record that appeared between the two reads', () => {
    const dir = tmp();
    writeJson(dir, PID_FILE, pidRecord());
    procMock.isAlive.mockReturnValue(true);
    expect(taskState(handle(dir)).state).toBe('running');
    writeJson(dir, EXIT_FILE, exitRecord());
    expect(taskState(handle(dir)).state).toBe('exited');

    const late = tmp();
    writeJson(late, PID_FILE, pidRecord());
    procMock.isAlive.mockImplementation(() => {
      writeJson(late, EXIT_FILE, exitRecord());
      return false;
    });
    expect(taskState(handle(late)).state).toBe('exited');
  });

  it('reports a lost task and whether anything of it is still running', () => {
    const dir = tmp();
    writeJson(dir, PID_FILE, pidRecord());
    procMock.isAlive.mockReturnValue(false);
    expect(taskState(handle(dir))).toMatchObject({ state: 'lost', orphans: false, cancelRequested: false });
    // The provider child outlived the shim.
    procMock.isAlive.mockImplementation((pid) => pid === 4343);
    expect(taskState(handle(dir))).toMatchObject({ state: 'lost', orphans: true });
    // Only helpers in the group remain.
    procMock.isAlive.mockReturnValue(false);
    procMock.isGroupAlive.mockReturnValue(true);
    expect(taskState(handle(dir))).toMatchObject({ orphans: true });
    writeJson(dir, CANCEL_FILE, { version: 1 });
    expect(taskState(handle(dir))).toMatchObject({ cancelRequested: true });
    // Without a pid record there is no child to look for.
    const bare = tmp();
    procMock.isGroupAlive.mockReturnValue(false);
    expect(taskState(handle(bare))).toMatchObject({ state: 'lost', pid: null, orphans: false });
  });

  it('keeps treating the task as running, and as orphaned, when the process table cannot be read', () => {
    const dir = tmp();
    writeJson(dir, PID_FILE, pidRecord());
    procMock.isAlive.mockImplementation(() => {
      throw new Error('ps failed');
    });
    expect(taskState(handle(dir)).state).toBe('running');
    // Shim readable as dead through a first call, then the table fails for the child and the group.
    let calls = 0;
    procMock.isAlive.mockImplementation(() => {
      if (calls++ === 0) return false;
      throw new Error('ps failed');
    });
    expect(taskState(handle(dir))).toMatchObject({ state: 'lost', orphans: true });
    procMock.isAlive.mockReset().mockReturnValueOnce(false);
    procMock.isGroupAlive.mockImplementation(() => {
      throw new Error('ps failed');
    });
    const noChild = tmp();
    writeJson(noChild, PID_FILE, pidRecord({ childPid: null }));
    procMock.isAlive.mockReturnValue(false);
    expect(taskState(handle(noChild))).toMatchObject({ orphans: true });
  });
});

describe('cancelShim', () => {
  const handle = (dir: string) => ({ provider: 'claude', workerId: 'w', workerDir: dir, pid: 4242, pgid: 4242, procStart: 'start-a', logPath: '', exitPath: '' });

  it('writes the intent once and signals the group only while something of the task is provably alive', async () => {
    const dir = tmp();
    writeJson(dir, PID_FILE, pidRecord());
    procMock.isAlive.mockReturnValue(true);
    procMock.isGroupAlive.mockReturnValue(true);
    await cancelShim(handle(dir), 50, new ManualClock());
    expect(procMock.terminateGroup).toHaveBeenCalledTimes(1);
    const first = readFileSync(join(dir, CANCEL_FILE), 'utf8');
    await cancelShim(handle(dir), 50, new ManualClock(1));
    expect(readFileSync(join(dir, CANCEL_FILE), 'utf8')).toBe(first);
  });

  it('does nothing when nothing of the task is alive, or its group is already gone', async () => {
    const dir = tmp();
    await cancelShim(handle(dir), 50, new ManualClock());
    expect(procMock.terminateGroup).not.toHaveBeenCalled();
    writeJson(dir, PID_FILE, pidRecord());
    procMock.isAlive.mockReturnValue(true);
    procMock.isGroupAlive.mockReturnValue(false);
    await cancelShim(handle(dir), 50, new ManualClock());
    expect(procMock.terminateGroup).not.toHaveBeenCalled();
  });

  it('signals a leftover group only with proof, and never when the process table fails', async () => {
    const dir = tmp();
    writeJson(dir, PID_FILE, pidRecord({ childPid: null }));
    procMock.isAlive.mockReturnValue(false);
    procMock.isGroupAlive.mockReturnValue(true);
    await cancelShim(handle(dir), 50, new ManualClock());
    expect(procMock.terminateGroup).toHaveBeenCalledTimes(1);
    procMock.terminateGroup.mockClear();
    procMock.isAlive.mockImplementation(() => {
      throw new Error('ps failed');
    });
    await cancelShim(handle(dir), 50, new ManualClock());
    expect(procMock.terminateGroup).not.toHaveBeenCalled();
    // The child's liveness is unknown, which reads as alive; the group is checked next.
    writeJson(dir, PID_FILE, pidRecord());
    procMock.isGroupAlive.mockReturnValue(false);
    await cancelShim(handle(dir), 50, new ManualClock());
    expect(procMock.terminateGroup).not.toHaveBeenCalled();
  });
});

describe('log reading', () => {
  it('parses JSON lines, keeps malformed ones short, and flags a garbage tail', () => {
    const long = `{${'x'.repeat(300)}`;
    const parsed = parseJsonLines(`{"a":1}\n\n  {"b":2}  \nnot json\n[1,2]\n${long}\n`);
    expect(parsed.events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parsed.malformed).toHaveLength(3);
    expect(parsed.malformed[2]).toHaveLength(203);
    expect(parsed.malformedTail).toBe(true);
    expect(parseJsonLines('{"a":1}\n{"b":2}').malformedTail).toBe(false);
    expect(parseJsonLines('').events).toEqual([]);
  });

  it('reads a whole log file, and nothing from a missing one', () => {
    const dir = tmp();
    expect(readLogLines(join(dir, 'missing.jsonl')).events).toEqual([]);
    writeFileSync(join(dir, 'log.jsonl'), '{"a":1}\ngarbage\n');
    const log = readLogLines(join(dir, 'log.jsonl'));
    expect(log.events).toEqual([{ a: 1 }]);
    expect(log.malformedTail).toBe(true);
  });

  it('returns only complete new lines and leaves a partial tail for the next call', () => {
    const dir = tmp();
    const file = join(dir, 'log.jsonl');
    expect(readNewLines(file, 0)).toEqual({ lines: [], nextOffset: 0 });
    writeFileSync(file, '{"a":1}\n{"b":');
    const first = readNewLines(file, 0);
    expect(first).toEqual({ lines: [{ a: 1 }], nextOffset: 8 });
    expect(readNewLines(file, 8)).toEqual({ lines: [], nextOffset: 8 });
    writeFileSync(file, '{"a":1}\n{"b":2}\n[3]\nplain\n');
    const second = readNewLines(file, 8);
    expect(second.lines).toEqual([{ b: 2 }]);
    expect(second.nextOffset).toBe(file.length === 0 ? 0 : 8 + '{"b":2}\n[3]\nplain\n'.length);
    expect(readNewLines(file, second.nextOffset)).toEqual({ lines: [], nextOffset: second.nextOffset });
  });
});

describe('archiving attempts', () => {
  it('refuses while the task runs or while its provider survives a dead shim', () => {
    const dir = tmp();
    writeJson(dir, PID_FILE, pidRecord());
    procMock.isAlive.mockReturnValue(true);
    expect(() => archiveAttempt('claude', dir)).toThrow(/still running/);
    procMock.isAlive.mockImplementation((pid) => pid === 4343);
    expect(() => archiveAttempt('claude', dir)).toThrow(/provider process is still running/);
  });

  it('moves every attempt file into numbered folders, and does nothing for an empty directory', () => {
    const dir = tmp();
    expect(archiveAttempt('claude', dir)).toBeNull();
    writeJson(dir, PID_FILE, pidRecord());
    writeJson(dir, EXIT_FILE, exitRecord());
    writeFileSync(join(dir, 'prompt.md'), 'p');
    writeFileSync(join(dir, 'keep.txt'), 'k');
    const first = archiveAttempt('claude', dir)!;
    expect(first).toBe(join(dir, 'attempts', '1'));
    expect(existsSync(join(first, 'prompt.md'))).toBe(true);
    expect(existsSync(join(dir, PID_FILE))).toBe(false);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
    expect(archivedAttempts(dir)).toBe(1);
    writeFileSync(join(dir, 'prompt.md'), 'q');
    expect(archiveAttempt('claude', dir)).toBe(join(dir, 'attempts', '2'));
    expect(archivedAttempts(dir)).toBe(2);
    expect(ATTEMPT_FILES).toContain('result.json');
  });
});

describe('session ids', () => {
  it('derive per worker and attempt, and advance with each archived attempt', () => {
    const dir = tmp();
    expect(sessionIdFor('wrk-1')).toBe(sessionIdFor('wrk-1', 0));
    expect(sessionIdFor('wrk-1', 1)).not.toBe(sessionIdFor('wrk-1', 0));
    expect(nextSessionId('wrk-1', dir)).toBe(sessionIdFor('wrk-1', 0));
    mkdirSync(join(dir, 'attempts', '1'), { recursive: true });
    expect(nextSessionId('wrk-1', dir)).toBe(sessionIdFor('wrk-1', 1));
  });
});
