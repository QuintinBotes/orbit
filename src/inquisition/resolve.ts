import type { GoalContract } from '../contract/types.ts';
import type { AmendmentProposal } from '../contract/amendment-types.ts';
import type { OrbitConfig, RunMode } from '../policy/types.ts';
import { wordTokens } from '../contract/wording.ts';
import { mentionsIrreversible, riskCategoriesInText, type RiskCategory } from './heuristics.ts';
import { classifyQuestion, settles, validateQuestion, type AnsweredAsk, type QuestionClassification } from './questions.ts';
import type { InquisitorQuestion, Reversibility } from './types.ts';

/**
 * Autonomous resolution (spec section 10 "Autonomous resolution rules").
 *
 *   follow established conventions, with the evidence recorded
 *   choose and test reversible implementation details
 *   experiment on technical hypotheses
 *   never guess product semantics, security rules, financial effects or
 *   irreversible data behaviour: those become persisted questions
 *
 * `resolveAmbiguities` is a pure function from the ambiguities and the policy
 * to a plan; the controller (or engine.commitPlan) executes it. A material
 * question blocks only the criteria it affects, and anything depending on
 * them. Independent work continues; the run is BLOCKED only when nothing
 * independent remains (scenario 4). When in doubt the plan fails closed: an
 * ambiguity it cannot classify or a question too weak to ask still blocks the
 * criteria it touches, because the alternative is guessing.
 */

export type AmbiguityKind =
  | 'convention'
  | 'implementation-detail'
  | 'technical-hypothesis'
  | 'product-semantics'
  | 'security'
  | 'privacy'
  | 'financial'
  | 'data-irreversible'
  | 'compatibility'
  | 'unknown';

/** Kinds that are material whatever the worker called them. */
const MATERIAL_KINDS: ReadonlySet<AmbiguityKind> = new Set(['product-semantics', 'security', 'privacy', 'financial', 'data-irreversible', 'compatibility', 'unknown']);

export interface AmbiguityOption {
  label: string;
  description: string;
  consequences: string;
}

export interface Ambiguity {
  /** Stable within the run, so a retried resolution records one decision, not two. */
  id: string;
  description: string;
  kind: AmbiguityKind;
  /** What inspection found. */
  evidence: string[];
  reversibility: Reversibility;
  /** Criteria (AC-n) whose implementation or proof depends on the answer. */
  affects: string[];
  options?: AmbiguityOption[];
  /** The established practice being followed and where it is established. */
  convention?: { statement: string; evidence: string[] };
  /** The reversible option chosen and why. */
  choice?: { option: string; rationale: string };
  experiment?: { description: string; expectedObservation: string; authorization: string; discriminates?: string[] };
  /** A prepared question; used when the ambiguity is material. */
  question?: InquisitorQuestion;
  /** The choice changes behaviour users or callers can observe. */
  changesBehavior?: boolean;
}

export interface ResolveInput {
  ambiguities: readonly Ambiguity[];
  contract: GoalContract;
  mode: RunMode;
  policy: Pick<OrbitConfig, 'ambiguity'>;
  /** Check ids and action names an experiment may cite as its authorization. */
  authorizations: readonly string[];
  /** Criteria already proven; they are not "remaining work" for the independence test. */
  supportedCriteria?: readonly string[];
  /** Criterion -> criteria it builds on. A criterion depending on a blocked one is blocked too. */
  dependsOn?: Readonly<Record<string, readonly string[]>>;
  /** Criteria already blocked by questions that are still open. */
  alreadyBlocked?: readonly string[];
  /** Questions a person has already answered: asking one of them again would reopen what is settled. */
  answeredQuestions?: readonly AnsweredAsk[];
}

export interface PlannedDecision {
  ambiguityId: string;
  kind: 'inquisition.resolve';
  summary: string;
  data: {
    ambiguity_id: string;
    category: 'convention' | 'implementation-detail';
    choice: string;
    rationale: string;
    evidence: string[];
    reversibility: Reversibility;
    affects: string[];
  };
}

export interface PlannedExperiment {
  ambiguityId: string;
  /** pin-test: a test that locks the reversible choice in; technical: a discriminating experiment. */
  kind: 'pin-test' | 'technical';
  description: string;
  expectedObservation: string;
  authorization: string;
  discriminates: string[];
}

export interface PlannedQuestion {
  ambiguityId: string;
  question: InquisitorQuestion;
  classification: QuestionClassification;
  /** Criteria this question blocks while open. */
  blocks: string[];
}

