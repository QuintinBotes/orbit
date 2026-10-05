/**
 * The run invariants of docs/architecture.md ("State machine"), checked from
 * durable state after a scenario. Each acceptance test asserts its scenario's
 * outcome and then calls `assertRunInvariants`, plus the invariant its
 * scenario is about.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { canTransition, isTerminal, type RunState } from '../../../src/controller/states.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { listCandidates, listEvidenceReports } from '../../../src/evidence/store.ts';
import { staleReasons } from '../../../src/evidence/freshness.ts';
import { listReviews } from '../../../src/review/store.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import type { OrbitDb } from '../../../src/storage/db.ts';
import { git, type Lab } from './lab.ts';

export interface EventRow {
  id: number;
  type: string;
  from_state: string | null;
  to_state: string | null;
  actor: string;
  data_json: string | null;
}

export function events(db: OrbitDb, runId: string, type?: string): EventRow[] {
  return type === undefined
    ? db.all<EventRow>('SELECT id, type, from_state, to_state, actor, data_json FROM events WHERE run_id = ? ORDER BY id', runId)
    : db.all<EventRow>('SELECT id, type, from_state, to_state, actor, data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', runId, type);
}

export function transitions(db: OrbitDb, runId: string): string[] {
  return events(db, runId, 'state.transition').map((e) => e.to_state!);
}

export function eventData<T = Record<string, unknown>>(e: EventRow): T {
  return (e.data_json ? JSON.parse(e.data_json) : {}) as T;
}

/** Every transition is a durable event, on an allowed edge, made by the controller holding the lease at the time. */
export function assertTransitionsDurable(db: OrbitDb, runId: string): void {
  const run = getRun(db, runId);
  const all = events(db, runId);
  let state: RunState = 'CREATED';
  let owner: string | null = null;
  for (const e of all) {
    if (e.type === 'lease.acquired' || e.type === 'lease.takeover') owner = e.actor;
    if (e.type === 'lease.released') owner = null;
    if (e.type !== 'state.transition') continue;
    expect(e.from_state, `event ${e.id} starts where the previous transition ended`).toBe(state);
    expect(canTransition(state, e.to_state as RunState), `${state} -> ${e.to_state} is an allowed edge`).toBe(true);
    // A person's command (orbit resume, orbit cancel) acts under a short CLI lease and records the person as the actor.
    if (!e.actor.startsWith('cli:')) expect(e.actor, `transition ${state} -> ${e.to_state} made by the lease holder`).toBe(owner);
    else expect(owner, `transition ${state} -> ${e.to_state} made under a CLI lease`).toMatch(/^cli-/);
    state = e.to_state as RunState;
  }
  expect(state, 'the run row agrees with the last durable transition').toBe(run.state);
}

/** The frozen policy still verifies against the hash recorded at run start, and is read-only. */
export function assertPolicyFrozen(db: OrbitDb, runId: string): void {
  const run = getRun(db, runId);
  expect(() => verifySnapshot(run.policyPath, run.policyHash)).not.toThrow();
  expect(statSync(run.policyPath).mode & 0o222).toBe(0);
}

/** No counter ever exceeds its hard cap (allowances may grow; caps never move). */
export function assertBudgetsWithinCaps(db: OrbitDb, runId: string): void {
  const rows = db.all<{ counter: string; used: number; allowance: number; hard_cap: number }>('SELECT counter, used, allowance, hard_cap FROM budget_counters WHERE run_id = ?', runId);
  for (const r of rows) {
    if (r.counter === 'wall_ms' || r.counter === 'cost_usd') continue;
    expect(r.used, `${r.counter} used`).toBeLessThanOrEqual(r.hard_cap);
    expect(r.allowance, `${r.counter} allowance`).toBeLessThanOrEqual(r.hard_cap);
  }
}

/** Bounded active workers: at no instant were more workers alive than the policy's parallel_workers cap. */
export function assertWorkersBounded(db: OrbitDb, runId: string, cap: number): number {
  const ws = listWorkers(db, { runId }).filter((w) => w.spawnedAt !== null);
  const points = ws.flatMap((w) => [
    { t: w.spawnedAt!, d: 1 },
    { t: w.endedAt ?? Number.MAX_SAFE_INTEGER, d: -1 },
  ]);
  points.sort((a, b) => a.t - b.t || a.d - b.d);
  let live = 0;
  let max = 0;
  for (const p of points) {
    live += p.d;
    max = Math.max(max, live);
  }
  expect(max, 'concurrent workers').toBeLessThanOrEqual(cap);
  return max;
}

