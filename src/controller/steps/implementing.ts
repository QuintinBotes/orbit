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
import { join } from 'node:path';
import { readJsonIfExists } from '../../core/fsx.ts';
import { OrbitError } from '../../core/errors.ts';
import { appendEvent } from '../../storage/events.ts';
import { listActiveWorkers } from '../../storage/workers.ts';
import { renderWorkerPrompt, type EvidenceRef, type PromptBrief } from '../../adapters/prompt.ts';
import { snapshotCandidate } from '../../evidence/candidate.ts';
import { invalidateEvidence } from '../../evidence/freshness.ts';
import { currentEvidenceReport, listCheckRuns, listFailures } from '../../evidence/store.ts';
import { invalidateStaleReviews } from '../../review/stale.ts';
import { AgentScheduler, budgetAdmission } from '../../scheduling/scheduler.ts';
import type { DifficultyClass, WorkUnit } from '../../scheduling/types.ts';
import { CANDIDATE_EVENT, type RunContext } from '../context.ts';
import { ensureWorker, recordSpendCap, routeFor, sessionSpendCap } from '../workers.ts';
import { advisoryBlockFor } from '../knowledge-hooks.ts';
import { assertContract, blockOnAuth, finishRun, move, note, policySummary, progress, safePoint, WAIT, type StepResult } from './common.ts';
import { latestAttempt } from './obtain.ts';

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
  const config = ctx.snapshot.config;
  const route = routeFor(ctx, `implement:${n}`, 'routine-code', routeSignals(ctx, n));
  const scheduler = new AgentScheduler({ agents: config.agents, scheduler: config.scheduler }, { clock: ctx.clock });
  const running: WorkUnit[] = listActiveWorkers(ctx.db, ctx.run.id).map((w) => ({ id: w.id, role: w.role, writer: !['planner', 'verifier', 'reviewer', 'inquisitor'].includes(w.role), ownedPaths: w.ownedPaths ?? [], dependsOn: [], revision: null, cancelWhen: [], budget: {}, provider: w.provider, worktree: w.cwd, status: 'running' }));
  const unit: WorkUnit = { id: `implement:${n}`, role: 'implementer', writer: true, ownedPaths: assertContract(ctx).allowed_paths, dependsOn: [], revision: null, cancelWhen: [], budget: {}, provider: route.provider, worktree: ctx.run.worktreePath, status: 'pending' };
  const plan = scheduler.plan([...running, unit], { admit: budgetAdmission(ledger) });
  if (!plan.start.some((u) => u.id === unit.id)) {
    const why = plan.deferred.find((d) => d.id === unit.id)?.reason ?? 'not admitted';
    // Budget refusals cannot clear by waiting; capacity and worktree conflicts can.
    if (/cost|wall time/i.test(why)) return finishRun(ctx, 'EXHAUSTED', `attempt ${n} not admitted: the remaining budget cannot support an honest completion (${why})`, { data: { admission: why } });
    return WAIT(`attempt ${n} deferred: ${why}`);
  }
  const cap = sessionSpendCap(ctx, route.model, 'implementer');
  if (cap.capUsd !== null && cap.capUsd <= 0) return finishRun(ctx, 'EXHAUSTED', `attempt ${n} not started: no model budget left under the hard cap less the closing reserve`);

  // The attempt is counted and recorded in one transaction, so a crash can neither count it twice nor lose it.
  ctx.db.tx(() => {
    if (ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ?", ctx.run.id, ATTEMPT_EVENT, n)) return;
    ledger.consume('implementation_attempts', 1);
    appendEvent(ctx.db, ctx.run.id, ATTEMPT_EVENT, ctx.ownerId, { attempt: n, route: route.decisionId, spend_cap_usd: cap.capUsd }, ctx.clock.now());
  });
  if (cap.capUsd !== null) recordSpendCap(ctx, `implement:${n}#1`, cap.capUsd, cap.worstCaseUsd);
  return null;
}

