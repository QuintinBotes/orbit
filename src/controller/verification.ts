/**
 * The evidence for one candidate (spec sections 5 and 11), collected the same way wherever it is asked for:
 * the VERIFYING step and `orbit verify` both call `collectVerificationEvidence`, so a finding is judged under one
 * policy whichever of them looks (docs/gaps.md G47).
 *
 * In a clean, writable checkout of exactly the candidate tree: the dependency install and audit, the trusted
 * command checks, the UI checks when UI paths changed or a criterion needs browser evidence, optionally the
 * agent-driven UI exploration, then the static security gate (secret scan and SAST) judged under the run's frozen
 * `static_security` policy at the controller's clock, and finally the evidence evaluation bound to the tree, the
 * check configuration and the policy.
 *
 * It never moves the run and never writes failure records: the caller decides what the evidence means for the
 * run. The VERIFYING step records gates and failures and persists the report; `orbit verify` only prints it.
 */
import { join } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { compileGlobs } from '../policy/globs.ts';
import { staticSecurityPolicy } from '../policy/config.ts';
import { readJsonIfExists } from '../core/fsx.ts';
import { gitTreeReader, isTestPath, loadTestLayout, testedByContent } from '../policy/test-files.ts';
import { git } from '../evidence/git.ts';
import { BASELINE_FILE, installDependencies, type BaselineReport } from '../evidence/baseline.ts';
import { candidateEvidenceDir, runChecks, type RunnerContext } from '../evidence/runner.ts';
import { evaluateEvidence, type BaseComparison, type Evaluation, type UiResultInput } from '../evidence/report.ts';
import type { CandidateRecord } from '../evidence/store.ts';
import type { CheckResult, EvidenceReport, ScopeReport } from '../evidence/types.ts';
import { runUiChecks, toEvidenceUi } from '../ui/runner.ts';
import type { UiRunResult } from '../ui/types.ts';
import type { ExplorationResult } from '../ui/explore.ts';
import { homeOf, toolchainCacheRootFor, type RunContext } from './context.ts';
import { staticSecurityGate, uiGate, type GateResult } from './gates.ts';
import { judgeSastResult, sastCheckIds, scanCandidateSecrets, type SastVerdict, type SecretScanResult } from './security.ts';
import { exploreCandidate, explorationEnabled, explorationUnverified } from './exploration.ts';

export interface CollectOptions<S> {
  /** A clean, writable checkout of exactly the candidate tree (the caller materializes and removes it). */
  checkoutDir: string;
  /** The implementation-scope report of the candidate, as the caller inspected (and, in supervised mode, authorized) it. */
  scope: ScopeReport;
  /** Disclosures the caller adds to the report's unverified list (one-shot authorizations). */
  notes?: readonly string[];
  /** Called after each long phase. A non-null value stops the collection and is handed back (VERIFYING's safe points). */
  checkpoint?: () => Promise<S | null>;
  /** Every gate the collection decides, in order, for the caller to record. */
  onGate?: (gate: GateResult<unknown>) => void;
  /**
   * Run the agent-driven UI exploration when `ui.exploration` is on and UI evidence is required. Only the
   * controller does: it starts workers. When off and exploration would have run, the report says so.
   */
  exploration: boolean;
}

export interface CollectedEvidence {
  report: EvidenceReport;
  /** Why the verdict is FAIL (the evaluation's reasons plus the security and UI gates'), for status output. */
  failReasons: string[];
  incompleteReasons: string[];
  evaluation: Evaluation;
  scan: SecretScanResult;
  sast: SastVerdict[];
  security: GateResult<unknown>;
  ui: GateResult<unknown>;
  uiRequired: boolean;
  exploration: ExplorationResult | null;
}

/** Where one candidate's UI run writes its evidence (and ui-result.json); the VERIFYING step reads it back to judge a run that never started. */
export function uiEvidenceDir(runDir: string, seq: number): string {
  return join(candidateEvidenceDir(runDir, seq), 'ui');
}

export type CollectOutcome<S> = { stopped: S } | { evidence: CollectedEvidence };

/** The note `orbit verify` adds when the controller would have explored the UI and it did not. */
export const EXPLORATION_NOT_RUN = 'UI exploration (ui.exploration) runs only in the controller\'s VERIFYING step; this verification did not explore the UI';

