import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import {
  ENV_POLICY_HASH,
  ENV_POLICY_PATH,
  ENV_WORKTREE,
  handlePreToolUse,
  runGuardHook,
  runGuardHookProcess,
  type GuardOptions,
} from '../../../src/policy/guard-hook.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';

let base: string;
let wt: string;
let opts: GuardOptions;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'orbit-guard-cov-'));
  wt = join(base, 'wt');
  mkdirSync(join(wt, 'apps'), { recursive: true });
  const config = parseConfig('version: 1\nscope: {allowed_paths: ["apps/**"], protected_paths: [".github/**"]}\n');
  const { path, hash } = snapshotPolicy(config, { runId: 'orb-gc', repoRoot: base, runDir: join(base, 'run'), clock: new ManualClock() });
  opts = { snapshotPath: path, expectedHash: hash, worktreeRoot: wt, home: join(base, 'home') };
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function event(tool_name: string, tool_input: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ cwd: wt, hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra });
}

describe('handlePreToolUse input validation and tool coverage', () => {
  it('NotebookEdit falls back to file_path only when notebook_path is absent', () => {
    const ok = handlePreToolUse(event('NotebookEdit', { file_path: join(wt, 'apps', 'n.ipynb') }), opts);
    expect(ok).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    const malformed = handlePreToolUse(event('NotebookEdit', { notebook_path: 5, file_path: join(wt, 'apps', 'n.ipynb') }), opts);
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr).toContain('tool_input.notebook_path is missing');
    const neither = handlePreToolUse(event('NotebookEdit', {}), opts);
    expect(neither.exitCode).toBe(2);
  });

  it('refuses relative paths for every file tool, naming the path.relative rule', () => {
    for (const [tool, input] of [
      ['Edit', { file_path: 'apps/a.ts' }],
      ['Write', { file_path: './apps/a.ts' }],
      ['NotebookEdit', { notebook_path: 'n.ipynb' }],
      ['Read', { file_path: 'README.md' }],
    ] as const) {
      const r = handlePreToolUse(event(tool, input), opts);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/^Orbit policy \(path\.relative\): .* is not an absolute path$/);
    }
  });

  it('requires a non-empty string path or command', () => {
    for (const [tool, input, field] of [
      ['Edit', { file_path: '' }, 'file_path'],
      ['Write', {}, 'file_path'],
      ['Read', { file_path: 3 }, 'file_path'],
      ['Bash', { command: '' }, 'command'],
      ['Bash', {}, 'command'],
    ] as const) {
      const r = handlePreToolUse(event(tool, input), opts);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toBe(`Orbit guard failed closed: tool_input.${field} is missing`);
    }
  });

  it('rejects an event name, tool name, tool_input or cwd of the wrong shape', () => {
    const cases: Array<[string, RegExp]> = [
      [JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }), /expected a PreToolUse event, got "PostToolUse"/],
      [JSON.stringify({ tool_name: 'Read', tool_input: {} }), /expected a PreToolUse event, got undefined/],
      [JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: '', tool_input: {} }), /tool_name is missing/],
      [JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 7, tool_input: {} }), /tool_name is missing/],
      [JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: null }), /tool_input is missing/],
      [JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: [] }), /tool_input is missing/],
      [JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: 'x' }), /tool_input is missing/],
      [JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, cwd: 'rel/dir' }), /cwd is not an absolute path/],
      [JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, cwd: 5 }), /cwd is not an absolute path/],
      ['[1,2]', /not a JSON object/],
      ['null', /not a JSON object/],
      ['"str"', /not a JSON object/],
      ['{nope', /not valid JSON/],
      ['   \n', /empty/],
    ];
    for (const [text, message] of cases) {
      const r = handlePreToolUse(text, opts);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });

  it('rejects input over 5 MiB, and non-string input', () => {
    const big = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(wt, 'a'), pad: 'x'.repeat(5 * 1024 * 1024) } });
    expect(handlePreToolUse(big, opts).stderr).toMatch(/too large/);
    expect(handlePreToolUse(undefined as unknown as string, opts).stderr).toMatch(/empty/);
  });

  it('fails closed when options are missing entirely', () => {
    const r = handlePreToolUse(event('Read', { file_path: join(wt, 'a') }), undefined as unknown as GuardOptions);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/worktree root is not configured/);
  });

  it('works without a home or an input cwd', () => {
    const { home: _home, ...noHome } = opts;
    const r = handlePreToolUse(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(wt, 'apps', 'a.ts') } }), noHome);
    expect(r).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('stringifies a non-Error thrown value in the fail-closed message', () => {
    const throwing = { get worktreeRoot(): string { throw 'plain string failure'; } } as unknown as GuardOptions;
    expect(handlePreToolUse('{}', throwing).stderr).toBe('Orbit guard failed closed: plain string failure');
  });
});

describe('runGuardHook environment handling', () => {
  const env = (): Record<string, string | undefined> => ({ [ENV_POLICY_PATH]: opts.snapshotPath, [ENV_POLICY_HASH]: opts.expectedHash, [ENV_WORKTREE]: wt });

  it('names the first missing variable', () => {
    for (const name of [ENV_POLICY_PATH, ENV_POLICY_HASH, ENV_WORKTREE]) {
      const e = env();
      e[name] = '';
      const r = runGuardHook('{}', e);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toBe(`Orbit guard failed closed: ${name} is not set`);
    }
  });

  it('passes HOME through so credential locations under it are protected', () => {
    const home = join(base, 'home');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    const read = event('Read', { file_path: join(home, '.ssh', 'id_rsa') });
    const withHome = runGuardHook(read, { ...env(), HOME: home });
    expect(JSON.parse(withHome.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/^Orbit policy \(read\.credential\)/);
    // an empty HOME is treated as unset
    expect(runGuardHook(read, { ...env(), HOME: '' }).exitCode).toBe(0);
  });

  it('fails closed (not throws) on an env object that throws on access', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('env exploded'); } }) as Record<string, string | undefined>;
    expect(runGuardHook('{}', hostile)).toMatchObject({ exitCode: 2, stderr: 'Orbit guard failed closed: env exploded' });
  });
});

