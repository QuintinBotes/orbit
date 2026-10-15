/**
 * Fail-before in the controller (docs/decisions/0014-fail-before.md, issue #65). VERIFYING runs the probe for a candidate
 * that is otherwise acceptable (evidence/fail-before.ts) and hands its outcome to the evidence report. Under `required`
 * the outcome routes the run:
 *
 * - passed-before goes to repair through `green_without_proof`, bounded by the repair loop's own stops; when they end it
 *   (the attempts run out, or a repair went round on the same tree), the run asks a person, one question per criterion,
 *   whether to accept the criterion without fail-before for this tree (a refactor, a characterization test);
 * - not established blocks the run with the cause and the same question, except for an environment, ERROR or install
 *   cause, which is fixed and never accepted (ADR 0010): `orbit resume` then runs the probe again.
 *
 * Only a person's `accept` counts, bound to the candidate tree it was asked for, and the report lists it in `unverified`.
 * Under `advisory` nothing here changes the run: the report carries the outcome.
 *
 * REVIEWING runs the same probe for a review repair's tests (docs/decisions/0015-repair-evidence.md, runRepairProbe): on
 * the pre-repair candidate's tree with the repair's test-owned paths but the tests named for findings, and with the
 * tests named for one finding as well, whatever `verification.fail_before` says.
 */
import { join } from 'node:path';
import { hashObject } from '../core/hash.ts';
import { acceptableCause, changesBetween, isBrowserCheck, isTestCommandCheck, newTestSupport, otherwiseAcceptable, REPAIR_CONTROL, REPAIR_PROBE, REPAIR_REPAIRED, runFailBeforeProbe, type FailBeforeEvidence, type NotEstablishedCause, type ProbeChange, type ProbeResult } from '../evidence/fail-before.ts';
import { runUiFailBeforeProbe, type UiRunner } from './fail-before-ui.ts';
import { git } from '../evidence/git.ts';
import type { BaseComparison } from '../evidence/report.ts';
import type { RunnerContext } from '../evidence/runner.ts';
import { currentEvidenceReport, type CandidateRecord, type EvidenceReportRecord } from '../evidence/store.ts';
import type { CheckResult, CriterionEvidence, EvidenceReport } from '../evidence/types.ts';
import type { GoalContract } from '../contract/types.ts';
import { isHumanActor } from '../inquisition/actors.ts';
import { findQuestion, insertQuestion, withdrawQuestion, type QuestionRecord } from '../inquisition/store.ts';
import { failBeforePolicy } from '../policy/config.ts';
import { dependencyManifestsChangedBetween, isLockfilePath } from '../policy/scope.ts';
import { gitTreeReader, isTestOwnedPath, loadTestLayout } from '../policy/test-files.ts';
import { getDecision, listDecisions } from '../storage/decisions.ts';
import { checkRunnerFor, runWorktreeRoot, type RunContext } from './context.ts';
import { decide, finishRun, type StepResult } from './steps/common.ts';

export const FAIL_BEFORE_REQUEST_KIND = 'verification.fail-before-request';
export const FAIL_BEFORE_ACCEPTED_KIND = 'verification.fail-before-accepted';
export const ACCEPT_WITHOUT_FAIL_BEFORE = 'accept';
export const DECLINE_WITHOUT_FAIL_BEFORE = 'decline';

export interface CollectFailBeforeInput {
  contract: GoalContract;
  base: BaseComparison;
  results: readonly CheckResult[];
  /** Whether the candidate's dependency install passed (or was skipped): a probe needs the same install. */
  installOk: boolean;
  /** The candidate's runner context: the probe runs its checks the same way. */
  runner: RunnerContext;
  /** The ui runner the browser probe drives (fail-before-ui.ts); absent, the one verification uses. Tests inject a scripted one. */
  uiRunner?: UiRunner;
}

/**
 * The fail-before evidence of a candidate: its probe, run now or reused, or why none ran. The probe runs once per
 * candidate that is otherwise acceptable (every required check passed), changes at least one test-owned path, and has
 * a criterion resting on new tests under a test check that passed on the base revision, or on new journeys under a
 * browser check (ADR 0016, item 4: fail-before-ui.ts, whose control run on the base revision stands in for the
 * base result the baseline never gives a browser check).
 */
