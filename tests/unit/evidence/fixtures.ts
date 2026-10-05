import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRun } from '../../../src/controller/run-store.ts';
import type { Clock } from '../../../src/core/clock.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { defaultConfig, defaultCheck } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { CheckDefinition, OrbitConfig, PolicySnapshot } from '../../../src/policy/types.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';

/** A real (symlink-resolved) temp directory and a function that removes it, read-only checkouts included. */
export function tempRoot(prefix = 'orbit-evidence-'): { root: string; remove: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return {
    root,
    remove: () => {
      makeWritableTree(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeWritableTree(dir: string): void {
  try {
    chmodSync(dir, 0o755);
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) makeWritableTree(p);
      else chmodSync(p, st.mode | 0o200);
    }
  } catch {
    /* removed already or a dangling link */
  }
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function write(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

export interface TestRepo {
  repo: string;
  base: string;
  baseTree: string;
}

/** A repository with one commit holding `files`. */
export function makeRepo(root: string, files: Record<string, string> = { 'README.md': 'acme\n', 'src/a.txt': 'one\n' }, name = 'repo'): TestRepo {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  for (const [p, c] of Object.entries(files)) write(join(repo, p), c);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'init');
  return { repo, base: sh(repo, 'rev-parse', 'HEAD').trim(), baseTree: sh(repo, 'rev-parse', 'HEAD^{tree}').trim() };
}

export function addWorktree(repo: string, dir: string, branch = 'orbit-w1'): string {
  mkdirSync(dirname(dir), { recursive: true });
  sh(repo, 'worktree', 'add', '-q', '-b', branch, dir);
  return realpathSync(dir);
}

export function checkDef(id: string, over: Partial<CheckDefinition> = {}): CheckDefinition {
  return { ...defaultCheck(id), command: ['node', '-e', 'process.exit(0)'], timeout_seconds: 30, ...over };
}

/** `node -e <script>` as a check command. */
export function nodeCheck(id: string, script: string, over: Partial<CheckDefinition> = {}): CheckDefinition {
  return checkDef(id, { command: ['node', '-e', script], ...over });
}

export interface TestRun {
  db: OrbitDb;
  runId: string;
  runDir: string;
  snapshot: PolicySnapshot;
  policyHash: string;
  clock: Clock;
}

/** A run row, a frozen policy snapshot holding `checks`, and a real SQLite file (or memory). */
export function makeRun(root: string, repo: string, checks: CheckDefinition[], opts: { runId?: string; clock?: Clock; configure?: (c: OrbitConfig) => void; memory?: boolean } = {}): TestRun {
  const runId = opts.runId ?? 'orb-test-1';
  const clock = opts.clock ?? systemClock;
  const runDir = join(root, '.orbit', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const config = defaultConfig('autonomous');
  config.isolation = { provider: 'none', allow_unisolated: true, container: null };
  config.checks = Object.fromEntries(checks.map((c) => [c.id, c]));
  opts.configure?.(config);
  const { snapshot, hash, path } = snapshotPolicy(config, { runId, repoRoot: repo, runDir, clock });
  const db = openDb(opts.memory ? ':memory:' : join(root, 'state.sqlite'));
  createRun(db, { id: runId, repoRoot: repo, goal: 'acme goal', mode: 'autonomous', policyHash: hash, policyPath: path }, clock);
  return { db, runId, runDir, snapshot, policyHash: hash, clock };
}
