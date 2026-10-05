/**
 * The spec section 5 gate sequence as explicit functions:
 *
 *   intake -> environment -> baseline -> implementation (scope) ->
 *   static security -> behaviour -> UI -> independent review -> delivery -> completion
 *
 * Each gate returns pass, fail or unverified with the evidence it looked at
 * and the failure behaviour from the spec table. Gates decide nothing about
 * state: the step that calls one acts on `onFailure`. "Unverified" is never
 * reported as passed; where a gate cannot establish its claim it says so.
 */
import { realpathSync } from 'node:fs';
import type { OrbitDb } from '../storage/db.ts';
import type { CredentialCheck } from '../recovery/credentials.ts';
import type { ReviewerSelection } from '../review/select.ts';
import { reviewGate, type ReviewGateResult } from '../review/stale.ts';
import { listReviews } from '../review/store.ts';
import type { GoalContract } from '../contract/types.ts';
import { contractProblems } from '../contract/validate.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import { UNATTENDED_MODES } from '../policy/config.ts';
import { snapshotHash } from '../policy/snapshot.ts';
import type { BaselineReport } from '../evidence/baseline.ts';
import type { Evaluation } from '../evidence/report.ts';
import { assertDeliverable, staleReasons } from '../evidence/freshness.ts';
import { currentEvidenceReport, type CandidateRecord, type EvidenceReportRecord } from '../evidence/store.ts';
import type { ScopeReport } from '../evidence/types.ts';
import type { UiRunResult } from '../ui/types.ts';
import { isOrbitError } from '../core/errors.ts';
import { criteriaBlockedByQuestions, openQuestions } from '../inquisition/questions.ts';
import type { QuestionRecord } from '../inquisition/store.ts';
import type { RunRecord } from './run-store.ts';
import type { SecretScanResult } from './security.ts';

export const GATES = ['intake', 'environment', 'baseline', 'implementation', 'static_security', 'behaviour', 'ui', 'independent_review', 'delivery', 'completion'] as const;
export type GateName = (typeof GATES)[number];

/** The spec table's failure behaviour, as a value a step can switch on. */
export type GateFailure = 'reject-contract' | 'block-unattended' | 'record-baseline' | 'deny-and-record' | 'repair-or-block' | 'repair-brief' | 'resolve-findings' | 'refuse-delivery' | 'no-success';

export const FAILURE_BEHAVIOUR: Readonly<Record<GateName, GateFailure>> = {
  intake: 'reject-contract',
  environment: 'block-unattended',
  baseline: 'record-baseline',
  implementation: 'deny-and-record',
  static_security: 'repair-or-block',
  behaviour: 'repair-brief',
  ui: 'repair-or-block',
  independent_review: 'resolve-findings',
  delivery: 'refuse-delivery',
  completion: 'no-success',
};

export type GateStatus = 'pass' | 'fail' | 'unverified';

export interface GateResult<D = Record<string, unknown>> {
  gate: GateName;
  status: GateStatus;
  passed: boolean;
  /** Why it did not pass; empty on pass. */
  reasons: string[];
  /** What was looked at: artifact paths, ids, hashes, plain observations. */
  evidence: string[];
  /** Things the gate passed with but could not establish (stated, never implied). */
  notes: string[];
  onFailure: GateFailure;
  details: D;
}

function result<D>(gate: GateName, reasons: string[], evidence: string[], notes: string[], details: D, unverified = false): GateResult<D> {
  const status: GateStatus = reasons.length > 0 ? 'fail' : unverified ? 'unverified' : 'pass';
  return { gate, status, passed: status === 'pass', reasons, evidence, notes, onFailure: FAILURE_BEHAVIOUR[gate], details };
}

// ---------------------------------------------------------------------------
// Intake

export interface IntakeInput {
  run: Pick<RunRecord, 'id' | 'repoRoot' | 'mode' | 'policyHash'>;
  snapshot: PolicySnapshot;
  /** Proposed or stored contract; validated here. Omitted at preflight, before a contract exists. */
  contract?: unknown;
}