export async function collectFailBefore(ctx: RunContext, cand: CandidateRecord, input: CollectFailBeforeInput): Promise<FailBeforeEvidence> {
  const { mode, timeoutSeconds } = failBeforePolicy(ctx.snapshot.config);
  const accepted = acceptedWithoutFailBefore(ctx, cand.treeHash);
  const evidence = (probe: FailBeforeEvidence['probe'], skipped: FailBeforeEvidence['skipped'] = null): FailBeforeEvidence => ({ mode, probe, skipped, accepted });
  if (mode === 'off') return evidence(null);
  const resting = newTestSupport(input.contract, ctx.snapshot, input.base).filter((s) => s.flips.length === 0 && s.withTests.length > 0);
  const byCheck = new Map<string, string[]>();
  for (const s of resting) for (const id of s.probeable) byCheck.set(id, [...(byCheck.get(id) ?? []), s.criterionId]);
  if (byCheck.size === 0) return evidence(null);
  const allowFlaky = ctx.snapshot.config.verification.allow_flaky_pass === true;
  const required = [...new Set([...input.contract.required_check_ids, ...Object.values(ctx.snapshot.config.checks).filter((c) => c.mandatory && c.kind === 'command').map((c) => c.id)])].filter((id) => ctx.snapshot.config.checks[id]?.kind === 'command');
  // A failure the report accepts as the contract's baseline exception does not make the candidate unacceptable.
  const exceptions = new Map((input.contract.baseline_exceptions ?? []).map((e) => [e.check_id, e.fingerprint] as const));
  if (!input.installOk || !otherwiseAcceptable(input.results, required, allowFlaky, exceptions)) {
    return evidence(null, { cause: 'not-acceptable', reason: 'the probe did not run: the candidate is not otherwise acceptable (a required check or the dependency install did not pass)' });
  }
  const baseRev = ctx.run.baseRevision!;
  const { owned, manifests } = await probeChanges(ctx.run.repoRoot, baseRev, cand.commitSha);
  if (owned.length === 0) {
    return evidence(null, { cause: 'content-only', reason: 'the probe did not run: the new tests are tests only by their content (such as a #[test] added to a Rust source), which the probe tree cannot take without the production code around them' });
  }
  if (manifests.length > 0) {
    return evidence(null, { cause: 'manifest', reason: `not probed: the candidate changes ${manifests.join(', ')}, a dependency manifest or lockfile outside test-owned paths, so a test could fail or pass on the base revision for a dependency rather than for the change` });
  }
  const ordered = [...byCheck].sort(([a], [b]) => a.localeCompare(b)).map(([checkId, criteria]) => ({ checkId, criteria }));
  const commandChecks = ordered.filter((c) => isTestCommandCheck(ctx.snapshot.config.checks[c.checkId]));
  const browserChecks = ordered.filter((c) => !commandChecks.includes(c) && isBrowserCheck(ctx.snapshot, c.checkId));
  let probe: ProbeResult | null = null;
  if (commandChecks.length > 0) {
    probe = await runFailBeforeProbe({
      runner: input.runner,
      repoRoot: ctx.run.repoRoot,
      baseRev,
      candidate: cand,
      checks: commandChecks,
      changes: owned,
      checkoutDir: join(runWorktreeRoot(ctx), `fail-before-${cand.seq}`),
      timeoutMs: timeoutSeconds * 1000,
      wallRemainingMs: wallRemaining(ctx),
      decide: (d) => decide(ctx, d),
    });
  }
  if (browserChecks.length > 0) {
    const uiProbe = await runUiFailBeforeProbe(ctx, cand, {
      baseRev,
      changes: owned,
      checks: browserChecks,
      timeoutMs: timeoutSeconds * 1000,
      wallRemainingMs: wallRemaining(ctx),
      runner: input.runner,
      ...(input.uiRunner ? { uiRunner: input.uiRunner } : {}),
    });
    probe =
      probe === null
        ? { probeId: uiProbe.probeId, probeTree: uiProbe.probeTree, baseRevision: baseRev, testPaths: owned.map((c) => c.path).sort(), checks: uiProbe.checks, reused: false }
        : { ...probe, checks: [...probe.checks, ...uiProbe.checks], reused: false };
  }
  return evidence(probe);
}

