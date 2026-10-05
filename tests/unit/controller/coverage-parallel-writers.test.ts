import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec } from '../../../src/adapters/types.ts';
import { planWorkUnits, type WorkUnitPlan } from '../../../src/scheduling/work-units.ts';
import { materializeCandidate } from '../../../src/evidence/candidate.ts';
import { insertQuestion } from '../../../src/inquisition/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { setPaused, requestCancel } from '../../../src/controller/run-store.ts';
import {
  MERGE_OVERHEAD_EVENT,
  UNITS_EVENT,
  UNIT_INTEGRATED_EVENT,
  UNIT_INTEGRATING_EVENT,
  UNIT_SERIALIZED_EVENT,
  recordUnits,
  recordedUnits,
  runParallelUnits,
  serializedUnits,
  splitAttempt,
  unitPurpose,
  unitWorktree,
  type ParallelOptions,
} from '../../../src/controller/parallel-writers.ts';
import { PLANNER_OUTPUT } from '../../integration/controller/harness.ts';
import { initLedger, makeUnitLab, validContract, type UnitLab } from './coverage-helpers.ts';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const usage = { provider: 'claude', model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.01, costSource: 'reported' as const };
const result = (over: Partial<TaskResult> = {}): TaskResult => ({ status: 'succeeded', structured: { ok: true }, text: null, error: null, exitCode: 0, usage, durationMs: 1, ...over });

interface Script {
  /** What each unit's session does to its worktree when it starts. */
  edit?: Record<string, (cwd: string) => void>;
  /** The result of each unit: null while running. */
  collect?: Record<string, TaskResult | null>;
}

