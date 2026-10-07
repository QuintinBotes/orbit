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
import { atomicWriteJson } from '../../core/fsx.ts';
import { join } from 'node:path';
import { sha256 } from '../../core/hash.ts';
import { OrbitError } from '../../core/errors.ts';
import { applyBaselineExceptionAnswers } from '../../inquisition/baseline-exception.ts';
import { inspectScope } from '../../policy/scope.ts';
import { gitTreeReader, loadTestLayout } from '../../policy/test-files.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../../evidence/candidate.ts';
import { git } from '../../evidence/git.ts';
import { evaluateEvidence, saveEvidenceReport } from '../../evidence/report.ts';
import { isFresh } from '../../evidence/freshness.ts';
import { currentEvidenceReport, listCandidates, recordFailure, setCandidateScope, setCandidateStatus, type CandidateRecord, type EvidenceReportRecord } from '../../evidence/store.ts';
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
import { assertContract, decide, finishRun, move, note, progress, safePoint, type StepResult } from './common.ts';
import { briefPath, currentAttempt, type StoredBrief } from './implementing.ts';
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
  // A candidate invalidated for a policy violation is never repaired in place (the implementer may not touch the
  // protected paths it changed): after a person's resume the worktree is restored first (e2e Nm7).
  if (cand.status === 'INVALIDATED') return violatingCandidate(ctx, cand);
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
      const target = lastValidCandidate(ctx, cand);
      return finishRun(
        ctx,
        'BLOCKED',
        `policy violation in candidate ${cand.seq}: ${scopeGate.reasons.join('; ')}; the candidate is invalidated and will not be reviewed or delivered. The run's worktree keeps the change for inspection; orbit resume ${ctx.run.id} restores the worktree to ${target ? `candidate ${target.seq}` : 'the base revision'}, without the change, and repairs from there`,
        { outcome: { candidate_id: cand.id, scope } },
      );
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
    const trigger = await pendingTrigger(ctx, cand, PROOF_BLOCKING_TRIGGERS);
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
  const trigger = await pendingTrigger(ctx, cand, null);
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

