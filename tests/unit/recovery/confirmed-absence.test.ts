/**
 * A worker or check record is closed only when its process is confirmed absent. An identity recovery cannot establish,
 * or a stop it cannot confirm, keeps the record open (PLANNED or RUNNING), and so keeps its checkout, with an event that
 * says why; a later pass closes it once the process is confirmed gone.
 *
 * Covers the two windows where that failed: a check whose shim died while the check's own process group survived and
 * could not be confirmed stopped, and a worker shim spawned before launch.json named it (a crash, or a failed rewrite of
 * launch.json, before the identity was persisted). The launcher records a token in launch.json before the spawn and
 * hands it to the shim on its command line, and the shim registers itself (registration.json) before it starts
 * anything in the checkout, so recovery can tell a launch that never spawned (no process carries the token) from one
 * whose shim may still run.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Proc = typeof import('../../../src/core/proc.ts');
const hooks = vi.hoisted(() => ({
  terminateGroup: vi.fn<Proc['terminateGroup']>(),
  processInfo: vi.fn<Proc['processInfo']>(),
  findProcesses: vi.fn<Proc['findProcesses']>(),
  findProcessesWithEnv: vi.fn<Proc['findProcessesWithEnv']>(),
}));
vi.mock('../../../src/core/proc.ts', async (orig) => {
  const actual = await orig<Proc>();
  return { ...actual, terminateGroup: hooks.terminateGroup, processInfo: hooks.processInfo, findProcesses: hooks.findProcesses, findProcessesWithEnv: hooks.findProcessesWithEnv };
});

const real = await vi.importActual<Proc>('../../../src/core/proc.ts');
const { OrbitError } = await import('../../../src/core/errors.ts');
const { worktreeRootFor } = await import('../../../src/controller/context.ts');
const { acquireLease, getRun } = await import('../../../src/controller/run-store.ts');
const { materializeCandidate } = await import('../../../src/evidence/candidate.ts');
const { shimPath } = await import('../../../src/evidence/check-shim.ts');
const { reconcileOnStart } = await import('../../../src/recovery/reconcile.ts');
const { getWorker, planWorker } = await import('../../../src/storage/workers.ts');
const { counters } = await import('./helpers.ts');
const { makeUnitLab } = await import('../controller/coverage-helpers.ts');
type UnitLab = import('../controller/coverage-helpers.ts').UnitLab;

const DEAD = 2_000_000_000;
const NEXT_OWNER = 'ctl-2';

let lab: UnitLab | undefined;
const kids: ChildProcess[] = [];
const scratch: string[] = [];
beforeEach(() => {
  hooks.terminateGroup.mockReset().mockImplementation(real.terminateGroup);
  hooks.processInfo.mockReset().mockImplementation(real.processInfo);
  hooks.findProcesses.mockReset().mockImplementation((match) => real.findProcesses(match));
  hooks.findProcessesWithEnv.mockReset().mockImplementation((name, value) => real.findProcessesWithEnv(name, value));
});
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
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A live process in a group of its own whose command line carries `marker` (a launch token, a worker or check directory). */
function carrying(marker: string[]): { pid: number; start: string } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...marker], { detached: true, stdio: 'ignore' });
  child.unref();
  kids.push(child);
  return { pid: child.pid!, start: real.processStartTime(child.pid!)! };
}

const sleeper = (): { pid: number; start: string } => carrying([]);

/** A live process in a group of its own whose environment carries a check's token, as every process of that check does. */
function inEnvironment(token: string): { pid: number; start: string } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, ORBIT_CHECK_TOKEN: token } });
  child.unref();
  kids.push(child);
  return { pid: child.pid!, start: real.processStartTime(child.pid!)! };
}

