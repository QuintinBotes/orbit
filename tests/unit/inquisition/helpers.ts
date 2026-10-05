import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import type { InquisitorOutput, InquisitorQuestion } from '../../../src/contract/model-outputs.ts';
import type { PolicySnapshot, RunMode } from '../../../src/policy/types.ts';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec, UsageReport } from '../../../src/adapters/types.ts';
import type { InquisitionContext } from '../../../src/inquisition/engine.ts';
import { loadInquisitionSnapshot, type SnapshotExtras } from '../../../src/inquisition/triggers.ts';
import { contract as baseContract, snapshot as baseSnapshot } from '../contract/fixtures.ts';

export const RUN = 'run-1';

export interface Env {
  db: OrbitDb;
  clock: ManualClock;
  dir: string;
  runDir: string;
  snap: PolicySnapshot;
  contract: GoalContract;
  cleanup(): void;
  /** Persist the contract on the run row the way the controller would, then build an engine context. */
  ctx(extras?: SnapshotExtras, patch?: Partial<InquisitionContext>): InquisitionContext;
}

export function setup(opts: { mode?: RunMode; contract?: (c: GoalContract) => GoalContract } = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-inq-'));
  const db = openDb(join(dir, 'state.sqlite'));
  const clock = new ManualClock();
  const snap = baseSnapshot();
  snap.config.mode = opts.mode ?? 'autonomous';
  let contract = baseContract(snap);
  if (opts.contract) contract = opts.contract(contract);
  createRun(db, { id: RUN, repoRoot: '/repo/acme', goal: 'Add CSV export', mode: snap.config.mode, policyHash: 'sha256:x', policyPath: join(dir, 'policy.json') }, clock);
  db.run('UPDATE runs SET contract_json = ? WHERE id = ?', JSON.stringify(contract), RUN);
  const runDir = join(dir, 'run');
  const env: Env = {
    db,
    clock,
    dir,
    runDir,
    snap,
    contract,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
    ctx(extras = {}, patch = {}) {
      return {
        db,
        clock,
        runId: RUN,
        runDir,
        snapshot: snap,
        contract,
        inquiry: loadInquisitionSnapshot(db, RUN, extras),
        ...patch,
      };
    },
  };
  return env;
}

let seq = 0;

export function addFailure(db: OrbitDb, fingerprint: string, candidateId: string | null, excerpt = 'AssertionError: expected 3 to equal 5', source = 'check'): void {
  db.run('INSERT INTO failures (run_id, candidate_id, source, source_id, fingerprint, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', RUN, candidateId, source, null, fingerprint, excerpt, 1_700_000_000_000 + seq++);
}

export function addCheckRun(db: OrbitDb, id: string, checkId: string, status = 'PASSED'): void {
  db.run(
    `INSERT INTO check_runs (id, run_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, started_at)
     VALUES (?, ?, ?, 'command', 'tree-1', 'cfg', 'pol', '[]', '.', 'none', ?, 1)`,
    id,
    RUN,
    checkId,
    status,
  );
}

export interface ReportShape {
  verdict?: 'PASS' | 'FAIL' | 'INCOMPLETE';
  tree?: string;
  checks?: { id: string; status: string; flaky?: boolean }[];
  acceptance?: { criterion_id: string; status: string; artifacts?: string[] }[];
  weakening?: { path: string; signal: string; detail: string }[];
  visual?: string[];
}

export function addEvidence(db: OrbitDb, r: ReportShape = {}, id = `ev-${seq++}`): void {
  const verdict = r.verdict ?? 'INCOMPLETE';
  const report = {
    verdict,
    checks: (r.checks ?? []).map((c) => ({ id: c.id, status: c.status, exit_code: c.status === 'PASSED' ? 0 : 1, flaky: c.flaky ?? false, log: `${c.id}.log` })),
    acceptance_evidence: (r.acceptance ?? []).map((a) => ({ criterion_id: a.criterion_id, status: a.status, artifacts: a.artifacts ?? [] })),
    scope: { weakening_signals: r.weakening ?? [], visual_baseline_changes: r.visual ?? [] },
    unverified: [],
  };
  db.run(
    'INSERT INTO evidence_reports (id, run_id, candidate_id, tree_hash, check_config_hash, policy_hash, verdict, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    RUN,
    'cand-1',
    r.tree ?? 'tree-1',
    'cfg',
    'pol',
    verdict,
    JSON.stringify(report),
    1_700_000_000_000 + seq++,
  );
}

