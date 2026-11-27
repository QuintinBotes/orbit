// Issue #167: every way a run can end stores why (runs.failure_class, runs.failure_secondary), every run stores the
// Orbit version that started it (runs.orbit_version), and neither can carry anything but a class name or a version.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { hostname, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ORBIT_VERSION } from '../../../src/cli/version.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import type { BlockedCheck } from '../../../src/controller/environment-block.ts';
import { FAILURE_CLASSES, isFailureClass } from '../../../src/controller/failure-class.ts';
import { buildFinalReport, renderMarkdown } from '../../../src/controller/report.ts';
import { acquireLease, createRun, getRun, listRuns, requestCancel, transition, UNKNOWN_ORBIT_VERSION } from '../../../src/controller/run-store.ts';
import { blockOnOpenQuestions, finishRun, safePoint } from '../../../src/controller/steps/common.ts';
import { blockOnBaseline } from '../../../src/controller/steps/preflight.ts';
import { TERMINAL_STATES, type RunState } from '../../../src/core/run-states.ts';
import type { BaselineReport } from '../../../src/evidence/baseline.ts';
import { insertQuestion } from '../../../src/inquisition/store.ts';
import { buildTimeline } from '../../../src/observability/timeline.ts';
import { renderHeader } from '../../../src/cli/commands/timeline.ts';
import { enterRecovery, exhaustRecovery } from '../../../src/recovery/budget.ts';
import { authBlocker, blockRunOnCredentials } from '../../../src/recovery/credentials.ts';
import { DEFAULT_WATCHDOG, watchdogTick } from '../../../src/recovery/watchdog.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { MIGRATIONS } from '../../../src/storage/schema.ts';
import { counters, makeRun, setup } from '../recovery/helpers.ts';
import { BASE_REV, initLedger, makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab | undefined;
const dirs: string[] = [];
const open: OrbitDb[] = [];
afterEach(() => {
  lab?.cleanup();
  lab = undefined;
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ended = (db: OrbitDb, id: string) => {
  const run = getRun(db, id);
  return { state: run.state, cls: run.failureClass, secondary: run.failureSecondary };
};
/** The data of the transition that ended the run, as the timeline reads it. */
const endEvent = (db: OrbitDb, id: string): Record<string, unknown> => {
  const row = db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id DESC LIMIT 1", id)!;
  return JSON.parse(row.data_json) as Record<string, unknown>;
};

const TO_REVIEWING: RunState[] = ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'];

describe('the Orbit version that started a run (FR-003)', () => {
  it('is stored with the run and in its run.created event', () => {
    lab = makeUnitLab();
    expect(getRun(lab.db, lab.runId).orbitVersion).toBe(ORBIT_VERSION);
    const created = lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'run.created'", lab.runId)!;
    expect(JSON.parse(created.data_json)).toMatchObject({ orbit_version: ORBIT_VERSION });
  });

  it('is the version the caller names, and stays that one when the run ends, blocks and resumes', () => {
    const { db, clock } = setup();
    open.push(db);
    createRun(db, { id: 'r1', repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p', orbitVersion: '0.4.0-rc.1' }, clock);
    acquireLease(db, 'r1', 'o', 60_000, clock);
    transition(db, { runId: 'r1', to: 'PREFLIGHT', ownerId: 'o', reason: 'go' }, clock);
    transition(db, { runId: 'r1', to: 'BLOCKED', ownerId: 'o', reason: 'wait' }, clock);
    transition(db, { runId: 'r1', to: 'PREFLIGHT', ownerId: 'o', reason: 'resumed' }, clock);
    expect(getRun(db, 'r1').orbitVersion).toBe('0.4.0-rc.1');
    expect(listRuns(db)[0]!.orbitVersion).toBe('0.4.0-rc.1');
  });

  it('stores nothing but a version: a value that is not one is recorded as unknown', () => {
    const { db, clock } = setup();
    open.push(db);
    for (const [i, bad] of [`${homedir()}/orbit`, 'token=not-a-real-token ', '', 'a'.repeat(80), '1.0.0\nsecret'].entries()) {
      createRun(db, { id: `r${i}`, repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p', orbitVersion: bad }, clock);
      expect(getRun(db, `r${i}`).orbitVersion, bad).toBe(UNKNOWN_ORBIT_VERSION);
    }
  });
});

describe('every way a run ends records why (FR-001, FR-002)', () => {
  it('a broken check environment is environment (US1 scenario 1)', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    const report: BaselineReport = {
      schema: 'orbit.baseline/1',
      runId: lab.runId,
      baseRevision: BASE_REV,
      baseTree: 'b'.repeat(40),
      policyHash: ctx.run.policyHash,
      checkIds: ['unit'],
      install: { skipped: true, reason: null, ok: false },
      checks: [{ checkId: 'unit', mandatory: true, status: 'FAILED', exitCode: 1, flaky: false, fingerprint: 'fp:1', excerpt: null, log: join(ctx.runDir, 'baseline', 'unit.log') }],
      failures: [{ checkId: 'unit', fingerprint: 'fp:1', excerpt: null }],
      complete: false,
      recordedAt: lab.clock.now(),
    };
    const broken: BlockedCheck = { checkId: 'unit', fingerprint: 'fp:1', signals: ['process-aborted'], cause: 'the process was killed by a fatal signal before it printed anything of its own (SIGABRT)', lines: [], questionId: null };
    await blockOnBaseline(ctx, report, { environment: [broken], incomplete: [], misconfigured: [] });
    expect(ended(lab.db, lab.runId)).toEqual({ state: 'BLOCKED', cls: 'environment', secondary: null });
    expect(endEvent(lab.db, lab.runId)).toMatchObject({ failure_class: 'environment' });
    expect(endEvent(lab.db, lab.runId)).not.toHaveProperty('failure_secondary');
  });

  it('success has no class (US1 scenario 2)', async () => {
    lab = makeUnitLab({ path: TO_REVIEWING });
    await finishRun(lab.ctx(), 'SUCCEEDED', 'all mandatory requirements hold', { outcome: { tree: 't' } });
    expect(ended(lab.db, lab.runId)).toEqual({ state: 'SUCCEEDED', cls: null, secondary: null });
    expect(endEvent(lab.db, lab.runId)).not.toHaveProperty('failure_class');
  });

  it('a stop is cancelled, also when it outranks what the step had decided (edge case 3)', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await finishRun(lab.ctx(), 'CANCELLED', 'cancelled by test (orbit cancel)');
    expect(ended(lab.db, lab.runId)).toEqual({ state: 'CANCELLED', cls: 'cancelled', secondary: null });
    lab.cleanup();

    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    requestCancel(lab.db, lab.runId, 'user', lab.clock);
    await finishRun(lab.ctx(), 'BLOCKED', 'needs a person', { outcome: { environment_failures: [{ check_id: 'unit' }] } });
    expect(ended(lab.db, lab.runId)).toEqual({ state: 'CANCELLED', cls: 'cancelled', secondary: null });
    lab.cleanup();

    // A stop requested at a safe point.
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    requestCancel(lab.db, lab.runId, 'user', lab.clock);
    await safePoint(lab.ctx());
    expect(ended(lab.db, lab.runId)).toEqual({ state: 'CANCELLED', cls: 'cancelled', secondary: null });
  });

  it('a spent budget is budget: the cost cap at a safe point', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'] });
    initLedger(lab);
    lab.db.run("UPDATE budget_counters SET used = hard_cap WHERE run_id = ? AND counter = 'cost_usd'", lab.runId);
    await safePoint(lab.ctx());
    // Issue #254: the cost cap waits BLOCKED for a person, and is still recorded as a budget stop.
    expect(ended(lab.db, lab.runId)).toEqual({ state: 'BLOCKED', cls: 'budget', secondary: null });
  });

  it('a crash that used every recovery attempt is environment, with the budget as the second cause', () => {
    const { db, clock } = setup();
    open.push(db);
    makeRun(db, clock, 'r1', 'ctl-1');
    exhaustRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', why: 'lost implementer wrk-1 cannot be restarted' });
    expect(ended(db, 'r1')).toEqual({ state: 'EXHAUSTED', cls: 'environment', secondary: 'budget' });

    makeRun(db, clock, 'r2', 'ctl-1');
    counters(db, 'r2', { recovery_attempts: 1 });
    enterRecovery(db, clock, { runId: 'r2', ownerId: 'ctl-1', reason: 'crash 1' });
    expect(enterRecovery(db, clock, { runId: 'r2', ownerId: 'ctl-1', reason: 'crash 2' }).outcome).toBe('exhausted');
    expect(ended(db, 'r2')).toEqual({ state: 'EXHAUSTED', cls: 'environment', secondary: 'budget' });
    expect(endEvent(db, 'r2')).toMatchObject({ failure_class: 'environment', failure_secondary: 'budget' });
  });

  it('a recovery the watchdog gave up on is environment', async () => {
    const { db, clock } = setup();
    open.push(db);
    makeRun(db, clock, 'r1', 'ctl-1', ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'RECOVERING']);
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.RECOVERING! + 60_000);
    acquireLease(db, 'r1', 'ctl-1', 60_000, clock);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', adapters: {}, workerActivityAt: () => null, config: { graceMs: 50 } });
    expect(rep.findings[0]).toMatchObject({ action: 'blocked' });
    expect(ended(db, 'r1')).toEqual({ state: 'BLOCKED', cls: 'environment', secondary: null });
  });

  it('a run that waits on a question for a person is awaiting-decision (issue #190)', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    insertQuestion(
      lab.db,
      { id: 'q-1', runId: lab.runId, mode: 'clarify', question: 'Which behaviour?', evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: true, affected: ['AC-2'], unblocked: [] },
      lab.clock,
    );
    expect(await blockOnOpenQuestions(lab.ctx(), 'delivery')).toEqual({ progressed: true, done: true });
    expect(ended(lab.db, lab.runId)).toEqual({ state: 'BLOCKED', cls: 'awaiting-decision', secondary: null });
  });

  it('missing credentials are credentials', () => {
    const { db, clock } = setup();
    open.push(db);
    makeRun(db, clock, 'r1', 'ctl-1');
    blockRunOnCredentials(db, clock, 'ctl-1', 'r1', authBlocker({ provider: 'claude', state: 'expired', runId: 'r1', env: {} }));
    expect(ended(db, 'r1')).toEqual({ state: 'BLOCKED', cls: 'credentials', secondary: null });
  });

  it('attempts spent on sessions that ended at their turn cap are turn-cap, with the budget second (edge case 1)', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'DIAGNOSING'] });
    lab.db.tx(() => appendEvent(lab!.db, lab!.runId, 'implementation.worker-ended', 'ctl-unit', { attempt: 1, status: 'max_turns', error: null }, lab!.clock.now()));
    lab.db.tx(() => appendEvent(lab!.db, lab!.runId, 'implementation.worker-ended', 'ctl-unit', { attempt: 2, status: 'timeout', error: null }, lab!.clock.now()));
    await finishRun(lab.ctx(), 'EXHAUSTED', 'implementation attempts hard cap reached (5 of 5); the last failure was fp:1', { outcome: { fingerprint: 'fp:1' } });
    expect(ended(lab.db, lab.runId)).toEqual({ state: 'EXHAUSTED', cls: 'turn-cap', secondary: 'budget' });
  });

  it('a session that ended some other way is not a turn cap', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'DIAGNOSING'] });
    lab.db.tx(() => appendEvent(lab!.db, lab!.runId, 'implementation.worker-ended', 'ctl-unit', { attempt: 1, status: 'timeout', error: null }, lab!.clock.now()));
    await finishRun(lab.ctx(), 'EXHAUSTED', 'implementation attempts hard cap reached (5 of 5); the last failure was fp:1', { outcome: { fingerprint: 'fp:1' } });
    expect(ended(lab.db, lab.runId)).toEqual({ state: 'EXHAUSTED', cls: 'model', secondary: 'budget' });
  });

  it('the cause a step names is used where the records carry no marker', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await finishRun(lab.ctx(), 'BLOCKED', 'CI did not finish within 60 minutes', { outcome: { branch: 'b', commit: 'c', pr: null }, cause: 'environment' });
    expect(ended(lab.db, lab.runId)).toEqual({ state: 'BLOCKED', cls: 'environment', secondary: null });
  });

  it('no transition into a terminal state can leave the class out: the store sets it, whoever asks', () => {
    const from: Record<string, RunState[]> = { SUCCEEDED: TO_REVIEWING, BLOCKED: ['PREFLIGHT'], EXHAUSTED: ['PREFLIGHT'], IMPOSSIBLE: ['PREFLIGHT'], CANCELLED: [] };
    expect(Object.keys(from).sort()).toEqual([...TERMINAL_STATES].sort());
    const { db, clock } = setup();
    open.push(db);
    for (const state of TERMINAL_STATES) {
      const id = `r-${state}`;
      makeRun(db, clock, id, 'o', from[state]!);
      transition(db, { runId: id, to: state, ownerId: 'o', reason: 'ended' }, clock);
      const run = getRun(db, id);
      if (state === 'SUCCEEDED') expect(run.failureClass).toBeNull();
      else expect(isFailureClass(run.failureClass), state).toBe(true);
    }
    expect(getRun(db, 'r-CANCELLED').failureClass).toBe('cancelled');
    expect(getRun(db, 'r-EXHAUSTED').failureClass).toBe('budget');
  });

  it('a blocked run that is resumed has no class again, and gets a new one when it ends again', () => {
    const { db, clock } = setup();
    open.push(db);
    makeRun(db, clock, 'r1', 'o', ['PREFLIGHT']);
    transition(db, { runId: 'r1', to: 'BLOCKED', ownerId: 'o', reason: 'env', patch: { outcomeReason: 'env', outcomeJson: JSON.stringify({ reviewer: { ok: false }, questions: ['q-1'] }) } }, clock);
    expect(ended(db, 'r1')).toEqual({ state: 'BLOCKED', cls: 'environment', secondary: 'awaiting-decision' });
    transition(db, { runId: 'r1', to: 'PREFLIGHT', ownerId: 'o', reason: 'resumed' }, clock);
    expect(ended(db, 'r1')).toEqual({ state: 'PREFLIGHT', cls: null, secondary: null });
    transition(db, { runId: 'r1', to: 'BLOCKED', ownerId: 'o', reason: 'again' }, clock);
    transition(db, { runId: 'r1', to: 'CANCELLED', ownerId: 'o', reason: 'cancelled' }, clock);
    expect(ended(db, 'r1')).toEqual({ state: 'CANCELLED', cls: 'cancelled', secondary: null });
  });
});