/** A lab whose temporary directory, and so every run, check and worker directory in it, is under a non-ASCII path. */
function nonAsciiLab(): UnitLab {
  const base = join(tmpdir(), `orbit-Código-${process.pid}`);
  mkdirSync(base, { recursive: true });
  scratch.push(base);
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = base;
  try {
    return makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
  } finally {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function untilGone(pid: number, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function kill(p: { pid: number }): void {
  try {
    process.kill(-p.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A git repository for the lab and one checkout of it under the run's worktree directory. */
async function checkout(l: UnitLab, name: string): Promise<string> {
  mkdirSync(join(l.repo, 'apps'), { recursive: true });
  writeFileSync(join(l.repo, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(l.repo, '.gitignore'), '.orbit/\n');
  git(l.repo, 'init', '-q', '-b', 'main');
  git(l.repo, 'add', '-A');
  git(l.repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
  const base = git(l.repo, 'rev-parse', 'HEAD');
  l.db.run('UPDATE runs SET base_revision = ?, base_tree = ? WHERE id = ?', base, git(l.repo, 'rev-parse', 'HEAD^{tree}'), l.runId);
  const dir = join(worktreeRootFor(l.home, getRun(l.db, l.runId)), name);
  await materializeCandidate(l.repo, base, dir, { readOnly: false });
  return dir;
}

/** The run's previous controller died with its recovery attempts spent: the next reconciliation ends it EXHAUSTED. */
function crashedRunOutOfRecovery(l: UnitLab): void {
  counters(l.db, l.runId, { recovery_attempts: 0 });
  l.clock.advance(2 * 3_600_000);
  acquireLease(l.db, l.runId, NEXT_OWNER, 60_000, l.clock);
}

const reconcile = (l: UnitLab) => reconcileOnStart({ db: l.db, ownerId: NEXT_OWNER, clock: l.clock, adapters: {}, graceMs: 50, orbitHome: l.home });

interface Released {
  removed: string[];
  kept: string[];
  retained?: { worktree: string; cause: string }[];
}
const released = (l: UnitLab): Released[] => l.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'worktrees.released' ORDER BY id", l.runId).map((r) => JSON.parse(r.data_json) as Released);
const events = (l: UnitLab, type: string): Record<string, unknown>[] => l.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', l.runId, type).map((r) => JSON.parse(r.data_json) as Record<string, unknown>);

// ---------------------------------------------------------------------------
// checks

/** An open check run in `cwd` whose shim died: pid.json names the check's own group `child`, launch.json a dead shim. */
function lostCheck(l: UnitLab, cwd: string, child: { pid: number }): { id: string; dir: string } {
  const id = 'cr-1';
  l.db.run(
    "INSERT INTO check_runs (id, run_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, pid, started_at) VALUES (?, ?, 'unit', 'test', 't', 'h', 'p', '[]', ?, 'none', 'RUNNING', ?, ?)",
    id,
    l.runId,
    cwd,
    DEAD,
    l.clock.now(),
  );
  const dir = join(dirname(getRun(l.db, l.runId).policyPath), 'evidence', '1', 'unit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(shimPath(dir, 'intent'), JSON.stringify({ token: 'tok-1', checkRunId: id, argv: ['sleep', '60'], cwd, timeoutMs: 60_000, killGraceMs: 50, maxOutputBytes: 1000, writtenAt: Date.now() }));
  writeFileSync(shimPath(dir, 'launch'), JSON.stringify({ token: 'tok-1', pid: DEAD, procStart: 'x' }));
  writeFileSync(shimPath(dir, 'pid'), JSON.stringify({ token: 'tok-1', shimPid: DEAD, childPid: child.pid, childPgid: child.pid, startedAt: Date.now() }));
  return { id, dir };
}

const checkStatus = (l: UnitLab, id: string): string => l.db.get<{ status: string }>('SELECT status FROM check_runs WHERE id = ?', id)!.status;

describe('a check of an ended run whose shim died while its own process group survived', () => {
  it('keeps the check open and its checkout when signalling the group fails, and a later pass closes it once the group is stopped', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const chk = await checkout(lab, 'check-1');
    const group = sleeper();
    const { id } = lostCheck(lab, chk, group);
    crashedRunOutOfRecovery(lab);
    hooks.terminateGroup.mockRejectedValueOnce(new OrbitError('INTERNAL', 'cannot send SIGINT to process group: EPERM', {}));

    const rep = await reconcile(lab);

    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    expect(rep.runs[0]!.checks[0]).toMatchObject({ checkRunId: id, observation: 'lost', closed: false, terminated: false });
    expect(rep.runs[0]!.checks[0]!.detail).toMatch(/could not be confirmed stopped/);
    expect(checkStatus(lab, id)).toBe('RUNNING');
    expect(existsSync(chk)).toBe(true);
    expect(isAlive(group.pid)).toBe(true);
    expect(released(lab)).toEqual([]);
    expect(events(lab, 'worktrees.retained').at(-1)).toMatchObject({ worktrees: expect.arrayContaining(['check-1']) });
    expect(events(lab, 'recovery.stop-unconfirmed')).toEqual([expect.objectContaining({ check_run_id: id, detail: expect.stringMatching(/could not be confirmed stopped/) })]);

    // Signalling works again: the next controller start stops the group, closes the check and releases the checkout.
    await reconcile(lab);

    expect(await untilGone(group.pid)).toBe(true);
    expect(checkStatus(lab, id)).toBe('CANCELLED');
    expect(existsSync(chk)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
    expect(released(lab)).toEqual([]);
  });

  it('keeps it open when the group outlives the stop (terminateGroup reports exited: false)', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const chk = await checkout(lab, 'check-1');
    const group = sleeper();
    const { id } = lostCheck(lab, chk, group);
    crashedRunOutOfRecovery(lab);
    hooks.terminateGroup.mockResolvedValueOnce({ exited: false, signal: 'SIGKILL' });

    const rep = await reconcile(lab);

    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'lost', closed: false, terminated: false });
    expect(checkStatus(lab, id)).toBe('RUNNING');
    expect(existsSync(chk)).toBe(true);
    expect(events(lab, 'recovery.stop-unconfirmed')).toEqual([expect.objectContaining({ check_run_id: id })]);
  });

  it("keeps it open when the group's identity cannot be established (the process table cannot be read)", async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const chk = await checkout(lab, 'check-1');
    const group = sleeper();
    const { id } = lostCheck(lab, chk, group);
    crashedRunOutOfRecovery(lab);
    hooks.processInfo.mockImplementation(() => {
      throw new OrbitError('INTERNAL', 'cannot run ps', {});
    });

    const rep = await reconcile(lab);

    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'lost', closed: false, terminated: false });
    expect(hooks.terminateGroup).not.toHaveBeenCalled();
    expect(checkStatus(lab, id)).toBe('RUNNING');
    expect(existsSync(chk)).toBe(true);
    expect(isAlive(group.pid)).toBe(true);
  });

  it('closes it when its group is confirmed stopped', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const chk = await checkout(lab, 'check-1');
    const group = sleeper();
    const { id } = lostCheck(lab, chk, group);
    crashedRunOutOfRecovery(lab);

    const rep = await reconcile(lab);

    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'lost', closed: true, terminated: true });
    expect(await untilGone(group.pid)).toBe(true);
    expect(checkStatus(lab, id)).toBe('CANCELLED');
    expect(existsSync(chk)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
  });
});

describe('a check of an ended run whose live shim is stopped', () => {
  it('keeps the check open when its check group outlives the stop', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const chk = await checkout(lab, 'check-1');
    const shim = sleeper();
    const group = sleeper();
    const { id, dir } = lostCheck(lab, chk, group);
    writeFileSync(shimPath(dir, 'launch'), JSON.stringify({ token: 'tok-1', pid: shim.pid, procStart: shim.start }));
    writeFileSync(shimPath(dir, 'pid'), JSON.stringify({ token: 'tok-1', shimPid: shim.pid, childPid: group.pid, childPgid: group.pid, startedAt: Date.now() }));
    crashedRunOutOfRecovery(lab);
    hooks.terminateGroup.mockResolvedValueOnce({ exited: false, signal: 'SIGKILL' });

    const rep = await reconcile(lab);

    expect(rep.runs[0]!.checks[0]).toMatchObject({ closed: false, terminated: false });
    expect(checkStatus(lab, id)).toBe('RUNNING');
    expect(existsSync(chk)).toBe(true);
    expect(events(lab, 'recovery.stop-unconfirmed')).toEqual([expect.objectContaining({ check_run_id: id })]);
  });
});

