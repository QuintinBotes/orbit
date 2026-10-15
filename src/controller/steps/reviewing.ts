/**
 * REVIEWING (spec section 12): an independent reviewer examines the exact
 * candidate through a packet built from the contract, the diff and the bound
 * evidence. Findings are claims: recorded, resolved only by evidence on this
 * tree, never by vote. Confirmed defects go back through DIAGNOSING (which
 * owns the attempt allowance) with a review repair brief; claims that need a
 * discriminating test go to the Inquisition; a clear review moves on to
 * delivery. A review that asked for repair only through notes on a
 * classification Orbit recorded gets one fresh review of the same tree, whose
 * APPROVE alone lets the run go on. A mandatory independent reviewer that is
 * unavailable blocks.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, atomicWriteJson } from '../../core/fsx.ts';
import { OrbitError, isOrbitError } from '../../core/errors.ts';
import { getDecision, listDecisions } from '../../storage/decisions.ts';
import { clipAtWord } from '../../core/text.ts';
import { recordReviewDepth, reviewDepthOf } from '../review-depth.ts';
import { listWorkers } from '../../storage/workers.ts';
import { renderWorkerPrompt } from '../../adapters/prompt.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../../evidence/candidate.ts';
import { currentEvidenceReport, listCandidates, type CandidateRecord, type CheckRunRecord } from '../../evidence/store.ts';
import { isFresh } from '../../evidence/freshness.ts';
import { buildReviewPacket } from '../../review/packet.ts';
import { ingestFindings, resolveFindings, type ClaimEvidence, type Disposition, type Resolution } from '../../review/resolve.ts';
import { findingFingerprint, severityRank, type FindingSeverity } from '../../review/types.ts';
import { appendEvent } from '../../storage/events.ts';
import { listCheckRuns } from '../../evidence/store.ts';
import { git } from '../../evidence/git.ts';
import type { EvidenceReport, RepairBrief } from '../../evidence/types.ts';
import { isTestCommandCheck, probeLogExcerpt, probeLogPath, underCheck, type ProbeChange, type ProbeResult } from '../../evidence/fail-before.ts';
import { probeChanges, runRepairProbe, type ProbeChanges } from '../fail-before.ts';
import { validateModelOutput, type ImplementerOutput } from '../../contract/model-outputs.ts';
import { mentionsIrreversible, riskCategoriesInText } from '../../inquisition/heuristics.ts';
import { progressSince, type NonProgressDecision } from '../../inquisition/repair.ts';
import { extensionDecisionRecord } from '../../scheduling/budget.ts';
import { marksCharges } from '../../scheduling/accounting.ts';
import { attemptHistory } from './diagnosing.ts';
import { selectReviewer, selectionDecisionRecord, type ReviewerSelection } from '../../review/select.ts';
import { failBeforePolicy } from '../../policy/config.ts';
import { preferredReviewProvider } from '../../policy/review.ts';
import { sameProviderApproval } from './review-approval.ts';
import type { CredentialStatus } from '../../adapters/types.ts';
import { listReviews, loadResolverState, markReviewInvalidated, persistResolution, recordReview } from '../../review/store.ts';
import { EVIDENCE_CLASSIFICATION_CATEGORY, type IngestedReview, type ReviewRecord } from '../../review/types.ts';
import { listAmendments, listLedger, listQuestions } from '../../inquisition/store.ts';
import type { Trigger } from '../../inquisition/types.ts';
import { machineAdmission, runWorktreeRoot, schedulerFor, type RunContext } from '../context.ts';
import { blockingQuestions, independentReviewGate } from '../gates.ts';
import { assertContract, blockOnAuth, blockOnOpenQuestions, decide, finishRun, MAX_REGENERATIONS, move, note, policySummary, progress, safePoint, WAIT, type StepResult } from './common.ts';
import { compileGlobs } from '../../policy/globs.ts';
import { budgetAdmission, DEFAULT_CONTEXT_DUPLICATION } from '../../scheduling/scheduler.ts';
import type { WorkUnit } from '../../scheduling/types.ts';
import { listActiveWorkers } from '../../storage/workers.ts';
import { stopWorker } from '../../recovery/reconcile.ts';
import { recordSpendCap, sessionSpendCap, stopAndSettle, workersFor } from '../workers.ts';
import { runningUnits } from './implementing.ts';
import { obtain } from './obtain.ts';
import { checkEnvironment, IMPLEMENTER_PROVIDER, recordGate } from './preflight.ts';
import { attemptCandidateId, briefPath, currentAttempt, type StoredBrief } from './implementing.ts';
import { handledTriggerKeys } from './verifying.ts';

export async function reviewingStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  const contract = assertContract(ctx);
  const cand = ctx.candidate;
  if (!cand || !ctx.ledger) throw new OrbitError('INTERNAL', `run ${ctx.run.id} is REVIEWING without a candidate or budget`);
  const ev = currentEvidenceReport(ctx.db, ctx.run.id, cand.id);
  if (!ev || ev.verdict !== 'PASS' || !isFresh(ev.report, { candidate: cand, snapshot: ctx.snapshot, contract })) {
    throw new OrbitError('STALE_EVIDENCE', `candidate ${cand.seq} has no fresh PASS evidence; review authorizes nothing without it`);
  }

  // Reviews of an older revision still running are obsolete (spec section 8: cancel work a new revision made worthless).
  await cancelObsoleteWork(ctx, cand.treeHash);
  // A tree whose review asked for repair only through notes has its one fresh review before anything else is decided.
  const fresh = freshReviewOf(ctx, cand.treeHash);
  if (fresh) return freshReview(ctx, cand, fresh);
  const focuses = reviewFocuses(ctx, cand);
  // Every review unit of this tree already recorded (a restart after recording): resolve and decide.
  if (listReviews(ctx.db, ctx.run.id, { treeHash: cand.treeHash }).length >= focuses.length) return resolveAndDecide(ctx, cand);

  const usable = await usableReviewer(ctx, cand);
  if (!usable.ok) return usable.step;
  const sel = usable.sel;
  if (focuses.length > 1) return parallelReview(ctx, cand, sel, focuses);
  const pending = await singleReview(ctx, cand, sel, { base: `review:${cand.id}`, what: `the ${sel.provider} reviewer`, fresh: null });
  return pending ?? resolveAndDecide(ctx, cand);
}

type SelectedReviewer = Extract<ReviewerSelection, { decision: 'SELECT' }>;

/** The reviewer for the candidate, or the step that blocks the run because none may review it (yet). */
async function usableReviewer(ctx: RunContext, cand: CandidateRecord): Promise<{ ok: true; sel: SelectedReviewer } | { ok: false; step: StepResult }> {
  const sel = await reviewerSelection(ctx, cand);
  if (sel.decision === 'BLOCK') {
    if (sel.code === 'AUTH_EXPIRED' || sel.code === 'AUTH_MISSING') {
      const provider = sel.alternatives.find((a) => /credentials/.test(a.reason))?.provider ?? preferredReviewProvider(ctx.snapshot.config.review) ?? IMPLEMENTER_PROVIDER;
      return { ok: false, step: await blockOnAuth(ctx, provider, sel.code === 'AUTH_MISSING' ? 'missing' : 'expired', sel.reason) };
    }
    return { ok: false, step: await finishRun(ctx, 'BLOCKED', `independent review unavailable: ${sel.reason}`, { outcome: { reviewer: sel } }) };
  }
  // review.when_unavailable: ask (decision 0007): the same-provider review runs only on a person's yes.
  if (sel.needsApproval === true) {
    const approval = sameProviderApproval(ctx, sel);
    // The reason names no policy setting on purpose: a person's answer clears this block, so resuming must not be refused as a frozen-policy block.
    if (approval.state === 'pending') {
      return {
        ok: false,
        step: await finishRun(
          ctx,
          'BLOCKED',
          `no independent reviewer is usable; review.when_unavailable is ask, so question ${approval.questionId} asks whether ${sel.provider} may review this run's candidate in a separate session (not independently). Answer with orbit decide ${ctx.run.id} ${approval.questionId} yes (or no), then orbit resume ${ctx.run.id}`,
          { outcome: { reviewer: sel, questions: [approval.questionId] } },
        ),
      };
    }
    if (approval.state === 'declined') {
      return {
        ok: false,
        step: await finishRun(ctx, 'BLOCKED', `${approval.by ?? 'nobody'} declined a same-provider review (question ${approval.questionId}) and no independent reviewer is usable; make one usable (orbit doctor shows why it is not), then start a new run`, {
          outcome: { reviewer: sel, questions: [approval.questionId] },
        }),
      };
    }
  }
  return { ok: true, sel };
}

/**
 * One general reviewer session of the candidate under the purpose `base`, recorded as a review of its tree. Returns the
 * step to take while it runs or when no usable review came back, and null once the review is recorded.
 */
async function singleReview(ctx: RunContext, cand: CandidateRecord, sel: SelectedReviewer, opts: { base: string; what: string; fresh: FreshReviewRecord | null }): Promise<StepResult | null> {
  const round = listReviews(ctx.db, ctx.run.id, { includeInvalidated: true }).length + 1;
  const { reviewDir, checkout } = await prepareReview(ctx, cand, sel.provider);
  const got = await obtain<{ review: IngestedReview; packetSha: string }>(ctx, {
    base: opts.base,
    maxAttempts: MAX_REGENERATIONS,
    what: opts.what,
    // One review round per reviewer session started, regenerations included: every session costs a round.
    beforeStart: () => ctx.ledger!.consume('review_rounds', 1),
    request: (purpose) => ({
      role: 'reviewer',
      purpose,
      candidateId: cand.id,
      provider: sel.provider,
      model: sel.model,
      effort: opts.fresh?.reason === 'shallow' ? SHALLOW_REVIEW_EFFORT : reviewEffort(ctx, sel),
      cwd: checkout,
      readOnly: true,
      phase: 'final',
      prompt: () => reviewerPrompt(ctx, cand, reviewDir, 'general', opts.fresh),
    }),
    accept: (r) => {
      try {
        return { review: ingestFindings({ output: r.structured, candidate: cand }), packetSha: packetShaOf(reviewDir) };
      } catch (err) {
        // A review of another revision says nothing about this tree: regenerate it like malformed output.
        if (isOrbitError(err, 'STALE_EVIDENCE')) throw new OrbitError('MALFORMED_OUTPUT', err.message);
        throw err;
      }
    },
  }).catch(async (err) => {
    await cleanupCandidateCheckout(ctx.run.repoRoot, checkout).catch(() => {});
    throw err;
  });
  if (!got.ok) {
    // A terminal outcome (no usable review) leaves no reviewer running: remove its read-only checkout too.
    if (got.step.done) await cleanupCandidateCheckout(ctx.run.repoRoot, checkout).catch(() => {});
    return got.step;
  }
  await cleanupCandidateCheckout(ctx.run.repoRoot, checkout).catch(() => {});
  recordReview(
    ctx.db,
    {
      id: `rev-${got.worker.id}`,
      runId: ctx.run.id,
      candidateId: cand.id,
      treeHash: cand.treeHash,
      round,
      provider: got.worker.provider,
      model: got.worker.model,
      workerId: got.worker.id,
      verdict: got.value.review.verdict,
      packetSha256: got.value.packetSha,
      findings: got.value.review.findings,
    },
    ctx.clock,
  );
  recordReviewDepth(ctx, got.worker, `rev-${got.worker.id}`);
  return null;
}

// ---------------------------------------------------------------------------
// Parallel review units (spec section 8: independent read-only work runs at once)

export type ReviewFocus = 'general' | 'security' | 'ui';

