/**
 * The fail-before probe of browser journeys (docs/decisions/0016-retest-followups.md, item 4). A browser check whose
 * directory holds a journey the candidate adds or changes is probed as a test check is: the journeys run on the base
 * revision with the candidate's test-owned changes, through the same ui runner and app fixture verification uses.
 * The baseline runs command checks only, so a browser check has no result on the base revision to stand for the
 * probe's control: the same journeys run on the base revision alone first, once per run (reused by the base tree),
 * and a failure on the probe tree is the new journeys' only when that control passed. A process that never reached
 * the repository's code (the application or the browser did not start) is an environment cause and establishes
 * nothing. The outcome is merged into the probe's checks (controller/fail-before.ts collectFailBefore), so the
 * report treats a browser check like any probed check. Evidence goes under the candidate's fail-before/ui/.
 */
import { isAbsolute, join, relative, sep } from 'node:path';
import { isOrbitError } from '../core/errors.ts';
import { hashObject } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../evidence/candidate.ts';
import { buildProbeTree, commitProbeTree, FAIL_BEFORE_PROBE, judgeProbeAttempts, probeEvidenceDir, probeRef, type CheckProbe, type NotEstablishedCause, type ProbeAttempt, type ProbeChange } from '../evidence/fail-before.ts';
import { resolveCommit, treeOf } from '../evidence/git.ts';
import type { CandidateRecord } from '../evidence/store.ts';
import type { CheckStatus } from '../evidence/types.ts';
import { listDecisions } from '../storage/decisions.ts';
import { runUiChecks, type UiRunInput } from '../ui/runner.ts';
import type { UiRunResult } from '../ui/types.ts';
import { homeOf, runWorktreeRoot, toolchainCacheRootFor, type RunContext } from './context.ts';
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
function judgeControl(data: Pick<ControlData, 'verdict' | 'passed' | 'environment' | 'reasons'>): ControlOutcome {
  if (data.passed) return { passed: true, cause: 'base-failed', reason: 'the journeys pass on the base revision' };
  const detail = data.reasons.length > 0 ? data.reasons.join('; ') : `the ui run ended ${data.verdict}`;
  const reason = `the journeys do not pass on the base revision (${detail})`;
  if (data.environment) return { passed: false, cause: 'environment', reason };
  if (data.verdict === 'TIMEOUT') return { passed: false, cause: 'timeout', reason };
  if (data.verdict === 'CANCELLED') return { passed: false, cause: 'cancelled', reason };
  if (data.verdict === 'ERROR') return { passed: false, cause: 'error', reason };
  return { passed: false, cause: 'base-failed', reason };
}

