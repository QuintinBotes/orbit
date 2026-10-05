/**
 * IMPLEMENTING and REPAIRING: one implementation attempt per entry. An
 * attempt is admitted by the scheduler and the budget, counted durably
 * (`implementation.attempt`), given to an implementer worker in the run's
 * worktree, and ends when the controller snapshots the worktree into a
 * candidate (`implementation.candidate`). A worker that already exists for
 * the attempt is observed, never duplicated.
 *
 * Whatever the worker reports about itself, its edits are snapshotted and
 * verified: verification, not the worker, decides. Only authentication
 * failures (block), transient provider failures and stray cancellations
 * (retry within the attempt, bounded by infrastructure_retries) skip that.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonIfExists } from '../../core/fsx.ts';
import { OrbitError, isOrbitError } from '../../core/errors.ts';
import { appendEvent } from '../../storage/events.ts';
import { listActiveWorkers, type WorkerRecord } from '../../storage/workers.ts';
import { classifyFailure, decideRetry } from '../../recovery/backoff.ts';
import { recoveryAttemptsRemaining, spendRecoveryAttempt } from '../../recovery/budget.ts';
import { stopRowProcess } from '../../recovery/reconcile.ts';
import { renderWorkerPrompt, type EvidenceRef, type PromptBrief } from '../../adapters/prompt.ts';
import { snapshotCandidate } from '../../evidence/candidate.ts';
import { invalidateEvidence } from '../../evidence/freshness.ts';
import { currentEvidenceReport, listCheckRuns, listEvidenceReports, listFailures } from '../../evidence/store.ts';
import { progressSince } from '../../inquisition/repair.ts';
import { attemptHistory } from './diagnosing.ts';
import { cancelObsoleteWork } from './reviewing.ts';
import { invalidateStaleReviews } from '../../review/stale.ts';
import { budgetAdmission } from '../../scheduling/scheduler.ts';
import type { DifficultyClass, WorkUnit } from '../../scheduling/types.ts';
import { CANDIDATE_EVENT, machineAdmission, schedulerFor, type RunContext } from '../context.ts';
import { blockingQuestions } from '../gates.ts';
import { ensureWorker, raiseOutputCap, recordSpendCap, routeFor, sessionSpendCap } from '../workers.ts';
import { recordedUnits, recordUnits, runParallelUnits, serializedUnits, splitAttempt } from '../parallel-writers.ts';
import type { WorkUnitPlan } from '../../scheduling/work-units.ts';
import { attemptSubject, deniedWorkerOperations, grantFor, requestAttemptAuthorization, runApprovedOperation, sessionEvents, ungrantedCommands, type ApprovedRun, type GuardedOperation } from '../authorization.ts';
import { advisoryBlockFor } from '../knowledge-hooks.ts';
import { assertContract, blockOnAuth, decide, finishRun, move, note, policySummary, progress, retryWait, safePoint, scheduleTransientRetry, WAIT, type StepResult } from './common.ts';
import { attemptStart, latestAttempt } from './obtain.ts';

export const ATTEMPT_EVENT = 'implementation.attempt';

/** A repair brief waiting for an attempt, as DIAGNOSING, REVIEWING or AWAITING_CI wrote it. */
export interface StoredBrief {
  attempt: number;
  source: 'diagnosis' | 'review' | 'ci' | 'scope';
  fingerprint: string | null;
  brief: object;
  /** Paths of evidence the brief cites, relative to the run directory. */
  refs?: string[];
}

export function briefPath(ctx: Pick<RunContext, 'runDir'>, attempt: number): string {
  return join(ctx.runDir, 'briefs', `attempt-${attempt}.json`);
}

/** The highest attempt started, from the durable attempt events. */
export function currentAttempt(ctx: RunContext): number {
  const row = ctx.db.get<{ n: number | null }>("SELECT MAX(CAST(json_extract(data_json, '$.attempt') AS INTEGER)) AS n FROM events WHERE run_id = ? AND type = ?", ctx.run.id, ATTEMPT_EVENT);
  return Number(row?.n ?? 0);
}

export function attemptCandidateId(ctx: RunContext, attempt: number): string | null {
  const row = ctx.db.get<{ id: string | null }>("SELECT json_extract(data_json, '$.candidate_id') AS id FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ? ORDER BY id DESC LIMIT 1", ctx.run.id, CANDIDATE_EVENT, attempt);
  return row?.id ?? null;
}

