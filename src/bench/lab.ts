/**
 * The bench lab: a throwaway git repository made from examples/demo-app (its own checks and .orbit/config.yaml), a
 * bare remote, the fake provider CLIs of tests/fakes behind the real adapters and worker shim, FakeGitHub for delivery,
 * and a private ORBIT_HOME. Every scenario of the lab tier drives the real controller, in this process, against one of
 * these. Nothing here reaches a model, a network or the user's repositories.
 *
 * It is the same harness tests/acceptance/helpers/lab.ts builds for the acceptance suite, kept here because src/ must
 * not import from tests/ (the command ships in the bundle). It needs an Orbit source checkout: the demo app and the
 * fakes are not part of an installed plugin, and `orbit bench --tier lab` says so when they are missing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemClock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { openDb, type OrbitDb } from '../storage/db.ts';
import { loadConfig } from '../policy/config.ts';
import type { OrbitConfig } from '../policy/types.ts';
import { createAdapter } from '../adapters/index.ts';
import type { ProviderAdapter } from '../adapters/types.ts';
import { ModelRegistry } from '../routing/registry.ts';
import { startRun, stateDbPath } from '../controller/start.ts';
import type { ControllerDeps } from '../controller/context.ts';
import { Controller } from '../controller/loop.ts';
import { getRun, type RunRecord } from '../controller/run-store.ts';
import { FakeGitHub } from '../delivery/github.ts';

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const SKIP = new Set(['DEMO.md', 'node_modules', 'test-results', 'playwright-report', 'state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'runs', 'worktrees', 'fake-github.json']);

/** The Orbit checkout this code runs from: src/bench/lab.ts and plugin/dist/orbit.mjs are both two levels below it. */
export function orbitCheckoutRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

export interface LabPaths {
  root: string;
  demo: string;
  fakeClaude: string;
  fakeCodex: string;
}

/** The files the lab needs from the checkout, or an error naming what is missing. */
export function labPaths(root: string = orbitCheckoutRoot()): LabPaths {
  const paths: LabPaths = { root, demo: join(root, 'examples', 'demo-app'), fakeClaude: join(root, 'tests', 'fakes', 'fake-claude.mjs'), fakeCodex: join(root, 'tests', 'fakes', 'fake-codex.mjs') };
  const missing = [join(paths.demo, 'package.json'), join(paths.demo, '.orbit', 'config.yaml'), paths.fakeClaude, paths.fakeCodex, join(root, 'node_modules')].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new OrbitError('NOT_FOUND', `the lab tier runs from an Orbit source checkout with its dependencies installed; missing ${missing.join(', ')}`, { missing });
  }
  return paths;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } }).trim();
}

export interface Lab {
  base: string;
  repo: string;
  remote: string;
  orbitHome: string;
  scenarioPath: string;
  config: OrbitConfig;
  db(): OrbitDb;
  runDir(runId: string): string;
  github(): FakeGitHub;
  close(): void;
}

export interface LabOptions {
  tweak?: (c: OrbitConfig) => void;
  /** Extra files committed on the base revision. */
  files?: Record<string, string>;
}

/** Makes labs from one prepared copy of the demo app, and removes everything it made. */
export class LabHost {
  readonly paths: LabPaths;
  private readonly templateBase: string;
  private readonly template: string;
  private readonly open = new Set<Lab>();
  private made = 0;

  constructor(root: string = orbitCheckoutRoot()) {
    this.paths = labPaths(root);
    this.templateBase = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-bench-template-')));
    this.template = join(this.templateBase, 'demo-app');
    cpSync(this.paths.demo, this.template, { recursive: true, filter: (src) => !SKIP.has(src.split('/').at(-1) ?? '') });
    // The example pins the versions Orbit's own dependencies have, so the lab links them rather than installing again.
    symlinkSync(join(this.paths.root, 'node_modules'), join(this.template, 'node_modules'));
  }

  /** The example's policy, made runnable here: no OS sandbox, the fake providers, FakeGitHub, linked dependencies. */
  private labConfig(repo: string, index: number, tweak?: (c: OrbitConfig) => void): OrbitConfig {
    const c = structuredClone(loadConfig(repo)) as OrbitConfig;
    c.isolation = { provider: 'none', allow_unisolated: true, container: null };
    c.providers = {
      claude: { command: this.paths.fakeClaude, data_policy_eligible: true, model: null, reasoning_effort: null, extra_args: [] },
      codex: { command: this.paths.fakeCodex, data_policy_eligible: true, model: 'gpt-6-astra', reasoning_effort: null, extra_args: [] },
    };
    c.delivery = { ...c.delivery, provider: 'fake' };
    c.dependencies = { ...c.dependencies, install_command: ['ln', '-sfn', join(repo, 'node_modules'), 'node_modules'] };
    c.knowledge = { ...c.knowledge, enabled: false };
    // No scenario starts the app; the address only has to be well formed, and nothing is bound for it.
    if (c.ui) c.ui.environment.base_url = `http://127.0.0.1:${41000 + index}`;
    tweak?.(c);
    return c;
  }

