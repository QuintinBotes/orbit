/**
 * Contract amendments (spec section 6 Amendments, and the invariant "no
 * model-authorized policy expansion"). Inquisition may clarify statements and
 * add derived criteria, proof and checks. It may not remove or weaken a
 * mandatory criterion or any proof, redefine success, widen allowed_paths,
 * relax delivery or resolve a needs-decision assumption on its own: those
 * need a human decision. Even with one, the result must stay inside the
 * frozen policy (scope, defined checks, merge permission), because a contract
 * can narrow policy but never extend it.
 *
 * Every applied amendment yields a ContractAmendment record with old and new
 * values, evidence, reason, the approval requirement and the verification it
 * invalidates.
 */
import { OrbitError } from '../core/errors.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import type { AcceptanceCriterion, ContractAmendment, GoalContract } from './types.ts';
import type { AmendmentChange, AmendmentProposal } from './amendment-types.ts';
import { containedInAny, normalizeGlob } from './globs.ts';
import { validateContract } from './validate.ts';
import { compareWording, normalizeEntry } from './wording.ts';

export type { AmendmentChange, AmendmentProposal } from './amendment-types.ts';

export interface AmendOptions {
  /** The run's frozen policy; scope, checks and merge permission are checked against it. */
  snapshot: PolicySnapshot;
  /**
   * Id of a recorded decision answered by a human. Only the controller sets
   * this, after confirming the decision's author; a model's proposal can
   * never carry its own approval.
   */
  approvedBy?: string | null;
  /** Passed through to validateContract. */
  policyHash?: string;
  /**
   * Records of the amendments already applied to this contract. A criterion
   * id is never issued twice in a run, even after its criterion was removed:
   * evidence, reviews and decisions refer to criteria by id, and a reused id
   * would let them speak for a different requirement.
   */
  history?: readonly ContractAmendment[];
}

export interface AmendmentAssessment {
  /** The contract as it would be after the change (not yet validated). */
  next: GoalContract;
  record: ContractAmendment;
  /** Why a human decision is required; empty when the change may apply directly. */
  approvalReasons: string[];
  /** Why the change can never apply, even with approval. */
  forbidden: string[];
}

export interface AmendResult {
  contract: GoalContract;
  record: ContractAmendment;
  approvedBy: string | null;
}

const DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Apply one amendment. Throws POLICY_DENIED when the change needs a human
 * decision that was not given, or exceeds the policy even with one (details
 * carry the would-be record so the caller can persist a decision request),
 * and CONTRACT_INVALID when the proposal is malformed or the result fails
 * contract validation.
 */
export function applyAmendment(contract: GoalContract, proposal: AmendmentProposal, opts: AmendOptions): AmendResult {
  const approvedBy = opts.approvedBy ?? null;
  if (approvedBy !== null && !DECISION_ID.test(approvedBy)) {
    throw new OrbitError('POLICY_DENIED', 'amendment approval must reference a recorded decision id');
  }
  const a = assessAmendment(contract, proposal, opts);
  if (a.forbidden.length > 0) {
    throw new OrbitError('POLICY_DENIED', `amendment exceeds the policy: ${a.forbidden.join('; ')}`, {
      record: a.record,
      forbidden: a.forbidden,
      approvalReasons: a.approvalReasons,
    });
  }
  if (a.approvalReasons.length > 0 && approvedBy === null) {
    throw new OrbitError('POLICY_DENIED', `amendment needs a human decision: ${a.approvalReasons.join('; ')}`, {
      record: a.record,
      approvalReasons: a.approvalReasons,
    });
  }
  const validated = validateContract(a.next, opts.snapshot, opts.policyHash === undefined ? {} : { policyHash: opts.policyHash });
  return { contract: validated, record: a.record, approvedBy };
}