export async function implementingStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  const contract = assertContract(ctx);
  if (!ctx.ledger) throw new OrbitError('INTERNAL', `run ${ctx.run.id} is ${ctx.run.state} without budget counters`);
  if (!ctx.run.worktreePath || !ctx.run.baseRevision) throw new OrbitError('INTERNAL', `run ${ctx.run.id} has no worktree or base revision`);

  let n = currentAttempt(ctx);
  if (n > 0 && attemptCandidateId(ctx, n) !== null) {
    // The attempt already became a candidate; verification of it may not have started (a crash before the transition).
    const cand = ctx.candidate;
    if (cand && !currentEvidenceReport(ctx.db, ctx.run.id, cand.id)) return move(ctx, 'VERIFYING', `candidate ${cand.seq} of attempt ${n} awaits verification`);
    n = 0;
  }
  if (n === 0) {
    const started = await startAttempt(ctx, currentAttempt(ctx) + 1);
    if (started) return started;
    n = currentAttempt(ctx);
  }
  return continueAttempt(ctx, n, contract);
}

/** Admit and count a new attempt. Returns a step result when it may not start (budget, capacity). */
async function startAttempt(ctx: RunContext, n: number): Promise<StepResult | null> {
  const ledger = ctx.ledger!;
  const route = routeFor(ctx, `implement:${n}`, 'routine-code', routeSignals(ctx, n));
  const scheduler = schedulerFor(ctx);
  // Capacity is the machine's, not the run's: every live worker of this repository's database occupies a slot,
  // whichever run it belongs to (spec section 8; scenario 15 with two runs under one controller).
  const running = runningUnits(ctx);
  const own = new Set(running.filter((u) => u.runId === ctx.run.id).map((u) => u.unit.id));
  const cap = sessionSpendCap(ctx, route.model, 'implementer');
  const unit: WorkUnit = {
    id: `implement:${n}`,
    role: 'implementer',
    writer: true,
    ownedPaths: assertContract(ctx).allowed_paths,
    dependsOn: [],
    revision: ctx.candidate?.treeHash ?? null,
    cancelWhen: [],
    // Admission keeps the conservative role ceiling for the cost estimate: an attempt is more than one session.
    budget: { costUsd: null, wallMs: null, maxTurns: ledger.maxTurnsPerSession() },
    provider: route.provider,
    worktree: ctx.run.worktreePath,
    status: 'pending',
  };
  // The run's own limits (parallel_workers, parallelism, worktree, ownership, budget) over its own units...
  const plan = scheduler.plan([...running.filter((r) => own.has(r.unit.id)).map((r) => r.unit), unit], { admit: budgetAdmission(ledger) });
  // ...and the machine's (CPU, memory) over every run's.
  const machine = plan.start.some((u) => u.id === unit.id) ? machineAdmission(ctx, running.map((r) => r.unit), [unit]) : null;
  if (!plan.start.some((u) => u.id === unit.id) || (machine && !machine.start.has(unit.id))) {
    const why = plan.deferred.find((d) => d.id === unit.id)?.reason ?? machine?.deferred.get(unit.id) ?? 'not admitted';
    // Budget refusals cannot clear by waiting; capacity and worktree conflicts can.
    if (/^not admitted by budget/.test(why)) return finishRun(ctx, 'EXHAUSTED', `attempt ${n} not admitted: the remaining budget cannot support an honest completion (${why})`, { data: { admission: why } });
    return WAIT(`attempt ${n} deferred: ${why}`);
  }
  if (cap.capUsd !== null && cap.capUsd <= 0) return finishRun(ctx, 'EXHAUSTED', `attempt ${n} not started: no model budget left under the hard cap less the closing reserve`);

  // A fresh attempt whose criteria map to disjoint files runs as parallel writers in their own worktrees (G14).
  const units = splitAttempt(ctx, assertContract(ctx), n === 1 && !existsSync(briefPath(ctx, n)));
  // The attempt is counted and recorded in one transaction (with its work units), so a crash can neither count it twice nor lose it.
  const counted = ctx.db.tx(() => {
    if (ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ?", ctx.run.id, ATTEMPT_EVENT, n)) return false;
    ledger.consume('implementation_attempts', 1);
    appendEvent(ctx.db, ctx.run.id, ATTEMPT_EVENT, ctx.ownerId, { attempt: n, route: route.decisionId, spend_cap_usd: cap.capUsd }, ctx.clock.now());
    if (units) recordUnits(ctx, n, units);
    return true;
  });
  if (counted && units) {
    decide(ctx, { id: `dec-${ctx.run.id}-units-${n}`, kind: 'scheduling.work-units', summary: `attempt ${n} runs as ${units.length} parallel writers with disjoint files: ${units.map((u) => `${u.id} (${u.criteria.join(', ')})`).join('; ')}`, data: { attempt: n, units } });
  }
  if (cap.capUsd !== null) recordSpendCap(ctx, `implement:${n}#1`, cap.capUsd, cap.worstCaseUsd);
  return null;
}

const READ_ONLY_ROLES = new Set(['planner', 'verifier', 'reviewer', 'inquisitor', 'curator', 'explorer']);

/**
 * Every live worker of the repository as a running work unit, with the run it belongs to, plus the attempts
 * other runs were admitted for whose implementer is not planned yet. Steps of different runs interleave between
 * admission and the worker row, so an admitted attempt holds its slot from the moment it is counted.
 */
export function runningUnits(ctx: RunContext): { runId: string; unit: WorkUnit }[] {
  const out: { runId: string; unit: WorkUnit }[] = listActiveWorkers(ctx.db).map((w) => ({
    runId: w.runId,
    // Another run's writer edits its own worktree, so its paths cannot collide with this run's; it still takes a slot.
    unit: { id: w.id, role: w.role, writer: w.runId === ctx.run.id && !READ_ONLY_ROLES.has(w.role), ownedPaths: w.ownedPaths ?? [], dependsOn: [], revision: null, cancelWhen: [], budget: {}, provider: w.provider, worktree: w.cwd, status: 'running' },
  }));
  const reserved = ctx.db.all<{ run_id: string; attempt: number }>(
    `SELECT e.run_id, MAX(CAST(json_extract(e.data_json, '$.attempt') AS INTEGER)) AS attempt FROM events e JOIN runs r ON r.id = e.run_id
     WHERE e.type = ? AND e.run_id <> ? AND r.state IN ('IMPLEMENTING', 'REPAIRING') GROUP BY e.run_id`,
    ATTEMPT_EVENT,
    ctx.run.id,
  );
  for (const r of reserved) {
    const planned = ctx.db.get("SELECT 1 AS x FROM workers WHERE run_id = ? AND role = 'implementer' AND attempt = ? LIMIT 1", r.run_id, r.attempt);
    const produced = ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ? LIMIT 1", r.run_id, CANDIDATE_EVENT, r.attempt);
    if (planned || produced) continue;
    out.push({ runId: r.run_id, unit: { id: `reserved:${r.run_id}:${r.attempt}`, role: 'implementer', writer: false, ownedPaths: [], dependsOn: [], revision: null, cancelWhen: [], budget: {}, provider: null, worktree: null, status: 'running' } });
  }
  return out;
}

async function continueAttempt(ctx: RunContext, n: number, contract: NonNullable<RunContext['contract']>): Promise<StepResult> {
  const route = routeFor(ctx, `implement:${n}`, 'routine-code', routeSignals(ctx, n));
  const base = `implement:${n}`;
  const units = recordedUnits(ctx, n);
  if (units && latestAttempt(ctx, base) === 0) {
    const r = await runParallelUnits(ctx, n, units, { route, contract, prompt: (u, all, workerId) => implementerPrompt(ctx, n, workerId, null, { unit: u, all }), running: () => runningUnits(ctx), maxTurns: ctx.ledger!.maxTurnsPerSession() });
    if (r.kind === 'step') return r.result;
    if (r.kind === 'done') return snapshot(ctx, n, r.workerId);
    // Some units could not be integrated in parallel: one implementer finishes their criteria on the integrated tree.
  }
  // A resume after a person fixed what blocked this attempt (a login) starts a fresh session instead of replaying the stored failure.
  const start = await attemptStart(ctx, base, `implementer (attempt ${n})`);
  if (!start.ok) return start.step;
  let k = start.n;
  for (;;) {
    const purpose = `${base}#${k}`;
    if (!ctx.db.get('SELECT 1 AS x FROM workers WHERE run_id = ? AND purpose = ?', ctx.run.id, purpose)) {
      // A transient failure set a backoff: the next session of this attempt waits it out.
      const wait = retryWait(ctx, base);
      if (wait) return wait;
    }
    // A supervised retry carries what a person authorized once for this attempt, or refused.
    const auth = authorizationFor(ctx, n, k);
    const st = await ensureWorker(ctx, {
      role: 'implementer',
      purpose,
      attempt: n,
      provider: route.provider,
      model: route.model,
      effort: route.effort,
      cwd: ctx.run.worktreePath!,
      readOnly: false,
      prompt: (workerId) => implementerPrompt(ctx, n, workerId, auth),
      maxBudgetUsd: capOf(ctx, n, purpose),
      ownedPaths: contract.allowed_paths,
    });
    if (st.status === 'running') return WAIT(`implementer ${st.worker.id} (attempt ${n}) is running`);
    const r = st.result;
    if (r.status === 'auth_failed') return blockOnAuth(ctx, st.worker.provider, 'auth_failed', r.error);
    const stray = r.status === 'cancelled' && !ctx.refresh().cancelRequested;
    if (r.status === 'transient_error' || stray) {
      if (r.status === 'cancelled') {
        const stop = await safePoint(ctx);
        if (stop) return stop;
      }
      const stop = await scheduleTransientRetry(ctx, { base, purpose, what: `implementer (attempt ${n})`, status: r.status, error: r.error });
      if (stop) return stop;
      k++;
      continue;
    }
    if (r.status === 'cancelled') {
      const stop = await safePoint(ctx);
      if (stop) return stop;
    }
    if (r.status === 'lost') {
      // The worker died under a live controller (spec section 14: preserve the worktree, restart a bounded worker).
      // Its half-written tree is not an attempt: a new session of the same attempt continues in the same worktree.
      const stop = await restartLostImplementer(ctx, st.worker, n, `${base}#${k + 1}`, route.model);
      if (stop) return stop;
      k++;
      continue;
    }
    // A response that exceeded the output cap would fail the same way at the same cap: the next session of this
    // attempt runs under the cap doubled (a recorded decision), once, in the same worktree.
    if (r.status === 'failed' && raiseOutputCap(ctx, purpose, r.error) !== null) {
      k++;
      continue;
    }
    // Supervised mode: what the guard denied inside the session is asked about, not only denied (spec section 5).
    const sup = await superviseDenials(ctx, n, k, st.worker);
    if (sup.kind === 'stop') return sup.result;
    if (sup.kind === 'retry') {
      k++;
      continue;
    }
    if (r.status !== 'succeeded') note(ctx, 'implementation.worker-ended', { attempt: n, status: r.status, error: r.error?.slice(0, 300) ?? null, note: 'its edits are verified like any other' });
    return snapshot(ctx, n, st.worker.id);
  }
}

export const AUTHORIZATION_RETRY_EVENT = 'authorization.retry';

/** A supervised retry of an attempt after a person answered for operations its session was denied. */
export interface AuthorizationRetry {
  attempt: number;
  /** Session number (`implement:<n>#<k>`) whose denials were answered. */
  after: number;
  /** Session number that runs with the answers. */
  next: number;
  granted: GuardedOperation[];
  refused: GuardedOperation[];
  /** What the controller ran for each granted operation (absent in events written before it ran them). */
  executed?: ApprovedRun[];
}

function authorizationRetries(ctx: RunContext, n: number): AuthorizationRetry[] {
  return ctx.db
    .all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ? ORDER BY id", ctx.run.id, AUTHORIZATION_RETRY_EVENT, n)
    .map((r) => JSON.parse(r.data_json) as AuthorizationRetry);
}

/** The answers session `k` of attempt `n` runs with: the newest retry that starts at or before it (a transient restart keeps them). */
function authorizationFor(ctx: RunContext, n: number, k: number): AuthorizationRetry | null {
  return authorizationRetries(ctx, n).filter((r) => r.next <= k).at(-1) ?? null;
}

type Supervision = { kind: 'proceed' } | { kind: 'retry' } | { kind: 'stop'; result: StepResult };

/**
 * Supervised mode (spec section 5: ask before unauthorized actions; section 10: persist questions, never wait on a
 * keyboard). The action-class operations the guard denied inside session `k` of attempt `n` become persisted
 * approve-once or deny questions and the run blocks until a person answers. Once every one is answered, the
 * controller runs each approved operation itself, exactly as approved, once, in isolation (a recorded action),
 * and the attempt is retried in the same worktree under the unchanged frozen policy with the output of each as an
 * artifact; refused ones are a scope repair. A retried session that ran anything the frozen policy denies is a
 * policy violation. Each operation is retried at most once per attempt.
 */
async function superviseDenials(ctx: RunContext, n: number, k: number, worker: WorkerRecord): Promise<Supervision> {
  if (ctx.run.mode !== 'supervised') return { kind: 'proceed' };
  const retries = authorizationRetries(ctx, n);
  if (retries.some((r) => r.after === k)) return { kind: 'retry' };
  const auth = retries.filter((r) => r.next <= k).at(-1);
  if (auth && auth.granted.length > 0) {
    // The controller ran what was approved; the worker itself was never allowed it, so no grant excuses anything here.
    const extra = ungrantedCommands(sessionEvents(worker), ctx.snapshot, worker.cwd, []);
    if (extra.length > 0) {
      decide(ctx, { id: `dec-${ctx.run.id}-deny-ungranted-${worker.id}`, kind: 'policy.deny', summary: `implementer ${worker.id} ran under a one-shot grant and did what no grant names: ${extra.join('; ')}`, data: { source: 'grant-check', worker_id: worker.id, attempt: n, ungranted: extra, granted: auth.granted.map((g) => g.key) } });
      return { kind: 'stop', result: await finishRun(ctx, 'BLOCKED', `policy violation in attempt ${n}: under a one-shot grant the implementer also ran what the policy denies and no person authorized (${extra.join('; ')}); its work will not be verified or delivered`, { outcome: { attempt: n, ungranted: extra } }) };
    }
  }
  const applied = new Set(retries.flatMap((r) => [...r.granted, ...r.refused].map((g) => g.key)));
  const ops = deniedWorkerOperations(ctx, worker).filter((o) => !applied.has(o.key));
  if (ops.length === 0) return { kind: 'proceed' };
  const subject = attemptSubject(n);
  const pending: string[] = [];
  const granted: GuardedOperation[] = [];
  const grants: { decisionId: string; approvedBy: string }[] = [];
  const refused: GuardedOperation[] = [];
  for (const op of ops) {
    const g = grantFor(ctx, op, subject);
    if (g.state === 'granted') {
      granted.push(op);
      grants.push({ decisionId: g.decisionId, approvedBy: g.approvedBy });
    } else if (g.state === 'denied') refused.push(op);
    else pending.push(`${g.state === 'pending' ? g.questionId : requestAttemptAuthorization(ctx, op, n, worker).id}: ${op.summary}`);
  }
  if (pending.length > 0) {
    return { kind: 'stop', result: await finishRun(ctx, 'BLOCKED', `supervised mode: implementation attempt ${n} was denied operations the policy does not authorize; a person decides each one (approve-once or deny with orbit decide, then orbit resume ${ctx.run.id}). Questions: ${pending.join(' | ')}`, { outcome: { authorization: pending } }) };
  }
  // Exactly what was approved, run by the controller (never by the worker), once each.
  const executed: ApprovedRun[] = [];
  for (const [i, op] of granted.entries()) executed.push(await runApprovedOperation(ctx, n, op, grants[i]!));
  note(ctx, AUTHORIZATION_RETRY_EVENT, { attempt: n, after: k, next: k + 1, granted, refused, executed } satisfies AuthorizationRetry);
  return { kind: 'retry' };
}

export const LOST_RESTART_EVENT = 'recovery.worker-restart';

/**
 * Restart a lost implementer the way reconciliation would (recovery/reconcile): the failure is classified as a
 * crash, the recovery budget decides, one recovery attempt is spent (once per lost worker, with its record),
 * any process the lost worker left is stopped, and the next session runs in the preserved worktree under a
 * fresh spend cap. Returns a terminal result when the recovery budget refuses.
 */
async function restartLostImplementer(ctx: RunContext, lost: WorkerRecord, n: number, nextPurpose: string, model: string | null): Promise<StepResult | null> {
  const already = ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.worker_id') = ? LIMIT 1", ctx.run.id, LOST_RESTART_EVENT, lost.id);
  if (already) return null;
  const decision = decideRetry({
    classification: classifyFailure({ status: 'lost' }),
    provider: lost.provider,
    runId: ctx.run.id,
    attempt: 1,
    infrastructureRetriesRemaining: Number.POSITIVE_INFINITY,
    wallRemainingMs: null,
    costRemainingUsd: null,
    recoveryAttemptsRemaining: recoveryAttemptsRemaining(ctx.db, ctx.run.id, undefined),
  });
  if (decision.action !== 'restart') return finishRun(ctx, 'EXHAUSTED', `recovery_attempts exhausted: lost implementer ${lost.id} (attempt ${n}) cannot be restarted: ${decision.reason}`, { data: { counter: 'recovery_attempts' } });
  // Nothing of the lost session may still write into the worktree the restart is about to use.
  const gone = await stopRowProcess(ctx.timing.killGraceMs, lost);
  if (gone === 'unknown') return WAIT(`lost implementer ${lost.id}: its process could not be confirmed stopped; not restarting yet`);
  try {
    spendRecoveryAttempt(ctx.db, ctx.run.id, ctx.clock, { ledgerFor: () => ctx.ledger, actor: ctx.ownerId, why: `restart of lost implementer ${lost.id} (attempt ${n})` });
  } catch (err) {
    if (isOrbitError(err, 'BUDGET_EXHAUSTED')) return finishRun(ctx, 'EXHAUSTED', `recovery_attempts exhausted: lost implementer ${lost.id} (attempt ${n}) cannot be restarted: ${err.message}`, { data: { counter: 'recovery_attempts' } });
    throw err;
  }
  const cap = sessionSpendCap(ctx, model, 'implementer');
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, LOST_RESTART_EVENT, ctx.ownerId, { worker_id: lost.id, attempt: n, next_purpose: nextPurpose, cwd_preserved: lost.cwd, live_controller: true }, ctx.clock.now()));
  if (cap.capUsd !== null) {
    if (cap.capUsd <= 0) return finishRun(ctx, 'EXHAUSTED', `lost implementer ${lost.id} not restarted: no model budget left under the hard cap less the closing reserve`);
    recordSpendCap(ctx, nextPurpose, cap.capUsd, cap.worstCaseUsd);
  }
  return null;
}

