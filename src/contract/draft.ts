/**
 * Contract creation (spec section 6, state CONTRACTING). The planner model
 * proposes the objective, criteria, proof, scope and checks; the controller
 * fixes everything that carries authority: criterion and assumption ids, the
 * policy hash, the baseline revision, the delivery target, and the edit scope
 * (intersected with the policy scope, never widened). Check ids the policy
 * does not define are dropped with a recorded reason, because a contract can
 * only name trusted checks, never introduce commands.
 *
 * The result is a pure function of its inputs, so re-running a crashed
 * CONTRACTING step produces the same contract.
 */
import { OrbitError } from '../core/errors.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import type { AcceptanceCriterion, ContractAssumption, GoalContract } from './types.ts';
import { reconcileAuthority } from './authority.ts';
import { intersectWithScope, literalGlob, normalizeGlob } from './globs.ts';
import { validateModelOutput, type PlannerOutput } from './model-outputs.ts';
import { policyHashOf, validateContract } from './validate.ts';
import { normalizePractices, type PracticeSelection } from './practices.ts';
import { normalizeEntry } from './wording.ts';

export interface DraftContractInput {
  /** The user's goal, verbatim. */
  goal: string;
  /** Planner result; validated against planner-output.schema.json here. */
  plannerOutput: unknown;
  snapshot: PolicySnapshot;
  baselineRevision: string;
  taskId: string;
  /** Hash to bind; defaults to the canonical hash of `snapshot`. */
  policyHash?: string;
}

export type DraftAdjustmentKind = 'check-dropped' | 'check-added' | 'path-dropped' | 'path-narrowed' | 'path-added' | 'topic-added' | 'decision-recorded' | 'authority-mismatch' | 'practice-selected';

/** A change the controller made to the planner's proposal, with its reason. */
export interface DraftAdjustment {
  kind: DraftAdjustmentKind;
  subject: string;
  reason: string;
}

export interface DraftResult {
  contract: GoalContract;
  adjustments: DraftAdjustment[];
}

/**
 * Topics on which spec section 10 forbids guessing, whatever the planner
 * listed: they always escalate.
 */
export const BASELINE_MATERIAL_TOPICS: readonly string[] = [
  'product semantics',
  'security rules',
  'financial effects',
  'irreversible data behavior',
];

