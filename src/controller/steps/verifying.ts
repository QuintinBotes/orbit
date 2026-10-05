/**
 * VERIFYING (spec sections 5 and 11): the implementation-scope gate
 * (independent diff inspection), the trusted checks in a clean checkout of
 * the exact candidate, UI checks when UI paths changed or a criterion needs
 * them, the static security gate, and an evidence report bound to the
 * candidate tree, the check configuration and the policy.
 *
 * PASS goes to review unless a proof-weakening trigger fires (scenario 5:
 * weak tests are rejected despite green status); FAIL goes to diagnosis with
 * failure records; INCOMPLETE goes to Inquisition when a trigger explains it
 * and to BLOCKED otherwise ("mandatory verification is unavailable").
 * A protected-path edit is a policy violation: BLOCKED, never repaired.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../core/hash.ts';
import { OrbitError } from '../../core/errors.ts';
import { inspectScope } from '../../policy/scope.ts';
import { compileGlobs } from '../../policy/globs.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../../evidence/candidate.ts';
import { git } from '../../evidence/git.ts';
import { installDependencies } from '../../evidence/baseline.ts';
import { candidateEvidenceDir, runChecks, type RunnerContext } from '../../evidence/runner.ts';
import { evaluateEvidence, saveEvidenceReport, type UiResultInput } from '../../evidence/report.ts';
import { isFresh } from '../../evidence/freshness.ts';
import { currentEvidenceReport, recordFailure, setCandidateScope, setCandidateStatus, type CandidateRecord, type EvidenceReportRecord } from '../../evidence/store.ts';
import type { CheckResult, ScopeReport } from '../../evidence/types.ts';
import { runUiChecks, toEvidenceUi } from '../../ui/runner.ts';
import type { UiRunResult } from '../../ui/types.ts';
import { detectTriggers, loadInquisitionSnapshot, PROOF_BLOCKING_TRIGGERS, thresholdsFromPolicy } from '../../inquisition/triggers.ts';
import type { Trigger } from '../../inquisition/types.ts';
import { validateModelOutput, type ImplementerOutput } from '../../contract/model-outputs.ts';
import { listWorkers } from '../../storage/workers.ts';
import { homeOf, runWorktreeRoot, type RunContext } from '../context.ts';
import { implementationScopeGate, staticSecurityGate, uiGate, behaviourGate } from '../gates.ts';
import { sastCheckIds, scanCandidateSecrets } from '../security.ts';
import { storedPlan } from './contracting.ts';
import { assertContract, decide, finishRun, move, progress, safePoint, type StepResult } from './common.ts';
import { recordGate } from './preflight.ts';

export async function verifyingStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  const contract = assertContract(ctx);
  const cand = ctx.candidate;
  if (!cand) throw new OrbitError('INTERNAL', `run ${ctx.run.id} is VERIFYING without a candidate`);
  const existing = currentEvidenceReport(ctx.db, ctx.run.id, cand.id);
  if (existing && isFresh(existing.report, { candidate: cand, snapshot: ctx.snapshot })) return act(ctx, cand, existing);

  // 1. Implementation scope: the gate the hooks only assist.
  const scope = cand.scope ?? (await inspectScope({ repoRoot: ctx.run.repoRoot, baseRev: ctx.run.baseRevision!, candidateRev: cand.commitSha, snapshot: ctx.snapshot, contractAllowedPaths: contract.allowed_paths }));
  if (!cand.scope) setCandidateScope(ctx.db, cand.id, scope);
  const scopeGate = implementationScopeGate(scope, ctx.snapshot);
  recordGate(ctx, scopeGate);
  if (!scopeGate.passed) {
    decide(ctx, { id: `dec-${ctx.run.id}-deny-${cand.id}`, kind: 'policy.deny', summary: `candidate ${cand.seq} denied by scope inspection: ${scopeGate.reasons.join('; ')}`, data: { candidate_id: cand.id, scope, policy_violation: scopeGate.details.policyViolation } });
    recordFailure(ctx.db, { runId: ctx.run.id, candidateId: cand.id, source: 'worker', sourceId: `scope:${cand.id}`, fingerprint: scopeFingerprint(scope), excerpt: scopeGate.reasons.join('; ').slice(0, 2000) }, ctx.clock);
    const report = saveEvidenceReport({ db: ctx.db, runDir: ctx.runDir, candidate: cand, report: evaluateEvidence({ contract, candidate: cand, checkResults: [], scope, snapshot: ctx.snapshot }).report, clock: ctx.clock });
    if (scopeGate.details.policyViolation) {
      setCandidateStatus(ctx.db, cand.id, 'INVALIDATED');
      return finishRun(ctx, 'BLOCKED', `policy violation in candidate ${cand.seq}: ${scopeGate.reasons.join('; ')}; the candidate is invalidated and will not be reviewed or delivered`, { outcome: { candidate_id: cand.id, scope } });
    }
    return act(ctx, cand, report);
  }

  // 2. Trusted checks in a clean, writable checkout of exactly this tree.
  const checkoutDir = join(runWorktreeRoot(ctx), `check-${cand.seq}`);
  await ensureCheckout(ctx, cand, checkoutDir);
  try {
    const runner: RunnerContext = {
      db: ctx.db,
      run: { id: ctx.run.id, policyHash: ctx.run.policyHash },
      snapshot: ctx.snapshot,
      isolation: ctx.isolation(),
      checkoutDir,
      runDir: ctx.runDir,
      clock: ctx.clock,
      // The step's signal means "stop supervising" (lease lost, shutdown, watchdog), never "cancel": the checks
      // keep running for the run's next owner. A durable cancellation reaches the runner through the run row.
      detachSignal: ctx.signal,
      pollMs: ctx.timing.checkPollMs,
      killGraceMs: ctx.timing.killGraceMs,
      homeDir: homeOf(ctx.deps),
    };
    const install = await installDependencies({ ...runner, candidate: cand });
    const commandChecks = contract.required_check_ids.filter((id) => ctx.snapshot.config.checks[id]?.kind === 'command');
    const results: CheckResult[] = [...install.results];
    if (install.skipped || install.ok) results.push(...(await runChecks({ ...runner, candidate: cand, checkIds: commandChecks })));
    const after = await safePoint(ctx);
    if (after) return after;
    if (ctx.signal.aborted) throw new OrbitError('CANCELLED', 'the step was interrupted during checks');

    // 3. UI checks when UI paths changed or a criterion needs browser evidence.
    const changed = await changedPaths(ctx, cand);
    const ui = ctx.snapshot.config.ui;
    const uiRequired = contract.acceptance_criteria.some((c) => c.ui === true) || (ui !== null && ui.required_when_ui_changes && changed.some(compileGlobs(ui.ui_paths, { nocase: false })));
    let uiResult: UiRunResult | null = null;
    if (uiRequired && ui && ui.journey_check_ids.length > 0) {
      uiResult = await runUiChecks({ checkoutDir, snapshot: ctx.snapshot, candidate: cand, uiConfig: ui, journeyCheckIds: ui.journey_check_ids, isolation: ctx.isolation(), outDir: join(candidateEvidenceDir(ctx.runDir, cand.seq), 'ui'), clock: ctx.clock, abortSignal: ctx.signal, homeDir: homeOf(ctx.deps), hostEnv: ctx.deps.hostEnv ?? process.env });
      const uiAfter = await safePoint(ctx);
      if (uiAfter) return uiAfter;
    }
    const uiG = uiGate({ required: uiRequired, configured: ui !== null && ui.journey_check_ids.length > 0, result: uiResult });
    recordGate(ctx, uiG);

    // 4. Static security: secret scan of the change, configured SAST.
    const scan = await scanCandidateSecrets({ repoRoot: ctx.run.repoRoot, baseRev: ctx.run.baseRevision!, commit: cand.commitSha, outDir: join(candidateEvidenceDir(ctx.runDir, cand.seq), 'security'), ...(ctx.deps.gitleaksPath === undefined ? {} : { gitleaksPath: ctx.deps.gitleaksPath }), hostPath: (ctx.deps.hostEnv ?? process.env).PATH });
    const sast = sastCheckIds(ctx.snapshot).map((id) => ({ checkId: id, status: results.find((r) => r.checkId === id)?.status ?? null }));
    const security = staticSecurityGate({ scan, sast });
    recordGate(ctx, security);

    // 5. The evidence report, bound to tree, check configuration and policy.
    const uiResults: UiResultInput[] = uiResult ? toEvidenceUi(uiResult) : [];
    const evaluation = evaluateEvidence({ contract, candidate: cand, checkResults: results, uiResults, scope, snapshot: ctx.snapshot, uiRequired });
    const report = evaluation.report;
    report.unverified.push(...security.notes, ...uiG.notes.filter((n) => !report.unverified.includes(n)));
    if (security.status === 'fail') {
      report.verdict = 'FAIL';
      for (const f of scan.findings) {
        recordFailure(ctx.db, { runId: ctx.run.id, candidateId: cand.id, source: 'check', sourceId: `secret-scan:${cand.id}:${f.file}:${f.line ?? 0}`, fingerprint: `secret-scan:${f.rule}:${f.file}`, excerpt: `potential secret (${f.rule}) at ${f.file}${f.line ? `:${f.line}` : ''}; value redacted` }, ctx.clock);
      }
    }
    if (uiG.status === 'fail' && report.verdict === 'PASS') report.verdict = 'FAIL';
    recordGate(ctx, behaviourGate({ ...evaluation, report }));
    const saved = saveEvidenceReport({ db: ctx.db, runDir: ctx.runDir, candidate: cand, report, clock: ctx.clock });
    return act(ctx, cand, saved);
  } finally {
    // An interrupted step (lease lost, watchdog) leaves the checkout: the run's next owner may already be
    // checking this same tree in it, and ensureCheckout reuses or replaces it on the next pass.
    if (!ctx.signal.aborted) await cleanupCandidateCheckout(ctx.run.repoRoot, checkoutDir).catch(() => {});
  }
}

async function act(ctx: RunContext, cand: CandidateRecord, ev: EvidenceReportRecord): Promise<StepResult> {
  const verdict = ev.report.verdict;
  const trigger = pendingTrigger(ctx, cand, verdict === 'PASS' ? PROOF_BLOCKING_TRIGGERS : null);
  if (verdict === 'PASS') {
    if (trigger) return move(ctx, 'INQUISITION', `green checks, but ${trigger.summary}`, { data: { trigger } });
    progress(ctx, 'evidence.pass', { candidate_id: cand.id, report_id: ev.id });
    return move(ctx, 'REVIEWING', `candidate ${cand.seq} verified: PASS (${ev.id})`);
  }
  if (verdict === 'FAIL') return move(ctx, 'DIAGNOSING', `candidate ${cand.seq} failed verification (${ev.id})`, { data: { report_id: ev.id } });
  if (trigger) return move(ctx, 'INQUISITION', `verification incomplete: ${trigger.summary}`, { data: { trigger } });
  return finishRun(ctx, 'BLOCKED', `mandatory verification is unavailable for candidate ${cand.seq}: ${ev.report.unverified.slice(0, 5).join('; ') || 'the evidence is incomplete'}`, { outcome: { report_id: ev.id } });
}

/** Triggers keyed by condition; one already inquired into does not fire again (a second hit means the inquiry did not settle it). */
export function handledTriggerKeys(ctx: RunContext): Set<string> {
  const keys = new Set<string>();
  for (const r of ctx.db.all<{ data_json: string | null }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'inquisition.completed'", ctx.run.id)) {
    const k = r.data_json ? (JSON.parse(r.data_json) as { key?: string }).key : undefined;
    if (k) keys.add(k);
  }
  return keys;
}