describe('what the record may hold', () => {
  it('only a class name: a reason and an outcome full of paths, the host name and a token leave no trace in it', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const secret = 'not-a-real-token-167';
    const noisy = `check failed in ${homedir()}/project on ${hostname()} with ANTHROPIC_API_KEY=${secret}`;
    await finishRun(lab.ctx(), 'BLOCKED', noisy, { outcome: { environment_failures: [{ check_id: 'unit', cause: noisy, log_path: `${homedir()}/x.log` }], note: noisy }, data: { code: noisy } });
    const row = lab.db.get<{ failure_class: string | null; failure_secondary: string | null; orbit_version: string | null }>('SELECT failure_class, failure_secondary, orbit_version FROM runs WHERE id = ?', lab.runId)!;
    expect(row).toEqual({ failure_class: 'environment', failure_secondary: null, orbit_version: ORBIT_VERSION });
    const event = endEvent(lab.db, lab.runId);
    expect(FAILURE_CLASSES).toContain(event.failure_class);
    for (const value of [row.failure_class, row.failure_secondary, row.orbit_version, event.failure_class]) {
      for (const leak of [homedir(), hostname(), secret]) expect(String(value)).not.toContain(leak);
    }
  });

  it('a class the caller names that is not on the list is refused', () => {
    const { db, clock } = setup();
    open.push(db);
    makeRun(db, clock, 'r1', 'o', ['PREFLIGHT']);
    expect(() => transition(db, { runId: 'r1', to: 'BLOCKED', ownerId: 'o', reason: 'x', cause: `${homedir()}/secret` as never }, clock)).toThrow(/not a failure class/);
    expect(getRun(db, 'r1').state).toBe('PREFLIGHT');
  });
});

