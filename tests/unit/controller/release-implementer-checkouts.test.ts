/**
 * A run that ends SUCCEEDED or CANCELLED releases its checkouts (EXHAUSTED and IMPOSSIBLE keep theirs, on record, until
 * orbit gc removes them after retention), but never at the cost of work or beneath a process: every implementer checkout
 * of the run (the main one and each parallel unit-* one, found from the worker records) has its unfinished edits pinned
 * in a ref before it is removed, a checkout whose edits could not be pinned is kept, and a checkout a worker may still
 * be writing in (its termination not confirmed) is kept until a later pass confirms it.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { worktreeRootFor } from '../../../src/controller/context.ts';
import { writeFinalReport } from '../../../src/controller/report.ts';
import { acquireLease, getRun, transition } from '../../../src/controller/run-store.ts';
import { finishRun } from '../../../src/controller/steps/common.ts';
import { WORKTREE_PRESERVED_EVENT } from '../../../src/controller/worktree-cleanup.ts';
import { processStartTime } from '../../../src/core/proc.ts';
import { materializeCandidate, snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { reconcileOnStart } from '../../../src/recovery/reconcile.ts';
import { appendEvent } from '../../../src/storage/events.ts';
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
const CANCEL = 'cancelled by request';
const retainedEvents = (): { worktrees: string[] }[] => lab!.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'worktrees.retained' ORDER BY id", lab!.runId).map((r) => JSON.parse(r.data_json) as { worktrees: string[] });

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

    await finishRun(lab.ctx(), 'CANCELLED', CANCEL);

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

    await finishRun(lab.ctx(), 'CANCELLED', CANCEL);

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

  it('a SUCCEEDED run does not call its own reviewed candidate unfinished edits', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING'] });
    const { base, main } = await repoWithImplementer(lab);
    implementer(lab, 'wrk-main', main, 'implement:1#1', 'finished');
    writeFileSync(join(main, 'apps', 'mul.mjs'), 'export const mul = (a, b) => a * b;\n');
    await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: main, runId: lab.runId, baseRev: base, attempt: 1, workerId: 'wrk-main' });

    await finishRun(lab.ctx(), 'SUCCEEDED', 'all mandatory requirements hold');

    const ref = `refs/orbit/${lab.runId}/candidates/1`;
    expect(released().at(-1)!.preserved).toEqual([expect.objectContaining({ worktree: 'implementer', ref })]);
    expect(final().next_action).toContain(ref);
    expect(final().next_action).not.toMatch(/Unfinished edits/);
  });
});

describe('a retained run that orbit gc pruned', () => {
  // Regression (review): the report merged the last retention with the last release, so after orbit gc removed an
  // EXHAUSTED run's retained checkouts, a rebuilt report still listed them as kept and still called them preserved.
  it('reports neither kept checkouts nor a preserved worktree once orbit gc has removed them', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { root, main } = await repoWithImplementer(lab);
    implementer(lab, 'wrk-main', main, 'implement:1#1', 'finished');
    await finishRun(lab.ctx(), 'EXHAUSTED', WALL);
    expect(retainedEvents()).toHaveLength(1);
    lab.db.run('DELETE FROM leases WHERE run_id = ?', lab.runId);
    lab.clock.advance(60_000);

    const out = await pruneExpiredRuns(lab.db, { repoRoot: lab.repo, keepDays: 0, clock: lab.clock, orbitHome: lab.home });
    expect(out.pruned.map((p) => p.runId)).toEqual([lab.runId]);
    expect(existsSync(root)).toBe(false);

    // orbit report rebuilds the report of a pruned run from its record.
    const runDir = join(lab.repo, '.orbit', 'runs', lab.runId);
    mkdirSync(runDir, { recursive: true });
    writeFinalReport(lab.db, lab.runId, { runDir, clock: lab.clock, snapshot: null });
    const report = JSON.parse(readFileSync(join(runDir, 'final.json'), 'utf8')) as { next_action: string; worktrees?: { retained: unknown[] } };
    expect(report.worktrees?.retained ?? []).toEqual([]);
    expect(report.next_action).not.toMatch(/worktree and evidence are preserved/);
    expect(report.next_action).toMatch(/orbit gc removed/);
  });
});

describe('a tracked edit is work, wherever it lies', () => {
  // Regression (review): the noise filter (node_modules/, .DS_Store) applied to tracked modifications too, so a checkout
  // whose only change was a tracked file under node_modules/ read as clean and was removed without being saved.
  it('a tracked edit under a path the noise filter excludes is saved before the release', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    mkdirSync(join(lab.repo, 'node_modules', 'vendor'), { recursive: true });
    writeFileSync(join(lab.repo, 'node_modules', 'vendor', 'index.js'), 'module.exports = 1;\n');
    const { main } = await repoWithImplementer(lab);
    implementer(lab, 'wrk-main', main, 'implement:1#1', 'finished');
    writeFileSync(join(main, 'node_modules', 'vendor', 'index.js'), 'module.exports = 2;\n');

    await finishRun(lab.ctx(), 'CANCELLED', CANCEL);

    const ref = `refs/orbit/${lab.runId}/candidates/1`;
    expect(git(lab.repo, 'show', `${ref}:node_modules/vendor/index.js`)).toContain('2');
    expect(existsSync(main)).toBe(false);
  });
});

describe('a checkout whose writer may still run is never released', () => {
  it('finishRun keeps the checkout of a worker it could not confirm stopped, and records why', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { main } = await repoWithImplementer(lab);
    implementer(lab, 'wrk-live', main, 'implement:1#1', 'unverifiable');
    writeFileSync(join(main, 'apps', 'wip.mjs'), 'export const wip = true;\n');

    await finishRun(lab.ctx(), 'CANCELLED', CANCEL);

    expect(getRun(lab.db, lab.runId).state).toBe('CANCELLED');
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
    expect(next).toMatch(/A checkout was kept: /);
  });

  it('recovery that ends a run EXHAUSTED keeps its checkouts on record and an unverified process RUNNING; orbit gc pins and removes them once it is gone', async () => {
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
    expect(existsSync(main)).toBe(true);
    expect(released()).toEqual([]);
    expect(retainedEvents().at(-1)!.worktrees).toEqual(expect.arrayContaining(['implementer', 'unit-1-u1']));

    // Its process is gone now: the next reconciliation confirms it, and the checkouts stay on record until orbit gc,
    // which pins the unit's unfinished edits before it removes anything.
    lab.db.run('UPDATE workers SET pid = ?, pgid = ?, proc_start = ? WHERE id = ?', DEAD, DEAD, 'x', 'wrk-u1');
    acquireLease(lab.db, lab.runId, OWNER, 60_000, lab.clock);
    await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: {}, graceMs: 100, orbitHome: lab.home });

    expect(getWorker(lab.db, 'wrk-u1').state).toBe('CANCELLED');
    expect(existsSync(u1)).toBe(true);
    lab.db.run('DELETE FROM leases WHERE run_id = ?', lab.runId);
    lab.clock.advance(60_000);
    const out = await pruneExpiredRuns(lab.db, { repoRoot: lab.repo, keepDays: 0, clock: lab.clock, orbitHome: lab.home });
    expect(out.pruned.map((p) => p.runId)).toEqual([lab.runId]);
    const ref = `refs/orbit/${lab.runId}/unsaved/wrk-u1`;
    expect(git(lab.repo, 'show', `${ref}:apps/mul.mjs`)).toContain('mul');
    expect(existsSync(u1)).toBe(false);
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
    expect(released()).toEqual([]);
    expect(retainedEvents().at(-1)!.worktrees).toContain('implementer');
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
    expect(released()).toEqual([]);
    expect(retainedEvents().at(-1)!.worktrees).toContain('implementer');
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

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The run ends with nothing released, as when its controller died between the terminal transition and the release. */
function endedWithoutRelease(l: UnitLab): void {
  transition(l.db, { runId: l.runId, to: 'CANCELLED', ownerId: OWNER, reason: CANCEL }, l.clock);
}

