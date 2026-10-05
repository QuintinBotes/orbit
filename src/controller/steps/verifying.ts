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
 * and to BLOCKED otherwise ("mandatory verification is unavailable"). An
 * environment failure (a failure the base revision has too with a denial in
 * its output, or a mandatory check that could not execute at all) is BLOCKED
 * first, whatever the verdict: no repair or inquiry can fix it.
 * A protected-path edit is a policy violation: BLOCKED, never repaired.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../core/hash.ts';
import { OrbitError } from '../../core/errors.ts';
import { applyBaselineExceptionAnswers } from '../../inquisition/baseline-exception.ts';
import { inspectScope } from '../../policy/scope.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../../evidence/candidate.ts';
import { git } from '../../evidence/git.ts';
import { evaluateEvidence, saveEvidenceReport } from '../../evidence/report.ts';
import { isFresh } from '../../evidence/freshness.ts';
import { currentEvidenceReport, recordFailure, setCandidateScope, setCandidateStatus, type CandidateRecord, type EvidenceReportRecord } from '../../evidence/store.ts';
import type { ScopeReport } from '../../evidence/types.ts';
import { detectTriggers, loadInquisitionSnapshot, PROOF_BLOCKING_TRIGGERS, thresholdsFromPolicy } from '../../inquisition/triggers.ts';
import type { Trigger } from '../../inquisition/types.ts';
import { validateModelOutput, type ImplementerOutput } from '../../contract/model-outputs.ts';
import { checksNotExecutedFor, environmentBlockReason, environmentFailuresFor, type BlockedCheck } from '../environment-block.ts';
import { listWorkers } from '../../storage/workers.ts';
import { runWorktreeRoot, type RunContext } from '../context.ts';
import { implementationScopeGate, behaviourGate, type ScopeGateDetails } from '../gates.ts';
import { authorizedOnce, deniedDependencyOperations, grantFor, requestAuthorization, scopeWithGrants } from '../authorization.ts';
import { collectVerificationEvidence } from '../verification.ts';
import { storedPlan } from './contracting.ts';
import { assertContract, decide, finishRun, move, progress, safePoint, type StepResult } from './common.ts';
import { recordGate } from './preflight.ts';

export async function verifyingStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  // An exception a person approved whose apply step never completed (the process died between recording the answer
  // and applying it) is part of the contract before any evidence is judged against it; otherwise a failure the
  // person accepted would be repaired.
  const exceptions = applyBaselineExceptionAnswers({ db: ctx.db, clock: ctx.clock, runId: ctx.run.id, runDir: ctx.runDir }, { snapshot: ctx.snapshot });
  if (exceptions.contract) ctx.contract = exceptions.contract;
  const contract = assertContract(ctx);
  const cand = ctx.candidate;
  if (!cand) throw new OrbitError('INTERNAL', `run ${ctx.run.id} is VERIFYING without a candidate`);
  const existing = currentEvidenceReport(ctx.db, ctx.run.id, cand.id);
  if (existing && isFresh(existing.report, { candidate: cand, snapshot: ctx.snapshot })) return act(ctx, cand, existing);

  // 1. Implementation scope: the gate the hooks only assist.
  let scope = cand.scope ?? (await inspectScope({ repoRoot: ctx.run.repoRoot, baseRev: ctx.run.baseRevision!, candidateRev: cand.commitSha, snapshot: ctx.snapshot, contractAllowedPaths: contract.allowed_paths }));
  if (!cand.scope) setCandidateScope(ctx.db, cand.id, scope);
  let scopeGate = implementationScopeGate(scope, ctx.snapshot);
  const authorizedOnceNotes: string[] = [];
  if (!scopeGate.passed && ctx.run.mode === 'supervised') {
    // Supervised mode asks a person before refusing a dependency change the policy does not authorize (spec section 5).
    const asked = await askForAuthorization(ctx, cand, scope, scopeGate.details);
    if (asked.kind === 'blocked') return asked.result;
    if (asked.kind === 'granted') {
      scope = asked.scope;
      authorizedOnceNotes.push(...asked.notes);
      scopeGate = implementationScopeGate(scope, ctx.snapshot);
      scopeGate.notes.push(...asked.notes);
    }
  }
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

  // 2-5. Trusted checks, UI checks and exploration, static security and the evidence report, in a clean,
  // writable checkout of exactly this tree: the one evidence function `orbit verify` uses too.
  const checkoutDir = join(runWorktreeRoot(ctx), `check-${cand.seq}`);
  await ensureCheckout(ctx, cand, checkoutDir);
  try {
    const collected = await collectVerificationEvidence<StepResult>(ctx, cand, { checkoutDir, scope, notes: authorizedOnceNotes, checkpoint: () => safePoint(ctx), onGate: (g) => recordGate(ctx, g), exploration: true });
    if ('stopped' in collected) return collected.stopped;
    const { report, evaluation, security, scan } = collected.evidence;
    if (security.status === 'fail') {
      for (const f of scan.findings) {
        recordFailure(ctx.db, { runId: ctx.run.id, candidateId: cand.id, source: 'check', sourceId: `secret-scan:${cand.id}:${f.file}:${f.line ?? 0}`, fingerprint: `secret-scan:${f.rule}:${f.file}`, excerpt: `potential secret (${f.rule}) at ${f.file}${f.line ? `:${f.line}` : ''}; value redacted` }, ctx.clock);
      }
    }
    recordGate(ctx, behaviourGate({ ...evaluation, report }));
    const saved = saveEvidenceReport({ db: ctx.db, runDir: ctx.runDir, candidate: cand, report, clock: ctx.clock });
    return act(ctx, cand, saved);
  } finally {
    // An interrupted step (lease lost, watchdog) leaves the checkout: the run's next owner may already be
    // checking this same tree in it, and ensureCheckout reuses or replaces it on the next pass.
    if (!ctx.signal.aborted) await cleanupCandidateCheckout(ctx.run.repoRoot, checkoutDir).catch(() => {});
  }
}