async function snapshot(ctx: RunContext, n: number, workerId: string): Promise<StepResult> {
  const cand = await snapshotCandidate({ db: ctx.db, clock: ctx.clock, repoRoot: ctx.run.repoRoot, worktree: ctx.run.worktreePath!, runId: ctx.run.id, baseRev: ctx.run.baseRevision!, attempt: n, workerId });
  // Every earlier report and review describes another tree now (spec section 11: invalidate on change).
  invalidateEvidence(ctx.db, ctx.run.id, `attempt ${n} produced candidate ${cand.seq} (tree ${cand.treeHash})`, ctx.clock, { exceptTreeHash: cand.treeHash });
  invalidateStaleReviews(ctx.db, { runId: ctx.run.id, runDir: ctx.runDir, current: { candidateId: cand.id, treeHash: cand.treeHash }, cause: `attempt ${n}` }, ctx.clock);
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, CANDIDATE_EVENT, ctx.ownerId, { attempt: n, candidate_id: cand.id, seq: cand.seq, tree_hash: cand.treeHash, reused: !cand.created }, ctx.clock.now()));
  ctx.candidate = cand;
  // Read-only work on the previous revision (reviewers, verifiers, explorers) is worthless now: stop it.
  await cancelObsoleteWork(ctx, cand.treeHash);
  progress(ctx, 'candidate', { attempt: n, candidate_id: cand.id, seq: cand.seq, tree_hash: cand.treeHash, reused: !cand.created });
  return move(ctx, 'VERIFYING', `attempt ${n} produced candidate ${cand.seq}${cand.created ? '' : ' (the same tree as an earlier candidate)'}`);
}