export function draftContract(input: DraftContractInput): DraftResult {
  const plan: PlannerOutput = validateModelOutput('planner', input.plannerOutput);
  const { snapshot } = input;
  const config = snapshot.config;
  const checks = config.checks ?? {};
  const isCheck = (id: string) => Object.prototype.hasOwnProperty.call(checks, id);
  const adjustments: DraftAdjustment[] = [];
  const dropCheck = (id: string, where: string) => {
    if (!adjustments.some((a) => a.kind === 'check-dropped' && a.subject === id)) {
      adjustments.push({ kind: 'check-dropped', subject: id, reason: `${where} names check "${id}", which the policy does not define` });
    }
  };

  const criteria: AcceptanceCriterion[] = plan.criteria.map((c, i) => {
    const checkIds: string[] = [];
    for (const id of c.check_ids) {
      if (!isCheck(id)) dropCheck(id, `criterion ${c.key}`);
      else if (!checkIds.includes(id)) checkIds.push(id);
    }
    return {
      id: `AC-${i + 1}`,
      statement: c.statement.trim(),
      proof: uniqueText(c.proof),
      mandatory: c.mandatory,
      ui: c.ui,
      check_ids: checkIds,
    };
  });

  const required: string[] = [];
  for (const id of plan.required_check_ids) {
    if (!isCheck(id)) dropCheck(id, 'required_check_ids');
    else if (!required.includes(id)) required.push(id);
  }
  for (const ac of criteria) {
    for (const id of ac.check_ids ?? []) {
      if (!required.includes(id)) {
        required.push(id);
        adjustments.push({ kind: 'check-added', subject: id, reason: `criterion ${ac.id} cites it as evidence` });
      }
    }
  }
  for (const id of Object.keys(checks).sort()) {
    if (checks[id]?.mandatory && !required.includes(id)) {
      required.push(id);
      adjustments.push({ kind: 'check-added', subject: id, reason: 'the policy marks it mandatory' });
    }
  }

  const scope = config.scope?.allowed_paths ?? [];
  const allowed: string[] = [];
  const keep = (g: string) => {
    if (!allowed.includes(g)) allowed.push(g);
  };
  for (const proposed of plan.allowed_paths) {
    const inside = intersectWithScope(proposed, scope);
    const normalized = normalizeGlob(proposed);
    if (inside.length === 0) {
      adjustments.push({ kind: 'path-dropped', subject: proposed, reason: normalized === null ? 'glob syntax cannot be checked against the policy scope' : 'not inside the policy scope' });
    } else if (inside.length === 1 && inside[0] === normalized) {
      keep(normalized);
    } else {
      inside.forEach(keep);
      adjustments.push({ kind: 'path-narrowed', subject: proposed, reason: `narrowed to the policy scope: ${inside.join(', ')}` });
    }
  }
  if (allowed.length === 0) {
    // The planner's globs missed the scope entirely; fall back to the exact
    // files it expects to change, where those are inside the scope.
    for (const f of plan.expected_changed_files) {
      const g = literalGlob(f.path);
      if (g !== null && intersectWithScope(g, scope).includes(g)) {
        if (!allowed.includes(g)) adjustments.push({ kind: 'path-added', subject: g, reason: 'expected changed file inside the policy scope' });
        keep(g);
      }
    }
  }
  if (allowed.length === 0) {
    throw new OrbitError('CONTRACT_INVALID', 'no proposed path lies inside the policy scope', { adjustments });
  }

  const assumptions: ContractAssumption[] = plan.assumptions.map((a, i) => ({
    id: `AS-${i + 1}`,
    statement: a.statement.trim(),
    status: a.status,
  }));
  // A material question the planner could not answer must not vanish with
  // the planner output: as a needs-decision assumption it stays visible to
  // review, and amend.ts lets only a human decision settle it.
  for (const d of plan.unresolved_decisions) {
    const statement = d.question.trim();
    if (!d.material || statement === '') continue;
    const same = assumptions.find((a) => normalizeEntry(a.statement) === normalizeEntry(statement));
    const target = same ?? { id: `AS-${assumptions.length + 1}`, statement, status: 'needs-decision' as const };
    if (same) same.status = 'needs-decision';
    else assumptions.push(target);
    adjustments.push({ kind: 'decision-recorded', subject: target.id, reason: 'the planner left a material decision unresolved' });
  }

  // Authority written in the goal never grants anything. Where the prose and the frozen policy disagree it is
  // recorded, and a request for more than the policy allows becomes a needs-decision assumption, which sends
  // the run to a clarify inquiry (a human confirms that the policy governs) instead of leaving the gap unseen.
  for (const m of reconcileAuthority(input.goal, config)) {
    adjustments.push({ kind: 'authority-mismatch', subject: m.subject, reason: `${m.detail} (goal text: "${m.phrase}")` });
    if (m.kind !== 'exceeds-policy') continue;
    const statement = `The goal asks for more authority than the policy grants (${m.subject}: "${m.phrase}"). Confirm that the policy governs, or change the policy and start a new run.`;
    if (!assumptions.some((a) => normalizeEntry(a.statement) === normalizeEntry(statement))) {
      assumptions.push({ id: `AS-${assumptions.length + 1}`, statement, status: 'needs-decision' });
    }
  }

  const topics = uniqueText(plan.material_topics);
  for (const t of BASELINE_MATERIAL_TOPICS) {
    if (!topics.some((x) => normalizeEntry(x) === normalizeEntry(t))) {
      topics.push(t);
      adjustments.push({ kind: 'topic-added', subject: t, reason: 'spec section 10 forbids guessing it' });
    }
  }

  // Spec section 5: practices are selected per task and omissions justified. The planner's selection is kept as it
  // stands, except that UI work always gets accessibility: leaving it out for a criterion the contract itself marks
  // as UI is not a judgement the planner can make.
  const practices: PracticeSelection[] = normalizePractices(plan.practices);
  const uiCriteria = criteria.filter((c) => c.ui === true).map((c) => c.id);
  const access = practices.find((p) => p.practice === 'accessibility');
  if (access && !access.applicable && uiCriteria.length > 0) {
    access.applicable = true;
    access.justification = `the contract has UI criteria (${uiCriteria.join(', ')}); the planner's reason for omitting it was: ${access.justification}`;
    adjustments.push({ kind: 'practice-selected', subject: 'accessibility', reason: `the planner omitted it, but ${uiCriteria.join(', ')} ${uiCriteria.length === 1 ? 'is a UI criterion' : 'are UI criteria'}` });
  }

  const actions = config.actions;
  const contract: GoalContract = {
    version: '1.0',
    task_id: input.taskId,
    original_goal: input.goal,
    objective: plan.objective.trim(),
    acceptance_criteria: criteria,
    non_goals: uniqueText(plan.non_goals),
    allowed_paths: allowed,
    required_check_ids: required,
    assumptions,
    practices,
    delivery: {
      draft_pr: Boolean(actions?.open_pull_request) && config.delivery?.pull_request === 'draft',
      // Merge is opt-in per run even when the policy permits it; only an
      // approved amendment turns it on.
      merge: false,
    },
    policy_hash: input.policyHash ?? policyHashOf(snapshot),
    baseline_revision: input.baselineRevision,
    escalation: { material_topics: topics },
  };

  const validated = validateContract(contract, snapshot, input.policyHash === undefined ? {} : { policyHash: input.policyHash });
  return { contract: validated, adjustments };
}

/** Trimmed, non-blank, de-duplicated by normalized wording, original order kept. */
function uniqueText(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = v.trim();
    const key = normalizeEntry(t);
    if (t === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