type AuthorizationOutcome = { kind: 'not-applicable' } | { kind: 'denied' } | { kind: 'blocked'; result: StepResult } | { kind: 'granted'; scope: ScopeReport; notes: string[] };

/**
 * A scope refusal made only of dependency changes the policy does not authorize: each one is authorized once by
 * a person's answer, refused, or asked about (the run blocks until the answer). Anything else in the refusal is
 * repaired as before, so nothing is asked about then.
 */
async function askForAuthorization(ctx: RunContext, cand: CandidateRecord, scope: ScopeReport, details: ScopeGateDetails): Promise<AuthorizationOutcome> {
  if (details.policyViolation) return { kind: 'not-applicable' };
  const ops = deniedDependencyOperations(scope, ctx.snapshot);
  if (ops.length === 0) return { kind: 'not-applicable' };
  const remaining = implementationScopeGate(scopeWithGrants(scope, ops), ctx.snapshot);
  if (!remaining.passed) return { kind: 'not-applicable' };
  const pending: string[] = [];
  const notes: string[] = [];
  for (const op of ops) {
    const g = grantFor(ctx, op, cand.treeHash);
    if (g.state === 'denied') return { kind: 'denied' };
    if (g.state === 'granted') {
      if (!authorizedOnce(ctx, op, cand.treeHash)) return { kind: 'denied' };
      notes.push(`authorized once by ${g.approvedBy} (decision ${g.decisionId}): ${op.summary}; the policy itself does not allow it`);
      continue;
    }
    const q = g.state === 'pending' ? g.questionId : requestAuthorization(ctx, op, cand).id;
    pending.push(`${q}: ${op.summary}`);
  }
  if (pending.length > 0) {
    return { kind: 'blocked', result: await finishRun(ctx, 'BLOCKED', `supervised mode: candidate ${cand.seq} needs a person's authorization before verification continues; answer approve-once or deny with orbit decide, then orbit resume ${ctx.run.id}. Questions: ${pending.join(' | ')}`, { outcome: { authorization: pending } }) };
  }
  return { kind: 'granted', scope: scopeWithGrants(scope, ops), notes };
}

async function act(ctx: RunContext, cand: CandidateRecord, ev: EvidenceReportRecord): Promise<StepResult> {
  const verdict = ev.report.verdict;
  if (verdict === 'PASS') {
    const trigger = pendingTrigger(ctx, cand, PROOF_BLOCKING_TRIGGERS);
    if (trigger) return move(ctx, 'INQUISITION', `green checks, but ${trigger.summary}`, { data: { trigger } });
    progress(ctx, 'evidence.pass', { candidate_id: cand.id, report_id: ev.id });
    return move(ctx, 'REVIEWING', `candidate ${cand.seq} verified: PASS (${ev.id})`);
  }
  // An environment failure is the environment's, and no repair can fix it, so neither the repair loop nor an inquiry
  // is entered for it: a failure the base revision has too with the sandbox or the host refusing an operation in its
  // output, or a mandatory check that could not execute at all (its process was killed before it printed anything).
  // A check that ran and failed on the code keeps the normal path.
  const sameAsBase = verdict === 'FAIL' ? environmentFailuresFor(ctx, cand, ev.report) : [];
  const environment = [...sameAsBase, ...checksNotExecutedFor(ctx, cand, ev.report).filter((n) => !sameAsBase.some((b) => b.checkId === n.checkId))];
  if (environment.length > 0) return blockOnEnvironment(ctx, cand, ev, environment);
  if (verdict === 'FAIL') return move(ctx, 'DIAGNOSING', `candidate ${cand.seq} failed verification (${ev.id})`, { data: { report_id: ev.id } });
  const trigger = pendingTrigger(ctx, cand, null);
  if (trigger) return move(ctx, 'INQUISITION', `verification incomplete: ${trigger.summary}`, { data: { trigger } });
  return finishRun(ctx, 'BLOCKED', `mandatory verification is unavailable for candidate ${cand.seq}: ${ev.report.unverified.slice(0, 5).join('; ') || 'the evidence is incomplete'}`, { outcome: { report_id: ev.id } });
}

async function blockOnEnvironment(ctx: RunContext, cand: CandidateRecord, ev: EvidenceReportRecord, failures: BlockedCheck[]): Promise<StepResult> {
  const reason = environmentBlockReason({ runId: ctx.run.id, candidateSeq: cand.seq, failures });
  const checks = failures.map((f) => ({ check_id: f.checkId, fingerprint: f.fingerprint, signals: f.signals, cause: f.cause, evidence_lines: f.lines, question_id: f.questionId, ...(f.logPath ? { log_path: f.logPath } : {}) }));
  decide(ctx, { id: `dec-${ctx.run.id}-environment-${cand.id}`, kind: 'verification.environment-failure', summary: reason, data: { candidate_id: cand.id, report_id: ev.id, checks } });
  const blockedIds = new Set(failures.map((f) => f.checkId));
  const others = ev.report.checks.filter((c) => (c.status === 'FAILED' || c.status === 'TIMEOUT') && !blockedIds.has(c.id)).map((c) => c.id);
  return finishRun(ctx, 'BLOCKED', reason, { outcome: { candidate_id: cand.id, report_id: ev.id, environment_failures: checks, other_failing_checks: others } });
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
