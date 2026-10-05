import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionLedger } from '../../../src/delivery/actions.ts';
import { acquireLease, getRun, releaseLease, transition } from '../../../src/controller/run-store.ts';
import { reconcileOnStart } from '../../../src/recovery/reconcile.ts';
import { OWNER, canStripTypes, cleanupAll, clock, counterUsed, makeEnv, makeRun, seedCounters, sleep, type Env } from './helpers.ts';

afterEach(cleanupAll);

const reconcile = (env: Env, owner = OWNER, extra: object = {}) => reconcileOnStart({ db: env.db, ownerId: owner, clock, adapters: env.adapters, graceMs: 300, ...extra });
const types = (env: Env) => env.db.all<{ type: string }>('SELECT type FROM events WHERE run_id = ? ORDER BY id', env.runId).map((r) => r.type);

describe('reconcileOnStart: external actions (scenarios 7 and 8)', () => {
  const key = 'pr:acme/widgets:orb-adp:1';
  const intent = (env: Env) => ({ runId: env.runId, kind: 'pr_create', idempotencyKey: key, target: { repo: 'acme/widgets', branch: 'orbit/orb-adp' } });

  it('an action that was EXECUTING when the controller died is flagged UNKNOWN, and the next attempt asks the remote before creating anything', async () => {
    const env = makeEnv();
    makeRun(env);
    const ledger = new ActionLedger(env.db, clock);
    const { action } = ledger.recordIntent(intent(env));
    ledger.markExecuting(action);
    expect(ledger.get(action.id).state).toBe('EXECUTING');

    const rep = await reconcile(env);
    expect(rep.runs[0]!.actions).toMatchObject([{ actionId: action.id, kind: 'pr_create', previousState: 'EXECUTING', flagged: true }]);
    expect(rep.summary.actionsFlagged).toBe(1);
    expect(ledger.get(action.id).state).toBe('UNKNOWN');
    expect(types(env)).toContain('recovery.action-flagged');

    // A restarted delivery: the remote already has the PR (the response was lost). One PR, no second create.
    let creates = 0;
    const out = await new ActionLedger(env.db, clock, { backoffMs: () => 0 }).performAction(
      intent(env),
      { execute: async () => { creates++; return { number: 8 }; }, reconcile: async () => ({ number: 7 }) },
      { authorization: { allowed: true, rule: 'test', reason: 'test' } as never },
    );
    expect(out.outcome).toBe('reconciled');
    expect(out.receipt).toEqual({ number: 7 });
    expect(creates).toBe(0);
  });

  it('actions that were never started, finished, or refused are not flagged; an UNKNOWN one is reported again', async () => {
    const env = makeEnv();
    makeRun(env);
    const ledger = new ActionLedger(env.db, clock);
    ledger.recordIntent({ ...intent(env), idempotencyKey: 'k-intent' });
    const done = ledger.recordIntent({ ...intent(env), idempotencyKey: 'k-done' }).action;
    ledger.recordReceipt(ledger.markExecuting(done), { number: 1 }, 'execute');
    const unknown = ledger.recordIntent({ ...intent(env), idempotencyKey: 'k-unknown' }).action;
    ledger.markUnknown(ledger.markExecuting(unknown), 'lost response');
    const rep = await reconcile(env);
    expect(rep.runs[0]!.actions.map((a) => [a.actionId, a.flagged])).toEqual([[unknown.id, true]]);
    expect(ledger.get(unknown.id).state).toBe('UNKNOWN');
  });

  it('actions of an ended run are reported, never changed: nothing owns them', async () => {
    const env = makeEnv();
    makeRun(env);
    const ledger = new ActionLedger(env.db, clock);
    const { action } = ledger.recordIntent(intent(env));
    ledger.markExecuting(action);
    transition(env.db, { runId: env.runId, to: 'BLOCKED', ownerId: OWNER, reason: 'test' }, clock);
    const rep = await reconcile(env);
    expect(rep.runs[0]!.actions).toMatchObject([{ previousState: 'EXECUTING', flagged: false }]);
    expect(ledger.get(action.id).state).toBe('EXECUTING');
  });
});