const FOCUS_TEXT: Record<Exclude<ReviewFocus, 'general'>, string> = {
  security: 'Focus: security. Authorization and tenancy, input validation, injection, secrets and sensitive data, unsafe defaults. Report any other defect you see as well.',
  ui: 'Focus: the user interface. User-visible states (empty, loading, error), accessibility, layout and interaction regressions on the changed screens. Report any other defect you see as well.',
};

/**
 * One general review, or, when the change is both security-sensitive (the planning assessment) and touches UI
 * paths, a security review and a UI review as separate read-only units that run at the same time.
 */
export function reviewFocuses(ctx: RunContext, cand: CandidateRecord): ReviewFocus[] {
  const ui = ctx.snapshot.config.ui;
  const changed = cand.diffStat?.paths ?? [];
  const uiChanged = ui !== null && (assertContract(ctx).acceptance_criteria.some((c) => c.ui === true) || changed.some(compileGlobs(ui.ui_paths, { nocase: false })));
  return securitySensitive(ctx) && uiChanged ? ['security', 'ui'] : ['general'];
}

function securitySensitive(ctx: RunContext): boolean {
  if (!ctx.run.difficultyJson) return false;
  try {
    return (JSON.parse(ctx.run.difficultyJson) as { factors?: { factor: string; value: unknown }[] }).factors?.some((f) => f.factor === 'security_impact' && f.value === true) ?? false;
  } catch {
    return false;
  }
}

function focusBase(cand: CandidateRecord, focus: ReviewFocus): string {
  return focus === 'general' ? `review:${cand.id}` : `review-${focus}:${cand.id}`;
}

/**
 * Start every review unit the scheduler admits in this step (each one read-only, bound to the candidate tree and
 * cancelled when it changes, budgeted from the route and the session spend cap), record each review as it
 * finishes, and resolve once all of them are in.
 */
async function parallelReview(ctx: RunContext, cand: CandidateRecord, sel: Extract<ReviewerSelection, { decision: 'SELECT' }>, focuses: ReviewFocus[]): Promise<StepResult> {
  const ledger = ctx.ledger!;
  const { reviewDir, checkout } = await prepareReview(ctx, cand, sel.provider);
  const recorded = new Set(listReviews(ctx.db, ctx.run.id, { treeHash: cand.treeHash }).map((r) => r.workerId));
  const config = ctx.snapshot.config;
  const scheduler = schedulerFor(ctx);
  const running = runningUnits(ctx);
  const own = new Set(running.filter((u) => u.runId === ctx.run.id).map((u) => u.unit.id));
  const pending: WorkUnit[] = [];
  const caps = new Map<string, { capUsd: number | null; worstCaseUsd: number }>();
  const toStart = focuses.filter((f) => workersFor(ctx, `${focusBase(cand, f)}#1`).length === 0);
  // Units starting together split what is left: each may overshoot its cap by one worst-case request, and every
  // unit after the first also pays for re-reading the shared context (the scheduler's duplication charge).
  const whole = sessionSpendCap(ctx, sel.model, 'reviewer', 'final');
  const n = Math.max(1, toStart.length);
  const share = whole.capUsd === null ? null : Math.max(0, Math.floor(((whole.capUsd + whole.worstCaseUsd - n * whole.worstCaseUsd) / (n + (n - 1) * DEFAULT_CONTEXT_DUPLICATION)) * 100) / 100);
  for (const focus of focuses) {
    const base = focusBase(cand, focus);
    if (!toStart.includes(focus)) continue;
    const cap = { capUsd: share, worstCaseUsd: whole.worstCaseUsd };
    caps.set(base, cap);
    pending.push({ id: base, role: 'reviewer', writer: false, ownedPaths: [], dependsOn: [], revision: cand.treeHash, cancelWhen: ['revision-changed'], budget: { costUsd: cap.capUsd, wallMs: null, maxTurns: ledger.maxTurnsPerSession() }, provider: sel.provider, worktree: checkout, status: 'pending' });
  }
  // The run's own limits and budget over its own units, then the machine's capacity over every run's.
  const plan = scheduler.plan([...running.filter((r) => own.has(r.unit.id)).map((r) => r.unit), ...pending], { parallelism: Math.max(focuses.length, config.agents.default_parallelism), admit: budgetAdmission(ledger, 'final') });
  const machine = machineAdmission(ctx, running.map((r) => r.unit), plan.start);
  const admitted = new Set(plan.start.map((u) => u.id).filter((id) => machine.start.has(id)));
  for (const [id, why] of machine.deferred) plan.deferred.push({ id, reason: why });
  if (plan.context_duplication.length > 0) note(ctx, 'scheduler.context-duplication', { candidate_id: cand.id, units: plan.context_duplication });
  for (const u of plan.start.filter((x) => admitted.has(x.id))) {
    const cap = caps.get(u.id);
    if (cap && cap.capUsd !== null) {
      if (cap.capUsd <= 0) return finishRun(ctx, 'EXHAUSTED', `the ${u.id} unit cannot start: no model budget left for review under the hard cap`);
      recordSpendCap(ctx, `${u.id}#1`, cap.capUsd, cap.worstCaseUsd);
    }
  }
  const waiting: string[] = [];
  let finished = 0;
  for (const focus of focuses) {
    const base = focusBase(cand, focus);
    const started = workersFor(ctx, `${base}#1`).length > 0;
    if (!started && !admitted.has(base)) {
      waiting.push(`${focus} review deferred: ${plan.deferred.find((d) => d.id === base)?.reason ?? 'not admitted'}`);
      continue;
    }
    const got = await obtain<{ review: IngestedReview; packetSha: string }>(ctx, {
      base,
      maxAttempts: MAX_REGENERATIONS,
      what: `the ${sel.provider} ${focus} reviewer`,
      beforeStart: () => ctx.ledger!.consume('review_rounds', 1),
      request: (purpose) => ({
        role: 'reviewer',
        purpose,
        candidateId: cand.id,
        provider: sel.provider,
        model: sel.model,
        effort: reviewEffort(ctx, sel),
        cwd: checkout,
        readOnly: true,
        phase: 'final',
        ...(typeof caps.get(base)?.capUsd === 'number' ? { maxBudgetUsd: caps.get(base)!.capUsd } : {}),
        prompt: () => reviewerPrompt(ctx, cand, reviewDir, focus),
      }),
      accept: (r) => {
        try {
          return { review: ingestFindings({ output: r.structured, candidate: cand }), packetSha: packetShaOf(reviewDir) };
        } catch (err) {
          if (isOrbitError(err, 'STALE_EVIDENCE')) throw new OrbitError('MALFORMED_OUTPUT', err.message);
          throw err;
        }
      },
    });
    if (!got.ok) {
      if (got.step.done) {
        await cleanupCandidateCheckout(ctx.run.repoRoot, checkout).catch(() => {});
        return got.step;
      }
      waiting.push(got.step.waiting ?? `${focus} review running`);
      continue;
    }
    finished++;
    if (recorded.has(got.worker.id)) continue;
    recordReview(
      ctx.db,
      {
        id: `rev-${got.worker.id}`,
        runId: ctx.run.id,
        candidateId: cand.id,
        treeHash: cand.treeHash,
        round: listReviews(ctx.db, ctx.run.id, { includeInvalidated: true }).length + 1,
        provider: got.worker.provider,
        model: got.worker.model,
        workerId: got.worker.id,
        verdict: got.value.review.verdict,
        packetSha256: got.value.packetSha,
        findings: got.value.review.findings,
      },
      ctx.clock,
    );
    recordReviewDepth(ctx, got.worker, `rev-${got.worker.id}`);
    recorded.add(got.worker.id);
  }
  if (finished < focuses.length) return WAIT(waiting.join('; ') || 'review units running');
  await cleanupCandidateCheckout(ctx.run.repoRoot, checkout).catch(() => {});
  return resolveAndDecide(ctx, cand);
}

/**
 * Stop read-only work bound to a revision that is no longer current (spec section 8): reviewers, verifiers and
 * explorers of another tree, through the scheduler's obsolescence rule. Returns the stopped worker ids. Each is charged
 * as it is stopped (no step asks for its purpose again, and it no longer counts as committed spend); a charge that
 * exhausts the budget is raised once every obsolete worker is stopped. A run started before 0.3.1 keeps 0.3.0's
 * accounting, which only stopped them.
 */
export async function cancelObsoleteWork(ctx: RunContext, currentTree: string): Promise<string[]> {
  const scheduler = schedulerFor(ctx);
  const trees = new Map(listCandidates(ctx.db, ctx.run.id).map((c) => [c.id, c.treeHash]));
  const active = listActiveWorkers(ctx.db, ctx.run.id).filter((w) => (w.role === 'reviewer' || w.role === 'verifier' || w.role === 'explorer') && w.candidateId !== null);
  const units: WorkUnit[] = active.map((w) => ({ id: w.id, role: w.role, writer: false, ownedPaths: [], dependsOn: [], revision: trees.get(w.candidateId!) ?? null, cancelWhen: ['revision-changed'], budget: {}, provider: w.provider, status: 'running' }));
  const stopped: string[] = [];
  let refused: unknown = null;
  const settles = marksCharges(ctx.db, ctx.run.id);
  for (const o of scheduler.obsolete(units, currentTree)) {
    const w = active.find((x) => x.id === o.unit.id)!;
    if (!settles) {
      await stopWorker({ db: ctx.db, clock: ctx.clock, ownerId: ctx.ownerId, adapters: ctx.deps.adapters, graceMs: ctx.timing.killGraceMs }, w, `obsolete: ${o.reason}`);
      stopped.push(w.id);
      continue;
    }
    try {
      // A reviewer spends from the closing reserve, as it was admitted; the others from ordinary work.
      await stopAndSettle(ctx, w, `obsolete: ${o.reason}`, w.role === 'reviewer' ? 'final' : 'work');
    } catch (err) {
      if (!isOrbitError(err, 'BUDGET_EXHAUSTED')) throw err;
      refused ??= err;
    }
    stopped.push(w.id);
  }
  if (stopped.length > 0) note(ctx, 'workers.obsolete-cancelled', { current_tree: currentTree, workers: stopped });
  if (refused) throw refused;
  return stopped;
}

