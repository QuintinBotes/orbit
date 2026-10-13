/**
 * A terminal run releases its checkouts, but never at the cost of work or beneath a process: every implementer checkout
 * of the run (the main one and each parallel unit-* one, found from the worker records) has its unfinished edits pinned
 * in a ref before it is removed, a checkout whose edits could not be pinned is kept, and a checkout a worker may still
 * be writing in (its termination not confirmed) is kept until a later pass confirms it.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { worktreeRootFor } from '../../../src/controller/context.ts';
import { acquireLease, getRun } from '../../../src/controller/run-store.ts';
import { finishRun } from '../../../src/controller/steps/common.ts';
import { processStartTime } from '../../../src/core/proc.ts';
import { materializeCandidate } from '../../../src/evidence/candidate.ts';
import { reconcileOnStart } from '../../../src/recovery/reconcile.ts';
import { pruneExpiredRuns } from '../../../src/storage/retention.ts';
import { finishWorker, getWorker, markWorkerRunning, planWorker } from '../../../src/storage/workers.ts';
import { counters } from '../recovery/helpers.ts';
import { makeUnitLab, OWNER, type UnitLab } from './coverage-helpers.ts';

const DEAD = 2_000_000_000;

let lab: UnitLab | undefined;
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) {
    try {
      process.kill(-k.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  lab?.cleanup();
  lab = undefined;
});

/** A live process in a group of its own, standing in for a worker's provider. */
function sleeper(): { pid: number; start: string } {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  child.unref();
  kids.push(child);
  return { pid: child.pid!, start: processStartTime(child.pid!)! };
}

/** A worker directory whose pid.json names `p`, with a group id that names no group, so nothing can be signalled. */
function unsignallable(dir: string, p: { shimPid: number; shimStart: string | null; childPid?: number; childStart?: string }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pid.json'), JSON.stringify({ version: 1, shimPid: p.shimPid, shimStart: p.shimStart, pgid: DEAD, childPid: p.childPid ?? null, childStart: p.childStart ?? null, sessionId: null, argvHash: 'h', startedAt: 1 }));
}

