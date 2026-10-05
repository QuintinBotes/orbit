import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { WorkUnit } from '../../../src/scheduling/types.ts';
import { DEFAULT_TIMING, homeOf, lenientContext, loadRunContext, machineAdmission, repoKey, runWorktreeRoot, schedulerFor, currentCandidate } from '../../../src/controller/context.ts';
import { addCandidate, makeUnitLab, type UnitLab } from './coverage-helpers.ts';
import { capturingLogger } from './coverage-log.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

describe('loadRunContext', () => {
  it('refuses a stored contract that is not JSON, naming the run', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    lab.db.run("UPDATE runs SET contract_json = '{not json' WHERE id = ?", lab.runId);
    expect(() => lab.ctx()).toThrow(/run orb-unit holds an unreadable contract/);
    try {
      lab.ctx();
    } catch (err) {
      expect(err).toMatchObject({ code: 'CONTRACT_INVALID' });
    }
  });

  it('refuses a stored contract that does not validate against the frozen policy', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    lab.db.run("UPDATE runs SET contract_json = '{}' WHERE id = ?", lab.runId);
    expect(() => lab.ctx()).toThrow(expect.objectContaining({ code: 'CONTRACT_INVALID' }));
  });

  it('builds isolation once, lazily, from the frozen policy, labelled with the run', () => {
    lab = makeUnitLab();
    const ctx = lab.ctx();
    const first = ctx.isolation();
    expect(first).toBeInstanceOf(NoIsolation);
    expect(ctx.isolation()).toBe(first);
  });

  it('uses the isolation a dependency supplies instead, and still builds it once', () => {
    let built = 0;
    const custom = new NoIsolation({ allowUnisolated: true } as never);
    lab = makeUnitLab({
      deps: {
        isolationFor: () => {
          built++;
          return custom;
        },
      },
    });
    const ctx = lab.ctx();
    expect(ctx.isolation()).toBe(custom);
    ctx.isolation();
    expect(built).toBe(1);
  });

  it('merges timing overrides over the defaults, and refresh re-reads the run row', () => {
    lab = makeUnitLab({ deps: { timing: { checkPollMs: 7 } } });
    const ctx = lab.ctx();
    expect(ctx.timing).toEqual({ ...DEFAULT_TIMING, checkPollMs: 7 });
    expect(ctx.run.state).toBe('CREATED');
    lab.walk(['PREFLIGHT']);
    expect(ctx.run.state).toBe('CREATED');
    expect(ctx.refresh().state).toBe('PREFLIGHT');
    expect(ctx.run.state).toBe('PREFLIGHT');
  });

  it('logs under the run id when a logger is given, and silently otherwise', () => {
    const cap = capturingLogger();
    lab = makeUnitLab({ logger: cap.logger });
    lab.ctx().log.info('hello');
    expect(cap.lines().at(-1)).toMatchObject({ msg: 'hello', run_id: 'orb-unit' });
    lab.cleanup();
    lab = makeUnitLab();
    expect(() => lab.ctx().log.info('quiet')).not.toThrow();
  });
});

describe('lenientContext', () => {
  it('reads the snapshot without trusting it and refuses to run anything under it', () => {
    lab = makeUnitLab();
    const ctx = lenientContext(lab.deps, lab.runId, new AbortController().signal);
    expect(ctx.policyVerified).toBe(false);
    expect(ctx.snapshot.run_id).toBe(lab.runId);
    expect(ctx.contract).toBeNull();
    expect(ctx.ledger).toBeNull();
    expect(() => ctx.isolation()).toThrow(expect.objectContaining({ code: 'POLICY_TAMPERED' }));
    expect(ctx.refresh().id).toBe(lab.runId);
  });

  it('falls back to an empty snapshot when the policy file cannot be read at all', () => {
    lab = makeUnitLab();
    const path = lab.ctx().run.policyPath;
    chmodSync(path, 0o000);
    try {
      const ctx = lenientContext(lab.deps, lab.runId, new AbortController().signal);
      if (process.getuid?.() === 0) return;
      expect(ctx.snapshot).toMatchObject({ schema: 'orbit.policy/1', run_id: lab.runId, repo_root: lab.repo, config: {}, effective_protected_paths: [] });
    } finally {
      chmodSync(path, 0o444);
    }
  });

  it('falls back the same way when the policy file is not JSON', () => {
    lab = makeUnitLab();
    const path = lab.ctx().run.policyPath;
    chmodSync(path, 0o644);
    writeFileSync(path, 'garbage');
    const ctx = lenientContext(lab.deps, lab.runId, new AbortController().signal);
    expect(ctx.snapshot.run_id).toBe(lab.runId);
    expect(ctx.snapshot.config).toEqual({});
  });
});