describe('a release a crash or a failure interrupted is resumed, and orbit gc never deletes unpinned work', () => {
  it('a controller start after a crash between the terminal transition and the release releases the run, its unit edits pinned first', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { base, root } = await repoWithImplementer(lab);
    const u1 = await unitCheckout(lab, root, base, 'u1');
    implementer(lab, 'wrk-u1', u1, 'implement:1/u1#1', 'finished');
    writeFileSync(join(u1, 'apps', 'mul.mjs'), 'export const mul = (a, b) => a * b;\n');
    endedWithoutRelease(lab);
    // The dead controller's lease has expired by the time the next one starts.
    lab.clock.advance(2 * 3_600_000);

    await reconcileOnStart({ db: lab.db, ownerId: 'ctl-2', clock: lab.clock, adapters: {}, graceMs: 50, orbitHome: lab.home });

    const ref = `refs/orbit/${lab.runId}/unsaved/wrk-u1`;
    expect(git(lab.repo, 'show', `${ref}:apps/mul.mjs`)).toContain('mul');
    expect(existsSync(u1)).toBe(false);
    expect(existsSync(root)).toBe(false);
    expect(released()).toEqual([expect.objectContaining({ removed: expect.arrayContaining(['unit-1-u1', 'implementer']), kept: [] })]);
    // The report written after that start names the pinned ref.
    writeFinalReport(lab.db, lab.runId, { runDir: lab.ctx().runDir, clock: lab.clock, snapshot: null });
    expect(final().next_action).toContain(ref);
  });

  it('a controller start leaves the release to the controller that still holds the run lease', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { base, root } = await repoWithImplementer(lab);
    const u1 = await unitCheckout(lab, root, base, 'u1');
    implementer(lab, 'wrk-u1', u1, 'implement:1/u1#1', 'finished');
    writeFileSync(join(u1, 'apps', 'mul.mjs'), 'export const mul = (a, b) => a * b;\n');
    // The owner is between the transition and its own release, and its lease is live.
    endedWithoutRelease(lab);

    await reconcileOnStart({ db: lab.db, ownerId: 'ctl-2', clock: lab.clock, adapters: {}, graceMs: 50, orbitHome: lab.home });

    expect(existsSync(u1)).toBe(true);
    expect(released()).toEqual([]);
  });

  it('the report names an edit a release pinned before it failed, though no release completed', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    endedWithoutRelease(lab);
    const ref = `refs/orbit/${lab.runId}/unsaved/wrk-u1`;
    lab.db.tx(() => appendEvent(lab!.db, lab!.runId, WORKTREE_PRESERVED_EVENT, OWNER, { worktree: 'unit-1-u1', ref, commit: 'c'.repeat(40), worker_id: 'wrk-u1' }, lab!.clock.now()));

    writeFinalReport(lab.db, lab.runId, { runDir: lab.ctx().runDir, clock: lab.clock, snapshot: null });

    const report = JSON.parse(readFileSync(join(lab.ctx().runDir, 'final.json'), 'utf8')) as { next_action: string; worktrees?: { preserved: { ref: string }[] } };
    expect(report.worktrees?.preserved).toEqual([{ worktree: 'unit-1-u1', ref }]);
    expect(report.next_action).toContain(`unit-1-u1 at ${ref}`);
  });

  it('orbit gc pins the unfinished edits of a run whose release never ran before it removes anything', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { base, root, main } = await repoWithImplementer(lab);
    const u1 = await unitCheckout(lab, root, base, 'u1');
    implementer(lab, 'wrk-u1', u1, 'implement:1/u1#1', 'finished');
    implementer(lab, 'wrk-main', main, 'implement:1#1', 'finished');
    writeFileSync(join(u1, 'apps', 'mul.mjs'), 'export const mul = (a, b) => a * b;\n');
    writeFileSync(join(main, 'apps', 'wip.mjs'), 'export const wip = true;\n');
    endedWithoutRelease(lab);
    lab.db.run('DELETE FROM leases WHERE run_id = ?', lab.runId);
    lab.clock.advance(60_000);

    const out = await pruneExpiredRuns(lab.db, { repoRoot: lab.repo, keepDays: 0, clock: lab.clock, orbitHome: lab.home });

    expect(out.pruned.map((p) => p.runId)).toEqual([lab.runId]);
    expect(git(lab.repo, 'show', `refs/orbit/${lab.runId}/unsaved/wrk-u1:apps/mul.mjs`)).toContain('mul');
    expect(git(lab.repo, 'show', `refs/orbit/${lab.runId}/candidates/1:apps/wip.mjs`)).toContain('wip');
    expect(existsSync(root)).toBe(false);
    expect(released()).toEqual([expect.objectContaining({ kept: [] })]);
  });

  it('orbit gc keeps a run whose checkout could not be pinned, and says why', async () => {
    if (process.getuid?.() === 0) return; // root reads a mode-000 file, so the snapshot would not fail
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { base, root } = await repoWithImplementer(lab);
    const u1 = await unitCheckout(lab, root, base, 'u1');
    implementer(lab, 'wrk-u1', u1, 'implement:1/u1#1', 'finished');
    writeFileSync(join(u1, 'apps', 'mul.mjs'), 'export const mul = (a, b) => a * b;\n');
    const unreadable = join(u1, 'apps', 'secret.mjs');
    writeFileSync(unreadable, 'export const secret = 1;\n');
    chmodSync(unreadable, 0o000);
    await finishRun(lab.ctx(), 'CANCELLED', CANCEL);
    expect(released().at(-1)!.retained).toEqual([expect.objectContaining({ worktree: 'unit-1-u1', cause: 'preservation-failed' })]);
    lab.db.run('DELETE FROM leases WHERE run_id = ?', lab.runId);
    lab.clock.advance(60_000);

    const out = await pruneExpiredRuns(lab.db, { repoRoot: lab.repo, keepDays: 0, clock: lab.clock, orbitHome: lab.home });

    expect(out.pruned).toEqual([]);
    expect(out.skipped).toEqual([expect.objectContaining({ runId: lab.runId, reason: expect.stringMatching(/unit-1-u1.*could not be preserved/) })]);
    expect(existsSync(join(u1, 'apps', 'mul.mjs'))).toBe(true);
    expect(existsSync(lab.ctx().runDir)).toBe(true);
    chmodSync(unreadable, 0o644);
  });
});

