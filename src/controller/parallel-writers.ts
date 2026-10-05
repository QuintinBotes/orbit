/**
 * Parallel writers within one run (spec section 8, agent scheduling; docs/gaps.md G14).
 *
 * "Spawn extra workers only for bounded independent units... Writers never share a mutable worktree. Integrate
 * changes serially, then invalidate affected evidence."
 *
 * When a fresh implementation attempt can be split (the planner mapped every criterion to files, the criteria
 * form at least two units with disjoint owned paths, and the policy asks for parallelism), each unit gets its
 * own implementer in its own worktree created at the base revision. Units are admitted by the scheduler like
 * any other work: the run's parallelism and parallel_workers, the machine's CPU and memory, rate-limit
 * backoff, the budget, and the merge overhead a writer beside another writer costs.
 *
 * A finished unit is integrated into the run's worktree on its own, one at a time: the files it changed are
 * copied over (or deleted), and every evidence report of the run is invalidated. A unit whose changes touch a
 * file the integrated work already changed is a conflict: its work is dropped and its criteria go to one
 * serial implementer that continues on top of the integrated tree. So does a unit whose session did not finish
 * (lost, cancelled, a transient failure) or that the budget cannot admit while nothing else runs. The attempt
 * then becomes one candidate like any other, verified as a whole.
 *
 * State is durable events, so a restarted controller resumes exactly: the unit plan (`implementation.units`,
 * recorded with the attempt), the integration intent and result per unit, and each serialized unit.
 */