describe('a check whose shim was spawned before launch.json named it', () => {
  it('stays open while a process carries its directory and token, and is closed once none does', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const chk = await checkout(lab, 'check-1');
    const { id, dir } = lostCheck(lab, chk, { pid: DEAD });
    const token = randomBytes(8).toString('hex');
    // Only the intent is on disk: the controller died right after the spawn.
    writeFileSync(shimPath(dir, 'intent'), JSON.stringify({ token, checkRunId: id, argv: ['sleep', '60'], cwd: chk, timeoutMs: 60_000, killGraceMs: 50, maxOutputBytes: 1000, writtenAt: Date.now() }));
    for (const f of ['launch', 'pid'] as const) rmSync(shimPath(dir, f));
    const shim = carrying([dir, token]);
    crashedRunOutOfRecovery(lab);

    const rep = await reconcile(lab);

    expect(rep.runs[0]!.checks[0]).toMatchObject({ closed: false });
    expect(rep.runs[0]!.checks[0]!.detail).toMatch(/carries its launch token/);
    expect(checkStatus(lab, id)).toBe('RUNNING');
    expect(existsSync(chk)).toBe(true);
    expect(isAlive(shim.pid)).toBe(true);

    kill(shim);
    expect(await untilGone(shim.pid)).toBe(true);
    await reconcile(lab);

    expect(checkStatus(lab, id)).toBe('CANCELLED');
    expect(existsSync(chk)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
  });
});