describe('an implementer that committed in its checkout', () => {
  const commitAll = (dir: string, message: string): string => {
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=w', '-c', 'user.email=w@example.invalid', 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };

  it('a unit checkout: the commit only its HEAD held is pinned before the checkout is removed', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { base, root } = await repoWithImplementer(lab);
    const u1 = await unitCheckout(lab, root, base, 'u1');
    implementer(lab, 'wrk-u1', u1, 'implement:1/u1#1', 'finished');
    writeFileSync(join(u1, 'apps', 'mul.mjs'), 'export const mul = (a, b) => a * b;\n');
    const sha = commitAll(u1, 'unit work');

    await finishRun(lab.ctx(), 'CANCELLED', CANCEL);

    const ref = `refs/orbit/${lab.runId}/unsaved/wrk-u1`;
    expect(git(lab.repo, 'show', `${ref}:apps/mul.mjs`)).toContain('mul');
    expect(git(lab.repo, 'for-each-ref', '--contains', sha, '--format=%(refname)')).toContain(ref);
    expect(existsSync(u1)).toBe(false);
  });

  it('the main checkout: committed work is saved as a candidate before the checkout is removed', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { main } = await repoWithImplementer(lab);
    implementer(lab, 'wrk-main', main, 'implement:1#1', 'finished');
    writeFileSync(join(main, 'apps', 'mul.mjs'), 'export const mul = (a, b) => a * b;\n');
    commitAll(main, 'main work');
    const tree = git(main, 'rev-parse', 'HEAD^{tree}');

    await finishRun(lab.ctx(), 'CANCELLED', 'cancelled by request');

    const ref = `refs/orbit/${lab.runId}/candidates/1`;
    expect(git(lab.repo, 'rev-parse', `${ref}^{tree}`)).toBe(tree);
    expect(existsSync(main)).toBe(false);
  });

  it('a clean checkout whose HEAD a candidate ref already holds gains no new ref', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { base, main } = await repoWithImplementer(lab);
    implementer(lab, 'wrk-main', main, 'implement:1#1', 'finished');
    writeFileSync(join(main, 'apps', 'mul.mjs'), 'export const mul = (a, b) => a * b;\n');
    const cand = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: main, runId: lab.runId, baseRev: base, attempt: 1, workerId: null });
    // As after a CI rebase: the run's worktree moved onto the candidate.
    git(main, 'reset', '-q', '--hard', cand.commitSha);

    await finishRun(lab.ctx(), 'CANCELLED', 'cancelled by request');

    expect(git(lab.repo, 'for-each-ref', '--format=%(refname)', `refs/orbit/${lab.runId}/`)).toBe(`refs/orbit/${lab.runId}/candidates/1`);
    expect(released().at(-1)!.preserved).toEqual([]);
    expect(existsSync(main)).toBe(false);
  });
});

