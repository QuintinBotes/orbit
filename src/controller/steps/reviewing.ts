/**
 * REVIEWING (spec section 12): an independent reviewer examines the exact
 * candidate through a packet built from the contract, the diff and the bound
 * evidence. Findings are claims: recorded, resolved only by evidence on this
 * tree, never by vote. Confirmed defects go back through DIAGNOSING (which
 * owns the attempt allowance) with a review repair brief; claims that need a
 * discriminating test go to the Inquisition; a clear review moves on to
 * delivery. A mandatory independent reviewer that is unavailable blocks.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, atomicWriteJson } from '../../core/fsx.ts';
import { OrbitError, isOrbitError } from '../../core/errors.ts';
import { getDecision } from '../../storage/decisions.ts';
import { listWorkers } from '../../storage/workers.ts';
import { renderWorkerPrompt } from '../../adapters/prompt.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../../evidence/candidate.ts';
import { currentEvidenceReport, type CandidateRecord } from '../../evidence/store.ts';
import { isFresh } from '../../evidence/freshness.ts';
import { buildReviewPacket } from '../../review/packet.ts';
import { ingestFindings, resolveFindings, type ClaimEvidence, type Disposition, type Resolution } from '../../review/resolve.ts';
import { severityRank, type FindingSeverity } from '../../review/types.ts';
import { appendEvent } from '../../storage/events.ts';
import { listCheckRuns } from '../../evidence/store.ts';
import { git } from '../../evidence/git.ts';
import type { RepairBrief } from '../../evidence/types.ts';
import { validateModelOutput, type ImplementerOutput } from '../../contract/model-outputs.ts';
import { mentionsIrreversible, riskCategoriesInText } from '../../inquisition/heuristics.ts';
import { progressSince } from '../../inquisition/repair.ts';
import { extensionDecisionRecord } from '../../scheduling/budget.ts';
import { attemptHistory } from './diagnosing.ts';
import { selectReviewer, selectionDecisionRecord, type ReviewerSelection } from '../../review/select.ts';
import type { CredentialStatus } from '../../adapters/types.ts';
import { listReviews, loadResolverState, persistResolution, recordReview } from '../../review/store.ts';
import type { IngestedReview } from '../../review/types.ts';
import { listLedger, listQuestions } from '../../inquisition/store.ts';
import type { Trigger } from '../../inquisition/types.ts';
import { runWorktreeRoot, type RunContext } from '../context.ts';
import { independentReviewGate } from '../gates.ts';
import { assertContract, blockOnAuth, decide, finishRun, MAX_REGENERATIONS, move, policySummary, progress, safePoint, type StepResult } from './common.ts';
import { obtain } from './obtain.ts';
import { checkEnvironment, IMPLEMENTER_PROVIDER, recordGate } from './preflight.ts';
import { briefPath, currentAttempt, type StoredBrief } from './implementing.ts';
import { handledTriggerKeys } from './verifying.ts';

export async function reviewingStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  const contract = assertContract(ctx);
  const cand = ctx.candidate;
  if (!cand || !ctx.ledger) throw new OrbitError('INTERNAL', `run ${ctx.run.id} is REVIEWING without a candidate or budget`);
  const ev = currentEvidenceReport(ctx.db, ctx.run.id, cand.id);
  if (!ev || ev.verdict !== 'PASS' || !isFresh(ev.report, { candidate: cand, snapshot: ctx.snapshot })) {
    throw new OrbitError('STALE_EVIDENCE', `candidate ${cand.seq} has no fresh PASS evidence; review authorizes nothing without it`);
  }

  // A review of this tree already recorded (a restart after recording): resolve and decide.
  if (listReviews(ctx.db, ctx.run.id, { treeHash: cand.treeHash }).length > 0) return resolveAndDecide(ctx, cand);

  const sel = await reviewerSelection(ctx, cand);
  if (sel.decision === 'BLOCK') {
    if (sel.code === 'AUTH_EXPIRED' || sel.code === 'AUTH_MISSING') {
      const provider = sel.alternatives.find((a) => /credentials/.test(a.reason))?.provider ?? ctx.snapshot.config.review.preferred_provider;
      return blockOnAuth(ctx, provider, sel.code === 'AUTH_MISSING' ? 'missing' : 'expired', sel.reason);
    }
    return finishRun(ctx, 'BLOCKED', `independent review unavailable: ${sel.reason}`, { outcome: { reviewer: sel } });
  }

  const round = listReviews(ctx.db, ctx.run.id, { includeInvalidated: true }).length + 1;
  const { reviewDir, checkout } = await prepareReview(ctx, cand, sel.provider);
  const got = await obtain<{ review: IngestedReview; packetSha: string }>(ctx, {
    base: `review:${cand.id}`,
    maxAttempts: MAX_REGENERATIONS,
    what: `the ${sel.provider} reviewer`,
    // One review round per reviewer session started, regenerations included: every session costs a round.
    beforeStart: () => ctx.ledger!.consume('review_rounds', 1),
    request: (purpose) => ({
      role: 'reviewer',
      purpose,
      candidateId: cand.id,
      provider: sel.provider,
      model: sel.model,
      effort: sel.effort,
      cwd: checkout,
      readOnly: true,
      phase: 'final',
      prompt: () => reviewerPrompt(ctx, cand, reviewDir),
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
  return resolveAndDecide(ctx, cand);
}

async function resolveAndDecide(ctx: RunContext, cand: CandidateRecord): Promise<StepResult> {
  const state = loadResolverState(ctx.db, ctx.run.id, cand.treeHash);
  const repairs = reviewRepairs(ctx);
  const repaired = new Map<string, ReviewRepairRecord>();
  for (const r of repairs) for (const f of r.findings) for (const id of f.member_ids) repaired.set(id, r);
  const evidence = await repairEvidence(ctx, cand, repairs);
  const resolution = resolveFindings({ findings: state.findings, previousFindings: state.previousFindings, reviews: state.reviews, snapshot: ctx.snapshot, evidence, treeHash: cand.treeHash, now: ctx.clock.now() });
  markRepaired(resolution, repaired);
  persistResolution(ctx.db, ctx.runDir, ctx.run.id, resolution, ctx.clock);
  const gate = independentReviewGate(ctx.db, { runId: ctx.run.id, treeHash: cand.treeHash, snapshot: ctx.snapshot, implementerProvider: implementerProvider(ctx), now: ctx.clock.now() });
  recordGate(ctx, gate);
  if (gate.passed && gate.details.approved) {
    progress(ctx, 'review.approved', { candidate_id: cand.id, tree_hash: cand.treeHash });
    return move(ctx, 'DELIVERING', `independent review cleared tree ${cand.treeHash}`);
  }

  // Review findings drive a repair loop (spec sections 12 and 14). A finding confirmed by evidence, and a
  // finding a reviewer asked to have repaired (REPAIR_REQUIRED, now or for an earlier tree) at a blocking
  // severity, becomes a repair brief; it is closed later only by a test exercising it that passes.
  const repairRequested = state.reviews.some((r) => r.verdict === 'REPAIR_REQUIRED');
  const blockRank = blockSeverityRank(ctx);
  const open = resolution.dispositions.filter((d) => d.status === 'accepted' || d.status === 'claim_pending' || d.status === 'open');
  const toRepair = open.filter((d) => d.status === 'accepted' || ((repairRequested || d.memberIds.some((id) => repaired.has(id))) && (d.blocking || severityRank(d.severity) <= blockRank)));
  if (toRepair.length > 0) {
    // Only a disagreement, or a finding about material semantics nobody may guess, needs the Inquisition first.
    const texts = findingTexts(state);
    const inquire = toRepair
      .filter((d) => d.status !== 'accepted')
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
      if (!handledTriggerKeys(ctx).has(trigger.key)) return move(ctx, 'INQUISITION', trigger.summary, { data: { trigger } });
    }
    return routeToRepair(ctx, cand, toRepair, resolution, texts);
  }

  if (resolution.claimsToTest.length > 0) {
    const trigger: Trigger = {
      kind: 'reviewer_disagreement',
      mode: 'reconcile',
      summary: `${resolution.claimsToTest.length} review claim(s) need a discriminating test before they can be accepted or rejected`,
      evidence: resolution.claimsToTest.slice(0, 20).map((c) => `${c.findingId}: ${c.statement}`.slice(0, 300)),
      subjects: [],
      key: `review:${cand.treeHash}:${resolution.claimsToTest.map((c) => c.findingId).sort().join(',')}`.slice(0, 500),
    };
    if (!handledTriggerKeys(ctx).has(trigger.key)) return move(ctx, 'INQUISITION', trigger.summary, { data: { trigger } });
  }
  return finishRun(ctx, 'BLOCKED', `independent review does not clear tree ${cand.treeHash}: ${gate.reasons.join('; ') || 'no approving review'}`, { outcome: { review_gate: gate.reasons, open_findings: openFindings(open) } });
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

/**
 * Evidence for findings an earlier repair addressed: the repair named a test for the finding (implementer
 * evidence_refs or tests_added naming its id or fingerprint), that test changed between the reviewed tree and
 * this candidate, and the required checks passed on this candidate. A test exercising the claim that passes
 * on this tree refutes the claim here; nothing else (a reviewer's silence, the implementer's word) does.
 */