import { copyFileSync, lstatSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { appendEvent } from '../storage/events.ts';
import type { WorkerRecord } from '../storage/workers.ts';
import { git } from '../evidence/git.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../evidence/candidate.ts';
import { invalidateEvidence } from '../evidence/freshness.ts';
import { budgetAdmission } from '../scheduling/scheduler.ts';
import type { WorkUnit } from '../scheduling/types.ts';
import { planWorkUnits, type WorkUnitPlan } from '../scheduling/work-units.ts';
import type { GoalContract } from '../contract/types.ts';
import { machineAdmission, runWorktreeRoot, schedulerFor, type RunContext } from './context.ts';
import { blockingQuestions } from './gates.ts';
import { ensureWorker, recordSpendCap, sessionSpendCap, workersFor, type RouteChoice } from './workers.ts';
import { storedPlan } from './steps/contracting.ts';
import { blockOnAuth, decide, note, safePoint, WAIT, type StepResult } from './steps/common.ts';

export const UNITS_EVENT = 'implementation.units';
export const UNIT_INTEGRATING_EVENT = 'implementation.unit-integrating';
export const UNIT_INTEGRATED_EVENT = 'implementation.unit-integrated';
export const UNIT_SERIALIZED_EVENT = 'implementation.unit-serialized';
export const MERGE_OVERHEAD_EVENT = 'scheduler.merge-overhead';

/**
 * The work units for a fresh attempt, or null to keep one writer. Supervised runs keep one writer: their
 * implementer's denied operations are asked about session by session (controller/authorization).
 */
export function splitAttempt(ctx: RunContext, contract: GoalContract, fresh: boolean): WorkUnitPlan[] | null {
  if (!fresh || ctx.run.mode === 'supervised') return null;
  if (ctx.snapshot.config.agents.default_parallelism < 2) return null;
  const plan = storedPlan(ctx);
  if (!plan || plan.criteria.length !== contract.acceptance_criteria.length) return null;
  // Criteria waiting for a person's decision are left to one writer that knows what is blocked.
  if (blockingQuestions(ctx.db, ctx.run.id).criteria.length > 0) return null;
  return planWorkUnits(contract.acceptance_criteria.map((c, i) => ({ id: c.id, paths: plan.criteria[i]!.changes.map((x) => x.path) })));
}

/** The unit plan recorded with attempt `n`, or null when the attempt has one writer. */
export function recordedUnits(ctx: RunContext, n: number): WorkUnitPlan[] | null {
  const row = ctx.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ? ORDER BY id LIMIT 1", ctx.run.id, UNITS_EVENT, n);
  return row ? ((JSON.parse(row.data_json) as { units: WorkUnitPlan[] }).units ?? null) : null;
}

export interface SerializedUnit {
  attempt: number;
  unit: string;
  criteria: string[];
  reason: string;
}

/** Units of attempt `n` whose work was dropped for the serial implementer, with why. */
export function serializedUnits(ctx: RunContext, n: number): SerializedUnit[] {
  return unitEvents<SerializedUnit>(ctx, UNIT_SERIALIZED_EVENT, n);
}

export function unitPurpose(n: number, u: Pick<WorkUnitPlan, 'id'>): string {
  return `implement:${n}/${u.id}#1`;
}

export function unitWorktree(ctx: RunContext, n: number, u: Pick<WorkUnitPlan, 'id'>): string {
  return join(runWorktreeRoot(ctx), `unit-${n}-${u.id}`);
}

export interface ParallelOptions {
  route: RouteChoice;
  contract: GoalContract;
  /** The prompt of a unit's implementer. */
  prompt: (unit: WorkUnitPlan, all: readonly WorkUnitPlan[], workerId: string) => string;
  /** Every live unit of the repository, for admission (implementing.runningUnits). */
  running: () => { runId: string; unit: WorkUnit }[];
  maxTurns: number;
}

export type ParallelOutcome = { kind: 'step'; result: StepResult } | { kind: 'done'; workerId: string } | { kind: 'serialize'; units: SerializedUnit[] };

interface IntegratedUnit {
  attempt: number;
  unit: string;
  worker_id: string;
  paths: string[];
}

/** One pass over attempt `n`'s units: integrate what finished, start what is admitted, and say what is left. */
export async function runParallelUnits(ctx: RunContext, n: number, units: readonly WorkUnitPlan[], opts: ParallelOptions): Promise<ParallelOutcome> {
  const settled = (): Set<string> => new Set([...unitEvents<IntegratedUnit>(ctx, UNIT_INTEGRATED_EVENT, n).map((e) => e.unit), ...serializedUnits(ctx, n).map((e) => e.unit)]);

  // 1. Collect finished units and integrate them, one at a time.
  for (const u of units) {
    if (settled().has(u.id)) continue;
    const existing = workersFor(ctx, unitPurpose(n, u)).at(-1);
    if (!existing) continue;
    const st = await ensureWorker(ctx, request(ctx, n, u, units, opts));
    if (st.status === 'running') continue;
    const r = st.result;
    if (r.status === 'auth_failed') return { kind: 'step', result: await blockOnAuth(ctx, st.worker.provider, 'auth_failed', r.error) };
    if (r.status === 'cancelled') {
      const stop = await safePoint(ctx);
      if (stop) return { kind: 'step', result: stop };
    }
    if (r.status === 'transient_error' || r.status === 'cancelled' || r.status === 'lost') {
      await serialize(ctx, n, u, `its session ended ${r.status}${r.error ? ` (${r.error.slice(0, 200)})` : ''}`);
      continue;
    }
    await integrate(ctx, n, u, st.worker);
  }

  // 2. Admit and start the units that have not started.
  const done = settled();
  const waiting = units.filter((u) => !done.has(u.id) && workersFor(ctx, unitPurpose(n, u)).length === 0);
  const active = units.filter((u) => !done.has(u.id) && workersFor(ctx, unitPurpose(n, u)).length > 0);
  if (waiting.length > 0) {
    const started = await admitAndStart(ctx, n, units, waiting, opts);
    if (started.count === 0 && active.length === 0) {
      // Nothing of this attempt runs and nothing more is admitted now. Capacity held by other runs clears by
      // waiting; a budget that cannot fund another parallel writer does not, so the rest goes to one writer.
      if (!started.budget) return { kind: 'step', result: WAIT(`work units of attempt ${n} deferred: ${started.why}`) };
      for (const u of waiting) await serialize(ctx, n, u, `not admitted as a parallel writer: ${started.why}`);
    }
  }

  // 3. All settled: one candidate from the integrated tree, or the serial writer for what was dropped.
  const now = settled();
  if (units.every((u) => now.has(u.id))) {
    for (const u of units) await removeWorktree(ctx, n, u);
    const dropped = serializedUnits(ctx, n);
    if (dropped.length > 0) return { kind: 'serialize', units: dropped };
    const last = unitEvents<IntegratedUnit>(ctx, UNIT_INTEGRATED_EVENT, n).at(-1)!;
    return { kind: 'done', workerId: last.worker_id };
  }
  const running = units.filter((u) => !now.has(u.id)).map((u) => u.id);
  return { kind: 'step', result: WAIT(`attempt ${n}: work units ${running.join(', ')} are running in their own worktrees`) };
}

function request(ctx: RunContext, n: number, u: WorkUnitPlan, all: readonly WorkUnitPlan[], opts: ParallelOptions): Parameters<typeof ensureWorker>[1] {
  const purpose = unitPurpose(n, u);
  const cap = ctx.db.get<{ cap: number | null }>("SELECT json_extract(data_json, '$.cap_usd') AS cap FROM events WHERE run_id = ? AND type = 'worker.spend-cap' AND json_extract(data_json, '$.purpose') = ? ORDER BY id DESC LIMIT 1", ctx.run.id, purpose);
  return {
    role: 'implementer',
    purpose,
    attempt: n,
    provider: opts.route.provider,
    model: opts.route.model,
    effort: opts.route.effort,
    cwd: unitWorktree(ctx, n, u),
    readOnly: false,
    prompt: (workerId) => opts.prompt(u, all, workerId),
    maxBudgetUsd: typeof cap?.cap === 'number' ? cap.cap : null,
    ownedPaths: u.ownedPaths,
  };
}

async function admitAndStart(ctx: RunContext, n: number, all: readonly WorkUnitPlan[], waiting: readonly WorkUnitPlan[], opts: ParallelOptions): Promise<{ kind: 'started'; count: number; why: string; budget: boolean }> {
  const running = opts.running();
  const own = running.filter((r) => r.runId === ctx.run.id).map((r) => r.unit);
  const pending: WorkUnit[] = waiting.map((u) => ({
    id: unitPurpose(n, u).replace(/#1$/, ''),
    role: 'implementer',
    writer: true,
    ownedPaths: u.ownedPaths,
    dependsOn: [],
    revision: null,
    cancelWhen: [],
    budget: { costUsd: null, wallMs: null, maxTurns: opts.maxTurns },
    provider: opts.route.provider,
    worktree: unitWorktree(ctx, n, u),
    status: 'pending',
  }));
  const plan = schedulerFor(ctx).plan([...own, ...pending], { admit: budgetAdmission(ctx.ledger!), parallelism: ctx.snapshot.config.agents.default_parallelism });
  const admitted = plan.start.filter((s) => pending.some((p) => p.id === s.id));
  const machine = admitted.length > 0 ? machineAdmission(ctx, running.map((r) => r.unit), admitted) : null;
  let count = 0;
  let unfunded = false;
  // The spend left for sessions is shared by the units still to start: a session's cap is otherwise all of it,
  // and the first writer would leave nothing for the others.
  const total = sessionSpendCap(ctx, opts.route.model, 'implementer');
  const share = total.capUsd === null ? null : Math.floor((total.capUsd / waiting.length) * 100) / 100;
  for (const unit of admitted) {
    if (machine && !machine.start.has(unit.id)) continue;
    const u = waiting.find((w) => unitPurpose(n, w).startsWith(`${unit.id}#`))!;
    const cap = { capUsd: share, worstCaseUsd: total.worstCaseUsd };
    if (cap.capUsd !== null && cap.capUsd <= 0) {
      unfunded = true;
      continue;
    }
    const merge = plan.merge_overhead.find((m) => m.id === unit.id);
    if (merge) note(ctx, MERGE_OVERHEAD_EVENT, { attempt: n, unit: u.id, alongside: merge.alongside, usd: merge.usd });
    if (cap.capUsd !== null) recordSpendCap(ctx, unitPurpose(n, u), cap.capUsd, cap.worstCaseUsd);
    const dir = unitWorktree(ctx, n, u);
    if (!existsSync(dir)) await materializeCandidate(ctx.run.repoRoot, ctx.run.baseRevision!, dir, { readOnly: false });
    await ensureWorker(ctx, request(ctx, n, u, all, opts));
    count++;
  }
  const deferred = plan.deferred.filter((d) => pending.some((p) => p.id === d.id)).map((d) => d.reason);
  const reasons = [...deferred, ...(machine ? [...machine.deferred.values()] : []), ...(unfunded ? ['no model budget left for another session'] : [])];
  const budget = unfunded || deferred.some((r) => /^not admitted by budget/.test(r));
  return { kind: 'started', count, why: reasons[0] ?? 'not admitted', budget };
}

/**
 * Integrate a finished unit into the run's worktree: the files it changed against the base, copied (or deleted)
 * one by one. A path the integrated work already changed is a conflict and serializes the unit. The intent is
 * recorded before the copy, so a crash mid-copy finishes the same copy rather than seeing its own files as a
 * conflict.
 */
async function integrate(ctx: RunContext, n: number, u: WorkUnitPlan, w: WorkerRecord): Promise<void> {
  const target = ctx.run.worktreePath!;
  const source = w.cwd;
  const intent = unitEvents<IntegratedUnit>(ctx, UNIT_INTEGRATING_EVENT, n).find((e) => e.unit === u.id);
  let paths: string[];
  if (intent) paths = intent.paths;
  else {
    paths = await changedFiles(source);
    const busy = new Set(await changedFiles(target));
    const clash = paths.filter((p) => busy.has(p));
    if (clash.length > 0) {
      await serialize(ctx, n, u, `conflict: ${clash.slice(0, 10).join(', ')} already changed by integrated work`);
      await removeWorktree(ctx, n, u);
      return;
    }
    note(ctx, UNIT_INTEGRATING_EVENT, { attempt: n, unit: u.id, worker_id: w.id, paths } satisfies IntegratedUnit);
  }
  for (const p of paths) copyPath(source, target, p);
  note(ctx, UNIT_INTEGRATED_EVENT, { attempt: n, unit: u.id, worker_id: w.id, paths } satisfies IntegratedUnit);
  // The run's tree changed: every evidence report describes another tree now (spec section 11).
  invalidateEvidence(ctx.db, ctx.run.id, `work unit ${u.id} of attempt ${n} integrated (${paths.length} file(s))`, ctx.clock);
  await removeWorktree(ctx, n, u);
}

async function serialize(ctx: RunContext, n: number, u: WorkUnitPlan, reason: string): Promise<void> {
  if (serializedUnits(ctx, n).some((s) => s.unit === u.id)) return;
  note(ctx, UNIT_SERIALIZED_EVENT, { attempt: n, unit: u.id, criteria: u.criteria, reason } satisfies SerializedUnit);
  decide(ctx, { id: `dec-${ctx.run.id}-serialize-${n}-${u.id}`, kind: 'scheduling.serialize', summary: `work unit ${u.id} (${u.criteria.join(', ')}) of attempt ${n} goes to the serial implementer: ${reason}`, data: { attempt: n, unit: u.id, criteria: u.criteria, reason } });
}

async function removeWorktree(ctx: RunContext, n: number, u: WorkUnitPlan): Promise<void> {
  const dir = unitWorktree(ctx, n, u);
  if (existsSync(dir)) await cleanupCandidateCheckout(ctx.run.repoRoot, dir).catch(() => {});
}

/** Files changed or added in a checkout against its HEAD (the base revision), repository-relative; ignored files excluded. */
async function changedFiles(dir: string): Promise<string[]> {
  const out = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  return out
    .split('\0')
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3))
    .sort();
}

function copyPath(source: string, target: string, rel: string): void {
  const from = resolve(source, rel);
  const to = resolve(target, rel);
  if (!inside(from, source) || !inside(to, target)) return;
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(from);
  } catch {
    st = null;
  }
  rmSync(to, { force: true });
  if (st === null) return;
  mkdirSync(dirname(to), { recursive: true });
  if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else if (st.isFile()) {
    copyFileSync(from, to);
    chmodSync(to, statSync(from).mode & 0o777);
  }
}

function inside(p: string, root: string): boolean {
  return p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function unitEvents<T>(ctx: RunContext, type: string, n: number): T[] {
  return ctx.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ? ORDER BY id", ctx.run.id, type, n).map((r) => JSON.parse(r.data_json) as T);
}

/** Record the unit plan with the attempt, in the caller's transaction. */
export function recordUnits(ctx: RunContext, n: number, units: readonly WorkUnitPlan[]): void {
  appendEvent(ctx.db, ctx.run.id, UNITS_EVENT, ctx.ownerId, { attempt: n, units }, ctx.clock.now());
}
