/**
 * The controller loop (architecture "Process model"). One incarnation:
 *
 *   start  register in `controllers`, reconcile every run it can take
 *          (recovery/reconcile: reattach, collect, restart lost workers,
 *          stop orphans), then tick until stopped
 *   tick   claim runnable runs whose lease is free or expired (non-terminal,
 *          not paused), step each owned run once with a timeout watchdog,
 *          publish heartbeat and last-progress
 *   stop   release leases and record the stop; detached workers and checks
 *          keep running for the next controller to reattach to
 *
 * Leases are renewed on their own timer, not by ticks, so a long step (a
 * check suite, an inquiry) never lets its lease lapse; a failed renewal
 * aborts the run's step at once, because another controller may own the run
 * from that moment. Foreground mode drives one run until it is terminal.
 */
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { isOrbitError } from '../core/errors.ts';
import { newOwnerId } from '../core/ids.ts';
import { processStartTime } from '../core/proc.ts';
import { redact } from '../core/redact.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import { appendEvent } from '../storage/events.ts';
import { heartbeatController, markControllerStopped, registerController, type ControllerMode } from '../storage/controllers.ts';
import { reconcileOnStart, type ReconcileReport } from '../recovery/reconcile.ts';
import { verifySnapshot } from '../policy/snapshot.ts';
import { BudgetLedger } from '../scheduling/budget.ts';
import type { ControllerDeps } from './context.ts';
import { getLease, getRun, listRuns, releaseLease, renewLease } from './run-store.ts';
import { isTerminal, RUN_STATES, type RunState } from './states.ts';
import { step } from './steps/index.ts';
import type { StepResult } from './steps/common.ts';
import { writeFinalReport } from './report.ts';

export interface ControllerOptions {
  deps: Omit<ControllerDeps, 'ownerId'> & { ownerId?: string };
  mode: ControllerMode;
  /** Foreground: the run to drive; the controller stops once it is terminal. */
  runId?: string;
  leaseTtlMs?: number;
  /** Must be well under leaseTtlMs. */
  leaseRenewMs?: number;
  heartbeatMs?: number;
  tickIntervalMs?: number;
  /** Watchdog: a step running longer is aborted and retried on a later tick. */
  stepTimeoutMs?: number;
  /**
   * How long an aborted step may take to stop before the controller gives the run up (stops renewing its
   * lease and stops waiting for it) so that one wedged step cannot hold every other run of this controller.
   */
  stepAbortGraceMs?: number;
  /** Most runs owned at once (service mode); foreground is always one. */
  maxRuns?: number;
  /** How long stop() waits for in-flight steps before releasing their leases. */
  shutdownGraceMs?: number;
  /** Install SIGTERM/SIGINT handlers that stop gracefully. */
  handleSignals?: boolean;
  /** Passed to reconciliation. */
  graceMs?: number;
  startGraceMs?: number;
}

export interface TickReport {
  owned: string[];
  steps: { runId: string; state: RunState; result: StepResult | { error: string } }[];
}

interface Owned {
  inflight: Promise<void> | null;
  abort: AbortController | null;
}

const NON_TERMINAL: RunState[] = RUN_STATES.filter((s) => !isTerminal(s));