/** The spend cap of a session: the one recorded for its purpose, else the attempt's. */
function capOf(ctx: RunContext, n: number, purpose: string): number | null {
  const own = ctx.db.get<{ cap: number | null }>("SELECT json_extract(data_json, '$.cap_usd') AS cap FROM events WHERE run_id = ? AND type = 'worker.spend-cap' AND json_extract(data_json, '$.purpose') = ? ORDER BY id DESC LIMIT 1", ctx.run.id, purpose);
  if (typeof own?.cap === 'number') return own.cap;
  const row = ctx.db.get<{ cap: number | null }>("SELECT json_extract(data_json, '$.spend_cap_usd') AS cap FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ? ORDER BY id DESC LIMIT 1", ctx.run.id, ATTEMPT_EVENT, n);
  return typeof row?.cap === 'number' ? row.cap : null;
}

/**
 * Escalation signals from durable records only: equivalent failures (same
 * fingerprint on distinct candidates) with the failure record ids as
 * evidence, the previous route with its outcome, the planning assessment's
 * security impact, and whether the hard diagnosis that escalated an earlier
 * attempt is solved (so routine follow-up may route back down, spec section 8).
 */
export function routeSignals(ctx: RunContext, n: number): Parameters<typeof routeFor>[3] {
  const difficulty = (ctx.run.difficulty ?? 'medium') as DifficultyClass;
  const failures = listFailures(ctx.db, ctx.run.id);
  const prev = n > 1 ? ctx.db.get<{ data_json: string }>('SELECT data_json FROM decisions WHERE id = ?', `dec-route-${ctx.run.id}-implement_${n - 1}`) : undefined;
  const prevRoute = prev ? (JSON.parse(prev.data_json) as { provider: string; model: string; effort: string | null }) : null;
  const solved = n > 1 && diagnosisSolved(ctx, n);
  const latest = failures.at(-1) ?? null;
  const same = latest && !solved ? failures.filter((f) => f.fingerprint === latest.fingerprint) : [];
  const repeated = new Set(same.map((f) => f.candidateId ?? `row-${f.id}`)).size;
  const evidence = same.map((f) => `failure:${f.id}`);
  const security = criticalSecurity(ctx);
  return {
    difficulty,
    attempt: n,
    repeatedFingerprints: repeated,
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(security ? { criticalSecurity: true } : {}),
    ...(solved ? { diagnosisSolved: true } : {}),
    ...(prevRoute ? { previousRoute: { provider: prevRoute.provider, model: prevRoute.model, effort: prevRoute.effort, outcome: solved ? ('verified' as const) : ('failed' as const), evidence } } : {}),
  };
}