async function repairEvidence(ctx: RunContext, cand: CandidateRecord, repairs: readonly ReviewRepairRecord[]): Promise<ClaimEvidence[]> {
  const out: ClaimEvidence[] = [];
  const pending = repairs.filter((r) => r.tree_hash !== cand.treeHash);
  if (pending.length === 0) return out;
  const required = new Set(assertContract(ctx).required_check_ids);
  const passed = listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: cand.id }).filter((c) => required.has(c.checkId) && c.status === 'PASSED' && c.treeHash === cand.treeHash);
  if (passed.length === 0) return out;
  const check = passed[0]!;
  const reports = listWorkers(ctx.db, { runId: ctx.run.id, role: 'implementer' }).filter((w) => w.state === 'SUCCEEDED' && w.resultJson);
  for (const r of pending) {
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
    for (const f of r.findings) {
      const ids = [f.fingerprint, f.external_id].filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => x.toLowerCase());
      const hit = named.find((n) => changed.has(n.path) && ids.some((id) => n.text.toLowerCase().includes(id)));
      if (!hit) continue;
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
        ref: `${hit.path} (written in attempt ${hit.attempt} for this finding; ${check.checkId} passed on tree ${cand.treeHash.slice(0, 12)}${check.logSha256 ? `, log sha256 ${check.logSha256.slice(0, 12)}` : ''})`,
      });
    }
  }
  return out;
}