export interface RejectedItem {
  ambiguityId: string;
  problems: string[];
  /** The criteria blocked anyway, because failing closed beats guessing. */
  blocks: string[];
}

export type Disposition =
  /** Nothing is blocked. */
  | 'continue'
  /** Some criteria are blocked on questions; independent criteria go on. */
  | 'continue-partial'
  /** Supervised and nothing independent remains: wait for the person. */
  | 'ask'
  /** Unattended and nothing independent remains: BLOCKED. */
  | 'block';

export interface ResolutionPlan {
  decisions: PlannedDecision[];
  experiments: PlannedExperiment[];
  questions: PlannedQuestion[];
  /** Ambiguities whose prepared question a person already answered: nothing is asked or blocked for them. */
  answered: { ambiguityId: string; question: string }[];
  /** Material or unclassifiable ambiguities whose question could not be asked as written. */
  rejected: RejectedItem[];
  /** Ambiguities the rules could not settle and that need more input (worker or person). */
  unresolved: { ambiguityId: string; reason: string }[];
  /** Pure additions (a pinning proof entry per decided criterion): they never need approval. */
  amendments: AmendmentProposal[];
  blockedCriteria: string[];
  /** Unblocked criteria that still have work to do. */
  continuingCriteria: string[];
  disposition: Disposition;
  reason: string;
}

export interface AmbiguityClassification {
  material: boolean;
  reasons: string[];
  categories: RiskCategory[];
}

const AC_ID = /^AC-[0-9]+$/;

function topicHit(topic: string, text: string): boolean {
  const need = wordTokens(topic).filter((t) => t.length > 2);
  if (need.length === 0) return false;
  const have = new Set(wordTokens(text));
  return need.every((t) => have.has(t));
}

/**
 * Material when the worker's own label says so, the effect is not reversible,
 * the text touches security, privacy, billing, data or compatibility, or the
 * contract lists the topic as material. Labels only ever upgrade: calling a
 * security rule an "implementation detail" does not make it one.
 */
export function classifyAmbiguity(a: Ambiguity, contract: GoalContract, policy: Pick<OrbitConfig, 'ambiguity'>): AmbiguityClassification {
  const reasons: string[] = [];
  const surface = [a.description, ...(a.options ?? []).flatMap((o) => [o.label, o.description, o.consequences]), ...a.evidence, a.choice?.rationale ?? ''].join('\n');
  // An experiment only observes; its text is not a decision about security or data.
  const categories = a.kind === 'technical-hypothesis' ? [] : riskCategoriesInText(surface);
  if (MATERIAL_KINDS.has(a.kind)) reasons.push(a.kind === 'unknown' ? 'its kind is unknown, so it cannot be treated as reversible' : `it concerns ${a.kind}`);
  if (a.kind !== 'technical-hypothesis' && a.reversibility !== 'reversible') reasons.push(`its effect is ${a.reversibility}`);
  if (categories.length > 0) reasons.push(`it touches ${categories.join(', ')}`);
  if (a.kind !== 'technical-hypothesis' && mentionsIrreversible(surface)) reasons.push('an option has irreversible effects');
  for (const topic of contract.escalation.material_topics) {
    if (topicHit(topic, surface)) reasons.push(`the contract lists "${topic}" as a material topic`);
  }
  if (policy.ambiguity.require_evidence_for_behavior_changes && a.changesBehavior === true && a.evidence.length === 0 && (a.convention?.evidence.length ?? 0) === 0) {
    reasons.push('it changes observable behaviour and nothing inspected supports the choice');
  }
  // `block_security_or_data_semantics: false` cannot loosen any of the above: the spec forbids guessing them.
  return { material: reasons.length > 0, reasons, categories };
}

/** Build a question from structured ambiguity data when the worker did not supply one. */
function synthesizeQuestion(a: Ambiguity): InquisitorQuestion | null {
  if (!a.options || a.options.length < 2 || !a.choice) return null;
  const text = a.description.trim().endsWith('?') ? a.description.trim() : `${a.description.trim().replace(/[.\s]+$/, '')}: which option applies?`;
  return {
    question: text,
    changes: ['implementation', 'proof'],
    evidence: a.evidence,
    options: a.options,
    recommendation: a.choice.option,
    recommendation_reason: a.choice.rationale,
    safe_default: { exists: false, option: null, reason: 'the choice is material, so proceeding without an answer would be a guess' },
    material: true,
    affected_work: [...a.affects],
    unblocked_work: [],
  };
}