describe('a worker whose shim was launched but has not written pid.json yet', () => {
  /** A PLANNED worker whose launch.json names `proc` (its shim, starting), with no pid.json. */
  function starting(l: UnitLab, id: string, cwd: string, proc: { pid: number; start: string }, requestedAt: number): void {
    const workerDir = join(l.base, 'workers', id);
    mkdirSync(workerDir, { recursive: true });
    planWorker(l.db, { id, runId: l.runId, role: 'implementer', purpose: 'implement:1/u1#1', provider: 'claude', workerDir, cwd, attempt: 1 }, l.clock);
    writeFileSync(join(workerDir, 'launch.json'), JSON.stringify({ version: 1, provider: 'claude', workerId: id, argvHash: 'h', sessionId: null, requestedAt, pid: proc.pid, procStart: proc.start }));
  }

  it('finishRun stops that shim and confirms it ended before the checkout is released', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { base, root } = await repoWithImplementer(lab);
    const u1 = await unitCheckout(lab, root, base, 'u1');
    const shim = sleeper();
    starting(lab, 'wrk-starting', u1, shim, lab.clock.now());

    await finishRun(lab.ctx(), 'CANCELLED', CANCEL);

    expect(isAlive(shim.pid)).toBe(false);
    expect(getWorker(lab.db, 'wrk-starting').state).toBe('CANCELLED');
    expect(existsSync(u1)).toBe(false);
  });

  it('reconciliation that ends a crashed run EXHAUSTED stops a starting shim and keeps its checkout on record', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { base, root } = await repoWithImplementer(lab);
    const u1 = await unitCheckout(lab, root, base, 'u1');
    const shim = sleeper();
    await crashedRunOutOfRecovery(lab);
    starting(lab, 'wrk-starting', u1, shim, lab.clock.now());

    await reconcileOnStart({ db: lab.db, ownerId: 'ctl-2', clock: lab.clock, adapters: {}, graceMs: 50, orbitHome: lab.home });

    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    expect(isAlive(shim.pid)).toBe(false);
    expect(getWorker(lab.db, 'wrk-starting').state).toBe('CANCELLED');
    expect(existsSync(u1)).toBe(true);
    expect(retainedEvents().at(-1)!.worktrees).toContain('unit-1-u1');
  });

  it('reconciliation stops a shim that never wrote pid.json before it plans a restart beside it', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    counters(lab.db, lab.runId, { recovery_attempts: 3 });
    const { base, root } = await repoWithImplementer(lab);
    const u1 = await unitCheckout(lab, root, base, 'u1');
    const shim = sleeper();
    // Launched a minute ago, long past the start grace: the launch is lost, but its shim still runs.
    starting(lab, 'wrk-stuck', u1, shim, lab.clock.now() - 60_000);

    const rep = await reconcileOnStart({ db: lab.db, ownerId: OWNER, clock: lab.clock, adapters: {}, graceMs: 50, orbitHome: lab.home });

    expect(isAlive(shim.pid)).toBe(false);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ workerId: 'wrk-stuck', observation: 'lost', restartPlanned: true });
  });
});