/** The planning assessment found a security-sensitive change (difficulty factor security_impact). */
function criticalSecurity(ctx: RunContext): boolean {
  if (!ctx.run.difficultyJson) return false;
  try {
    const a = JSON.parse(ctx.run.difficultyJson) as { factors?: { factor: string; value: unknown }[] };
    return a.factors?.some((f) => f.factor === 'security_impact' && f.value === true) ?? false;
  } catch {
    return false;
  }
}

/**
 * The diagnosis that escalated an earlier attempt is solved: some earlier implementation route escalated, the
 * fingerprints that drove it are gone from the newest attempt's evidence, no equivalent failure repeated on that
 * candidate, and the newest attempt made measurable progress on the cause (a fixed mandatory check or a
 * localized fault, inquisition/repair.progressSince).
 */
function diagnosisSolved(ctx: RunContext, n: number): boolean {
  let escalatedAt = 0;
  for (let k = n - 1; k >= 1; k--) {
    const row = ctx.db.get<{ data_json: string }>('SELECT data_json FROM decisions WHERE id = ?', `dec-route-${ctx.run.id}-implement_${k}`);
    const d = row ? (JSON.parse(row.data_json) as { escalated_from?: unknown }) : null;
    if (d?.escalated_from) {
      escalatedAt = k;
      break;
    }
  }
  if (escalatedAt === 0) return false;
  const latestCand = attemptCandidateId(ctx, n - 1);
  if (!latestCand) return false;
  const report = listEvidenceReports(ctx.db, ctx.run.id).filter((r) => r.candidateId === latestCand).at(-1);
  if (!report) return false;
  const failures = listFailures(ctx.db, ctx.run.id);
  const earlier = new Set<string>();
  for (let k = 1; k < escalatedAt; k++) {
    const c = attemptCandidateId(ctx, k);
    for (const f of failures) if (c !== null && f.candidateId === c) earlier.add(f.fingerprint);
  }
  if (earlier.size === 0) return false;
  const now = new Set(failures.filter((f) => f.candidateId === latestCand).map((f) => f.fingerprint));
  if ([...earlier].some((fp) => now.has(fp))) return false;
  const history = attemptHistory(ctx);
  const cur = history.find((h) => h.attempt === n - 1);
  if (!cur) return false;
  const before = [...history].reverse().find((h) => h.attempt < n - 1) ?? null;
  const p = progressSince(before, cur);
  return p.fixed_checks.length > 0 || p.localized_fault !== null || (report.verdict === 'PASS' && p.made_progress);
}

