/**
 * A fixture run for the timeline tests: one run that goes through a clarifying question, a failed first attempt, an
 * escalated second attempt that passes verification, a review by another provider and a delivery, with every record
 * written through the real store modules under a manual clock, so the times are exact and the order is the one a
 * controller would have produced.
 */
import { dirname } from 'node:path';
import { ManualClock } from '../../../src/core/clock.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import { startRun } from '../../../src/controller/start.ts';
import { acquireLease, releaseLease, transition } from '../../../src/controller/run-store.ts';
import type { RunState } from '../../../src/controller/states.ts';
import { finalizeCandidate, finishCheckRun, insertEvidenceReport, markCheckRunning, planCheckRun, reserveCandidate, type CandidateRecord } from '../../../src/evidence/store.ts';
import type { EvidenceReport } from '../../../src/evidence/types.ts';
import { insertQuestion, setQuestionAnswer } from '../../../src/inquisition/store.ts';
import { recordReview } from '../../../src/review/store.ts';
import { recordUsage } from '../../../src/routing/usage.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { recordDecision } from '../../../src/storage/decisions.ts';
import { finishWorker, markWorkerRunning, planWorker } from '../../../src/storage/workers.ts';
import type { OrbitDb } from '../../../src/storage/db.ts';
import type { Lab } from './lab.ts';

export const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
export const RUN_ID = 'orb-timeline-1';
const OWNER = 'ctl-fixture';

export interface Fixture {
  db: OrbitDb;
  clock: ManualClock;
  runId: string;
  runDir: string;
  /** Move the manual clock forward, then run `fn` (everything it writes carries the new time). */
  at<T>(secondsAfterStart: number, fn: () => T): T;
  to(state: RunState, reason: string, patch?: { outcomeReason?: string }): void;
  event(type: string, data: unknown, secondsAfterStart: number): void;
  finishSucceeded(): void;
}

export function startFixture(lab: Lab, goal = 'Add a mul function to the calculator.'): Fixture {
  const clock = new ManualClock(T0);
  const db = lab.db();
  const run = startRun({ db, repoRoot: lab.repo, goal, config: defaultConfig('autonomous-delivery'), clock, runId: RUN_ID });
  const runDir = dirname(run.policyPath);
  acquireLease(db, run.id, OWNER, 24 * 3_600_000, clock);
  const fx: Fixture = {
    db,
    clock,
    runId: run.id,
    runDir,
    at(seconds, fn) {
      const target = T0 + seconds * 1000;
      if (target > clock.now()) clock.advance(target - clock.now());
      return fn();
    },
    to(state, reason, patch) {
      transition(db, { runId: run.id, to: state, ownerId: OWNER, reason, actor: OWNER, ...(patch ? { patch } : {}) }, clock);
    },
    event(type, data, seconds) {
      fx.at(seconds, () => db.tx(() => appendEvent(db, run.id, type, 'controller', data, clock.now())));
    },
    finishSucceeded() {
      releaseLease(db, run.id, OWNER);
    },
  };
  return fx;
}

function report(runId: string, attempt: number, tree: string, verdict: 'PASS' | 'FAIL', failing: string[]): EvidenceReport {
  return {
    task_id: runId,
    run_id: runId,
    attempt,
    candidate_revision: `rev-${attempt}`,
    tree_hash: tree,
    check_config_hash: 'cfg',
    policy_hash: 'pol',
    scope: { files: [], violations: [], lockfile_changed: false, dependency_manifest_changed: [], symlinks_escaping: [], weakening_signals: [], visual_baseline_changes: [] } as unknown as EvidenceReport['scope'],
    checks: [{ id: 'unit-tests', status: failing.length ? 'FAILED' : 'PASSED', exit_code: failing.length ? 1 : 0, flaky: false, log: 'logs/unit-tests.log' }],
    ui: [],
    acceptance_evidence: [],
    verdict,
    unverified: [],
  };
}

function candidate(fx: Fixture, attempt: number, workerId: string, tree: string): CandidateRecord {
  const c = reserveCandidate(fx.db, { runId: fx.runId, attempt, workerId, treeHash: tree, parentSha: 'base000' }, fx.clock);
  return finalizeCandidate(fx.db, c.id, `commit${attempt}0000000`, { files: 1, insertions: 4, deletions: 0, binaryFiles: 0, paths: ['calc.mjs'], truncated: false }, fx.clock);
}

