import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManualClock } from '../../../src/core/clock.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { TaskSpec } from '../../../src/adapters/types.ts';
import type { IsolationProvider } from '../../../src/isolation/types.ts';

export const FAKES = fileURLToPath(new URL('../../fakes/', import.meta.url));
export const FAKE_CLAUDE = join(FAKES, 'fake-claude.mjs');
export const FAKE_CODEX = join(FAKES, 'fake-codex.mjs');

export interface Fixture {
  base: string;
  repo: string;
  workerDir: string;
  policyPath: string;
  policyHash: string;
  scenarioPath: string;
  argvLog: string;
}

/** A real git repository with one commit, a frozen policy snapshot, and an empty worker directory. */
export function makeFixture(configYaml = 'version: 1\nmode: supervised\nscope: {allowed_paths: ["apps/**", "tests/**"]}\n'): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-adp-')));
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'apps'), { recursive: true });
  writeFileSync(join(repo, 'apps', 'a.ts'), 'export const a = 1;\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test' } });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const snap = snapshotPolicy(parseConfig(configYaml), { runId: 'orb-adp', repoRoot: repo, runDir: join(base, 'run'), clock: new ManualClock() });
  const workerDir = join(base, 'run', 'workers', 'w1');
  mkdirSync(workerDir, { recursive: true, mode: 0o700 });
  return { base, repo, workerDir, policyPath: snap.path, policyHash: snap.hash, scenarioPath: join(base, 'scenario.json'), argvLog: join(base, 'argv.jsonl') };
}

export function writeScenario(f: Fixture, scenario: object): void {
  writeFileSync(f.scenarioPath, JSON.stringify(scenario));
}

export const IMPLEMENTER_OUTPUT = {
  summary: 'changed a',
  changed_paths: [{ path: 'apps/a.ts', change: 'modify', purpose: 'update' }],
  tests_added: [],
  checks_run: [],
  evidence_refs: [],
  remaining_issues: [],
  next_action: { kind: 'request-verification', detail: 'run checks' },
};

export const REVIEW_OUTPUT = { verdict: 'APPROVE', candidate_revision: 'abc1234', findings: [] };

export function implementerSpec(f: Fixture, over: Partial<TaskSpec> = {}): TaskSpec & { policyHash: string } {
  return {
    runId: 'orb-adp',
    workerId: 'w1',
    role: 'implementer',
    model: 'sonnet',
    effort: 'medium',
    cwd: f.repo,
    workerDir: f.workerDir,
    prompt: 'Change apps/a.ts.',
    systemPrompt: 'You are the implementer.',
    outputSchema: MODEL_OUTPUT_SCHEMAS.implementer,
    readOnly: false,
    maxTurns: 10,
    timeoutMs: 60_000,
    sandbox: { writablePaths: [f.repo, f.workerDir], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 60_000, memoryMb: null, cpus: null, pids: null } },
    policyPath: f.policyPath,
    policyHash: f.policyHash,
    env: { ORBIT_FAKE_SCENARIO: f.scenarioPath, ORBIT_FAKE_ARGV_LOG: f.argvLog },
    ...over,
  };
}

export async function waitFor<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 20_000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Test harness only: the given provider (srt) with listening and loopback connects opened for the whole wrapped process,
 * so the REAL claude CLI inside it (the os-sandbox tier) reaches the fake API on this machine's loopback. A Claude worker
 * never gets that permission (issue #31): the adapter hands the provider allowLocalBinding false whatever profile it was
 * given, and this puts it back, for the fake API's sake, in tests whose subject is something else.
 */
export function withHarnessLoopback(isolation: IsolationProvider): IsolationProvider {
  return {
    kind: isolation.kind,
    ...(isolation.privateLoopback === undefined ? {} : { privateLoopback: isolation.privateLoopback }),
    available: () => isolation.available(),
    wrap: (argv, profile, opts) => isolation.wrap(argv, { ...profile, allowLocalBinding: true }, opts),
  };
}