/** Repository authorization, scope, budgets and measurable criteria. Failure: reject the contract. */
export function intakeGate(input: IntakeInput): GateResult<{ problems: string[] }> {
  const { snapshot, run } = input;
  const reasons: string[] = [];
  const evidence: string[] = [`policy ${run.policyHash}`];
  let repo: string;
  try {
    repo = realpathSync(run.repoRoot);
  } catch {
    repo = run.repoRoot;
    reasons.push(`repository ${run.repoRoot} does not exist`);
  }
  if (repo !== snapshot.repo_root) reasons.push(`the run's repository ${repo} is not the repository the policy authorizes (${snapshot.repo_root})`);
  if (run.mode !== snapshot.config.mode) reasons.push(`the run's mode ${run.mode} differs from the frozen policy mode ${snapshot.config.mode}`);
  if (snapshotHash(snapshot) !== run.policyHash) reasons.push('the policy snapshot does not match the hash recorded for the run');
  const limits = snapshot.config.scheduler.hard_limits;
  for (const [k, v] of Object.entries(limits)) if (!(typeof v === 'number' && v > 0)) reasons.push(`hard limit ${k} must be positive`);
  if (snapshot.config.scope.allowed_paths.length === 0) reasons.push('the policy allows no paths, so no implementation is authorized');

  const problems = input.contract === undefined ? [] : contractProblems(input.contract, snapshot, { policyHash: run.policyHash });
  reasons.push(...problems.map((p) => `contract: ${p}`));
  if (input.contract !== undefined && problems.length === 0) {
    const c = input.contract as GoalContract;
    evidence.push(`contract ${c.task_id}: ${c.acceptance_criteria.length} criteria, ${c.required_check_ids.length} required checks, scope ${c.allowed_paths.join(', ')}`);
    const mandatory = c.acceptance_criteria.filter((a) => a.mandatory);
    if (mandatory.length === 0) reasons.push('the contract has no mandatory acceptance criterion, so success could not be measured');
    for (const a of mandatory) {
      if (a.proof.length === 0) reasons.push(`${a.id} names no proof`);
      const byCheck = (a.check_ids ?? []).length > 0;
      const byUi = a.ui === true && (snapshot.config.ui?.journey_check_ids.length ?? 0) > 0;
      if (!byCheck && !byUi) reasons.push(`${a.id} is not measurable: it cites no trusted check${a.ui ? ' and the policy defines no UI journeys' : ''}`);
    }
    if (c.allowed_paths.length === 0) reasons.push('the contract allows no paths');
  }
  return result('intake', reasons, evidence, [], { problems });
}

// ---------------------------------------------------------------------------
// Environment

export interface EnvironmentInput {
  snapshot: PolicySnapshot;
  mode: RunRecord['mode'];
  /** The isolation provider kind that would run workers and checks, or the error constructing it. */
  isolation: { kind: 'sandbox-runtime' | 'container' | 'none'; available: boolean; detail: string } | { error: string };
  /** Credential checks of the providers the run cannot do without. */
  credentials: readonly CredentialCheck[];
  /** Reviewer selection when independent review is mandatory; null when it is not. */
  reviewer: ReviewerSelection | null;
}

export function environmentGate(input: EnvironmentInput): GateResult<{ blockedProvider: string | null; code: string | null }> {
  const reasons: string[] = [];
  const evidence: string[] = [];
  const notes: string[] = [];
  let blockedProvider: string | null = null;
  let code: string | null = null;
  const unattended = UNATTENDED_MODES.has(input.mode);

  if ('error' in input.isolation) {
    reasons.push(`isolation is unavailable: ${input.isolation.error}`);
    code = 'ISOLATION_UNAVAILABLE';
  } else {
    const iso = input.isolation;
    evidence.push(`isolation ${iso.kind}: ${iso.detail}`);
    if (iso.kind === 'none') {
      if (unattended && input.snapshot.config.isolation.allow_unisolated !== true) {
        reasons.push(`unattended ${input.mode} execution needs isolation; the policy selects none`);
        code = 'ISOLATION_UNAVAILABLE';
      } else {
        // An explicit, trusted opt-out: honoured, and stated in every report rather than hidden.
        notes.push('no isolation: workers and checks run without an OS sandbox and without network egress controls (isolation.allow_unisolated)');
      }
    } else if (!iso.available) {
      reasons.push(`${iso.kind} isolation is unavailable: ${iso.detail}`);
      code = 'ISOLATION_UNAVAILABLE';
    } else if (iso.kind === 'sandbox-runtime') {
      notes.push('sandbox-runtime limits filesystem writes and network egress but not CPU, memory or process count');
    }
  }

  for (const c of input.credentials) {
    evidence.push(`credentials ${c.provider}: ${c.verdict}${c.status ? ` (${c.status.state}${c.status.method ? `, ${c.status.method}` : ''})` : ''}`);
    if (c.verdict === 'blocked') {
      reasons.push(`${c.provider} credentials are ${c.status?.state ?? 'not usable'}${c.status?.detail ? `: ${c.status.detail}` : ''}`);
      blockedProvider ??= c.provider;
      code ??= c.status?.state === 'missing' ? 'AUTH_MISSING' : 'AUTH_EXPIRED';
    } else if (c.verdict === 'error') {
      reasons.push(`${c.provider} could not be checked: ${c.error ?? 'unknown error'}`);
      code ??= 'PROVIDER_UNAVAILABLE';
    } else if (c.verdict === 'unverified') {
      notes.push(`${c.provider} credentials are present but unverified until a request succeeds`);
    }
  }

  if (input.reviewer) {
    if (input.reviewer.decision === 'BLOCK') {
      reasons.push(`independent review: ${input.reviewer.reason}`);
      code ??= input.reviewer.code;
    } else {
      evidence.push(`reviewer ${input.reviewer.provider}/${input.reviewer.model ?? 'default'} (${input.reviewer.independent ? 'independent' : 'same provider'})`);
    }
  }
  return result('environment', reasons, evidence, notes, { blockedProvider, code });
}

