/**
 * Helpers shared by the mock demo and its integration test: make a throwaway
 * copy of examples/demo-app, give it dependencies and visual baselines for this
 * platform, and turn it into a git repository. Nothing here touches the
 * example in place.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORBIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const EXAMPLE_DIR = join(ORBIT_ROOT, 'examples', 'demo-app');
export const GOALS_DIR = join(EXAMPLE_DIR, 'goals');

// DEMO.md is for maintainers and stays out of the repository the workers see.
const SKIP = new Set(['DEMO.md', 'node_modules', 'test-results', 'playwright-report', 'state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'runs', 'worktrees', 'fake-github.json']);

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** A TCP port nobody is listening on, so parallel demo runs and tests never share the app's port. */
export function freePortSync(): string {
  const r = spawnSync(process.execPath, ['-e', "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })"], { encoding: 'utf8' });
  const port = r.stdout.trim();
  if (!/^\d+$/.test(port)) throw new Error(`could not find a free port: ${r.stderr}`);
  return port;
}

/** Environment for a child that must not look like it runs under Orbit's UI runner. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('ORBIT_UI_')) delete env[k];
  return env;
}

export function run(cwd: string, cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: opts.env ?? cleanEnv(), timeout: opts.timeoutMs ?? 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Copy the example without installed dependencies, test output or Orbit run state. */
export function copyExample(dest: string): void {
  cpSync(EXAMPLE_DIR, dest, { recursive: true, filter: (src) => !SKIP.has(src.split('/').at(-1) ?? '') });
}

export type InstallMethod = 'npm-ci-offline' | 'npm-ci' | 'linked';

/**
 * Install from the example's lockfile. Offline first (a warm npm cache is enough), then,
 * only when `allowNetwork` is set, with the registry, and as a last resort link Orbit's own
 * node_modules, whose versions the example pins.
 */
export function installDependencies(dir: string, opts: { allowNetwork?: boolean } = {}): InstallMethod {
  const flags = ['--ignore-scripts', '--no-audit', '--no-fund'];
  if (run(dir, 'npm', ['ci', '--offline', ...flags]).ok) return 'npm-ci-offline';
  if (opts.allowNetwork && run(dir, 'npm', ['ci', ...flags]).ok) return 'npm-ci';
  symlinkSync(join(ORBIT_ROOT, 'node_modules'), join(dir, 'node_modules'));
  return 'linked';
}

/** True when this machine has the Chromium that the installed Playwright drives. */
export function chromiumAvailable(dir: string): boolean {
  const script = "const { chromium } = require('@playwright/test'); process.exit(require('fs').existsSync(chromium.executablePath()) ? 0 : 1)";
  return run(dir, process.execPath, ['-e', script]).ok;
}

/** Baselines are recorded per platform. Elsewhere, a person records them first: this is that person, not Orbit. */
export function ensureBaselines(dir: string): boolean {
  if (existsSync(join(dir, 'tests/e2e/__screenshots__/desktop', process.platform))) return false;
  const r = run(dir, 'npx', ['--no-install', 'playwright', 'test', 'visual', '-u', '--reporter=null'], { timeoutMs: 300_000, env: cleanEnv({ PORT: freePortSync() }) });
  if (!r.ok) throw new Error(`could not record visual baselines: ${r.out.slice(-2000)}`);
  return true;
}

/** A repository with the example committed on main. */
export function initRepo(dir: string): string {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Acme Controller');
  git(dir, 'config', 'user.email', 'controller@acme.test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Demo app');
  return git(dir, 'rev-parse', 'HEAD');
}

/** The example's own checks, as a person would run them after `npm ci`. */
export function runExampleChecks(dir: string, which: ('lint' | 'unit' | 'ui')[] = ['lint', 'unit', 'ui']): { id: string; ok: boolean; out: string }[] {
  const commands: Record<string, string[]> = { lint: ['run', '--silent', 'lint'], unit: ['test', '--silent'], ui: ['run', 'test:ui'] };
  return which.map((id) => ({ id, ...run(dir, 'npm', commands[id]!, { timeoutMs: 600_000, env: cleanEnv({ PORT: freePortSync() }) }) }));
}
