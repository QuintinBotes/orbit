/**
 * The process-level entries of the CLI, run in this process: `orbit hook`
 * (the fail-closed wrapper), the process entry main.ts, and the hidden
 * `check-runner` command. process.exit, the output streams and the handlers
 * a real process would install are replaced, so the effect of each path is
 * read from what the process was told to do.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryIo } from '../../../src/cli/io.ts';
import { createContext } from '../../../src/cli/context.ts';
import { EXIT } from '../../../src/cli/exit.ts';

const spawnMock = vi.hoisted(() => ({ impl: null as null | ((...a: unknown[]) => unknown) }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => (spawnMock.impl ? spawnMock.impl(...args) : (actual.spawn as (...a: unknown[]) => unknown)(...args)) };
});

const guard = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock('../../../src/policy/guard-hook.ts', () => ({ runGuardHookProcess: () => (guard.run ? guard.run() : Promise.resolve()) }));

const dirs: string[] = [];
let stdout = '';
let stderr = '';
let exits: number[] = [];
let handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
let savedExitCode: typeof process.exitCode;
let savedArgv: string[];
let savedEmitWarning: typeof process.emitWarning;

beforeEach(() => {
  stdout = '';
  stderr = '';
  exits = [];
  handlers = {};
  guard.run = null;
  spawnMock.impl = null;
  savedExitCode = process.exitCode;
  savedArgv = process.argv;
  savedEmitWarning = process.emitWarning;
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
    stdout += String(c);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => {
    stderr += String(c);
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
  }) as typeof process.exit);
  vi.spyOn(process, 'on').mockImplementation(((ev: string, fn: (...a: unknown[]) => void) => {
    (handlers[ev] ??= []).push(fn);
    return process;
  }) as typeof process.on);
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
  process.argv = savedArgv;
  process.emitWarning = savedEmitWarning;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function denyReason(): string {
  const j = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  expect(j.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  return j.hookSpecificOutput.permissionDecisionReason;
}

describe('hookMain', () => {
  it('blocks (exit 2, deny on stdout, reason on stderr) for any hook name but pre-tool-use', async () => {
    const { hookMain } = await import('../../../src/cli/hook.ts');
    await hookMain(['post-tool-use']);
    expect(denyReason()).toBe('Orbit guard failed closed: unknown hook "post-tool-use"; only pre-tool-use exists');
    expect(stderr).toBe('Orbit guard failed closed: unknown hook "post-tool-use"; only pre-tool-use exists\n');
    expect(exits).toEqual([2]);
    expect(process.exitCode).toBe(2);
  });

  it('names an absent hook as an empty string', async () => {
    const { hookMain } = await import('../../../src/cli/hook.ts');
    await hookMain([]);
    expect(denyReason()).toContain('unknown hook ""');
    expect(exits).toEqual([2]);
  });

  it('installs fail-closed handlers for uncaught errors and unhandled rejections before loading the guard', async () => {
    let seenAtGuard: string[] = [];
    guard.run = async () => {
      seenAtGuard = Object.keys(handlers);
    };
    const { hookMain } = await import('../../../src/cli/hook.ts');
    await hookMain(['pre-tool-use']);
    expect(seenAtGuard.sort()).toEqual(['uncaughtException', 'unhandledRejection']);
    // A guard that returns normally leaves the decision to the guard: nothing was blocked here.
    expect(exits).toEqual([]);
    expect(stdout).toBe('');
    expect(process.exitCode).toBe(2);

    handlers.uncaughtException![0]!(new Error('kaboom'));
    expect(denyReason()).toBe('Orbit guard failed closed: kaboom');
    expect(exits).toEqual([2]);
    stdout = '';
    handlers.unhandledRejection![0]!('plain string reason');
    expect(denyReason()).toBe('Orbit guard failed closed: plain string reason');
    expect(exits).toEqual([2, 2]);
  });

  it('fails closed with the guard\'s own error when the guard throws or rejects', async () => {
    guard.run = async () => {
      throw new Error('guard exploded');
    };
    const { hookMain } = await import('../../../src/cli/hook.ts');
    await hookMain(['pre-tool-use']);
    expect(denyReason()).toBe('Orbit guard failed closed: guard exploded');
    expect(exits).toEqual([2]);

    stdout = '';
    exits = [];
    guard.run = () => Promise.reject('not an error object');
    await hookMain(['pre-tool-use']);
    expect(denyReason()).toBe('Orbit guard failed closed: not an error object');
    expect(exits).toEqual([2]);
  });

  it('still ends the process with 2 when writing the deny decision itself fails', async () => {
    vi.mocked(process.stdout.write).mockImplementation((() => {
      throw new Error('EPIPE');
    }) as typeof process.stdout.write);
    const { hookMain } = await import('../../../src/cli/hook.ts');
    await expect(hookMain(['nope'])).rejects.toThrow('EPIPE');
    expect(exits).toEqual([2]);
  });
});

describe('main.ts (the process entry)', () => {
  it('dispatches `hook` before anything else loads, and fails closed on a bad hook', async () => {
    process.argv = ['node', '/x/orbit.mjs', 'hook', 'bogus'];
    await import('../../../src/cli/main.ts');
    expect(denyReason()).toContain('unknown hook "bogus"');
    expect(exits).toEqual([2]);
    expect(process.exitCode).toBe(2);
  });

  it('runs any other command through the command table and sets the exit code from it', async () => {
    process.argv = ['node', '/x/orbit.mjs', '--version'];
    process.exitCode = 9;
    await import('../../../src/cli/main.ts');
    expect(stdout).toBe('0.2.0\n');
    expect(process.exitCode).toBe(0);
  });

  it('turns a usage error into exit code 2 with the message on stderr', async () => {
    process.argv = ['node', '/x/orbit.mjs', 'frobnicate'];
    await import('../../../src/cli/main.ts');
    expect(stderr).toMatch(/orbit: unknown command "frobnicate"/);
    expect(process.exitCode).toBe(2);
  });

  it('filters the node:sqlite experimental warning and lets every other warning through', async () => {
    process.argv = ['node', '/x/orbit.mjs', '--version'];
    const seen: unknown[] = [];
    process.emitWarning = ((w: unknown) => void seen.push(w)) as typeof process.emitWarning;
    await import('../../../src/cli/main.ts');
    process.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning');
    process.emitWarning('something else', 'DeprecationWarning');
    expect(seen).toEqual(['something else']);
  });
});

describe('orbit shim and hook through the command table', () => {
  it('shim takes its arguments verbatim and reports a bad command line with exit code 2', async () => {
    const { main } = await import('../../../src/cli/cli.ts');
    const io = memoryIo();
    expect(await main(['shim', '--worker-dir', 'relative', '--', 'x'], { io })).toBe(2);
    expect(stderr).toBe('orbit shim: --worker-dir must be an absolute path\n');
    expect(io.stderr).toBe('');
  });

  it('hook returns the exit code the hook wrapper left on the process', async () => {
    const { main } = await import('../../../src/cli/cli.ts');
    expect(await main(['hook', 'bogus'], { io: memoryIo() })).toBe(2);
    expect(denyReason()).toContain('unknown hook "bogus"');
  });

  it('hook answers usage (2) when the wrapper left no exit code at all', async () => {
    guard.run = async () => {
      process.exitCode = undefined;
    };
    const { main } = await import('../../../src/cli/cli.ts');
    expect(await main(['hook', 'pre-tool-use'], { io: memoryIo() })).toBe(EXIT.USAGE);
  });
});

describe('orbit check-runner', () => {
  const ctx = () => createContext({ io: memoryIo() });

  function checkDirs() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-cr-')));
    dirs.push(base);
    const runDir = join(base, 'run');
    const checkDir = join(runDir, 'checks', 'unit');
    mkdirSync(checkDir, { recursive: true });
    return { base, runDir, checkDir };
  }

  const USAGE = 'usage: orbit check-runner <absolute run dir> <absolute check dir>\n';

  it.each([
    ['no arguments', []],
    ['one argument', ['/abs/run']],
    ['a relative run dir', ['run', '/abs/check']],
    ['a relative check dir', ['/abs/run', 'check']],
    ['an extra argument', ['/abs/run', '/abs/check', 'more']],
  ])('refuses %s with the usage line and exit code 2, creating nothing', async (_name, args) => {
    const { checkRunnerCommand } = await import('../../../src/cli/commands/internal.ts');
    const c = ctx();
    expect(await checkRunnerCommand(args, c)).toBe(EXIT.USAGE);
    expect((c.io as ReturnType<typeof memoryIo>).stderr).toBe(USAGE);
  });

  it('runs the check under the shim it writes beside the run and answers the shim\'s exit code', async () => {
    const { checkRunnerCommand } = await import('../../../src/cli/commands/internal.ts');
    const { runDir, checkDir } = checkDirs();
    writeFileSync(
      join(checkDir, 'intent.json'),
      JSON.stringify({ token: 't', checkRunId: 'c1', argv: [process.execPath, '-e', "console.log('ran')"], cwd: runDir, timeoutMs: 20_000, killGraceMs: 500, maxOutputBytes: 100_000, writtenAt: Date.now() }),
    );
    const c = ctx();
    const code = await checkRunnerCommand([runDir, checkDir], c);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(checkDir, 'exit.json'), 'utf8'))).toMatchObject({ token: 't', exitCode: 0, error: null });
    expect(readFileSync(join(checkDir, 'output.raw'), 'utf8')).toContain('ran');
    expect((c.io as ReturnType<typeof memoryIo>).stderr).toBe('');
  });

  it('creates the run directory when it does not exist yet', async () => {
    const { checkRunnerCommand } = await import('../../../src/cli/commands/internal.ts');
    const { base } = checkDirs();
    const runDir = join(base, 'fresh', 'run');
    const checkDir = join(runDir, 'c');
    spawnMock.impl = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    expect(await checkRunnerCommand([runDir, checkDir], ctx())).toBe(0);
    expect(readFileSync(join(runDir, 'check-shim.mjs'), 'utf8')).toMatch(/Generated by Orbit/);
  });

  it.each([
    ['its exit code', [3, null], 3],
    ['128 when a signal ended it', [null, 'SIGKILL'], 128],
    ['a plain failure when it reports neither', [null, null], EXIT.FAILURE],
  ] as const)('answers %s', async (_n, emitted, expected) => {
    const { checkRunnerCommand } = await import('../../../src/cli/commands/internal.ts');
    const { runDir, checkDir } = checkDirs();
    spawnMock.impl = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', ...emitted));
      return child;
    };
    expect(await checkRunnerCommand([runDir, checkDir], ctx())).toBe(expected);
  });

  it('says so and answers 1 when the shim process cannot be started', async () => {
    const { checkRunnerCommand } = await import('../../../src/cli/commands/internal.ts');
    const { runDir, checkDir } = checkDirs();
    spawnMock.impl = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    };
    const c = ctx();
    expect(await checkRunnerCommand([runDir, checkDir], c)).toBe(EXIT.FAILURE);
    expect((c.io as ReturnType<typeof memoryIo>).stderr).toBe('check-runner: cannot start the check shim: spawn ENOENT\n');
  });

  it('shimCommand is the worker shim with its arguments untouched', async () => {
    const { shimCommand } = await import('../../../src/cli/commands/internal.ts');
    expect(await shimCommand(['--timeout-ms', '5'])).toBe(2);
    expect(stderr).toMatch(/expected -- followed by the provider command/);
  });
});