async function resolveAndDecide(ctx: RunContext, cand: CandidateRecord): Promise<StepResult> {
  const state = loadResolverState(ctx.db, ctx.run.id, cand.treeHash);
  const repairs = reviewRepairs(ctx);
  const repaired = new Map<string, ReviewRepairRecord>();
  for (const r of repairs) for (const f of r.findings) for (const id of f.member_ids) repaired.set(id, r);
  // A finding a review of this tree raised again is the reviewer's claim about the repaired tree: the repair's test does
  // not override it. Nor does a test whose finding a review of an earlier tree that had it raised again (raisedOn).
  const closed = new Set([...state.findings, ...state.previousFindings].filter((f) => f.status === 'resolved' || f.status === 'rejected').map((f) => f.id));
  const raisedOn = new Map<string, Set<string>>();
  for (const f of [...state.findings, ...state.previousFindings]) {
    const fp = findingFingerprint(f);
    raisedOn.set(fp, (raisedOn.get(fp) ?? new Set<string>()).add(f.treeHash));
  }
  const { evidence, unresolved, repairedBy, probed } = await repairEvidence(ctx, cand, repairs, { raisedAgain: new Set(state.findings.map((f) => findingFingerprint(f))), raisedOn, closed });
  if (probed) {
    // The repair probe ran checks, a long phase of its own: the step's safe point follows it, as VERIFYING's does.
    const stop = await safePoint(ctx);
    if (stop) return stop;
  }
  const resolution = resolveFindings({ findings: state.findings, previousFindings: state.previousFindings, reviews: state.reviews, snapshot: ctx.snapshot, evidence, treeHash: cand.treeHash, now: ctx.clock.now() });
  markRepaired(resolution, repaired, repairedBy);
  const undecided = settleInquiredClaims(ctx, cand, resolution);
  noteUnresolvedRepairTests(resolution, unresolved);
  persistResolution(ctx.db, ctx.runDir, ctx.run.id, resolution, ctx.clock);
  const gate = independentReviewGate(ctx.db, { runId: ctx.run.id, treeHash: cand.treeHash, snapshot: ctx.snapshot, implementerProvider: implementerProvider(ctx), now: ctx.clock.now(), whyNotIndependent: recordedWhyNotIndependent(ctx), selectionIndependent: recordedSelectionIndependent(ctx) });
  recordGate(ctx, gate);
  if (gate.passed && gate.details.approved) {
    // An APPROVE that inspected nothing (no tool call recorded) does not clear a tree that changes something (ADR 0016,
    // item 3): one fresh review must open the files. A fresh review of the tree that inspected nothing, whatever its
    // verdict, leaves the tree without a review that looked at it, even when another approval stands: the run stops.
    if (cand.treeHash !== ctx.run.baseTree) {
      const shallow = shallowApprovals(ctx, state);
      const asked = freshReviewOf(ctx, cand.treeHash);
      const fresh = asked ? recordedFreshReview(ctx, asked) : null;
      if (fresh && reviewDepthOf(ctx, fresh.id)?.tool_calls === 0 && !shallow.some((r) => r.id === fresh.id)) shallow.push(fresh);
      if (shallow.length > 0) return decideShallowApproval(ctx, cand, shallow, gate.reasons);
    }
    progress(ctx, 'review.approved', { candidate_id: cand.id, tree_hash: cand.treeHash });
    const waiting = await blockOnOpenQuestions(ctx, 'delivery');
    if (waiting) return waiting;
    return move(ctx, 'DELIVERING', gate.details.independent ? `independent review cleared tree ${cand.treeHash}` : `review cleared tree ${cand.treeHash}, but it was ${gate.notes[0]}`);
  }

  // Review findings drive a repair loop (spec sections 12 and 14). A finding confirmed by evidence, and a
  // finding a reviewer asked to have repaired (REPAIR_REQUIRED, now or for an earlier tree) at a blocking
  // severity, becomes a repair brief; it is closed later only by the test the repair wrote for it, where a test check
  // passes on the pre-repair tree without that test, fails there with it and passes on the repaired tree (ADR 0015).
  const repairRequested = state.reviews.some((r) => r.verdict === 'REPAIR_REQUIRED');
  const blockRank = blockSeverityRank(ctx);
  const open = resolution.dispositions.filter((d) => d.status === 'accepted' || d.status === 'claim_pending' || d.status === 'open');
  const toRepair = open.filter(
    (d) => d.status === 'accepted' || undecided.has(d.findingId) || ((repairRequested || d.memberIds.some((id) => repaired.has(id))) && (d.blocking || severityRank(d.severity) <= blockRank)),
  );
  if (toRepair.length > 0) {
    const texts = findingTexts(state);
    // Spec section 10 and scenario 4: a finding about a criterion an open material question blocks is not repaired
    // on a guess. It waits with its criterion for a person; only the findings it does not touch are repaired.
    const waiting = blockingQuestions(ctx.db, ctx.run.id);
    const held = toRepair.filter((d) => blockedCriteriaIn(d, texts.get(d.findingId), waiting.criteria).length > 0);
    const repairable = toRepair.filter((d) => !held.includes(d));
    if (held.length > 0) {
      note(ctx, 'review.findings-held', { tree_hash: cand.treeHash, findings: held.map((d) => ({ id: d.findingId, external_id: d.externalId, criteria: blockedCriteriaIn(d, texts.get(d.findingId), waiting.criteria) })), questions: waiting.questions.map((q) => q.id) });
    }
    if (repairable.length === 0) {
      const blocked = await blockOnOpenQuestions(ctx, 'review repair', {
        detail: `Review finding(s) ${held.map((d) => d.externalId ?? d.findingId).join(', ')} concern ${waiting.criteria.length === 1 ? 'it' : 'them'} and are not repaired on a guess.`,
        outcome: { held_findings: openFindings(held) },
      });
      if (blocked) return blocked;
    }
    // Repeated non-progress on this path too (scenario 6): a repair that reproduced the tree it was sent to repair
    // brings back the same review, the same findings and the same brief, so another attempt would change nothing.
    const stalled = stalledReviewRepair(ctx, cand);
    if (stalled) {
      const outcome = { non_progress: stalled, open_findings: openFindings(toRepair) };
      // An unanswered material question may be why nothing changed: a person's answer, not another attempt, moves it.
      const blocked = await blockOnOpenQuestions(ctx, 'another review repair', { detail: `non-progress: ${stalled.reason}.`, outcome });
      if (blocked) return blocked;
      decide(ctx, { id: `dec-${ctx.run.id}-non-progress-review-${currentAttempt(ctx)}`, kind: 'repair.non-progress', summary: stalled.reason, data: stalled });
      return finishRun(ctx, 'EXHAUSTED', clipAtWord(`non-progress: ${stalled.reason}; open findings: ${describeFindings(toRepair)}`, 2000), { outcome });
    }
    // Only a disagreement, or a finding about material semantics nobody may guess, needs the Inquisition first;
    // a claim it has already inquired into on this tree goes to its discriminating test instead of back to it.
    const inquire = repairable
      .filter((d) => d.status !== 'accepted' && !undecided.has(d.findingId))
      .map((d) => ({ d, why: d.disagreement ? [`disagreement (${d.disagreement.kinds.join(', ')})`] : materialSemantics(ctx, d, texts.get(d.findingId)) }))
      .filter((x) => x.why.length > 0);
    if (inquire.length > 0) {
      const disagreement = inquire.some((x) => x.d.disagreement !== null);
      const trigger: Trigger = {
        kind: disagreement ? 'reviewer_disagreement' : 'hidden_decision',
        mode: disagreement ? 'reconcile' : 'risk-review',
        summary: `${inquire.length} review finding(s) need the Inquisition before any repair: ${inquire.map((x) => `${x.d.externalId ?? x.d.findingId} (${x.why.join('; ')})`).join(', ')}`.slice(0, 500),
        evidence: inquire.slice(0, 20).map((x) => `${x.d.findingId}: ${x.d.claim}`.slice(0, 300)),
        subjects: [],
        key: `review:${cand.treeHash}:${inquire.map((x) => x.d.fingerprint).sort().join(',')}`.slice(0, 500),
      };
      if (!handledTriggerKeys(ctx).has(trigger.key)) {
        const spent = await reviewRoundsSpent(ctx, `${repairable.length} open finding(s): ${describeFindings(repairable)}`, { open_findings: openFindings(repairable) });
        if (spent) return spent;
        return move(ctx, 'INQUISITION', trigger.summary, { data: { trigger } });
      }
    }
    return routeToRepair(ctx, cand, repairable, resolution, texts, { held, criteria: waiting.criteria, questions: waiting.questions.map((q) => q.id) });
  }

  if (resolution.claimsToTest.length > 0) {
    const trigger: Trigger = {
      kind: 'reviewer_disagreement',
      mode: 'reconcile',
      summary: `${resolution.claimsToTest.length} review claim(s) need a discriminating test before they can be accepted or rejected`,
      evidence: resolution.claimsToTest.slice(0, 20).map((c) => `${c.findingId}: ${c.statement}`.slice(0, 300)),
      subjects: [],
      key: claimsTriggerKey(cand, resolution.claimsToTest),
    };
    if (!handledTriggerKeys(ctx).has(trigger.key)) {
      // With an approving review on this tree, an inquiry that refutes the claims clears it with no further round,
      // so only without one does the spent round cap end the run here.
      if (!gate.details.approved) {
        const claims = resolution.dispositions.filter((d) => resolution.claimsToTest.some((c) => c.findingId === d.findingId));
        const spent = await reviewRoundsSpent(ctx, `${resolution.claimsToTest.length} review claim(s) still needing a discriminating test: ${describeFindings(claims)}`, { open_findings: openFindings(claims) });
        if (spent) return spent;
      }
      return move(ctx, 'INQUISITION', trigger.summary, { data: { trigger } });
    }
  }
  // A review that asked for repair only through notes (findings filed under evidence-classification that no check
  // confirmed: they dispute Orbit's own evidence classification) approves nothing, and no repair can answer it. It gets
  // one fresh review of the same tree, told so (ADR 0014, 0.3.1 addendum, item 3), rather than an attempt spent on the
  // same tree; only that reviewer's APPROVE lets the run go on. Without a review round left, or once the fresh review has
  // not approved either, the run stops here and says why.
  const noted = resolution.dispositions.filter((d) => d.recordedClassification !== undefined);
  const notes = noted.length === 0 ? '' : `; review finding(s) ${noted.map((d) => `${d.externalId ?? d.findingId} (${d.severity})`).join(', ')} are filed under the category ${EVIDENCE_CLASSIFICATION_CATEGORY} and confirmed by no check: they dispute ${[...new Set(noted.map((d) => d.recordedClassification!))].join(' and ')}, which no repair can change, so they are reported as notes and not repaired`;
  let fresh: { text: string; outcome: Record<string, unknown> } | null = null;
  const asked = freshReviewOf(ctx, cand.treeHash);
  if (asked) {
    fresh = describeFreshReview(ctx, asked, resolution, state);
  } else if (gate.passed && askedOnlyThroughNotes(state, noted).length > 0) {
    // Every review of the tree is cleared and none approves: an approval is all that is missing, and a fresh review is
    // the only thing that can give one. It costs a review round like any review, so none starts at the cap.
    const rounds = ctx.ledger!.state('review_rounds');
    if (rounds.used < rounds.allowance) return startFreshReview(ctx, cand, state, noted);
    fresh = {
      text: `; no fresh review of the tree was started: review_rounds hard cap reached (${rounds.used} of ${rounds.hard_cap})`,
      outcome: { started: false, reason: 'review_rounds hard cap reached', review_rounds: { used: rounds.used, hard_cap: rounds.hard_cap } },
    };
  }
  return finishRun(ctx, 'BLOCKED', `${gate.details.independent ? 'independent review' : 'review'} does not clear tree ${cand.treeHash}: ${gate.reasons.join('; ') || 'no approving review'}${notes}${fresh?.text ?? ''}`.slice(0, 2000), {
    outcome: { review_gate: gate.reasons, open_findings: openFindings(open), ...(noted.length > 0 ? { noted_findings: openFindings(noted) } : {}), ...(fresh ? { fresh_review: fresh.outcome } : {}) },
  });
}

// ---------------------------------------------------------------------------
// One fresh review of a tree a review asked to repair only through notes

/** The decision that starts the one fresh review of a tree (ADR 0014, 0.3.1 addendum, item 3). */
const FRESH_REVIEW_KIND = 'review.fresh';

interface FreshReviewRecord {
  /**
   * Why the tree gets its one fresh review: an earlier review asked for repair only through notes (`notes`, the
   * default for records written before the field), or approved it without inspecting anything (`shallow`, ADR 0016).
   */
  reason?: 'notes' | 'shallow';
  tree_hash: string;
  candidate_id: string;
  /** The purpose base of the fresh reviewer's sessions. */
  base: string;
  /** The reviews of the tree it supersedes once it is recorded: none approved, and each finding of theirs was closed or a note. */
  superseded: string[];
  /** The notes through which those reviews asked for repair. */
  noted: { id: string; external_id: string | null; severity: string; classification: string; claim: string }[];
}

function freshReviewDecisionId(ctx: RunContext, treeHash: string): string {
  return `dec-${ctx.run.id}-review-fresh-${treeHash}`;
}

/** The fresh review asked for this tree, if any: at most one per tree, whichever candidate carries it. */
function freshReviewOf(ctx: RunContext, treeHash: string): FreshReviewRecord | null {
  const d = getDecision(ctx.db, freshReviewDecisionId(ctx, treeHash));
  return d ? (d.data as FreshReviewRecord) : null;
}