/** What a probe from `from` to `to` may take, and what keeps it from running at all (ADR 0014 section 2). */
export interface ProbeChanges {
  /** The test-owned changes: what the probe tree takes from `to`. */
  owned: ProbeChange[];
  /** Dependency manifests and lockfiles `to` changes outside test-owned paths: with any, nothing is probed. */
  manifests: string[];
  /** Every change from `from` to `to`, which builds the repaired tree in the probe checkout. */
  all: ProbeChange[];
}

/** The changes from `from` to `to` a probe tree may take, and the manifests or lockfiles that stop it, read from the revisions. */
export async function probeChanges(repoRoot: string, from: string, to: string): Promise<ProbeChanges> {
  const changes = await changesBetween(repoRoot, from, to);
  // A .NET test project owns its whole folder and its project file, so the owner of every changed file is read.
  const layout = await loadTestLayout(gitTreeReader((args) => git(repoRoot, args)), from, to, changes.map((c) => c.path), { allDotnetOwners: true });
  const owned = changes.filter((c) => isTestOwnedPath(c.path, layout));
  // From the revisions, never from the scope report verification is given: a person's one-shot grant clears it.
  const manifests = [...new Set([...(await dependencyManifestsChangedBetween(repoRoot, from, to, changes)), ...changes.map((c) => c.path).filter(isLockfilePath)])].filter((p) => !isTestOwnedPath(p, layout)).sort();
  return { owned, manifests, all: changes };
}

/** What is left of the run's wall-time budget, which a probe must fit its bound into; null before the budget exists. */
function wallRemaining(ctx: RunContext): number | null {
  if (!ctx.ledger) return null;
  const wall = ctx.ledger.syncWall();
  return Math.max(0, wall.hard_cap - wall.used);
}

export interface RepairProbeRequest {
  /** The repair attempt whose tests are probed, which tells its probes of this candidate apart from another repair's. */
  attempt: number;
  /** The commit of the candidate the repair was sent to repair: the probe tree starts from its tree. */
  preRepair: string;
  /** The repair's test-owned changes from `preRepair` to the candidate (probeChanges) that the probe tree takes. */
  changes: readonly ProbeChange[];
  /**
   * The tests named for the findings judged on this tree, which it takes beside the control tree's changes; null for the
   * control tree, which takes none of the tests named for findings.
   */
  tests: readonly string[] | null;
  /** The checks to probe, each with the findings whose resolution rests on it. */
  checks: readonly { checkId: string; findings: readonly string[] }[];
  /** The repaired tree: `changes` are every change of the repair and `tests` is null (REPAIR_REPAIRED). */
  repaired?: boolean;
}

/**
 * A probe of a review repair's tests (ADR 0015): each given check, a required command check of category test that
 * passed on the repaired candidate and cleanly on the pre-repair one, runs on the pre-repair candidate's tree with the
 * given test-owned changes, with the candidate's runner context, a failing run once more, within
 * `verification.fail_before_timeout_seconds` for the tree. Its attempts are recorded like the fail-before probe's, never
 * in check_runs or failures, and a completed probe is one `review.repair-probe` decision whose decisive results a later
 * call for the same tree reuses. The tree is pinned under refs/orbit/<run>/repair-probe/<seq>-<attempt>-control for the
 * control tree, or -<attempt>-<id of the finding's tests>.
 */
