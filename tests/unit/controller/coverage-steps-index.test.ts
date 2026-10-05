import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { OrbitError } from '../../../src/core/errors.ts';
import { getRun, requestCancel, transition } from '../../../src/controller/run-store.ts';
import { STEP_ERROR_EVENT, STEPS, finalizeRun, step, type StepFn } from '../../../src/controller/steps/index.ts';
import type { RunContext } from '../../../src/controller/context.ts';
import { initLedger, makeUnitLab, OWNER, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
const steps = STEPS as unknown as Record<string, StepFn | undefined>;
const saved: Record<string, StepFn | undefined> = {};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) steps[k] = v;
  for (const k of Object.keys(saved)) delete saved[k];
  lab?.cleanup();
});

function stub(state: string, fn: StepFn | undefined): void {
  if (!(state in saved)) saved[state] = steps[state];
  if (fn) steps[state] = fn;
  else delete steps[state];
}

const signal = () => new AbortController().signal;
const events = (type: string) => lab.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', lab.runId, type);

describe('step dispatch', () => {
  it('has a step for every working state, and finalizeRun is re-exported for the loop', () => {
    for (const s of ['CREATED', 'PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'REPAIRING', 'VERIFYING', 'DIAGNOSING', 'REVIEWING', 'DELIVERING', 'AWAITING_CI', 'INQUISITION', 'RECOVERING']) expect(typeof steps[s], s).toBe('function');
    expect(steps.REPAIRING).toBe(steps.IMPLEMENTING);
    expect(typeof finalizeRun).toBe('function');
  });

  it('runs the step of the run\'s state and returns its result', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    stub('PREFLIGHT', async (ctx: RunContext) => ({ progressed: true, waiting: ctx.run.state }));
    expect(await step(lab.deps, lab.runId, signal())).toEqual({ progressed: true, waiting: 'PREFLIGHT' });
  });

  it('a terminal run has nothing to do, and a state with no step is an internal error', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    stub('PREFLIGHT', undefined);
    await expect(step(lab.deps, lab.runId, signal())).rejects.toMatchObject({ code: 'INTERNAL', message: 'no step for state PREFLIGHT' });
    transition(lab.db, { runId: lab.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'x' }, lab.clock);
    expect(await step(lab.deps, lab.runId, signal())).toEqual({ progressed: false, done: true });
  });
});

describe('a run whose authority cannot be verified', () => {
  it('blocks when the policy snapshot no longer matches its hash, and stops there', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const policy = getRun(lab.db, lab.runId).policyPath;
    chmodSync(policy, 0o644);
    writeFileSync(policy, '{}');
    const out = await step(lab.deps, lab.runId, signal());
    expect(out).toEqual({ progressed: true, done: true });
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('BLOCKED');
    expect(run.outcomeReason).toMatch(/^POLICY_TAMPERED: /);
  });

  it('blocks on a stored contract that no longer validates', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    lab.db.run("UPDATE runs SET contract_json = '{}' WHERE id = ?", lab.runId);
    await step(lab.deps, lab.runId, signal());
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^CONTRACT_INVALID: /);
  });

  it('a run that already ended is not blocked again, and any other load failure surfaces', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const policy = getRun(lab.db, lab.runId).policyPath;
    chmodSync(policy, 0o644);
    writeFileSync(policy, '{}');
    transition(lab.db, { runId: lab.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'x' }, lab.clock);
    expect(await step(lab.deps, lab.runId, signal())).toEqual({ progressed: false, done: true });
    await expect(step(lab.deps, 'orb-missing', signal())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a step that throws', () => {
  it('lets an aborted step and a lost lease propagate to the loop', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ac = new AbortController();
    stub('PREFLIGHT', async () => {
      ac.abort();
      throw new Error('aborted mid-step');
    });
    await expect(step(lab.deps, lab.runId, ac.signal)).rejects.toThrow('aborted mid-step');
    stub('PREFLIGHT', async () => {
      throw new OrbitError('LEASE_LOST', 'lease gone');
    });
    await expect(step(lab.deps, lab.runId, signal())).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('a cancellation or a concurrent update that landed mid-step is a wait for the next safe point', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    for (const code of ['CANCELLED', 'CONCURRENT_UPDATE'] as const) {
      stub('PREFLIGHT', async () => {
        throw new OrbitError(code, `${code} happened`);
      });
      expect(await step(lab.deps, lab.runId, signal())).toEqual({ progressed: false, waiting: `${code} happened` });
    }
    expect(getRun(lab.db, lab.runId).state).toBe('PREFLIGHT');
  });

  it('a run another actor ended during the step is done, not blocked', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    stub('PREFLIGHT', async () => {
      transition(lab.db, { runId: lab.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'x' }, lab.clock);
      throw new Error('late failure');
    });
    expect(await step(lab.deps, lab.runId, signal())).toEqual({ progressed: false, done: true });
  });

  it('an error that maps to an outcome ends the run that way', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    stub('PREFLIGHT', async () => {
      throw new OrbitError('SCOPE_VIOLATION', 'wrote outside scope');
    });
    expect(await step(lab.deps, lab.runId, signal())).toEqual({ progressed: true, done: true });
    expect(getRun(lab.db, lab.runId)).toMatchObject({ state: 'BLOCKED', outcomeReason: 'SCOPE_VIOLATION: wrote outside scope' });
  });
});