/**
 * An open check run in `cwd` whose shim registered itself (registration.json: the spawning marker) and was then killed
 * before it wrote pid.json, so nothing on disk names the check's process group; launch.json is written or not.
 */
function unrecordedCheck(l: UnitLab, cwd: string, opts: { launch: boolean; shim?: { pid: number; start: string } }): { id: string; dir: string; token: string } {
  const { id, dir } = lostCheck(l, cwd, { pid: DEAD });
  const token = randomBytes(8).toString('hex');
  const shimPid = opts.shim?.pid ?? DEAD;
  writeFileSync(shimPath(dir, 'intent'), JSON.stringify({ token, checkRunId: id, argv: ['sleep', '60'], cwd, timeoutMs: 60_000, killGraceMs: 50, maxOutputBytes: 1000, writtenAt: Date.now() }));
  rmSync(shimPath(dir, 'pid'));
  if (opts.launch) writeFileSync(shimPath(dir, 'launch'), JSON.stringify({ token, pid: shimPid, procStart: opts.shim?.start ?? 'x' }));
  else rmSync(shimPath(dir, 'launch'));
  writeFileSync(shimPath(dir, 'registration'), JSON.stringify({ token, shimPid, registeredAt: Date.now() }));
  return { id, dir, token };
}

describe('a check whose shim died between spawning its check and recording it', () => {
  for (const launch of [true, false]) {
    it(`stays open while a process carries its token in the environment, and closes once none does (launch.json ${launch ? 'written' : 'absent'})`, async () => {
      lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
      const chk = await checkout(lab, 'check-1');
      const { id, token } = unrecordedCheck(lab, chk, { launch });
      const check = inEnvironment(token);
      crashedRunOutOfRecovery(lab);

      const rep = await reconcile(lab);

      expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
      expect(rep.runs[0]!.checks[0]).toMatchObject({ checkRunId: id, closed: false });
      expect(rep.runs[0]!.checks[0]!.detail).toMatch(new RegExp(`process ${check.pid} carries its token in its environment`));
      expect(checkStatus(lab, id)).toBe('RUNNING');
      expect(existsSync(chk)).toBe(true);
      expect(isAlive(check.pid)).toBe(true);
      expect(events(lab, 'recovery.stop-unconfirmed')).toEqual([expect.objectContaining({ check_run_id: id })]);

      kill(check);
      expect(await untilGone(check.pid)).toBe(true);
      await reconcile(lab);

      expect(checkStatus(lab, id)).toBe('CANCELLED');
      expect(existsSync(chk)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
    });
  }

  it('closes it when no process carries its token', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const chk = await checkout(lab, 'check-1');
    const { id } = unrecordedCheck(lab, chk, { launch: true });
    crashedRunOutOfRecovery(lab);

    const rep = await reconcile(lab);

    expect(hooks.findProcessesWithEnv).toHaveBeenCalled();
    expect(rep.runs[0]!.checks[0]).toMatchObject({ checkRunId: id, closed: true });
    expect(checkStatus(lab, id)).toBe('CANCELLED');
    expect(existsSync(chk)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
  });

  it('keeps it open when the environments cannot be searched', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const chk = await checkout(lab, 'check-1');
    const { id } = unrecordedCheck(lab, chk, { launch: false });
    crashedRunOutOfRecovery(lab);
    hooks.findProcessesWithEnv.mockImplementation(() => {
      throw new OrbitError('INTERNAL', 'cannot run ps', {});
    });

    const rep = await reconcile(lab);

    expect(rep.runs[0]!.checks[0]).toMatchObject({ closed: false });
    expect(rep.runs[0]!.checks[0]!.detail).toMatch(/could not be searched/);
    expect(checkStatus(lab, id)).toBe('RUNNING');
    expect(existsSync(chk)).toBe(true);
  });

  it('a live shim that registered but never named its check group is stopped, and the check closes only once no process carries its token', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const chk = await checkout(lab, 'check-1');
    const shim = sleeper();
    const { id, token } = unrecordedCheck(lab, chk, { launch: true, shim });
    const check = inEnvironment(token);
    crashedRunOutOfRecovery(lab);

    const rep = await reconcile(lab);

    expect(await untilGone(shim.pid)).toBe(true);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ closed: false, terminated: false });
    expect(checkStatus(lab, id)).toBe('RUNNING');
    expect(existsSync(chk)).toBe(true);
    expect(isAlive(check.pid)).toBe(true);

    kill(check);
    expect(await untilGone(check.pid)).toBe(true);
    await reconcile(lab);

    expect(checkStatus(lab, id)).toBe('CANCELLED');
    expect(existsSync(chk)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
  });

  it('a live shim that never registered is stopped and the check closed: it never reached the spawn', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const chk = await checkout(lab, 'check-1');
    const shim = sleeper();
    const { id, dir } = unrecordedCheck(lab, chk, { launch: true, shim });
    rmSync(shimPath(dir, 'registration'));
    crashedRunOutOfRecovery(lab);

    const rep = await reconcile(lab);

    expect(await untilGone(shim.pid)).toBe(true);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ closed: true, terminated: true });
    expect(hooks.findProcessesWithEnv).not.toHaveBeenCalled();
    expect(checkStatus(lab, id)).toBe('CANCELLED');
  });
});