/** Classify an amendment without applying it; throws CONTRACT_INVALID for malformed proposals. */
export function assessAmendment(contract: GoalContract, proposal: AmendmentProposal, opts: Pick<AmendOptions, 'snapshot' | 'history'>): AmendmentAssessment {
  if (!proposal || typeof proposal !== 'object' || !proposal.change || typeof proposal.change !== 'object') {
    invalid('amendment must have a change');
  }
  const evidence = text(proposal.evidence, 'evidence');
  const reason = text(proposal.reason, 'reason');
  const next = structuredClone(contract);
  const ctx: Ctx = { contract, next, snapshot: opts.snapshot, history: opts.history ?? [], approval: [], forbidden: [] };
  const change = applyChange(ctx, proposal.change);
  // Cloned so the record cannot change when either contract is later mutated.
  const record: ContractAmendment = {
    field: change.field,
    old_value: structuredClone(change.oldValue),
    new_value: structuredClone(change.newValue),
    evidence,
    reason,
    approval_required: ctx.approval.length > 0,
    affected_verification: change.affected,
  };
  return { next, record, approvalReasons: ctx.approval, forbidden: ctx.forbidden };
}

interface Ctx {
  contract: GoalContract;
  next: GoalContract;
  snapshot: PolicySnapshot;
  history: readonly ContractAmendment[];
  approval: string[];
  forbidden: string[];
}

interface Applied {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  affected: string[];
}

function invalid(message: string): never {
  throw new OrbitError('CONTRACT_INVALID', `amendment rejected: ${message}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${name} must be a non-empty string`);
  return value.trim();
}

function textList(values: unknown, name: string, minItems = 1): string[] {
  if (!Array.isArray(values)) invalid(`${name} must be a list`);
  const out: string[] = [];
  for (const v of values) {
    const t = text(v, name);
    if (!out.some((o) => normalizeEntry(o) === normalizeEntry(t))) out.push(t);
  }
  if (out.length < minItems) invalid(`${name} needs at least ${minItems} entr${minItems === 1 ? 'y' : 'ies'}`);
  return out;
}

function criterion(c: GoalContract, id: unknown): AcceptanceCriterion {
  const found = c.acceptance_criteria.find((ac) => ac.id === id);
  if (!found) invalid(`no criterion ${String(id)}`);
  return found;
}

function nextId(prefix: 'AC' | 'AS', ids: readonly string[]): string {
  let max = 0;
  for (const id of ids) {
    const m = new RegExp(`^${prefix}-([0-9]+)$`).exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

const CRITERION_ID = /^AC-[0-9]+$/;

/** Criterion ids a previous amendment created, changed or removed. */
function criterionIdsIn(history: readonly ContractAmendment[]): string[] {
  const ids: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === 'string' && CRITERION_ID.test(v)) ids.push(v);
    else if (v !== null && typeof v === 'object' && !Array.isArray(v)) collect((v as { id?: unknown }).id);
  };
  for (const record of history) {
    for (const a of record.affected_verification ?? []) collect(a);
    collect(record.old_value);
    collect(record.new_value);
  }
  return ids;
}

function checkDefined(ctx: Ctx, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ctx.snapshot.config.checks ?? {}, id);
}

function requireDefinedChecks(ctx: Ctx, ids: readonly string[]): void {
  for (const id of ids) {
    if (!checkDefined(ctx, id)) ctx.forbidden.push(`check "${id}" is not defined by the policy, and a contract cannot add check commands`);
  }
}

function noop(): never {
  invalid('the change does not alter the contract');
}