/** The recorded review of the fresh reviewer's sessions, or null while none has come back. */
function recordedFreshReview(ctx: RunContext, rec: FreshReviewRecord): ReviewRecord | null {
  const prefix = `${rec.base}#`;
  const workers = new Set(ctx.db.all<{ id: string; purpose: string | null }>("SELECT id, purpose FROM workers WHERE run_id = ? AND role = 'reviewer'", ctx.run.id).filter((w) => w.purpose?.startsWith(prefix)).map((w) => w.id));
  return listReviews(ctx.db, ctx.run.id, { treeHash: rec.tree_hash }).find((r) => r.workerId !== null && workers.has(r.workerId)) ?? null;
}

/** The REPAIR_REQUIRED reviews of the tree that raised a note: the ones that asked for repair through something no repair can change. */
function askedOnlyThroughNotes(state: ReturnType<typeof loadResolverState>, noted: readonly Disposition[]): string[] {
  const notedIds = new Set(noted.flatMap((d) => d.memberIds));
  return state.reviews.filter((r) => r.verdict === 'REPAIR_REQUIRED' && state.findings.some((f) => f.reviewId === r.id && notedIds.has(f.id))).map((r) => r.id);
}

/** Record the decision that asks for the fresh review, then start it. */
async function startFreshReview(ctx: RunContext, cand: CandidateRecord, state: ReturnType<typeof loadResolverState>, noted: readonly Disposition[]): Promise<StepResult> {
  const rec: FreshReviewRecord = {
    tree_hash: cand.treeHash,
    candidate_id: cand.id,
    base: `review-fresh:${cand.id}`,
    superseded: state.reviews.map((r) => r.id),
    noted: noted.map((d) => ({ id: d.findingId, external_id: d.externalId, severity: d.severity, classification: d.recordedClassification!, claim: d.claim.slice(0, 500) })),
  };
  decide(ctx, {
    id: freshReviewDecisionId(ctx, cand.treeHash),
    kind: FRESH_REVIEW_KIND,
    summary: `one fresh review of tree ${cand.treeHash.slice(0, 12)}: review(s) ${rec.superseded.join(', ')} asked for repair only through note(s) ${rec.noted.map((n) => `${n.external_id ?? n.id} (${n.severity})`).join(', ')} on ${[...new Set(rec.noted.map((n) => n.classification))].join(' and ')}, which no repair can change; only an APPROVE from the fresh review clears the tree`,
    data: rec,
  });
  return freshReview(ctx, cand, rec);
}

/** The reasoning effort of a fresh review asked because the tree's approval inspected nothing (ADR 0016). */
const SHALLOW_REVIEW_EFFORT = 'high';

/** The approving reviews of the tree whose recorded depth shows no tool call; a review with no recorded depth is not one. */
function shallowApprovals(ctx: RunContext, state: ReturnType<typeof loadResolverState>): ReturnType<typeof loadResolverState>['reviews'] {
  return state.reviews.filter((r) => r.verdict === 'APPROVE' && reviewDepthOf(ctx, r.id)?.tool_calls === 0);
}

/**
 * A tree whose approval inspected nothing gets the one fresh review of the tree, at high effort, told to open the files
 * (a review round like any other, so none starts at the cap). When the tree already had its fresh review and an approval
 * still inspected nothing, or no round is left, the run stops and says why: a resume would decide the tree the same way.
 */
async function decideShallowApproval(ctx: RunContext, cand: CandidateRecord, shallow: ReturnType<typeof loadResolverState>['reviews'], gateReasons: readonly string[]): Promise<StepResult> {
  const ids = shallow.map((r) => r.id);
  const what = `review(s) ${ids.join(', ')} of tree ${cand.treeHash} judged it from the packet alone and inspected nothing (no tool call)`;
  const asked = freshReviewOf(ctx, cand.treeHash);
  if (!asked) {
    const rounds = ctx.ledger!.state('review_rounds');
    if (rounds.used < rounds.allowance) {
      const rec: FreshReviewRecord = { reason: 'shallow', tree_hash: cand.treeHash, candidate_id: cand.id, base: `review-fresh:${cand.id}`, superseded: ids, noted: [] };
      decide(ctx, { id: freshReviewDecisionId(ctx, cand.treeHash), kind: FRESH_REVIEW_KIND, summary: `one fresh review of tree ${cand.treeHash.slice(0, 12)}: ${what}`, data: rec });
      return freshReview(ctx, cand, rec);
    }
    return finishRun(ctx, 'BLOCKED', `the review inspected nothing: ${what}, and no fresh review of the tree was started: review_rounds hard cap reached (${rounds.used} of ${rounds.hard_cap})`, {
      outcome: { review_gate: [...gateReasons], shallow_reviews: ids, fresh_review: { started: false, reason: 'review_rounds hard cap reached', review_rounds: { used: rounds.used, hard_cap: rounds.hard_cap } } },
    });
  }
  const fresh = recordedFreshReview(ctx, asked);
  return finishRun(ctx, 'BLOCKED', `the review inspected nothing: ${what}, and the tree already had its one fresh review${fresh ? ` (${fresh.id})` : ''}, so no other review is asked`, {
    outcome: { review_gate: [...gateReasons], shallow_reviews: ids, fresh_review: { started: true, review_id: fresh?.id ?? null, reason: asked.reason ?? 'notes' } },
  });
}

/**
 * The fresh review: started (or collected) unless it is recorded, then the reviews it supersedes are set aside and the
 * tree is decided again. A superseded review approved nothing and has no open finding, so setting it aside clears
 * nothing by itself: the tree still needs an APPROVE, now from the fresh review, and its findings stay on the record.
 */
async function freshReview(ctx: RunContext, cand: CandidateRecord, rec: FreshReviewRecord): Promise<StepResult> {
  let review = recordedFreshReview(ctx, rec);
  if (!review) {
    const usable = await usableReviewer(ctx, cand);
    if (!usable.ok) return usable.step;
    const pending = await singleReview(ctx, cand, usable.sel, { base: rec.base, what: `the ${usable.sel.provider} fresh reviewer`, fresh: rec });
    if (pending) return pending;
    review = recordedFreshReview(ctx, rec);
    if (!review) throw new OrbitError('INTERNAL', `the fresh review of tree ${rec.tree_hash} was recorded but cannot be found`);
  }
  for (const id of rec.superseded) {
    if (id === review.id) continue;
    markReviewInvalidated(ctx.db, id, `superseded by fresh review ${review.id} of the same tree: it asked for repair only through notes on a classification Orbit recorded, which no repair can change`, ctx.clock);
  }
  return resolveAndDecide(ctx, cand);
}

/** What the BLOCKED outcome says of a fresh review that did not clear the tree. */
function describeFreshReview(ctx: RunContext, rec: FreshReviewRecord, resolution: Resolution, state: ReturnType<typeof loadResolverState>): { text: string; outcome: Record<string, unknown> } {
  const earlier = rec.noted.map((n) => `${n.external_id ?? n.id} (${n.severity})`).join(', ');
  const review = recordedFreshReview(ctx, rec);
  if (!review) return { text: `; the fresh review of the tree asked after note(s) ${earlier} has not come back`, outcome: { started: true, review_id: null, earlier_noted: rec.noted } };
  const own = new Set(state.findings.filter((f) => f.reviewId === review.id).map((f) => f.id));
  const findings = resolution.dispositions.filter((d) => d.memberIds.some((id) => own.has(id)));
  const named = findings.length === 0 ? 'it named no finding' : findings.map((d) => `${d.externalId ?? d.findingId} (${d.severity}, ${d.recordedClassification !== undefined ? 'a note' : d.status})`).join(', ');
  const why = rec.reason === 'shallow' ? `approved it without inspecting anything` : `raised only the note(s) ${earlier}`;
  return {
    text: `; the one fresh review of this tree (${review.id}, ${review.verdict}), asked after review(s) ${rec.superseded.join(', ')} ${why}, did not approve it either: ${named}`,
    outcome: { started: true, review_id: review.id, verdict: review.verdict, findings: openFindings(findings), earlier_noted: rec.noted },
  };
}

// ---------------------------------------------------------------------------
// The review repair loop

export const REVIEW_REPAIR_EVENT = 'review.repair';

interface ReviewRepairRecord {
  attempt: number;
  tree_hash: string;
  candidate_id: string;
  commit: string;
  findings: { finding_id: string; member_ids: string[]; fingerprint: string; external_id: string | null }[];
}

/** Every repair a review sent, oldest first. */
function reviewRepairs(ctx: RunContext): ReviewRepairRecord[] {
  return ctx.db
    .all<{ data_json: string | null }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', ctx.run.id, REVIEW_REPAIR_EVENT)
    .map((r) => (r.data_json ? (JSON.parse(r.data_json) as ReviewRepairRecord) : null))
    .filter((r): r is ReviewRepairRecord => r !== null && Array.isArray(r.findings));
}

/** The least severe rank that still blocks under review.security.block_severities (default critical and high). */
function blockSeverityRank(ctx: RunContext): number {
  const listed = (ctx.snapshot.config.review?.security?.block_severities ?? ['critical', 'high']) as FindingSeverity[];
  return listed.length === 0 ? -1 : Math.max(...listed.map((s) => severityRank(s)));
}

interface FindingText {
  evidence: string | null;
  suggestedValidation: string | null;
}

function findingTexts(state: ReturnType<typeof loadResolverState>): Map<string, FindingText> {
  const out = new Map<string, FindingText>();
  for (const f of [...state.findings, ...state.previousFindings]) out.set(f.id, { evidence: f.evidence, suggestedValidation: f.suggestedValidation });
  return out;
}

const UNDECIDED = /\b(ambiguous|ambiguity|unclear|unspecified|not specified|undecided|undefined behaviou?r|product decision|needs? a decision|not decided)\b/i;

/**
 * Why a finding concerns semantics an autonomous repair may not guess (spec section 10: material product
 * semantics, security rules, financial effects, irreversible data behaviour). Empty when it is a defect a
 * test can settle. Only consulted under ambiguity.block_security_or_data_semantics.
 */
function materialSemantics(ctx: RunContext, d: Disposition, t: FindingText | undefined): string[] {
  if (!ctx.snapshot.config.ambiguity.block_security_or_data_semantics) return [];
  const text = [d.category ?? '', d.claim, t?.evidence ?? '', t?.suggestedValidation ?? ''].join('\n');
  const cats = riskCategoriesInText(text);
  const reasons: string[] = [];
  if (cats.includes('billing')) reasons.push('financial effects');
  if (cats.includes('data') || mentionsIrreversible(text)) reasons.push('irreversible data behaviour');
  if (UNDECIDED.test(text)) reasons.push(d.security || cats.includes('security') || cats.includes('privacy') ? 'an undecided security rule' : 'undecided product behaviour');
  const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/));
  for (const topic of ctx.contract?.escalation.material_topics ?? []) {
    const need = topic.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (need.length > 0 && need.every((w) => words.has(w))) reasons.push(`the contract lists "${topic}" as material`);
  }
  return reasons;
}

/** What an earlier repair's tests show on this candidate: evidence that resolves findings, and why the others stay open. */
interface RepairEvidence {
  evidence: ClaimEvidence[];
  /** By finding fingerprint: why the repair's test does not resolve it on this tree. */
  unresolved: Map<string, string[]>;
  /** By finding id: the repair whose test resolved it, which its resolution names. */
  repairedBy: Map<string, ReviewRepairRecord>;
  /** Whether a repair probe ran a check in this call: a long phase, after which the step stops at a safe point. */
  probed: boolean;
}

