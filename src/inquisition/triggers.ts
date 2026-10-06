import type { OrbitDb } from '../storage/db.ts';
import { OrbitError } from '../core/errors.ts';
import { hashObject } from '../core/hash.ts';
import { redact } from '../core/redact.ts';
import { listDecisions } from '../storage/decisions.ts';
import type { GoalContract } from '../contract/types.ts';
import type { ImplementerOutput } from '../contract/model-outputs.ts';
import { wordTokens } from '../contract/wording.ts';
import { isTestPath } from '../policy/weakening.ts';
import type { RunMode } from '../policy/types.ts';
import { fingerprintOccurrences, listFailures, type FailureRecord } from './store.ts';
import { RISK_CATEGORIES, riskCategoriesInDiff, riskCategoriesInPaths, riskCategoriesInText, type RiskCategory } from './heuristics.ts';
import type { InquisitionMode, Trigger, TriggerKind } from './types.ts';

/**
 * Deterministic trigger detection (spec section 10 "Triggers"). Everything
 * here is code over a snapshot of durable state: no model decides whether an
 * inquisition is needed. Each trigger names the mode that answers it and the
 * observations that raised it, so the controller can enter INQUISITION with a
 * stated reason and a worker (if one is needed) starts from facts.
 *
 * Sources that are not in the database (candidate diff, planner's expected
 * files, implementer claims, source statements to reconcile) are passed in as
 * data by the caller; this module reads no files and runs no commands.
 */

export interface TriggerThresholds {
  /** Distinct candidates failing with one fingerprint (policy scheduler.repeated_failure_threshold). */
  repeatedFailure: number;
  /** Changed files outside the planner's expected set tolerated before it counts as unexplained. */
  unexplainedFiles: number;
  /** Policy denials in one run tolerated before it counts as pressure on scope. */
  denials: number;
}

export const DEFAULT_THRESHOLDS: TriggerThresholds = { repeatedFailure: 2, unexplainedFiles: 3, denials: 3 };

/** The policy owns the repeated-failure threshold; the other two are Inquisition heuristics. */
export function thresholdsFromPolicy(config: { scheduler: { repeated_failure_threshold: number } }): TriggerThresholds {
  return { ...DEFAULT_THRESHOLDS, repeatedFailure: config.scheduler.repeated_failure_threshold };
}

export interface EvidenceView {
  candidateId: string;
  treeHash: string;
  verdict: 'PASS' | 'FAIL' | 'INCOMPLETE';
  checks: { id: string; status: string; flaky: boolean }[];
  acceptance: { criterion_id: string; status: string; artifacts: string[] }[];
  weakeningSignals: { path: string; signal: string; detail: string }[];
  visualBaselineChanges: string[];
  unverified: string[];
}

export interface ReviewView {
  id: string;
  round: number;
  candidateId: string;
  treeHash: string;
  provider: string;
  verdict: string;
  findings: { id?: string; severity?: string; claim?: string }[];
}

export interface PolicyDenial {
  rule: string;
  target: string | null;
}

/** One document's claims about named things, for reconciliation. */
export interface SourceStatement {
  /** Where it came from: a path, an issue, a doc title. */
  source: string;
  /** Higher authority wins a reconciliation; the map is part of the inquisition's output. */
  authority: 'policy' | 'goal' | 'user' | 'test' | 'code' | 'doc' | 'issue' | 'comment';
  claims: { subject: string; value: string }[];
}

export interface InquisitionSnapshot {
  runId: string;
  mode: RunMode;
  contract: GoalContract | null;
  failures: FailureRecord[];
  evidence: EvidenceView | null;
  reviews: ReviewView[];
  denials: PolicyDenial[];
  /** Kinds and summaries of recorded decisions, to tell a decided topic from a hidden one. */
  decisions: { kind: string; summary: string }[];
  /** The planner's expected_changed_files paths. */
  expectedChangedFiles: string[];
  changedFiles: string[];
  /** Unified diff of the candidate against its base; only added lines are inspected. */
  diff: string | null;
  claims: ImplementerOutput | null;
  sources: SourceStatement[];
  thresholds: TriggerThresholds;
}