describe('a state database written before this change', () => {
  const V6 = MIGRATIONS.slice(0, 6);
  const oldDb = (name: string): { path: string; db: OrbitDb } => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-167-'));
    dirs.push(dir);
    const path = join(dir, name);
    const db = openDb(path, { migrations: V6 });
    db.run("INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, outcome_reason, created_at, updated_at, ended_at) VALUES ('old-ok', '/repo', 'g', 'autonomous', 'SUCCEEDED', 'sha256:x', '/p', 'done', 1, 2, 2)");
    db.run("INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, outcome_reason, outcome_json, created_at, updated_at, ended_at) VALUES ('old-blocked', '/repo', 'g', 'autonomous', 'BLOCKED', 'sha256:x', '/p', 'environment gate: git is missing', '{\"state\":\"BLOCKED\"}', 3, 4, 4)");
    return { path, db };
  };

  it('migrates in place, keeps its runs, and loads them with no class and no version (edge case 2)', () => {
    const { path, db: old } = oldDb('state.sqlite');
    old.close();
    const db = openDb(path);
    open.push(db);
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(7);
    expect(listRuns(db).map((r) => [r.id, r.state, r.failureClass, r.failureSecondary, r.orbitVersion])).toEqual([
      ['old-blocked', 'BLOCKED', null, null, null],
      ['old-ok', 'SUCCEEDED', null, null, null],
    ]);
    expect(getRun(db, 'old-blocked').outcomeReason).toBe('environment gate: git is missing');
  });

  it('shows version unknown and no class for such a run, in the report and the timeline', () => {
    const { path, db: old } = oldDb('state.sqlite');
    old.close();
    const db = openDb(path);
    open.push(db);
    const run = getRun(db, 'old-blocked');
    const report = buildFinalReport(db, run, { runDir: join(tmpdir(), 'orbit-167-no-such-run-dir'), clock: new ManualClock(), snapshot: null });
    expect(report).toMatchObject({ orbit_version: 'unknown', failure_class: null, failure_secondary: null });
    const md = renderMarkdown(report);
    expect(md).toContain('Orbit version: unknown');
    expect(md).toContain('Failure class: none');
    const timeline = buildTimeline(db, run);
    expect(timeline.run).toMatchObject({ orbit_version: 'unknown', failure_class: null, failure_secondary: null });
    expect(renderHeader(timeline)).toContain('orbit:     unknown');
  });

  it('an old blocked run that is resumed and ends again under this version gets its class, and keeps version unknown', () => {
    const { path, db: old } = oldDb('state.sqlite');
    old.close();
    const db = openDb(path);
    open.push(db);
    const clock = new ManualClock();
    acquireLease(db, 'old-blocked', 'o', 60_000, clock);
    transition(db, { runId: 'old-blocked', to: 'PREFLIGHT', ownerId: 'o', reason: 'resumed' }, clock);
    transition(db, { runId: 'old-blocked', to: 'CANCELLED', ownerId: 'o', reason: 'cancelled' }, clock);
    expect(getRun(db, 'old-blocked')).toMatchObject({ failureClass: 'cancelled', orbitVersion: null });
  });

  it('is not migrated while a run lease is live, and is left at its version', () => {
    const { path, db: old } = oldDb('leased.sqlite');
    const now = Date.now();
    old.run('INSERT INTO leases (run_id, owner_id, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?)', 'old-blocked', 'older-orbit', now, now, now + 60_000);
    old.close();
    expect(() => openDb(path)).toThrow(/Cannot migrate the state database while an older Orbit is driving these runs: old-blocked \(owner older-orbit\)/);
    const still = openDb(path, { migrations: V6 });
    open.push(still);
    expect(still.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(6);
    expect(still.all<{ name: string }>("SELECT name FROM pragma_table_info('runs')").map((c) => c.name)).not.toContain('failure_class');
  });
});