export class Controller {
  readonly ownerId: string;
  readonly deps: ControllerDeps;
  private readonly opts: ControllerOptions;
  private readonly log: Logger;
  private readonly owned = new Map<string, Owned>();
  /**
   * Runs given up while their step was still running (it ignored the watchdog's abort). They are not
   * claimed again until that step settles, or this process would run two steps of one run at once.
   */
  private readonly draining = new Map<string, Promise<void>>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private started = false;
  private stopping: Promise<void> | null = null;
  private signalHandler: ((sig: NodeJS.Signals) => void) | null = null;
  lastReconcile: ReconcileReport | null = null;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.ownerId = opts.deps.ownerId ?? newOwnerId();
    this.deps = { ...opts.deps, ownerId: this.ownerId };
    this.log = (opts.deps.logger ?? nullLogger).child({ controller: this.ownerId });
    if (opts.mode === 'foreground' && !opts.runId) throw new Error('a foreground controller needs the run it drives');
  }

  private get ttl(): number {
    return this.opts.leaseTtlMs ?? 60_000;
  }

  /** Register, reconcile, and tick until stopped (or, in foreground mode, until the run is terminal). */
  async start(): Promise<void> {
    if (this.started) throw new Error('controller already started');
    this.started = true;
    const { db, clock } = this.deps;
    registerController(db, { id: this.ownerId, pid: process.pid, host: hostname(), procStart: processStartTime(process.pid), mode: this.opts.mode }, clock);
    this.log.info('controller started', { mode: this.opts.mode, run: this.opts.runId ?? null });
    if (this.opts.handleSignals) {
      this.signalHandler = (sig) => void this.stop(`received ${sig}`);
      process.once('SIGTERM', this.signalHandler);
      process.once('SIGINT', this.signalHandler);
    }
    this.timers.push(setInterval(() => this.heartbeat(), this.opts.heartbeatMs ?? 5_000));
    this.timers.push(setInterval(() => this.renewAll(), this.opts.leaseRenewMs ?? Math.max(250, Math.floor(this.ttl / 4))));
    for (const t of this.timers) t.unref();

    await this.reconcile(this.opts.mode === 'foreground' ? [this.opts.runId!] : undefined);
    this.ensureFinalReports();
    while (!this.stopped) {
      await this.tick();
      if (this.opts.mode === 'foreground' && this.foregroundDone()) break;
      if (this.stopped) break;
      await sleep(this.opts.tickIntervalMs ?? 1_000);
    }
    await this.stop(this.opts.mode === 'foreground' ? 'foreground run finished' : 'stopped');
  }

  /** Graceful shutdown: no new steps, wait briefly for in-flight ones, release leases, record the stop. */
  stop(reason = 'stopped'): Promise<void> {
    this.stopping ??= this.doStop(reason);
    return this.stopping;
  }

  private async doStop(reason: string): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.signalHandler) {
      process.removeListener('SIGTERM', this.signalHandler);
      process.removeListener('SIGINT', this.signalHandler);
    }
    const inflight = [...[...this.owned.values()].map((o) => o.inflight), ...this.draining.values()].filter((p): p is Promise<void> => p !== null);
    if (inflight.length > 0) await Promise.race([Promise.allSettled(inflight), sleep(this.opts.shutdownGraceMs ?? 5_000)]);
    const { db, clock } = this.deps;
    for (const runId of this.owned.keys()) {
      try {
        releaseLease(db, runId, this.ownerId);
        db.tx(() => appendEvent(db, runId, 'lease.released', this.ownerId, { reason }, clock.now()));
      } catch (err) {
        this.log.warn('lease release failed', { run_id: runId, error: messageOf(err) });
      }
    }
    this.owned.clear();
    if (this.started) {
      try {
        markControllerStopped(db, this.ownerId, reason, clock);
      } catch (err) {
        this.log.warn('could not record the stop', { error: messageOf(err) });
      }
    }
    this.log.info('controller stopped', { reason });
  }

  /** One pass: claim, step every owned run once (in parallel), publish liveness. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { owned: [], steps: [] };
    if (this.stopped) return report;
    await this.claim();
    const launched: Promise<void>[] = [];
    for (const [runId, slot] of this.owned) {
      if (slot.inflight) continue;
      let run;
      try {
        run = getRun(this.deps.db, runId);
      } catch {
        this.drop(runId, 'run disappeared');
        continue;
      }
      if (isTerminal(run.state) || run.paused) {
        this.drop(runId, isTerminal(run.state) ? `run ${run.state}` : 'run paused');
        continue;
      }
      const p = this.runStep(runId, run.state, slot, report);
      slot.inflight = p;
      launched.push(p);
    }
    await Promise.allSettled(launched);
    report.owned = [...this.owned.keys()];
    const progressed = report.steps.some((s) => 'progressed' in s.result && s.result.progressed);
    heartbeatController(this.deps.db, this.ownerId, this.deps.clock, { progress: progressed });
    return report;
  }

  private async runStep(runId: string, state: RunState, slot: Owned, report: TickReport): Promise<void> {
    const ac = new AbortController();
    slot.abort = ac;
    const timeoutMs = this.opts.stepTimeoutMs ?? 45 * 60_000;
    const graceMs = this.opts.stepAbortGraceMs ?? 60_000;
    let wedge: NodeJS.Timeout | null = null;
    const gaveUp = new Promise<'wedged'>((resolve) => {
      wedge = setTimeout(() => resolve('wedged'), timeoutMs + graceMs);
      wedge.unref();
    });
    const timer = setTimeout(() => {
      this.note(runId, 'step.timeout', { state, timeout_ms: timeoutMs });
      ac.abort(new Error(`step ${state} exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();
    const work = (async (): Promise<'settled'> => {
      try {
        const result = await step(this.deps, runId, ac.signal);
        report.steps.push({ runId, state, result });
        if (result.done && this.owned.get(runId) === slot) {
          const run = getRun(this.deps.db, runId);
          if (isTerminal(run.state) || run.paused) this.drop(runId, isTerminal(run.state) ? `run ${run.state}` : 'run paused');
        }
      } catch (err) {
        report.steps.push({ runId, state, result: { error: messageOf(err) } });
        if (isOrbitError(err, 'LEASE_LOST')) {
          if (this.owned.get(runId) === slot) this.forget(runId, 'lease lost');
        } else if (!ac.signal.aborted) this.log.error('step crashed', { run_id: runId, state, error: messageOf(err) });
      } finally {
        clearTimeout(timer);
        if (wedge) clearTimeout(wedge);
        slot.inflight = null;
        slot.abort = null;
      }
      return 'settled';
    })();
    if ((await Promise.race([work, gaveUp])) === 'settled') return;
    // The step ignored its abort. Give the run up: no more renewals (its lease expires and another controller
    // may take it; anything the stuck step still tries is fenced by that lease), and no new step here until it settles.
    report.steps.push({ runId, state, result: { error: `step ${state} did not stop within ${graceMs} ms of its ${timeoutMs} ms timeout` } });
    this.log.error('step wedged; giving the run up', { run_id: runId, state });
    const settled: Promise<void> = work.then(() => {
      if (this.draining.get(runId) === settled) this.draining.delete(runId);
    });
    this.draining.set(runId, settled);
    if (this.owned.get(runId) === slot) {
      this.owned.delete(runId);
      this.note(runId, 'step.wedged', { owner: this.ownerId, state, timeout_ms: timeoutMs, grace_ms: graceMs });
    }
  }

  /** Take runs whose lease is free or expired; reconciliation acquires the lease and repairs what a dead owner left. */
  private async claim(): Promise<void> {
    const { db, clock } = this.deps;
    const max = this.opts.mode === 'foreground' ? 1 : (this.opts.maxRuns ?? Number.POSITIVE_INFINITY);
    const want: string[] = [];
    const candidates = this.opts.mode === 'foreground' ? [getRun(db, this.opts.runId!)] : listRuns(db, { states: NON_TERMINAL, limit: 1_000 }).reverse();
    for (const run of candidates) {
      if (this.owned.size + want.length >= max) break;
      if (this.owned.has(run.id) || this.draining.has(run.id) || isTerminal(run.state) || run.paused) continue;
      const lease = getLease(db, run.id);
      if (lease && lease.ownerId !== this.ownerId && lease.expiresAt > clock.now()) continue;
      want.push(run.id);
    }
    if (want.length > 0) await this.reconcile(want);
  }

  private async reconcile(runIds: string[] | undefined): Promise<void> {
    const { db, clock } = this.deps;
    try {
      this.lastReconcile = await reconcileOnStart({
        db,
        ownerId: this.ownerId,
        clock,
        adapters: this.deps.adapters,
        leaseTtlMs: this.ttl,
        ...(runIds ? { runIds } : {}),
        ...(this.opts.graceMs !== undefined ? { graceMs: this.opts.graceMs } : {}),
        ...(this.opts.startGraceMs !== undefined ? { startGraceMs: this.opts.startGraceMs } : {}),
        ledgerFor: (id) => this.ledgerFor(id),
      });
      for (const e of this.lastReconcile.errors) this.log.warn('reconcile error', { run_id: e.runId, error: e.message });
    } catch (err) {
      this.log.error('reconcile failed', { error: messageOf(err) });
    }
    const max = this.opts.mode === 'foreground' ? 1 : (this.opts.maxRuns ?? Number.POSITIVE_INFINITY);
    for (const run of listRuns(db, { states: NON_TERMINAL, limit: 1_000 })) {
      const lease = getLease(db, run.id);
      if (!lease || lease.ownerId !== this.ownerId || this.owned.has(run.id) || this.draining.has(run.id)) continue;
      if (this.opts.mode === 'foreground' && run.id !== this.opts.runId) {
        releaseLease(db, run.id, this.ownerId);
        continue;
      }
      if (this.owned.size >= max || run.paused) {
        // Reconciliation took it; this controller will not work on it, so another may.
        releaseLease(db, run.id, this.ownerId);
        continue;
      }
      this.owned.set(run.id, { inflight: null, abort: null });
    }
  }

  private ledgerFor(runId: string): BudgetLedger | null {
    const { db, clock } = this.deps;
    if (!db.get('SELECT 1 AS x FROM budget_counters WHERE run_id = ? LIMIT 1', runId)) return null;
    try {
      const run = getRun(db, runId);
      return new BudgetLedger(db, clock).attach(runId, verifySnapshot(run.policyPath, run.policyHash));
    } catch {
      return null;
    }
  }

  private renewAll(): void {
    const { db, clock } = this.deps;
    for (const [runId, slot] of this.owned) {
      let ok = false;
      try {
        ok = renewLease(db, runId, this.ownerId, this.ttl, clock);
      } catch (err) {
        this.log.warn('lease renewal failed', { run_id: runId, error: messageOf(err) });
      }
      if (!ok) {
        // From here another controller may own the run: stop acting on it now.
        slot.abort?.abort(new Error('lease lost'));
        this.forget(runId, 'lease renewal failed');
      }
    }
  }

  private heartbeat(): void {
    try {
      if (!heartbeatController(this.deps.db, this.ownerId, this.deps.clock)) void this.stop('this controller was marked stopped by another process');
    } catch (err) {
      this.log.warn('heartbeat failed', { error: messageOf(err) });
    }
  }

  private drop(runId: string, why: string): void {
    const { db } = this.deps;
    try {
      releaseLease(db, runId, this.ownerId);
    } catch {
      /* a lost lease needs no release */
    }
    this.owned.delete(runId);
    this.log.info('run released', { run_id: runId, reason: why });
  }

  private forget(runId: string, why: string): void {
    this.owned.delete(runId);
    this.note(runId, 'lease.lost', { owner: this.ownerId, reason: why });
  }

  private note(runId: string, type: string, data: unknown): void {
    try {
      this.deps.db.tx(() => appendEvent(this.deps.db, runId, type, this.ownerId, data, this.deps.clock.now()));
    } catch {
      /* best effort */
    }
  }

  private foregroundDone(): boolean {
    const run = getRun(this.deps.db, this.opts.runId!);
    return isTerminal(run.state);
  }

  /** A terminal run whose report was lost to a crash after the transition gets it written now. */
  private ensureFinalReports(): void {
    const { db, clock } = this.deps;
    const since = clock.now() - 24 * 60 * 60_000;
    for (const row of db.all<{ id: string }>('SELECT id FROM runs WHERE ended_at IS NOT NULL AND ended_at >= ?', since)) {
      try {
        const run = getRun(db, row.id);
        const runDir = dirname(run.policyPath);
        if (existsSync(join(runDir, 'final.md'))) continue;
        let snapshot = null;
        try {
          snapshot = verifySnapshot(run.policyPath, run.policyHash);
        } catch {
          snapshot = null;
        }
        writeFinalReport(db, run.id, { runDir, clock, snapshot });
      } catch (err) {
        this.log.warn('final report repair failed', { run_id: row.id, error: messageOf(err) });
      }
    }
  }

  /** Runs this controller currently owns. */
  ownedRuns(): string[] {
    return [...this.owned.keys()];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function messageOf(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
}