// ---------------------------------------------------------------------------
// Baseline

/** Records pre-existing failures (pass); blocks only when the locked install itself failed. */
export function baselineGate(report: BaselineReport): GateResult<{ failures: BaselineReport['failures'] }> {
  const reasons: string[] = [];
  const notes: string[] = [];
  const evidence = [`baseline of ${report.baseRevision} (tree ${report.baseTree}): ${report.checks.length} check(s)`];
  if (!report.install.skipped && !report.install.ok) reasons.push(`the locked dependency install failed on the base revision${report.install.reason ? `: ${report.install.reason}` : ''}`);
  for (const f of report.failures) notes.push(`pre-existing failure on the base revision: ${f.checkId}${f.fingerprint ? ` (${f.fingerprint})` : ''}`);
  // Pre-existing vulnerabilities and license problems on the base revision, one note per finding, so the final report lists them.
  for (const n of report.auditNotes ?? []) notes.push(n);
  if (!report.complete) notes.push('the baseline is incomplete: some checks could not produce a decisive result on the base revision');
  return result('baseline', reasons, evidence, notes, { failures: report.failures }, !report.complete && reasons.length === 0);
}

// ---------------------------------------------------------------------------
// Implementation scope

export interface ScopeGateDetails {
  /** Protected paths or escaping symlinks: a policy violation, not something a repair may negotiate. */
  policyViolation: boolean;
  repairable: string[];
}

export function implementationScopeGate(scope: ScopeReport, snapshot: PolicySnapshot): GateResult<ScopeGateDetails> {
  const reasons: string[] = [];
  const repairable: string[] = [];
  const deps = snapshot.config.dependencies;
  if (scope.forbidden_paths_changed.length > 0) reasons.push(`protected paths changed: ${scope.forbidden_paths_changed.join(', ')}`);
  if (scope.symlinks_escaping.length > 0) reasons.push(`symlinks escape the worktree: ${scope.symlinks_escaping.join(', ')}`);
  const policyViolation = reasons.length > 0;
  const add = (why: string) => {
    reasons.push(why);
    repairable.push(why);
  };
  if (scope.out_of_scope_paths_changed.length > 0) add(`paths outside the authorized scope changed: ${scope.out_of_scope_paths_changed.join(', ')}`);
  if (!scope.within_size_limits) add(`the change is over the size limits (${scope.changed_files} files, ${scope.changed_lines} lines)`);
  if (scope.lockfile_changed && !deps.change_lockfile) add('a lockfile changed, which the policy does not allow');
  if (scope.dependency_manifest_changed.length > 0 && !deps.add_packages) add(`dependency manifests changed: ${scope.dependency_manifest_changed.join(', ')}`);
  const evidence = [`${scope.changed_files} file(s), ${scope.changed_lines} line(s) changed`];
  const notes = scope.weakening_signals.map((w) => `possible oracle weakening in ${w.path}: ${w.signal} (${w.detail})`);
  return result('implementation', reasons, evidence, notes, { policyViolation, repairable });
}

// ---------------------------------------------------------------------------
// Static security

export interface StaticSecurityInput {
  scan: SecretScanResult;
  /** SAST check ids the policy defines, with their results on this candidate (missing = not run). */
  sast: { checkId: string; status: string | null }[];
}