/** One attempt's standing for a check: its journeys' worst result, or the environment cause that kept them from running. */
function attemptOf(ctx: RunContext, result: UiRunResult, checkId: string, n: number): { attempt: ProbeAttempt } | { environment: string } {
  const notRun = result.notExecuted.find((x) => x.checkId === null || x.checkId === checkId);
  if (notRun) {
    const what = notRun.stage === 'application' ? 'the application' : `the journey process of ${checkId}`;
    return { environment: notRun.environment ?? `${what} never ran the repository's code` };
  }
  const journeys = result.journeys.filter((j) => j.checkId === checkId);
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
  const probeId = newId('probe');
  const checks = [...req.checks].sort((a, b) => a.checkId.localeCompare(b.checkId));
  const checkIds = checks.map((c) => c.checkId);
  const done = (probeTree: string | null, probed: CheckProbe[]): UiProbeResult => ({ probeId, probeTree, checks: probed });
  const ui = ctx.snapshot.config.ui;
  if (!ui || ui.journey_check_ids.length === 0) {
    return done(null, notEstablished(checkIds, 'not-probed', (id) => `${id} was not probed: no ui journeys are configured (ui.journey_check_ids is empty)`));
  }
  if (req.wallRemainingMs !== null && req.wallRemainingMs < req.timeoutMs) {
    const left = Math.max(0, Math.floor(req.wallRemainingMs / 1000));
    return done(null, notEstablished(checkIds, 'budget', (id) => `${id} was not probed: the run has ${left} s of wall time left, less than the probe's bound of ${Math.floor(req.timeoutMs / 1000)} s (verification.fail_before_timeout_seconds)`));
  }
  const deadline = ctx.clock.now() + req.timeoutMs;
  const repoRoot = ctx.run.repoRoot;
  const baseCommit = await resolveCommit(repoRoot, req.baseRev);
  const baseTree = await treeOf(repoRoot, baseCommit);
  const uiDir = join(probeEvidenceDir(ctx.runDir, cand.seq), 'ui');
  // The runner binds its evidence to the candidate it is given and checks the checkout against it, so each tree
  // gets the candidate record of its own commit: the base revision for the control, the probe commit for the probe.
  const runJourneys = (checkoutDir: string, commitSha: string, treeHash: string, parentSha: string, outDir: string): Promise<UiRunResult> =>
    runner({ checkoutDir, snapshot: ctx.snapshot, candidate: { ...cand, commitSha, treeHash, parentSha }, uiConfig: ui, journeyCheckIds: [...checkIds], isolation: ctx.isolation(), outDir, clock: ctx.clock, abortSignal: ctx.signal, homeDir: homeOf(ctx.deps), hostEnv: ctx.deps.hostEnv ?? process.env, toolchainCacheRoot: toolchainCacheRootFor(ctx) });

  // The control: the same journeys on the base revision alone, once per run, reused by the base tree.
  let control = listDecisions(ctx.db, ctx.run.id, { kind: UI_CONTROL_DECISION_KIND })
    .map((d) => d.data as ControlData | null)
    .find((d) => d !== null && d.base_tree === baseTree && sameIds(d.checks, checkIds));
  if (!control) {
    let ran: UiRunResult | null = null;
    let controlThrown: string | null = null;
    const checkout = join(runWorktreeRoot(ctx), 'fail-before-ui-control');
    await cleanupCandidateCheckout(repoRoot, checkout).catch(() => {});
    try {
      await materializeCandidate(repoRoot, baseCommit, checkout, { readOnly: false });
      ran = await runJourneys(checkout, baseCommit, baseTree, baseCommit, join(uiDir, 'control'));
    } catch (err) {
      controlThrown = err instanceof Error ? err.message : String(err);
    } finally {
      await cleanupCandidateCheckout(repoRoot, checkout).catch(() => {});
    }
    control = {
      base_revision: req.baseRev,
      base_tree: baseTree,
      checks: [...checkIds],
      verdict: ran?.verdict ?? 'ERROR',
      passed: ran !== null && ran.verdict === 'PASS',
      environment: (ran?.notExecuted.length ?? 0) > 0,
      reasons: ran !== null ? [...ran.reasons] : [`the journeys could not run on the base revision: ${controlThrown ?? 'no result'}`],
    };
    decide(ctx, {
      id: `dec-${ctx.run.id}-fail-before-ui-control-${hashObject({ tree: baseTree, checks: [...checkIds] }).slice(7, 19)}`,
      kind: UI_CONTROL_DECISION_KIND,
      summary: control.passed ? `the journeys (${checkIds.join(', ')}) pass on the base revision alone: the fail-before ui control` : `the journeys (${checkIds.join(', ')}) do not pass on the base revision alone, so no browser check is probed: ${control.reasons.join('; ')}`,
      data: control,
    });
  }
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
  let runs = 0;
  const checkout = join(runWorktreeRoot(ctx), `fail-before-ui-${cand.seq}`);
  await cleanupCandidateCheckout(repoRoot, checkout).catch(() => {});
  try {
    await materializeCandidate(repoRoot, commit, checkout, { readOnly: false });
  } catch (err) {
    thrown = { cause: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  try {
    for (let n = 1; thrown === null && n <= 2; n++) {
      if (ctx.clock.now() >= deadline) break;
      let result: UiRunResult;
      try {
        result = await runJourneys(checkout, commit, probeTree, baseCommit, join(uiDir, `probe-${n}`));
      } catch (err) {
        thrown = { cause: isOrbitError(err, 'CANCELLED') ? 'cancelled' : 'error', message: err instanceof Error ? err.message : String(err) };
        break;
      }
      runs++;
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
    const environment = environments.get(id);
    if (environment !== undefined) return { checkId: id, outcome: 'not-established', cause: 'environment', reason: `${id} could not run on the base revision with the new tests: ${environment}, not a journey result`, attempts: mine };
    if (thrown !== null) return { checkId: id, outcome: 'not-established', cause: thrown.cause, reason: `${id} could not be run on the probe tree: ${thrown.message}`, attempts: mine };
    if (mine.length === 0) return { checkId: id, outcome: 'not-established', cause: 'budget', reason: `${id} was not probed to the end: the probe's bound of ${Math.floor(req.timeoutMs / 1000)} s (verification.fail_before_timeout_seconds) ran out`, attempts: mine };
    const judged = judgeProbeAttempts(id, mine, FAIL_BEFORE_PROBE.where);
    // A failure that could not be repeated for want of time is the bound's, as in the command probe.
    if (judged.outcome === 'not-established' && judged.cause === 'once' && ctx.clock.now() >= deadline - 1000) {
      return { ...judged, cause: 'budget', reason: `${id} was not probed to the end: the probe's bound of ${Math.floor(req.timeoutMs / 1000)} s (verification.fail_before_timeout_seconds) ran out` };
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