function adapter(script: Script): ProviderAdapter & { starts: string[] } {
  const a = {
    id: 'claude',
    starts: [] as string[],
    async startTask(spec: TaskSpec): Promise<TaskHandle> {
      const unit = /implement:\d+\/(u\d+)/.exec(lab.db.get<{ purpose: string }>('SELECT purpose FROM workers WHERE id = ?', spec.workerId)?.purpose ?? '')?.[1] ?? '?';
      a.starts.push(unit);
      mkdirSync(spec.workerDir, { recursive: true });
      writeFileSync(join(spec.workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: 2_000_000_000, shimStart: 'x', pgid: 2_000_000_000, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
      script.edit?.[unit]?.(spec.cwd);
      return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x', logPath: '', exitPath: '' };
    },
    async collectResult(h: TaskHandle): Promise<TaskResult | null> {
      const unit = /implement:\d+\/(u\d+)/.exec(lab.db.get<{ purpose: string }>('SELECT purpose FROM workers WHERE id = ?', h.workerId)?.purpose ?? '')?.[1] ?? '?';
      return script.collect && unit in script.collect ? (script.collect[unit] ?? null) : null;
    },
    async cancelTask(): Promise<void> {},
  };
  return a as unknown as ProviderAdapter & { starts: string[] };
}

const UNITS: WorkUnitPlan[] = [
  { id: 'u1', criteria: ['AC-1'], ownedPaths: ['apps/a.mjs'] },
  { id: 'u2', criteria: ['AC-2'], ownedPaths: ['apps/b.mjs'] },
];

const write = (rel: string, text: string) => (cwd: string) => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};

async function setup(script: Script, tweak?: (c: import('../../../src/policy/types.ts').OrbitConfig) => void, probe = { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 }) {
  const a = adapter(script);
  lab = makeUnitLab({
    path: ['PREFLIGHT'],
    adapters: { claude: a },
    deps: { schedulerProbe: probe },
    tweak: (c) => {
      c.agents = { ...c.agents, default_parallelism: 2 };
      tweak?.(c);
    },
  });
  // A real repository at the base revision, and the run's own worktree beside the unit worktrees.
  mkdirSync(join(lab.repo, 'apps'), { recursive: true });
  writeFileSync(join(lab.repo, 'apps', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(lab.repo, 'apps', 'b.mjs'), 'export const b = 1;\n');
  writeFileSync(join(lab.repo, '.gitignore'), '.orbit/\n');
  git(lab.repo, 'init', '-q', '-b', 'main');
  git(lab.repo, 'add', '-A');
  git(lab.repo, 'commit', '-q', '-m', 'base');
  const base = git(lab.repo, 'rev-parse', 'HEAD');
  const main = join(lab.home, 'worktrees', 'main-wt');
  await materializeCandidate(lab.repo, base, main, { readOnly: false });
  lab.db.run('UPDATE runs SET base_revision = ?, worktree_path = ? WHERE id = ?', base, main, lab.runId);
  initLedger(lab);
  return { a, base, main };
}

function options(over: Partial<ParallelOptions> = {}): ParallelOptions {
  return {
    route: { provider: 'claude', model: null, effort: null, workKind: 'routine-code', decisionId: 'dec-route' },
    contract: validContract(lab),
    prompt: (u, all, id) => `unit ${u.id} of ${all.length} (${id})`,
    running: () => [],
    maxTurns: 5,
    ...over,
  };
}

const events = (type: string): { data_json: string }[] => lab.db.all('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', lab.runId, type);
const data = (type: string) => events(type).map((e) => JSON.parse(e.data_json));

describe('naming and recording', () => {
  it('names a unit\'s purpose and worktree under the run, and reads back the plan recorded with an attempt', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    expect(unitPurpose(2, { id: 'u3' })).toBe('implement:2/u3#1');
    expect(unitWorktree(ctx, 2, { id: 'u3' }).endsWith(join(lab.runId, 'unit-2-u3'))).toBe(true);
    expect(recordedUnits(ctx, 1)).toBeNull();
    recordUnits(ctx, 1, UNITS);
    recordUnits(ctx, 2, [UNITS[0]!]);
    expect(recordedUnits(ctx, 1)).toEqual(UNITS);
    expect(recordedUnits(ctx, 2)).toEqual([UNITS[0]]);
    expect(recordedUnits(ctx, 3)).toBeNull();
    expect(data(UNITS_EVENT)).toHaveLength(2);
    expect(serializedUnits(ctx, 1)).toEqual([]);
  });
});

describe('splitAttempt', () => {
  const criteria = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `AC-${i + 1}`, statement: `s${i}`, proof: ['p'], mandatory: true, check_ids: ['unit'] }));
  function plan(paths: string[][]): void {
    const out = { ...PLANNER_OUTPUT, criteria: paths.map((ps, i) => ({ ...PLANNER_OUTPUT.criteria[0]!, key: `k${i}`, changes: ps.map((p) => ({ path: p, summary: 'x' })) })) };
    mkdirSync(lab.ctx().runDir, { recursive: true });
    writeFileSync(join(lab.ctx().runDir, 'planner.json'), JSON.stringify({ worker_id: 'w', output: out }));
  }
  const prepare = (tweak?: (c: import('../../../src/policy/types.ts').OrbitConfig) => void) => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], tweak: (c) => ((c.agents = { ...c.agents, default_parallelism: 2 }), tweak?.(c)) });
  };

  it('splits criteria the planner mapped to disjoint files into units', () => {
    prepare();
    plan([['apps/a.mjs'], ['apps/b.mjs']]);
    const ctx = lab.ctx();
    const units = splitAttempt(ctx, { ...validContract(lab), acceptance_criteria: criteria(2) }, true);
    expect(units).toEqual(planWorkUnits([{ id: 'AC-1', paths: ['apps/a.mjs'] }, { id: 'AC-2', paths: ['apps/b.mjs'] }]));
    expect(units).toHaveLength(2);
  });

  it('keeps one writer for a repair, a supervised run, a policy that does not ask for parallelism, no stored plan, a plan that does not match, or a waiting decision', () => {
    prepare();
    plan([['apps/a.mjs'], ['apps/b.mjs']]);
    const two = { ...validContract(lab), acceptance_criteria: criteria(2) };
    expect(splitAttempt(lab.ctx(), two, false)).toBeNull();
    expect(splitAttempt(lab.ctx(), { ...two, acceptance_criteria: criteria(3) }, true)).toBeNull();
    rmSync(join(lab.ctx().runDir, 'planner.json'));
    expect(splitAttempt(lab.ctx(), two, true)).toBeNull();
    plan([['apps/a.mjs'], ['apps/b.mjs']]);
    insertQuestion(lab.db, { id: 'q-1', runId: lab.runId, mode: 'clarify', question: 'Which?', evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: true, affected: ['AC-2'], unblocked: [] }, lab.clock);
    expect(splitAttempt(lab.ctx(), two, true)).toBeNull();
    lab.cleanup();

    prepare((c) => (c.agents = { ...c.agents, default_parallelism: 1 }));
    plan([['apps/a.mjs'], ['apps/b.mjs']]);
    expect(splitAttempt(lab.ctx(), { ...validContract(lab), acceptance_criteria: criteria(2) }, true)).toBeNull();
    lab.cleanup();

    lab = makeUnitLab({ path: [] });
    lab.db.run("UPDATE runs SET mode = 'supervised' WHERE id = ?", lab.runId);
    expect(splitAttempt(lab.ctx(), { ...validContract(lab), acceptance_criteria: criteria(2) }, true)).toBeNull();
  });
});