  make(opts: LabOptions = {}): Lab {
    const index = this.made++;
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-bench-')));
    const repo = join(base, 'repo');
    cpSync(this.template, repo, { recursive: true, filter: (p) => p === this.template || !p.startsWith(join(this.template, 'node_modules')) });
    symlinkSync(join(this.paths.root, 'node_modules'), join(repo, 'node_modules'));
    for (const [rel, content] of Object.entries(opts.files ?? {})) {
      mkdirSync(join(repo, rel, '..'), { recursive: true });
      writeFileSync(join(repo, rel), content);
    }
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Acme Controller');
    git(repo, 'config', 'user.email', 'controller@acme.test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Demo app');
    const remote = join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', remote);
    git(base, '-C', remote, 'config', 'core.hooksPath', join(remote, 'hooks'));
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'main');
    const config = this.labConfig(repo, index, opts.tweak);
    writeFileSync(join(base, 'policy.json'), JSON.stringify(config));
    let db: OrbitDb | null = null;
    const lab: Lab = {
      base,
      repo,
      remote,
      orbitHome: join(base, 'orbit-home'),
      scenarioPath: join(base, 'scenario.json'),
      config,
      db() {
        db ??= openDb(stateDbPath(repo));
        return db;
      },
      runDir: (runId) => join(repo, '.orbit', 'runs', runId),
      github: () => new FakeGitHub({ statePath: join(repo, '.orbit', 'fake-github.json'), remoteGitDir: remote }),
      close: () => {
        db?.close();
        db = null;
        this.open.delete(lab);
        // Review checkouts are read-only; one left by a stopped controller must not fail the cleanup.
        spawnSync('chmod', ['-R', 'u+w', base]);
        rmSync(base, { recursive: true, force: true });
      },
    };
    this.open.add(lab);
    return lab;
  }

  dispose(): void {
    for (const lab of [...this.open]) lab.close();
    rmSync(this.templateBase, { recursive: true, force: true });
  }

  /** The fake provider CLIs behind the real adapters, reading the lab's scenario file. */
  adapters(lab: Lab, argvLog?: string): Record<string, ProviderAdapter> {
    const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: lab.scenarioPath, ...(argvLog ? { ORBIT_FAKE_ARGV_LOG: argvLog } : {}) };
    const out: Record<string, ProviderAdapter> = {};
    for (const [id, pc] of Object.entries(lab.config.providers)) out[id] = createAdapter(id, pc, { claudeTier: 'claude-sandbox', graceMs: 300, baseEnv, clock: systemClock });
    return out;
  }

  deps(lab: Lab): Omit<ControllerDeps, 'ownerId'> {
    const db = lab.db();
    return {
      db,
      clock: systemClock,
      adapters: this.adapters(lab),
      registry: new ModelRegistry(db, systemClock),
      orbitHome: lab.orbitHome,
      hostEnv: process.env,
      orbitInstallDir: this.paths.root,
      // Deterministic across machines: the built-in secret patterns, not whatever gitleaks is installed.
      gitleaksPath: null,
      // ...and a fixed machine for scheduling (16 cores, 64 GB free), not whatever this host is doing.
      schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 },
      timing: { checkPollMs: 50, killGraceMs: 300, ciAbsentGraceMs: 0, workerTimeoutMs: 180_000 },
      // A lab run notifies nobody: no desktop notification, webhook or comment per scenario.
      notify: { env: { ...process.env, ORBIT_NOTIFICATIONS: 'off' } },
    };
  }

  /** Start a run for `goal` and drive it to a terminal state with the real controller loop, in this process. */
  async run(lab: Lab, goal: string, extra: Partial<ControllerDeps> = {}): Promise<RunRecord> {
    const db = lab.db();
    const registry = new ModelRegistry(db, systemClock);
    registry.seed();
    for (const e of registry.list()) if (e.provider === 'claude' && e.family !== 'fable') registry.markAvailability(e.modelId, 'claude-cli', true, 'validated by the bench lab');
    const run = startRun({ db, repoRoot: lab.repo, goal, config: lab.config, clock: systemClock });
    await new Controller({ mode: 'foreground', runId: run.id, deps: { ...this.deps(lab), ...extra }, tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
    return getRun(db, run.id);
  }
}

export function writeLabScenario(lab: Pick<Lab, 'scenarioPath'>, scenario: object): void {
  writeFileSync(lab.scenarioPath, JSON.stringify(scenario));
}