export function pendingTrigger(ctx: RunContext, cand: CandidateRecord, only: readonly string[] | null): Trigger | null {
  const plan = storedPlan(ctx);
  const claims = latestImplementerClaims(ctx);
  const snapshot = loadInquisitionSnapshot(ctx.db, ctx.run.id, {
    currentTreeHash: cand.treeHash,
    expectedChangedFiles: plan?.expected_changed_files.map((f) => f.path) ?? [],
    changedFiles: cand.diffStat?.paths ?? [],
    claims,
    thresholds: thresholdsFromPolicy(ctx.snapshot.config),
  });
  const handled = handledTriggerKeys(ctx);
  return detectTriggers(snapshot).find((t) => !handled.has(t.key) && (only === null || only.includes(t.kind))) ?? null;
}

function latestImplementerClaims(ctx: RunContext): ImplementerOutput | null {
  const w = listWorkers(ctx.db, { runId: ctx.run.id, role: 'implementer' }).filter((x) => x.state === 'SUCCEEDED').at(-1);
  if (!w?.resultJson) return null;
  try {
    return validateModelOutput('implementer', (JSON.parse(w.resultJson) as { structured?: unknown }).structured);
  } catch {
    return null;
  }
}

function scopeFingerprint(scope: ScopeReport): string {
  return `scope:${sha256(JSON.stringify([[...scope.forbidden_paths_changed].sort(), [...scope.out_of_scope_paths_changed].sort(), scope.within_size_limits, scope.lockfile_changed, [...scope.symlinks_escaping].sort()])).slice(0, 16)}`;
}

/** Reuse a checkout of this exact tree left by an interrupted step (checks reattach to it); otherwise make a fresh one. */
async function ensureCheckout(ctx: RunContext, cand: CandidateRecord, dir: string): Promise<void> {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    try {
      const tree = (await git(dir, ['rev-parse', 'HEAD^{tree}'])).trim();
      if (tree === cand.treeHash && (await git(dir, ['status', '--porcelain', '--untracked-files=no'])).trim() === '') return;
    } catch {
      /* not a usable checkout */
    }
    await cleanupCandidateCheckout(ctx.run.repoRoot, dir);
  }
  await materializeCandidate(ctx.run.repoRoot, cand.commitSha, dir, { readOnly: false });
}

async function changedPaths(ctx: RunContext, cand: CandidateRecord): Promise<string[]> {
  const out = await git(ctx.run.repoRoot, ['diff', '--name-only', '-z', '--no-renames', ctx.run.baseRevision!, cand.commitSha, '--']);
  return out.split('\0').filter((p) => p.length > 0);
}