describe('the process-table search under a non-ASCII path', () => {
  it('finds the shim of a check whose directory is under it, by its token, before launch.json names it', async () => {
    lab = nonAsciiLab();
    const chk = await checkout(lab, 'check-1');
    const { id, dir } = lostCheck(lab, chk, { pid: DEAD });
    const token = randomBytes(8).toString('hex');
    writeFileSync(shimPath(dir, 'intent'), JSON.stringify({ token, checkRunId: id, argv: ['sleep', '60'], cwd: chk, timeoutMs: 60_000, killGraceMs: 50, maxOutputBytes: 1000, writtenAt: Date.now() }));
    for (const f of ['launch', 'pid'] as const) rmSync(shimPath(dir, f));
    expect(dir).toContain('Código');
    const shim = carrying([join(dirname(dirname(dirname(dir))), 'check-shim.mjs'), dir, token]);
    crashedRunOutOfRecovery(lab);

    await reconcile(lab);

    expect(isAlive(shim.pid)).toBe(true);
    expect(checkStatus(lab, id)).toBe('RUNNING');
    expect(existsSync(chk)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fail-before probe attempts

/** An open fail-before probe attempt in the probe checkout `cwd`, its attempt directory with its intent. */
function openProbe(l: UnitLab, cwd: string): { id: string; dir: string; token: string } {
  const id = 'fbp-1';
  l.db.run(
    "INSERT INTO fail_before_probes (id, run_id, candidate_id, probe_id, probe_tree, check_id, check_config_hash, policy_hash, attempt, command_json, cwd, isolation, status, started_at) VALUES (?, ?, 'cand-1', 'probe-1', 't', 'unit', 'h', 'p', 1, '[]', ?, 'none', 'RUNNING', ?)",
    id,
    l.runId,
    cwd,
    l.clock.now(),
  );
  const dir = join(dirname(getRun(l.db, l.runId).policyPath), 'evidence', '1', 'fail-before', 'unit');
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(8).toString('hex');
  writeFileSync(shimPath(dir, 'intent'), JSON.stringify({ token, checkRunId: id, argv: ['sleep', '60'], cwd, timeoutMs: 60_000, killGraceMs: 50, maxOutputBytes: 1000, writtenAt: Date.now() }));
  return { id, dir, token };
}

const probeStatus = (l: UnitLab, id: string): string => l.db.get<{ status: string }>('SELECT status FROM fail_before_probes WHERE id = ?', id)!.status;

describe('a fail-before probe attempt that may still run', () => {
  it('stays open, and its checkout is kept, while a process carries its token on a check shim command line before launch.json names it', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const probe = await checkout(lab, 'fail-before-1');
    const { id, dir, token } = openProbe(lab, probe);
    const shim = carrying([dir, token]);
    crashedRunOutOfRecovery(lab);

    const rep = await reconcile(lab);

    expect(rep.runs[0]!.probes).toEqual([]);
    expect(probeStatus(lab, id)).toBe('RUNNING');
    expect(existsSync(probe)).toBe(true);
    expect(isAlive(shim.pid)).toBe(true);
    expect(released(lab)).toEqual([]);
    expect(events(lab, 'worktrees.retained').at(-1)).toMatchObject({ worktrees: expect.arrayContaining(['fail-before-1']) });
    expect(events(lab, 'recovery.stop-unconfirmed')).toEqual([expect.objectContaining({ fail_before_probe_id: id })]);

    kill(shim);
    expect(await untilGone(shim.pid)).toBe(true);
    const again = await reconcile(lab);

    expect(again.runs[0]!.probes).toEqual([id]);
    expect(probeStatus(lab, id)).toBe('CANCELLED');
    expect(existsSync(probe)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
  });

  it('stays open while its check runs on after its shim died between the spawn and pid.json', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const probe = await checkout(lab, 'fail-before-1');
    const { id, dir, token } = openProbe(lab, probe);
    writeFileSync(shimPath(dir, 'launch'), JSON.stringify({ token, pid: DEAD, procStart: 'x' }));
    writeFileSync(shimPath(dir, 'registration'), JSON.stringify({ token, shimPid: DEAD, registeredAt: Date.now() }));
    const check = inEnvironment(token);
    crashedRunOutOfRecovery(lab);

    await reconcile(lab);

    expect(probeStatus(lab, id)).toBe('RUNNING');
    expect(existsSync(probe)).toBe(true);
    expect(isAlive(check.pid)).toBe(true);
  });

  it('is stopped and closed when its shim is the process launch.json names, and its checkout released', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const probe = await checkout(lab, 'fail-before-1');
    const { id, dir, token } = openProbe(lab, probe);
    const shim = sleeper();
    const group = sleeper();
    writeFileSync(shimPath(dir, 'launch'), JSON.stringify({ token, pid: shim.pid, procStart: shim.start }));
    writeFileSync(shimPath(dir, 'pid'), JSON.stringify({ token, shimPid: shim.pid, childPid: group.pid, childPgid: group.pid, startedAt: Date.now() }));
    crashedRunOutOfRecovery(lab);

    const rep = await reconcile(lab);

    expect(rep.runs[0]!.probes).toEqual([id]);
    expect(await untilGone(shim.pid)).toBe(true);
    expect(await untilGone(group.pid)).toBe(true);
    expect(probeStatus(lab, id)).toBe('CANCELLED');
    expect(existsSync(probe)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
  });
});

// ---------------------------------------------------------------------------
// workers

/** A PLANNED implementer of `cwd` whose launch.json records the intent (a token), without the spawned shim's pid. */
function launched(l: UnitLab, id: string, cwd: string, launch: Record<string, unknown> | string): string {
  const workerDir = join(l.base, 'workers', id);
  mkdirSync(workerDir, { recursive: true });
  planWorker(l.db, { id, runId: l.runId, role: 'implementer', purpose: 'implement:1#1', provider: 'claude', workerDir, cwd, attempt: 1 }, l.clock);
  writeFileSync(join(workerDir, 'launch.json'), typeof launch === 'string' ? launch : JSON.stringify({ version: 1, provider: 'claude', workerId: id, argvHash: 'h', sessionId: null, requestedAt: l.clock.now(), ...launch }));
  return workerDir;
}

describe('a worker shim spawned before launch.json named it', () => {
  it('keeps the worker active and its checkout while a process carries its launch token, and a later pass closes it once none does', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const wt = await checkout(lab, 'implementer');
    crashedRunOutOfRecovery(lab);
    const token = randomBytes(16).toString('hex');
    const shim = carrying(['--launch-token', token, '--']);
    launched(lab, 'wrk-1', wt, { token });

    await reconcile(lab);

    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    expect(getWorker(lab.db, 'wrk-1').state).toBe('PLANNED');
    expect(existsSync(wt)).toBe(true);
    // Not registered, so not identified: it is never signalled.
    expect(isAlive(shim.pid)).toBe(true);
    expect(released(lab)).toEqual([]);
    expect(events(lab, 'worktrees.retained').at(-1)).toMatchObject({ worktrees: expect.arrayContaining(['implementer']) });
    expect(events(lab, 'recovery.stop-unconfirmed')).toEqual([expect.objectContaining({ worker_id: 'wrk-1', detail: expect.stringMatching(new RegExp(`process ${shim.pid} carries its launch token`)) })]);

    kill(shim);
    expect(await untilGone(shim.pid)).toBe(true);
    await reconcile(lab);

    expect(getWorker(lab.db, 'wrk-1')).toMatchObject({ state: 'CANCELLED', error: 'never started: run is EXHAUSTED' });
    expect(existsSync(wt)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
    expect(released(lab)).toEqual([]);
  });

  it('stops a shim that registered itself, by the identity it registered, before the worker is closed', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const wt = await checkout(lab, 'implementer');
    crashedRunOutOfRecovery(lab);
    const token = randomBytes(16).toString('hex');
    const shim = carrying(['--launch-token', token, '--']);
    const dir = launched(lab, 'wrk-1', wt, { token });
    writeFileSync(join(dir, 'registration.json'), JSON.stringify({ version: 1, token, shimPid: shim.pid, shimStart: shim.start, pgid: shim.pid, registeredAt: Date.now() }));

    await reconcile(lab);

    expect(await untilGone(shim.pid)).toBe(true);
    expect(getWorker(lab.db, 'wrk-1')).toMatchObject({ state: 'CANCELLED', error: 'its starting shim was stopped: run is EXHAUSTED' });
    expect(existsSync(wt)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
  });

  it('closes a launch whose spawn never happened: no process carries its token', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const wt = await checkout(lab, 'implementer');
    crashedRunOutOfRecovery(lab);
    launched(lab, 'wrk-1', wt, { token: randomBytes(16).toString('hex') });

    await reconcile(lab);

    expect(hooks.findProcesses).toHaveBeenCalled();
    expect(getWorker(lab.db, 'wrk-1')).toMatchObject({ state: 'CANCELLED', error: 'never started: run is EXHAUSTED' });
    expect(existsSync(wt)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
  });

  it('keeps the worker when the process table cannot be searched', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const wt = await checkout(lab, 'implementer');
    crashedRunOutOfRecovery(lab);
    launched(lab, 'wrk-1', wt, { token: randomBytes(16).toString('hex') });
    hooks.findProcesses.mockImplementation(() => {
      throw new OrbitError('INTERNAL', 'cannot run ps', {});
    });

    await reconcile(lab);

    expect(getWorker(lab.db, 'wrk-1').state).toBe('PLANNED');
    expect(existsSync(wt)).toBe(true);
    expect(events(lab, 'recovery.stop-unconfirmed')).toEqual([expect.objectContaining({ worker_id: 'wrk-1', detail: expect.stringMatching(/process table could not be searched/) })]);
  });

  it('a launch record without a token is found by the shim command line naming its worker directory', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const wt = await checkout(lab, 'implementer');
    crashedRunOutOfRecovery(lab);
    const dir = launched(lab, 'wrk-1', wt, '{not json');
    const shim = carrying(['--worker-dir', dir, '--timeout-ms', '0', '--']);

    await reconcile(lab);

    expect(getWorker(lab.db, 'wrk-1').state).toBe('PLANNED');
    expect(existsSync(wt)).toBe(true);
    expect(isAlive(shim.pid)).toBe(true);
  });
});

describe('a worker launch whose registration.json cannot be used', () => {
  const foreign = (token: string, shim: { pid: number; start: string | null }): string => JSON.stringify({ version: 1, token: `other-${token}`, shimPid: shim.pid, shimStart: shim.start, pgid: shim.pid, registeredAt: Date.now() });
  for (const [name, content] of [
    ['names another launch whose process is long gone', (t: string) => foreign(t, { pid: DEAD, start: 'x' })],
    ['is damaged', () => ''],
  ] as const) {
    it(`${name}: the worker is closed once no process carries the launch token`, async () => {
      lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
      const wt = await checkout(lab, 'implementer');
      crashedRunOutOfRecovery(lab);
      const token = randomBytes(16).toString('hex');
      const dir = launched(lab, 'wrk-1', wt, { token });
      writeFileSync(join(dir, 'registration.json'), content(token));

      await reconcile(lab);

      expect(hooks.findProcesses).toHaveBeenCalled();
      expect(getWorker(lab.db, 'wrk-1')).toMatchObject({ state: 'CANCELLED', error: 'never started: run is EXHAUSTED' });
      expect(existsSync(wt)).toBe(true); // an EXHAUSTED run keeps its checkouts on record (worktrees.retained)
      expect(events(lab, 'recovery.stop-unconfirmed')).toEqual([]);
    });
  }

  it('keeps the worker while a process carries the launch token, whatever the registration says', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const wt = await checkout(lab, 'implementer');
    crashedRunOutOfRecovery(lab);
    const token = randomBytes(16).toString('hex');
    const shim = carrying(['--launch-token', token, '--']);
    const dir = launched(lab, 'wrk-1', wt, { token });
    writeFileSync(join(dir, 'registration.json'), '');

    await reconcile(lab);

    expect(getWorker(lab.db, 'wrk-1').state).toBe('PLANNED');
    expect(existsSync(wt)).toBe(true);
    expect(isAlive(shim.pid)).toBe(true);
  });

  it('keeps the worker while the shim that registration.json names still runs, though it names another launch', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'] });
    const wt = await checkout(lab, 'implementer');
    crashedRunOutOfRecovery(lab);
    const token = randomBytes(16).toString('hex');
    const other = sleeper();
    const dir = launched(lab, 'wrk-1', wt, { token });
    writeFileSync(join(dir, 'registration.json'), foreign(token, other));

    await reconcile(lab);

    expect(getWorker(lab.db, 'wrk-1').state).toBe('PLANNED');
    expect(existsSync(wt)).toBe(true);
    expect(isAlive(other.pid)).toBe(true);
    expect(events(lab, 'recovery.stop-unconfirmed')).toEqual([expect.objectContaining({ worker_id: 'wrk-1', detail: expect.stringMatching(/names another launch/) })]);
  });
});

describe('a worker launch record without a token under a non-ASCII path', () => {
  it('finds the shim by its worker directory on the shim command line', async () => {
    lab = nonAsciiLab();
    const wt = await checkout(lab, 'implementer');
    crashedRunOutOfRecovery(lab);
    const dir = launched(lab, 'wrk-1', wt, '{not json');
    expect(dir).toContain('Código');
    const shim = carrying(['--worker-dir', dir, '--timeout-ms', '0', '--']);

    await reconcile(lab);

    expect(getWorker(lab.db, 'wrk-1').state).toBe('PLANNED');
    expect(existsSync(wt)).toBe(true);
    expect(isAlive(shim.pid)).toBe(true);
  });
});
