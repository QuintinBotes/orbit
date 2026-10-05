/**
 * Shared set-up for the controller coverage tests: a real run (frozen policy
 * in a temp repository, in-memory database, manual clock) with a loaded
 * RunContext, no processes and no git. Providers are stub adapters.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManualClock } from '../../../src/core/clock.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import type { ProviderAdapter } from '../../../src/adapters/types.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import { loadRunContext, type ControllerDeps, type RunContext } from '../../../src/controller/context.ts';
import { acquireLease, getRun, transition } from '../../../src/controller/run-store.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { startRun } from '../../../src/controller/start.ts';
import type { RunState } from '../../../src/controller/states.ts';
import type { CapturedLog } from './coverage-log.ts';

export const ORBIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const OWNER = 'ctl-unit';

export interface UnitLab {
  base: string;
  repo: string;
  home: string;
  db: OrbitDb;
  clock: ManualClock;
  deps: ControllerDeps;
  config: OrbitConfig;
  runId: string;
  /** A fresh context for the run as it is now. */
  ctx(signal?: AbortSignal): RunContext;
  /** Walk the run through `path` (the owner holds the lease). */
  walk(path: RunState[]): void;
  cleanup(): void;
}

export interface UnitLabOptions {
  tweak?: (config: OrbitConfig) => void;
  adapters?: Record<string, ProviderAdapter>;
  deps?: Partial<ControllerDeps>;
  path?: RunState[];
  logger?: ControllerDeps['logger'];
}

export function unitConfig(tweak?: (c: OrbitConfig) => void): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.isolation = { provider: 'none', allow_unisolated: true, container: null };
  c.scope.allowed_paths = ['apps/**', 'tests/**'];
  c.checks = { unit: { ...defaultCheck('unit'), command: [process.execPath, '-e', '0'], timeout_seconds: 60 } };
  c.knowledge = { ...c.knowledge, enabled: false };
  tweak?.(c);
  return c;
}