function affectedCriteria(contract: GoalContract, ids: readonly string[]): string[] {
  const known = new Set(contract.acceptance_criteria.map((c) => c.id));
  return [...new Set(ids.filter((i) => AC_ID.test(i) && known.has(i)))];
}

/** Criteria that cannot proceed because they, or something they build on, are blocked. */
function closeOverDependencies(seed: readonly string[], dependsOn: Readonly<Record<string, readonly string[]>> | undefined, all: readonly string[]): string[] {
  const blocked = new Set(seed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of all) {
      if (blocked.has(id)) continue;
      if ((dependsOn?.[id] ?? []).some((d) => blocked.has(d))) {
        blocked.add(id);
        grew = true;
      }
    }
  }
  return [...blocked].sort();
}

export function resolveAmbiguities(input: ResolveInput): ResolutionPlan {
  const { contract, policy } = input;
  const allIds = contract.acceptance_criteria.map((c) => c.id);
  const decisions: PlannedDecision[] = [];
  const experiments: PlannedExperiment[] = [];
  const questions: PlannedQuestion[] = [];
  const rejected: RejectedItem[] = [];
  const answered: ResolutionPlan['answered'] = [];
  const unresolved: ResolutionPlan['unresolved'] = [];
  const amendments: AmendmentProposal[] = [];
  const seedBlocked = new Set<string>(input.alreadyBlocked ?? []);
  // An experiment is authorized only by name: a caller that passes nothing (a JavaScript caller, say) authorizes nothing rather than everything.
  const authorizations = new Set(input.authorizations ?? []);

  for (const a of input.ambiguities) {
    const affects = affectedCriteria(contract, a.affects);
    const cls = classifyAmbiguity(a, contract, policy);

    if (cls.material) {
      // Prepared question first, then one built from the options; either way it must pass question quality.
      const draft = a.question ?? synthesizeQuestion(a);
      if (draft && input.answeredQuestions?.some((a) => settles(a, draft))) {
        answered.push({ ambiguityId: a.id, question: draft.question });
        continue;
      }
      const check = draft ? validateQuestion(draft, { contract }) : { valid: false, problems: ['no question could be built: the ambiguity has neither a prepared question nor two options and a recommendation'] };
      let blocks = affects;
      if (draft) blocks = [...new Set([...affects, ...affectedCriteria(contract, draft.affected_work)])];
      // A material ambiguity that names no criterion could touch any of them.
      if (blocks.length === 0) blocks = [...allIds];
      blocks.forEach((b) => seedBlocked.add(b));
      if (draft && check.valid) questions.push({ ambiguityId: a.id, question: draft, classification: classifyQuestion(draft, { contract }), blocks });
      else rejected.push({ ambiguityId: a.id, problems: check.problems, blocks });
      continue;
    }

    if (a.kind === 'technical-hypothesis') {
      const e = a.experiment;
      if (!e) {
        unresolved.push({ ambiguityId: a.id, reason: 'a technical hypothesis needs a discriminating experiment' });
        affects.forEach((b) => seedBlocked.add(b));
      } else if (!authorizations.has(e.authorization)) {
        unresolved.push({ ambiguityId: a.id, reason: `experiment authorization "${e.authorization}" is not a defined check or enabled action` });
        affects.forEach((b) => seedBlocked.add(b));
      } else {
        experiments.push({ ambiguityId: a.id, kind: 'technical', description: e.description, expectedObservation: e.expectedObservation, authorization: e.authorization, discriminates: e.discriminates ?? [] });
      }
      continue;
    }

    // From here the ambiguity is a reversible convention or implementation detail.
    if (!policy.ambiguity.resolve_reversible_choices) {
      // Policy asks before any choice: the question is non-material but still blocks what it touches.
      const draft = a.question ?? synthesizeQuestion(a);
      if (draft && input.answeredQuestions?.some((a) => settles(a, draft))) {
        answered.push({ ambiguityId: a.id, question: draft.question });
        continue;
      }
      const ok = draft ? validateQuestion(draft, { contract }) : null;
      const blocks = affects.length > 0 ? affects : [...allIds];
      blocks.forEach((b) => seedBlocked.add(b));
      if (draft && ok?.valid) questions.push({ ambiguityId: a.id, question: draft, classification: classifyQuestion(draft, { contract }), blocks });
      else rejected.push({ ambiguityId: a.id, problems: ok?.problems ?? ['policy requires asking before choosing, and no question could be built'], blocks });
      continue;
    }

    const conventionEvidence = a.convention?.evidence.filter((e) => e.trim() !== '') ?? [];
    const followsConvention = a.kind === 'convention' && conventionEvidence.length > 0;
    const choice = followsConvention ? { option: a.convention!.statement, rationale: `established convention: ${a.convention!.statement}` } : a.choice;
    if (!choice || !choice.option.trim()) {
      unresolved.push({ ambiguityId: a.id, reason: a.kind === 'convention' ? 'no recorded evidence establishes the convention, and no reversible choice was named' : 'no reversible choice was named' });
      affects.forEach((b) => seedBlocked.add(b));
      continue;
    }
    const evidence = followsConvention ? conventionEvidence : a.evidence;
    decisions.push({
      ambiguityId: a.id,
      kind: 'inquisition.resolve',
      summary: `${followsConvention ? 'followed convention' : 'chose reversible detail'}: ${a.description.trim()} -> ${choice.option.trim()}`,
      data: {
        ambiguity_id: a.id,
        category: followsConvention ? 'convention' : 'implementation-detail',
        choice: choice.option.trim(),
        rationale: choice.rationale.trim(),
        evidence,
        reversibility: a.reversibility,
        affects,
      },
    });
    // "Choose and test": the choice is pinned by a test, and the criterion's proof says so.
    experiments.push({
      ambiguityId: a.id,
      kind: 'pin-test',
      description: `Add a test that pins the chosen behaviour: ${choice.option.trim()}`,
      expectedObservation: `The test passes with the choice in place and fails if it is reverted.`,
      authorization: 'test',
      discriminates: [],
    });
    for (const id of affects) {
      amendments.push({
        change: { op: 'add_proof', criterion_id: id, proof: [`A test pins the decision "${choice.option.trim()}" for: ${a.description.trim()}`] },
        evidence: evidence.join('; ') || a.description,
        reason: 'a reversible choice is recorded as a decision and pinned by a test, so reversing it later is deliberate',
      });
    }
  }

  let blocking = blockingDisposition({ blocked: [...seedBlocked], contract, mode: input.mode, supportedCriteria: input.supportedCriteria, dependsOn: input.dependsOn });
  // A contract with no criteria gives an unresolved question nothing to block, which must not read as "nothing is blocked".
  if (allIds.length === 0 && (questions.length > 0 || rejected.length > 0 || unresolved.length > 0)) {
    const unattended = input.mode !== 'supervised';
    blocking = { ...blocking, disposition: unattended ? 'block' : 'ask', reason: `a decision is outstanding and the contract has no criteria to carry on with` };
  }
  return { decisions, experiments, questions, answered, rejected, unresolved, amendments, ...blocking };
}