/** What the reviews so far said about the findings the repairs addressed. */
interface ReviewHistory {
  /** Fingerprints a review of this tree raised: the reviewer saw the repair's test and still holds the claim. */
  raisedAgain: ReadonlySet<string>;
  /** By fingerprint, every tree a review raised the finding on. */
  raisedOn: ReadonlyMap<string, ReadonlySet<string>>;
  /** Ids of the findings already resolved or rejected. */
  closed: ReadonlySet<string>;
}

const NOT_APART = "the repair's test passes on the pre-repair tree too, so it does not tell the trees apart";

/** Whether `text` names `id` as a whole token, as reviewers and reports cite ids: TEST-1 is not named by TEST-10. */
function namesId(text: string, id: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i').test(text);
}

/** Whether a report's text names a finding a repair was sent, by its fingerprint or its external id. */
function namesFinding(text: string, f: { fingerprint: string; external_id: string | null }): boolean {
  return [f.fingerprint, f.external_id].some((id) => typeof id === 'string' && id.length > 0 && namesId(text, id));
}

/**
 * The findings among `among` a report's text names for a file: each whose fingerprint it names, and for each external id
 * it names, the findings with that id. An external id (TEST-1) is unique only within one review, so among the findings
 * that share it, an id names the ones whose fingerprint `cited` holds (the fingerprints the reports cite for the same
 * file) when any does, and all of them otherwise: a title "(TEST-1)" beside a note citing review 2's TEST-1 is not read
 * as naming review 1's.
 */
function findingsNamed<F extends { fingerprint: string; external_id: string | null }>(text: string, among: readonly F[], cited: ReadonlySet<string>): F[] {
  const out = new Map<string, F>();
  for (const f of among) if (f.fingerprint.length > 0 && namesId(text, f.fingerprint)) out.set(f.fingerprint, f);
  const ids = new Set(among.flatMap((f) => (typeof f.external_id === 'string' && f.external_id.length > 0 && namesId(text, f.external_id) ? [f.external_id] : [])));
  for (const id of ids) {
    const sharing = among.filter((f) => f.external_id === id);
    const pinned = sharing.filter((f) => cited.has(f.fingerprint));
    for (const f of pinned.length > 0 ? pinned : sharing) out.set(f.fingerprint, f);
  }
  return [...out.values()];
}

/**
 * Evidence for findings an earlier repair addressed (docs/decisions/0015-repair-evidence.md). The repair named a test for
 * the finding (implementer evidence_refs or tests_added naming its id or fingerprint as a whole token), and that test
 * changed between the reviewed tree and this candidate. Each required command check of category test that passed on this
 * candidate, whose directory holds the test (ADR 0014 section 4), and whose latest run on the pre-repair candidate passed
 * cleanly, runs on two probe trees built from the pre-repair candidate's tree with its production code
 * (controller/fail-before.ts runRepairProbe): the control tree, with the repair's test-owned changes but every test the
 * reports name for a finding, and the finding's tree, the control tree with the tests named for the finding. The finding
 * is resolved by its tests only when such a check PASSED on the control tree, FAILED on the finding's tree on every
 * attempt, with no environment signal and its logs read whole, and PASSED on this candidate: the finding's own tests
 * tell the trees apart, not another finding's test, a test change named for nothing, or a check that fails on the
 * pre-repair tree by itself. Exit statuses alone decide; nothing reads the test output to tell which tests ran. A check
 * that passes on the finding's tree (its tests are skipped, the check's command never runs them, or they do not check
 * the fix), one that fails on the control tree, one that did not pass cleanly on the pre-repair candidate, and a probe
 * that is not established (a timeout, an ERROR, an environment signal, a manifest or lockfile the repair changes, a log
 * that cannot be read whole, the probe's bound) leave the finding open, and `unresolved` says why. A test that fails to
 * load on the pre-repair tree, for a symbol the repair adds, counts as failing, and so does a test that fails only on a
 * probe tree for a reason that is neither the fix nor the repair (ADR 0015 Limits): the review of the repaired tree is the
 * second line of defence. Nothing else resolves it: a reviewer's silence, the implementer's word, or a lint, typecheck or
 * build check that passed. A finding a review of this tree raised again (`raisedAgain`, by fingerprint) is not probed:
 * the reviewer saw the repair's test and still holds the claim, so the finding stays open. Nor is a test that a review of
 * an earlier tree with it raised the finding again on (`raisedOn`), nor a finding already closed (`closed`, by id). A
 * finding sent to repair more than once is judged by its latest repair that named a test for it, on the tree that repair
 * started from.
 */
async function repairEvidence(ctx: RunContext, cand: CandidateRecord, repairs: readonly ReviewRepairRecord[], seen: ReviewHistory): Promise<RepairEvidence> {
  const out: ClaimEvidence[] = [];
  const unresolved = new Map<string, string[]>();
  const result: RepairEvidence = { evidence: out, unresolved, repairedBy: new Map(), probed: false };
  const because = (fingerprint: string, why: string): void => {
    const list = unresolved.get(fingerprint) ?? [];
    if (!list.includes(why)) list.push(why);
    unresolved.set(fingerprint, list);
  };
  const pending = repairs.filter((r) => r.tree_hash !== cand.treeHash);
  if (pending.length === 0) return result;
  const tree = cand.treeHash.slice(0, 12);
  const required = new Set(assertContract(ctx).required_check_ids);
  const checks = ctx.snapshot.config.checks;
  // The latest pass on this tree of each required command check of category test: the checks a repair probe may run.
  const passed = new Map<string, CheckRunRecord>();
  for (const c of listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: cand.id })) {
    if (required.has(c.checkId) && c.status === 'PASSED' && c.treeHash === cand.treeHash && isTestCommandCheck(checks[c.checkId])) passed.set(c.checkId, c);
  }
  /** The passing test checks whose directory holds `path`: the ones whose run can include it (ADR 0014 section 4). */
  const holders = (path: string): string[] => [...passed.keys()].filter((id) => underCheck(path, checks[id])).sort();
  const reports = listWorkers(ctx.db, { runId: ctx.run.id, role: 'implementer' }).filter((w) => w.state === 'SUCCEEDED' && w.resultJson);
  // Every finding a repair was sent: a test the reports name for any of them stays out of a control tree.
  const everyFinding = repairs.flatMap((r) => r.findings);
  // The latest attempt that produced each tree: a tree of that attempt or a later one has the tests written by then.
  const attemptOf = new Map<string, number>();
  for (const c of listCandidates(ctx.db, ctx.run.id)) attemptOf.set(c.treeHash, Math.max(attemptOf.get(c.treeHash) ?? 0, c.attempt));
  /** A tree before this one, with the test written in `attempt`, whose review raised the finding again; null when none. */
  const heldBy = (fingerprint: string, attempt: number): string | null => [...(seen.raisedOn.get(fingerprint) ?? [])].find((t) => t !== cand.treeHash && (attemptOf.get(t) ?? 0) >= attempt) ?? null;
  // Newest repair first: a finding sent to repair more than once is judged on the tree its latest repair started from.
  const judged = new Set<string>();
  for (const r of [...pending].reverse()) {
    const findings = r.findings.filter((f) => !seen.raisedAgain.has(f.fingerprint) && !judged.has(f.fingerprint) && !f.member_ids.every((id) => seen.closed.has(id)));
    if (findings.length === 0) continue;
    let changed: Set<string>;
    try {
      changed = new Set((await git(ctx.run.repoRoot, ['diff', '--name-only', '-z', '--no-renames', r.commit, cand.commitSha, '--'])).split('\0').filter((p) => p.length > 0));
    } catch {
      continue;
    }
    const named: { path: string; attempt: number; text: string }[] = [];
    for (const w of reports) {
      if ((w.attempt ?? 0) < r.attempt) continue;
      let o: ImplementerOutput;
      try {
        o = validateModelOutput('implementer', (JSON.parse(w.resultJson!) as { structured?: unknown }).structured);
      } catch {
        continue;
      }
      for (const e of o.evidence_refs) named.push({ path: e.ref.trim(), attempt: w.attempt ?? r.attempt, text: `${e.ref} ${e.note}` });
      for (const t of o.tests_added) named.push({ path: t.path.trim(), attempt: w.attempt ?? r.attempt, text: `${t.path} ${t.name}` });
    }
    // The fingerprints the reports cite for each path, then the findings, of any repair, each path the repair changed is
    // named for, with the first attempt that named it.
    const cited = new Map<string, Set<string>>();
    for (const x of named) for (const g of everyFinding) if (g.fingerprint.length > 0 && namesId(x.text, g.fingerprint)) cited.set(x.path, (cited.get(x.path) ?? new Set<string>()).add(g.fingerprint));
    const namedFor = new Map<string, Map<string, { name: string; attempt: number }>>();
    for (const x of named) {
      if (!changed.has(x.path)) continue;
      const m = namedFor.get(x.path) ?? new Map<string, { name: string; attempt: number }>();
      for (const g of findingsNamed(x.text, everyFinding, cited.get(x.path) ?? new Set())) m.set(g.fingerprint, { name: g.external_id ?? g.finding_id, attempt: Math.min(m.get(g.fingerprint)?.attempt ?? x.attempt, x.attempt) });
      if (m.size > 0) namedFor.set(x.path, m);
    }
    // The tests the repair named for each finding, less a file also named for another finding (a failure in it could be
    // the other finding's test, and a test file is the smallest unit a check runs) and those a review of a tree that
    // already had them raised the finding again on.
    const testsFor = new Map<string, { path: string; attempt: number }[]>();
    for (const f of findings) {
      const paths = [...namedFor].filter(([, m]) => m.has(f.fingerprint));
      if (paths.length === 0) continue;
      judged.add(f.fingerprint);
      const tests: { path: string; attempt: number }[] = [];
      for (const [path, m] of paths) {
        const { attempt } = m.get(f.fingerprint)!;
        const others = [...new Set([...m].filter(([fp]) => fp !== f.fingerprint).map(([, v]) => v.name))].sort();
        const held = heldBy(f.fingerprint, attempt);
        if (others.length > 0) because(f.fingerprint, `${path} is named for ${others.join(' and ')} too, so a failure in it cannot be tied to this finding; a test in a file of its own can resolve it`);
        else if (held === null) tests.push({ path, attempt });
        else because(f.fingerprint, `${path}: a review of tree ${held.slice(0, 12)}, which already had it, raised the finding again`);
      }
      if (tests.length > 0) testsFor.set(f.fingerprint, tests);
    }
    if (testsFor.size === 0) continue;
    if (passed.size === 0) {
      for (const fp of testsFor.keys()) because(fp, `no required command check of category test passed on tree ${tree}, so no test can resolve it`);
      continue;
    }
    let plan: ProbeChanges;
    try {
      plan = await probeChanges(ctx.run.repoRoot, r.commit, cand.commitSha);
    } catch (err) {
      if (!isOrbitError(err)) throw err;
      for (const fp of testsFor.keys()) because(fp, `not probed: the repair's changes could not be read (${err.message})`);
      continue;
    }
    if (plan.manifests.length > 0) {
      for (const fp of testsFor.keys()) because(fp, `not probed: the repair changes ${plan.manifests.join(', ')}, a dependency manifest or lockfile outside test-owned paths, so its test could fail on the pre-repair tree for a dependency rather than for the repair`);
      continue;
    }
    const owned = new Map(plan.owned.map((c) => [c.path, c] as const));
    // The control tree takes the repair's test-owned changes but every test named for a finding.
    const forFindings = new Set(named.filter((x) => everyFinding.some((f) => namesFinding(x.text, f))).map((x) => x.path));
    const control = plan.owned.filter((c) => !forFindings.has(c.path));
    // The latest run of each check on the pre-repair candidate: a check is probed only where it passed there cleanly, so a
    // failure on the probe trees is not the pre-repair tree's own.
    const before = new Map<string, CheckRunRecord>();
    for (const c of listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: r.candidate_id })) if (c.treeHash === r.tree_hash) before.set(c.checkId, c);
    // For each finding, its test-owned tests and the checks that judge them.
    const plans = new Map<string, FindingPlan>();
    for (const f of findings) {
      const tests: { path: string; attempt: number }[] = [];
      const ids = new Set<string>();
      for (const t of testsFor.get(f.fingerprint) ?? []) {
        if (!owned.has(t.path)) {
          because(f.fingerprint, `${t.path} is a test only by its content (not a test-owned file), which the probe tree cannot take without the repair's production code`);
          continue;
        }
        tests.push(t);
        const holding = holders(t.path);
        if (holding.length === 0) because(f.fingerprint, `no required command check of category test that passed on tree ${tree} holds ${t.path} under its directory`);
        for (const id of holding) {
          const b = before.get(id);
          if (b?.status === 'PASSED' && !b.flaky) ids.add(id);
          else because(f.fingerprint, `${id} is not probed: it did not pass cleanly on the pre-repair tree ${r.tree_hash.slice(0, 12)} (${b === undefined ? 'it has no recorded run there' : b.status === 'PASSED' ? 'its pass there needed a rerun' : `its run there ended ${b.status}`}), so a failure there could not be tied to the repair's test`);
        }
      }
      if (tests.length > 0 && ids.size > 0) plans.set(f.fingerprint, { name: f.external_id ?? f.finding_id, tests, checks: [...ids].sort() });
    }
    if (plans.size === 0) continue;
    const probe = async (changes: readonly ProbeChange[], tests: readonly string[] | null, byCheck: ReadonlyMap<string, readonly string[]>, fps: readonly string[], repaired = false): Promise<ProbeResult | null> => {
      try {
        const p = await runRepairProbe(ctx, cand, { attempt: r.attempt, preRepair: r.commit, changes, tests, checks: [...byCheck].map(([checkId, names]) => ({ checkId, findings: [...names] })), repaired });
        if (!p.reused && p.checks.some((c) => c.attempts.length > 0)) result.probed = true;
        return p;
      } catch (err) {
        // A stop of supervision or a cancellation is the step's; a git failure building the probe leaves the findings open.
        if (!isOrbitError(err) || err.code === 'CANCELLED') throw err;
        for (const fp of fps) because(fp, `not probed: ${err.message}`);
        return null;
      }
    };
    /** The finding's tests a check's directory holds, as a reason names them. */
    const under = (p: FindingPlan, id: string): { path: string; attempt: number }[] => p.tests.filter((t) => underCheck(t.path, checks[id]));
    // The control tree, once for the repair: a check must pass there for a failure with a finding's tests to be theirs.
    const controlChecks = new Map<string, string[]>();
    for (const p of plans.values()) for (const id of p.checks) controlChecks.set(id, [...(controlChecks.get(id) ?? []), p.name]);
    const base = await probe(control, null, controlChecks, [...plans.keys()]);
    if (!base) continue;
    // The repaired tree in the same probe checkout, once for the repair, for the checks that passed on the control tree:
    // a check must pass there too, so the finding's tests fail before and pass after in one place, and a failure that is
    // the probe checkout's own (its path, its directory) fails on both.
    const afterChecks = new Map([...controlChecks].filter(([id]) => base.checks.some((c) => c.checkId === id && c.outcome === 'passed-before')));
    const after = afterChecks.size > 0 ? await probe(plan.all, null, afterChecks, [...plans.keys()], true) : null;
    if (afterChecks.size > 0 && !after) continue;
    // Each finding's tree, one for the findings named by the same tests, with the checks that passed on the control tree.
    const keyOf = (p: FindingPlan): string => p.tests.map((t) => t.path).sort().join('\0');
    const groups = new Map<string, { tests: string[]; checks: Map<string, string[]>; fps: string[] }>();
    for (const [fp, p] of plans) {
      for (const id of p.checks) {
        const c = base.checks.find((x) => x.checkId === id);
        const label = under(p, id).map((t) => t.path).join(', ');
        if (c?.outcome === 'failed-before') {
          because(fp, `${label}: ${id} fails on the pre-repair tree without the finding's tests too, so its failure cannot be tied to them (${c.reason})`);
          continue;
        }
        if (c?.outcome !== 'passed-before') {
          because(fp, `${label}: whether it tells the trees apart is not established: ${c?.reason ?? `${id} was not probed`}`);
          continue;
        }
        const a = after?.checks.find((x) => x.checkId === id);
        if (a?.outcome !== 'passed-before') {
          because(fp, `${label}: ${id} did not pass on the repaired tree in the probe checkout (${a?.reason ?? `${id} was not probed`}), so what the finding's tests tell apart may be the probe checkout rather than the repair`);
          continue;
        }
        const g = groups.get(keyOf(p)) ?? { tests: p.tests.map((t) => t.path).sort(), checks: new Map<string, string[]>(), fps: [] };
        g.checks.set(id, [...(g.checks.get(id) ?? []), p.name]);
        if (!g.fps.includes(fp)) g.fps.push(fp);
        groups.set(keyOf(p), g);
      }
    }
    const verdicts = new Map<string, ProbeResult>();
    for (const [key, g] of groups) {
      const p = await probe([...control, ...g.tests.map((path) => owned.get(path)!)], g.tests, g.checks, g.fps);
      if (p) verdicts.set(key, p);
    }
    for (const f of findings) {
      const p = plans.get(f.fingerprint);
      const theirs = p ? verdicts.get(keyOf(p)) : undefined;
      if (!p || !theirs) continue;
      // The first check the finding's tests tell the trees apart with, and why each other check does not.
      let hit: { tests: { path: string; attempt: number }[]; check: CheckRunRecord; reason: string; control: string; repaired: string } | null = null;
      for (const id of p.checks) {
        const c = theirs.checks.find((x) => x.checkId === id);
        // Not run on the finding's tree: it did not pass on the control tree, which is already said.
        if (!c) continue;
        const tests = under(p, id);
        const label = tests.map((t) => t.path).join(', ');
        if (c.outcome === 'failed-before') hit ??= { tests, check: passed.get(id)!, reason: c.reason, control: base.checks.find((x) => x.checkId === id)!.reason, repaired: after!.checks.find((x) => x.checkId === id)!.reason };
        else because(f.fingerprint, c.outcome === 'passed-before' ? `${label}: ${NOT_APART} (${c.reason})` : `${label}: whether it tells the trees apart is not established: ${c.reason}`);
      }
      if (!hit) continue;
      const { tests, check } = hit;
      out.push({
        findingId: f.finding_id,
        fingerprint: f.fingerprint,
        kind: 'new_test',
        treeHash: cand.treeHash,
        verdict: 'refutes',
        status: 'PASSED',
        flaky: check.flaky,
        exercisesClaim: true,
        checkId: check.checkId,
        ref: `${tests.map((t) => t.path).join(', ')} (written in attempt ${[...new Set(tests.map((t) => t.attempt))].join(' and ')} for this finding; ${hit.reason}, ${hit.control}, and ${hit.repaired}: pre-repair tree ${r.tree_hash.slice(0, 12)}, probe tree ${theirs.probeTree!.slice(0, 12)}, control tree ${base.probeTree!.slice(0, 12)}; and ${check.checkId} passed on tree ${tree}${check.logSha256 ? `; log sha256 ${check.logSha256.slice(0, 12)}` : ''})`,
      });
      for (const id of f.member_ids) result.repairedBy.set(id, r);
    }
  }
  return result;
}

