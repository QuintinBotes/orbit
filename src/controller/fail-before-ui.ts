/**
 * The fail-before probe of browser journeys (docs/decisions/0016-retest-followups.md, item 4). A browser check whose
 * directory holds a journey the candidate adds or changes is probed as a test check is: the journeys run on the base
 * revision with the candidate's test-owned changes, through the same ui runner and app fixture verification uses.
 * The baseline runs command checks only, so a browser check has no result on the base revision to stand for the
 * probe's control: the same journeys run on the base revision alone first, once per run (reused by the base tree),
 * and a failure on the probe tree is the new journeys' only when that control passed. Both checkouts get the locked
 * install the command probe gives its probe tree (evidence/fail-before.ts installProbeCheckout) before the journeys
 * run there, and an install or a journey run that fails because a dependency could not be fetched or installed is
 * the environment's, never a journey failure. A process that never reached the repository's code (the application
 * or the browser did not start) is an environment cause and establishes nothing. The outcome is merged into the
 * probe's checks (controller/fail-before.ts collectFailBefore), so the report treats a browser check like any
 * probed check. Evidence goes under the candidate's fail-before/ui/.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isOrbitError } from '../core/errors.ts';
import { hashObject } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { redact } from '../core/redact.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../evidence/candidate.ts';
import { buildProbeTree, commitProbeTree, dependencyFetchLine, FAIL_BEFORE_PROBE, installProbeCheckout, judgeProbeAttempts, probeEvidenceDir, probeRef, type CheckProbe, type NotEstablishedCause, type ProbeAttempt, type ProbeChange, type ProbeInstallStop, type ProbeRequest } from '../evidence/fail-before.ts';
import { resolveCommit, treeOf } from '../evidence/git.ts';
import type { CandidateRecord } from '../evidence/store.ts';
import type { CheckStatus } from '../evidence/types.ts';
import { listDecisions } from '../storage/decisions.ts';
import { APP_LOG_FILE } from '../ui/app-fixture.ts';
import { runUiChecks, type UiRunInput } from '../ui/runner.ts';
import type { UiJourneyResult, UiRunResult } from '../ui/types.ts';
import { checkRunnerFor, homeOf, runWorktreeRoot, toolchainCacheRootFor, type RunContext } from './context.ts';
import { decide } from './steps/common.ts';

/** The ui runner the probe drives; tests inject one that answers scripted results and starts no browser. */
export type UiRunner = (input: UiRunInput) => Promise<UiRunResult>;

export const UI_CONTROL_DECISION_KIND = 'verification.fail-before-ui-control';
export const UI_PROBE_DECISION_KIND = 'verification.fail-before-ui';

export interface UiProbeRequest {
  /** The revision the probe tree starts from, and the control runs on. */
  baseRev: string;
  /** The candidate's test-owned changes against `baseRev`: what the probe tree takes from it. */
  changes: readonly ProbeChange[];
  /** The browser checks to probe, each with the criteria resting on it. */
  checks: readonly { checkId: string; criteria: readonly string[] }[];
  /** The one wall-clock bound of the whole ui probe (verification.fail_before_timeout_seconds). */
  timeoutMs: number;
  /** What is left of the run's wall-time budget; the probe is skipped when it is less than its bound. Null: no budget yet. */
  wallRemainingMs: number | null;
  /** The ui runner; absent, the one verification uses (ui/runner.ts runUiChecks). */
  uiRunner?: UiRunner;
  /** The candidate's runner context, which runs the locked install in each checkout; absent, the run's own (checkRunnerFor). */
  runner?: ProbeRequest['runner'];
}

export interface UiProbeResult {
  probeId: string;
  /** The probe tree (the base tree with the candidate's test-owned paths); null when it was refused or never built. */
  probeTree: string | null;
  checks: CheckProbe[];
}

interface ControlData {
  base_revision: string;
  base_tree: string;
  checks: string[];
  verdict: string;
  passed: boolean;
  environment: boolean;
  /** The line that shows a dependency could not be fetched or installed, when the control run's output shows one. */
  dependency_failure?: string | null;
  reasons: string[];
}

/** What the control established: a pass, or why not, with the cause each browser check then carries. */
interface ControlOutcome {
  passed: boolean;
  cause: NotEstablishedCause;
  reason: string;
}