/** A claim that was sent to repair and no longer holds was repaired: resolved, not rejected (it was never refuted on the tree it was raised on). */
function markRepaired(resolution: Resolution, repaired: ReadonlyMap<string, ReviewRepairRecord>): void {
  for (const d of resolution.dispositions) {
    if (d.status !== 'rejected' || d.evidenceRefs.length === 0) continue;
    const rec = d.memberIds.map((id) => repaired.get(id)).find((x) => x !== undefined);
    if (!rec) continue;
    d.status = 'resolved';
    d.reason = `repaired in attempt ${rec.attempt}: a test exercising the claim passes on tree ${resolution.treeHash.slice(0, 12)} (${d.evidenceRefs.join('; ')})`;
  }
  resolution.rejected = resolution.dispositions.filter((d) => d.status === 'rejected');
  resolution.resolved = resolution.dispositions.filter((d) => d.status === 'resolved');
}

function openFindings(list: readonly Disposition[]): { id: string; external_id: string | null; severity: string; status: string; claim: string }[] {
  return list.map((d) => ({ id: d.findingId, external_id: d.externalId, severity: d.severity, status: d.status, claim: d.claim.slice(0, 300) }));
}

function describeFindings(list: readonly Disposition[]): string {
  return list.map((d) => `${d.externalId ?? d.findingId} (${d.severity}): ${d.claim.slice(0, 120)}`).join('; ');
}