export async function collectVerificationEvidence<S = never>(ctx: RunContext, cand: CandidateRecord, opts: CollectOptions<S>): Promise<CollectOutcome<S>> {
  const contract = ctx.contract;
  if (!contract) throw new OrbitError('TRANSITION_INVALID', `run ${ctx.run.id} has no contract yet; there is nothing to verify`);
  const baseRev = ctx.run.baseRevision;
  if (!baseRev) throw new OrbitError('TRANSITION_INVALID', `run ${ctx.run.id} has no base revision; preflight did not finish`);
  const snapshot = ctx.snapshot;
  const { checkoutDir, scope } = opts;
  const gate = (g: GateResult<unknown>): void => opts.onGate?.(g);
  const checkpoint = async (): Promise<S | null> => (opts.checkpoint ? opts.checkpoint() : null);

  // Trusted checks in a clean, writable checkout of exactly this tree.
  const runner: RunnerContext = {
    db: ctx.db,
    run: { id: ctx.run.id, policyHash: ctx.run.policyHash },
    snapshot,
    isolation: ctx.isolation(),
    checkoutDir,
    runDir: ctx.runDir,
    clock: ctx.clock,
    // The signal means "stop supervising" (lease lost, shutdown, watchdog), never "cancel": the checks keep running
    // for the run's next owner. A durable cancellation reaches the runner through the run row.
    detachSignal: ctx.signal,
    pollMs: ctx.timing.checkPollMs,
    killGraceMs: ctx.timing.killGraceMs,
    homeDir: homeOf(ctx.deps),
    toolchainCacheRoot: toolchainCacheRootFor(ctx),
  };
  const install = await installDependencies({ ...runner, candidate: cand });
  const commandChecks = contract.required_check_ids.filter((id) => snapshot.config.checks[id]?.kind === 'command');
  const results: CheckResult[] = [...install.results];
  if (install.skipped || install.ok) results.push(...(await runChecks({ ...runner, candidate: cand, checkIds: commandChecks })));
  const afterChecks = await checkpoint();
  if (afterChecks !== null) return { stopped: afterChecks };
  if (ctx.signal.aborted) throw new OrbitError('CANCELLED', 'the step was interrupted during checks');

  // UI checks when UI paths changed or a criterion needs browser evidence.
  const changed = await changedPaths(ctx.run.repoRoot, baseRev, cand.commitSha);
  const ui = snapshot.config.ui;
  const uiRequired = contract.acceptance_criteria.some((c) => c.ui === true) || (ui !== null && ui.required_when_ui_changes && changed.some(compileGlobs(ui.ui_paths, { nocase: false })));
  let uiResult: UiRunResult | null = null;
  if (uiRequired && ui && ui.journey_check_ids.length > 0) {
    uiResult = await runUiChecks({ checkoutDir, snapshot, candidate: cand, uiConfig: ui, journeyCheckIds: ui.journey_check_ids, isolation: ctx.isolation(), outDir: uiEvidenceDir(ctx.runDir, cand.seq), clock: ctx.clock, abortSignal: ctx.signal, homeDir: homeOf(ctx.deps), hostEnv: ctx.deps.hostEnv ?? process.env, toolchainCacheRoot: toolchainCacheRootFor(ctx) });
    const afterUi = await checkpoint();
    if (afterUi !== null) return { stopped: afterUi };
  }
  const uiG = uiGate({ required: uiRequired, configured: ui !== null && ui.journey_check_ids.length > 0, result: uiResult });
  gate(uiG);

  // Agent-driven exploration (ui.exploration): only reproduced findings count, and they count as failures.
  let exploration: ExplorationResult | null = null;
  const wouldExplore = uiRequired && explorationEnabled(ui);
  if (wouldExplore && opts.exploration) {
    exploration = await exploreCandidate(ctx, cand, checkoutDir, join(candidateEvidenceDir(ctx.runDir, cand.seq), 'ui-exploration'));
    const explored = await checkpoint();
    if (explored !== null) return { stopped: explored };
  }

  // Static security: the secret scan of the change and configured SAST, both judged under the run's frozen
  // static_security policy (severities, exceptions and their expiry) at the controller's clock.
  const staticPolicy = staticSecurityPolicy(snapshot.config);
  const judgedAt = ctx.clock.now();
  const scan = await scanCandidateSecrets({
    repoRoot: ctx.run.repoRoot,
    baseRev,
    commit: cand.commitSha,
    outDir: join(candidateEvidenceDir(ctx.runDir, cand.seq), 'security'),
    ...(ctx.deps.gitleaksPath === undefined ? {} : { gitleaksPath: ctx.deps.gitleaksPath }),
    hostPath: (ctx.deps.hostEnv ?? process.env).PATH,
    policy: staticPolicy,
    now: judgedAt,
  });
  const sastVerdicts = sastCheckIds(snapshot).map((id) => judgeSastResult(results.find((r) => r.checkId === id) ?? null, id, staticPolicy, judgedAt));
  const security = staticSecurityGate({ scan, sast: sastVerdicts.map((v) => ({ checkId: v.checkId, status: v.status })) });
  gate(security);

  // The evidence report, bound to tree, check configuration and policy.
  const uiResults: UiResultInput[] = uiResult ? toEvidenceUi(uiResult) : [];
  const base = await baseComparison(ctx, baseRev, cand.commitSha);
  const evaluation = evaluateEvidence({ contract, candidate: cand, checkResults: results, uiResults, scope, snapshot, uiRequired, base, runDir: ctx.runDir });
  const report = evaluation.report;
  const failReasons = [...evaluation.failReasons];
  const disclose = (text: string): void => {
    if (!report.unverified.includes(text)) report.unverified.push(text);
  };
  // A gate's notes say what it could not establish; a gate with nothing to judge (not applicable) established nothing and
  // claims nothing, so its note (the reason) is a decision detail, not something left unverified (issue #33).
  for (const g of [security, uiG]) if (g.status !== 'not_applicable') for (const n of g.notes) disclose(n);
  for (const n of opts.notes ?? []) disclose(n);
  // A dependency audit that could not run on this candidate is unverified, never silently a pass (a blocking one stopped the install).
  if (install.audit && install.audit.blocking.length === 0 && install.audit.summary) disclose(install.audit.summary);
  // Waived or advisory SAST findings, and SARIF that could not be read, are disclosed with the evidence.
  for (const v of sastVerdicts) if (v.note && (!v.classification || v.classification.excepted.length > 0 || v.classification.advisory.length > 0)) disclose(v.note);
  if (security.status === 'fail') {
    report.verdict = 'FAIL';
    failReasons.push(...security.reasons);
  }
  if (uiG.status === 'fail' && report.verdict === 'PASS') {
    report.verdict = 'FAIL';
    failReasons.push(...uiG.reasons);
  }
  if (exploration) {
    for (const n of explorationUnverified(exploration)) disclose(n);
    if (exploration.reproduced.length > 0) {
      report.verdict = 'FAIL';
      const why = `UI exploration reproduced ${exploration.reproduced.length} defect(s) as failing tests: ${exploration.reproduced.map((f) => `${f.id} (${f.severity})`).join(', ')}`;
      disclose(why);
      failReasons.push(why);
    }
  } else if (wouldExplore && !opts.exploration) {
    disclose(EXPLORATION_NOT_RUN);
  }
  return { evidence: { report, failReasons, incompleteReasons: evaluation.incompleteReasons, evaluation, scan, sast: sastVerdicts, security, ui: uiG, uiRequired, exploration } };
}