export async function pendingTrigger(ctx: RunContext, cand: CandidateRecord, only: readonly string[] | null): Promise<Trigger | null> {
  const plan = storedPlan(ctx);
  const claims = latestImplementerClaims(ctx);
  const changedFiles = cand.diffStat?.paths ?? [];
  // The unexplained-architecture filter tells tests apart with the one test-file predicate, which needs the project
  // files of both trees for .NET and Rust (ADR 0011); loadTestLayout reads nothing when no such file changed.
  const base = ctx.run.baseRevision;
  const testLayout = base && (only === null || only.includes('unexplained_architecture')) ? await loadTestLayout(gitTreeReader((args) => git(ctx.run.repoRoot, args)), base, cand.commitSha, changedFiles) : undefined;
  const snapshot = loadInquisitionSnapshot(ctx.db, ctx.run.id, {
    currentTreeHash: cand.treeHash,
    expectedChangedFiles: plan?.expected_changed_files.map((f) => f.path) ?? [],
    changedFiles,
    ...(testLayout ? { testLayout } : {}),
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

/** The newest earlier candidate the policy did not invalidate: what a restored worktree goes back to. Null: the base revision. */
function lastValidCandidate(ctx: RunContext, cand: CandidateRecord): CandidateRecord | null {
  return listCandidates(ctx.db, ctx.run.id).filter((c) => c.seq < cand.seq && c.status !== 'INVALIDATED' && c.status !== 'CREATING').at(-1) ?? null;
}

/**
 * A candidate the policy invalidated (protected paths changed). Blocked again, unless a person resumed the run since
 * the block and no attempt has started since that resume: then the run's worktree, which still holds the violating
 * change and which the implementer may not repair, is restored to the last valid candidate (or the base revision),
 * and the next attempt redoes the work from there with a brief that says so.
 */
async function violatingCandidate(ctx: RunContext, cand: CandidateRecord): Promise<StepResult> {
  const reasons = cand.scope ? implementationScopeGate(cand.scope, ctx.snapshot).reasons : [];
  const deny = ctx.db.get<{ id: number }>("SELECT id FROM events WHERE run_id = ? AND type = 'decision.recorded' AND json_extract(data_json, '$.decision_id') = ? ORDER BY id DESC LIMIT 1", ctx.run.id, `dec-${ctx.run.id}-deny-${cand.id}`);
  const resumed = ctx.db.get<{ id: number }>("SELECT id FROM events WHERE run_id = ? AND type = 'run.resumed' AND id > ? ORDER BY id DESC LIMIT 1", ctx.run.id, deny?.id ?? 0);
  const attemptSince = resumed ? ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'implementation.attempt' AND id > ?", ctx.run.id, resumed.id) : undefined;
  if (!resumed || attemptSince || !ctx.run.worktreePath || !ctx.run.baseRevision) {
    return finishRun(ctx, 'BLOCKED', `policy violation in candidate ${cand.seq}: ${reasons.join('; ') || 'the policy invalidated it'}; the candidate is invalidated and will not be reviewed or delivered`, { outcome: { candidate_id: cand.id, scope: cand.scope } });
  }
  const target = lastValidCandidate(ctx, cand);
  await restoreWorktree(ctx.run.worktreePath, ctx.run.baseRevision, target?.commitSha ?? null);
  note(ctx, 'worktree.restored', { candidate_id: cand.id, restored_to: target ? target.id : 'base', commit: target?.commitSha ?? ctx.run.baseRevision, resumed_event_id: resumed.id });
  const contract = assertContract(ctx);
  const next = currentAttempt(ctx) + 1;
  const fingerprint = cand.scope ? scopeFingerprint(cand.scope) : `scope:${cand.id}`;
  const from = target ? `candidate ${target.seq} (tree ${target.treeHash.slice(0, 12)})` : `the base revision ${ctx.run.baseRevision.slice(0, 12)}`;
  const stored: StoredBrief = {
    attempt: next,
    source: 'scope',
    fingerprint,
    brief: {
      fingerprint,
      evidence: [`candidate ${cand.seq} was invalidated by the policy: ${reasons.join('; ') || 'protected paths changed'}`, `the controller restored the worktree to ${from} after a person resumed the run; the violating change is gone`],
      hypotheses: [{ statement: 'The previous attempt edited paths the policy protects, so its work cannot be verified or delivered', supporting: reasons.join('; ') || 'policy violation recorded for the candidate' }],
      experiment: 'Compare the worktree with the contract allowed paths before changing anything and list what the task still needs',
      expected_observation: 'No protected path differs from the base revision, and the remaining work lies inside the allowed paths',
      scoped_fix: `Redo the work of attempt ${cand.attempt} starting from ${from}, keeping every change inside ${contract.allowed_paths.join(', ')}`,
      post_fix_checks: contract.required_check_ids,
      preserved_constraints: [`Never edit protected paths: ${ctx.snapshot.effective_protected_paths.join(', ')}`, 'Keep the behaviour tests that prove the acceptance criteria'],
    },
  };
  if (!existsSync(briefPath(ctx, next))) atomicWriteJson(briefPath(ctx, next), stored);
  return move(ctx, 'DIAGNOSING', `candidate ${cand.seq} violated the policy; the worktree was restored to ${from} and attempt ${next} repairs from there`, { data: { attempt: next, restored_to: target?.id ?? 'base' } });
}

/**
 * The run's worktree back to `commit` (a candidate) or to the base revision: tracked files reset, files git does not
 * ignore removed, then the candidate's content laid over the base the way an attempt leaves it (HEAD stays at the
 * base, so the next snapshot diffs against it as before). Ignored files (dependencies, build output) are kept.
 */
async function restoreWorktree(worktree: string, base: string, commit: string | null): Promise<void> {
  await git(worktree, ['reset', '-q', '--hard', base]);
  await git(worktree, ['clean', '-q', '-fd']);
  if (commit === null) return;
  await git(worktree, ['read-tree', '-u', '-m', base, commit]);
  await git(worktree, ['reset', '-q']);
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