/** REVIEWING -> REPAIRING with one brief per finding, within the review round and attempt budgets. */
async function routeToRepair(ctx: RunContext, cand: CandidateRecord, toRepair: Disposition[], resolution: Resolution, texts: Map<string, FindingText>): Promise<StepResult> {
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
      return finishRun(ctx, 'EXHAUSTED', `implementation attempt allowance spent (${att.used} of ${att.allowance}) and no extension for the review repair: ${decision.denied_because.join('; ')}; open findings: ${describeFindings(toRepair)}`.slice(0, 2000), { outcome: { ...outcome, extension: decision } });
    }
  }

  const claims = new Map(resolution.claims.map((c) => [c.findingId, c]));
  const briefs = toRepair.map((d) => reviewBrief(ctx, d, claims.get(d.findingId)?.proposedValidation ?? null, texts.get(d.findingId), contract));
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
  const suggested = validation ?? t?.suggestedValidation ?? `a test that exercises "${d.claim.slice(0, 200)}"${d.location ? ` at ${d.location}` : ''}`;
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
      `Report the validation test in evidence_refs as { criterion_id: null, ref: "<test file path>", note: "validation for finding ${name} (${d.fingerprint})" }.`,
    ],
    finding_ids: d.memberIds,
    severity: d.severity,
  };
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
  const sel: ReviewerSelection = env.reviewer ?? fallbackSelection(ctx, env);
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
  });
  atomicWrite(join(reviewDir, 'packet.md'), packet.text, 0o600);
  atomicWriteJson(join(reviewDir, 'packet.json'), { sha256: packet.sha256, bytes: packet.bytes, excluded: packet.excluded, included: packet.included, eligibility: packet.eligibility, candidate: packet.candidate, redacted: packet.redacted });
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

function reviewerPrompt(ctx: RunContext, cand: CandidateRecord, reviewDir: string): string {
  const text = readText(join(reviewDir, 'packet.md'));
  const contract = assertContract(ctx);
  const task = [
    'Review the exact candidate in this read-only checkout against the contract and the bound evidence in the packet. Do not edit anything and do not ask questions.',
    'Reject weak proof, test weakening, scope leakage, regressions, unsafe defaults and unresolved material assumptions. Each finding must be a specific, testable claim with a location.',
    `Echo the candidate revision ${cand.commitSha} in candidate_revision.`,
  ].join('\n');
  return renderWorkerPrompt({
    role: 'reviewer',
    task,
    contract,
    policySummary: policySummary(ctx, { readOnly: true }),
    candidate: { revision: cand.commitSha, treeHash: cand.treeHash, base: ctx.run.baseRevision },
    untrusted: [{ label: 'review packet', content: text, ref: `reviews/${cand.seq}/packet.md` }],
    maxBlockChars: text.length + 100,
    maxPromptChars: text.length + 40_000,
  });
}

/** Packet and read-only checkout must exist before the reviewer starts; both are idempotent. */
export async function prepareReview(ctx: RunContext, cand: CandidateRecord, provider: string): Promise<{ reviewDir: string; checkout: string }> {
  const reviewDir = join(ctx.runDir, 'reviews', String(cand.seq));
  const checkout = join(runWorktreeRoot(ctx), `review-${cand.seq}`);
  if (!existsSync(join(reviewDir, 'packet.md'))) await preparePacket(ctx, cand, reviewDir, provider);
  if (!existsSync(checkout) || readdirSync(checkout).length === 0) await materializeCandidate(ctx.run.repoRoot, cand.commitSha, checkout, { readOnly: true });
  return { reviewDir, checkout };
}