function runCheck(fx: Fixture, cand: CandidateRecord, status: 'PASSED' | 'FAILED', seconds: number): void {
  const planned = fx.at(seconds, () => planCheckRun(fx.db, { runId: fx.runId, candidateId: cand.id, checkId: 'unit-tests', kind: 'command', treeHash: cand.treeHash, checkConfigHash: 'cfg', policyHash: 'pol', command: ['node', '--test'], cwd: '.', isolation: 'none', limitations: [] }, fx.clock));
  fx.at(seconds + 1, () => markCheckRunning(fx.db, planned.id, 4242, fx.clock));
  fx.at(seconds + 6, () =>
    finishCheckRun(fx.db, planned.id, {
      status,
      exitCode: status === 'PASSED' ? 0 : 1,
      timedOut: false,
      cancelled: false,
      logPath: 'logs/unit-tests.log',
      logSha256: null,
      fingerprint: status === 'FAILED' ? 'fp-mul-undefined' : null,
      excerpt: null,
      artifacts: [],
      endedAt: fx.clock.now(),
    }),
  );
}

export function worker(fx: Fixture, id: string, role: 'implementer' | 'reviewer' | 'planner', provider: string, model: string, attempt: number | null, seconds: number, state: 'SUCCEEDED' | 'FAILED', cost: number | null): void {
  fx.at(seconds, () => planWorker(fx.db, { id, runId: fx.runId, role, provider, model, attempt, workerDir: `${fx.runDir}/workers/${id}`, cwd: fx.runDir }, fx.clock));
  fx.at(seconds + 1, () => markWorkerRunning(fx.db, id, { pid: 4000 + seconds, pgid: 4000 + seconds, procStart: null }, fx.clock));
  fx.at(seconds + 40, () => {
    finishWorker(fx.db, id, { state, exitCode: state === 'SUCCEEDED' ? 0 : 1, resultStatus: state === 'SUCCEEDED' ? 'succeeded' : 'max_turns', ...(state === 'FAILED' ? { error: 'ran out of turns' } : {}) }, fx.clock);
    recordUsage(
      fx.db,
      {
        runId: fx.runId,
        workerId: id,
        usage: { provider, model, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost, costSource: cost === null ? 'unavailable' : 'reported' },
        durationMs: 39_000,
        pricing: null,
      },
      fx.clock,
    );
  });
}

function route(fx: Fixture, id: string, purpose: string, workKind: string, model: string, seconds: number, extra: Record<string, unknown> = {}): void {
  fx.at(seconds, () =>
    recordDecision(
      fx.db,
      fx.runDir,
      {
        id,
        runId: fx.runId,
        kind: 'route',
        summary: `${purpose}: route ${workKind} -> claude/${model}`,
        data: {
          kind: 'route',
          work_kind: workKind,
          provider: 'claude',
          model,
          effort: 'high',
          reason: `${workKind} starts at the sonnet tier`,
          justification: { signals: [], evidence: [], ignored: [] },
          alternatives_considered: [],
          attempt: 1,
          difficulty: 'simple',
          purpose,
          ...extra,
        },
      },
      fx.clock,
    ),
  );
}