export function staticSecurityGate(input: StaticSecurityInput): GateResult<{ secrets: number; sastDefined: boolean }> {
  const reasons: string[] = [];
  const notes: string[] = [];
  const evidence = [`secret scan: ${input.scan.note}; ${input.scan.files} file(s) scanned (${input.scan.reportPath})`];
  if (!input.scan.completed) notes.push('the secret scan did not complete');
  if (input.scan.findings.length > 0) {
    reasons.push(`the secret scan found ${input.scan.findings.length} potential secret(s): ${input.scan.findings.slice(0, 10).map((f) => `${f.file}${f.line ? `:${f.line}` : ''} (${f.rule})`).join(', ')}`);
  }
  if (input.scan.scanner === 'builtin') notes.push(`secret scan used built-in patterns only: ${input.scan.note}`);
  if (input.sast.length === 0) {
    notes.push('static analysis (SAST) is unverified: the policy defines no SAST check');
  } else {
    for (const s of input.sast) {
      evidence.push(`SAST ${s.checkId}: ${s.status ?? 'not run'}`);
      if (s.status === 'FAILED') reasons.push(`SAST check ${s.checkId} failed`);
      else if (s.status !== 'PASSED') notes.push(`SAST check ${s.checkId} is unverified (${s.status ?? 'not run'})`);
    }
  }
  const unverified = input.sast.length === 0 || !input.scan.completed || input.sast.some((s) => s.status !== 'PASSED');
  return result('static_security', reasons, evidence, notes, { secrets: input.scan.findings.length, sastDefined: input.sast.length > 0 }, unverified);
}

// ---------------------------------------------------------------------------
// Behaviour

export function behaviourGate(evaluation: Evaluation): GateResult<{ verdict: string }> {
  const r = evaluation.report;
  const evidence = r.checks.map((c) => `${c.id}: ${c.status}${c.flaky ? ' (flaky)' : ''} (${c.log})`);
  evidence.push(...r.acceptance_evidence.map((a) => `${a.criterion_id}: ${a.status}`));
  if (r.verdict === 'FAIL') return result('behaviour', evaluation.failReasons.length > 0 ? evaluation.failReasons : ['the evidence verdict is FAIL'], evidence, r.unverified, { verdict: r.verdict });
  return result('behaviour', [], evidence, [...evaluation.incompleteReasons, ...r.unverified], { verdict: r.verdict }, r.verdict !== 'PASS');
}

// ---------------------------------------------------------------------------
// UI

export interface UiGateInput {
  required: boolean;
  configured: boolean;
  result: Pick<UiRunResult, 'verdict' | 'reasons' | 'unverified' | 'journeys'> | null;
}

export function uiGate(input: UiGateInput): GateResult<{ verdict: string | null }> {
  if (!input.required) return result('ui', [], ['no UI path changed and no criterion needs UI evidence'], [], { verdict: null });
  if (!input.configured) return result('ui', ['UI evidence is required but the policy configures no UI journeys'], [], [], { verdict: null });
  const r = input.result;
  if (!r) return result('ui', [], [], ['UI checks did not run'], { verdict: null }, true);
  const evidence = r.journeys.map((j) => `${j.id}: ${j.status}`);
  if (r.verdict === 'PASS') return result('ui', [], evidence, r.unverified, { verdict: r.verdict });
  if (r.verdict === 'FAIL' || r.verdict === 'BLOCKED') return result('ui', r.reasons.length > 0 ? r.reasons : [`UI verdict ${r.verdict}`], evidence, r.unverified, { verdict: r.verdict });
  return result('ui', [], evidence, [...r.reasons, ...r.unverified], { verdict: r.verdict }, true);
}

// ---------------------------------------------------------------------------
// Independent review

export interface ReviewGateArgs {
  runId: string;
  treeHash: string;
  snapshot: PolicySnapshot;
  implementerProvider: string;
  now: number;
}

export function independentReviewGate(db: OrbitDb, input: ReviewGateArgs): GateResult<{ gate: ReviewGateResult; approved: boolean }> {
  const g = reviewGate(db, { runId: input.runId, treeHash: input.treeHash, snapshot: input.snapshot, implementerProvider: input.implementerProvider, now: input.now });
  const approved = g.cleared.some((r) => r.verdict === 'APPROVE');
  const evidence = g.cleared.map((r) => `review ${r.id} by ${r.provider}: ${r.verdict} on tree ${r.treeHash}`);
  return result('independent_review', g.reasons, evidence, [], { gate: g, approved });
}

// ---------------------------------------------------------------------------
// Delivery

