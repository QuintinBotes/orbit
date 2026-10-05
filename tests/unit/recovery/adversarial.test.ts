import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLease, getRun, requestCancel } from '../../../src/controller/run-store.ts';
import { ActionLedger } from '../../../src/delivery/actions.ts';
import { heartbeatController, registerController } from '../../../src/storage/controllers.ts';
import { getWorker, planWorker } from '../../../src/storage/workers.ts';
import { decideRetry } from '../../../src/recovery/backoff.ts';
import { reconcileOnStart } from '../../../src/recovery/reconcile.ts';
import { DEFAULT_WATCHDOG, watchdogTick } from '../../../src/recovery/watchdog.ts';
import { counters, eventTypes, makeRun, setup } from './helpers.ts';

/**
 * Regression tests from the adversarial review of recovery. Each one failed
 * against the first implementation.
 */

const MIN = 60_000;
const common = { adapters: {}, workerActivityAt: () => null, config: { graceMs: 50 } };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('reconcileOnStart: a run waiting in INQUISITION', () => {
  it('a controller restart does not skip the inquisition or spend recovery budget', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-dead', ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'INQUISITION'], 30);
    counters(db, 'r1', { recovery_attempts: 3 });
    clock.advance(60);
    const rep = await reconcileOnStart({ db, ownerId: 'ctl-new', clock, adapters: {} });
    expect(rep.runs[0]!.skipped).toBeNull();
    // RECOVERING would resume IMPLEMENTING (the stage before the inquisition), acting on an unresolved question.
    expect(getRun(db, 'r1').state).toBe('INQUISITION');
    expect(db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = 'r1' AND counter = 'recovery_attempts'")?.used).toBe(0);
    // Restarts while a person takes their time must never exhaust the run.
    for (const owner of ['ctl-2', 'ctl-3', 'ctl-4', 'ctl-5']) {
      db.run('UPDATE leases SET expires_at = ? WHERE run_id = ?', clock.now() - 1, 'r1');
      await reconcileOnStart({ db, ownerId: owner, clock, adapters: {} });
    }
    expect(getRun(db, 'r1').state).toBe('INQUISITION');
  });
});

describe('reconcileOnStart: one worker failing to reconcile', () => {
  it('does not stop the run pass: external actions are still flagged and the error is reported', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const dir = mkdtempSync(join(tmpdir(), 'orbit-rec-'));
    dirs.push(dir);
    // A damaged worker directory: exit.json without pid.json for a row still PLANNED.
    writeFileSync(join(dir, 'exit.json'), JSON.stringify({ version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 1, endedAt: 2 }));
    planWorker(db, { id: 'w1', runId: 'r1', role: 'implementer', provider: 'stub', workerDir: dir, cwd: dir }, clock);
    const ledger = new ActionLedger(db, clock);
    const { action } = ledger.recordIntent({ runId: 'r1', kind: 'pr_create', idempotencyKey: 'pr:acme/widgets:r1:1', target: { repo: 'acme/widgets' } });
    ledger.markExecuting(action);
    const stub = { collectResult: async () => ({ status: 'succeeded', exitCode: 0, error: null }) };
    const rep = await reconcileOnStart({ db, ownerId: 'ctl-1', clock, adapters: { stub: stub as never } });
    expect(ledger.get(action.id).state).toBe('UNKNOWN');
    expect(rep.errors.some((e) => e.runId === 'r1' && /w1/.test(e.message))).toBe(true);
    expect(getWorker(db, 'w1').state).toBe('PLANNED');
  });
});

describe('watchdog: per-run judgement', () => {
  it("another run's progress on the same controller does not hide a stuck step", async () => {
    const { db, clock } = setup();
    registerController(db, { id: 'ctl-1', pid: process.pid, host: 'h', mode: 'service' }, clock);
    makeRun(db, clock, 'stuck', 'ctl-1');
    makeRun(db, clock, 'busy', 'ctl-1');
    counters(db, 'stuck', { recovery_attempts: 3 });
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(db, 'stuck', 'ctl-1', 60_000, clock);
    acquireLease(db, 'busy', 'ctl-1', 60_000, clock);
    // The controller just made progress, on some run.
    heartbeatController(db, 'ctl-1', clock, { progress: true });
    db.run('UPDATE runs SET last_progress_at = ? WHERE id = ?', clock.now(), 'busy');
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', host: 'h', ...common });
    expect(rep.findings).toMatchObject([{ kind: 'stuck-step', runId: 'stuck', action: 'abandoned-to-recovering' }]);
    expect(getRun(db, 'stuck').state).toBe('RECOVERING');
    expect(getRun(db, 'busy').state).toBe('IMPLEMENTING');
  });

  it('a run that cannot be acted on does not stop the tick for the other runs', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'ok', 'ctl-1');
    counters(db, 'ok', { recovery_attempts: 3 });
    // Newer, so listed first: stuck in RECOVERING with a durable cancellation the controller has not acted on yet.
    clock.advance(1);
    makeRun(db, clock, 'cancelling', 'ctl-1', ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'RECOVERING']);
    requestCancel(db, 'cancelling', 'cli', clock);
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(db, 'ok', 'ctl-1', 60_000, clock);
    acquireLease(db, 'cancelling', 'ctl-1', 60_000, clock);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', ...common });
    expect(getRun(db, 'ok').state).toBe('RECOVERING');
    // Cancellation wins: not BLOCKED, not touched beyond the finding.
    expect(getRun(db, 'cancelling').state).toBe('RECOVERING');
    expect(rep.findings.find((f) => f.runId === 'cancelling')).toMatchObject({ kind: 'stuck-step', action: null });
    expect(eventTypes(db, 'cancelling')).not.toContain('watchdog.error');
  });
});

describe('decideRetry: provider retry-after hints', () => {
  const base = { attempt: 1, infrastructureRetriesRemaining: 5, wallRemainingMs: null, costRemainingUsd: null, random: () => 0.5 } as const;

  it('a retry-after too long to wait for is not a retry, even with no wall budget known', () => {
    // 30 days: past setTimeout's 2^31 ms limit, Node would fire at once and hammer the provider.
    const d = decideRetry({ ...base, classification: { kind: 'transient', reason: 'x', retryAfterMs: 30 * 24 * 3600 * 1000 } });
    expect(d.action).toBe('stop');
  });

  it('a malformed retry-after is ignored instead of becoming the wait', () => {
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const d = decideRetry({ ...base, classification: { kind: 'transient', reason: 'x', retryAfterMs: bad } });
      expect(d).toMatchObject({ action: 'retry' });
      if (d.action === 'retry') expect(Number.isFinite(d.delayMs) && d.delayMs >= 0 && d.delayMs <= d.ceilingMs).toBe(true);
    }
  });

  it('a worker crash is not restarted once the recovery budget is spent', () => {
    const d = decideRetry({ ...base, classification: { kind: 'crash', reason: 'task status lost', retryAfterMs: null }, recoveryAttemptsRemaining: 0 });
    expect(d).toMatchObject({ action: 'stop', limit: 'recovery_attempts' });
  });
});