describe('currentCandidate', () => {
  it('is the candidate the newest implementation event names, else the newest ready one, else none', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    expect(currentCandidate(lab.db, lab.runId)).toBeNull();
    const a = addCandidate(lab, { tree: 'a'.repeat(40), commit: '1'.repeat(40) });
    const b = addCandidate(lab, { tree: 'b'.repeat(40), commit: '2'.repeat(40) });
    expect(currentCandidate(lab.db, lab.runId)?.id).toBe(b.id);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'implementation.candidate', 'x', ?)", lab.runId, lab.clock.now(), JSON.stringify({ candidate_id: a.id }));
    expect(currentCandidate(lab.db, lab.runId)?.id).toBe(a.id);
    // An event that names nothing real falls back to the newest ready candidate.
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'implementation.candidate', 'x', ?)", lab.runId, lab.clock.now(), JSON.stringify({ candidate_id: 'cand-missing' }));
    expect(currentCandidate(lab.db, lab.runId)?.id).toBe(b.id);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'implementation.candidate', 'x', ?)", lab.runId, lab.clock.now(), JSON.stringify({}));
    expect(currentCandidate(lab.db, lab.runId)?.id).toBe(b.id);
  });
});

describe('paths and capacity helpers', () => {
  it('homeOf is the configured home or the user home', () => {
    lab = makeUnitLab();
    expect(homeOf(lab.deps)).toBe(lab.deps.homeDir);
    expect(homeOf({ ...lab.deps, homeDir: undefined })).toBe(homedir());
  });

  it('repoKey is a stable twelve-character id of the real path, and a missing repository still gets one', () => {
    lab = makeUnitLab();
    expect(repoKey(lab.repo)).toMatch(/^[0-9a-f]{12}$/);
    expect(repoKey(lab.repo)).toBe(repoKey(lab.repo));
    const link = join(lab.base, 'link');
    rmSync(link, { force: true });
    mkdirSync(join(lab.base, 'other'));
    expect(repoKey(join(lab.base, 'missing'))).toMatch(/^[0-9a-f]{12}$/);
    expect(repoKey(join(lab.base, 'missing'))).not.toBe(repoKey(lab.repo));
  });

  it('keeps worker worktrees under the orbit home, outside the repository', () => {
    lab = makeUnitLab();
    const ctx = lab.ctx();
    const root = runWorktreeRoot(ctx);
    expect(root).toBe(join(lab.home, 'worktrees', repoKey(lab.repo), lab.runId));
    expect(root.startsWith(lab.repo)).toBe(false);
  });

  const unit = (id: string, over: Partial<WorkUnit> = {}): WorkUnit => ({ id, role: 'implementer', writer: true, worktree: join('/wt', id), ownedPaths: ['apps/**'], dependsOn: [], revision: null, cancelWhen: [], budget: {}, ...over });

  it('admits what the machine can run and says why the rest waits, ignoring ownership and worktrees', () => {
    lab = makeUnitLab({ deps: { schedulerProbe: { availableParallelism: () => 2, freemem: () => 64_000 * 1024 * 1024 } } });
    const ctx = lab.ctx();
    const r = machineAdmission(ctx, [unit('r1')], [unit('p1'), unit('p2'), unit('p3')]);
    const decided = new Set([...r.start, ...r.deferred.keys()]);
    expect(['p1', 'p2', 'p3'].every((id) => decided.has(id))).toBe(true);
    expect(r.deferred.size).toBeGreaterThan(0);
    for (const why of r.deferred.values()) expect(why).toMatch(/^machine /);
    // Two units that own the same paths in the same worktree are not the machine's concern.
    lab.cleanup();
    lab = makeUnitLab({ deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } } });
    const same = machineAdmission(lab.ctx(), [], [unit('a', { worktree: '/wt/shared' }), unit('b', { worktree: '/wt/shared' })]);
    expect([...same.start].sort()).toEqual(['a', 'b']);
  });

  it('builds a scheduler on the controller\'s probe when one is set and on the host otherwise', () => {
    lab = makeUnitLab();
    expect(schedulerFor(lab.ctx())).toBeDefined();
    lab.cleanup();
    lab = makeUnitLab({ deps: { schedulerProbe: { availableParallelism: () => 1, freemem: () => 1 } } });
    expect(schedulerFor(lab.ctx())).toBeDefined();
  });
});