describe('a check still running in its checkout', () => {
  it('the release keeps the checkout of an open check run, and a later controller start releases it once the check is closed', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const { base, root } = await repoWithImplementer(lab);
    const chk = join(root, 'check-1');
    await materializeCandidate(lab.repo, base, chk, { readOnly: false });
    const check = sleeper();
    lab.db.run(
      "INSERT INTO check_runs (id, run_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, pid, started_at) VALUES ('cr-1', ?, 'unit', 'test', 't', 'h', 'p', '[]', ?, 'none', 'RUNNING', ?, ?)",
      lab.runId,
      chk,
      check.pid,
      lab.clock.now(),
    );

    await finishRun(lab.ctx(), 'CANCELLED', CANCEL);

    expect(existsSync(chk)).toBe(true);
    expect(released().at(-1)!.retained).toEqual([expect.objectContaining({ worktree: 'check-1', cause: 'active-check', why: expect.stringMatching(/cr-1/) })]);
    expect(final().next_action).toContain(chk);

    // The next controller start closes the check (it left no shim records, so recovery finds nothing of it to stop) and releases the checkout.
    lab.clock.advance(2 * 3_600_000);
    await reconcileOnStart({ db: lab.db, ownerId: 'ctl-2', clock: lab.clock, adapters: {}, graceMs: 50, orbitHome: lab.home });

    expect(lab.db.get<{ status: string }>("SELECT status FROM check_runs WHERE id = 'cr-1'")!.status).toBe('CANCELLED');
    expect(existsSync(chk)).toBe(false);
    expect(released().at(-1)!).toMatchObject({ removed: ['check-1'], kept: [] });
  });
});