function implementerPrompt(ctx: RunContext, n: number, workerId: string, auth: AuthorizationRetry | null = null, parallel: { unit: WorkUnitPlan; all: readonly WorkUnitPlan[] } | null = null): string {
  const contract = assertContract(ctx);
  const blocked = blockingQuestions(ctx.db, ctx.run.id).criteria;
  const stored = readJsonIfExists<StoredBrief>(briefPath(ctx, n));
  const briefs: PromptBrief[] = stored ? [{ label: `${stored.source} repair brief`, content: stored.brief, ref: `briefs/attempt-${n}.json` }] : [];
  const refs: EvidenceRef[] = [];
  const cand = ctx.candidate;
  if (stored && cand) {
    for (const row of listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: cand.id })) {
      if (row.status === 'PASSED' || !row.logPath || !row.logSha256) continue;
      refs.push({ id: row.checkId, path: relative(ctx.runDir, row.logPath), sha256: row.logSha256, summary: `${row.checkId} ${row.status} on candidate ${cand.seq}`, ...(row.excerpt ? { excerpt: row.excerpt } : {}) });
    }
  }
  for (const e of auth?.executed ?? []) {
    if (e.state !== 'SUCCEEDED' || !e.path || !e.sha256) continue;
    refs.push({ id: `approved-${e.key}`, path: e.path, sha256: e.sha256, summary: `output of the approved command \`${e.command}\`, run once by the controller (exit ${e.exit_code ?? 'none'}${e.timed_out ? ', timed out' : ''})`, ...(e.excerpt ? { excerpt: e.excerpt } : {}) });
  }
  const task = [
    parallel ? 'Implement your work unit of the contract below in this worktree.' : n === 1 || !stored ? 'Implement the contract below in this worktree.' : `Repair attempt ${n}: act on the repair brief below; change the cause, not the tests that show it.`,
    'Make the smallest coherent change. Add or extend behaviour tests that would fail without it. Stay inside the allowed paths.',
    'Do not commit, push, or edit protected paths, policy, CI configuration or check definitions. The controller snapshots your worktree and runs the trusted checks itself.',
    `Acceptance criteria: ${contract.acceptance_criteria.map((c) => `${c.id}${c.mandatory ? '' : ' (optional)'}: ${c.statement}`).join(' | ')}`,
    ...(blocked.length > 0 ? [`Blocked, waiting for a person's decision (do not implement or guess them): ${blocked.join(', ')}. Implement the other criteria only.`] : []),
    ...authorizationLines(auth),
    ...parallelLines(ctx, n, parallel),
  ].join('\n');
  return renderWorkerPrompt({
    role: 'implementer',
    task,
    contract,
    policySummary: policySummary(ctx, { readOnly: false }),
    candidate: { revision: cand?.commitSha ?? null, treeHash: cand?.treeHash ?? null, base: ctx.run.baseRevision },
    briefs,
    evidenceRefs: refs,
    advisoryBlock: advisoryBlockFor(ctx, { role: 'implementer', workerId, paths: contract.allowed_paths, checkIds: contract.required_check_ids, fingerprints: stored?.fingerprint ? [stored.fingerprint] : [] }),
  });
}