/** A finding's tests on the probe trees: its test-owned tests, and the checks that judge them. */
interface FindingPlan {
  /** The finding as a decision lists it: its external id, or its id. */
  name: string;
  tests: { path: string; attempt: number }[];
  /** The checks that passed on the repaired tree and cleanly on the pre-repair one, whose directory holds a test. */
  checks: string[];
}

/**
 * A finding a repair addressed that stays open says why the repair's test did not resolve it ("the repair's test passes
 * on the pre-repair tree too, so it does not tell the trees apart", or why that could not be established), so the
 * person reading the finding, and the next repair brief, see what is missing.
 */
function noteUnresolvedRepairTests(resolution: Resolution, unresolved: ReadonlyMap<string, readonly string[]>): void {
  for (const d of resolution.dispositions) {
    const why = unresolved.get(d.fingerprint);
    if (!why || !(d.status === 'accepted' || d.status === 'claim_pending' || d.status === 'open')) continue;
    d.reason += `; the repair's test does not resolve it on tree ${resolution.treeHash.slice(0, 12)}: ${why.join('; ')}`;
  }
}

function claimsTriggerKey(cand: CandidateRecord, claims: readonly { findingId: string }[]): string {
  return `review:${cand.treeHash}:${claims.map((c) => c.findingId).sort().join(',')}`.slice(0, 500);
}

/**
 * Claims the Inquisition has already inquired into on this tree are not left pending (which could only end
 * BLOCKED, since the inquiry will not run twice). The inquiry's own record decides, never a default:
 * - a ledger entry naming the claim that was rejected on evidence rejects it;
 * - a ledger entry naming it that was supported, or a contract amendment the inquiry proposed citing it as its
 *   evidence or reason, accepts it;
 * - otherwise the claim stays pending (nobody's say-so accepts or rejects it) and is returned, so it goes to a
 *   repair attempt whose brief is its discriminating test: the reviewer's validation written as a test, failing on
 *   this tree and then fixed, or passing, which refutes the claim on the repaired tree.
 */
function settleInquiredClaims(ctx: RunContext, cand: CandidateRecord, resolution: Resolution): Set<string> {
  const undecided = new Set<string>();
  if (resolution.claimsToTest.length === 0) return undecided;
  const key = claimsTriggerKey(cand, resolution.claimsToTest);
  if (!handledTriggerKeys(ctx).has(key)) return undecided;
  const pending = new Set(resolution.claimsToTest.map((c) => c.findingId));
  const ledger = listLedger(ctx.db, ctx.run.id);
  const amendments = listAmendments(ctx.db, ctx.run.id).filter((a) => a.status !== 'rejected');
  for (const d of resolution.dispositions) {
    if (!pending.has(d.findingId) || d.status !== 'claim_pending') continue;
    const names = [d.findingId, d.externalId, d.fingerprint].filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => x.toLowerCase());
    const cites = (text: string): boolean => names.some((n) => text.toLowerCase().includes(n));
    const refuted = ledger.find((e) => e.status === 'rejected' && cites(e.claim));
    const supported = ledger.find((e) => e.status === 'supported' && cites(e.claim));
    const amended = amendments.find((a) => cites(`${a.record.evidence}\n${a.record.reason}`));
    if (refuted) {
      d.status = 'rejected';
      d.blocking = false;
      // A rejection is stored only with the evidence it rests on: the ledger entry and what that entry cites.
      d.evidenceRefs = [...d.evidenceRefs, `ledger:${refuted.id}`, ...refuted.evidence.map((e) => `${e.kind}:${e.ref}`)];
      d.reason = `rejected by the Inquisition (inquiry ${key}): ledger entry ${refuted.id} was rejected on evidence: ${clipAtWord(refuted.claim, 200)}`;
    } else if (supported || amended) {
      d.status = 'accepted';
      const basis = supported ? `ledger entry ${supported.id} supports it` : `amendment ${amended!.id} (${amended!.record.field}) cites it`;
      d.reason = `accepted by the Inquisition (inquiry ${key}): ${basis}; a repair attempt must confirm it with a failing test and fix it, or show with a passing test that it does not hold`;
    } else {
      undecided.add(d.findingId);
      d.reason = `the Inquisition (inquiry ${key}) neither supported nor refuted it; a repair attempt runs its discriminating test: the reviewer's validation fails on this tree and is fixed, or passes and refutes it`;
    }
  }
  resolution.accepted = resolution.dispositions.filter((d) => d.status === 'accepted');
  resolution.rejected = resolution.dispositions.filter((d) => d.status === 'rejected');
  resolution.blocking = resolution.dispositions.filter((d) => d.blocking);
  resolution.claimsToTest = resolution.claimsToTest.filter((c) => resolution.dispositions.some((d) => d.findingId === c.findingId && d.status === 'claim_pending'));
  for (const c of resolution.claims) {
    const d = resolution.dispositions.find((x) => x.findingId === c.findingId);
    if (d) {
      c.status = d.status;
      c.blocking = d.blocking;
    }
  }
  return undecided;
}