export function addReview(db: OrbitDb, provider: string, verdict: string, tree = 'tree-1', round = 1): void {
  db.run('INSERT INTO reviews (id, run_id, candidate_id, tree_hash, round, provider, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', `rev-${seq++}`, RUN, 'cand-1', tree, round, provider, verdict, 1_700_000_000_000 + seq);
}

export function addDecision(db: OrbitDb, kind: string, summary: string, data: unknown = {}): void {
  db.run('INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', `dec-t-${seq++}`, RUN, kind, summary, JSON.stringify(data), 1_700_000_000_000 + seq);
}

/** A question that passes every quality rule; override fields to break one. */
export function goodQuestion(over: Partial<InquisitorQuestion> = {}): InquisitorQuestion {
  return {
    question: 'Should the export include every matching record or only the current page?',
    changes: ['implementation', 'proof'],
    evidence: ['Filtering occurs before pagination in the report query; no export convention exists in the repository.'],
    options: [
      { label: 'All matching records', description: 'Query every page server side.', consequences: 'Requires separate querying and large-result handling.' },
      { label: 'Current page', description: 'Serialize only the rows on screen.', consequences: 'Simpler but potentially surprising to users.' },
    ],
    recommendation: 'All matching records',
    recommendation_reason: 'The criterion says every matching record, including those beyond the page.',
    safe_default: { exists: false, option: null, reason: 'Product behavior differs between the options, so no default is safe.' },
    material: true,
    affected_work: ['AC-1'],
    unblocked_work: ['AC-2', 'AC-3'],
    ...over,
  };
}

/** The same question with the single-letter labels the inquisitor schema requires (spec example: A and B). */
export function workerQuestion(over: Partial<InquisitorQuestion> = {}): InquisitorQuestion {
  const q = goodQuestion();
  return { ...q, options: q.options.map((o, i) => ({ ...o, label: String.fromCharCode(65 + i) })), recommendation: 'A', ...over };
}

export function inquisitorOutput(over: Partial<InquisitorOutput> = {}): InquisitorOutput {
  return {
    mode: 'clarify',
    trigger: 'missing outcomes',
    facts: [{ statement: 'Filtering occurs before pagination.', source: 'apps/api/reports.ts:40' }],
    assumptions: [],
    unknowns: [],
    ledger: [],
    interpretations: [],
    chosen_experiment: null,
    autonomous_decisions: [],
    questions: [],
    amendments: [],
    ...over,
  };
}

const USAGE: UsageReport = { provider: 'fake', model: 'fake-model', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, costSource: 'reported' };

export type Script = Partial<TaskResult> & { pendingPolls?: number };

/** Scripted adapter: each startTask consumes the next script entry. */
export class ScriptedAdapter implements ProviderAdapter {
  readonly id = 'fake';
  specs: TaskSpec[] = [];
  cancelled: string[] = [];
  private polls = new Map<string, number>();
  private scripts: Script[];
  private idx = 0;
  private bySpec = new Map<string, Script>();
  constructor(scripts: Script[]) {
    this.scripts = scripts;
  }
  async discoverCapabilities() {
    return { provider: 'fake', available: true, version: '1', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'exact' as const, costReporting: true, detail: '' };
  }
  async validateCredentials() {
    return { state: 'valid' as const, method: null, detail: '' };
  }
  async startTask(spec: TaskSpec): Promise<TaskHandle> {
    this.specs.push(spec);
    this.bySpec.set(spec.workerId, this.scripts[Math.min(this.idx++, this.scripts.length - 1)] ?? { status: 'failed' });
    return { provider: 'fake', workerId: spec.workerId, workerDir: spec.workerDir, pid: 4242, pgid: 4242, procStart: null, logPath: join(spec.workerDir, 'log.jsonl'), exitPath: join(spec.workerDir, 'exit.json') };
  }
  async streamEvents() {
    return { events: [], nextOffset: 0 };
  }
  async cancelTask(h: TaskHandle) {
    this.cancelled.push(h.workerId);
  }
  async collectResult(h: TaskHandle): Promise<TaskResult | null> {
    const s = this.bySpec.get(h.workerId)!;
    const n = this.polls.get(h.workerId) ?? 0;
    this.polls.set(h.workerId, n + 1);
    if (n < (s.pendingPolls ?? 0)) return null;
    return { status: 'succeeded', structured: null, text: null, error: null, exitCode: 0, usage: USAGE, durationMs: 10, ...s };
  }
  async reportUsage() {
    return USAGE;
  }
}
