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
import { watchdogTick, type WatchdogConfig } from '../recovery/watchdog.ts';
import { checkRunCredentials, credentialCheckDue, providersForRun } from '../recovery/credentials.ts';
import { reattachCheck, type RunnerContext } from '../evidence/runner.ts';
import { getCheckRun, isFinalCheckStatus } from '../evidence/store.ts';
import { loadRunContext } from './context.ts';
import { stopActiveWorkers } from './workers.ts';
import { verifySnapshot } from '../policy/snapshot.ts';
import { BudgetLedger } from '../scheduling/budget.ts';
import type { ControllerDeps } from './context.ts';
import { getLease, getRun, listRuns, releaseLease, renewLease } from './run-store.ts';
import { isTerminal, RUN_STATES, type RunState } from './states.ts';
import { step } from './steps/index.ts';
import type { StepResult } from './steps/common.ts';
import { finalizeRun, writeFinalReport } from './report.ts';
import { pruneExpiredRuns, type PruneResult } from '../storage/retention.ts';
import { listQuestions } from '../inquisition/store.ts';
import { notificationsPolicy } from '../policy/config.ts';
import { notifyOpenQuestions, resolveNotifyDeps } from '../notify/notify.ts';
import { pollRemoteAnswers } from '../notify/remote-answers.ts';
import { resumeAnsweredRun } from './resume.ts';