function applyChange(ctx: Ctx, change: AmendmentChange): Applied {
  const { contract, next } = ctx;
  switch (change.op) {
    case 'clarify_objective': {
      const objective = text(change.objective, 'objective');
      if (objective === contract.objective) noop();
      const verdict = compareWording(contract.objective, objective);
      if (!verdict.clarification) ctx.approval.push(`redefines the objective: ${verdict.reasons.join(', ')}`);
      next.objective = objective;
      return { field: 'objective', oldValue: contract.objective, newValue: objective, affected: [...contract.acceptance_criteria.map((ac) => ac.id), 'review'] };
    }

    case 'clarify_criterion': {
      const old = criterion(contract, change.criterion_id);
      const statement = text(change.statement, 'statement');
      if (statement === old.statement) noop();
      const verdict = compareWording(old.statement, statement);
      if (!verdict.clarification && old.mandatory) {
        ctx.approval.push(`weakens or redefines mandatory criterion ${old.id}: ${verdict.reasons.join(', ')}`);
      }
      criterion(next, old.id).statement = statement;
      return { field: `acceptance_criteria[${old.id}].statement`, oldValue: old.statement, newValue: statement, affected: [old.id] };
    }

    case 'add_criterion': {
      const statement = text(change.statement, 'statement');
      const proof = textList(change.proof, 'proof');
      const checkIds = uniqueIds(change.check_ids, 'check_ids', 0);
      if (typeof change.mandatory !== 'boolean' || typeof change.ui !== 'boolean') invalid('mandatory and ui must be booleans');
      requireDefinedChecks(ctx, checkIds);
      const id = nextId('AC', [...contract.acceptance_criteria.map((ac) => ac.id), ...criterionIdsIn(ctx.history)]);
      const added: AcceptanceCriterion = { id, statement, proof, mandatory: change.mandatory, ui: change.ui, check_ids: checkIds };
      next.acceptance_criteria.push(added);
      for (const cid of checkIds) if (!next.required_check_ids.includes(cid)) next.required_check_ids.push(cid);
      return { field: 'acceptance_criteria', oldValue: null, newValue: added, affected: [id, ...checkIds.map((c) => `check:${c}`)] };
    }

    case 'add_proof': {
      const old = criterion(contract, change.criterion_id);
      const have = new Set(old.proof.map(normalizeEntry));
      const fresh = textList(change.proof, 'proof').filter((p) => !have.has(normalizeEntry(p)));
      if (fresh.length === 0) noop();
      const target = criterion(next, old.id);
      target.proof = [...old.proof, ...fresh];
      return { field: `acceptance_criteria[${old.id}].proof`, oldValue: old.proof, newValue: target.proof, affected: [old.id] };
    }

    case 'replace_proof': {
      const old = criterion(contract, change.criterion_id);
      const proof = textList(change.proof, 'proof');
      if (proof.length === old.proof.length && proof.every((p, i) => p === old.proof[i])) noop();
      // Any proof entry that is not kept (verbatim or clarified) is a removal.
      old.proof.forEach((entry, i) => {
        if (!proof.some((p) => compareWording(entry, p).clarification)) {
          ctx.approval.push(`removes or weakens proof entry ${i + 1} of criterion ${old.id}`);
        }
      });
      criterion(next, old.id).proof = proof;
      return { field: `acceptance_criteria[${old.id}].proof`, oldValue: old.proof, newValue: proof, affected: [old.id] };
    }

    case 'set_mandatory': {
      const old = criterion(contract, change.criterion_id);
      if (typeof change.mandatory !== 'boolean') invalid('mandatory must be a boolean');
      if (change.mandatory === old.mandatory) noop();
      if (!change.mandatory) ctx.approval.push(`makes mandatory criterion ${old.id} optional`);
      criterion(next, old.id).mandatory = change.mandatory;
      return { field: `acceptance_criteria[${old.id}].mandatory`, oldValue: old.mandatory, newValue: change.mandatory, affected: [old.id] };
    }

    case 'remove_criterion': {
      const old = criterion(contract, change.criterion_id);
      // Removing any criterion removes its proof entries, so it is always weakening.
      ctx.approval.push(`removes ${old.mandatory ? 'mandatory ' : ''}criterion ${old.id} and its proof`);
      next.acceptance_criteria = next.acceptance_criteria.filter((ac) => ac.id !== old.id);
      return { field: 'acceptance_criteria', oldValue: old, newValue: null, affected: [old.id] };
    }

    case 'add_required_checks': {
      const ids = uniqueIds(change.check_ids, 'check_ids', 1);
      requireDefinedChecks(ctx, ids);
      const target = change.criterion_id === null ? null : criterion(next, change.criterion_id);
      const before = { required_check_ids: [...contract.required_check_ids], ...(target ? { check_ids: [...(target.check_ids ?? [])] } : {}) };
      let changed = false;
      for (const id of ids) {
        if (!next.required_check_ids.includes(id)) {
          next.required_check_ids.push(id);
          changed = true;
        }
        if (target && !(target.check_ids ?? []).includes(id)) {
          target.check_ids = [...(target.check_ids ?? []), id];
          changed = true;
        }
      }
      if (!changed) noop();
      const after = { required_check_ids: [...next.required_check_ids], ...(target ? { check_ids: [...(target.check_ids ?? [])] } : {}) };
      return {
        field: target ? `acceptance_criteria[${target.id}].check_ids` : 'required_check_ids',
        oldValue: before,
        newValue: after,
        affected: [...(target ? [target.id] : []), ...ids.map((c) => `check:${c}`)],
      };
    }

    case 'remove_required_checks': {
      const ids = uniqueIds(change.check_ids, 'check_ids', 1);
      const checks = ctx.snapshot.config.checks ?? {};
      if (change.criterion_id === null) {
        const removed = ids.filter((id) => contract.required_check_ids.includes(id));
        if (removed.length === 0) noop();
        for (const id of removed) {
          if (checks[id]?.mandatory) ctx.forbidden.push(`check "${id}" is mandatory in the policy and cannot be removed`);
        }
        ctx.approval.push(`removes required check${removed.length === 1 ? '' : 's'} ${removed.join(', ')}`);
        next.required_check_ids = next.required_check_ids.filter((id) => !removed.includes(id));
        const touched: string[] = [];
        for (const ac of next.acceptance_criteria) {
          if (ac.check_ids?.some((id) => removed.includes(id))) {
            ac.check_ids = ac.check_ids.filter((id) => !removed.includes(id));
            touched.push(ac.id);
          }
        }
        return { field: 'required_check_ids', oldValue: contract.required_check_ids, newValue: next.required_check_ids, affected: [...touched, ...removed.map((c) => `check:${c}`)] };
      }
      const old = criterion(contract, change.criterion_id);
      const removed = ids.filter((id) => (old.check_ids ?? []).includes(id));
      if (removed.length === 0) noop();
      ctx.approval.push(`removes check evidence ${removed.join(', ')} from criterion ${old.id}`);
      const target = criterion(next, old.id);
      target.check_ids = (target.check_ids ?? []).filter((id) => !removed.includes(id));
      return { field: `acceptance_criteria[${old.id}].check_ids`, oldValue: old.check_ids ?? [], newValue: target.check_ids, affected: [old.id] };
    }

    case 'set_allowed_paths': {
      if (!Array.isArray(change.allowed_paths) || change.allowed_paths.length === 0) invalid('allowed_paths must be a non-empty list');
      const globs: string[] = [];
      for (const raw of change.allowed_paths) {
        const g = typeof raw === 'string' ? normalizeGlob(raw) : null;
        if (g === null) {
          ctx.forbidden.push(`allowed path "${String(raw)}" uses glob syntax that cannot be checked against the policy scope`);
          continue;
        }
        if (!globs.includes(g)) globs.push(g);
      }
      const same = globs.length === contract.allowed_paths.length && globs.every((g) => contract.allowed_paths.includes(g));
      if (same && ctx.forbidden.length === 0) noop();
      const scope = ctx.snapshot.config.scope?.allowed_paths ?? [];
      for (const g of globs) {
        if (!containedInAny(g, contract.allowed_paths)) ctx.approval.push(`widens allowed_paths with "${g}"`);
        if (!containedInAny(g, scope)) ctx.forbidden.push(`allowed path "${g}" is outside the policy scope`);
      }
      next.allowed_paths = globs;
      return { field: 'allowed_paths', oldValue: contract.allowed_paths, newValue: globs, affected: ['scope'] };
    }

    case 'add_non_goal': {
      const goal = text(change.non_goal, 'non_goal');
      if (contract.non_goals.some((n) => normalizeEntry(n) === normalizeEntry(goal))) noop();
      // A new non-goal can exclude something a criterion needs, which redefines success.
      ctx.approval.push('adds a non-goal, which can redefine success');
      next.non_goals = [...contract.non_goals, goal];
      return { field: 'non_goals', oldValue: contract.non_goals, newValue: next.non_goals, affected: ['review'] };
    }

    case 'remove_non_goal': {
      const goal = text(change.non_goal, 'non_goal');
      const kept = contract.non_goals.filter((n) => normalizeEntry(n) !== normalizeEntry(goal));
      if (kept.length === contract.non_goals.length) invalid('no such non-goal');
      ctx.approval.push('removes a non-goal, which broadens the work');
      next.non_goals = kept;
      return { field: 'non_goals', oldValue: contract.non_goals, newValue: kept, affected: ['review'] };
    }

    case 'set_assumption': {
      const statement = text(change.statement, 'statement');
      const statuses = ['unverified', 'supported', 'rejected', 'needs-decision'];
      if (!statuses.includes(change.status)) invalid('unknown assumption status');
      if (change.assumption_id === null) {
        const id = nextId('AS', contract.assumptions.map((a) => a.id));
        const added = { id, statement, status: change.status };
        next.assumptions = [...contract.assumptions, added];
        return { field: 'assumptions', oldValue: null, newValue: added, affected: ['review'] };
      }
      const old = contract.assumptions.find((a) => a.id === change.assumption_id);
      if (!old) invalid(`no assumption ${String(change.assumption_id)}`);
      if (old.statement === statement && old.status === change.status) noop();
      // A needs-decision assumption is a material unknown; only a human settles it.
      if (old.status === 'needs-decision' && change.status !== 'needs-decision') {
        ctx.approval.push(`resolves needs-decision assumption ${old.id}`);
      }
      const updated = { id: old.id, statement, status: change.status };
      next.assumptions = next.assumptions.map((a) => (a.id === old.id ? updated : a));
      return { field: `assumptions[${old.id}]`, oldValue: old, newValue: updated, affected: ['review'] };
    }

    case 'add_escalation_topic': {
      const topic = text(change.topic, 'topic');
      if (contract.escalation.material_topics.some((t) => normalizeEntry(t) === normalizeEntry(topic))) noop();
      next.escalation.material_topics = [...contract.escalation.material_topics, topic];
      return { field: 'escalation.material_topics', oldValue: contract.escalation.material_topics, newValue: next.escalation.material_topics, affected: [] };
    }

    case 'remove_escalation_topic': {
      const topic = text(change.topic, 'topic');
      const kept = contract.escalation.material_topics.filter((t) => normalizeEntry(t) !== normalizeEntry(topic));
      if (kept.length === contract.escalation.material_topics.length) invalid('no such escalation topic');
      ctx.approval.push('removes an escalation topic, which lets the run guess where it had to ask');
      next.escalation.material_topics = kept;
      return { field: 'escalation.material_topics', oldValue: contract.escalation.material_topics, newValue: kept, affected: [] };
    }

    case 'set_delivery': {
      if (typeof change.draft_pr !== 'boolean' || typeof change.merge !== 'boolean') invalid('draft_pr and merge must be booleans');
      const old = contract.delivery;
      if (old.draft_pr === change.draft_pr && old.merge === change.merge) noop();
      const actions = ctx.snapshot.config.actions;
      if (change.merge && !old.merge) {
        ctx.approval.push('turns on merge');
        if (!actions?.merge) ctx.forbidden.push('the policy does not allow merge');
      }
      if (!change.draft_pr && old.draft_pr) ctx.approval.push('turns a draft pull request into a ready one');
      if (change.draft_pr && !old.draft_pr && (!actions?.open_pull_request || ctx.snapshot.config.delivery?.pull_request === 'none')) {
        ctx.forbidden.push('the policy does not allow opening a pull request');
      }
      next.delivery = { draft_pr: change.draft_pr, merge: change.merge };
      return { field: 'delivery', oldValue: old, newValue: next.delivery, affected: ['delivery'] };
    }

    default: {
      const op = (change as { op?: unknown }).op;
      return invalid(`unknown amendment operation ${JSON.stringify(op)}`);
    }
  }
}

function uniqueIds(values: unknown, name: string, minItems: number): string[] {
  if (!Array.isArray(values)) invalid(`${name} must be a list`);
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) invalid(`${name} entries must be check ids`);
    if (!out.includes(v)) out.push(v);
  }
  if (out.length < minItems) invalid(`${name} needs at least ${minItems} entr${minItems === 1 ? 'y' : 'ies'}`);
  return out;
}