/**
 * A claim that was sent to repair and no longer holds was repaired: resolved, not rejected (it was never refuted on the
 * tree it was raised on). Its reason names the repair whose test resolved it (`repairedBy`), else the latest it was sent to.
 */
function markRepaired(resolution: Resolution, repaired: ReadonlyMap<string, ReviewRepairRecord>, repairedBy: ReadonlyMap<string, ReviewRepairRecord>): void {
  for (const d of resolution.dispositions) {
    if (d.status !== 'rejected' || d.evidenceRefs.length === 0) continue;
    const rec = d.memberIds.map((id) => repairedBy.get(id)).find((x) => x !== undefined) ?? d.memberIds.map((id) => repaired.get(id)).find((x) => x !== undefined);
    if (!rec) continue;
    d.status = 'resolved';
    d.reason = `repaired in attempt ${rec.attempt}: the test written for it fails on the pre-repair tree and passes on tree ${resolution.treeHash.slice(0, 12)} (${d.evidenceRefs.join('; ')})`;
  }
  resolution.rejected = resolution.dispositions.filter((d) => d.status === 'rejected');
  resolution.resolved = resolution.dispositions.filter((d) => d.status === 'resolved');
}

function openFindings(list: readonly Disposition[]): { id: string; external_id: string | null; severity: string; status: string; claim: string }[] {
  return list.map((d) => ({ id: d.findingId, external_id: d.externalId, severity: d.severity, status: d.status, claim: clipAtWord(d.claim, 300) }));
}

/**
 * The criteria among `blocked` (ones an open material question blocks) a finding concerns: named by id in its claim,
 * location, evidence or suggested validation, as reviewers cite the contract.
 */
export function blockedCriteriaIn(d: Pick<Disposition, 'claim' | 'location'>, t: FindingText | undefined, blocked: readonly string[]): string[] {
  if (blocked.length === 0) return [];
  const text = [d.claim, d.location ?? '', t?.evidence ?? '', t?.suggestedValidation ?? ''].join('\n');
  return blocked.filter((id) => namesId(text, id));
}

/**
 * A review repair that reproduced the tree it was sent to repair: the latest attempt produced the current candidate,
 * whose tree is the one the attempt's review repair brief was written for. Nothing about the run changed, so the next
 * pass would bring the same review, findings and brief. Null when no such repair exists, or when a person resumed the
 * run since the brief was sent (an answer or an environment repair is new information).
 */
function stalledReviewRepair(ctx: RunContext, cand: CandidateRecord): NonProgressDecision | null {
  const latest = currentAttempt(ctx);
  if (latest === 0 || attemptCandidateId(ctx, latest) !== cand.id) return null;
  const sent = ctx.db.get<{ id: number }>("SELECT id FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ? AND json_extract(data_json, '$.tree_hash') = ? ORDER BY id DESC LIMIT 1", ctx.run.id, REVIEW_REPAIR_EVENT, latest, cand.treeHash);
  if (!sent) return null;
  if (ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'run.resumed' AND id > ?", ctx.run.id, sent.id)) return null;
  const reason = `attempt ${latest} reproduced tree ${cand.treeHash.slice(0, 12)}, the tree its review repair brief was written for: no measurable progress (same tree as attempt ${cand.attempt}); the same review, findings and brief would follow, so more attempts, tokens or lines would not change that`;
  return { terminate: true, reason, consecutiveNoProgress: 1, threshold: 1, fingerprint: null, suggestedState: 'EXHAUSTED' };
}

/**
 * Whatever an inquiry decides about findings that need repair has to be reviewed again, so with no review round left
 * no inquisitor starts and the run ends here, EXHAUSTED, as a repair without a round does (0.3.0 retest: the last
 * Inquisition ran after review_rounds 4 of 4, and the run then ended EXHAUSTED anyway). The one exception, decided by
 * the caller: claims on a tree an approving review cleared, which an inquiry that refutes them clears without another
 * round. Null while a round is left.
 */
async function reviewRoundsSpent(ctx: RunContext, open: string, outcome: Record<string, unknown>): Promise<StepResult | null> {
  const rounds = ctx.ledger!.state('review_rounds');
  if (rounds.used < rounds.allowance) return null;
  return finishRun(ctx, 'EXHAUSTED', `review_rounds hard cap reached (${rounds.used} of ${rounds.hard_cap}) with ${open}`.slice(0, 2000), { data: { counter: 'review_rounds', used: rounds.used, hard_cap: rounds.hard_cap }, outcome });
}

function describeFindings(list: readonly Disposition[]): string {
  return list.map((d) => `${d.externalId ?? d.findingId} (${d.severity}): ${clipAtWord(d.claim, 200)}`).join('; ');
}

/** REVIEWING -> REPAIRING with one brief per finding, within the review round and attempt budgets. */
async function routeToRepair(
  ctx: RunContext,
  cand: CandidateRecord,
  toRepair: Disposition[],
  resolution: Resolution,
  texts: Map<string, FindingText>,
  waiting: { held: Disposition[]; criteria: string[]; questions: string[] } = { held: [], criteria: [], questions: [] },
): Promise<StepResult> {
  const ledger = ctx.ledger!;
  const contract = assertContract(ctx);
  const outcome = { open_findings: openFindings(toRepair) };
  // Every repair needs another review of the repaired tree: without a round left, the findings stay open.
  const rounds = ledger.state('review_rounds');
  if (rounds.used >= rounds.allowance) {
    return finishRun(ctx, 'EXHAUSTED', `review_rounds hard cap reached (${rounds.used} of ${rounds.hard_cap}) with ${toRepair.length} open finding(s): ${describeFindings(toRepair)}`.slice(0, 2000), { data: { counter: 'review_rounds', used: rounds.used, hard_cap: rounds.hard_cap }, outcome });
  }
  const next = currentAttempt(ctx) + 1;
  const att = ledger.state('implementation_attempts');
  if (att.used >= att.hard_cap) {
    return finishRun(ctx, 'EXHAUSTED', `implementation attempts hard cap reached (${att.used} of ${att.hard_cap}) with ${toRepair.length} open review finding(s): ${describeFindings(toRepair)}`.slice(0, 2000), { data: { counter: 'implementation_attempts' }, outcome });
  }
  const earlier = new Set(reviewRepairs(ctx).flatMap((r) => r.findings.map((f) => f.fingerprint)));
  if (att.used >= att.allowance && !ctx.db.get('SELECT 1 AS x FROM decisions WHERE id = ?', `dec-${ctx.run.id}-extension-${next}`)) {
    const history = attemptHistory(ctx);
    const cur = history.at(-1) ?? null;
    const p = cur ? progressSince(history.length >= 2 ? history[history.length - 2]! : null, cur) : null;
    const decision = ledger.requestExtension({
      counter: 'implementation_attempts',
      progress: { ...(p ? { newly_supported_criteria: p.newly_supported_criteria, fixed_checks: p.fixed_checks } : {}), localized_fault: toRepair.map((d) => d.location).find((l) => l !== null) ?? null },
      hypothesisIsNew: toRepair.some((d) => !earlier.has(d.fingerprint)),
      withinScope: true,
      failureRemains: true,
      nextExperiment: `write the validation tests for ${toRepair.map((d) => d.externalId ?? d.findingId).join(', ')}`,
      reason: `${toRepair.length} review finding(s) remain on tree ${cand.treeHash.slice(0, 12)}`,
      role: 'implementer',
    });
    const rec = extensionDecisionRecord(decision);
    decide(ctx, { id: `dec-${ctx.run.id}-extension-${next}`, kind: rec.kind, summary: rec.summary, data: rec.data });
    if (decision.decision === 'deny_extension') {
      return finishRun(ctx, 'EXHAUSTED', clipAtWord(`implementation attempt allowance spent (${att.used} of ${att.allowance}) and no extension for the review repair: ${decision.denied_because.join('; ')}; open findings: ${describeFindings(toRepair)}`, 2000), { outcome: { ...outcome, extension: decision } });
    }
  }

  const claims = new Map(resolution.claims.map((c) => [c.findingId, c]));
  const hold =
    waiting.criteria.length === 0
      ? []
      : [
          `Do not implement or guess ${waiting.criteria.join(', ')}: ${waiting.criteria.length === 1 ? 'it waits' : 'they wait'} for a person's decision (question(s) ${waiting.questions.join(', ')})${waiting.held.length > 0 ? `; review finding(s) ${waiting.held.map((d) => d.externalId ?? d.findingId).join(', ')} about ${waiting.criteria.length === 1 ? 'it are' : 'them are'} held until then` : ''}.`,
        ];
  const briefs = toRepair.map((d) => {
    const b = reviewBrief(ctx, d, claims.get(d.findingId)?.proposedValidation ?? null, texts.get(d.findingId), contract);
    return hold.length > 0 ? { ...b, preserved_constraints: [...b.preserved_constraints, ...hold] } : b;
  });
  const stored: StoredBrief = { attempt: next, source: 'review', fingerprint: briefs[0]!.fingerprint, brief: briefs.length === 1 ? briefs[0]! : { briefs }, refs: toRepair.flatMap((d) => d.memberIds) };
  if (!existsSync(briefPath(ctx, next))) atomicWriteJson(briefPath(ctx, next), stored);
  const record: ReviewRepairRecord = { attempt: next, tree_hash: cand.treeHash, candidate_id: cand.id, commit: cand.commitSha, findings: toRepair.map((d) => ({ finding_id: d.findingId, member_ids: d.memberIds, fingerprint: d.fingerprint, external_id: d.externalId })) };
  ctx.db.tx(() => {
    if (ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.attempt') = ?", ctx.run.id, REVIEW_REPAIR_EVENT, next)) return;
    appendEvent(ctx.db, ctx.run.id, REVIEW_REPAIR_EVENT, ctx.ownerId, record, ctx.clock.now());
  });
  decide(ctx, { id: `dec-${ctx.run.id}-brief-${next}`, kind: 'repair.brief', summary: `repair brief (review) for attempt ${next}: ${describeFindings(toRepair)}`, data: { attempt: next, source: 'review', findings: record.findings, path: `briefs/attempt-${next}.json` } });
  return move(ctx, 'REPAIRING', `review requires repair of ${toRepair.length} finding(s); brief for attempt ${next}`, { data: { attempt: next, findings: record.findings.map((f) => f.finding_id) } });
}

/** Spec section 14 repair brief for one finding; the experiment is the reviewer's validation written as a failing test. */
function reviewBrief(ctx: RunContext, d: Disposition, validation: string | null, t: FindingText | undefined, contract: NonNullable<RunContext['contract']>): RepairBrief & { finding_ids: string[]; severity: string } {
  const name = d.externalId ?? d.findingId;
  const suggested = validation ?? t?.suggestedValidation ?? `a test that exercises "${clipAtWord(d.claim, 200)}"${d.location ? ` at ${d.location}` : ''}`;
  return {
    fingerprint: d.fingerprint,
    evidence: [`review finding ${name} (${d.severity}, ${d.category ?? 'uncategorized'})${d.location ? ` at ${d.location}` : ''}: ${t?.evidence ?? d.reason}`.slice(0, 1000), ...d.evidenceRefs],
    hypotheses: [{ statement: d.claim.slice(0, 500), supporting: (t?.evidence ?? d.reason).slice(0, 500) }],
    experiment: `Write the reviewer's suggested validation as a test that fails on the current candidate: ${suggested}`.slice(0, 1000),
    expected_observation: `The new test fails on the current candidate (tree ${ctx.candidate?.treeHash.slice(0, 12) ?? 'unknown'}) and passes once the defect is repaired. If it already passes without a change, the claim does not hold: keep the test and say so.`,
    scoped_fix: `Repair the defect the finding describes${d.location ? ` at ${d.location}` : ''} without changing behaviour the acceptance criteria do not cover.`,
    post_fix_checks: [...contract.required_check_ids],
    preserved_constraints: [
      `Stay within the allowed paths: ${contract.allowed_paths.join(', ')}.`,
      'Do not weaken, skip or delete existing tests or assertions.',
      ...contract.non_goals.slice(0, 10).map((g) => `Non-goal: ${g}`),
      `Report the validation test in evidence_refs as { criterion_id: null, ref: "<test file path>", note: "validation for finding ${name} (${d.fingerprint})" }, naming there only the tests that check this finding, each in a test file of its own: a file named for more than one finding resolves none of them. Orbit runs the required test checks on the current candidate's tree with only your test files changed, first without the tests you name for findings, where a check must pass, then with the tests you name for this finding, where it must fail, and the check must pass on the repaired tree, in the same checkout and as the candidate: only then does the test resolve the finding. A test that is skipped, that the check's command does not run, or that passes without the repair leaves the finding open, and so does a check that fails without the tests you name.`,
    ],
    finding_ids: d.memberIds,
    severity: d.severity,
  };
}

/**
 * The reasoning effort a review session runs at. The Codex reviewer's is providers.codex.review_reasoning_effort (default
 * medium: at the CLI's own default a review answered in tens of reasoning tokens with no tool call); a snapshot written
 * before the key existed keeps the selection's effort.
 */
function reviewEffort(ctx: RunContext, sel: Extract<ReviewerSelection, { decision: 'SELECT' }>): string | null {
  return ctx.snapshot.config.providers[sel.provider]?.review_reasoning_effort ?? sel.effort;
}

/** The reviewer selection recorded for this run, the latest that selected a reviewer. */
function recordedSelection(ctx: RunContext): Extract<ReviewerSelection, { decision: 'SELECT' }> | undefined {
  return listDecisions(ctx.db, ctx.run.id, { kind: 'review.select' }).map((d) => d.data as ReviewerSelection | null).filter((d): d is Extract<ReviewerSelection, { decision: 'SELECT' }> => d?.decision === 'SELECT').at(-1);
}

/** Whether the recorded reviewer selection was independent; true when none was recorded. */
function recordedSelectionIndependent(ctx: RunContext): boolean {
  return recordedSelection(ctx)?.independent !== false;
}

/** Why the reviewer was not independent, from the reviewer selection recorded for this run; null when none says. */
function recordedWhyNotIndependent(ctx: RunContext): string | null {
  const sel = recordedSelection(ctx);
  return sel && sel.decision === 'SELECT' && !sel.independent ? (sel.independentUnavailable ?? null) : null;
}

export function implementerProvider(ctx: RunContext): string {
  return listWorkers(ctx.db, { runId: ctx.run.id, role: 'implementer' }).at(-1)?.provider ?? IMPLEMENTER_PROVIDER;
}

/** Selected once per candidate and recorded; a restart reuses the recorded choice instead of probing again. */
async function reviewerSelection(ctx: RunContext, cand: CandidateRecord): Promise<ReviewerSelection> {
  const id = `dec-${ctx.run.id}-review-select-${cand.id}`;
  const prior = getDecision(ctx.db, id);
  if (prior && (prior.data as ReviewerSelection).decision === 'SELECT') return prior.data as ReviewerSelection;
  // Credentials can expire during a run: the environment is checked again before review.
  const env = await checkEnvironment(ctx);
  // Judged again with the implementer's actual model, so a same-provider review can prefer a different tier.
  const sel: ReviewerSelection = fallbackSelection(ctx, env);
  const rec = selectionDecisionRecord(sel);
  if (sel.decision === 'SELECT') decide(ctx, { id, kind: rec.kind, summary: rec.summary, data: rec.data });
  else decide(ctx, { kind: rec.kind, summary: rec.summary, data: rec.data });
  return sel;
}

/** Without a mandatory independent provider, the policy's same-provider rules still decide who reviews. */
function fallbackSelection(ctx: RunContext, env: Awaited<ReturnType<typeof checkEnvironment>>): ReviewerSelection {
  const credentials: Record<string, CredentialStatus | undefined> = Object.fromEntries(env.credentials.map((c) => [c.provider, c.status ?? undefined]));
  return selectReviewer({ snapshot: ctx.snapshot, capabilities: env.capabilities, credentials, implementer: { provider: implementerProvider(ctx), model: lastImplementerModel(ctx) }, registry: ctx.deps.registry });
}

function lastImplementerModel(ctx: RunContext): string | null {
  return listWorkers(ctx.db, { runId: ctx.run.id, role: 'implementer' }).at(-1)?.model ?? null;
}

/** The packet is built once per candidate and written next to the run; the prompt carries it as untrusted data. */
async function preparePacket(ctx: RunContext, cand: CandidateRecord, reviewDir: string, provider: string): Promise<void> {
  const contract = assertContract(ctx);
  const ev = currentEvidenceReport(ctx.db, ctx.run.id, cand.id)!;
  const packet = await buildReviewPacket({
    contract,
    snapshot: ctx.snapshot,
    candidate: cand,
    baseRev: ctx.run.baseRevision!,
    repoRoot: ctx.run.repoRoot,
    evidenceReport: ev.report,
    ledger: listLedger(ctx.db, ctx.run.id).map((l) => ({ id: l.id, claim: l.claim, source: l.source, confidence: l.confidence, status: l.status, ...(l.consequence ? { consequence_if_wrong: l.consequence } : {}), reversibility: l.reversibility, ...(l.experiment ? { validation_experiment: l.experiment } : {}) })),
    questions: listQuestions(ctx.db, ctx.run.id, { status: 'open' }).map((q) => q.question),
    provider,
    // A reviewer sees the probe only under required (ADR 0014 section 1): under advisory and off it is the person's.
    ...(failBeforePolicy(ctx.snapshot.config).mode === 'required' ? { failBeforeLogs: failBeforeLogs(ctx, ev.report) } : {}),
  });
  atomicWrite(join(reviewDir, 'packet.md'), packet.text, 0o600);
  atomicWriteJson(join(reviewDir, 'packet.json'), { sha256: packet.sha256, bytes: packet.bytes, excluded: packet.excluded, included: packet.included, eligibility: packet.eligibility, candidate: packet.candidate, redacted: packet.redacted });
}

/** The failing lines of each fail-before probe log the report names, for the packet (ADR 0014); the files lie in the run directory. */
function failBeforeLogs(ctx: RunContext, report: EvidenceReport): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of report.acceptance_evidence) {
    for (const c of a.fail_before?.checks ?? []) {
      const log = c.attempts.at(-1)?.log;
      if (log && !out.has(log)) out.set(log, probeLogExcerpt(probeLogPath(ctx.runDir, log)));
    }
  }
  return out;
}