/**
 * What the candidate is compared with so a green check that the base revision gives as well is not taken as proof:
 * the base tree, the base revision's recorded check results (only a baseline of this revision under this policy),
 * the paths the candidate adds or modifies, and what tells which of them are tests (ADR 0011): the test layout of
 * both trees and, when no changed path is a test by itself, the diffs of the files only content can show a test in.
 */
async function baseComparison(ctx: RunContext, baseRev: string, commit: string): Promise<BaseComparison> {
  const repoRoot = ctx.run.repoRoot;
  const treeHash = (await git(repoRoot, ['rev-parse', '--verify', `${baseRev}^{tree}`])).trim();
  const baseline = readJsonIfExists<BaselineReport>(join(ctx.runDir, BASELINE_FILE));
  const usable = baseline !== null && baseline.schema === 'orbit.baseline/1' && baseline.baseTree === treeHash && baseline.policyHash === ctx.run.policyHash && Array.isArray(baseline.checks);
  const out = await git(repoRoot, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=ACMT', baseRev, commit, '--']);
  const changedPaths = out.split('\0').filter((p) => p.length > 0);
  // With the Rust modules the crate compiles: a #[test] the change adds to a module counts only when cargo builds it.
  const testLayout = await loadTestLayout(gitTreeReader((args) => git(repoRoot, args)), baseRev, commit, changedPaths, { rustModules: true });
  const diffs = new Map<string, string>();
  if (!changedPaths.some((p) => isTestPath(p, testLayout))) {
    // With full context: an added #[test] is judged by its whole attribute group in the candidate, whose #[ignore] or
    // cfg may be an unchanged line (with -U0 a change to the attribute alone of an ignored test counted).
    for (const p of changedPaths.filter(testedByContent).slice(0, MAX_CONTENT_DIFFS)) {
      diffs.set(p, await git(repoRoot, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', `-U${WHOLE_FILE_CONTEXT}`, baseRev, commit, '--', `:(literal)${p}`]));
    }
  }
  return {
    treeHash,
    checks: usable ? baseline.checks.map((c) => ({ checkId: c.checkId, status: c.status })) : null,
    changedPaths,
    testLayout,
    diffs,
  };
}

/** Changed files read for a test only their content shows; beyond this many, the rest are judged by path. */
const MAX_CONTENT_DIFFS = 50;
/**
 * Context lines that make git show the whole file in one hunk: more lines than any source the 8 MiB output limit lets
 * through, and twice it still fits the int git keeps it in (2^31 and more overflowed, measured with git 2.54). A diff
 * that is not whole is judged to add no test (policy/test-files.ts).
 */
const WHOLE_FILE_CONTEXT = 100_000_000;

async function changedPaths(repoRoot: string, baseRev: string, commit: string): Promise<string[]> {
  const out = await git(repoRoot, ['diff', '--name-only', '-z', '--no-renames', baseRev, commit, '--']);
  return out.split('\0').filter((p) => p.length > 0);
}