describe('runGuardHookProcess (in-process entry point)', () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  const savedExit = process.exitCode;
  const savedEnv = { ...process.env };

  afterEach(() => {
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    process.exitCode = savedExit;
    for (const k of [ENV_POLICY_PATH, ENV_POLICY_HASH, ENV_WORKTREE]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
  });

  function arrange(chunks: Array<string | Buffer>, withEnv = true): { out: string[]; err: string[]; handlers: Array<(e: Error) => void> } {
    Object.defineProperty(process, 'stdin', { value: Readable.from(chunks, { objectMode: false }), configurable: true });
    if (withEnv) {
      process.env[ENV_POLICY_PATH] = opts.snapshotPath;
      process.env[ENV_POLICY_HASH] = opts.expectedHash;
      process.env[ENV_WORKTREE] = wt;
    } else {
      for (const k of [ENV_POLICY_PATH, ENV_POLICY_HASH, ENV_WORKTREE]) delete process.env[k];
    }
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => (out.push(String(s)), true)) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => (err.push(String(s)), true)) as never);
    const handlers: Array<(e: Error) => void> = [];
    vi.spyOn(process, 'once').mockImplementation(((name: string, fn: (e: Error) => void) => {
      if (name === 'uncaughtException') handlers.push(fn);
      return process;
    }) as never);
    return { out, err, handlers };
  }

  it('allows silently: exit code 0 and nothing written', async () => {
    const io = arrange([event('Read', { file_path: join(wt, 'apps', 'a.ts') })]);
    await runGuardHookProcess();
    expect(process.exitCode).toBe(0);
    expect(io.out).toEqual([]);
    expect(io.err).toEqual([]);
  });

  it('joins stdin chunks (strings and buffers, split mid-character) before parsing', async () => {
    const text = event('Write', { file_path: join(wt, 'docs', 'ä.md'), content: '' });
    const bytes = Buffer.from(text);
    const cut = bytes.indexOf(Buffer.from('ä')) + 1;
    const io = arrange([bytes.subarray(0, cut), bytes.subarray(cut)]);
    await runGuardHookProcess();
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(io.out[0]!).hookSpecificOutput.permissionDecisionReason).toContain('scope.not-allowed');
  });

  it('accepts string chunks from a stdin that has an encoding set', async () => {
    const io = arrange([]);
    const stream = Readable.from([event('Read', { file_path: join(wt, 'apps', 'a.ts') })], { objectMode: true });
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
    await runGuardHookProcess();
    expect(process.exitCode).toBe(0);
    expect(io.out).toEqual([]);
  });

  it('writes a deny decision on stdout and still exits 0', async () => {
    const io = arrange([event('Bash', { command: 'git push origin HEAD' })]);
    await runGuardHookProcess();
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(io.out.join('')).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(io.err).toEqual([]);
  });

  it('exits 2 with reason on stderr and deny JSON on stdout when the environment is missing', async () => {
    const io = arrange([event('Read', { file_path: join(wt, 'a') })], false);
    await runGuardHookProcess();
    expect(process.exitCode).toBe(2);
    expect(io.err).toEqual([`Orbit guard failed closed: ${ENV_POLICY_PATH} is not set\n`]);
    expect(JSON.parse(io.out.join('')).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('exits 2 for an oversized stdin before parsing anything', async () => {
    const chunk = Buffer.alloc(3 * 1024 * 1024, 0x20);
    const io = arrange([chunk, chunk]);
    await runGuardHookProcess();
    expect(process.exitCode).toBe(2);
    expect(io.err.join('')).toContain('hook input is too large');
  });

  it('exits 2 when reading stdin fails', async () => {
    const io = arrange([]);
    const broken = new Readable({
      read() {
        this.destroy(new Error('stdin broke'));
      },
    });
    Object.defineProperty(process, 'stdin', { value: broken, configurable: true });
    await runGuardHookProcess();
    expect(process.exitCode).toBe(2);
    expect(io.err.join('')).toContain('stdin broke');
  });

  it('exits 2 on empty stdin', async () => {
    const io = arrange([]);
    await runGuardHookProcess();
    expect(process.exitCode).toBe(2);
    expect(io.err.join('')).toContain('hook input is empty');
  });

  it('installs an uncaughtException handler that fails closed with exit 2, even if writing throws', async () => {
    const io = arrange([event('Read', { file_path: join(wt, 'apps', 'a.ts') })]);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runGuardHookProcess();
    expect(io.handlers).toHaveLength(1);
    io.handlers[0]!(new Error('boom'));
    expect(exit).toHaveBeenCalledWith(2);
    expect(JSON.parse(io.out.at(-1)!).hookSpecificOutput.permissionDecisionReason).toBe('Orbit guard failed closed: boom');
    expect(io.err.at(-1)).toBe('Orbit guard failed closed: boom\n');

    exit.mockClear();
    vi.mocked(process.stdout.write).mockImplementation((() => {
      throw new Error('stdout closed');
    }) as never);
    expect(() => io.handlers[0]!(new Error('again'))).toThrow('stdout closed');
    expect(exit).toHaveBeenCalledWith(2);
  });
});