export interface BlockingInput {
  /** Criteria blocked directly. */
  blocked: readonly string[];
  contract: GoalContract;
  mode: RunMode;
  supportedCriteria?: readonly string[];
  dependsOn?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Scenario 4 in one function: blocked criteria and everything built on them
 * stop; everything else carries on. Only when nothing independent is left does
 * an unattended run become BLOCKED (a supervised one waits for the person).
 */
export function blockingDisposition(input: BlockingInput): Pick<ResolutionPlan, 'blockedCriteria' | 'continuingCriteria' | 'disposition' | 'reason'> {
  const allIds = input.contract.acceptance_criteria.map((c) => c.id);
  const blockedCriteria = closeOverDependencies(input.blocked, input.dependsOn, allIds);
  const done = new Set(input.supportedCriteria ?? []);
  const continuingCriteria = allIds.filter((id) => !blockedCriteria.includes(id) && !done.has(id));
  const unattended = input.mode !== 'supervised';
  if (blockedCriteria.length === 0) return { blockedCriteria, continuingCriteria, disposition: 'continue', reason: 'nothing is blocked' };
  if (continuingCriteria.length > 0) {
    return { blockedCriteria, continuingCriteria, disposition: 'continue-partial', reason: `${blockedCriteria.join(', ')} wait for a decision; ${continuingCriteria.join(', ')} are independent and continue` };
  }
  return unattended
    ? { blockedCriteria, continuingCriteria, disposition: 'block', reason: `${blockedCriteria.join(', ')} wait for a decision and no independent work remains` }
    : { blockedCriteria, continuingCriteria, disposition: 'ask', reason: `${blockedCriteria.join(', ')} wait for the person's decision and no independent work remains` };
}

/** Check ids and enabled actions: what an experiment may name as its authorization. */
export function authorizationIds(config: Pick<OrbitConfig, 'checks' | 'actions'>): string[] {
  return [...Object.keys(config.checks), ...Object.entries(config.actions).filter(([, on]) => on).map(([k]) => k)];
}