function notEstablished(checkIds: readonly string[], cause: NotEstablishedCause, reason: (id: string) => string): CheckProbe[] {
  return checkIds.map((id) => ({ checkId: id, outcome: 'not-established' as const, cause, reason: reason(id), attempts: [] }));
}

/** A path relative to the run directory when it lies inside it, as the evidence report names logs. */
function runRelative(runDir: string, p: string): string {
  const r = relative(runDir, p);
  return r === '' || r.startsWith('..') || isAbsolute(r) ? p : r.split(sep).join('/');
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** The control's outcome from its recorded run: PASS establishes, anything else leaves every browser check open. */
function judgeControl(data: Pick<ControlData, 'verdict' | 'passed' | 'environment' | 'dependency_failure' | 'reasons'>): ControlOutcome {
  if (data.passed) return { passed: true, cause: 'base-failed', reason: 'the journeys pass on the base revision' };
  if (data.dependency_failure) return { passed: false, cause: 'environment', reason: `a dependency could not be fetched or installed on the base revision (${data.dependency_failure})` };
  const detail = data.reasons.length > 0 ? data.reasons.join('; ') : `the ui run ended ${data.verdict}`;
  const reason = `the journeys do not pass on the base revision (${detail})`;
  if (data.environment) return { passed: false, cause: 'environment', reason };
  if (data.verdict === 'TIMEOUT') return { passed: false, cause: 'timeout', reason };
  if (data.verdict === 'CANCELLED') return { passed: false, cause: 'cancelled', reason };
  if (data.verdict === 'ERROR') return { passed: false, cause: 'error', reason };
  return { passed: false, cause: 'base-failed', reason };
}

/**
 * A failed journey's error that shows its browser never started: Playwright's launch error and the launch parts of
 * what ui/explore.ts treats as an environment failure (its network and module errors are not this), with the
 * sandbox launch failures ui/runner.ts already names. The ui runner only turns some of these into a `notExecuted`
 * entry (a missing browser executable, for one, fails the journeys with none), so the journeys' own errors are read
 * as well. Reading error text here can only make the probe stricter: a match turns a would-be failure into
 * "establishes nothing", never the other way, which is the only direction wording may be read.
 */
const BROWSER_NOT_STARTED = /browserType\.launch|Executable doesn't exist|Failed to launch|MachPortRendezvousServer|mach_port_rendezvous|sandbox initialization failed|Target page, context or browser has been closed/i;

/** Why the browser did not start for one of `journeys`, from its error (UiJourneyResult.error, or its error context), or null. */
function browserNotStarted(journeys: readonly UiJourneyResult[]): string | null {
  for (const j of journeys) {
    if (j.status !== 'FAILED') continue;
    const text = [j.error?.message, j.errorContext?.errorDetails].filter((t): t is string => t !== null && t !== undefined).join('\n');
    const line = text.split('\n').find((l) => BROWSER_NOT_STARTED.test(l))?.trim();
    if (line) return `the browser did not start (${redact(line).slice(0, 300)})`;
  }
  return null;
}

/** A journey or application log as written, or null when there is none: a fetch failure may show only in it. */
function logText(path: string | null | undefined): string | null {
  try {
    return path && existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** The line that shows a dependency could not be fetched or installed in one ui run, or null. */
function dependencyFetchFailure(result: UiRunResult, journeys: readonly UiJourneyResult[]): string | null {
  // The application's log (app/app.log under the run's output directory, APP_LOG_FILE) is read whether or not the
  // application started: a server that fetches a package as it starts can record the refusal only there while its
  // journeys then fail as ordinary assertions. When the application never started, the same file is already read
  // as a notExecuted log. Reading it can only make the probe stricter (see dependencyFetchLine in
  // evidence/fail-before.ts, the one definition both probes use).
  const texts = [...result.reasons, ...journeys.flatMap((j) => [j.error?.message, j.errorContext?.errorDetails]), ...result.notExecuted.map((x) => x.environment), ...result.checks.map((c) => logText(c.logPath)), ...result.notExecuted.map((x) => logText(x.logPath)), logText(join(result.outDir, 'app', APP_LOG_FILE))];
  for (const text of texts) {
    const line = dependencyFetchLine(text);
    if (line !== null) return line;
  }
  return null;
}

/** One attempt's standing for a check: its journeys' worst result, or the environment cause that kept them from running. */
function attemptOf(ctx: RunContext, result: UiRunResult, checkId: string, n: number): { attempt: ProbeAttempt } | { environment: string } {
  const journeys = result.journeys.filter((j) => j.checkId === checkId);
  // The run's output and logs, the application's included, are read for a fetch failure first, whether or not the
  // application started: such a failure is the environment's, never a journey result.
  const fetchLine = dependencyFetchFailure(result, journeys);
  if (fetchLine) return { environment: `a dependency could not be fetched or installed (${fetchLine})` };
  const notRun = result.notExecuted.find((x) => x.checkId === null || x.checkId === checkId);
  if (notRun) {
    const what = notRun.stage === 'application' ? 'the application' : `the journey process of ${checkId}`;
    return { environment: notRun.environment ?? `${what} never ran the repository's code` };
  }
  const notStarted = browserNotStarted(journeys);
  if (notStarted) return { environment: notStarted };
  const status: CheckStatus =
    result.verdict === 'TIMEOUT' ? 'TIMEOUT'
    : result.verdict === 'CANCELLED' ? 'CANCELLED'
    : result.verdict === 'ERROR' || journeys.length === 0 ? 'ERROR'
    : journeys.some((j) => j.status === 'TIMED_OUT') ? 'TIMEOUT'
    : journeys.some((j) => j.status === 'INTERRUPTED') ? 'CANCELLED'
    // Only a journey that failed is a failure here: on the probe tree a failure is the evidence, so a skipped journey,
    // which verification counts against a candidate, failed nothing (ADR 0015's skipped test, for journeys).
    : journeys.some((j) => j.status === 'FAILED') ? 'FAILED'
    : 'PASSED';
  const run = result.checks.find((c) => c.checkId === checkId);
  return { attempt: { attempt: n, status, exitCode: run?.exitCode ?? null, signals: [], log: runRelative(ctx.runDir, run?.logPath ?? join(result.outDir, 'ui-result.json')) } };
}

/**
 * Probe the browser checks of one candidate: the control on the base revision alone (once per run, reused by the
 * base tree and recorded as a decision), then, when it passed, the journeys on the probe tree, a failing run once
 * more. Each check is judged over its attempts as a command check is (judgeProbeAttempts): failed-before needs two
 * failing runs with no environment cause, a pass is passed-before, and an environment cause, an error or a timeout
 * establishes nothing. The whole probe keeps to `verification.fail_before_timeout_seconds` and to the run's
 * remaining wall time, as the command probe does.
 */
export async function runUiFailBeforeProbe(ctx: RunContext, cand: CandidateRecord, req: UiProbeRequest): Promise<UiProbeResult> {
  const runner = req.uiRunner ?? runUiChecks;
  const probeRunner = req.runner ?? checkRunnerFor(ctx);
  const probeId = newId('probe');
  const checks = [...req.checks].sort((a, b) => a.checkId.localeCompare(b.checkId));
  const checkIds = checks.map((c) => c.checkId);
  // Set once the probe's deadline timer and signal exist (below); every return past there releases them.
  let releaseBound: () => void = () => {};
  const done = (probeTree: string | null, probed: CheckProbe[]): UiProbeResult => {
    releaseBound();
    return { probeId, probeTree, checks: probed };
  };
  const ui = ctx.snapshot.config.ui;
  if (!ui || ui.journey_check_ids.length === 0) {
    return done(null, notEstablished(checkIds, 'not-probed', (id) => `${id} was not probed: no ui journeys are configured (ui.journey_check_ids is empty)`));
  }
  // With no start command the journeys run against whatever server is already at base_url, which Orbit did not
  // start from the probe's checkout and which is not bound to the base revision, so no result of theirs can be
  // fail-before evidence: neither the control nor the probe runs.
  if (ui.environment.start_command === null) {
    return done(null, notEstablished(checkIds, 'not-probed', (id) => `${id} was not probed: ui.environment.start_command is not set, so the journeys would run against the application already at ui.environment.base_url, which is not started from the probe's checkout and is not bound to the base revision`));
  }
  if (req.wallRemainingMs !== null && req.wallRemainingMs < req.timeoutMs) {
    const left = Math.max(0, Math.floor(req.wallRemainingMs / 1000));
    return done(null, notEstablished(checkIds, 'budget', (id) => `${id} was not probed: the run has ${left} s of wall time left, less than the probe's bound of ${Math.floor(req.timeoutMs / 1000)} s (verification.fail_before_timeout_seconds)`));
  }
  // One deadline for the control (its application start included, through the ui runner) and every probe attempt:
  // the signal given to the runner aborts when the bound, or what is left of the run's wall time, runs out, not
  // only between attempts. The controller's own signal aborts it too, as before; `boundOut` tells the two apart, so
  // a run the bound cuts short is the budget's and never a failure, while the controller's stays a cancellation.
  const boundMs = req.wallRemainingMs === null ? req.timeoutMs : Math.min(req.timeoutMs, req.wallRemainingMs);
  const deadline = ctx.clock.now() + boundMs;
  const boundControl = new AbortController();
  let boundOut = false;
  const onBoundSignal = (): void => boundControl.abort();
  ctx.signal.addEventListener('abort', onBoundSignal, { once: true });
  if (ctx.signal.aborted) boundControl.abort();
  const boundTimer = setTimeout(() => {
    boundOut = true;
    boundControl.abort();
  }, Math.max(0, deadline - ctx.clock.now()));
  boundTimer.unref();
  releaseBound = () => {
    clearTimeout(boundTimer);
    ctx.signal.removeEventListener('abort', onBoundSignal);
  };
  const boundRanOut = (): boolean => !ctx.signal.aborted && (boundOut || ctx.clock.now() >= deadline);
  const boundReason = (id: string): string => `${id} was not probed to the end: the probe's bound of ${Math.floor(req.timeoutMs / 1000)} s (verification.fail_before_timeout_seconds) ran out`;
  const repoRoot = ctx.run.repoRoot;
  const baseCommit = await resolveCommit(repoRoot, req.baseRev);
  const baseTree = await treeOf(repoRoot, baseCommit);
  // A directory of this probe's own: an application appends to its log (app/app.log), and the log is read whole for a
  // fetch failure, so a resumed probe of the same candidate must not find an earlier run's refusal in it.
  const uiDir = join(probeEvidenceDir(ctx.runDir, cand.seq), 'ui', probeId);
  // The runner binds its evidence to the candidate it is given and checks the checkout against it, so each tree
  // gets the candidate record of its own commit: the base revision for the control, the probe commit for the probe.
  const runJourneys = (checkoutDir: string, commitSha: string, treeHash: string, parentSha: string, outDir: string): Promise<UiRunResult> =>
    runner({ checkoutDir, snapshot: ctx.snapshot, candidate: { ...cand, commitSha, treeHash, parentSha }, uiConfig: ui, journeyCheckIds: [...checkIds], isolation: ctx.isolation(), outDir, clock: ctx.clock, abortSignal: boundControl.signal, homeDir: homeOf(ctx.deps), hostEnv: ctx.deps.hostEnv ?? process.env, toolchainCacheRoot: toolchainCacheRootFor(ctx) });

  // The control: the same journeys on the base revision alone, once per run, reused by the base tree.
  let controlCut = false;
  let control = listDecisions(ctx.db, ctx.run.id, { kind: UI_CONTROL_DECISION_KIND })
    .map((d) => d.data as ControlData | null)
    .find((d) => d !== null && d.base_tree === baseTree && sameIds(d.checks, checkIds));
  if (!control) {
    let ran: UiRunResult | null = null;
    let controlThrown: string | null = null;
    let controlInstall: ProbeInstallStop | null = null;
    const checkout = join(runWorktreeRoot(ctx), 'fail-before-ui-control');
    await cleanupCandidateCheckout(repoRoot, checkout).catch(() => {});
    try {
      await materializeCandidate(repoRoot, baseCommit, checkout, { readOnly: false });
      // The locked install first, as the command probe installs its probe tree: without it the journeys fetch
      // their own tooling, and a registry the sandbox refuses reads as the journeys failing on the base revision.
      controlInstall = await installProbeCheckout({ runner: probeRunner, probeId, candidateId: cand.id, treeHash: baseTree, bindingId: `fail-before-ui-control:${baseTree}`, evidenceDir: uiDir, checkoutDir: checkout, deadline, timeoutMs: req.timeoutMs, where: 'for the ui control on the base revision' });
      if (controlInstall === null) ran = await runJourneys(checkout, baseCommit, baseTree, baseCommit, join(uiDir, 'control'));
    } catch (err) {
      controlThrown = err instanceof Error ? err.message : String(err);
    } finally {
      await cleanupCandidateCheckout(repoRoot, checkout).catch(() => {});
    }
    // An install that stopped the control is the environment's or the install's, not the journeys': no control is
    // recorded for reuse, so a later candidate's probe tries the install and the control again.
    if (controlInstall !== null) return done(null, notEstablished(checkIds, controlInstall.cause, controlInstall.reason));
    const fetchLine = ran !== null ? dependencyFetchFailure(ran, ran.journeys) : null;
    control = {
      base_revision: req.baseRev,
      base_tree: baseTree,
      checks: [...checkIds],
      verdict: ran?.verdict ?? 'ERROR',
      passed: ran !== null && ran.verdict === 'PASS' && fetchLine === null,
      environment: (ran?.notExecuted.length ?? 0) > 0 || (ran !== null && browserNotStarted(ran.journeys) !== null) || fetchLine !== null,
      dependency_failure: fetchLine,
      reasons: ran !== null ? [...ran.reasons] : [`the journeys could not run on the base revision: ${controlThrown ?? 'no result'}`],
    };
    // A control the bound cut short says nothing about the base revision, so it is not recorded for reuse: a later
    // candidate's probe, with a bound of its own, runs the control again. A control that failed for an environment
    // or install cause says nothing reusable either: the cause may be fixed by the next candidate's probe.
    controlCut = boundRanOut();
    const freshOutcome = judgeControl(control);
    if (!controlCut && freshOutcome.cause !== 'environment' && freshOutcome.cause !== 'install') {
      decide(ctx, {
        id: `dec-${ctx.run.id}-fail-before-ui-control-${hashObject({ tree: baseTree, checks: [...checkIds] }).slice(7, 19)}`,
        kind: UI_CONTROL_DECISION_KIND,
        summary: control.passed ? `the journeys (${checkIds.join(', ')}) pass on the base revision alone: the fail-before ui control` : `the journeys (${checkIds.join(', ')}) do not pass on the base revision alone, so no browser check is probed: ${control.reasons.join('; ')}`,
        data: control,
      });
    }
  }
  if (controlCut) return done(null, notEstablished(checkIds, 'budget', boundReason));
  const judgedControl = judgeControl(control);
  if (!judgedControl.passed) {
    return done(null, notEstablished(checkIds, judgedControl.cause, (id) => `${id} was not probed: ${judgedControl.reason}, so a failure with the new journeys would not be theirs alone`));
  }

  // The probe tree, built as the command probe builds it, and checked out beside the candidate's own checkout.
  const built = await buildProbeTree(repoRoot, req.baseRev, req.changes, FAIL_BEFORE_PROBE.base);
  if ('refused' in built) return done(null, notEstablished(checkIds, 'refused-tree', (id) => `${id} was not probed: git refused the probe tree (${built.refused})`));
  const probeTree = built.tree;
  const commit = await commitProbeTree(repoRoot, { base: req.baseRev, tree: probeTree, ref: probeRef(ctx.run.id, cand.seq, FAIL_BEFORE_PROBE, 'ui'), message: `orbit fail-before ui probe ${ctx.run.id}/${cand.seq}\n\nbase: ${req.baseRev}\ncandidate: ${cand.commitSha}\ntree: ${probeTree}\n` });
  const attempts = new Map<string, ProbeAttempt[]>(checkIds.map((id) => [id, []]));
  const environments = new Map<string, string>();
  let thrown: { cause: NotEstablishedCause; message: string } | null = null;
  let cutShort = false;
  let runs = 0;
  const checkout = join(runWorktreeRoot(ctx), `fail-before-ui-${cand.seq}`);
  await cleanupCandidateCheckout(repoRoot, checkout).catch(() => {});
  try {
    await materializeCandidate(repoRoot, commit, checkout, { readOnly: false });
  } catch (err) {
    thrown = { cause: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  // The probe checkout gets the same locked install before its journeys run; a stop here is no journey's failure.
  let probeInstall: ProbeInstallStop | null = null;
  if (thrown === null) {
    try {
      probeInstall = await installProbeCheckout({ runner: probeRunner, probeId, candidateId: cand.id, treeHash: probeTree, bindingId: `fail-before-ui:${probeTree}`, evidenceDir: uiDir, checkoutDir: checkout, deadline, timeoutMs: req.timeoutMs, where: 'on the ui probe tree' });
    } catch (err) {
      if (boundRanOut()) probeInstall = { cause: 'budget', reason: boundReason };
      else thrown = { cause: isOrbitError(err, 'CANCELLED') ? 'cancelled' : 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }
  try {
    for (let n = 1; thrown === null && probeInstall === null && n <= 2; n++) {
      if (boundRanOut()) break;
      let result: UiRunResult;
      try {
        result = await runJourneys(checkout, commit, probeTree, baseCommit, join(uiDir, `probe-${n}`));
      } catch (err) {
        // The bound cutting a run short is the budget's, whatever the runner then throws or reports.
        if (boundRanOut()) cutShort = true;
        else thrown = { cause: isOrbitError(err, 'CANCELLED') ? 'cancelled' : 'error', message: err instanceof Error ? err.message : String(err) };
        break;
      }
      runs++;
      if (boundRanOut()) {
        cutShort = true;
        break;
      }
      let failed = false;
      for (const id of checkIds) {
        const a = attemptOf(ctx, result, id, n);
        if ('environment' in a) environments.set(id, a.environment);
        else {
          attempts.get(id)!.push(a.attempt);
          if (a.attempt.status === 'FAILED') failed = true;
        }
      }
      if (!failed) break;
    }
  } finally {
    await cleanupCandidateCheckout(repoRoot, checkout).catch(() => {});
  }
  const probed = checkIds.map((id): CheckProbe => {
    const mine = attempts.get(id)!;
    if (probeInstall !== null) return { checkId: id, outcome: 'not-established', cause: probeInstall.cause, reason: probeInstall.reason(id), attempts: mine };
    const environment = environments.get(id);
    if (environment !== undefined) return { checkId: id, outcome: 'not-established', cause: 'environment', reason: `${id} could not run on the base revision with the new tests: ${environment}, not a journey result`, attempts: mine };
    if (thrown !== null) return { checkId: id, outcome: 'not-established', cause: thrown.cause, reason: `${id} could not be run on the probe tree: ${thrown.message}`, attempts: mine };
    if (cutShort) return { checkId: id, outcome: 'not-established', cause: 'budget', reason: boundReason(id), attempts: mine };
    if (mine.length === 0) return { checkId: id, outcome: 'not-established', cause: 'budget', reason: boundReason(id), attempts: mine };
    const judged = judgeProbeAttempts(id, mine, FAIL_BEFORE_PROBE.where);
    // A failure that could not be repeated for want of time is the bound's, as in the command probe.
    if (judged.outcome === 'not-established' && judged.cause === 'once' && (boundRanOut() || ctx.clock.now() >= deadline - 1000)) {
      return { ...judged, cause: 'budget', reason: boundReason(id) };
    }
    return judged;
  });
  if (runs > 0) {
    const criteria = new Map(checks.map((c) => [c.checkId, [...c.criteria]]));
    decide(ctx, {
      id: `dec-${ctx.run.id}-fail-before-ui-${probeId}`,
      kind: UI_PROBE_DECISION_KIND,
      summary: probed.map((c) => `${c.reason}${(criteria.get(c.checkId) ?? []).length > 0 ? `: ${(criteria.get(c.checkId) ?? []).join(', ')}` : ''}`).join('; '),
      data: {
        probe_id: probeId,
        candidate_id: cand.id,
        candidate_seq: cand.seq,
        base_revision: req.baseRev,
        probe_tree: probeTree,
        checks: probed.map((c) => ({ check_id: c.checkId, outcome: c.outcome, ...(c.cause ? { cause: c.cause } : {}), reason: c.reason, criteria: criteria.get(c.checkId) ?? [], attempts: c.attempts.map((a) => ({ status: a.status, exit_code: a.exitCode, log: a.log })) })),
      },
    });
  }
  return done(probeTree, probed);
}
