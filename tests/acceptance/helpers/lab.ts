/**
 * The acceptance lab: a throwaway git repository made from examples/demo-app
 * (its own checks, its own .orbit/config.yaml), a bare remote, the fake
 * provider CLIs behind the real adapters and worker shim, FakeGitHub for
 * delivery, and a private ~/.orbit. Every scenario drives the real controller
 * (in process, or the CLI as a child process) against it.
 *
 * Dependencies are installed once per test file into a template copy
 * (`npm ci --offline` from the example's lockfile, else Orbit's own
 * node_modules, whose versions the example pins); each lab links them.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemClock } from '../../../src/core/clock.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { loadConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { createAdapter } from '../../../src/adapters/index.ts';
import type { ProviderAdapter } from '../../../src/adapters/types.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import { startRun, stateDbPath } from '../../../src/controller/start.ts';
import type { ControllerDeps } from '../../../src/controller/context.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { getRun, type RunRecord } from '../../../src/controller/run-store.ts';
import { FakeGitHub } from '../../../src/delivery/github.ts';

export const ORBIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DEMO_DIR = join(ORBIT_ROOT, 'examples', 'demo-app');
export const FAKE_CLAUDE = join(ORBIT_ROOT, 'tests', 'fakes', 'fake-claude.mjs');
export const FAKE_CODEX = join(ORBIT_ROOT, 'tests', 'fakes', 'fake-codex.mjs');
export const CLI_ENTRY = join(ORBIT_ROOT, 'src', 'cli', 'main.ts');

/** Node runs the TypeScript sources directly (type stripping), which the child controllers need. */
export const CAN_STRIP_TYPES = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
export const HAS_DEMO = existsSync(join(DEMO_DIR, 'package.json')) && existsSync(join(DEMO_DIR, '.orbit', 'config.yaml'));
export const READY = CAN_STRIP_TYPES && HAS_DEMO;

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const SKIP = new Set(['DEMO.md', 'node_modules', 'test-results', 'playwright-report', 'state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'runs', 'worktrees', 'fake-github.json']);

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } }).trim();
}

export function freePort(): string {
  const r = spawnSync(process.execPath, ['-e', "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })"], { encoding: 'utf8' });
  const port = r.stdout.trim();
  if (!/^\d+$/.test(port)) throw new Error(`no free port: ${r.stderr}`);
  return port;
}

/** Environment for a child that must not look like it runs under Orbit's UI runner. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('ORBIT_UI_')) delete env[k];
  return env;
}

let template: string | null = null;
const templateRoot = (): string => {
  if (template) return template;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-acc-template-')));
  const dir = join(root, 'demo-app');
  cpSync(DEMO_DIR, dir, { recursive: true, filter: (src) => !SKIP.has(src.split('/').at(-1) ?? '') });
  const flags = ['--ignore-scripts', '--no-audit', '--no-fund'];
  const ci = spawnSync('npm', ['ci', '--offline', ...flags], { cwd: dir, encoding: 'utf8', env: cleanEnv(), timeout: 300_000 });
  if (ci.status !== 0) symlinkSync(join(ORBIT_ROOT, 'node_modules'), join(dir, 'node_modules'));
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  template = dir;
  return dir;
};

/** True when Playwright's Chromium is installed for the example's Playwright. */
export function chromiumAvailable(): boolean {
  if (!READY) return false;
  const script = "const { chromium } = require('@playwright/test'); process.exit(require('fs').existsSync(chromium.executablePath()) ? 0 : 1)";
  return spawnSync(process.execPath, ['-e', script], { cwd: templateRoot(), env: cleanEnv() }).status === 0;
}

/** The copy of the demo every lab repository starts from, with this platform's baselines once ensureBaselines ran. */
export function labTemplateDir(): string {
  return templateRoot();
}