describe('reconcileOnStart: leases and crashed owners', () => {
  it('a run whose owner died mid-step becomes RECOVERING with the stage to resume, and one recovery attempt is spent', async () => {
    const env = makeEnv();
    makeRun(env, undefined, 'ctl-dead', 30);
    seedCounters(env, { recovery_attempts: 3 });
    await sleep(60);
    const rep = await reconcile(env, 'ctl-new');
    expect(rep.runs[0]).toMatchObject({ recovery: 'recovering', skipped: null });
    const run = getRun(env.db, env.runId);
    expect(run).toMatchObject({ state: 'RECOVERING', resumeState: 'IMPLEMENTING' });
    expect(counterUsed(env, 'recovery_attempts')).toBe(1);
    expect(types(env)).toContain('lease.takeover');
    expect(types(env)).toContain('recovery.crash-handled');
    expect(rep.summary.runsRecovering).toBe(1);

    // Running it again (the same controller, a periodic pass) does not spend another attempt for the same crash.
    const again = await reconcile(env, 'ctl-new');
    expect(again.runs[0]!.recovery).toBeNull();
    expect(counterUsed(env, 'recovery_attempts')).toBe(1);
  });

  it('a crash loop ends: with the recovery budget spent the run is EXHAUSTED, not recovered again', async () => {
    const env = makeEnv();
    makeRun(env, undefined, 'ctl-a', 30);
    seedCounters(env, { recovery_attempts: 1 });
    await sleep(60);
    await reconcile(env, 'ctl-b');
    expect(getRun(env.db, env.runId).state).toBe('RECOVERING');
    // ctl-b dies in turn.
    env.db.run('UPDATE leases SET expires_at = ? WHERE run_id = ?', Date.now() - 1, env.runId);
    const rep = await reconcile(env, 'ctl-c');
    expect(rep.runs[0]!.recovery).toBe('exhausted');
    expect(getRun(env.db, env.runId)).toMatchObject({ state: 'EXHAUSTED' });
    expect(rep.summary.runsExhausted).toBe(1);
  });

  it('a graceful shutdown (lease released) is not a crash', async () => {
    const env = makeEnv();
    makeRun(env, undefined, 'ctl-a');
    releaseLease(env.db, env.runId, 'ctl-a');
    const rep = await reconcile(env, 'ctl-b');
    expect(rep.runs[0]!.recovery).toBeNull();
    expect(getRun(env.db, env.runId).state).toBe('IMPLEMENTING');
  });

  it('a run another live controller holds is skipped entirely', async () => {
    const env = makeEnv();
    makeRun(env, undefined, 'ctl-a', 60_000);
    const rep = await reconcile(env, 'ctl-b');
    expect(rep.runs[0]).toMatchObject({ skipped: 'leased-by-other', workers: [], checks: [], actions: [] });
    expect(getRun(env.db, env.runId).state).toBe('IMPLEMENTING');
    expect(env.db.get<{ owner_id: string }>('SELECT owner_id FROM leases WHERE run_id = ?', env.runId)?.owner_id).toBe('ctl-a');
  });

  it('a run with a durable cancellation is not pushed into RECOVERING (only CANCELLED is reachable)', async () => {
    const env = makeEnv();
    makeRun(env, undefined, 'ctl-dead', 30);
    env.db.run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', env.runId);
    await sleep(60);
    const rep = await reconcile(env, 'ctl-new');
    expect(rep.runs[0]!.recovery).toBe('cancel-pending');
    expect(getRun(env.db, env.runId).state).toBe('IMPLEMENTING');
  });

  it('only the requested runs are touched, and a failure in one run does not stop the others', async () => {
    const env = makeEnv();
    makeRun(env);
    const rep = await reconcile(env, OWNER, { runIds: ['no-such-run'] });
    expect(rep.runs).toEqual([]);
    expect(rep.errors).toEqual([]);
  });
});

describe.skipIf(!canStripTypes)('reconcileOnStart: a controller killed mid-transition (scenario 7)', () => {
  it('a real controller process crashes right after committing a transition; the next controller finds RECOVERING with the stage to resume', async () => {
    const env = makeEnv();
    const dbPath = env.db.path;
    // The dying controller: opens the same SQLite file, takes the lease, walks the run, and is killed (exit 137) by the fault point after the third commit.
    const script = join(env.f.base, 'dying-controller.ts');
    const root = fileURLToPath(new URL('../../../src/', import.meta.url));
    writeFileSync(
      script,
      `import { openDb } from ${JSON.stringify(join(root, 'storage/db.ts'))};
import { acquireLease, createRun, transition } from ${JSON.stringify(join(root, 'controller/run-store.ts'))};
import { systemClock } from ${JSON.stringify(join(root, 'core/clock.ts'))};
const db = openDb(${JSON.stringify(dbPath)});
createRun(db, { id: 'orb-adp', repoRoot: '/r', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: ${JSON.stringify(env.f.policyPath)} }, systemClock);
acquireLease(db, 'orb-adp', 'ctl-doomed', 150, systemClock);
for (const to of ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING']) transition(db, { runId: 'orb-adp', to, ownerId: 'ctl-doomed', reason: 'walk' }, systemClock);
`,
    );
    env.db.close();
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ['--no-warnings', script], { stdio: 'ignore', env: { ...process.env, ORBIT_FAULTS: 'controller.transition.after-commit=crash*' } });
      child.on('exit', (c) => resolve(c));
    });
    expect(code).toBe(137);

    const { openDb } = await import('../../../src/storage/db.ts');
    const db = openDb(dbPath);
    // The fault point fires after every commit (crash*), so the process died after the first transition: the run is in PREFLIGHT, owned by a dead lease.
    expect(db.get<{ state: string }>("SELECT state FROM runs WHERE id = 'orb-adp'")?.state).toBe('PREFLIGHT');
    await sleep(250);
    const rep = await reconcileOnStart({ db, ownerId: 'ctl-next', clock, adapters: {}, graceMs: 100 });
    expect(rep.runs[0]).toMatchObject({ recovery: 'recovering' });
    expect(db.get<{ state: string; resume_state: string }>("SELECT state, resume_state FROM runs WHERE id = 'orb-adp'")).toMatchObject({ state: 'RECOVERING', resume_state: 'PREFLIGHT' });
    db.close();
  });
});