export async function runRepairProbe(ctx: RunContext, cand: CandidateRecord, req: RepairProbeRequest): Promise<ProbeResult> {
  const { timeoutSeconds } = failBeforePolicy(ctx.snapshot.config);
  const part = req.repaired ? 'repaired' : req.tests === null ? 'control' : hashObject([...req.tests].sort()).slice(7, 19);
  return runFailBeforeProbe({
    runner: checkRunnerFor(ctx),
    repoRoot: ctx.run.repoRoot,
    baseRev: req.preRepair,
    candidate: cand,
    checks: [...req.checks].sort((a, b) => a.checkId.localeCompare(b.checkId)).map((c) => ({ checkId: c.checkId, criteria: [...c.findings] })),
    changes: req.changes,
    checkoutDir: join(runWorktreeRoot(ctx), `repair-probe-${cand.seq}`),
    timeoutMs: timeoutSeconds * 1000,
    wallRemainingMs: wallRemaining(ctx),
    decide: (d) => decide(ctx, d),
    flavour: req.repaired ? REPAIR_REPAIRED : req.tests === null ? REPAIR_CONTROL : REPAIR_PROBE,
    refPart: `${req.attempt}-${part}`,
  });
}

// ---------------------------------------------------------------------------
// A person's acceptance, bound to a tree

interface RequestData {
  question_id: string;
  criterion_id: string;
  tree_hash: string;
  candidate_id: string;
  outcome: string;
  cause: string | null;
}

function requests(ctx: RunContext): RequestData[] {
  return listDecisions(ctx.db, ctx.run.id, { kind: FAIL_BEFORE_REQUEST_KIND }).map((d) => d.data as RequestData);
}

export function failBeforeQuestionId(runId: string, treeHash: string, criterionId: string): string {
  return `q-fail-before-${hashObject({ run: runId, tree: treeHash, criterion: criterionId }).slice(7, 19)}`;
}

type Answer = { state: 'accepted'; questionId: string; by: string } | { state: 'declined'; questionId: string } | { state: 'pending'; questionId: string } | { state: 'none' };

function answerFor(ctx: RunContext, treeHash: string, criterionId: string): Answer {
  const req = requests(ctx).filter((r) => r.tree_hash === treeHash && r.criterion_id === criterionId).at(-1);
  if (!req) return { state: 'none' };
  const q = findQuestion(ctx.db, req.question_id);
  if (!q || q.status === 'withdrawn') return { state: 'none' };
  if (q.status === 'open') return { state: 'pending', questionId: q.id };
  const by = q.answeredBy;
  if ((q.answer ?? '').trim().toLowerCase() !== ACCEPT_WITHOUT_FAIL_BEFORE || !by || !isHumanActor(by)) return { state: 'declined', questionId: q.id };
  return { state: 'accepted', questionId: q.id, by };
}

/** The criteria a person accepted without fail-before for `treeHash`, each recorded once as a decision. */
export function acceptedWithoutFailBefore(ctx: RunContext, treeHash: string): { criterionId: string; questionId: string; by: string }[] {
  const out: { criterionId: string; questionId: string; by: string }[] = [];
  for (const criterionId of [...new Set(requests(ctx).filter((r) => r.tree_hash === treeHash).map((r) => r.criterion_id))].sort()) {
    const a = answerFor(ctx, treeHash, criterionId);
    if (a.state !== 'accepted') continue;
    const id = `dec-${ctx.run.id}-fail-before-accepted-${a.questionId}`;
    if (!getDecision(ctx.db, id)) decide(ctx, { id, kind: FAIL_BEFORE_ACCEPTED_KIND, summary: `${a.by} accepted ${criterionId} without fail-before for tree ${treeHash.slice(0, 12)} only`, data: { question_id: a.questionId, criterion_id: criterionId, tree_hash: treeHash, accepted_by: a.by } });
    out.push({ criterionId, questionId: a.questionId, by: a.by });
  }
  return out;
}

