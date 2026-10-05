/**
 * `orbit doctor`, the checks about the machine and the repository: runtime,
 * git, configuration, storage, configured checks, isolation, browsers,
 * delivery, secret scanning, the background service and the publication
 * guard. `runDoctor` runs in this process against a real temporary git
 * repository and a private HOME; only what cannot be arranged honestly
 * (a Docker daemon, `gh`, a node:sqlite that lacks FTS5) is replaced.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { which, runDoctor, doctorCommand, type DoctorCheck } from '../../../src/cli/commands/doctor.ts';
import { createContext, type CliContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { parseCommand } from '../../../src/cli/args.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import type { IsolationProvider } from '../../../src/isolation/types.ts';
import type { ProviderAdapter } from '../../../src/adapters/types.ts';
import { registerController, markControllerStopped } from '../../../src/storage/controllers.ts';
import { openDb } from '../../../src/storage/db.ts';
import { stateDbPath } from '../../../src/controller/start.ts';
import type { CommandRunner } from '../../../src/controller/service.ts';

const hooks = vi.hoisted(() => ({
  config: null as null | (() => unknown),
  exec: null as null | ((argv: readonly string[]) => unknown),
  isolation: null as null | (() => unknown),
  openDb: null as null | ((path: string) => unknown),
  adapters: null as null | (() => unknown),
}));

vi.mock('../../../src/policy/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/policy/index.ts')>();
  return { ...actual, loadConfig: (...a: Parameters<typeof actual.loadConfig>) => (hooks.config ? hooks.config() : actual.loadConfig(...a)) } as typeof actual;
});
vi.mock('../../../src/core/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/exec.ts')>();
  return {
    ...actual,
    execCapture: (argv: readonly string[], opts: never) => {
      const fake = hooks.exec?.(argv);
      if (fake instanceof Error) return Promise.reject(fake);
      return fake !== undefined ? Promise.resolve(fake) : actual.execCapture(argv, opts);
    },
  };
});
vi.mock('../../../src/isolation/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/isolation/index.ts')>();
  return {
    ...actual,
    getIsolation: (...a: Parameters<typeof actual.getIsolation>) => {
      if (!hooks.isolation) return actual.getIsolation(...a);
      const r = hooks.isolation();
      if (r instanceof Error) throw r;
      return r;
    },
  } as typeof actual;
});
vi.mock('../../../src/storage/db.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/storage/db.ts')>();
  return {
    ...actual,
    openDb: (path: string, ...rest: unknown[]) => {
      const fake = hooks.openDb?.(path);
      if (fake instanceof Error) throw fake;
      return fake !== undefined ? fake : (actual.openDb as (...a: unknown[]) => unknown)(path, ...rest);
    },
  } as typeof actual;
});
vi.mock('../../../src/adapters/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/adapters/index.ts')>();
  return {
    ...actual,
    createAdapters: (...a: Parameters<typeof actual.createAdapters>) => {
      if (!hooks.adapters) return actual.createAdapters(...a);
      const r = hooks.adapters();
      if (r instanceof Error) throw r;
      return r;
    },
  } as typeof actual;
});

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const dirs: string[] = [];
beforeEach(() => {
  hooks.config = null;
  hooks.exec = null;
  hooks.openDb = null;
  hooks.adapters = null;
  // A sandbox that is present and working, so the checks under test are not coloured by this machine's srt.
  hooks.isolation = () => fakeIsolation('sandbox-runtime', true, 'srt 1.2 and seatbelt');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function fakeIsolation(kind: IsolationProvider['kind'], ok: boolean, detail: string): IsolationProvider {
  return { kind, available: async () => ({ ok, detail }), wrap: () => ({}) as never };
}

function tmp(prefix = 'orbit-doc-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function exe(dir: string, name: string, body = '#!/bin/sh\nexit 0\n'): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, body, { mode: 0o755 });
  return p;
}

interface World {
  base: string;
  repo: string;
  home: string;
  bin: string;
  env: Record<string, string | undefined>;
  ctx(over?: Partial<CliContext>): CliContext;
  git(...a: string[]): string;
}

function world(opts: { commit?: boolean; git?: boolean } = {}): World {
  const base = tmp();
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
  if (opts.git !== false) {
    git('init', '-q', '-b', 'main');
    if (opts.commit !== false) {
      writeFileSync(join(repo, 'README.md'), '# acme\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
    }
  }
  const env: Record<string, string | undefined> = { PATH: `${bin}:${process.env.PATH}`, HOME: home, ...GIT_ENV };
  return {
    base,
    repo,
    home,
    bin,
    env,
    git,
    ctx: (over = {}) => createContext({ io: memoryIo(), cwd: repo, env, homeDir: home, orbitHome: join(home, '.orbit'), platform: 'linux', uid: 1000, user: 'alice', clock: systemClock, ...over }),
  };
}

function cfg(over: (c: OrbitConfig) => void = () => {}): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.isolation = { ...c.isolation, provider: 'none', allow_unisolated: true };
  over(c);
  return c;
}

const noAdapters = () => ({});
async function doctor(w: World, over: { config?: OrbitConfig | null; probe?: boolean; ctx?: Partial<CliContext> } = {}): Promise<Record<string, DoctorCheck>> {
  hooks.adapters ??= noAdapters;
  if (over.config) {
    const c = over.config;
    hooks.config = () => c;
  }
  const report = await runDoctor(w.ctx(over.ctx), { probe: over.probe ?? false });
  return Object.fromEntries(report.checks.map((c) => [c.id, c]));
}

describe('which', () => {
  it('finds an executable on PATH, resolves a path with a slash, and refuses a directory or a file that cannot run', () => {
    const w = world();
    const tool = exe(w.bin, 'acme-tool');
    writeFileSync(join(w.bin, 'not-executable'), 'x', { mode: 0o644 });
    mkdirSync(join(w.bin, 'a-directory'));
    const env = { PATH: `:${w.bin}:/nonexistent-dir` };
    expect(which('acme-tool', env)).toBe(tool);
    expect(which('not-executable', env)).toBeNull();
    expect(which('a-directory', env)).toBeNull();
    expect(which('missing-tool', env)).toBeNull();
    expect(which('acme-tool', {})).toBeNull();
    expect(which(tool, {})).toBe(tool);
    expect(which('./acme-tool', {}, w.bin)).toBe(join(w.bin, 'acme-tool'));
    expect(which('./nope', {}, w.bin)).toBeNull();
  });
});

describe('runtime', () => {
  it('passes on this Node, and fails on one that is too old', async () => {
    const w = world();
    const ok = await doctor(w, { config: cfg() });
    expect(ok['runtime.node']).toMatchObject({ status: 'pass', summary: `Node v${process.versions.node}` });
    const saved = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    try {
      Object.defineProperty(process.versions, 'node', { value: '20.1.0', configurable: true });
    } catch {
      return;
    }
    try {
      const old = await doctor(w, { config: cfg() });
      expect(old['runtime.node']).toMatchObject({ status: 'fail', summary: 'Node v20.1.0 is older than 22.16.0', missing: 'Node >= 22.16.0 (node:sqlite timeout, isTransaction)' });
    } finally {
      Object.defineProperty(process.versions, 'node', saved);
    }
  });

  it('reports a node:sqlite without FTS5 or that cannot open at all, closing what it opened', async () => {
    const w = world();
    let closed = 0;
    hooks.openDb = (path) =>
      path === ':memory:'
        ? {
            raw: {
              exec: () => {
                throw new Error('no such module: fts5');
              },
            },
            close: () => void closed++,
          }
        : undefined;
    const c = await doctor(w, { config: cfg() });
    expect(c['runtime.sqlite']).toMatchObject({ status: 'fail', summary: 'node:sqlite is not usable: no such module: fts5', missing: 'node:sqlite with FTS5', fix: 'use Node >= 22.16' });
    expect(closed).toBeGreaterThan(0);
    hooks.openDb = (path) => (path === ':memory:' ? new Error('cannot open') : undefined);
    expect((await doctor(w, { config: cfg() }))['runtime.sqlite']?.summary).toBe('node:sqlite is not usable: cannot open');
    hooks.openDb = (path) => (path === ':memory:' ? ({ raw: { exec: () => { throw 'plain'; } }, close() {} }) : undefined);
    expect((await doctor(w, { config: cfg() }))['runtime.sqlite']?.summary).toBe('node:sqlite is not usable: plain');
  });
});

describe('git', () => {
  it('passes for a repository with a commit, its base branch and a clean tree', async () => {
    const w = world();
    const c = await doctor(w, { config: cfg() });
    expect(c['git.cli']).toMatchObject({ status: 'pass', summary: expect.stringMatching(/^git \d+\.\d+/) });
    expect(c['git.repo']).toMatchObject({ status: 'pass', summary: `repository ${w.repo}; worktrees supported`, details: [] });
  });

  it('fails when git cannot be found, and warns about one that is too old', async () => {
    const w = world();
    const gone = await doctor(w, { config: cfg(), ctx: { env: { PATH: '/nonexistent-dir', HOME: w.home } } });
    expect(gone['git.cli']).toMatchObject({ status: 'fail', summary: 'git was not found', missing: 'the git executable on PATH', fix: 'install git (>= 2.31)' });
    expect(gone['git.repo']).toBeUndefined();
    hooks.exec = (argv) => (argv[1] === '--version' ? { exitCode: 0, signal: null, stdout: 'git version 2.20.1\n', stderr: '' } : undefined);
    const old = await doctor(w, { config: cfg() });
    expect(old['git.cli']).toMatchObject({ status: 'warn', summary: 'git 2.20.1 is older than 2.31.0', missing: 'git >= 2.31.0 (--path-format, worktree repair)', fix: 'upgrade git' });
    hooks.exec = (argv) => (argv[1] === '--version' ? { exitCode: 0, signal: null, stdout: 'git version unknown\n', stderr: '' } : undefined);
    expect((await doctor(w, { config: cfg() }))['git.cli']?.summary).toBe('git 0 is older than 2.31.0');
  });

  it('fails outside a repository and for a repository with no commit', async () => {
    const outside = world({ git: false });
    const c = await doctor(outside, { config: cfg() });
    expect(c['git.repo']).toMatchObject({ status: 'fail', summary: 'not inside a git repository', fix: 'run from a repository, or pass --repo <dir>' });
    expect(c.config).toMatchObject({ status: 'fail', summary: 'no .orbit/config.yaml' });
    const fresh = world({ commit: false });
    const empty = await doctor(fresh, { config: cfg() });
    expect(empty['git.repo']).toMatchObject({ status: 'fail', summary: `${fresh.repo} has no commits`, missing: 'a base revision (at least one commit)', fix: 'make an initial commit' });
  });

  it('warns about a missing base branch, a missing remote under a delivering mode, and uncommitted changes, together', async () => {
    const w = world();
    writeFileSync(join(w.repo, 'scratch.txt'), 'x');
    writeFileSync(join(w.repo, 'other.txt'), 'y');
    mkdirSync(join(w.repo, '.orbit'));
    writeFileSync(join(w.repo, '.orbit', 'state-note.txt'), 'orbit files are ignored');
    const c = await doctor(w, { config: cfg((x) => { x.mode = 'autonomous-delivery'; x.actions.push_task_branch = true; x.repository.base_branch = 'trunk'; x.repository.remote = 'upstream'; }) });
    const repo = c['git.repo']!;
    expect(repo.status).toBe('warn');
    expect(repo.summary).toBe(`repository ${w.repo}: missing base branch trunk, remote upstream, a clean working tree`);
    expect(repo.missing).toBe('base branch trunk; remote upstream; a clean working tree');
    expect(repo.fix).toBe('create it, or set repository.base_branch to an existing branch; git remote add upstream <url>, or choose a mode that does not deliver; commit or stash the changes, or set repository.allow_dirty_start');
    expect(repo.details).toEqual([
      'repository.base_branch "trunk" does not exist locally',
      'delivery pushes task branches but remote "upstream" is not configured',
      '2 uncommitted path(s); a run would refuse to start (repository.allow_dirty_start is false)',
    ]);
    const allowed = await doctor(w, { config: cfg((x) => { x.repository.allow_dirty_start = true; }) });
    expect(allowed['git.repo']?.status).toBe('pass');
    // A mode that does not deliver never needs a remote.
    const quiet = await doctor(w, { config: cfg((x) => { x.repository.allow_dirty_start = true; x.actions.push_task_branch = true; }) });
    expect(quiet['git.repo']?.status).toBe('pass');
    git_remote(w);
    const withRemote = await doctor(w, { config: cfg((x) => { x.mode = 'autonomous-delivery'; x.actions.push_task_branch = true; x.repository.allow_dirty_start = true; }) });
    expect(withRemote['git.repo']?.status).toBe('pass');
  });

  it('fails when git cannot list worktrees, and says what it printed', async () => {
    const w = world();
    hooks.exec = (argv) => (argv[1] === 'worktree' ? { exitCode: 129, signal: null, stdout: '', stderr: "git: 'worktree' is not a git command.\n" } : undefined);
    const c = await doctor(w, { config: cfg() });
    expect(c['git.repo']).toMatchObject({ status: 'fail', missing: 'git worktree support', fix: 'upgrade git (worktrees need git >= 2.5)', details: ["git worktree list failed: git: 'worktree' is not a git command."] });
  });
});

function git_remote(w: World): void {
  w.git('remote', 'add', 'origin', 'https://example.test/acme/widget.git');
}

describe('config', () => {
  it('passes with the mode when it loads, says to run init when there is none, and lists what is invalid', async () => {
    const w = world();
    const ok = await doctor(w, { config: cfg() });
    expect(ok.config).toMatchObject({ status: 'pass', summary: '.orbit/config.yaml is valid (mode autonomous)' });
    hooks.config = null;
    const none = await doctor(w);
    expect(none.config).toMatchObject({ status: 'fail', summary: 'no .orbit/config.yaml', missing: 'the repository policy file', fix: 'run "orbit init", then define your checks' });
    mkdirSync(join(w.repo, '.orbit'), { recursive: true });
    writeFileSync(join(w.repo, '.orbit', 'config.yaml'), 'version: [unclosed\n');
    const bad = await doctor(w);
    expect(bad.config).toMatchObject({ status: 'fail', summary: 'configuration is invalid (1 problem)', missing: 'a valid .orbit/config.yaml', fix: 'fix the problems below; checks use defaults until then' });
    expect(bad.config!.details[0]).toMatch(/^yaml: /);
    const many = Array.from({ length: 15 }, (_, i) => `problem ${i + 1}`);
    hooks.config = () => {
      throw new OrbitError('CONFIG_INVALID', 'invalid', { problems: many });
    };
    const lots = await doctor(w);
    expect(lots.config!.summary).toBe('configuration is invalid (15 problems)');
    expect(lots.config!.details).toHaveLength(12);
    hooks.config = () => {
      throw new Error('disk on fire');
    };
    expect((await doctor(w)).config).toMatchObject({ summary: 'configuration is invalid (1 problem)', details: ['disk on fire'] });
    hooks.config = () => {
      throw 'a string';
    };
    expect((await doctor(w)).config?.details).toEqual(['a string']);
  });

  it('says there is no config when run outside a repository', async () => {
    const w = world({ git: false });
    const c = await doctor(w);
    expect(c.config).toMatchObject({ status: 'fail', summary: 'no .orbit/config.yaml' });
  });
});

describe('storage', () => {
  it('without a repository there is nothing to check', async () => {
    const w = world({ git: false });
    const c = await doctor(w, { config: cfg() });
    expect(c.storage).toMatchObject({ status: 'warn', summary: 'no repository, so no state database to check', missing: 'a repository', fix: null });
  });

  it('proves WAL and write access on a scratch database when no state exists yet, and creates nothing in the repository', async () => {
    const w = world();
    const c = await doctor(w, { config: cfg() });
    expect(c.storage).toMatchObject({ status: 'pass', summary: 'no state database yet; it will be created in .orbit/ (WAL works, directory writable)' });
    expect(existsSync(join(w.repo, '.orbit'))).toBe(false);
    expect(existsSync(join(w.repo, '.orbit', 'state.sqlite'))).toBe(false);
  });

  it('fails when the scratch database cannot use WAL, or the directory is not writable', async () => {
    const w = world();
    hooks.openDb = (path) => (path.endsWith('probe.sqlite') ? { get: () => ({ journal_mode: 'delete' }), close() {} } : undefined);
    const nowal = await doctor(w, { config: cfg() });
    expect(nowal.storage).toMatchObject({ status: 'fail', summary: 'SQLite cannot use WAL on this filesystem (journal_mode=delete)', missing: 'WAL journaling', fix: 'use a local disk, not a network or container bind mount' });
    hooks.openDb = (path) => (path.endsWith('probe.sqlite') ? { get: () => undefined, close() {} } : undefined);
    expect((await doctor(w, { config: cfg() })).storage?.summary).toBe('SQLite cannot use WAL on this filesystem (journal_mode=undefined)');
    hooks.openDb = null;
    if (process.getuid?.() !== 0) {
      chmodSync(w.repo, 0o500);
      const ro = await doctor(w, { config: cfg() });
      expect(ro.storage).toMatchObject({ status: 'fail', summary: `${w.repo} is not writable`, missing: 'a writable .orbit directory', fix: 'fix permissions' });
      chmodSync(w.repo, 0o755);
      mkdirSync(join(w.repo, '.orbit'));
      chmodSync(join(w.repo, '.orbit'), 0o500);
      expect((await doctor(w, { config: cfg() })).storage?.summary).toBe(`${join(w.repo, '.orbit')} is not writable`);
      chmodSync(join(w.repo, '.orbit'), 0o755);
    }
  });

  it('reads the schema version of an existing state database, and warns when it is not in WAL mode', async () => {
    const w = world();
    mkdirSync(join(w.repo, '.orbit'), { recursive: true });
    openDb(stateDbPath(w.repo)).close();
    const ok = await doctor(w, { config: cfg() });
    expect(ok.storage).toMatchObject({ status: 'pass', summary: expect.stringMatching(/^state database writable, WAL, schema version \d+\/\d+$/) });
    hooks.openDb = (path) =>
      path === stateDbPath(w.repo)
        ? { get: (sql: string) => (sql.includes('journal_mode') ? { journal_mode: 'DELETE' } : { user_version: 3 }), tx: (fn: () => void) => fn(), run: () => ({}), close() {} }
        : undefined;
    const delete_ = await doctor(w, { config: cfg() });
    expect(delete_.storage).toMatchObject({ status: 'warn', summary: `${stateDbPath(w.repo)} is not in WAL mode (journal_mode=DELETE)`, missing: 'WAL journaling' });
  });

  it('fails with the reason when the database cannot be used', async () => {
    const w = world();
    mkdirSync(join(w.repo, '.orbit'), { recursive: true });
    writeFileSync(stateDbPath(w.repo), 'this is not a sqlite database at all');
    const c = await doctor(w, { config: cfg() });
    expect(c.storage).toMatchObject({ status: 'fail', missing: 'a writable, current state.sqlite', fix: 'check file permissions and that Orbit is not older than the database' });
    expect(c.storage!.summary).toMatch(/^state database problem: /);
    hooks.openDb = (path) => (path === stateDbPath(w.repo) ? new Error('x'.repeat(300)) : undefined);
    expect((await doctor(w, { config: cfg() })).storage!.summary.length).toBeLessThan(260);
    hooks.openDb = (path) => (path === stateDbPath(w.repo) ? (() => { throw 'plain'; })() : undefined);
  });
});

describe('configured checks', () => {
  const check = (id: string, over: Partial<ReturnType<typeof defaultCheck>> = {}) => ({ ...defaultCheck(id), command: ['node', '-e', '0'], ...over });

  it('warns when no check is defined at all', async () => {
    const w = world();
    const c = await doctor(w, { config: cfg() });
    expect(c.checks).toMatchObject({ status: 'warn', summary: 'no checks are defined', fix: 'define checks in .orbit/config.yaml (see the commented examples)' });
  });

  it('resolves each check\'s command without running it, and lists where it found it', async () => {
    const w = world();
    const node = exe(w.bin, 'acme-lint');
    mkdirSync(join(w.repo, 'node_modules', '.bin'), { recursive: true });
    const local = exe(join(w.repo, 'node_modules', '.bin'), 'acme-local');
    exe(w.repo, 'run-tests.sh');
    const c = await doctor(w, {
      config: cfg((x) => {
        x.checks = {
          lint: check('lint', { command: ['acme-lint', '--fix'] }),
          local: check('local', { command: ['acme-local'] }),
          script: check('script', { command: ['./run-tests.sh'] }),
          shell: check('shell', { shell: true, command: ['FOO=1 BAR=2 acme-lint --all && echo done'] }),
          builtin: check('builtin', { shell: true, command: ['cd sub && make'] }),
        };
      }),
    });
    expect(c.checks).toMatchObject({ status: 'pass', summary: '5 check(s) resolve' });
    expect(c.checks!.details).toEqual([
      `lint: acme-lint -> ${node}`,
      `local: acme-local -> ${local}`,
      `script: ./run-tests.sh -> ${join(w.repo, 'run-tests.sh')}`,
      `shell: acme-lint -> ${node}`,
      'builtin: shell builtin "cd" (not resolved)',
    ]);
  });

  it('fails for a mandatory check whose command is missing and only warns for an optional one, naming the working directory', async () => {
    const w = world();
    mkdirSync(join(w.repo, 'web'));
    const optional = await doctor(w, { config: cfg((x) => (x.checks = { e2e: check('e2e', { command: ['no-such-tool'], mandatory: false, cwd: 'web' }) })) });
    expect(optional.checks).toMatchObject({ status: 'warn', summary: '1 of 1 check(s) cannot run', missing: 'the executable or script a configured check runs', fix: 'install it, or correct the check in .orbit/config.yaml' });
    expect(optional.checks!.details).toEqual(['e2e: "no-such-tool" was not found (optional check) (cwd web)']);
    const both = await doctor(w, { config: cfg((x) => (x.checks = { a: check('a', { command: ['no-such-tool'] }), b: check('b', { command: ['also-missing'], mandatory: false }) })) });
    expect(both.checks).toMatchObject({ status: 'fail', summary: '2 of 2 check(s) cannot run' });
    expect(both.checks!.details).toEqual(['a: "no-such-tool" was not found', 'b: "also-missing" was not found (optional check)']);
    // A warning after a failure does not soften it.
    const order = await doctor(w, { config: cfg((x) => (x.checks = { b: check('b', { command: ['also-missing'], mandatory: false }), a: check('a', { command: ['no-such-tool'] }) })) });
    expect(order.checks!.status).toBe('fail');
  });

  it('reports a check with no command, whether argv or shell', async () => {
    const w = world();
    const c = await doctor(w, { config: cfg((x) => (x.checks = { empty: check('empty', { command: [] }), blank: check('blank', { shell: true, command: ['   '] }), assignments: check('assignments', { shell: true, command: ['A=1 B=2'], mandatory: false }) })) });
    expect(c.checks).toMatchObject({ status: 'fail', summary: '3 of 3 check(s) cannot run' });
    expect(c.checks!.details).toEqual(['empty: has no command', 'blank: has no command', 'assignments: has no command']);
    const shellEmpty = await doctor(w, { config: cfg((x) => (x.checks = { none: check('none', { shell: true, command: [] , mandatory: false }) })) });
    expect(shellEmpty.checks!.status).toBe('warn');
  });

  it('catches a package-manager script that does not exist before the first run does', async () => {
    const w = world();
    for (const pm of ['npm', 'pnpm', 'yarn']) exe(w.bin, pm);
    writeFileSync(join(w.repo, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'vitest', broken: 5 } }));
    mkdirSync(join(w.repo, 'apps', 'web'), { recursive: true });
    writeFileSync(join(w.repo, 'apps', 'web', 'package.json'), '{ not json');
    const c = await doctor(w, {
      config: cfg((x) => {
        x.checks = {
          build: check('build', { command: ['npm', 'run', 'build'] }),
          unit: check('unit', { command: ['pnpm', 'test'] }),
          lint: check('lint', { command: ['npm', 'run', 'lint'] }),
          run_script: check('run_script', { command: ['yarn', 'run-script', 'test'] }),
          broken: check('broken', { command: ['npm', 'run', 'broken'], mandatory: false }),
          web: check('web', { command: ['npm', 'run', 'dev'], cwd: 'apps/web' }),
          install: check('install', { command: ['npm', 'install'] }),
          bare: check('bare', { command: ['npm'] }),
        };
      }),
    });
    expect(c.checks).toMatchObject({ status: 'fail', summary: '3 of 8 check(s) cannot run' });
    expect(c.checks!.details).toContain('lint: npm script "lint" is not defined in package.json');
    expect(c.checks!.details).toContain('broken: npm script "broken" is not defined in package.json');
    expect(c.checks!.details).toContain(`web: npm script "dev" is not defined in ${join('apps', 'web', 'package.json')}`);
    expect(c.checks!.details.some((d) => d.startsWith('build: npm -> '))).toBe(true);
    expect(c.checks!.details.some((d) => d.startsWith('unit: pnpm -> '))).toBe(true);
    expect(c.checks!.details.some((d) => d.startsWith('run_script: yarn -> '))).toBe(true);
    expect(c.checks!.details.some((d) => d.startsWith('install: npm -> '))).toBe(true);
    expect(c.checks!.details.some((d) => d.startsWith('bare: npm -> '))).toBe(true);
  });

  it('shows a path outside the repository in full', async () => {
    const w = world();
    exe(w.bin, 'npm');
    const outside = tmp();
    writeFileSync(join(outside, 'package.json'), '{}');
    const c = await doctor(w, { config: cfg((x) => (x.checks = { far: check('far', { command: ['npm', 'test'], cwd: outside }) })) });
    expect(c.checks!.details).toEqual([`far: npm script "test" is not defined in ${join(outside, 'package.json')}`]);
  });
});

describe('isolation', () => {
  it('passes with the provider, its limitations and what the probe said', async () => {
    const w = world();
    const c = await doctor(w, { config: cfg((x) => (x.isolation.provider = 'sandbox-runtime')) });
    expect(c.isolation).toMatchObject({ status: 'pass', summary: 'sandbox-runtime: srt 1.2 and seatbelt' });
    expect(c.isolation!.details[0]).toBe('provider: sandbox-runtime');
    expect(c.isolation!.details.slice(1).every((d) => d.startsWith('limitation: '))).toBe(true);
    expect(c.isolation!.details.length).toBeGreaterThan(3);
  });

  it('fails with the reason an unavailable sandbox gives, and names what is needed for each kind', async () => {
    const w = world();
    hooks.isolation = () => fakeIsolation('sandbox-runtime', false, 'srt not found on PATH');
    const srt = await doctor(w, { config: cfg((x) => (x.isolation.provider = 'sandbox-runtime')) });
    expect(srt.isolation).toMatchObject({ status: 'fail', summary: 'sandbox-runtime isolation is unavailable: srt not found on PATH', missing: 'sandbox-runtime isolation (the srt binary and Seatbelt or bubblewrap)', fix: expect.stringContaining('') });
    hooks.isolation = () => fakeIsolation('container', false, 'docker daemon not running');
    const container = await doctor(w, { config: cfg((x) => { x.isolation.provider = 'container'; x.isolation.container = null; }) });
    expect(container.isolation).toMatchObject({ status: 'fail', summary: 'container isolation is unavailable: docker daemon not running' });
    expect(container.isolation!.missing).toMatch(/Docker/i);
  });

  it('explains what happens when the policy forbids the isolation it asks for', async () => {
    const w = world();
    hooks.isolation = () => new OrbitError('CONFIG_INVALID', 'isolation.provider none needs allow_unisolated for unattended runs');
    const c = await doctor(w, { config: cfg() });
    expect(c.isolation).toMatchObject({ status: 'fail', summary: 'isolation.provider none needs allow_unisolated for unattended runs', missing: 'an isolation provider permitted for unattended runs', fix: 'set isolation.provider to sandbox-runtime or container' });
    hooks.isolation = () => new Error('x'.repeat(400));
    expect((await doctor(w, { config: cfg() })).isolation!.summary.length).toBeLessThanOrEqual(240);
  });

  it('warns that no isolation means the full permissions of the user, listing the limitations', async () => {
    const w = world();
    hooks.isolation = () => fakeIsolation('none', true, 'not isolated');
    const c = await doctor(w, { config: cfg() });
    expect(c.isolation).toMatchObject({ status: 'warn', missing: 'an isolation provider', fix: 'use sandbox-runtime or container' });
    expect(c.isolation!.summary).toContain("no isolation: workers and checks run with the Orbit user's full permissions");
    expect(c.isolation!.details[0]).toBe('provider: none');
    expect(c.isolation!.details.length).toBeGreaterThan(3);
  });

  it('checks that the container image is present locally, and says how to get it', async () => {
    const w = world();
    hooks.isolation = () => fakeIsolation('container', true, 'docker 27 running');
    const withImage = (c: OrbitConfig) => {
      c.isolation.provider = 'container';
      c.isolation.container = { image: 'acme/runner:1', memory_mb: 512, cpus: 1, pids: 100 };
    };
    const asked: string[][] = [];
    hooks.exec = (argv) => (argv[0] === 'docker' ? (asked.push([...argv]), { exitCode: 1, signal: null, stdout: '', stderr: 'no such image' }) : undefined);
    const missing = await doctor(w, { config: cfg(withImage) });
    expect(missing.isolation).toMatchObject({ status: 'fail', summary: 'container image acme/runner:1 is not present locally', fix: 'docker pull acme/runner:1' });
    expect(missing.isolation!.missing).toContain('acme/runner:1');
    expect(asked[0]).toEqual(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'acme/runner:1']);
    hooks.exec = (argv) => (argv[0] === 'docker' ? new Error('spawn docker ENOENT') : undefined);
    expect((await doctor(w, { config: cfg(withImage) })).isolation?.status).toBe('fail');
    hooks.exec = (argv) => (argv[0] === 'docker' ? { exitCode: 0, signal: null, stdout: 'sha256:abc\n', stderr: '' } : undefined);
    const present = await doctor(w, { config: cfg(withImage) });
    expect(present.isolation).toMatchObject({ status: 'pass', summary: 'container: docker 27 running' });
    expect(present.isolation!.details.some((d) => d.startsWith('limitation: Host allowlisting is not available in containers'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Browsers

function uiConfig(over: Partial<NonNullable<OrbitConfig['ui']>> = {}): NonNullable<OrbitConfig['ui']> {
  return {
    required_when_ui_changes: false,
    ui_paths: [],
    browsers: ['chromium'],
    viewports: [{ width: 1280, height: 800 }],
    environment: { base_url: 'http://localhost:3000', start_command: null, ready_timeout_seconds: 30, isolated_test_data: true, production_accounts: false },
    journey_check_ids: [],
    accessibility: { enabled: false, fail_on_new_serious_or_critical: false },
    visual: { enabled: false, baseline_changes_require_review: true, baseline_globs: [] },
    visual_baseline_auto_accept: false,
    ...over,
  };
}

function installPlaywright(repo: string, opts: { core?: boolean; browsers?: unknown; axe?: boolean } = {}): void {
  const nm = join(repo, 'node_modules');
  mkdirSync(join(nm, '@playwright', 'test'), { recursive: true });
  writeFileSync(join(nm, '@playwright', 'test', 'package.json'), JSON.stringify({ name: '@playwright/test', version: '1.50.0' }));
  if (opts.core !== false) {
    mkdirSync(join(nm, 'playwright-core'), { recursive: true });
    writeFileSync(join(nm, 'playwright-core', 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.50.0' }));
    if (opts.browsers !== undefined) writeFileSync(join(nm, 'playwright-core', 'browsers.json'), typeof opts.browsers === 'string' ? opts.browsers : JSON.stringify(opts.browsers));
  }
  if (opts.axe) {
    mkdirSync(join(nm, '@axe-core', 'playwright'), { recursive: true });
    writeFileSync(join(nm, '@axe-core', 'playwright', 'package.json'), JSON.stringify({ name: '@axe-core/playwright', version: '4.0.0' }));
  }
}

describe('browsers', () => {
  const BROWSERS = { browsers: [{ name: 'chromium', revision: '1234' }, { name: 'firefox', revision: '5678' }] };

  it('is not required without a ui section or a playwright check', async () => {
    const w = world();
    const c = await doctor(w, { config: cfg() });
    expect(c.playwright).toMatchObject({ status: 'pass', summary: 'not required: no ui section and no playwright check is configured' });
  });

  it('fails when @playwright/test or playwright-core is missing from the repository', async () => {
    const w = world();
    const wanted = cfg((x) => (x.ui = uiConfig()));
    const none = await doctor(w, { config: wanted });
    expect(none.playwright).toMatchObject({ status: 'fail', summary: '@playwright/test is not installed in this repository', fix: 'npm install -D @playwright/test, then npx playwright install' });
    installPlaywright(w.repo, { core: false });
    const noCore = await doctor(w, { config: wanted });
    expect(noCore.playwright).toMatchObject({ status: 'fail', summary: 'playwright-core is missing next to @playwright/test', missing: 'playwright-core', fix: 'reinstall dependencies' });
    const viaCheck = await doctor(w, { config: cfg((x) => (x.checks = { e2e: { ...defaultCheck('e2e'), command: ['npx', 'playwright', 'test'], kind: 'playwright' } })) });
    expect(viaCheck.playwright?.status).toBe('fail');
  });

  it('looks for each browser at its revision in the cache the platform uses, and says where', async () => {
    const w = world();
    installPlaywright(w.repo, { browsers: BROWSERS });
    const cache = tmp('orbit-pw-');
    mkdirSync(join(cache, 'chromium-1234'));
    const env = { ...w.env, PLAYWRIGHT_BROWSERS_PATH: cache };
    const ok = await doctor(w, { config: cfg((x) => (x.ui = uiConfig())), ctx: { env } });
    expect(ok.playwright).toMatchObject({ status: 'pass', summary: 'Playwright and its browsers are installed', details: [`chromium: installed (${cache})`] });
    const headless = tmp('orbit-pw-');
    mkdirSync(join(headless, 'chromium_headless_shell-1234'));
    expect((await doctor(w, { config: cfg((x) => (x.ui = uiConfig())), ctx: { env: { ...w.env, PLAYWRIGHT_BROWSERS_PATH: headless } } })).playwright?.status).toBe('pass');
    const missing = await doctor(w, { config: cfg((x) => (x.ui = uiConfig({ browsers: ['chromium', 'firefox'] }))), ctx: { env } });
    expect(missing.playwright).toMatchObject({ status: 'fail', summary: 'missing: firefox', missing: 'Playwright browsers/packages: firefox', fix: 'npx playwright install firefox' });
    expect(missing.playwright!.details).toEqual([`chromium: installed (${cache})`, `firefox: not found in ${cache}`]);
    // A browser the installed playwright does not list has no revision to look for: reported, not a failure.
    const unknown = await doctor(w, { config: cfg((x) => (x.ui = uiConfig({ browsers: ['webkit'] }))), ctx: { env } });
    expect(unknown.playwright).toMatchObject({ status: 'pass', details: [`webkit: not found in ${cache}`] });
  });

  it('uses the default browser when the ui section names none, and the per-platform cache when no override is set', async () => {
    const w = world();
    installPlaywright(w.repo, { browsers: BROWSERS });
    const noBrowsers = { ...uiConfig(), browsers: undefined as unknown as string[] };
    const home = w.home;
    const where = async (platform: NodeJS.Platform, env: Record<string, string | undefined>) => {
      const c = await doctor(w, { config: cfg((x) => (x.ui = noBrowsers)), ctx: { platform, env: { ...w.env, ...env } } });
      return /not found in (.*)$/.exec(c.playwright!.details[0]!)![1];
    };
    expect(await where('darwin', {})).toBe(join(home, 'Library', 'Caches', 'ms-playwright'));
    expect(await where('linux', {})).toBe(join(home, '.cache', 'ms-playwright'));
    expect(await where('linux', { XDG_CACHE_HOME: '/xdg' })).toBe(join('/xdg', 'ms-playwright'));
    expect(await where('win32', {})).toBe(join(home, 'AppData', 'Local', 'ms-playwright'));
    expect(await where('win32', { LOCALAPPDATA: 'C:\\local' })).toBe(join('C:\\local', 'ms-playwright'));
    expect(await where('linux', { PLAYWRIGHT_BROWSERS_PATH: '0' })).toBe(join(home, '.cache', 'ms-playwright'));
  });

  it('says when the browser list cannot be read, and treats a list without browsers as empty', async () => {
    const w = world();
    installPlaywright(w.repo, { browsers: '{ nope' });
    const bad = await doctor(w, { config: cfg((x) => (x.ui = uiConfig())) });
    expect(bad.playwright!.details[0]).toBe('browsers.json could not be read; browser revisions are not checked');
    expect(bad.playwright!.status).toBe('pass');
    installPlaywright(w.repo, { browsers: {} });
    const empty = await doctor(w, { config: cfg((x) => (x.ui = uiConfig())) });
    expect(empty.playwright!.details).toHaveLength(1);
    expect(empty.playwright!.details[0]).toMatch(/^chromium: not found in /);
  });

  it('checks the accessibility package only when accessibility scans are enabled', async () => {
    const w = world();
    installPlaywright(w.repo, { browsers: BROWSERS });
    const cache = tmp('orbit-pw-');
    mkdirSync(join(cache, 'chromium-1234'));
    const env = { ...w.env, PLAYWRIGHT_BROWSERS_PATH: cache };
    const a11y = (x: OrbitConfig) => (x.ui = uiConfig({ accessibility: { enabled: true, fail_on_new_serious_or_critical: true } }));
    const missing = await doctor(w, { config: cfg(a11y), ctx: { env } });
    expect(missing.playwright).toMatchObject({ status: 'fail', summary: 'missing: @axe-core/playwright', fix: 'npx playwright install' });
    expect(missing.playwright!.details).toContain('@axe-core/playwright: not installed (accessibility scans are enabled in the ui policy)');
    installPlaywright(w.repo, { browsers: BROWSERS, axe: true });
    const present = await doctor(w, { config: cfg(a11y), ctx: { env } });
    expect(present.playwright).toMatchObject({ status: 'pass' });
    expect(present.playwright!.details).toContain('@axe-core/playwright: installed');
  });
});

// ---------------------------------------------------------------------------
// Delivery and secret scanning

describe('delivery', () => {
  const delivering = (x: OrbitConfig) => {
    x.mode = 'autonomous-delivery';
    x.actions.open_pull_request = true;
    x.actions.push_task_branch = true;
  };
  const OK = JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'acme-bot', tokenSource: 'GH_TOKEN', scopes: 'repo, workflow' }] } });
  const ghEnv = (w: World, extra: Record<string, string | undefined> = {}) => ({ ...w.env, PATH: w.bin, ...extra });
  const asked: string[][] = [];
  beforeEach(() => (asked.length = 0));
  const answer = (stdout: string, exitCode = 0, stderr = '') => (argv: readonly string[]) => (argv[1] === 'auth' ? (asked.push([...argv]), { exitCode, signal: null, stdout, stderr }) : undefined);

  it('is not required for the fake provider, or for a mode that does not deliver', async () => {
    const w = world();
    const fake = await doctor(w, { config: cfg((x) => { delivering(x); x.delivery.provider = 'fake'; }) });
    expect(fake.delivery).toMatchObject({ status: 'pass', summary: 'not required: delivery uses the fake provider' });
    const quiet = await doctor(w, { config: cfg() });
    expect(quiet.delivery).toMatchObject({ status: 'pass', summary: 'not required: mode autonomous does not deliver' });
    const noActions = await doctor(w, { config: cfg((x) => { x.mode = 'autonomous-delivery'; x.actions.open_pull_request = false; x.actions.push_task_branch = false; x.actions.repair_ci = false; }) });
    expect(noActions.delivery?.summary).toBe('not required: mode autonomous-delivery does not deliver');
    const repairOnly = await doctor(w, { config: cfg((x) => { x.mode = 'autonomous-delivery'; x.actions.open_pull_request = false; x.actions.push_task_branch = false; x.actions.repair_ci = true; }), ctx: { env: ghEnv(w) } });
    expect(repairOnly.delivery?.status).toBe('fail');
  });

  it('fails when gh is missing or no scoped token is set for the controller', async () => {
    const w = world();
    const noGh = await doctor(w, { config: cfg(delivering), ctx: { env: ghEnv(w) } });
    expect(noGh.delivery).toMatchObject({ status: 'fail', summary: 'the gh CLI was not found', missing: 'the gh executable on PATH', fix: 'install GitHub CLI (https://cli.github.com)' });
    exe(w.bin, 'gh');
    const noToken = await doctor(w, { config: cfg(delivering), ctx: { env: ghEnv(w) } });
    expect(noToken.delivery).toMatchObject({ status: 'fail', summary: 'GH_TOKEN is not set for the controller', fix: 'export GH_TOKEN in the environment the controller or service runs in' });
    expect(noToken.delivery!.missing).toContain('fine-grained GH_TOKEN');
  });

  it('asks gh for its auth status with only the environment it needs, and reports who is logged in', async () => {
    const w = world();
    const gh = exe(w.bin, 'gh');
    hooks.exec = answer(OK);
    const c = await doctor(w, { config: cfg(delivering), ctx: { env: ghEnv(w, { GH_TOKEN: 'fixture-token', SECRET_THING: 'leak', ANTHROPIC_API_KEY: 'k' }) } });
    expect(c.delivery).toMatchObject({ status: 'pass', summary: 'gh authenticated as acme-bot via GH_TOKEN', details: ['scopes: repo, workflow'] });
    expect(asked).toEqual([[gh, 'auth', 'status', '--json', 'hosts']]);
    hooks.exec = answer(JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', tokenSource: 'GH_TOKEN' }] } }));
    const noScopes = await doctor(w, { config: cfg(delivering), ctx: { env: ghEnv(w, { GH_TOKEN: 't' }) } });
    expect(noScopes.delivery).toMatchObject({ status: 'pass', summary: 'gh authenticated as unknown via GH_TOKEN' });
    expect(noScopes.delivery!.details[0]).toContain('not reported (fine-grained tokens carry repository permissions instead)');
  });

  it('fails with the reason when gh cannot run, exits non-zero, or the credential is not usable', async () => {
    const w = world();
    exe(w.bin, 'gh');
    const env = ghEnv(w, { GH_TOKEN: 't' });
    hooks.exec = (argv) => (argv[1] === 'auth' ? new Error('spawn gh EACCES\nsecond line') : undefined);
    expect((await doctor(w, { config: cfg(delivering), ctx: { env } })).delivery).toMatchObject({ status: 'fail', summary: 'gh could not run: spawn gh EACCES second line', missing: 'a working gh CLI', fix: null });
    const token = ['gh', 'p_', 'Q1w2E3r4T5'.repeat(4)].join('');
    hooks.exec = answer('', 1, `HTTP 401 with token ${token}`);
    const failed = await doctor(w, { config: cfg(delivering), ctx: { env } });
    expect(failed.delivery).toMatchObject({ status: 'fail', missing: 'a valid GitHub credential', fix: 'gh auth login, or export a valid GH_TOKEN' });
    expect(failed.delivery!.summary).toMatch(/^gh auth status failed: HTTP 401 with token /);
    expect(failed.delivery!.summary).not.toContain(token);
    hooks.exec = answer(JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', tokenSource: 'keyring', login: 'x' }] } }));
    const broad = await doctor(w, { config: cfg(delivering), ctx: { env } });
    expect(broad.delivery).toMatchObject({ status: 'fail', missing: 'a valid GH_TOKEN', fix: 'export a valid fine-grained GH_TOKEN' });
    expect(broad.delivery!.summary).toBe('GitHub credential is not usable: the active credential comes from keyring, not a scoped GH_TOKEN');
    hooks.exec = answer(JSON.stringify({ hosts: {} }));
    expect((await doctor(w, { config: cfg(delivering), ctx: { env } })).delivery?.summary).toBe('GitHub credential is not usable: no active account for github.com');
  });

  it('only warns when gh answers with something it cannot read', async () => {
    const w = world();
    exe(w.bin, 'gh');
    hooks.exec = answer('this is not json');
    const c = await doctor(w, { config: cfg(delivering), ctx: { env: ghEnv(w, { GH_TOKEN: 't' }) } });
    expect(c.delivery).toMatchObject({ status: 'warn', missing: 'a gh version that supports "auth status --json hosts"', fix: 'upgrade gh' });
    expect(c.delivery!.summary).toMatch(/^gh auth status gave an unreadable answer: /);
  });
});

describe('secret scanning', () => {
  it('reports where gitleaks is, or that the built-in patterns are used', async () => {
    const w = world();
    const none = await doctor(w, { config: cfg(), ctx: { env: { ...w.env, PATH: w.bin } } });
    expect(none.gitleaks).toMatchObject({ status: 'warn', missing: 'the gitleaks executable (optional)', fix: 'install gitleaks for a stronger secret scan' });
    expect(none.gitleaks!.summary).toContain("Orbit's built-in secret patterns are used");
    const tool = exe(w.bin, 'gitleaks');
    const found = await doctor(w, { config: cfg(), ctx: { env: { ...w.env, PATH: w.bin } } });
    expect(found.gitleaks).toMatchObject({ status: 'pass', summary: `gitleaks at ${tool} (the secret scan uses Orbit's trusted configuration)` });
  });
});

// ---------------------------------------------------------------------------
// Service

describe('service', () => {
  const runner = (printExit = 0, active = 'active\n'): CommandRunner => async (argv) => ({ exitCode: argv.includes('print') ? printExit : 0, stdout: argv.includes('is-active') ? active : '', stderr: '' });
  const install = (w: World, platform: 'darwin' | 'linux') => {
    const l = execLabel(w.repo);
    const path = platform === 'darwin' ? join(w.home, 'Library', 'LaunchAgents', `${l}.plist`) : join(w.home, '.config', 'systemd', 'user', `${l}.service`);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'definition');
    return path;
  };
  const noLinger = () => {
    hooks.exec = (argv) => (argv[0] === 'loginctl' ? { exitCode: 0, signal: null, stdout: 'Linger=yes\n', stderr: '' } : undefined);
  };

  it('has nothing to check without a repository, or on a platform without a service manager', async () => {
    const outside = world({ git: false });
    expect((await doctor(outside)).service).toMatchObject({ status: 'warn', summary: 'no repository, so no service to check', missing: 'a repository', fix: null });
    const w = world();
    const win = await doctor(w, { config: cfg(), ctx: { platform: 'win32' } });
    expect(win.service).toMatchObject({ status: 'warn', summary: 'persistent service is not supported on win32', fix: 'use "orbit run --foreground"' });
  });

  it('warns when the service manager cannot be asked', async () => {
    const w = world();
    const c = await doctor(w, { config: cfg(), ctx: { platform: 'darwin', seams: { serviceRunner: async () => { throw new Error('launchctl: not found'); } } } });
    expect(c.service).toMatchObject({ status: 'warn', summary: 'service status could not be read: launchctl: not found', missing: 'launchctl or systemctl', fix: null });
    const plain = await doctor(w, { config: cfg(), ctx: { platform: 'darwin', seams: { serviceRunner: async () => Promise.reject('plain') } } });
    expect(plain.service?.summary).toBe('service status could not be read: plain');
  });

  it('says no service is installed, with the definition path and that no controller has registered', async () => {
    const w = world();
    noLinger();
    const c = await doctor(w, { config: cfg(), ctx: { platform: 'darwin', seams: { serviceRunner: runner(113) } } });
    expect(c.service).toMatchObject({ status: 'warn', summary: 'no service is installed, so runs only progress while a terminal is attached', fix: 'orbit service install' });
    expect(c.service!.details).toEqual([`label: ${execLabel(w.repo)}`, `definition: ${join(w.home, 'Library', 'LaunchAgents', `${execLabel(w.repo)}.plist`)}`, 'heartbeat: no controller has registered in this repository']);
  });

  it('says an installed service is not loaded, or that its state is unknown', async () => {
    const w = world();
    install(w, 'darwin');
    const notLoaded = await doctor(w, { config: cfg(), ctx: { platform: 'darwin', seams: { serviceRunner: runner(113) } } });
    expect(notLoaded.service).toMatchObject({ status: 'warn', summary: 'service installed but not loaded', missing: 'a loaded service', fix: 'orbit service install (reloads it)' });
    const unknown = await doctor(w, { config: cfg(), ctx: { platform: 'darwin', seams: { serviceRunner: runner(9) } } });
    expect(unknown.service!.summary).toBe('service installed but state unknown (launchctl print exited 9)');
  });

  it('reads controller heartbeats from the state database: live, stale and stopped', async () => {
    const w = world();
    install(w, 'darwin');
    mkdirSync(join(w.repo, '.orbit'), { recursive: true });
    const db = openDb(stateDbPath(w.repo));
    const now = Date.now();
    registerController(db, { id: 'ctl-live', pid: process.pid, host: 'h.invalid', mode: 'service' }, { now: () => now, sleep: systemClock.sleep });
    registerController(db, { id: 'ctl-old', pid: 4242, host: 'h.invalid', mode: 'foreground' }, { now: () => now - 10 * 60_000, sleep: systemClock.sleep });
    registerController(db, { id: 'ctl-done', pid: 4243, host: 'h.invalid', mode: 'foreground' }, { now: () => now - 20 * 60_000, sleep: systemClock.sleep });
    markControllerStopped(db, 'ctl-done', 'finished', { now: () => now - 19 * 60_000, sleep: systemClock.sleep });
    db.close();
    const c = await doctor(w, { config: cfg(), ctx: { platform: 'darwin', seams: { serviceRunner: runner(0) } } });
    expect(c.service).toMatchObject({ status: 'pass', summary: 'service loaded and its controller heartbeat is fresh' });
    const beat = c.service!.details.find((d) => d.startsWith('heartbeat: '))!;
    expect(beat).toContain(`service controller pid ${process.pid}: heartbeat`);
    expect(beat).toMatch(/\(live\)/);
    expect(beat).toMatch(/foreground controller pid 4242: heartbeat 10m ago \(stale\)/);
    // A controller that stopped on purpose is not listed at all.
    expect(beat).not.toContain('4243');
  });

  it('warns when the controller heartbeat is stale, and still passes when nothing has published one yet', async () => {
    const w = world();
    install(w, 'darwin');
    mkdirSync(join(w.repo, '.orbit'), { recursive: true });
    const db = openDb(stateDbPath(w.repo));
    registerController(db, { id: 'ctl-old', pid: 4242, host: 'h.invalid', mode: 'service' }, { now: () => Date.now() - 10 * 60_000, sleep: systemClock.sleep });
    db.close();
    const stale = await doctor(w, { config: cfg(), ctx: { platform: 'darwin', seams: { serviceRunner: runner(0) } } });
    expect(stale.service).toMatchObject({ status: 'warn', summary: 'service is loaded but its controller heartbeat is stale', missing: 'a fresh controller heartbeat (it may be wedged or still starting)' });
    expect(stale.service!.fix).toContain(join(w.home, '.orbit', 'logs'));
    const fresh = world();
    install(fresh, 'darwin');
    const quiet = await doctor(fresh, { config: cfg(), ctx: { platform: 'darwin', seams: { serviceRunner: runner(0) } } });
    expect(quiet.service).toMatchObject({ status: 'pass', summary: 'service loaded; the controller has not published a heartbeat yet' });
  });

  it('copes with a state database it cannot read', async () => {
    const w = world();
    install(w, 'darwin');
    mkdirSync(join(w.repo, '.orbit'), { recursive: true });
    writeFileSync(stateDbPath(w.repo), 'not a database');
    const c = await doctor(w, { config: cfg(), ctx: { platform: 'darwin', seams: { serviceRunner: runner(0) } } });
    expect(c.service!.details).toContain('heartbeat: the state database could not be read');
    expect(c.service!.status).toBe('pass');
  });

  it('on Linux warns that a user service stops at logout when lingering is off', async () => {
    const w = world();
    install(w, 'linux');
    hooks.exec = (argv) => (argv[0] === 'loginctl' ? { exitCode: 0, signal: null, stdout: 'Linger=no\n', stderr: '' } : undefined);
    const c = await doctor(w, { config: cfg(), ctx: { platform: 'linux', seams: { serviceRunner: runner(0, 'active\n') } } });
    expect(c.service).toMatchObject({ status: 'warn', summary: 'service is loaded; lingering is off', missing: 'systemd lingering', fix: 'loginctl enable-linger alice' });
    expect(c.service!.details).toContain('lingering is off for alice: the service stops at logout (loginctl enable-linger alice)');
    const lingerOn = world();
    install(lingerOn, 'linux');
    noLinger();
    const ok = await doctor(lingerOn, { config: cfg(), ctx: { platform: 'linux', seams: { serviceRunner: runner(0, 'active\n') } } });
    expect(ok.service?.status).toBe('pass');
    // Not installed and lingering off: both facts are reported.
    const bare = world();
    hooks.exec = (argv) => (argv[0] === 'loginctl' ? { exitCode: 0, signal: null, stdout: 'Linger=no\n', stderr: '' } : undefined);
    const none = await doctor(bare, { config: cfg(), ctx: { platform: 'linux', seams: { serviceRunner: runner(0, 'inactive\n') } } });
    expect(none.service!.summary).toContain('no service is installed');
    expect(none.service!.details.some((d) => d.startsWith('lingering is off'))).toBe(true);
  });
});

import { serviceLabel } from '../../../src/controller/service.ts';
function execLabel(repo: string): string {
  return serviceLabel(repo);
}

// ---------------------------------------------------------------------------
// Publication guard

describe('publication guard', () => {
  it('warns when there is no private-terms file, and fails when learning would share globally without one', async () => {
    const w = world();
    const warn = await doctor(w, { config: cfg() });
    expect(warn['guard.terms']).toMatchObject({ status: 'warn', missing: 'the private-terms file (checked before anything leaves this repository)' });
    expect(warn['guard.terms']!.summary).toBe(`no publish-guard terms file at ${join(w.home, '.config', 'publish-guard', 'terms.txt')}`);
    expect(warn['guard.terms']!.fix).toContain('create it to have private terms checked');
    const fail = await doctor(w, { config: cfg((x) => (x.knowledge.share_globally = true)) });
    expect(fail['guard.terms']).toMatchObject({ status: 'fail', fix: 'create it, or set knowledge.share_globally: false' });
  });

  it('reports a terms file it finds without printing a term, from the default place or from the policy', async () => {
    const w = world();
    mkdirSync(join(w.home, '.config', 'publish-guard'), { recursive: true });
    writeFileSync(join(w.home, '.config', 'publish-guard', 'terms.txt'), '# private\nacme-secret-project\nre:codename-[0-9]+\n');
    const c = await doctor(w, { config: cfg() });
    expect(c['guard.terms']).toMatchObject({ status: 'pass', summary: 'publish-guard terms file present (2 term(s); never printed)' });
    expect(JSON.stringify(c['guard.terms'])).not.toContain('acme-secret-project');
    expect(c['guard.terms']!.details[0]).toBe(`path: ${join(w.home, '.config', 'publish-guard', 'terms.txt')}`);
    const custom = join(w.base, 'my-terms.txt');
    writeFileSync(custom, 'one-term\nre:(\n');
    const viaPolicy = await doctor(w, { config: cfg((x) => (x.guard.terms_file = custom)) });
    expect(viaPolicy['guard.terms']).toMatchObject({ status: 'pass', summary: 'publish-guard terms file present (2 term(s); never printed)' });
    expect(viaPolicy['guard.terms']!.details.some((d) => d.includes('not a usable regular expression'))).toBe(true);
  });

  it('fails when the terms file the policy names does not exist, and says so without hiding the reason', async () => {
    const w = world();
    const c = await doctor(w, { config: cfg((x) => (x.guard.terms_file = join(w.base, 'absent-terms.txt'))) });
    expect(c['guard.terms']).toMatchObject({ status: 'fail', missing: 'a readable terms file', fix: 'fix the path or permissions; Orbit refuses to publish without it once it is configured' });
    expect(c['guard.terms']!.summary).toMatch(/^the publication guard cannot load its terms: publication guard: the configured terms file \(.*absent-terms\.txt\) does not exist; refusing to publish without it$/);
    const plain = world();
    mkdirSync(join(plain.home, '.config', 'publish-guard'), { recursive: true });
    writeFileSync(join(plain.home, '.config', 'publish-guard', 'config.json'), '{ "termsFile": "/nonexistent/terms.txt" }');
    const viaConfig = await doctor(plain, { config: cfg() });
    expect(['pass', 'warn', 'fail']).toContain(viaConfig['guard.terms']!.status);
  });
});

// ---------------------------------------------------------------------------
// The whole report and the command

describe('runDoctor and doctorCommand', () => {
  it('turns a check that throws into a failure of that check and carries on with the rest', async () => {
    const w = world();
    hooks.adapters = () => ({ 'mystery-ai': {} as ProviderAdapter });
    const c = await doctor(w, { config: cfg((x) => (x.providers = { 'mystery-ai': x.providers.claude! })) });
    expect(c.providers).toMatchObject({ status: 'fail', missing: null, fix: 'report this as an Orbit bug' });
    expect(c.providers!.summary).toMatch(/^this check crashed: /);
    expect(c.gitleaks).toBeDefined();
    expect(c['guard.terms']).toBeDefined();
  });

  it('reads the model registry from the repository\'s state, and reports a registry that cannot be read', async () => {
    const w = world();
    mkdirSync(join(w.repo, '.orbit'), { recursive: true });
    writeFileSync(stateDbPath(w.repo), 'not a database');
    const c = await doctor(w, { config: cfg() });
    expect(c.models).toMatchObject({ status: 'fail', missing: 'a readable model registry', fix: null });
    expect(c.models!.summary).toMatch(/^the model registry could not be read: /);
    hooks.openDb = (path) => (path === stateDbPath(w.repo) ? new Error('x'.repeat(300)) : undefined);
    expect((await doctor(w, { config: cfg() })).models!.summary.length).toBeLessThanOrEqual(240);
    hooks.openDb = (path) => (path === stateDbPath(w.repo) ? (() => { throw 'plain'; })() : undefined);
    expect((await doctor(w, { config: cfg() })).models!.summary).toBe('the model registry could not be read: plain');
  });

  it('counts passes, warnings and failures, and is ok only when nothing failed', async () => {
    const w = world();
    hooks.adapters = noAdapters;
    hooks.config = () => cfg();
    const report = await runDoctor(w.ctx(), { probe: false });
    expect(report.repo).toBe(w.repo);
    expect(report.counts.pass + report.counts.warn + report.counts.fail).toBe(report.checks.length);
    expect(report.ok).toBe(report.counts.fail === 0);
    const outside = world({ git: false });
    const none = await runDoctor(outside.ctx(), { probe: false });
    expect(none.repo).toBeNull();
    expect(none.ok).toBe(false);
  });

  async function command(w: World, argv: string[], over: Partial<CliContext> = {}) {
    const io = memoryIo();
    const args = parseCommand(argv, { probe: { type: 'boolean', description: '' } }, 'orbit doctor');
    const code = await doctorCommand(args, w.ctx({ io, ...over }));
    return { code, out: io.stdout };
  }

  it('prints each check with its status, what is missing and the fix, then a summary line, and exits 1 on a failure', async () => {
    const w = world({ git: false });
    hooks.adapters = noAdapters;
    const r = await command(w, []);
    expect(r.code).toBe(1);
    expect(r.out.split('\n')[0]).toBe('orbit doctor');
    expect(r.out).toMatch(/^PASS {2}runtime\.node {1,}Node v/m);
    expect(r.out).toMatch(/^FAIL {2}git\.repo {1,}not inside a git repository\n {6}missing: a git repository to run in\n {6}fix: {5}run from a repository, or pass --repo <dir>\n/m);
    expect(r.out).toMatch(/^WARN {2}storage /m);
    expect(r.out).toMatch(/\n\d+ passed, \d+ warning\(s\), [1-9]\d* failed\n$/);
  });

  it('names the repository, lists details under their check, and exits 0 when nothing failed', async () => {
    const w = world();
    hooks.adapters = noAdapters;
    hooks.config = () => cfg((x) => (x.checks = { unit: { ...defaultCheck('unit'), command: ['node', '-e', '0'] } }));
    hooks.exec = (argv) => (argv[0] === 'loginctl' ? { exitCode: 0, signal: null, stdout: 'Linger=yes\n', stderr: '' } : undefined);
    const binNode = exe(w.bin, 'node');
    const r = await command(w, [], { env: { ...w.env, PATH: `${w.bin}:${process.env.PATH}` } });
    expect(r.out.split('\n')[0]).toBe(`orbit doctor  (${w.repo})`);
    expect(r.out).toContain(`      unit: node -> ${binNode}\n`);
    const json = await command(w, ['--json']);
    const report = JSON.parse(json.out) as { repo: string; ok: boolean; counts: Record<string, number>; checks: Array<{ id: string }> };
    expect(report.repo).toBe(w.repo);
    expect(json.code).toBe(report.ok ? 0 : 1);
    expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['runtime.node', 'git.repo', 'checks', 'isolation', 'models', 'playwright', 'delivery', 'gitleaks', 'service', 'guard.terms']));
  });

  it('takes --repo and refuses an argument', async () => {
    const w = world({ git: false });
    const other = world();
    hooks.adapters = noAdapters;
    hooks.config = () => cfg();
    const args = parseCommand(['--repo', other.repo, '--json'], { probe: { type: 'boolean', description: '' } }, 'orbit doctor');
    const io = memoryIo();
    await doctorCommand(args, w.ctx({ io }));
    expect((JSON.parse(io.stdout) as { repo: string }).repo).toBe(other.repo);
    await expect(doctorCommand(parseCommand(['extra'], { probe: { type: 'boolean', description: '' } }, 'orbit doctor'), w.ctx())).rejects.toThrow('expected 0 argument(s), got 1');
  });
});