describe('the report and the timeline show both (FR-004)', () => {
  it('the final report carries the class, the secondary class and the version, as JSON and as text', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    await finishRun(ctx, 'BLOCKED', 'no reviewer', { outcome: { reviewer: { ok: false }, questions: ['q-1'] } });
    const saved = JSON.parse(readFileSync(join(ctx.runDir, 'final.json'), 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ failure_class: 'environment', failure_secondary: 'awaiting-decision', orbit_version: ORBIT_VERSION });
    const md = readFileSync(join(ctx.runDir, 'final.md'), 'utf8');
    expect(md).toContain('Failure class: environment (secondary: awaiting-decision)');
    expect(md).toContain(`Orbit version: ${ORBIT_VERSION}`);
  });

  it('the report of a run that succeeded says there is no failure class', async () => {
    lab = makeUnitLab({ path: TO_REVIEWING });
    const ctx = lab.ctx();
    await finishRun(ctx, 'SUCCEEDED', 'all mandatory requirements hold');
    expect(JSON.parse(readFileSync(join(ctx.runDir, 'final.json'), 'utf8'))).toMatchObject({ failure_class: null, failure_secondary: null, orbit_version: ORBIT_VERSION });
    expect(readFileSync(join(ctx.runDir, 'final.md'), 'utf8')).toContain('Failure class: none');
  });

  it('the timeline carries them on the run, on the entry that created it and on the entry that ended it', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await finishRun(lab.ctx(), 'BLOCKED', 'no reviewer', { outcome: { reviewer: { ok: false }, questions: ['q-1'] } });
    const t = buildTimeline(lab.db, getRun(lab.db, lab.runId));
    expect(t.run).toMatchObject({ failure_class: 'environment', failure_secondary: 'awaiting-decision', orbit_version: ORBIT_VERSION });
    const created = t.entries.find((e) => e.event === 'run.created')!;
    expect(created.data).toMatchObject({ orbit_version: ORBIT_VERSION });
    expect(created.text).toContain(`by Orbit ${ORBIT_VERSION}`);
    const last = t.entries.filter((e) => e.event === 'state.transition').at(-1)!;
    expect(last.data).toMatchObject({ failure_class: 'environment', failure_secondary: 'awaiting-decision' });
    expect(last.text).toContain('[environment, secondary awaiting-decision]');
    const header = renderHeader(t);
    expect(header).toContain(`orbit:     ${ORBIT_VERSION}`);
    expect(header).toContain('class:     environment (secondary: awaiting-decision)');
  });
});
