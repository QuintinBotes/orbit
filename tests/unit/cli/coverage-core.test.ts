/** The CLI's own plumbing: dispatch and error reporting, argument parsing, exit codes, output helpers and the context. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS, commandHelp, exitCodesText, helpText, main, type CommandDef } from '../../../src/cli/cli.ts';
import { Args, GLOBAL_OPTIONS, parseCommand } from '../../../src/cli/args.ts';
import { EXIT, UsageError, exitCodeFor, exitCodeForState } from '../../../src/cli/exit.ts';
import { ago, createIo, iso, json, line, memoryIo, oneLine, table } from '../../../src/cli/io.ts';
import {
  CONTROLLER_STALE_MS,
  controllers,
  createContext,
  findRunByPrefix,
  gitEnv,
  liveLease,
  liveServiceController,
  openState,
  resolveRepo,
  withCliLease,
  withState,
} from '../../../src/cli/context.ts';
import { OrbitError, isOrbitError, type OrbitErrorCode } from '../../../src/core/errors.ts';
import { ManualClock, systemClock } from '../../../src/core/clock.ts';
import { registerController, heartbeatController, markControllerStopped } from '../../../src/storage/controllers.ts';
import { acquireLease } from '../../../src/controller/run-store.ts';
import { makeLab } from './lab.ts';

const labs: Array<ReturnType<typeof makeLab>> = [];
const dirs: string[] = [];
const added: CommandDef[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const l of labs.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const c of added.splice(0)) (COMMANDS as CommandDef[]).splice((COMMANDS as CommandDef[]).indexOf(c), 1);
});
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
const tmpdir_ = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-core-')));
  dirs.push(d);
  return d;
};

async function run(argv: string[], over: Parameters<typeof main>[1] = {}) {
  const io = memoryIo();
  const code = await main(argv, { io, cwd: process.cwd(), env: {}, ...over });
  return { code, out: io.stdout, err: io.stderr };
}

/** A command that throws whatever the test gives it, registered for one test. */
function throwing(value: unknown, name = 'boom'): void {
  const def: CommandDef = {
    name,
    summary: 'throws',
    usage: `orbit ${name}`,
    run: async () => {
      throw value;
    },
  };
  (COMMANDS as CommandDef[]).push(def);
  added.push(def);
}