/** Baselines are per platform; where none were committed, record them in the template (a person would, not Orbit). */
export function ensureBaselines(): void {
  const dir = templateRoot();
  if (existsSync(join(dir, 'tests/e2e/__screenshots__/desktop', process.platform))) return;
  const r = spawnSync('npx', ['--no-install', 'playwright', 'test', 'visual', '-u', '--reporter=null'], { cwd: dir, encoding: 'utf8', timeout: 300_000, env: cleanEnv({ PORT: freePort() }) });
  if (r.status !== 0) throw new Error(`could not record visual baselines: ${(r.stdout + r.stderr).slice(-2000)}`);
}

export interface Lab {
  base: string;
  repo: string;
  remote: string;
  orbitHome: string;
  scenarioPath: string;
  argvLog: string;
  config: OrbitConfig;
  configPath: string;
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

/** The example's policy, made runnable here: no OS sandbox, the fake providers, FakeGitHub, linked dependencies. */
export function labConfig(repo: string, tweak?: (c: OrbitConfig) => void): OrbitConfig {
  const c = structuredClone(loadConfig(repo)) as OrbitConfig;
  c.isolation = { provider: 'none', allow_unisolated: true, container: null };
  c.providers = {
    claude: { command: FAKE_CLAUDE, data_policy_eligible: true, model: null, reasoning_effort: null, extra_args: [] },
    codex: { command: FAKE_CODEX, data_policy_eligible: true, model: 'gpt-6-astra', reasoning_effort: null, extra_args: [] },
  };
  c.delivery = { ...c.delivery, provider: 'fake' };
  c.dependencies = { ...c.dependencies, install_command: ['ln', '-sfn', join(repo, 'node_modules'), 'node_modules'] };
  c.knowledge = { ...c.knowledge, enabled: false };
  if (c.ui) c.ui.environment.base_url = `http://127.0.0.1:${freePort()}`;
  tweak?.(c);
  return c;
}

export function makeLab(opts: LabOptions = {}): Lab {
  const src = templateRoot();
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-acc-')));
  const repo = join(base, 'repo');
  cpSync(src, repo, { recursive: true, filter: (p) => p === src || !p.startsWith(join(src, 'node_modules')) });
  symlinkSync(realpathSync(join(src, 'node_modules')), join(repo, 'node_modules'));
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
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  const config = labConfig(repo, opts.tweak);
  const configPath = join(base, 'policy.json');
  writeFileSync(configPath, JSON.stringify(config));
  let db: OrbitDb | null = null;
  return {
    base,
    repo,
    remote,
    orbitHome: join(base, 'orbit-home'),
    scenarioPath: join(base, 'scenario.json'),
    argvLog: join(base, 'argv.jsonl'),
    config,
    configPath,
    db() {
      db ??= openDb(stateDbPath(repo));
      return db;
    },
    runDir: (runId) => join(repo, '.orbit', 'runs', runId),
    github: () => new FakeGitHub({ statePath: join(repo, '.orbit', 'fake-github.json'), remoteGitDir: remote }),
    close() {
      db?.close();
      db = null;
      // Review checkouts are read-only; one left by a killed controller must not fail the cleanup.
      spawnSync('chmod', ['-R', 'u+w', base]);
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export function writeScenario(lab: Pick<Lab, 'scenarioPath'>, scenario: object): void {
  writeFileSync(lab.scenarioPath, JSON.stringify(scenario));
}

/** What `orbit doctor` would have done: seed the registry and validate the Claude models on the CLI surface. */
export function seedRegistry(db: OrbitDb): void {
  const registry = new ModelRegistry(db, systemClock);
  registry.seed();
  for (const e of registry.list()) if (e.provider === 'claude' && e.family !== 'fable') registry.markAvailability(e.modelId, 'claude-cli', true, 'validated by the acceptance lab');
}

export function startLabRun(lab: Lab, goal: string): RunRecord {
  const db = lab.db();
  seedRegistry(db);
  return startRun({ db, repoRoot: lab.repo, goal, config: lab.config, clock: systemClock });
}

export function labAdapters(lab: Pick<Lab, 'config' | 'scenarioPath' | 'argvLog'>, env: Record<string, string> = {}): Record<string, ProviderAdapter> {
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: lab.scenarioPath, ORBIT_FAKE_ARGV_LOG: lab.argvLog, ...env };
  const out: Record<string, ProviderAdapter> = {};
  for (const [id, pc] of Object.entries(lab.config.providers)) out[id] = createAdapter(id, pc, { claudeTier: 'claude-sandbox', graceMs: 300, baseEnv, clock: systemClock });
  return out;
}

export function labDeps(lab: Lab, extra: Partial<ControllerDeps> = {}): Omit<ControllerDeps, 'ownerId'> {
  const db = lab.db();
  return {
    db,
    clock: systemClock,
    adapters: labAdapters(lab),
    registry: new ModelRegistry(db, systemClock),
    orbitHome: lab.orbitHome,
    hostEnv: process.env,
    orbitInstallDir: ORBIT_ROOT,
    // Deterministic across machines: the built-in secret patterns, not whatever gitleaks is installed.
    gitleaksPath: null,
    // ...and a fixed machine for scheduling (16 cores, 64 GB free), not whatever this host is doing (G54).
    schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 },
    timing: { checkPollMs: 50, killGraceMs: 300, ciAbsentGraceMs: 0, workerTimeoutMs: 180_000 },
    ...extra,
  };
}

/** Drive one run to a terminal state with the real controller loop, in this process. */
export async function drive(lab: Lab, runId: string, extra: Partial<ControllerDeps> = {}): Promise<RunRecord> {
  await new Controller({ mode: 'foreground', runId, deps: labDeps(lab, extra), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
  return getRun(lab.db(), runId);
}

export function runState(lab: Lab, runId: string): RunRecord {
  return getRun(lab.db(), runId);
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 60_000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null && v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ---------------------------------------------------------------------------
// The CLI as a child process

export interface CliChild extends ChildProcess {
  output(): string;
  exited(): Promise<number | null>;
}

/** The environment the fake providers and the CLI need, with a private HOME and ORBIT_HOME. */
export function cliEnv(lab: Lab, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...GIT_ENV, HOME: lab.base, ORBIT_HOME: lab.orbitHome, ORBIT_FAKE_SCENARIO: lab.scenarioPath, ORBIT_FAKE_ARGV_LOG: lab.argvLog, ...extra };
}

/** `orbit <args>` run from the lab repository by Node over the TypeScript sources. */
export function orbit(lab: Lab, args: string[], extra: Record<string, string> = {}): CliChild {
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', CLI_ENTRY, ...args], { cwd: lab.repo, env: cliEnv(lab, extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  const done = new Promise<number | null>((r) => child.once('close', (code) => r(code)));
  return Object.assign(child, { output: () => out, exited: () => done });
}

export async function orbitOnce(lab: Lab, args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  const c = orbit(lab, args, extra);
  const code = await c.exited();
  return { code, out: c.output() };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function argvCalls(lab: Lab): { tool: string; role: string; call: number }[] {
  if (!existsSync(lab.argvLog)) return [];
  return readFileSync(lab.argvLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { tool: string; role: string; call: number });
}

// ---------------------------------------------------------------------------
// A controller in its own process (helpers/controller-main.ts)

const CONTROLLER_MAIN = fileURLToPath(new URL('./controller-main.ts', import.meta.url));

export interface ControllerChild extends ChildProcess {
  output(): string;
  exited(): Promise<void>;
}

export function spawnController(lab: Lab, opts: { mode: 'service' | 'foreground'; runId?: string; leaseTtlMs?: number; env?: Record<string, string> }): ControllerChild {
  const args = { repo: lab.repo, orbitHome: lab.orbitHome, configPath: lab.configPath, scenarioPath: lab.scenarioPath, argvLog: lab.argvLog, mode: opts.mode, runId: opts.runId, leaseTtlMs: opts.leaseTtlMs };
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', CONTROLLER_MAIN, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env ?? {}) } });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  const done = new Promise<void>((r) => child.once('exit', () => r()));
  return Object.assign(child, { output: () => out, exited: () => done });
}