export interface DeliveryGateInput {
  snapshot: PolicySnapshot;
  candidate: Pick<CandidateRecord, 'id' | 'runId' | 'treeHash' | 'commitSha'>;
  evidence: EvidenceReportRecord;
  review: { treeHash: string; verdict: string } | null;
  /** Tree of the commit about to be delivered. */
  deliveryCommitTree: string;
}

export function deliveryGate(input: DeliveryGateInput): GateResult<{ code: string | null }> {
  try {
    assertDeliverable({
      report: input.evidence.report,
      review: input.review,
      deliveryCommitTree: input.deliveryCommitTree,
      invalidatedReason: input.evidence.invalidatedReason,
      current: { candidate: input.candidate, snapshot: input.snapshot },
    });
    return result('delivery', [], [`evidence ${input.evidence.id} and review on tree ${input.candidate.treeHash}; delivery tree ${input.deliveryCommitTree}`], [], { code: null });
  } catch (err) {
    if (!isOrbitError(err)) throw err;
    return result('delivery', [err.message], [], [], { code: err.code });
  }
}

// ---------------------------------------------------------------------------
// Completion

export interface CompletionInput {
  run: Pick<RunRecord, 'id'>;
  snapshot: PolicySnapshot;
  candidate: Pick<CandidateRecord, 'id' | 'runId' | 'treeHash' | 'commitSha'> | null;
  implementerProvider: string;
  /** Delivery modes: the tree of the delivered commit; local modes: the tree the local branch points at. */
  deliveredTree: string | null;
  now: number;
}

/** Criteria blocked by open material questions, with the questions that block them. */
export function blockingQuestions(db: OrbitDb, runId: string): { criteria: string[]; questions: QuestionRecord[] } {
  const waiting = openQuestions(db, runId).filter((q) => q.material);
  const criteria = criteriaBlockedByQuestions(waiting);
  return { criteria, questions: waiting.filter((q) => q.affected.some((a) => criteria.includes(a))) };
}

/**
 * No success without current evidence: a fresh PASS report and an APPROVE
 * review of the same tree, and the delivered (or locally branched) commit's
 * tree equal to it.
 */
export function completionGate(db: OrbitDb, input: CompletionInput): GateResult<{ evidenceId: string | null; reviewId: string | null; blockedCriteria: string[] }> {
  const reasons: string[] = [];
  const evidence: string[] = [];
  const c = input.candidate;
  if (!c) return result('completion', ['there is no candidate'], [], [], { evidenceId: null, reviewId: null, blockedCriteria: [] });
  const report = currentEvidenceReport(db, input.run.id, c.id);
  if (!report) reasons.push(`no live evidence report for candidate ${c.id}`);
  else {
    evidence.push(`evidence ${report.id}: ${report.verdict} on tree ${report.treeHash}`);
    if (report.verdict !== 'PASS') reasons.push(`the evidence verdict is ${report.verdict}, not PASS`);
    const stale = staleReasons(report.report, { candidate: c, snapshot: input.snapshot });
    if (stale.length > 0) reasons.push(`the evidence is stale: ${stale.join('; ')}`);
  }
  const g = reviewGate(db, { runId: input.run.id, treeHash: c.treeHash, snapshot: input.snapshot, implementerProvider: input.implementerProvider, now: input.now });
  const approve = listReviews(db, input.run.id, { treeHash: c.treeHash }).find((r) => r.verdict === 'APPROVE' && r.invalidatedAt === null) ?? null;
  if (!approve) reasons.push(`no APPROVE review of tree ${c.treeHash}`);
  else evidence.push(`review ${approve.id} by ${approve.provider}: APPROVE on tree ${approve.treeHash}`);
  if (!g.ok) reasons.push(...g.reasons);
  // A criterion an open material question blocks is not done, whatever the checks say (spec section 10).
  const { criteria: blocked, questions: waiting } = blockingQuestions(db, input.run.id);
  if (blocked.length > 0) reasons.push(`${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} blocked by open question(s) ${waiting.map((q) => q.id).join(', ')} waiting for a person`);
  if (input.deliveredTree === null) reasons.push('no delivered commit to compare with the reviewed tree');
  else if (input.deliveredTree !== c.treeHash) reasons.push(`the delivered tree ${input.deliveredTree} is not the reviewed tree ${c.treeHash}`);
  else evidence.push(`delivered tree ${input.deliveredTree}`);
  return result('completion', reasons, evidence, [], { evidenceId: report?.id ?? null, reviewId: approve?.id ?? null, blockedCriteria: blocked });
}