function ask(ctx: RunContext, cand: CandidateRecord, e: CriterionEvidence, why: string): QuestionRecord {
  const fb = e.fail_before!;
  const id = failBeforeQuestionId(ctx.run.id, cand.treeHash, e.criterion_id);
  const tree = cand.treeHash.slice(0, 12);
  const q =
    findQuestion(ctx.db, id) ??
    insertQuestion(
      ctx.db,
      {
        id,
        runId: ctx.run.id,
        mode: 'decision-record',
        question: `Accept ${e.criterion_id} without fail-before evidence for candidate ${cand.seq} (tree ${tree})?`,
        evidence: [`verification.fail_before is required: a criterion resting on new tests needs them to fail on the base revision`, `${e.criterion_id}: ${fb.reason}`, why, ...(fb.test_paths.count > 0 ? [`new tests: ${fb.test_paths.paths.join(', ')}${fb.test_paths.count > fb.test_paths.paths.length ? ` and ${fb.test_paths.count - fb.test_paths.paths.length} more` : ''}`] : [])],
        options: [
          { label: ACCEPT_WITHOUT_FAIL_BEFORE, description: `Accept ${e.criterion_id} for tree ${tree} only, without fail-before evidence (a refactor, or a characterization test of behaviour that already existed)`, consequences: 'verification counts the criterion as supported for this tree; the report lists who accepted it; any other tree is asked about again' },
          { label: DECLINE_WITHOUT_FAIL_BEFORE, description: `Keep requiring a test for ${e.criterion_id} that fails on the base revision`, consequences: 'the criterion stays unproven: the run stays blocked until a repair adds such a test (orbit repair), or it is cancelled' },
        ],
        changes: ['proof'],
        recommendation: { option: DECLINE_WITHOUT_FAIL_BEFORE, reason: 'a test that passes without the change is no evidence of it; accept only when the change is not meant to change behaviour' },
        safeDefault: { exists: true, option: DECLINE_WITHOUT_FAIL_BEFORE, reason: 'declining keeps the evidence rule the person set for this run' },
        material: true,
        affected: [e.criterion_id],
        unblocked: [],
      },
      ctx.clock,
      'controller',
    );
  if (!requests(ctx).some((r) => r.question_id === q.id)) {
    decide(ctx, { id: `dec-${ctx.run.id}-fail-before-request-${q.id}`, kind: FAIL_BEFORE_REQUEST_KIND, summary: `asked a person whether to accept ${e.criterion_id} without fail-before for candidate ${cand.seq} (tree ${tree})`, data: { question_id: q.id, criterion_id: e.criterion_id, tree_hash: cand.treeHash, candidate_id: cand.id, outcome: fb.outcome, cause: fb.cause ?? null } satisfies RequestData });
  }
  return q;
}

/** Fail-before questions of this run that no longer apply: another tree, or a criterion this report no longer needs one for. */
function withdrawMoot(ctx: RunContext, cand: CandidateRecord, report: EvidenceReport): void {
  const needs = new Set(failBeforeGaps(ctx, report).map((e) => e.criterion_id));
  for (const r of requests(ctx)) {
    const q = findQuestion(ctx.db, r.question_id);
    if (!q || q.status !== 'open') continue;
    if (r.tree_hash === cand.treeHash && needs.has(r.criterion_id)) continue;
    withdrawQuestion(ctx.db, q.id, r.tree_hash === cand.treeHash ? `${r.criterion_id} no longer needs a decision about fail-before evidence for this tree` : `the candidate changed since: the question was about tree ${r.tree_hash.slice(0, 12)}`, ctx.clock);
  }
}

/**
 * Whether the criterion's probe shows a cause no person may accept (an environment signal, an ERROR, a failed install),
 * on the criterion or on any one of its probed checks: a report that named only one check's cause cannot hide another's.
 */
function neverAccepted(e: CriterionEvidence): boolean {
  const fb = e.fail_before!;
  return [fb.cause, ...fb.checks.map((c) => c.cause)].some((c) => c !== undefined && !acceptableCause(c as NotEstablishedCause));
}

const PASSED_BEFORE_NOTE = 'the new tests pass on the base revision';
const NOT_ESTABLISHED_NOTE = 'fail-before not established';