function packetShaOf(reviewDir: string): string {
  try {
    return (JSON.parse(readText(join(reviewDir, 'packet.json'))) as { sha256: string }).sha256;
  } catch {
    return '';
  }
}

function readText(p: string): string {
  return readFileSync(p, 'utf8');
}

function reviewerPrompt(ctx: RunContext, cand: CandidateRecord, reviewDir: string, focus: ReviewFocus = 'general', fresh: FreshReviewRecord | null = null): string {
  const text = readText(join(reviewDir, 'packet.md'));
  const contract = assertContract(ctx);
  const task = [
    'Review the exact candidate in this read-only checkout against the contract and the bound evidence in the packet. Do not edit anything and do not ask questions.',
    'Reject weak proof, test weakening, scope leakage, regressions, unsafe defaults and unresolved material assumptions. Each finding must be a specific, testable claim with a location.',
    ...(focus === 'general' ? [] : [FOCUS_TEXT[focus]]),
    ...(fresh ? freshReviewText(fresh) : []),
    `Echo the candidate revision ${cand.commitSha} in candidate_revision.`,
  ].join('\n');
  // The noted findings are an earlier reviewer's words: data for this reviewer, never instructions.
  const noted = fresh && fresh.noted.length > 0 ? [{ label: 'findings noted in the earlier review', content: fresh.noted.map((n) => `${n.external_id ?? n.id} (${n.severity}): ${n.claim}`).join('\n') }] : [];
  return renderWorkerPrompt({
    role: 'reviewer',
    task,
    contract,
    policySummary: policySummary(ctx, { readOnly: true }),
    candidate: { revision: cand.commitSha, treeHash: cand.treeHash, base: ctx.run.baseRevision },
    untrusted: [{ label: 'review packet', content: text, ref: `reviews/${cand.seq}/packet.md` }, ...noted],
    maxBlockChars: text.length + 100,
    maxPromptChars: text.length + 40_000,
  });
}

/** The fresh reviewer's task: which notes it follows, and why none of them is a finding a repair could answer. */
function freshReviewText(rec: FreshReviewRecord): string[] {
  if (rec.reason === 'shallow') {
    return [
      `This is a fresh review of a tree that an earlier review (${rec.superseded.join(', ')}) approved from the review packet alone, without opening any file or running any command.`,
      'Before your verdict, open the changed files and the tests that cover them in this read-only checkout, with your tools, and check the change against the contract and the evidence. A verdict given without inspecting the checkout does not clear the tree.',
    ];
  }
  const names = rec.noted.map((n) => `${n.external_id ?? n.id} (${n.severity})`).join(', ');
  const what = [...new Set(rec.noted.map((n) => n.classification))];
  return [
    `This is a fresh review of a tree that an earlier review asked to have repaired only through finding(s) ${names}, quoted below, filed under the category ${EVIDENCE_CLASSIFICATION_CATEGORY}. Each disputes ${what.join(' or ')}.`,
    'Such a classification is not a finding and cannot be repaired by changing the candidate: a repair changes only the candidate, never the base revision.',
    `Judge the candidate as in any review: a finding is a defect of the candidate or of its tests that a change to the candidate can repair, and it uses its normal category. Use the category ${EVIDENCE_CLASSIFICATION_CATEGORY} only for a finding that disputes Orbit's recorded classification and asks for nothing else.`,
    // Said whatever the criteria say, since no criterion's wording is read: the draft keeps a criterion such as the
    // retest's AC-4 ("The new tests fail on the base revision") that the planner writes against its brief.
    `Whether the new tests fail on the base revision is Orbit's to establish through verification.fail_before (under advisory and off it is reported to the person). A criterion's promise of it is therefore not a finding against the candidate and does not withhold APPROVE: judge the criterion's other clauses as usual. A finding that disputes only that promise uses the category ${EVIDENCE_CLASSIFICATION_CATEGORY}.`,
  ];
}

/** Packet and read-only checkout must exist before the reviewer starts; both are idempotent. */
export async function prepareReview(ctx: RunContext, cand: CandidateRecord, provider: string): Promise<{ reviewDir: string; checkout: string }> {
  const reviewDir = join(ctx.runDir, 'reviews', String(cand.seq));
  const checkout = join(runWorktreeRoot(ctx), `review-${cand.seq}`);
  if (!existsSync(join(reviewDir, 'packet.md'))) await preparePacket(ctx, cand, reviewDir, provider);
  if (!existsSync(checkout) || readdirSync(checkout).length === 0) await materializeCandidate(ctx.run.repoRoot, cand.commitSha, checkout, { readOnly: true });
  return { reviewDir, checkout };
}