/** A unit writer's share of the attempt, or what the serial implementer takes over from units that could not be integrated. */
function parallelLines(ctx: RunContext, n: number, parallel: { unit: WorkUnitPlan; all: readonly WorkUnitPlan[] } | null): string[] {
  if (parallel) {
    const others = parallel.all.filter((u) => u.id !== parallel.unit.id);
    return [
      `You are work unit ${parallel.unit.id} of ${parallel.all.length} parallel writers for this attempt, each in its own worktree. Implement only ${parallel.unit.criteria.join(', ')}; the other criteria are someone else's.`,
      `Change only these files (plus a new behaviour test of your own for your criteria): ${parallel.unit.ownedPaths.join(', ')}.`,
      `Do not touch what the other units own: ${others.flatMap((u) => u.ownedPaths).join(', ')}. The controller integrates the units one at a time; a unit that touches a file another unit changed is redone serially.`,
    ];
  }
  const dropped = serializedUnits(ctx, n);
  if (dropped.length === 0) return [];
  return [
    'Part of this attempt was implemented by parallel writers and is already in this worktree; keep it.',
    ...dropped.map((d) => `Work unit ${d.unit} (${d.criteria.join(', ')}) could not be integrated in parallel (${d.reason}). Implement ${d.criteria.join(', ')} now, on top of the integrated work.`),
  ];
}