async function continueAttempt(ctx: RunContext, n: number, contract: NonNullable<RunContext['contract']>): Promise<StepResult> {
  const route = routeFor(ctx, `implement:${n}`, 'routine-code', routeSignals(ctx, n));
  let k = Math.max(1, latestAttempt(ctx, `implement:${n}`));
  const cap = capOf(ctx, n);
  for (;;) {
    const purpose = `implement:${n}#${k}`;
    const st = await ensureWorker(ctx, {
      role: 'implementer',
      purpose,
      attempt: n,
      provider: route.provider,
      model: route.model,
      effort: route.effort,
      cwd: ctx.run.worktreePath!,
      readOnly: false,
      prompt: (workerId) => implementerPrompt(ctx, n, workerId),
      maxBudgetUsd: cap,
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
      ctx.ledger!.consume('infrastructure_retries', 1);
      note(ctx, 'worker.retry', { purpose, status: r.status });
      k++;
      continue;
    }
    if (r.status === 'cancelled') {
      const stop = await safePoint(ctx);
      if (stop) return stop;
    }
    if (r.status !== 'succeeded') note(ctx, 'implementation.worker-ended', { attempt: n, status: r.status, error: r.error?.slice(0, 300) ?? null, note: 'its edits are verified like any other' });
    return snapshot(ctx, n, st.worker.id);
  }
}

async function snapshot(ctx: RunContext, n: number, workerId: string): Promise<StepResult> {
  const cand = await snapshotCandidate({ db: ctx.db, clock: ctx.clock, repoRoot: ctx.run.repoRoot, worktree: ctx.run.worktreePath!, runId: ctx.run.id, baseRev: ctx.run.baseRevision!, attempt: n, workerId });
  // Every earlier report and review describes another tree now (spec section 11: invalidate on change).
  invalidateEvidence(ctx.db, ctx.run.id, `attempt ${n} produced candidate ${cand.seq} (tree ${cand.treeHash})`, ctx.clock, { exceptTreeHash: cand.treeHash });
  invalidateStaleReviews(ctx.db, { runId: ctx.run.id, runDir: ctx.runDir, current: { candidateId: cand.id, treeHash: cand.treeHash }, cause: `attempt ${n}` }, ctx.clock);
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, CANDIDATE_EVENT, ctx.ownerId, { attempt: n, candidate_id: cand.id, seq: cand.seq, tree_hash: cand.treeHash, reused: !cand.created }, ctx.clock.now()));
  ctx.candidate = cand;
  progress(ctx, 'candidate', { attempt: n, candidate_id: cand.id, seq: cand.seq, tree_hash: cand.treeHash, reused: !cand.created });
  return move(ctx, 'VERIFYING', `attempt ${n} produced candidate ${cand.seq}${cand.created ? '' : ' (the same tree as an earlier candidate)'}`);
}

function capOf(ctx: RunContext, n: number): number | null {
  const row = ctx.db.get<{ cap: number | null }>("SELECT json_extract(data_json, '$.spend_cap_usd') AS cap FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ? ORDER BY id DESC LIMIT 1", ctx.run.id, ATTEMPT_EVENT, n);
  return typeof row?.cap === 'number' ? row.cap : null;
}

/**
 * Escalation signals from durable records only: equivalent failures (same
 * fingerprint on distinct candidates) with the failure record ids as
 * evidence, and the previous route with its outcome.
 */
function routeSignals(ctx: RunContext, n: number): Parameters<typeof routeFor>[3] {
  const difficulty = (ctx.run.difficulty ?? 'medium') as DifficultyClass;
  const failures = listFailures(ctx.db, ctx.run.id);
  const latest = failures.at(-1) ?? null;
  const same = latest ? failures.filter((f) => f.fingerprint === latest.fingerprint) : [];
  const repeated = new Set(same.map((f) => f.candidateId ?? `row-${f.id}`)).size;
  const evidence = same.map((f) => `failure:${f.id}`);
  const prev = n > 1 ? ctx.db.get<{ data_json: string }>('SELECT data_json FROM decisions WHERE id = ?', `dec-route-${ctx.run.id}-implement_${n - 1}`) : undefined;
  const prevRoute = prev ? (JSON.parse(prev.data_json) as { provider: string; model: string; effort: string | null }) : null;
  return {
    difficulty,
    attempt: n,
    repeatedFingerprints: repeated,
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(prevRoute ? { previousRoute: { provider: prevRoute.provider, model: prevRoute.model, effort: prevRoute.effort, outcome: 'failed' as const, evidence } } : {}),
  };
}

function implementerPrompt(ctx: RunContext, n: number, workerId: string): string {
  const contract = assertContract(ctx);
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
  const task = [
    n === 1 || !stored ? 'Implement the contract below in this worktree.' : `Repair attempt ${n}: act on the repair brief below; change the cause, not the tests that show it.`,
    'Make the smallest coherent change. Add or extend behaviour tests that would fail without it. Stay inside the allowed paths.',
    'Do not commit, push, or edit protected paths, policy, CI configuration or check definitions. The controller snapshots your worktree and runs the trusted checks itself.',
    `Acceptance criteria: ${contract.acceptance_criteria.map((c) => `${c.id}${c.mandatory ? '' : ' (optional)'}: ${c.statement}`).join(' | ')}`,
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

function relative(root: string, p: string): string {
  return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
}