/** A run whose previous controller died with its recovery attempts spent: the next reconciliation ends it EXHAUSTED. */
async function crashedRunOutOfRecovery(l: UnitLab): Promise<void> {
  counters(l.db, l.runId, { recovery_attempts: 0 });
  l.clock.advance(2 * 3_600_000);
  acquireLease(l.db, l.runId, 'ctl-2', 60_000, l.clock);
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const hasRef = (ref: string): boolean => git(lab!.repo, 'for-each-ref', '--format=%(refname)', ref) === ref;

interface Released {
  removed: string[];
  kept: string[];
  preserved?: { worktree: string; ref: string; commit: string; worker_id: string | null }[];
  retained?: { worktree: string; why: string; cause: string }[];
}
const released = (): Released[] => lab!.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'worktrees.released' ORDER BY id", lab!.runId).map((r) => JSON.parse(r.data_json) as Released);
const final = (): { next_action: string } => JSON.parse(readFileSync(join(lab!.ctx().runDir, 'final.json'), 'utf8')) as { next_action: string };

/** A git repository for the lab with the run's main implementer checkout at the base revision. */
async function repoWithImplementer(l: UnitLab): Promise<{ base: string; root: string; main: string }> {
  mkdirSync(join(l.repo, 'apps'), { recursive: true });
  writeFileSync(join(l.repo, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(l.repo, '.gitignore'), '.orbit/\n*.log\n');
  git(l.repo, 'init', '-q', '-b', 'main');
  git(l.repo, 'add', '-A');
  git(l.repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
  const base = git(l.repo, 'rev-parse', 'HEAD');
  const tree = git(l.repo, 'rev-parse', 'HEAD^{tree}');
  const root = worktreeRootFor(l.home, getRun(l.db, l.runId));
  const main = join(root, 'implementer');
  await materializeCandidate(l.repo, base, main, { readOnly: false });
  l.db.run('UPDATE runs SET base_revision = ?, base_tree = ?, worktree_path = ? WHERE id = ?', base, tree, main, l.runId);
  return { base, root, main };
}

async function unitCheckout(l: UnitLab, root: string, base: string, unit: string): Promise<string> {
  const dir = join(root, `unit-1-${unit}`);
  await materializeCandidate(l.repo, base, dir, { readOnly: false });
  return dir;
}

/** An implementer worker row for `cwd`: finished, or RUNNING under a live pid it cannot verify (no pid.json, no start time). */
function implementer(l: UnitLab, id: string, cwd: string, purpose: string, how: 'finished' | 'unverifiable'): void {
  const workerDir = join(l.base, 'workers', id);
  mkdirSync(workerDir, { recursive: true });
  planWorker(l.db, { id, runId: l.runId, role: 'implementer', purpose, provider: 'claude', workerDir, cwd, attempt: 1 }, l.clock);
  if (how === 'unverifiable') {
    // This test's own pid: alive, and with no recorded start time it cannot be proven to be the worker, so nothing signals it.
    markWorkerRunning(l.db, id, { pid: process.pid, pgid: process.pid, procStart: null }, l.clock);
    return;
  }
  markWorkerRunning(l.db, id, { pid: DEAD, pgid: DEAD, procStart: 'x' }, l.clock);
  finishWorker(l.db, id, { state: 'SUCCEEDED', resultStatus: 'succeeded' }, l.clock);
}

const WALL = 'implementer: the provider kept failing transiently and the wall budget is spent (last: 529)';

describe('a terminal run preserves the unfinished edits of every implementer checkout before removing it', () => {
  it('a dirty parallel unit checkout at exhaustion before integration is pinned in an unsaved ref, then removed', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { base, root, main } = await repoWithImplementer(lab);
    const u1 = await unitCheckout(lab, root, base, 'u1');
    const u2 = await unitCheckout(lab, root, base, 'u2');
    implementer(lab, 'wrk-u1', u1, 'implement:1/u1#1', 'finished');
    implementer(lab, 'wrk-u2', u2, 'implement:1/u2#1', 'finished');
    // Unit u1 edited a tracked file and added one; neither was integrated into the main checkout.
    writeFileSync(join(u1, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
    writeFileSync(join(u1, 'apps', 'mul.mjs'), 'export const mul = (a, b) => a * b;\n');
    writeFileSync(join(u1, 'debug.log'), 'ignored\n');

    await finishRun(lab.ctx(), 'EXHAUSTED', WALL);

    const ref = `refs/orbit/${lab.runId}/unsaved/wrk-u1`;
    expect(hasRef(ref)).toBe(true);
    expect(git(lab.repo, 'show', `${ref}:apps/mul.mjs`)).toContain('mul');
    expect(git(lab.repo, 'show', `${ref}:apps/calc.mjs`)).toContain('sub');
    expect(() => git(lab!.repo, 'cat-file', '-e', `${ref}:debug.log`)).toThrow();
    expect(git(lab.repo, 'rev-parse', `${ref}^`)).toBe(base);
    // A clean unit checkout has nothing to keep.
    expect(hasRef(`refs/orbit/${lab.runId}/unsaved/wrk-u2`)).toBe(false);
    expect(existsSync(u1)).toBe(false);
    expect(existsSync(u2)).toBe(false);
    expect(existsSync(main)).toBe(false);
    const ev = released().at(-1)!;
    expect(ev.kept).toEqual([]);
    expect(ev.preserved).toEqual([expect.objectContaining({ worktree: 'unit-1-u1', ref, worker_id: 'wrk-u1' })]);
    const preserved = lab.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'worktree.preserved'", lab.runId);
    expect(preserved.map((p) => JSON.parse(p.data_json) as { ref: string })).toEqual([expect.objectContaining({ ref })]);
    expect(final().next_action).toContain(ref);
  });

  it('keeps a checkout whose unfinished edits could not be pinned, and says so in the event and the report', async () => {
    if (process.getuid?.() === 0) return; // root reads a mode-000 file, so the snapshot would not fail
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { base, root } = await repoWithImplementer(lab);
    const u1 = await unitCheckout(lab, root, base, 'u1');
    implementer(lab, 'wrk-u1', u1, 'implement:1/u1#1', 'finished');
    const unreadable = join(u1, 'apps', 'secret.mjs');
    writeFileSync(unreadable, 'export const secret = 1;\n');
    chmodSync(unreadable, 0o000);

    await finishRun(lab.ctx(), 'EXHAUSTED', WALL);

    expect(existsSync(u1)).toBe(true);
    expect(hasRef(`refs/orbit/${lab.runId}/unsaved/wrk-u1`)).toBe(false);
    const ev = released().at(-1)!;
    expect(ev.kept).toEqual(['unit-1-u1']);
    expect(ev.retained).toEqual([expect.objectContaining({ worktree: 'unit-1-u1', cause: 'preservation-failed', why: expect.stringMatching(/could not be preserved/) })]);
    expect(existsSync(root)).toBe(true);
    const next = final().next_action;
    expect(next).toContain(u1);
    expect(next).toMatch(/could not be preserved/);
    chmodSync(unreadable, 0o644);
  });

  it('the single-implementer path still releases: the main checkout is saved as a candidate and removed', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { main } = await repoWithImplementer(lab);
    implementer(lab, 'wrk-main', main, 'implement:1#1', 'finished');
    writeFileSync(join(main, 'apps', 'wip.mjs'), 'export const wip = true;\n');

    await finishRun(lab.ctx(), 'CANCELLED', 'cancelled by request');

    const ref = `refs/orbit/${lab.runId}/candidates/1`;
    expect(hasRef(ref)).toBe(true);
    expect(git(lab.repo, 'show', `${ref}:apps/wip.mjs`)).toContain('wip');
    expect(existsSync(main)).toBe(false);
    const ev = released().at(-1)!;
    expect(ev.removed).toEqual(['implementer']);
    expect(ev.kept).toEqual([]);
    expect(ev.preserved).toEqual([expect.objectContaining({ worktree: 'implementer', ref })]);
    expect(final().next_action).toContain(ref);
  });
});

describe('a checkout whose writer may still run is never released', () => {
  it('finishRun keeps the checkout of a worker it could not confirm stopped, and records why', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { main } = await repoWithImplementer(lab);
    implementer(lab, 'wrk-live', main, 'implement:1#1', 'unverifiable');
    writeFileSync(join(main, 'apps', 'wip.mjs'), 'export const wip = true;\n');

    await finishRun(lab.ctx(), 'EXHAUSTED', WALL);

    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    expect(getWorker(lab.db, 'wrk-live').state).toBe('RUNNING');
    expect(existsSync(join(main, 'apps', 'wip.mjs'))).toBe(true);
    // Its edits are not touched while it may still write: no snapshot was taken beneath it.
    expect(hasRef(`refs/orbit/${lab.runId}/candidates/1`)).toBe(false);
    const ev = released().at(-1)!;
    expect(ev.kept).toEqual(['implementer']);
    expect(ev.retained).toEqual([expect.objectContaining({ worktree: 'implementer', cause: 'active-worker', why: expect.stringMatching(/wrk-live.*not confirmed/) })]);
    const next = final().next_action;
    expect(next).toContain(main);
    expect(next).toMatch(/wrk-live/);
    expect(next).toMatch(/released when a run ends, but for the checkouts kept/);
  });

  it('recovery keeps the checkout of an unverified process it left RUNNING, and a later pass releases it once the process is gone', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    counters(lab.db, lab.runId, { recovery_attempts: 0 });
    const { base, root, main } = await repoWithImplementer(lab);
    const u1 = await unitCheckout(lab, root, base, 'u1');
    // The main implementer was lost (its process is gone) and the recovery budget cannot restart it: the run ends EXHAUSTED.
    const lostDir = join(lab.base, 'workers', 'wrk-lost');
    mkdirSync(lostDir, { recursive: true });
    planWorker(lab.db, { id: 'wrk-lost', runId: lab.runId, role: 'implementer', purpose: 'implement:1#1', provider: 'claude', workerDir: lostDir, cwd: main, attempt: 1 }, lab.clock);
    markWorkerRunning(lab.db, 'wrk-lost', { pid: DEAD, pgid: DEAD, procStart: 'x' }, lab.clock);
    // A unit writer whose files are gone and whose recorded process cannot be verified: recovery leaves it RUNNING.
    implementer(lab, 'wrk-u1', u1, 'implement:1/u1#1', 'unverifiable');
    writeFileSync(join(u1, 'apps', 'mul.mjs'), 'export const mul = (a, b) => a * b;\n');

    await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: {}, graceMs: 100, orbitHome: lab.home });

    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    expect(getWorker(lab.db, 'wrk-u1').state).toBe('RUNNING');
    expect(existsSync(u1)).toBe(true);
    expect(existsSync(main)).toBe(false);
    const first = released().at(-1)!;
    expect(first.kept).toEqual(['unit-1-u1']);
    expect(first.retained).toEqual([expect.objectContaining({ worktree: 'unit-1-u1', cause: 'active-worker' })]);

    // Its process is gone now: the next reconciliation confirms it, then preserves the unit's edits and releases the checkout.
    lab.db.run('UPDATE workers SET pid = ?, pgid = ?, proc_start = ? WHERE id = ?', DEAD, DEAD, 'x', 'wrk-u1');
    acquireLease(lab.db, lab.runId, OWNER, 60_000, lab.clock);
    await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: {}, graceMs: 100, orbitHome: lab.home });

    expect(getWorker(lab.db, 'wrk-u1').state).toBe('CANCELLED');
    expect(existsSync(u1)).toBe(false);
    const ref = `refs/orbit/${lab.runId}/unsaved/wrk-u1`;
    expect(git(lab.repo, 'show', `${ref}:apps/mul.mjs`)).toContain('mul');
    expect(released().at(-1)!).toMatchObject({ removed: ['unit-1-u1'], kept: [] });
  });

  it('recovery does not record a running worker stopped when its group could not be signalled, and keeps its checkout', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { main } = await repoWithImplementer(lab);
    const proc = sleeper();
    const dir = join(lab.base, 'workers', 'wrk-run');
    unsignallable(dir, { shimPid: proc.pid, shimStart: proc.start });
    planWorker(lab.db, { id: 'wrk-run', runId: lab.runId, role: 'implementer', purpose: 'implement:1#1', provider: 'claude', workerDir: dir, cwd: main, attempt: 1 }, lab.clock);
    markWorkerRunning(lab.db, 'wrk-run', { pid: proc.pid, pgid: DEAD, procStart: proc.start }, lab.clock);
    writeFileSync(join(main, 'apps', 'wip.mjs'), 'export const wip = true;\n');
    await crashedRunOutOfRecovery(lab);

    await reconcileOnStart({ db: lab.db, ownerId: 'ctl-2', clock: lab.clock, adapters: {}, graceMs: 50, orbitHome: lab.home });

    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    expect(getWorker(lab.db, 'wrk-run').state).toBe('RUNNING');
    expect(existsSync(join(main, 'apps', 'wip.mjs'))).toBe(true);
    expect(released().at(-1)!.retained).toEqual([expect.objectContaining({ worktree: 'implementer', cause: 'active-worker' })]);
  });

  it('recovery does not finish a lost worker whose provider outlived its shim and could not be stopped, and keeps its checkout', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { main } = await repoWithImplementer(lab);
    const proc = sleeper();
    const dir = join(lab.base, 'workers', 'wrk-orphan');
    unsignallable(dir, { shimPid: DEAD, shimStart: 'x', childPid: proc.pid, childStart: proc.start });
    planWorker(lab.db, { id: 'wrk-orphan', runId: lab.runId, role: 'implementer', purpose: 'implement:1#1', provider: 'claude', workerDir: dir, cwd: main, attempt: 1 }, lab.clock);
    markWorkerRunning(lab.db, 'wrk-orphan', { pid: DEAD, pgid: DEAD, procStart: 'x' }, lab.clock);
    await crashedRunOutOfRecovery(lab);

    await reconcileOnStart({ db: lab.db, ownerId: 'ctl-2', clock: lab.clock, adapters: {}, graceMs: 50, orbitHome: lab.home });

    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    expect(getWorker(lab.db, 'wrk-orphan').state).toBe('RUNNING');
    expect(existsSync(main)).toBe(true);
    expect(released().at(-1)!.retained).toEqual([expect.objectContaining({ worktree: 'implementer', cause: 'active-worker' })]);
  });

  it('orbit gc does not prune a finished run while a worker of it is still active', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { main } = await repoWithImplementer(lab);
    implementer(lab, 'wrk-live', main, 'implement:1#1', 'unverifiable');
    await finishRun(lab.ctx(), 'EXHAUSTED', WALL);
    lab.db.run('DELETE FROM leases WHERE run_id = ?', lab.runId);
    lab.clock.advance(60_000);

    const out = await pruneExpiredRuns(lab.db, { repoRoot: lab.repo, keepDays: 0, clock: lab.clock, orbitHome: lab.home });

    expect(out.pruned).toEqual([]);
    expect(out.skipped).toEqual([expect.objectContaining({ runId: lab.runId, reason: expect.stringMatching(/wrk-live/) })]);
    expect(existsSync(main)).toBe(true);
  });
});