describe('infrastructure retries', () => {
  it('without a budget retries a failing step a bounded number of times and then blocks with the last error', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    stub('PREFLIGHT', async () => {
      throw new OrbitError('GIT_FAILED', 'git broke sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF');
    });
    for (let i = 1; i <= 4; i++) {
      const out = await step(lab.deps, lab.runId, signal());
      expect(out.waiting).toMatch(/^step failed \(GIT_FAILED\); retrying: git broke/);
      expect(out.waiting).not.toContain('abcdefghijklmnopqrstuvwxyz');
    }
    expect(await step(lab.deps, lab.runId, signal())).toEqual({ progressed: true, done: true });
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('BLOCKED');
    expect(run.outcomeReason).toContain('PREFLIGHT failed 5 time(s); last error GIT_FAILED: git broke');
    expect(events(STEP_ERROR_EVENT)).toHaveLength(5);
    expect(JSON.parse(events(STEP_ERROR_EVENT)[0]!.data_json)).toMatchObject({ state: 'PREFLIGHT', code: 'GIT_FAILED' });
  });

  it('counts the failures of the current state only: a transition starts the count again', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    let fail = true;
    stub('PREFLIGHT', async () => {
      if (fail) throw new Error('flaky');
      return { progressed: false };
    });
    for (let i = 0; i < 3; i++) await step(lab.deps, lab.runId, signal());
    fail = false;
    expect(await step(lab.deps, lab.runId, signal())).toEqual({ progressed: false });
    transition(lab.db, { runId: lab.runId, to: 'CONTRACTING', ownerId: OWNER, reason: 'x' }, lab.clock);
    stub('CONTRACTING', async () => {
      throw 'plain string failure';
    });
    const out = await step(lab.deps, lab.runId, signal());
    expect(out.waiting).toBe('step failed (INTERNAL); retrying: plain string failure');
  });

  it('with a budget each failure spends one infrastructure retry, and a spent budget blocks at once', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    stub('PREFLIGHT', async () => {
      throw new Error('transient');
    });
    const before = lab.ctx().ledger!.state('infrastructure_retries').used;
    expect((await step(lab.deps, lab.runId, signal())).waiting).toMatch(/retrying/);
    expect(lab.ctx().ledger!.state('infrastructure_retries').used).toBe(before + 1);
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'infrastructure_retries'");
    expect(await step(lab.deps, lab.runId, signal())).toEqual({ progressed: true, done: true });
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('PREFLIGHT failed 2 time(s)');
  });

  it('any other failure of the ledger surfaces from the retry itself', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    stub('PREFLIGHT', async (ctx) => {
      ctx.ledger!.consume = () => {
        throw new Error('ledger down');
      };
      throw new Error('step failed');
    });
    await expect(step(lab.deps, lab.runId, signal())).rejects.toThrow('ledger down');
  });

  it('a cancellation requested in the meantime is taken at the next safe point, not by the retry', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    stub('PREFLIGHT', async () => {
      requestCancel(lab.db, lab.runId, 'user', lab.clock);
      throw new Error('failed while cancelling');
    });
    const out = await step(lab.deps, lab.runId, signal());
    expect(out.waiting).toMatch(/retrying/);
    expect(getRun(lab.db, lab.runId).state).toBe('PREFLIGHT');
  });
});