describe('runParallelUnits', () => {
  it('starts every admitted unit in its own worktree at the base revision, records the merge overhead and waits for them', async () => {
    const { a } = await setup({ collect: {} });
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(out).toEqual({ kind: 'step', result: { progressed: false, waiting: 'attempt 1: work units u1, u2 are running in their own worktrees' } });
    expect(a.starts.sort()).toEqual(['u1', 'u2']);
    expect(existsSync(join(unitWorktree(lab.ctx(), 1, UNITS[0]!), 'apps', 'a.mjs'))).toBe(true);
    expect(data(MERGE_OVERHEAD_EVENT)).toHaveLength(1);
    expect(a.starts).toHaveLength(2);
    // Asked again while they run: nothing new starts.
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(a.starts).toHaveLength(2);
  });

  it('integrates each finished unit into the run\'s worktree, serially, and invalidates evidence', async () => {
    const script: Script = { edit: { u1: write('apps/a.mjs', 'export const a = 2;\n'), u2: write('apps/new.mjs', 'export const n = 1;\n') }, collect: {} };
    const { main } = await setup(script);
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    script.collect!.u1 = result();
    script.collect!.u2 = result();
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(out.kind).toBe('done');
    expect(readFileSync(join(main, 'apps', 'a.mjs'), 'utf8')).toBe('export const a = 2;\n');
    expect(readFileSync(join(main, 'apps', 'new.mjs'), 'utf8')).toBe('export const n = 1;\n');
    expect(data(UNIT_INTEGRATED_EVENT).map((e) => [e.unit, e.paths])).toEqual([
      ['u1', ['apps/a.mjs']],
      ['u2', ['apps/new.mjs']],
    ]);
    expect(existsSync(unitWorktree(lab.ctx(), 1, UNITS[0]!))).toBe(false);
    expect(out.kind === 'done' && out.workerId).toBeTruthy();
  });

  it('a unit that changes what integrated work already changed is a conflict: its work is dropped for the serial writer', async () => {
    const script: Script = { edit: { u1: write('apps/a.mjs', 'one\n'), u2: write('apps/a.mjs', 'two\n') }, collect: {} };
    const { main } = await setup(script);
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    script.collect!.u1 = result();
    script.collect!.u2 = result();
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(out).toMatchObject({ kind: 'serialize', units: [{ unit: 'u2', criteria: ['AC-2'], reason: 'conflict: apps/a.mjs already changed by integrated work' }] });
    expect(readFileSync(join(main, 'apps', 'a.mjs'), 'utf8')).toBe('one\n');
    expect(listDecisions(lab.db, lab.runId, { kind: 'scheduling.serialize' })).toHaveLength(1);
  });

  it('a crash after the integration intent was recorded finishes the same copy instead of calling its own files a conflict', async () => {
    const script: Script = { edit: { u1: write('apps/a.mjs', 'one\n'), u2: write('apps/b.mjs', 'two\n') }, collect: {} };
    const { main } = await setup(script);
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    // The first unit was half copied: its file is already in the run's worktree and its intent is recorded.
    writeFileSync(join(main, 'apps', 'a.mjs'), 'one\n');
    const w1 = lab.db.get<{ id: string }>("SELECT id FROM workers WHERE purpose = 'implement:1/u1#1'")!;
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, ?, 'x', ?)", lab.runId, lab.clock.now(), UNIT_INTEGRATING_EVENT, JSON.stringify({ attempt: 1, unit: 'u1', worker_id: w1.id, paths: ['apps/a.mjs'] }));
    script.collect!.u1 = result();
    script.collect!.u2 = result();
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(out.kind).toBe('done');
    expect(data(UNIT_SERIALIZED_EVENT)).toEqual([]);
  });

  it('copies deletions, symlinks and the executable bit, and never writes outside the worktree', async () => {
    const script: Script = {
      edit: {
        u1: (cwd) => {
          rmSync(join(cwd, 'apps', 'a.mjs'));
          writeFileSync(join(cwd, 'apps', 'run.sh'), '#!/bin/sh\n');
          chmodSync(join(cwd, 'apps', 'run.sh'), 0o755);
          symlinkSync('b.mjs', join(cwd, 'apps', 'link.mjs'));
        },
        u2: write('docs/x.md', 'x\n'),
      },
      collect: {},
    };
    const { main } = await setup(script);
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    script.collect!.u1 = result();
    script.collect!.u2 = result();
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(existsSync(join(main, 'apps', 'a.mjs'))).toBe(false);
    expect(statSync(join(main, 'apps', 'run.sh')).mode & 0o111).not.toBe(0);
    expect(lstatSync(join(main, 'apps', 'link.mjs')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(main, 'apps', 'link.mjs'))).toBe('b.mjs');
    expect(existsSync(join(main, 'docs', 'x.md'))).toBe(true);
    expect(existsSync(join(main, '..', 'escape.txt'))).toBe(false);
  });

  it('never copies a path that leaves the worktree it came from or the one it goes to', async () => {
    const script: Script = { collect: {} };
    const { main } = await setup(script);
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    const dir = unitWorktree(lab.ctx(), 1, UNITS[0]!);
    writeFileSync(join(dir, '..', 'escape.txt'), 'x');
    const w1 = lab.db.get<{ id: string }>("SELECT id FROM workers WHERE purpose = 'implement:1/u1#1'")!;
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, ?, 'x', ?)", lab.runId, lab.clock.now(), UNIT_INTEGRATING_EVENT, JSON.stringify({ attempt: 1, unit: 'u1', worker_id: w1.id, paths: ['../escape.txt'] }));
    script.collect!.u1 = result();
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(existsSync(join(main, '..', 'escape.txt'))).toBe(false);
    expect(existsSync(join(main, 'escape.txt'))).toBe(false);
    expect(data(UNIT_INTEGRATED_EVENT).map((e) => e.paths)).toEqual([['../escape.txt']]);
  });

  it('rejects a unit that adds a symlink leaving the repository, so a later unit cannot write through it', async () => {
    // Unit u1 links apps/staging to a directory outside the repository; u2 adds apps/staging/orbit.mjs in its
    // own checkout. The paths differ, so no exact-path conflict stops them.
    let outside = '';
    const script: Script = {
      edit: {
        u1: (cwd) => symlinkSync(outside, join(cwd, 'apps', 'staging')),
        u2: write('apps/staging/orbit.mjs', 'export const pwned = true;\n'),
      },
      collect: {},
    };
    const { main } = await setup(script);
    outside = join(lab.home, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'orbit.mjs'), 'canary\n');
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    script.collect!.u1 = result();
    script.collect!.u2 = result();
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(readFileSync(join(outside, 'orbit.mjs'), 'utf8')).toBe('canary\n');
    expect(lstatSync(join(main, 'apps', 'staging')).isSymbolicLink()).toBe(false);
    const [ser] = data(UNIT_SERIALIZED_EVENT);
    expect(ser).toMatchObject({ unit: 'u1', criteria: ['AC-1'] });
    expect(ser.reason).toMatch(/^rejected: symlink leaves the repository: apps\/staging/);
    expect(readFileSync(join(main, 'apps', 'staging', 'orbit.mjs'), 'utf8')).toBe('export const pwned = true;\n');
  });

  it('never writes beyond a symlink another unit integrated: the later unit is a conflict', async () => {
    // A link that stays inside the repository is accepted; a unit writing below it is refused by git apply.
    const script: Script = {
      edit: {
        u1: (cwd) => symlinkSync('../docs', join(cwd, 'apps', 'staging')),
        u2: write('apps/staging/orbit.mjs', 'export const x = 1;\n'),
      },
      collect: {},
    };
    const { main } = await setup(script);
    mkdirSync(join(main, 'docs'));
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    script.collect!.u1 = result();
    script.collect!.u2 = result();
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(readlinkSync(join(main, 'apps', 'staging'))).toBe('../docs');
    expect(existsSync(join(main, 'docs', 'orbit.mjs'))).toBe(false);
    expect(out).toMatchObject({ kind: 'serialize', units: [{ unit: 'u2', reason: expect.stringMatching(/^conflict: /) }] });
  });

  it('a unit whose session was lost, cancelled or failed transiently goes to the serial writer, with the reason', async () => {
    const script: Script = { collect: { u1: result({ status: 'lost', error: null }), u2: result({ status: 'transient_error', error: 'overloaded' }) } };
    await setup(script);
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(out).toMatchObject({ kind: 'serialize' });
    expect(data(UNIT_SERIALIZED_EVENT).map((e) => [e.unit, e.reason])).toEqual([
      ['u1', 'its session ended lost'],
      ['u2', 'its session ended transient_error (overloaded)'],
    ]);
  });

  it('a unit whose session was cancelled while the run is being cancelled ends the step', async () => {
    const script: Script = { collect: {} };
    await setup(script);
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    script.collect!.u1 = result({ status: 'cancelled' });
    requestCancel(lab.db, lab.runId, 'user', lab.clock);
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(out).toMatchObject({ kind: 'step', result: { done: true } });
  });

  it('a unit cancelled for another reason is serialized, and a paused run waits', async () => {
    const script: Script = { collect: {} };
    await setup(script);
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    script.collect!.u1 = result({ status: 'cancelled' });
    script.collect!.u2 = result({ status: 'lost' });
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(out.kind).toBe('serialize');
    setPaused(lab.db, lab.runId, true, 'user', lab.clock);
  });

  it('an authentication failure of a unit blocks the run on the credentials', async () => {
    const script: Script = { collect: {} };
    await setup(script);
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    script.collect!.u1 = result({ status: 'auth_failed', error: 'rejected' });
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(out).toMatchObject({ kind: 'step', result: { done: true } });
    expect(lab.db.get<{ state: string }>('SELECT state FROM runs WHERE id = ?', lab.runId)?.state).toBe('BLOCKED');
  });

  it('with nothing started and capacity held by other runs, waits for it to clear and says why', async () => {
    const { a } = await setup({ collect: {} }, undefined, { availableParallelism: () => 1, freemem: () => 64_000 * 1024 * 1024 });
    const busy = Array.from({ length: 4 }, (_, i) => ({ runId: 'orb-other', unit: { id: `other-${i}`, role: 'implementer' as const, writer: true, ownedPaths: [`x${i}/**`], dependsOn: [], revision: null, cancelWhen: [], budget: {}, provider: 'claude', worktree: `/wt/other-${i}`, status: 'running' as const } }));
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options({ running: () => busy }));
    expect(out.kind).toBe('step');
    expect(out).toMatchObject({ result: { progressed: false, waiting: expect.stringMatching(/^work units of attempt 1 deferred: /) } });
    expect(a.starts).toEqual([]);
  });

  it('with a budget that cannot fund another writer and nothing running, gives every unit to the serial writer', async () => {
    const { a } = await setup({ collect: {} });
    // Spend nearly all of the model budget: no session cap is left to share between the units.
    lab.db.run("UPDATE budget_counters SET used = hard_cap - 0.001 WHERE counter = 'cost_usd'");
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(out.kind === 'serialize' || out.kind === 'step').toBe(true);
    expect(a.starts).toEqual([]);
    if (out.kind === 'serialize') expect(out.units.every((u) => u.reason.startsWith('not admitted as a parallel writer'))).toBe(true);
  });

  it('counts the run\'s own live units against the plan: units that do not fit go to the serial writer with the reason', async () => {
    const { a } = await setup({ collect: {} });
    const own = { runId: lab.runId, unit: { id: 'implement:1/u9', role: 'implementer' as const, writer: true, ownedPaths: ['elsewhere/**'], dependsOn: [], revision: null, cancelWhen: [], budget: {}, provider: 'claude', worktree: '/wt/u9', status: 'running' as const } };
    const busy = lab.db.get<{ id: string }>('SELECT id FROM runs LIMIT 1')!;
    lab.db.run("INSERT INTO workers (id, run_id, role, purpose, provider, state, worker_dir, cwd, created_at) VALUES ('wrk-held', ?, 'implementer', 'implement:0', 'claude', 'RUNNING', '/wd', '/wt', 1)", busy.id);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'worker.spend-cap', 'x', ?)", lab.runId, JSON.stringify({ purpose: 'implement:0', cap_usd: 1_000_000, worst_case_usd: 1 }));
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options({ running: () => [own] }));
    expect(a.starts).toEqual([]);
    if (out.kind !== 'serialize') throw new Error(`expected serialize, got ${JSON.stringify(out)}`);
    expect(out.units).toHaveLength(2);
    expect(out.units.every((u) => u.reason === 'not admitted as a parallel writer: at capacity: 2 active of 2 (limited by requested parallelism)')).toBe(true);
  });

  it('units the budget cannot admit start nothing and go to the serial writer with the budget as the reason', async () => {
    const { a } = await setup({ collect: {} });
    const reserve = lab.ctx().ledger!.reserve().cost_usd;
    lab.db.run("UPDATE budget_counters SET used = hard_cap - ? WHERE counter = 'cost_usd'", reserve + 0.01);
    const out = await runParallelUnits(lab.ctx(), 1, UNITS, options());
    expect(a.starts).toEqual([]);
    if (out.kind !== 'serialize') throw new Error(`expected serialize, got ${JSON.stringify(out)}`);
    expect(out.units).toHaveLength(2);
    expect(out.units.every((u) => u.reason.startsWith('not admitted as a parallel writer: not admitted by budget: cost exceeds'))).toBe(true);
  });

  it('shares the spend cap of the sessions to start between them and records each unit\'s share', async () => {
    await setup({ collect: {} });
    await runParallelUnits(lab.ctx(), 1, UNITS, options());
    const caps = data('worker.spend-cap');
    expect(caps).toHaveLength(2);
    expect(caps[0].cap_usd).toBe(caps[1].cap_usd);
    expect(caps.map((c) => c.purpose)).toEqual(['implement:1/u1#1', 'implement:1/u2#1']);
  });
});