export function makeUnitLab(opts: UnitLabOptions = {}): UnitLab {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-uc-')));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(repo, { recursive: true });
  const db = openDb(':memory:');
  const clock = new ManualClock();
  const config = unitConfig(opts.tweak);
  const run = startRun({ db, repoRoot: repo, goal: 'Add a mul function.', config, clock, runId: 'orb-unit' });
  acquireLease(db, run.id, OWNER, 3_600_000, clock);
  const deps: ControllerDeps = {
    db,
    clock,
    ownerId: OWNER,
    adapters: opts.adapters ?? {},
    registry: new ModelRegistry(db, clock),
    orbitHome: home,
    homeDir: join(base, 'userhome'),
    hostEnv: { PATH: process.env.PATH },
    orbitInstallDir: ORBIT_ROOT,
    timing: { checkPollMs: 20, killGraceMs: 50, ciAbsentGraceMs: 0, workerTimeoutMs: 120_000 },
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.deps ?? {}),
  };
  const lab: UnitLab = {
    base,
    repo,
    home,
    db,
    clock,
    deps,
    config,
    runId: run.id,
    ctx: (signal = new AbortController().signal) => loadRunContext(deps, run.id, signal),
    walk(path) {
      for (const to of path) transition(db, { runId: run.id, to, ownerId: OWNER, reason: 'test' }, clock);
    },
    cleanup() {
      try {
        db.close();
      } catch {
        /* closed */
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
  if (opts.path) lab.walk(opts.path);
  return lab;
}

export type { CapturedLog };

import { BudgetLedger } from '../../../src/scheduling/budget.ts';

/** Initialise the run's budget counters, as PLANNING does; later contexts attach to them. */
export function initLedger(lab: Pick<UnitLab, 'db' | 'clock' | 'runId' | 'ctx'>): BudgetLedger {
  return new BudgetLedger(lab.db, lab.clock).init(lab.runId, lab.ctx().snapshot, 'medium');
}

import { aggregateCheckConfigHash } from '../../../src/evidence/report.ts';
import { finalizeCandidate, insertEvidenceReport, reserveCandidate, type CandidateRecord, type EvidenceReportRecord } from '../../../src/evidence/store.ts';
import type { EvidenceReport, ScopeReport } from '../../../src/evidence/types.ts';
import { recordReview } from '../../../src/review/store.ts';
import type { IngestedFinding, ReviewRecord } from '../../../src/review/types.ts';

export const BASE_REV = 'a'.repeat(40);

export function cleanScope(over: Partial<ScopeReport> = {}): ScopeReport {
  return {
    allowed_paths_pass: true,
    forbidden_paths_changed: [],
    out_of_scope_paths_changed: [],
    changed_files: 2,
    changed_lines: 10,
    within_size_limits: true,
    lockfile_changed: false,
    dependency_manifest_changed: [],
    symlinks_escaping: [],
    weakening_signals: [],
    visual_baseline_changes: [],
    ...over,
  };
}

/** A READY candidate for the run (the commit and tree are labels; nothing is read from git). */
export function addCandidate(lab: Pick<UnitLab, 'db' | 'clock' | 'runId'>, over: { tree?: string; commit?: string; attempt?: number } = {}): CandidateRecord {
  const c = reserveCandidate(lab.db, { runId: lab.runId, attempt: over.attempt ?? 1, workerId: null, treeHash: over.tree ?? 't'.repeat(40), parentSha: BASE_REV }, lab.clock);
  return finalizeCandidate(lab.db, c.id, over.commit ?? 'c'.repeat(40), { files: 2, insertions: 10, deletions: 0, binaryFiles: 0, paths: [], truncated: false }, lab.clock);
}

/** An evidence report for the candidate, bound to the run's policy and the checks named. */
export function addEvidence(lab: Pick<UnitLab, 'db' | 'clock' | 'runId'>, cand: CandidateRecord, over: Partial<EvidenceReport> = {}): EvidenceReportRecord {
  const run = getRun(lab.db, lab.runId);
  const snapshot = verifySnapshot(run.policyPath, run.policyHash);
  const checks = over.checks ?? [{ id: 'unit', status: 'PASSED' as const, exit_code: 0, flaky: false, log: 'evidence/1/unit.log' }];
  const report: EvidenceReport = {
    task_id: lab.runId,
    run_id: lab.runId,
    attempt: cand.attempt,
    candidate_revision: cand.commitSha,
    tree_hash: cand.treeHash,
    check_config_hash: aggregateCheckConfigHash(snapshot, checks.map((c) => c.id)),
    policy_hash: run.policyHash,
    scope: cleanScope(),
    checks,
    ui: [],
    acceptance_evidence: [],
    verdict: 'PASS',
    unverified: [],
    ...over,
  };
  return insertEvidenceReport(lab.db, { candidateId: cand.id, report, reportPath: null }, lab.clock);
}

export function addReview(lab: Pick<UnitLab, 'db' | 'clock' | 'runId'>, cand: CandidateRecord, over: { verdict?: 'APPROVE' | 'REPAIR_REQUIRED' | 'BLOCK'; provider?: string; findings?: IngestedFinding[]; id?: string; round?: number } = {}): ReviewRecord {
  return recordReview(
    lab.db,
    { ...(over.id ? { id: over.id } : {}), runId: lab.runId, candidateId: cand.id, treeHash: cand.treeHash, round: over.round ?? 1, provider: over.provider ?? 'codex', model: null, workerId: null, verdict: over.verdict ?? 'APPROVE', packetSha256: null, findings: over.findings ?? [] },
    lab.clock,
  );
}

import type { GoalContract } from '../../../src/contract/types.ts';

/** A contract that validates against the lab's frozen policy (one mandatory criterion measured by the `unit` check). */
export function validContract(lab: Pick<UnitLab, 'db' | 'runId'>, over: Partial<GoalContract> = {}): GoalContract {
  const run = getRun(lab.db, lab.runId);
  return {
    version: '1.0',
    task_id: lab.runId,
    original_goal: run.goal,
    objective: 'Add a mul function to the calculator.',
    acceptance_criteria: [{ id: 'AC-1', statement: 'mul(a, b) returns the product', proof: ['tests/mul.test.mjs asserts mul(2, 3) === 6'], mandatory: true, check_ids: ['unit'] }],
    non_goals: [],
    allowed_paths: ['apps/**', 'tests/**'],
    required_check_ids: ['unit'],
    assumptions: [],
    delivery: { draft_pr: false, merge: false },
    policy_hash: run.policyHash,
    baseline_revision: BASE_REV,
    escalation: { material_topics: [] },
    ...over,
  };
}

/** Store a valid contract on the run, as CONTRACTING does, so later contexts load it. */
export function setContract(lab: Pick<UnitLab, 'db' | 'runId'>, over: Partial<GoalContract> = {}): GoalContract {
  const c = validContract(lab, over);
  lab.db.run('UPDATE runs SET contract_json = ?, base_revision = ? WHERE id = ?', JSON.stringify(c), c.baseline_revision, lab.runId);
  return c;
}

// ---------------------------------------------------------------------------
// A real repository and a scripted provider for the step tests

import { execFileSync } from 'node:child_process';
import { writeFileSync as writeFileSyncFs } from 'node:fs';
import type { TaskHandle, TaskResult, TaskSpec } from '../../../src/adapters/types.ts';
import { materializeCandidate } from '../../../src/evidence/candidate.ts';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
export const gitIn = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Make the lab's repository a real one at a base commit, with the run's implementer worktree beside it. */
export async function giveRepository(lab: Pick<UnitLab, 'db' | 'repo' | 'home' | 'runId'>, files: Record<string, string> = { 'apps/calc.mjs': 'export const add = (a, b) => a + b;\n', 'tests/add.test.mjs': 'export {};\n' }): Promise<{ base: string; tree: string; worktree: string }> {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(lab.repo, rel, '..'), { recursive: true });
    writeFileSyncFs(join(lab.repo, rel), text);
  }
  writeFileSyncFs(join(lab.repo, '.gitignore'), '.orbit/\n');
  gitIn(lab.repo, 'init', '-q', '-b', 'main');
  gitIn(lab.repo, 'add', '-A');
  gitIn(lab.repo, 'commit', '-q', '-m', 'base');
  const base = gitIn(lab.repo, 'rev-parse', 'HEAD');
  const tree = gitIn(lab.repo, 'rev-parse', 'HEAD^{tree}');
  const worktree = join(lab.home, 'worktrees', 'implementer');
  await materializeCandidate(lab.repo, base, worktree, { readOnly: false });
  lab.db.run('UPDATE runs SET base_revision = ?, base_tree = ?, worktree_path = ?, branch = ? WHERE id = ?', base, tree, worktree, `orbit/${lab.runId}`, lab.runId);
  return { base, tree, worktree };
}