/** The whole story. Offsets are seconds after T0. */
export function buildFullRun(lab: Lab): Fixture {
  const fx = startFixture(lab);
  fx.at(1, () => fx.to('PREFLIGHT', 'starting'));
  fx.at(2, () => fx.to('CONTRACTING', 'preflight passed: clean tree, baseline recorded'));
  fx.at(3, () => fx.to('PLANNING', 'contract committed'));
  fx.at(4, () => fx.to('INQUISITION', 'ambiguity: rounding of the product'));
  const q = fx.at(5, () =>
    insertQuestion(
      fx.db,
      {
        runId: fx.runId,
        mode: 'clarify',
        question: 'Should mul round its result?',
        evidence: ['calc.mjs:1'],
        options: [
          { label: 'A', description: 'exact', consequences: 'none' },
          { label: 'B', description: 'two decimals', consequences: 'money format' },
        ],
        changes: ['implementation'],
        recommendation: { option: 'A', reason: 'simplest' },
        safeDefault: { exists: true, option: 'A', reason: 'reversible' },
        material: true,
        affected: ['AC-1'],
        unblocked: [],
      },
      fx.clock,
    ),
  );
  fx.at(65, () => setQuestionAnswer(fx.db, q.id, 'A', 'alice', fx.clock));
  fx.at(66, () => fx.to('PLANNING', 'question answered; back to planning'));
  fx.at(70, () => fx.to('IMPLEMENTING', 'plan accepted'));

  // Attempt 1 on the cheap route.
  route(fx, 'dec-route-attempt-1', 'implement-1', 'implementation', 'claude-sonnet-4-6', 71);
  fx.event('implementation.attempt', { attempt: 1, route: 'dec-route-attempt-1', spend_cap_usd: 2 }, 72);
  worker(fx, 'w-impl-1', 'implementer', 'claude', 'claude-sonnet-4-6', 1, 73, 'SUCCEEDED', 0.12);
  const c1 = fx.at(114, () => candidate(fx, 1, 'w-impl-1', 'tree1111111111'));
  fx.at(115, () => fx.to('VERIFYING', 'attempt 1 produced candidate 1'));
  runCheck(fx, c1, 'FAILED', 116);
  fx.at(125, () => insertEvidenceReport(fx.db, { candidateId: c1.id, report: report(fx.runId, 1, c1.treeHash, 'FAIL', ['unit-tests']), reportPath: null }, fx.clock));
  fx.at(126, () => fx.to('DIAGNOSING', 'verification FAIL on candidate 1: unit-tests'));
  fx.at(127, () => fx.to('REPAIRING', 'repair brief accepted'));

  // Attempt 2 escalates, with the evidence that justified it.
  route(fx, 'dec-route-attempt-2', 'implement-2', 'implementation', 'claude-opus-4-8', 129, {
    attempt: 2,
    escalated_from: { provider: 'claude', model: 'claude-sonnet-4-6', family: 'sonnet' },
    reason: 'repeated failure fingerprint fp-mul-undefined after attempt 1',
    justification: { signals: [{ signal: 'repeated-failure', detail: 'fp-mul-undefined seen twice', evidence: ['chk:unit-tests'] }], evidence: ['chk:unit-tests', 'cand:1'], ignored: [] },
  });
  fx.event('implementation.attempt', { attempt: 2, route: 'dec-route-attempt-2', spend_cap_usd: 3 }, 130);
  worker(fx, 'w-impl-2', 'implementer', 'claude', 'claude-opus-4-8', 2, 131, 'SUCCEEDED', null);
  fx.event('budget.cost-ceiling-charged', { role: 'implementer', ceiling_usd: 1 }, 171);
  const c2 = fx.at(172, () => candidate(fx, 2, 'w-impl-2', 'tree2222222222'));
  fx.at(173, () => fx.to('VERIFYING', 'repair attempt 2 produced candidate 2'));
  runCheck(fx, c2, 'PASSED', 174);
  fx.at(183, () => insertEvidenceReport(fx.db, { candidateId: c2.id, report: report(fx.runId, 2, c2.treeHash, 'PASS', []), reportPath: null }, fx.clock));
  fx.at(184, () => fx.to('REVIEWING', 'verification PASS on candidate 2'));
  worker(fx, 'w-rev-1', 'reviewer', 'codex', 'gpt-6.1-sol', null, 185, 'SUCCEEDED', 0.05);
  fx.at(226, () =>
    recordReview(
      fx.db,
      {
        runId: fx.runId,
        candidateId: c2.id,
        treeHash: c2.treeHash,
        round: 1,
        provider: 'codex',
        model: 'gpt-6.1-sol',
        workerId: 'w-rev-1',
        verdict: 'APPROVE',
        packetSha256: null,
        findings: [{ externalId: 'F-1', severity: 'low', category: 'style', location: 'calc.mjs:3', path: 'calc.mjs', line: 3, claim: 'name could be clearer', evidence: 'calc.mjs:3', suggestedValidation: null }],
      },
      fx.clock,
    ),
  );
  fx.at(227, () => fx.to('DELIVERING', 'independent review approved candidate 2'));

  // Delivery.
  fx.event('action.intent', { action_id: 'act-1', kind: 'push_task_branch', key: 'k1', tree_hash: c2.treeHash, commit_sha: c2.commitSha }, 228);
  fx.event('action.executing', { action_id: 'act-1', kind: 'push_task_branch', attempt: 1, executor: OWNER, deadline_at: T0 + 400_000 }, 229);
  fx.event('action.succeeded', { action_id: 'act-1', kind: 'push_task_branch', via: 'execute', attempts: 1 }, 232);
  fx.at(233, () =>
    recordDecision(fx.db, fx.runDir, { id: 'dec-delivered', runId: fx.runId, kind: 'delivery.completed', summary: 'delivered commit2000000 to orbit/mul', data: { commit: 'commit2000000', branch: 'orbit/mul', pr: null } }, fx.clock),
  );
  fx.at(234, () => fx.to('SUCCEEDED', 'delivered and reviewed'));

  // What the ledger charged: the measured cost plus a ceiling for the session that reported none.
  fx.db.run("INSERT INTO budget_counters (run_id, counter, used, allowance, hard_cap) VALUES (?, 'cost_usd', 1.17, 5, 10)", fx.runId);
  fx.finishSucceeded();
  return fx;
}