/** The mandatory criteria fail-before keeps from support under `required`: passed-before (unverified) or not established (blocked). */
export function failBeforeGaps(ctx: RunContext, report: EvidenceReport): CriterionEvidence[] {
  const mandatory = new Set((ctx.contract?.acceptance_criteria ?? []).filter((c) => c.mandatory).map((c) => c.id));
  return report.acceptance_evidence.filter((e) => {
    const fb = e.fail_before;
    if (!mandatory.has(e.criterion_id) || fb === undefined || fb.mode !== 'required' || fb.accepted !== undefined) return false;
    return (fb.outcome === 'passed-before' && e.status === 'unverified' && (e.note ?? '').startsWith(PASSED_BEFORE_NOTE)) || (fb.outcome === 'not-established' && e.status === 'blocked' && (e.note ?? '').startsWith(NOT_ESTABLISHED_NOTE));
  });
}

/**
 * Whether a recorded report no longer says what fail-before would say now: a person answered a question about one of
 * its criteria for this tree since, or the run was resumed after it found a probe not established (the cause may be
 * fixed, and `orbit resume` runs the probe again).
 */
export function failBeforeStale(ctx: RunContext, cand: CandidateRecord, record: EvidenceReportRecord): boolean {
  const accepted = new Map(acceptedWithoutFailBefore(ctx, cand.treeHash).map((a) => [a.criterionId, a.questionId] as const));
  for (const e of record.report.acceptance_evidence) {
    if (e.fail_before === undefined) continue;
    if ((e.fail_before.accepted?.question_id ?? null) !== (accepted.get(e.criterion_id) ?? null)) return true;
  }
  const open = record.report.acceptance_evidence.some((e) => e.fail_before?.mode === 'required' && e.fail_before.outcome === 'not-established');
  if (!open) return false;
  return ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'run.resumed' AND ts > ? LIMIT 1", ctx.run.id, record.createdAt) !== undefined;
}

/** `AC-1, AC-2: <text>` once per distinct text, in the order the criteria come: a reason several criteria share is stated once. */
function groupedByText(items: readonly { id: string; text: string }[]): string[] {
  const groups = new Map<string, string[]>();
  for (const { id, text } of items) groups.set(text, [...(groups.get(text) ?? []), id]);
  return [...groups].map(([text, ids]) => `${ids.join(', ')}: ${text}`);
}

function decideHow(runId: string, questions: readonly QuestionRecord[]): string {
  return `Answer ${questions.length === 1 ? 'it' : 'each'} with orbit decide ${runId} <question-id> ${ACCEPT_WITHOUT_FAIL_BEFORE}|${DECLINE_WITHOUT_FAIL_BEFORE}, then orbit resume ${runId}. Questions: ${questions.map((q) => `${q.id}: ${q.question}`).join(' | ')}`;
}

/**
 * VERIFYING's routing under `required` (ADR 0014 section 4), before the Inquisition: a criterion whose probe is not
 * established blocks the run, with a question when its cause may be accepted; one whose new tests pass on the base
 * revision goes to repair while `pending` finds an inquiry to enter, and to a person when none is left (the repair loop
 * already went round on this tree). Null when fail-before keeps no criterion from support, or the loop should go on.
 */