export interface ScriptedAdapter extends ProviderAdapter {
  specs: TaskSpec[];
  collects: number;
}

export type Scripted = (info: { purpose: string; workerId: string; role: string; n: number; spec: TaskSpec }) => TaskResult | null;

/**
 * A provider that records every task it starts (writing the shim's pid file) and answers each worker from `script`:
 * null means "still running". `onStart` lets a test edit the worktree the way a session would.
 */
export function scriptedAdapter(lab: Pick<UnitLab, 'db'>, script: Scripted, onStart?: (spec: TaskSpec) => void): ScriptedAdapter {
  const asked = new Map<string, number>();
  const specs = new Map<string, TaskSpec>();
  const a = {
    id: 'claude',
    specs: [] as TaskSpec[],
    collects: 0,
    async startTask(spec: TaskSpec): Promise<TaskHandle> {
      a.specs.push(spec);
      specs.set(spec.workerId, spec);
      mkdirSync(spec.workerDir, { recursive: true });
      writeFileSyncFs(join(spec.workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: 2_000_000_000, shimStart: 'x', pgid: 2_000_000_000, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
      onStart?.(spec);
      return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x', logPath: '', exitPath: '' };
    },
    async collectResult(h: TaskHandle): Promise<TaskResult | null> {
      a.collects++;
      const row = lab.db.get<{ purpose: string; role: string }>('SELECT purpose, role FROM workers WHERE id = ?', h.workerId);
      const key = `${h.workerId}`;
      const n = (asked.get(key) ?? 0) + 1;
      asked.set(key, n);
      return script({ purpose: row?.purpose ?? '', workerId: h.workerId, role: row?.role ?? '', n, spec: specs.get(h.workerId)! });
    },
    async cancelTask(): Promise<void> {},
    async discoverCapabilities() {
      return { provider: 'claude', available: true, version: '1', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'full', costReporting: true, detail: '' };
    },
    async validateCredentials() {
      return { state: 'valid', method: 'api_key', detail: 'ok' };
    },
  };
  return a as unknown as ScriptedAdapter;
}

export const okResult = (structured: unknown, over: Partial<TaskResult> = {}): TaskResult => ({
  status: 'succeeded',
  structured,
  text: null,
  error: null,
  exitCode: 0,
  usage: { provider: 'claude', model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.05, costSource: 'reported' },
  durationMs: 1,
  ...over,
});

/** Validate every claude model on the CLI surface so routing finds one. */
export function validateModels(lab: Pick<UnitLab, 'deps'>): void {
  lab.deps.registry.seed();
  for (const e of lab.deps.registry.list()) if (e.provider === 'claude') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
}
