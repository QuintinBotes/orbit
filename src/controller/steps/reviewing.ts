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
import { ingestFindings, resolveFindings } from '../../review/resolve.ts';
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
  if (!got.ok) return got.step;
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
  const resolution = resolveFindings({ findings: state.findings, previousFindings: state.previousFindings, reviews: state.reviews, snapshot: ctx.snapshot, evidence: [], treeHash: cand.treeHash, now: ctx.clock.now() });
  persistResolution(ctx.db, ctx.runDir, ctx.run.id, resolution, ctx.clock);
  const gate = independentReviewGate(ctx.db, { runId: ctx.run.id, treeHash: cand.treeHash, snapshot: ctx.snapshot, implementerProvider: implementerProvider(ctx), now: ctx.clock.now() });
  recordGate(ctx, gate);
  if (gate.passed && gate.details.approved) {
    progress(ctx, 'review.approved', { candidate_id: cand.id, tree_hash: cand.treeHash });
    return move(ctx, 'DELIVERING', `independent review cleared tree ${cand.treeHash}`);
  }
  if (resolution.repairBriefs.length > 0) {
    const next = currentAttempt(ctx) + 1;
    const first = resolution.repairBriefs[0]!;
    const stored: StoredBrief = { attempt: next, source: 'review', fingerprint: first.fingerprint, brief: resolution.repairBriefs.length === 1 ? first : { briefs: resolution.repairBriefs }, refs: resolution.accepted.map((d) => d.findingId) };
    if (!existsSync(briefPath(ctx, next))) atomicWriteJson(briefPath(ctx, next), stored);
    return move(ctx, 'DIAGNOSING', `review confirmed ${resolution.accepted.length} defect(s); repair brief for attempt ${next}`, { data: { findings: resolution.accepted.map((d) => d.findingId) } });
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
  return finishRun(ctx, 'BLOCKED', `independent review does not clear tree ${cand.treeHash}: ${gate.reasons.join('; ') || 'no approving review'}`, { outcome: { review_gate: gate.reasons } });
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