/** What a person answered about operations an earlier session of this attempt was denied. */
function authorizationLines(auth: AuthorizationRetry | null): string[] {
  if (!auth) return [];
  const lines = ['An earlier session of this attempt was denied operations the policy does not authorize, and a person answered. Continue from the current worktree: the earlier edits are there.'];
  for (const g of auth.granted) lines.push(`Authorized once, for this attempt only: ${g.summary}. ${approvedOutcome(auth.executed?.find((e) => e.key === g.key) ?? null)} Do not run it yourself: you are still refused it, and anything else outside the policy stops the run.`);
  for (const g of auth.refused) lines.push(`Refused by a person: ${g.summary}. Do not try it again; finish the work inside the policy without it.`);
  return lines;
}

/** What the controller did with one approved operation, for the retried session. */
function approvedOutcome(e: ApprovedRun | null): string {
  if (!e) return 'The controller performs approved operations; the policy you run under is unchanged.';
  if (e.state === 'SUCCEEDED') return `The controller ran exactly this command once, in isolation, on your behalf (exit code ${e.exit_code ?? 'none'}${e.timed_out ? ', timed out' : ''}); its output is the evidence artifact approved-${e.key} (${e.path}).`;
  if (e.state === 'UNKNOWN') return `The controller started it on your behalf, but its outcome is unknown (${e.note ?? 'no detail'}); it is not run again.`;
  return `Nothing was run for it: ${e.note ?? 'there was no exact command to run'}.`;
}

function relative(root: string, p: string): string {
  return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
}