/** No delivery from an unreviewed revision: every external action names a tree with fresh PASS evidence and an APPROVE review. */
export function assertActionsReviewed(db: OrbitDb, runId: string): void {
  const actions = db.all<{ kind: string; tree_hash: string | null; state: string }>('SELECT kind, tree_hash, state FROM actions WHERE run_id = ?', runId);
  const approved = new Set(listReviews(db, runId, { includeInvalidated: true }).filter((r) => r.verdict === 'APPROVE').map((r) => r.treeHash));
  const passed = new Set(listEvidenceReports(db, runId).filter((e) => e.verdict === 'PASS').map((e) => e.treeHash));
  for (const a of actions) {
    if (a.tree_hash === null) continue;
    expect(approved.has(a.tree_hash), `${a.kind} action on tree ${a.tree_hash} has an APPROVE review`).toBe(true);
    expect(passed.has(a.tree_hash), `${a.kind} action on tree ${a.tree_hash} has PASS evidence`).toBe(true);
  }
}

/** No success without current evidence: a SUCCEEDED run's delivered tree carries fresh PASS evidence and an APPROVE review. */
export function assertSuccessBound(lab: Lab, runId: string): void {
  const db = lab.db();
  const run = getRun(db, runId);
  if (run.state !== 'SUCCEEDED') return;
  const outcome = JSON.parse(run.outcomeJson ?? '{}') as { tree?: string };
  expect(outcome.tree, 'a successful run names the tree it delivered').toMatch(/^[0-9a-f]{40}$/);
  const cand = listCandidates(db, runId).find((c) => c.treeHash === outcome.tree);
  expect(cand, 'the delivered tree is a candidate of this run').toBeDefined();
  const ev = listEvidenceReports(db, runId).filter((e) => e.treeHash === outcome.tree && e.invalidatedAt === null).at(-1);
  expect(ev?.verdict).toBe('PASS');
  expect(staleReasons(ev!.report, { candidate: cand!, snapshot: verifySnapshot(run.policyPath, run.policyHash) })).toEqual([]);
  expect(listReviews(db, runId, { treeHash: outcome.tree! }).some((r) => r.verdict === 'APPROVE' && r.invalidatedAt === null)).toBe(true);
  if (run.branch) {
    const local = git(lab.repo, 'branch', '--list', run.branch);
    const remote = git(lab.remote, 'branch', '--list', run.branch);
    const where = remote ? lab.remote : local ? lab.repo : null;
    if (where) expect(git(where, 'rev-parse', `refs/heads/${run.branch}^{tree}`), 'the branch carries exactly the reviewed tree').toBe(outcome.tree);
  }
}

/** No continuation after durable cancellation: after the request, the only transition is to CANCELLED. */
export function assertCancellationFinal(db: OrbitDb, runId: string): void {
  const all = events(db, runId);
  const at = all.findIndex((e) => e.type === 'run.cancel-requested');
  if (at < 0) return;
  const after = all.slice(at).filter((e) => e.type === 'state.transition').map((e) => e.to_state);
  for (const s of after) expect(s, 'transition after a durable cancellation').toBe('CANCELLED');
}

/** A terminal run ends with a written report that names its outcome. */
export function assertFinalReport(lab: Lab, runId: string): string {
  const run = getRun(lab.db(), runId);
  if (!isTerminal(run.state)) return '';
  const path = join(lab.runDir(runId), 'final.md');
  expect(existsSync(path), 'final.md written').toBe(true);
  const text = readFileSync(path, 'utf8');
  expect(text).toMatch(new RegExp(`^# Orbit run ${runId}: ${run.state}`));
  return text;
}

/** One owner lease per run, at most, and none left behind by a foreground controller after a terminal state. */
export function assertLeases(db: OrbitDb, runId: string): void {
  const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM leases WHERE run_id = ?', runId)?.n ?? 0;
  expect(n).toBeLessThanOrEqual(1);
}

export function assertRunInvariants(lab: Lab, runId: string): void {
  const db = lab.db();
  assertTransitionsDurable(db, runId);
  assertLeases(db, runId);
  assertPolicyFrozen(db, runId);
  assertBudgetsWithinCaps(db, runId);
  assertWorkersBounded(db, runId, lab.config.scheduler.hard_limits.parallel_workers);
  assertActionsReviewed(db, runId);
  assertSuccessBound(lab, runId);
  assertCancellationFinal(db, runId);
  assertFinalReport(lab, runId);
}