const DAY_MS = 24 * 60 * 60_000;

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
  /** Service mode: how often the watchdog (recovery/watchdog) runs. Default 30 s; 0 turns it off. */
  watchdogMs?: number;
  watchdog?: Partial<WatchdogConfig>;
  /**
   * How often a run's provider credentials are checked again while it works (the run's start counts as the
   * first check, made by preflight). Default 15 min; 0 turns it off.
   */
  credentialCheckMs?: number;
  /** Providers checked with a live probe (a tiny real request) rather than a status query. Default Claude, whose status cannot see an expired credential. */
  liveProbeProviders?: readonly string[];
  /**
   * Artifact retention (retention.keep_runs_days): expired finished runs are pruned when the controller starts and,
   * in service mode, every `intervalMs` (default one day; 0 turns the periodic pass off). `keepDays` overrides the
   * value read from the newest run's frozen policy.
   */
  retention?: { keepDays?: number; intervalMs?: number };
  /**
   * Service mode: how often BLOCKED runs with open questions are considered for remote answers (ADR 0008). Each run
   * is read at most every `notifications.remote_answers.poll_seconds` of its own policy. Default 30 s; 0 turns it off.
   */
  remoteAnswersMs?: number;
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
  private watching = false;
  private pruning = false;
  private polling = false;
  /** When each run's comments were last read for remote answers (service mode). */
  private readonly remotePolledAt = new Map<string, number>();
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
    const watchdogMs = this.opts.watchdogMs ?? 30_000;
    if (this.opts.mode === 'service' && watchdogMs > 0) this.timers.push(setInterval(() => void this.watchdog(), watchdogMs));
    const remoteMs = this.opts.remoteAnswersMs ?? 30_000;
    if (this.opts.mode === 'service' && remoteMs > 0) this.timers.push(setInterval(() => void this.remoteAnswers(), remoteMs));
    for (const t of this.timers) t.unref();

    await this.reconcile(this.opts.mode === 'foreground' ? [this.opts.runId!] : undefined);
    this.ensureFinalReports();
    await this.pruneRetention();
    const retentionMs = this.opts.retention?.intervalMs ?? DAY_MS;
    if (this.opts.mode === 'service' && retentionMs > 0) {
      const t = setInterval(() => void this.pruneRetention(), retentionMs);
      t.unref();
      this.timers.push(t);
    }
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
    // Steps still running stop supervising before their leases go: a shutdown is not a cancellation, so their
    // checks and workers are detached (left running) for the next controller to reattach to, never killed.
    const late = [...this.owned.values()].filter((o) => o.inflight !== null);
    for (const o of late) o.abort?.abort(new Error(`controller stopping: ${reason}`));
    if (late.length > 0) await Promise.race([Promise.allSettled(late.map((o) => o.inflight)), sleep(1_000)]);
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
        if (await this.credentialCheck(runId, ac.signal)) {
          report.steps.push({ runId, state, result: { progressed: true, done: true } });
          if (this.owned.get(runId) === slot) this.drop(runId, 'credentials blocked the run');
          return 'settled';
        }
        const result = await step(this.deps, runId, ac.signal);
        report.steps.push({ runId, state, result });
        await this.announceQuestions(runId);
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
      this.lastReconcile = null;
    }
    // No new work before reconciliation: a run whose pass failed (or a pass that failed outright) is not taken
    // up now; its lease is released and the next claim reconciles it again.
    const reconciled = new Set((this.lastReconcile?.runs ?? []).filter((r) => r.skipped === null).map((r) => r.runId));
    const max = this.opts.mode === 'foreground' ? 1 : (this.opts.maxRuns ?? Number.POSITIVE_INFINITY);
    for (const run of listRuns(db, { states: NON_TERMINAL, limit: 1_000 })) {
      const lease = getLease(db, run.id);
      if (!lease || lease.ownerId !== this.ownerId || this.owned.has(run.id) || this.draining.has(run.id)) continue;
      if (!reconciled.has(run.id)) {
        releaseLease(db, run.id, this.ownerId);
        this.log.warn('run not reconciled; not taken up', { run_id: run.id });
        continue;
      }
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
    if (this.lastReconcile) await this.collectFinishedChecks(this.lastReconcile);
    // Reconciliation can end a run (recovery budget spent); its report is written now, not at the next start.
    this.ensureFinalReports();
  }

  /**
   * Checks that finished while no controller supervised them (reconciliation saw their exit record) are
   * recorded now, for every owned run, so their rows do not stay RUNNING until some step happens to look.
   * Only what already finished is collected: nothing is started or supervised here (a pre-aborted detach).
   */
  private async collectFinishedChecks(rep: ReconcileReport): Promise<void> {
    const { db, clock } = this.deps;
    for (const r of rep.runs) {
      const finished = r.checks.filter((c) => c.observation === 'finished' && !c.closed);
      if (finished.length === 0 || !this.owned.has(r.runId)) continue;
      try {
        const ctx = loadRunContext(this.deps, r.runId, new AbortController().signal);
        const detach = new AbortController();
        detach.abort(new Error('collecting finished checks after reconciliation'));
        for (const c of finished) {
          const row = getCheckRun(db, c.checkRunId);
          if (isFinalCheckStatus(row.status)) continue;
          const runner: RunnerContext = { db, run: { id: ctx.run.id, policyHash: ctx.run.policyHash }, snapshot: ctx.snapshot, isolation: ctx.isolation(), checkoutDir: row.cwd, runDir: ctx.runDir, clock, detachSignal: detach.signal, pollMs: ctx.timing.checkPollMs, killGraceMs: ctx.timing.killGraceMs };
          try {
            await reattachCheck(runner, c.checkRunId);
          } catch (err) {
            // A flaky rerun is due: that is the verifying step's to start, not reconciliation's.
            if (!isOrbitError(err, 'CANCELLED')) this.log.warn('could not collect a finished check', { run_id: r.runId, check_run: c.checkRunId, error: messageOf(err) });
          }
        }
      } catch (err) {
        this.log.warn('could not collect finished checks', { run_id: r.runId, error: messageOf(err) });
      }
    }
  }

  /** One watchdog pass (service mode). A run it abandons or exhausts has its in-flight step stopped here too. */
  private async watchdog(): Promise<void> {
    if (this.watching || this.stopped) return;
    this.watching = true;
    try {
      const rep = await watchdogTick({
        db: this.deps.db,
        clock: this.deps.clock,
        ownerId: this.ownerId,
        adapters: this.deps.adapters,
        ledgerFor: (id) => this.ledgerFor(id),
        ...(this.opts.watchdog ? { config: this.opts.watchdog } : {}),
      });
      let ended = false;
      for (const f of rep.findings) {
        this.log.warn('watchdog', { kind: f.kind, run_id: f.runId ?? null, controller: f.controllerId ?? null, action: f.action, detail: f.detail.slice(0, 300) });
        if ((f.action === 'abandoned-to-recovering' || f.action === 'exhausted') && f.runId) {
          this.owned.get(f.runId)?.abort?.abort(new Error(`watchdog: ${f.detail}`));
          if (f.action === 'exhausted') ended = true;
        }
      }
      if (ended) this.ensureFinalReports();
    } catch (err) {
      this.log.warn('watchdog failed', { error: messageOf(err) });
    } finally {
      this.watching = false;
    }
  }

  /**
   * The periodic credential check (spec section 14: an authentication failure blocks, it is never retried).
   * Due every `credentialCheckMs`, counted from the run's start (preflight checked then) or the last check.
   * Returns true when the check blocked the run; its workers are stopped and its report written.
   */
  private async credentialCheck(runId: string, signal: AbortSignal): Promise<boolean> {
    const interval = this.opts.credentialCheckMs ?? 15 * 60_000;
    if (interval <= 0) return false;
    const { db, clock } = this.deps;
    const run = getRun(db, runId);
    if (run.state === 'CREATED' || isTerminal(run.state) || run.paused || run.cancelRequested) return false;
    if (clock.now() - run.createdAt < interval || !credentialCheckDue(db, runId, clock, interval)) return false;
    const rep = await checkRunCredentials({
      db,
      clock,
      ownerId: this.ownerId,
      runId,
      adapters: this.deps.adapters,
      providers: providersForRun(db, runId, Object.keys(this.deps.adapters).includes('claude') ? ['claude'] : []),
      liveProviders: this.opts.liveProbeProviders ?? ['claude'],
      timeoutMs: 60_000,
    });
    if (rep.blocked?.outcome !== 'blocked' || signal.aborted) return false;
    const ctx = loadRunContext(this.deps, runId, signal);
    const unstoppable = await stopActiveWorkers(ctx, rep.blocked.blocker.message.slice(0, 300));
    if (unstoppable.length > 0) this.note(runId, 'workers.stop-failed', { workers: unstoppable });
    await finalizeRun(ctx);
    return true;
  }

  /** Questions a step raised are announced once (ADR 0008); a notification never fails the step. */
  private async announceQuestions(runId: string): Promise<void> {
    const { db, clock } = this.deps;
    try {
      if (listQuestions(db, runId, { status: 'open' }).length === 0) return;
      const run = getRun(db, runId);
      let config = null;
      try {
        config = verifySnapshot(run.policyPath, run.policyHash).config;
      } catch {
        config = null;
      }
      await notifyOpenQuestions({ db, clock, run, runDir: dirname(run.policyPath), config, deps: resolveNotifyDeps(this.deps), actor: this.ownerId });
    } catch (err) {
      this.log.warn('question notification failed', { run_id: runId, error: messageOf(err) });
    }
  }

  /**
   * One remote-answer pass (service mode, ADR 0008): the comments of every BLOCKED run with open questions whose
   * policy turns remote answers on, read at most once per its poll interval; a run left with no open material
   * question is resumed through the same rules as `orbit resume`, and this controller then picks it up.
   */
  private async remoteAnswers(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    const { db, clock } = this.deps;
    try {
      for (const run of listRuns(db, { states: ['BLOCKED'], limit: 200 })) {
        if (this.stopped) break;
        if (run.cancelRequested || listQuestions(db, run.id, { status: 'open' }).length === 0) continue;
        let config;
        try {
          config = verifySnapshot(run.policyPath, run.policyHash).config;
        } catch {
          continue;
        }
        const n = notificationsPolicy(config).remote_answers;
        if (!n.enabled) continue;
        const last = this.remotePolledAt.get(run.id);
        if (last !== undefined && clock.now() - last < n.poll_seconds * 1000) continue;
        this.remotePolledAt.set(run.id, clock.now());
        try {
          const notify = resolveNotifyDeps(this.deps);
          const client = await notify.threads(run.repoRoot, config);
          const rep = await pollRemoteAnswers({ db, clock, run, runDir: dirname(run.policyPath), config, client, actor: this.ownerId });
          for (const e of rep.errors) this.log.warn('remote answers', { run_id: run.id, error: e });
          if (rep.accepted.length === 0) continue;
          const to = resumeAnsweredRun(db, clock, run.id, this.ownerId, this.ownerId, `resumed after a remote answer by ${rep.accepted.map((a) => a.author).join(', ')}`);
          if (to) this.log.info('run resumed by a remote answer', { run_id: run.id, to });
        } catch (err) {
          this.note(run.id, 'remote.poll-failed', { error: messageOf(err) });
        }
      }
    } catch (err) {
      this.log.warn('remote answers pass failed', { error: messageOf(err) });
    } finally {
      this.polling = false;
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

  /**
   * Remove the artifacts of finished runs older than retention.keep_runs_days (storage/retention). The period
   * comes from the newest run's frozen policy for each repository in this database, unless the options set it.
   * Never fails the controller: a pass that cannot run is logged and tried again on the next one.
   */
  async pruneRetention(): Promise<PruneResult[]> {
    if (this.pruning || this.stopped) return [];
    this.pruning = true;
    const out: PruneResult[] = [];
    try {
      const { db, clock } = this.deps;
      for (const { repo_root: repoRoot } of db.all<{ repo_root: string }>('SELECT DISTINCT repo_root FROM runs')) {
        try {
          const keepDays = this.opts.retention?.keepDays ?? this.keepDaysFor(repoRoot);
          if (keepDays === null) continue;
          const r = await pruneExpiredRuns(db, { repoRoot, keepDays, clock, orbitHome: this.deps.orbitHome });
          out.push(r);
          if (r.pruned.length > 0 || r.skipped.length > 0) this.log.info('retention pass', { repo: repoRoot, keep_days: keepDays, pruned: r.pruned.map((p) => p.runId), skipped: r.skipped.length });
        } catch (err) {
          this.log.warn('retention pass failed', { repo: repoRoot, error: messageOf(err) });
        }
      }
    } finally {
      this.pruning = false;
    }
    return out;
  }

  /** retention.keep_runs_days of the newest run of a repository whose frozen policy still verifies. */
  private keepDaysFor(repoRoot: string): number | null {
    for (const row of this.deps.db.all<{ id: string }>('SELECT id FROM runs WHERE repo_root = ? ORDER BY created_at DESC LIMIT 20', repoRoot)) {
      try {
        const run = getRun(this.deps.db, row.id);
        const days = verifySnapshot(run.policyPath, run.policyHash).config.retention?.keep_runs_days;
        if (typeof days === 'number' && Number.isInteger(days) && days >= 1) return days;
      } catch {
        /* a pruned or unverifiable snapshot says nothing; try an older run */
      }
    }
    return null;
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