/** What the database cannot supply; everything else is loaded. */
export interface SnapshotExtras {
  expectedChangedFiles?: string[];
  changedFiles?: string[];
  diff?: string | null;
  claims?: ImplementerOutput | null;
  sources?: SourceStatement[];
  thresholds?: Partial<TriggerThresholds>;
  /**
   * The tree hash of the candidate under inquiry. When given, only evidence
   * and reviews bound to exactly that tree count: a report for an earlier
   * tree describes code that no longer exists (spec section 11 freshness).
   */
  currentTreeHash?: string;
}

interface RunRow {
  mode: string;
  contract_json: string | null;
}
interface EvidenceRow {
  candidate_id: string;
  tree_hash: string;
  verdict: string;
  report_json: string;
}
interface ReviewRow {
  id: string;
  round: number;
  candidate_id: string;
  tree_hash: string;
  provider: string;
  verdict: string;
  findings_json: string | null;
}

/** A missing column falls back; one that does not parse fails, because an unreadable contract or report must not read as "nothing to detect". */
function safeParse<T>(text: string | null, fallback: T, code: 'CONTRACT_INVALID' | 'INTERNAL' = 'INTERNAL', what = 'a stored record'): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new OrbitError(code, `${what} holds unreadable JSON`, undefined, { cause: err });
  }
}

/** Build the snapshot from the run's rows (current evidence only: invalidated reports and reviews are history). */
export function loadInquisitionSnapshot(db: OrbitDb, runId: string, extras: SnapshotExtras = {}): InquisitionSnapshot {
  const run = db.get<RunRow>('SELECT mode, contract_json FROM runs WHERE id = ?', runId);
  if (!run) throw new OrbitError('NOT_FOUND', `no run ${runId}`);
  const tree = extras.currentTreeHash;
  const ev =
    tree === undefined
      ? db.get<EvidenceRow>('SELECT candidate_id, tree_hash, verdict, report_json FROM evidence_reports WHERE run_id = ? AND invalidated_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1', runId)
      : db.get<EvidenceRow>('SELECT candidate_id, tree_hash, verdict, report_json FROM evidence_reports WHERE run_id = ? AND tree_hash = ? AND invalidated_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1', runId, tree);
  let evidence: EvidenceView | null = null;
  if (ev) {
    const report = safeParse<Record<string, unknown>>(ev.report_json, {}, 'INTERNAL', `evidence report for candidate ${ev.candidate_id}`);
    const scope = (report.scope ?? {}) as { weakening_signals?: EvidenceView['weakeningSignals']; visual_baseline_changes?: string[] };
    evidence = {
      candidateId: ev.candidate_id,
      treeHash: ev.tree_hash,
      verdict: ev.verdict as EvidenceView['verdict'],
      checks: ((report.checks ?? []) as { id: string; status: string; flaky?: boolean }[]).map((c) => ({ id: c.id, status: c.status, flaky: c.flaky === true })),
      acceptance: ((report.acceptance_evidence ?? []) as { criterion_id: string; status: string; artifacts?: string[] }[]).map((a) => ({ criterion_id: a.criterion_id, status: a.status, artifacts: a.artifacts ?? [] })),
      weakeningSignals: scope.weakening_signals ?? [],
      visualBaselineChanges: scope.visual_baseline_changes ?? [],
      unverified: (report.unverified ?? []) as string[],
    };
  }
  const reviews = db
    .all<ReviewRow>('SELECT id, round, candidate_id, tree_hash, provider, verdict, findings_json FROM reviews WHERE run_id = ? AND invalidated_at IS NULL ORDER BY round, rowid', runId)
    .filter((r) => tree === undefined || r.tree_hash === tree)
    .map((r) => ({ id: r.id, round: r.round, candidateId: r.candidate_id, treeHash: r.tree_hash, provider: r.provider, verdict: r.verdict, findings: safeParse<ReviewView['findings']>(r.findings_json, []) }));
  const decisions = listDecisions(db, runId);
  const denials: PolicyDenial[] = decisions
    .filter((d) => d.kind === 'policy.deny' || d.kind.startsWith('policy.deny.'))
    .map((d) => {
      const data = (d.data ?? {}) as Record<string, unknown>;
      const target = [data.target, data.path, data.command, data.host].find((v): v is string => typeof v === 'string') ?? null;
      return { rule: typeof data.rule === 'string' ? data.rule : d.kind, target };
    });
  return {
    runId,
    mode: run.mode as RunMode,
    contract: safeParse<GoalContract | null>(run.contract_json, null, 'CONTRACT_INVALID', `the contract of run ${runId}`),
    failures: listFailures(db, runId),
    evidence,
    reviews,
    denials,
    decisions: decisions.map((d) => ({ kind: d.kind, summary: d.summary })),
    expectedChangedFiles: extras.expectedChangedFiles ?? [],
    changedFiles: extras.changedFiles ?? [],
    diff: extras.diff ?? null,
    claims: extras.claims ?? null,
    sources: extras.sources ?? [],
    thresholds: { ...DEFAULT_THRESHOLDS, ...extras.thresholds },
  };
}