describe('help and version', () => {
  it('help <command> prints that command\'s options, and refuses an unknown one', async () => {
    const one = await run(['help', 'status']);
    expect(one.code).toBe(0);
    expect(one.out).toContain('Usage: orbit status');
    expect(one.out).toContain('--json');
    const two = await run(['help', 'models', 'list']);
    expect(two.out).toContain('Usage: orbit models list');
    // Asking for help on a command that does not exist is a usage error, not a silent general help (it used to exit 0).
    const unknown = await run(['help', 'frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.out).toBe('');
    expect(unknown.err).toMatch(/unknown command "frobnicate"/);
    const codes = await run(['help', 'exit-codes']);
    expect(codes.out).toBe(exitCodesText());
    expect(codes.out).toContain('VERIFY_INCOMPLETE');
  });

  it('prints the general help and exits 2 when given nothing at all', async () => {
    expect(await run([])).toMatchObject({ code: EXIT.USAGE, out: helpText(), err: '' });
  });

  it('check-runner is reachable through the command table and reports its usage on the CLI output', async () => {
    const r = await run(['check-runner', 'relative']);
    expect(r).toEqual({ code: EXIT.USAGE, out: '', err: 'usage: orbit check-runner <absolute run dir> <absolute check dir>\n' });
  });

  it.each(['--help', '-h', 'help'])('%s prints the general help and exits 0', async (flag) => {
    const r = await run([flag]);
    expect(r).toMatchObject({ code: 0, out: helpText() });
  });

  it.each(['--version', '-V', 'version'])('%s prints the version only', async (flag) => {
    const r = await run([flag]);
    expect(r).toEqual({ code: 0, out: '0.2.0\n', err: '' });
  });

  it('a command accepts --help and prints its help without running', async () => {
    const r = await run(['stats', '--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: orbit stats');
    expect(r.err).toBe('');
  });

  it('commandHelp shows short flags, value names and a default value name', () => {
    const def: CommandDef = {
      name: 'x',
      summary: 'sum',
      usage: 'orbit x',
      options: { path: { type: 'string', description: 'a path' }, named: { type: 'string', description: 'named', valueName: 'thing' }, quiet: { type: 'boolean', short: 'q', description: 'be quiet' } },
      run: async () => 0,
    };
    const text = commandHelp(def);
    expect(text).toContain('--path <value>');
    expect(text).toContain('--named <thing>');
    expect(text).toMatch(/-q, --quiet\s+be quiet/);
    expect(text).toMatch(/-h, --help/);
  });
});

describe('dispatch', () => {
  it('names the subcommands of a group, and the known commands otherwise', async () => {
    expect((await run(['service'])).err).toContain('"orbit service" needs a subcommand: install, uninstall, status, run');
    expect((await run(['policy', '--json'])).err).toContain('needs a subcommand: show');
    const unknown = await run(['wat']);
    expect(unknown.err).toMatch(/unknown command "wat"; commands: doctor, init, run/);
    expect(unknown.err).toContain('run "orbit help" for the commands');
    // A flag after the first word is not a subcommand.
    expect((await run(['models', '--json'])).err).toContain('needs a subcommand: list, refresh');
  });

  it('refuses everything but the read-only commands inside a worker, for each way a worker is marked', async () => {
    for (const env of [{ ORBIT_WORKER: '1' }, { ORBIT_POLICY_HASH: 'sha256:x' }, { ORBIT_POLICY_PATH: '/p/policy.json' }]) {
      const r = await run(['pause', 'run-1'], { env });
      expect(r.code, JSON.stringify(env)).toBe(EXIT.CONFIG);
      expect(r.err).toContain('"orbit pause" is refused inside a worker');
    }
    // Not a worker: ORBIT_WORKER=0 does not count, so the command reaches its own argument check.
    const notWorker = await run(['pause'], { env: { ORBIT_WORKER: '0' } });
    expect(notWorker.code).toBe(EXIT.USAGE);
    expect(notWorker.err).toContain('expected 1 argument(s), got 0');
    // A read-only command is allowed in a worker.
    const allowed = await run(['stats', '--help'], { env: { ORBIT_WORKER: '1' } });
    expect(allowed.code).toBe(0);
  });
});

describe('error reporting', () => {
  it('prints a usage error with the usage line, or as JSON when --json is in the arguments', async () => {
    const plain = await run(['stats', '--since', 'x', '--bogus']);
    expect(plain.code).toBe(EXIT.USAGE);
    expect(plain.err).toMatch(/^orbit: .*\nusage: orbit stats .*\nrun "orbit help" for the commands\n$/);
    const asJson = await run(['stats', '--bogus', '--json']);
    expect(asJson.code).toBe(EXIT.USAGE);
    expect(JSON.parse(asJson.err)).toEqual({ error: { code: 'USAGE', message: expect.stringContaining('bogus') } });
    // An error with no usage line prints just the message and the pointer to help.
    const none = await run(['nope']);
    expect(none.err).not.toContain('usage:');
    expect(none.err.endsWith('run "orbit help" for the commands\n')).toBe(true);
  });

  it('maps an Orbit error to its code and lists up to 20 validation problems', async () => {
    const problems = Array.from({ length: 25 }, (_, i) => `problem ${i + 1}`);
    throwing(new OrbitError('CONFIG_INVALID', 'config is wrong', { problems: [...problems, 7] }));
    const r = await run(['boom']);
    expect(r.code).toBe(EXIT.CONFIG);
    const lines = r.err.trimEnd().split('\n');
    expect(lines[0]).toBe('orbit: config is wrong');
    expect(lines).toHaveLength(21);
    expect(lines[20]).toBe('  - problem 20');
    const j = await run(['boom', '--json']);
    expect(JSON.parse(j.err)).toEqual({ error: { code: 'CONFIG_INVALID', message: 'config is wrong' } });
  });

  it('prints an Orbit error without problems, or with a details object that has none, as one line', async () => {
    throwing(new OrbitError('NOT_FOUND', 'no such thing', { problems: 'not a list' }), 'missing');
    const r = await run(['missing']);
    expect(r).toMatchObject({ code: EXIT.NOT_FOUND, err: 'orbit: no such thing\n' });
  });

  it('reports an unexpected error as INTERNAL with exit 1, with the stack only under ORBIT_DEBUG', async () => {
    throwing(new Error('disk on fire'), 'crash');
    const quiet = await run(['crash']);
    expect(quiet).toMatchObject({ code: EXIT.FAILURE, err: 'orbit: disk on fire\n' });
    const loud = await run(['crash'], { env: { ORBIT_DEBUG: '1' } });
    expect(loud.err).toMatch(/^orbit: disk on fire\n.*Error: disk on fire\n\s+at /s);
    const j = await run(['crash', '--json']);
    expect(JSON.parse(j.err)).toEqual({ error: { code: 'INTERNAL', message: 'disk on fire' } });
  });

  it('reports a thrown value that is not an Error by its text, and never prints a stack for it', async () => {
    throwing('just a string', 'odd');
    const r = await run(['odd'], { env: { ORBIT_DEBUG: '1' } });
    expect(r).toMatchObject({ code: EXIT.FAILURE, err: 'orbit: just a string\n' });
    throwing(Object.assign(new Error('with a code'), { stack: undefined }), 'nostack');
    const s = await run(['nostack'], { env: { ORBIT_DEBUG: '1' } });
    expect(s.err).toBe('orbit: with a code\n\n');
  });
});

describe('exit codes', () => {
  it('maps every Orbit error code to a documented exit code, and anything else to 1', () => {
    const table_: Array<[OrbitErrorCode, number]> = [
      ['NOT_FOUND', EXIT.NOT_FOUND],
      ['CONFIG_INVALID', EXIT.CONFIG],
      ['CONTRACT_INVALID', EXIT.CONFIG],
      ['SCHEMA_INVALID', EXIT.CONFIG],
      ['POLICY_DENIED', EXIT.CONFIG],
      ['POLICY_TAMPERED', EXIT.CONFIG],
      ['SCOPE_VIOLATION', EXIT.CONFIG],
      ['TRANSITION_INVALID', EXIT.CONFLICT],
      ['CONCURRENT_UPDATE', EXIT.CONFLICT],
      ['LEASE_LOST', EXIT.CONFLICT],
      ['CANCELLED', EXIT.CONFLICT],
      ['AUTH_EXPIRED', EXIT.ENVIRONMENT],
      ['AUTH_MISSING', EXIT.ENVIRONMENT],
      ['PROVIDER_UNAVAILABLE', EXIT.ENVIRONMENT],
      ['ISOLATION_UNAVAILABLE', EXIT.ENVIRONMENT],
      ['INTERNAL', EXIT.FAILURE],
    ];
    for (const [code, exit] of table_) expect(exitCodeFor(new OrbitError(code, 'x')), String(code)).toBe(exit);
    expect(exitCodeFor(new UsageError('u'))).toBe(EXIT.USAGE);
    expect(exitCodeFor(new Error('x'))).toBe(EXIT.FAILURE);
    expect(exitCodeFor('x')).toBe(EXIT.FAILURE);
    expect(isOrbitError(new OrbitError('INTERNAL', 'x'))).toBe(true);
  });

  it('maps a foreground run\'s final state', () => {
    expect(exitCodeForState('SUCCEEDED')).toBe(EXIT.OK);
    expect(exitCodeForState('BLOCKED')).toBe(EXIT.BLOCKED);
    expect(exitCodeForState('EXHAUSTED')).toBe(EXIT.EXHAUSTED);
    expect(exitCodeForState('IMPOSSIBLE')).toBe(EXIT.IMPOSSIBLE);
    expect(exitCodeForState('CANCELLED')).toBe(EXIT.CANCELLED);
    expect(exitCodeForState('RUNNING')).toBe(EXIT.FAILURE);
    expect(exitCodeForState('')).toBe(EXIT.FAILURE);
  });

  it('a UsageError carries its usage line', () => {
    expect(new UsageError('m', 'orbit x').usage).toBe('orbit x');
    expect(new UsageError('m').usage).toBeUndefined();
    expect(new UsageError('m').name).toBe('UsageError');
  });
});

describe('Args', () => {
  const spec = {
    name: { type: 'string', description: 'n' },
    tag: { type: 'string', multiple: true, short: 't', description: 't' },
    count: { type: 'string', description: 'c' },
    level: { type: 'string', description: 'l' },
    ratio: { type: 'string', description: 'r' },
    flag: { type: 'boolean', description: 'f' },
  } as const;
  const parse = (argv: string[]) => parseCommand(argv, spec, 'orbit t');

  it('reads strings, booleans and lists, with absent options as undefined, false and []', () => {
    const a = parse(['--name', 'x', '-t', 'a', '--tag', 'b', '--flag', 'pos1']);
    expect(a.str('name')).toBe('x');
    expect(a.str('flag')).toBeUndefined();
    expect(a.str('missing')).toBeUndefined();
    expect(a.bool('flag')).toBe(true);
    expect(a.bool('name')).toBe(false);
    expect(a.list('tag')).toEqual(['a', 'b']);
    expect(a.list('name')).toEqual(['x']);
    expect(a.list('missing')).toEqual([]);
    expect(a.list('flag')).toEqual([]);
    expect(a.positionals).toEqual(['pos1']);
  });

  it('int accepts digits only', () => {
    expect(parse([]).int('count')).toBeUndefined();
    expect(parse(['--count', '0']).int('count')).toBe(0);
    expect(parse(['--count', '42']).int('count')).toBe(42);
    for (const bad of ['-1', '1.5', 'abc', '', '1e3', ' 2']) {
      expect(() => parse([`--count=${bad}`]).int('count'), bad).toThrow(`--count must be a non-negative integer, got ${JSON.stringify(bad)}`);
    }
    try {
      parse(['--count=x']).int('count');
    } catch (e) {
      expect((e as UsageError).usage).toBe('orbit t');
    }
  });

  it('num accepts non-negative decimals', () => {
    expect(parse([]).num('ratio')).toBeUndefined();
    expect(parse(['--ratio', '0']).num('ratio')).toBe(0);
    expect(parse(['--ratio', '2.5']).num('ratio')).toBe(2.5);
    for (const bad of ['-0.5', 'abc', 'Infinity', 'NaN']) expect(() => parse([`--ratio=${bad}`]).num('ratio'), bad).toThrow(/non-negative number/);
  });

  it('oneOf accepts only the allowed values', () => {
    expect(parse([]).oneOf('level', ['a', 'b'])).toBeUndefined();
    expect(parse(['--level', 'b']).oneOf('level', ['a', 'b'])).toBe('b');
    expect(() => parse(['--level', 'c']).oneOf('level', ['a', 'b'])).toThrow('--level must be one of a, b, got "c"');
  });

  it('expect enforces the number of positionals with its own wording for exact and ranged counts', () => {
    const a = parse(['one', 'two']);
    expect(a.expect(2)).toEqual(['one', 'two']);
    expect(a.expect(1, 3)).toEqual(['one', 'two']);
    expect(() => a.expect(1)).toThrow('expected 1 argument(s), got 2');
    expect(() => a.expect(3, 4)).toThrow('expected 3 to 4 arguments, got 2');
    expect(() => a.expect(0, 1)).toThrow('expected 0 to 1 arguments, got 2');
  });

  it('turns parser failures into usage errors carrying the usage line, first line only', () => {
    expect(() => parse(['--nope'])).toThrow(UsageError);
    try {
      parse(['--nope']);
    } catch (e) {
      expect((e as UsageError).usage).toBe('orbit t');
      expect((e as UsageError).message).not.toContain('\n');
      expect((e as UsageError).message).toMatch(/^unknown option "--nope" for "orbit t"/);
    }
    expect(() => parse(['--name'])).toThrow(/option --name needs a value/);
  });

  it('merges the global options and makes a command without options work', () => {
    const a = parseCommand(['--json', '--repo', '/r', '-h'], undefined, 'orbit y');
    expect(a.bool('json')).toBe(true);
    expect(a.str('repo')).toBe('/r');
    expect(a.bool('help')).toBe(true);
    expect(Object.keys(GLOBAL_OPTIONS)).toEqual(['repo', 'json', 'help']);
    expect(new Args({}, [], 'u').positionals).toEqual([]);
  });
});

describe('io', () => {
  it('createIo redacts what it writes, tells a terminal from a pipe and reads all of stdin', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const sink = (into: string[], isTTY?: boolean) => Object.assign(new Writable({ write: (c, _e, cb) => (into.push(String(c)), cb()) }), isTTY === undefined ? {} : { isTTY });
    const stdin = new PassThrough();
    const io = createIo(sink(out, true), sink(err), stdin);
    expect(io.stdoutIsTty).toBe(true);
    // Token-shaped text assembled at runtime, so no such literal sits in the source.
    const secret = ['sk-ant-', 'api03-', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
    io.out(`token ${secret} end\n`);
    io.err('plain\n');
    expect(out.join('')).not.toContain(secret);
    expect(out.join('')).toContain('[REDACTED');
    expect(err).toEqual(['plain\n']);
    stdin.write('héllo ');
    stdin.write(Buffer.from('wörld'));
    stdin.end();
    expect(await io.readStdin()).toBe('héllo wörld');
    expect(createIo(sink([]), sink([])).stdoutIsTty).toBe(false);
  });

  it('createIo has an empty stdin when there is none, reads string chunks and survives a closed pipe', async () => {
    const closed = new Writable({
      write() {
        throw new Error('EPIPE');
      },
    });
    const io = createIo(closed, closed);
    expect(await io.readStdin()).toBe('');
    expect(() => io.out('x')).not.toThrow();
    expect(() => io.err('x')).not.toThrow();
    const strings = new PassThrough({ encoding: 'utf8' });
    strings.end('abc');
    expect(await createIo(closed, closed, strings).readStdin()).toBe('abc');
  });

  it('memoryIo captures redacted output and serves the given stdin', async () => {
    const io = memoryIo('in');
    io.out('a');
    io.err('b');
    line(io, 'c');
    line(io);
    json(io, { k: [1] });
    expect(io.stdout).toBe('a' + 'c\n' + '\n' + '{\n  "k": [\n    1\n  ]\n}\n');
    expect(io.stderr).toBe('b');
    expect(io.stdoutIsTty).toBe(false);
    expect(await io.readStdin()).toBe('in');
    expect(await memoryIo().readStdin()).toBe('');
  });

  it('table pads every column but the last, with or without a header, and trims the right edge', () => {
    expect(table([])).toBe('');
    expect(table([], ['A'])).toBe('A\n');
    expect(table([['x', 'long value'], ['yyyy', 'z']], ['K', 'V'])).toBe('K     V\nx     long value\nyyyy  z\n');
    expect(table([['a', ''], ['bb', 'c']])).toBe('a\nbb  c\n');
    // A short row is padded as if its missing cells were empty.
    expect(table([['a', 'b', 'c'], ['d']])).toBe('a  b  c\nd\n');
  });

  it('oneLine flattens whitespace and truncates with an ellipsis at the limit', () => {
    expect(oneLine('  a \n\t b   c ')).toBe('a b c');
    expect(oneLine('x'.repeat(120))).toBe('x'.repeat(120));
    expect(oneLine('x'.repeat(121))).toBe(`${'x'.repeat(117)}...`);
    expect(oneLine('abcdefghij', 8)).toBe('abcde...');
  });

  it('ago picks seconds, minutes, hours or days, never negative, and says never for null', () => {
    const now = 1_000_000_000;
    expect(ago(now, null)).toBe('never');
    expect(ago(now, now + 5000)).toBe('0s ago');
    expect(ago(now, now - 89_000)).toBe('89s ago');
    expect(ago(now, now - 90_000)).toBe('2m ago');
    expect(ago(now, now - 89 * 60_000)).toBe('89m ago');
    expect(ago(now, now - 90 * 60_000)).toBe('2h ago');
    expect(ago(now, now - 47 * 3_600_000)).toBe('47h ago');
    expect(ago(now, now - 48 * 3_600_000)).toBe('2d ago');
  });

  it('iso prints an ISO timestamp, or a dash for null', () => {
    expect(iso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(iso(null)).toBe('-');
  });
});

describe('createContext', () => {
  const base = { io: memoryIo() };

  it('takes the user from ORBIT_USER, then USER, then LOGNAME, then the account, and prefers an override', () => {
    expect(createContext({ ...base, env: { ORBIT_USER: 'o', USER: 'u', LOGNAME: 'l' } }).user).toBe('o');
    expect(createContext({ ...base, env: { USER: 'u', LOGNAME: 'l' } }).user).toBe('u');
    expect(createContext({ ...base, env: { LOGNAME: 'l' } }).user).toBe('l');
    expect(createContext({ ...base, env: {} }).user).toMatch(/\S/);
    expect(createContext({ ...base, env: { USER: 'u' }, user: 'given' }).user).toBe('given');
  });

  it('falls back to a generic name when the account cannot be read', async () => {
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:os')>()),
      userInfo: () => {
        throw new Error('no passwd entry');
      },
    }));
    try {
      const { createContext: fresh } = await import('../../../src/cli/context.ts');
      expect(fresh({ io: memoryIo(), env: {} }).user).toBe('user');
    } finally {
      vi.doUnmock('node:os');
      vi.resetModules();
    }
  });

  it('defaults to the process for cwd, env, platform and uid, and to ORBIT_HOME or ~/.orbit for the state home', () => {
    const c = createContext({ io: memoryIo() });
    expect(c.cwd).toBe(process.cwd());
    expect(c.env).toBe(process.env);
    expect(c.platform).toBe(process.platform);
    expect(c.uid).toBe(process.getuid?.() ?? 0);
    expect(c.clock).toBe(systemClock);
    expect(c.seams).toEqual({});
    expect(createContext({ ...base, env: { ORBIT_HOME: '/o/h' }, homeDir: '/h' }).orbitHome).toBe('/o/h');
    expect(createContext({ ...base, env: {}, homeDir: '/h' }).homeDir).toBe('/h');
    const given = createContext({ ...base, cwd: '/c', platform: 'linux', uid: 7, orbitHome: '/oh', entry: '/e', seams: { pollMs: 5 }, clock: new ManualClock(5) });
    expect(given).toMatchObject({ cwd: '/c', platform: 'linux', uid: 7, orbitHome: '/oh', entry: '/e', seams: { pollMs: 5 } });
  });

  it('uid is 0 where the platform has no getuid', () => {
    const saved = Object.getOwnPropertyDescriptor(process, 'getuid')!;
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    try {
      expect(createContext(base).uid).toBe(0);
    } finally {
      Object.defineProperty(process, 'getuid', saved);
    }
  });

  it('resolves the entry script through symlinks, keeps an unresolvable one as an absolute path, and is empty without argv[1]', () => {
    const d = tmpdir_();
    writeFileSync(join(d, 'real.mjs'), '');
    symlinkSync(join(d, 'real.mjs'), join(d, 'link.mjs'));
    const argv = process.argv;
    try {
      process.argv = ['node', join(d, 'link.mjs')];
      expect(createContext(base).entry).toBe(join(d, 'real.mjs'));
      process.argv = ['node', join(d, 'gone.mjs')];
      expect(createContext(base).entry).toBe(join(d, 'gone.mjs'));
      process.argv = ['node'];
      expect(createContext(base).entry).toBe('');
    } finally {
      process.argv = argv;
    }
  });
});

describe('resolveRepo', () => {
  it('finds the git toplevel from a subdirectory or from --repo', async () => {
    const l = lab();
    mkdirSync(join(l.repo, 'sub', 'deep'), { recursive: true });
    const ctx = createContext({ io: memoryIo(), cwd: join(l.repo, 'sub', 'deep'), env: { PATH: process.env.PATH } });
    expect(await resolveRepo(ctx)).toBe(l.repo);
    expect(await resolveRepo({ ...ctx, cwd: '/' }, l.repo)).toBe(l.repo);
    expect(await resolveRepo(ctx, '../..')).toBe(l.repo);
  });

  // Issue #3: this used to answer the primary checkout. A linked worktree is its own repository root (git rev-parse
  // --show-toplevel), so init, doctor and run work on the tree they were started in, not on the main working tree.
  it('answers the linked worktree itself from inside it, from a subdirectory of it and from --repo', async () => {
    const l = lab();
    const wt = join(l.base, 'wt');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: l.repo, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    mkdirSync(join(wt, 'sub'));
    const ctx = createContext({ io: memoryIo(), cwd: wt, env: { PATH: process.env.PATH } });
    expect(await resolveRepo(ctx)).toBe(wt);
    expect(await resolveRepo({ ...ctx, cwd: join(wt, 'sub') })).toBe(wt);
    expect(await resolveRepo({ ...ctx, cwd: '/' }, wt)).toBe(wt);
    // The main working tree still answers itself.
    expect(await resolveRepo({ ...ctx, cwd: l.repo })).toBe(l.repo);
  });

  it('says NOT_FOUND for a missing directory and for a directory outside any repository', async () => {
    const d = tmpdir_();
    const ctx = createContext({ io: memoryIo(), cwd: d, env: { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: d } });
    await expect(resolveRepo(ctx, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('does not exist') });
    await expect(resolveRepo(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('is not inside a git repository; run orbit from a repository or pass --repo') });
  });

  it('says PROVIDER_UNAVAILABLE when git cannot be run', async () => {
    const d = tmpdir_();
    const ctx = createContext({ io: memoryIo(), cwd: d, env: { PATH: '' } });
    await expect(resolveRepo(ctx)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: expect.stringMatching(/^git is not available: /) });
  });

  it('gitEnv passes only the variables git needs and turns optional locks off', () => {
    expect(gitEnv({ PATH: '/bin', HOME: '/h', SECRET_TOKEN: 'x', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', TMPDIR: undefined })).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' });
  });
});

describe('state access', () => {
  it('openState refuses a missing database unless asked to create it, and withState closes it afterwards', async () => {
    const l = lab({ git: false });
    const repo = join(l.base, 'fresh');
    mkdirSync(repo);
    expect(() => openState(repo)).toThrow(/no Orbit state in .*; run "orbit init", then "orbit run"/);
    const created = openState(repo, { create: true });
    created.close();
    expect(await withState(repo, (db) => db.get<{ n: number }>('SELECT 1 AS n')?.n)).toBe(1);
    let seen: { close(): void } | null = null;
    await expect(
      withState(repo, (db) => {
        seen = db;
        throw new Error('inside');
      }),
    ).rejects.toThrow('inside');
    expect(() => (seen as unknown as { get(sql: string): unknown }).get('SELECT 1')).toThrow();
    expect(await withState(join(l.base, 'other'), () => 'ok', { create: true })).toBe('ok');
  });

  it('findRunByPrefix takes an exact id, a unique prefix, and refuses ambiguous, short or unknown ones', () => {
    const l = lab();
    const a = l.newRun('goal a', 'run-aaaa-1');
    const b = l.newRun('goal b', 'run-aaaa-2');
    const c = l.newRun('goal c', 'run-bbbb_%1');
    const db = l.db();
    expect(findRunByPrefix(db, a.id).id).toBe(a.id);
    expect(findRunByPrefix(db, 'run-bbbb').id).toBe(c.id);
    expect(() => findRunByPrefix(db, 'run-aaaa')).toThrow(/matches more than one run \(run-aaaa-1, run-aaaa-2\); use the full id/);
    // LIKE wildcards in the prefix are literal.
    expect(() => findRunByPrefix(db, 'run-%')).toThrow(/no run run-%/);
    expect(() => findRunByPrefix(db, 'run-bbbb_')).not.toThrow();
    expect(() => findRunByPrefix(db, 'run')).toThrow(/^no run run; recent runs: /);
    expect(b.id).toBe('run-aaaa-2');
  });

  it('findRunByPrefix says there are no runs when the database is empty', () => {
    const l = lab();
    l.db();
    expect(() => findRunByPrefix(l.db(), 'whatever')).toThrow(new OrbitError('NOT_FOUND', 'no run whatever'));
  });

  it('liveLease is the lease only while it has not expired', () => {
    const l = lab();
    const run = l.newRun();
    const clock = new ManualClock(1_000_000);
    expect(liveLease(l.db(), run.id, clock.now())).toBeNull();
    acquireLease(l.db(), run.id, 'owner-1', 60_000, clock);
    expect(liveLease(l.db(), run.id, clock.now() + 59_999)?.ownerId).toBe('owner-1');
    expect(liveLease(l.db(), run.id, clock.now() + 60_000)).toBeNull();
    expect(liveLease(l.db(), run.id, clock.now() + 70_000)).toBeNull();
  });
});

describe('controller liveness', () => {
  it('is live while the heartbeat is fresh and, on this host, the process still exists', () => {
    const l = lab();
    const db = l.db();
    const clock = new ManualClock(10_000_000);
    registerController(db, { id: 'c-here-alive', pid: process.pid, host: hostname(), mode: 'service' }, clock);
    registerController(db, { id: 'c-here-dead', pid: 2 ** 22 + 12345, host: hostname(), mode: 'foreground' }, clock);
    registerController(db, { id: 'c-elsewhere', pid: 2 ** 22 + 54321, host: 'another-host.invalid', mode: 'service' }, clock);
    const stale = registerController(db, { id: 'c-stale', pid: process.pid, host: hostname(), mode: 'service' }, new ManualClock(10_000_000 - CONTROLLER_STALE_MS - 1));
    const stopped = registerController(db, { id: 'c-stopped', pid: process.pid, host: hostname(), mode: 'service' }, clock);
    markControllerStopped(db, stopped.id, 'done', clock);
    expect(heartbeatController(db, 'c-here-alive', clock)).toBe(true);
    const now = clock.now() + 10;
    const live = Object.fromEntries(controllers(db, now).map((c) => [c.record.id, c.live]));
    expect(live).toEqual({ 'c-here-alive': true, 'c-here-dead': false, 'c-elsewhere': true, 'c-stale': false });
    expect(controllers(db, now, { includeStopped: true }).find((c) => c.record.id === 'c-stopped')?.live).toBe(false);
    expect(controllers(db, now, { limit: 1 })).toHaveLength(1);
    expect(controllers(db, now).find((c) => c.record.id === 'c-stale')?.age).toBe(now - stale.heartbeatAt);
    // A heartbeat in the future never gives a negative age.
    expect(controllers(db, 0).every((c) => c.age === 0)).toBe(true);
    expect(liveServiceController(db, now)?.record.mode).toBe('service');
    markControllerStopped(db, 'c-here-alive', 'x', clock);
    markControllerStopped(db, 'c-elsewhere', 'x', clock);
    expect(liveServiceController(db, now)).toBeNull();
  });
});

describe('withCliLease', () => {
  it('holds the lease for the length of the callback and releases it afterwards, even when the callback throws', async () => {
    const l = lab();
    const run = l.newRun();
    const ctx = createContext({ io: memoryIo(), clock: systemClock });
    let owner = '';
    expect(
      await withCliLease(ctx, l.db(), run.id, (o) => {
        owner = o;
        expect(liveLease(l.db(), run.id, Date.now())?.ownerId).toBe(o);
        return 'done';
      }),
    ).toBe('done');
    expect(owner).toMatch(/^cli-/);
    expect(liveLease(l.db(), run.id, Date.now())).toBeNull();
    await expect(
      withCliLease(ctx, l.db(), run.id, () => {
        throw new Error('inside');
      }),
    ).rejects.toThrow('inside');
    expect(liveLease(l.db(), run.id, Date.now())).toBeNull();
  });

  it('never takes a run from a live controller, and names the owner and when its lease ends', async () => {
    const l = lab();
    const run = l.newRun();
    acquireLease(l.db(), run.id, 'controller-9', 60_000, systemClock);
    const ctx = createContext({ io: memoryIo(), clock: systemClock });
    const err = await withCliLease(ctx, l.db(), run.id, () => 'never').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrbitError);
    expect((err as OrbitError).code).toBe('CONCURRENT_UPDATE');
    expect((err as OrbitError).message).toMatch(/^run .* is owned by a live controller \(controller-9\); its lease expires \d{4}-\d\d-\d\dT/);
    expect(existsSync(l.repo)).toBe(true);
  });
});