export async function routeFailBefore(ctx: RunContext, cand: CandidateRecord, ev: EvidenceReportRecord, pending: () => Promise<StepResult | null>): Promise<StepResult | null> {
  withdrawMoot(ctx, cand, ev.report);
  const gaps = failBeforeGaps(ctx, ev.report);
  if (gaps.length === 0) return null;
  const tree = cand.treeHash.slice(0, 12);
  const notEstablished = gaps.filter((e) => e.fail_before!.outcome === 'not-established');
  if (notEstablished.length > 0) {
    const environment = notEstablished.filter(neverAccepted);
    const askable = notEstablished.filter((e) => !environment.includes(e));
    const declined = askable.filter((e) => answerFor(ctx, cand.treeHash, e.criterion_id).state === 'declined');
    const questions = askable.filter((e) => !declined.includes(e)).map((e) => ask(ctx, cand, e, `the probe was not established for tree ${tree}`));
    const parts = [
      `fail-before evidence is required (verification.fail_before: required), and for candidate ${cand.seq} (tree ${tree}) it was not established: ${groupedByText(notEstablished.map((e) => ({ id: e.criterion_id, text: e.fail_before!.reason }))).join('; ')}`,
      ...(environment.length > 0 ? [`${environment.map((e) => e.criterion_id).join(', ')}: the cause is the environment's (an environment signal, an ERROR or a failed install), which is never accepted in place of the evidence; fix it, then orbit resume ${ctx.run.id} runs the probe again`] : []),
      ...(declined.length > 0 ? [`${declined.map((e) => e.criterion_id).join(', ')}: a person declined to accept ${declined.length === 1 ? 'it' : 'them'} without fail-before for this tree`] : []),
      ...(questions.length > 0 ? [decideHow(ctx.run.id, questions)] : []),
    ];
    return finishRun(ctx, 'BLOCKED', parts.join('. '), { outcome: { candidate_id: cand.id, report_id: ev.id, fail_before: { candidate_id: cand.id, tree_hash: cand.treeHash, not_established: notEstablished.map((e) => ({ criterion_id: e.criterion_id, cause: e.fail_before!.cause ?? null, reason: e.fail_before!.reason })), questions: questions.map((q) => q.id) } } });
  }
  const waiting = gaps.map((e) => ({ e, a: answerFor(ctx, cand.treeHash, e.criterion_id) }));
  if (waiting.some((w) => w.a.state === 'pending' || w.a.state === 'declined')) return askPerson(ctx, cand, gaps, `the person's answer is still needed`, ev.id);
  const next = await pending();
  if (next) return next;
  return askPerson(ctx, cand, gaps, `the repair loop already went round on tree ${tree}, and another repair would start from the same evidence`, ev.id);
}

/**
 * DIAGNOSING's stops (the non-progress threshold, the attempt cap, an allowance with no extension) end a run whose
 * candidate rests on new tests that pass on the base revision in a question to a person instead (ADR 0014 section 4).
 * Null when the current candidate has no such criterion, or a person declined it already: the run then ends as it would.
 */
export async function askInsteadOfExhausting(ctx: RunContext, cand: CandidateRecord, why: string): Promise<StepResult | null> {
  const ev = currentEvidenceReport(ctx.db, ctx.run.id, cand.id);
  if (!ev) return null;
  const gaps = failBeforeGaps(ctx, ev.report).filter((e) => e.fail_before!.outcome === 'passed-before');
  if (gaps.length === 0 || gaps.every((e) => answerFor(ctx, cand.treeHash, e.criterion_id).state === 'declined')) return null;
  return askPerson(ctx, cand, gaps, `the repair attempts ran out (${why})`, ev.id);
}

async function askPerson(ctx: RunContext, cand: CandidateRecord, gaps: readonly CriterionEvidence[], why: string, reportId: string): Promise<StepResult> {
  const tree = cand.treeHash.slice(0, 12);
  const declined = gaps.filter((e) => answerFor(ctx, cand.treeHash, e.criterion_id).state === 'declined');
  const questions = gaps.filter((e) => !declined.includes(e)).map((e) => ask(ctx, cand, e, why));
  const parts = [
    `${groupedByText(gaps.map((e) => ({ id: e.criterion_id, text: e.note ?? '' }))).join('; ')}; ${why}`,
    ...(declined.length > 0 ? [`${declined.map((e) => e.criterion_id).join(', ')}: a person declined to accept ${declined.length === 1 ? 'it' : 'them'} without fail-before for tree ${tree}; a repair that adds a test failing on the base revision is the way on (orbit repair ${ctx.run.id})`] : []),
    ...(questions.length > 0 ? [`Accept ${questions.length === 1 ? 'it' : 'them'} without fail-before for tree ${tree} (a refactor, or a characterization test), or not. ${decideHow(ctx.run.id, questions)}`] : []),
  ];
  return finishRun(ctx, 'BLOCKED', parts.join('. '), { outcome: { candidate_id: cand.id, report_id: reportId, fail_before: { candidate_id: cand.id, tree_hash: cand.treeHash, passed_before: gaps.map((e) => e.criterion_id), questions: questions.map((q) => q.id) } } });
}