// ---------------------------------------------------------------------------

function trig(kind: TriggerKind, mode: InquisitionMode, summary: string, evidence: string[], subjects: string[], keyParts: unknown): Trigger {
  return { kind, mode, summary, evidence, subjects: [...new Set(subjects)].sort(), key: `${kind}:${hashObject(keyParts).slice(7, 19)}` };
}

const VAGUE_WORDS =
  /\b(improve[sd]?|better|faster|slower|nicer|cleaner|robust|user[- ]friendly|intuitive|seamless|properly|appropriately|as needed|as appropriate|etc|and so on|good|nice|easy|polish|clean ?up|optimi[sz]e[sd]?|enhance[sd]?|handle[sd]?|support[s]?)\b/i;
/** Markers of something a test can observe: numbers, quoted values, comparisons, concrete result verbs. */
const MEASURABLE =
  /\d|["'`]|[<>=]|\b(returns?|produces?|contains?|equals?|rejects?|displays?|includes?|persists?|emits?|responds?|renders?|raises?|throws?|creates?|deletes?|updates?|sends?|redirects?|preserves?|escapes?|matches|status code|error message|header|column|record|row|every|all)\b/i;
const NON_PROOF = /^\s*(works?|looks? good|manual(ly)?( verif\w*| test\w*)?|verified|done|tested|it works|n\/a|tbd|todo|ok|okay)\W*$/i;

function detectMissingOutcomes(s: InquisitionSnapshot): Trigger[] {
  const c = s.contract;
  if (!c) return [];
  const evidence: string[] = [];
  const subjects: string[] = [];
  if (c.acceptance_criteria.length === 0) evidence.push('the contract has no acceptance criteria');
  else if (!c.acceptance_criteria.some((a) => a.mandatory)) evidence.push('the contract has no mandatory criterion, so nothing is required to be true');
  for (const ac of c.acceptance_criteria) {
    const real = ac.proof.filter((p) => p.trim() !== '' && !NON_PROOF.test(p) && wordTokens(p).length >= 3);
    if (real.length === 0) {
      evidence.push(`${ac.id}: no testable proof entry`);
      subjects.push(ac.id);
    } else if (VAGUE_WORDS.test(ac.statement) && !MEASURABLE.test(ac.statement) && !real.some((p) => MEASURABLE.test(p))) {
      const word = ac.statement.match(VAGUE_WORDS)?.[0] ?? 'vague wording';
      evidence.push(`${ac.id}: vague wording ("${word}") with no measurable outcome in the statement or its proof`);
      subjects.push(ac.id);
    }
  }
  if (evidence.length === 0) return [];
  return [trig('missing_outcomes', 'clarify', 'acceptance criteria lack a measurable outcome', evidence, subjects, { evidence })];
}

function normSubject(text: string): string {
  return wordTokens(text).join(' ');
}

function detectContradictorySources(s: InquisitionSnapshot): Trigger[] {
  const bySubject = new Map<string, Map<string, { sources: string[]; raw: string }>>();
  for (const src of s.sources) {
    for (const claim of src.claims) {
      const subject = normSubject(claim.subject);
      const value = normSubject(claim.value);
      if (subject === '' || value === '') continue;
      const values = bySubject.get(subject) ?? new Map();
      const entry = values.get(value) ?? { sources: [], raw: claim.value };
      entry.sources.push(`${src.source} (${src.authority})`);
      values.set(value, entry);
      bySubject.set(subject, values);
    }
  }
  const out: Trigger[] = [];
  for (const [subject, values] of [...bySubject].sort(([a], [b]) => a.localeCompare(b))) {
    if (values.size < 2) continue;
    const parts = [...values.values()].map((v) => `${v.sources.join(', ')} say "${v.raw}"`);
    out.push(trig('contradictory_sources', 'reconcile', `sources disagree about ${subject}`, [`${subject}: ${parts.join('; ')}`], [], { subject, values: [...values.keys()].sort() }));
  }
  return out;
}

const PASSED = 'PASSED';

function mandatoryCriteria(c: GoalContract | null): GoalContract['acceptance_criteria'] {
  return c ? c.acceptance_criteria.filter((a) => a.mandatory) : [];
}

/** Mandatory criteria evidence has not established: missing entry, any status but supported, or "supported" with no artifact behind it. */
function unprovenCriteria(s: InquisitionSnapshot): { id: string; why: string }[] {
  const e = s.evidence;
  const out: { id: string; why: string }[] = [];
  for (const ac of mandatoryCriteria(s.contract)) {
    const entry = e?.acceptance.find((a) => a.criterion_id === ac.id);
    if (!entry) out.push({ id: ac.id, why: 'no evidence entry' });
    else if (entry.status !== 'supported') out.push({ id: ac.id, why: `status ${entry.status}` });
    else if (entry.artifacts.length === 0) out.push({ id: ac.id, why: 'marked supported with no artifact' });
  }
  return out;
}

function checksGreen(s: InquisitionSnapshot): boolean {
  const e = s.evidence;
  if (!e || e.checks.length === 0) return false;
  const required = new Set(s.contract?.required_check_ids ?? []);
  const relevant = required.size > 0 ? e.checks.filter((c) => required.has(c.id)) : e.checks;
  // A required check that never ran is not green; a flaky pass is disclosed, not clean.
  if (relevant.length === 0 || (required.size > 0 && [...required].some((id) => !e.checks.some((c) => c.id === id)))) return false;
  return relevant.every((c) => c.status === PASSED && !c.flaky);
}

function detectGreenWithoutProof(s: InquisitionSnapshot): Trigger[] {
  if (!s.evidence || !checksGreen(s)) return [];
  const unproven = unprovenCriteria(s);
  if (unproven.length === 0) return [];
  const evidence = [`verdict ${s.evidence.verdict} although every required check passed`, ...unproven.map((u) => `${u.id}: ${u.why}`)];
  return [trig('green_without_proof', 'challenge', 'checks are green but mandatory criteria are not proven', evidence, unproven.map((u) => u.id), { tree: s.evidence.treeHash, unproven })];
}

function detectOracleWeakening(s: InquisitionSnapshot): Trigger[] {
  const e = s.evidence;
  if (!e) return [];
  const evidence = [...e.weakeningSignals.map((w) => `${w.path}: ${w.signal}${w.detail ? ` (${w.detail})` : ''}`), ...e.visualBaselineChanges.map((p) => `${p}: visual baseline changed`)];
  if (evidence.length === 0) return [];
  return [trig('oracle_weakening', 'challenge', 'the candidate weakens its own tests or baselines', evidence, [], { tree: e.treeHash, evidence })];
}

/**
 * Failures recorded before any candidate exists: the base tree's own failures
 * (spec section 6 "record pre-existing failures") and a dependency install. They
 * have no candidate, so each row would count as a separate attempt and one
 * candidate failing the way the base already did would read as a repeat.
 */
const NOT_A_REPAIR_ATTEMPT: ReadonlySet<string> = new Set(['baseline', 'install']);

function detectRepeatedFailure(s: InquisitionSnapshot): Trigger[] {
  const out: Trigger[] = [];
  for (const [fingerprint, occ] of [...fingerprintOccurrences(s.failures.filter((f) => !NOT_A_REPAIR_ATTEMPT.has(f.source)))].sort(([a], [b]) => a.localeCompare(b))) {
    if (occ.candidates.length < s.thresholds.repeatedFailure) continue;
    const evidence = [`fingerprint ${fingerprint} on ${occ.candidates.length} distinct candidates`];
    if (occ.excerpt) evidence.push(`last excerpt: ${redact(occ.excerpt).slice(0, 200)}`);
    // The count is in the key: a further occurrence is a new condition worth a new look.
    out.push({ kind: 'repeated_failure', mode: 'diagnose', summary: `equivalent failure repeated ${occ.candidates.length} times`, evidence, subjects: [], key: `repeated_failure:${fingerprint}:${occ.candidates.length}` });
  }
  return out;
}

function detectUnexplainedArchitecture(s: InquisitionSnapshot): Trigger[] {
  if (s.changedFiles.length === 0 || s.expectedChangedFiles.length === 0) return [];
  const expected = new Set(s.expectedChangedFiles.map((p) => p.replace(/^\.\//, '')));
  const expectedDirs = new Set([...expected].map((p) => p.split('/')[0] ?? p));
  // New tests are asked for by the criteria themselves; weakening of old ones is its own trigger.
  const extra = s.changedFiles.filter((p) => !expected.has(p) && !isTestPath(p));
  if (extra.length <= s.thresholds.unexplainedFiles) return [];
  const newAreas = [...new Set(extra.map((p) => p.split('/')[0] ?? p))].filter((d) => !expectedDirs.has(d)).sort();
  const evidence = [`${extra.length} changed files are outside the planner's expected set (tolerated: ${s.thresholds.unexplainedFiles})`, ...extra.slice(0, 10)];
  if (newAreas.length > 0) evidence.push(`areas the plan never mentioned: ${newAreas.join(', ')}`);
  return [trig('unexplained_architecture', 'risk-review', 'the change reaches beyond what the plan explained', evidence, [], { extra: [...extra].sort() })];
}

function topicCovers(topic: string, category: RiskCategory): boolean {
  return topic.toLowerCase().includes(category) || riskCategoriesInText(topic).includes(category);
}

function detectHiddenDecisions(s: InquisitionSnapshot): Trigger[] {
  const out: Trigger[] = [];
  const c = s.contract;
  const open = c?.assumptions.filter((a) => a.status === 'needs-decision') ?? [];
  if (open.length > 0) {
    out.push(trig('hidden_decision', 'decision-record', 'assumptions are waiting for a decision', open.map((a) => `${a.id}: ${a.statement}`), [], { open: open.map((a) => a.id) }));
  }
  const fromPaths = riskCategoriesInPaths(s.changedFiles);
  const fromDiff = s.diff ? riskCategoriesInDiff(s.diff) : new Map<RiskCategory, string[]>();
  const contractText = c ? [c.objective, ...c.acceptance_criteria.flatMap((a) => [a.statement, ...a.proof]), ...c.non_goals, ...c.assumptions.map((a) => a.statement)].join('\n') : '';
  const stated = new Set(riskCategoriesInText(contractText));
  for (const cat of RISK_CATEGORIES) {
    const hits = [...(fromPaths.get(cat) ?? []).map((p) => `path ${p}`), ...(fromDiff.get(cat) ?? []).map((l) => `added: ${l}`)];
    if (hits.length === 0) continue;
    // The contract naming the area means someone decided it; a declared topic or a recorded decision means it was handled.
    if (stated.has(cat)) continue;
    if ((c?.escalation.material_topics ?? []).some((t) => topicCovers(t, cat))) continue;
    if (s.decisions.some((d) => d.kind.startsWith('inquisition.') && riskCategoriesInText(d.summary).includes(cat))) continue;
    out.push(trig('hidden_decision', 'risk-review', `the change touches ${cat} but the contract never mentions it`, hits.slice(0, 8), [], { cat, hits: hits.slice(0, 8) }));
  }
  return out;
}

function detectScopePressure(s: InquisitionSnapshot): Trigger[] {
  if (s.denials.length === 0) return [];
  const groups = new Map<string, number>();
  for (const d of s.denials) groups.set(`${d.rule} ${d.target ?? ''}`.trim(), (groups.get(`${d.rule} ${d.target ?? ''}`.trim()) ?? 0) + 1);
  const repeated = [...groups].filter(([, n]) => n >= 2);
  if (s.denials.length < s.thresholds.denials && repeated.length === 0) return [];
  const evidence = [`${s.denials.length} policy denials`, ...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} x${n}`)];
  return [trig('scope_pressure', 'risk-review', 'work keeps running into the authority boundary', evidence.slice(0, 12), [], { groups: [...groups].sort() })];
}

function detectUnsupportedConfidence(s: InquisitionSnapshot): Trigger[] {
  const claims = s.claims;
  if (!claims) return [];
  const e = s.evidence;
  const evidence: string[] = [];
  const subjects: string[] = [];
  for (const run of claims.checks_run) {
    if (run.claimed_result !== 'passed' || run.check_id === null) continue;
    const actual = e?.checks.find((c) => c.id === run.check_id);
    // Check ids and refs come from model output: redacted before they become evidence.
    const checkId = redact(run.check_id);
    if (!actual) evidence.push(`claims ${checkId} passed; the controller has no result for it${e ? '' : ' (no evidence yet)'}`);
    else if (actual.status !== PASSED) evidence.push(`claims ${checkId} passed; the controller recorded ${actual.status}`);
  }
  for (const ref of claims.evidence_refs) {
    if (ref.criterion_id === null) continue;
    // An optional criterion no check is mapped to (an amendment can add one) stays unverified whatever the tests do:
    // rejecting green over it only sends attempt after attempt at a status no stronger test can change (e2e Nm11).
    // The report already lists it as unverified, and it does not block the verdict.
    const criterion = s.contract?.acceptance_criteria.find((c) => c.id === ref.criterion_id);
    if (criterion && !criterion.mandatory && (criterion.check_ids ?? []).length === 0) continue;
    const entry = e?.acceptance.find((a) => a.criterion_id === ref.criterion_id);
    if (!entry || entry.status !== 'supported') {
      evidence.push(`claims evidence for ${ref.criterion_id} (${redact(ref.ref)}); the controller records ${entry ? entry.status : 'no entry'}`);
      subjects.push(ref.criterion_id);
    }
  }
  if (claims.next_action.kind === 'request-verification' && claims.tests_added.length === 0 && claims.evidence_refs.length === 0 && mandatoryCriteria(s.contract).length > 0) {
    evidence.push('requests verification with no tests added and no evidence offered');
  }
  if (evidence.length === 0) return [];
  return [trig('unsupported_confidence', 'challenge', 'the implementer claims more than the evidence shows', evidence, subjects, { evidence })];
}

function detectReviewerDisagreement(s: InquisitionSnapshot): Trigger[] {
  const out: Trigger[] = [];
  const byTree = new Map<string, ReviewView[]>();
  for (const r of s.reviews) byTree.set(r.treeHash, [...(byTree.get(r.treeHash) ?? []), r]);
  for (const [tree, reviews] of byTree) {
    // Latest verdict per provider for this exact tree.
    const latest = new Map<string, ReviewView>();
    for (const r of reviews) latest.set(r.provider, r);
    const verdicts = new Map<string, string[]>();
    for (const r of latest.values()) verdicts.set(r.verdict, [...(verdicts.get(r.verdict) ?? []), r.provider]);
    const approves = verdicts.has('APPROVE');
    const objects = [...verdicts.keys()].some((v) => v !== 'APPROVE');
    if (approves && objects) {
      out.push(trig('reviewer_disagreement', 'reconcile', 'reviewers disagree about the same tree', [...verdicts].map(([v, p]) => `${p.join(', ')}: ${v}`), [], { tree, kind: 'split' }));
    } else if (approves && s.evidence && s.evidence.treeHash === tree && s.evidence.verdict !== 'PASS') {
      out.push(trig('reviewer_disagreement', 'reconcile', 'a review approves a tree the evidence does not pass', [`review APPROVE; evidence verdict ${s.evidence.verdict}`], [], { tree, kind: 'evidence' }));
    }
  }
  return out;
}

/** Highest-stakes first: a controller that can only act on one inquiry at a time picks the head. */
const ORDER: readonly TriggerKind[] = [
  'oracle_weakening',
  'hidden_decision',
  'scope_pressure',
  'green_without_proof',
  'unsupported_confidence',
  'repeated_failure',
  'unexplained_architecture',
  'contradictory_sources',
  'reviewer_disagreement',
  'missing_outcomes',
];

export function detectTriggers(s: InquisitionSnapshot): Trigger[] {
  const all = [
    ...detectMissingOutcomes(s),
    ...detectContradictorySources(s),
    ...detectGreenWithoutProof(s),
    ...detectRepeatedFailure(s),
    ...detectUnexplainedArchitecture(s),
    ...detectHiddenDecisions(s),
    ...detectScopePressure(s),
    ...detectUnsupportedConfidence(s),
    ...detectOracleWeakening(s),
    ...detectReviewerDisagreement(s),
  ];
  return all.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

export interface ProofAdequacy {
  adequate: boolean;
  /** Triggers that make a green result untrustworthy. */
  triggers: Trigger[];
  /** Why proof is inadequate when no trigger says so (nothing current to judge). */
  reason?: string;
}

/** Trigger kinds whose presence means a green result must not count as completion (scenario 5). */
export const PROOF_BLOCKING_TRIGGERS: readonly TriggerKind[] = ['oracle_weakening', 'green_without_proof', 'unsupported_confidence'];

/**
 * Whether green checks may stand as proof. Weakened tests, unverified
 * mandatory criteria and unsupported claims each force challenge mode: the
 * verdict gate stays closed until the challenge produces disconfirming tests
 * that pass.
 */
export function proofAdequacy(s: InquisitionSnapshot): ProofAdequacy {
  const triggers = detectTriggers(s).filter((t) => PROOF_BLOCKING_TRIGGERS.includes(t.kind));
  // Absence of evidence is not adequate proof: with no current report (none yet, or only reports for another tree) nothing can have been shown.
  if (s.evidence === null) return { adequate: false, triggers, reason: 'no current evidence report exists for this candidate, so no check result can count as proof' };
  return { adequate: triggers.length === 0, triggers };
}

/** Group triggers into one inquiry per mode, in priority order of their first trigger. */
export function groupByMode(triggers: readonly Trigger[]): { mode: InquisitionMode; triggers: Trigger[] }[] {
  const out: { mode: InquisitionMode; triggers: Trigger[] }[] = [];
  for (const t of triggers) {
    const g = out.find((x) => x.mode === t.mode);
    if (g) g.triggers.push(t);
    else out.push({ mode: t.mode, triggers: [t] });
  }
  return out;
}
