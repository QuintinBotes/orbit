/**
 * Contract validation (spec section 6, gate "Intake"). A contract is accepted
 * only when it matches schemas/contract.schema.json and agrees with the
 * frozen policy snapshot it claims to be bound to. Every problem is collected
 * before failing, so one CONTRACT_INVALID error explains the whole contract
 * rather than the first mistake.
 */
import contractSchema from '../../schemas/contract.schema.json' with { type: 'json' };
import { OrbitError } from '../core/errors.ts';
import { hashObject } from '../core/hash.ts';
import type { GoalContract } from './types.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import { containedInAny, globsMayOverlap, isAnalysableGlob } from './globs.ts';
import { validateAgainst } from './json-schema.ts';

export interface ContractCheckOptions {
  /**
   * Hash the contract must carry. Defaults to the canonical hash of the
   * snapshot object; pass the run's recorded policy hash when the snapshot
   * is hashed differently.
   */
  policyHash?: string;
}

/** The hash a contract bound to `snapshot` must carry. */
export function policyHashOf(snapshot: PolicySnapshot): string {
  return hashObject(snapshot);
}

/** All problems with `contract` against `snapshot`; empty when it is valid. */
export function contractProblems(contract: unknown, snapshot: PolicySnapshot, opts: ContractCheckOptions = {}): string[] {
  const res = validateAgainst<GoalContract>(contractSchema, contract);
  // Cross-checks assume the schema's shape, so a malformed contract reports
  // only its schema errors.
  if (!res.ok) return res.errors.map((e) => `schema: ${e}`);
  return crossCheck(res.value, snapshot, opts.policyHash ?? policyHashOf(snapshot));
}

/** Validate and return the contract typed; throws CONTRACT_INVALID listing every problem. */
export function validateContract(contract: unknown, snapshot: PolicySnapshot, opts: ContractCheckOptions = {}): GoalContract {
  const problems = contractProblems(contract, snapshot, opts);
  if (problems.length > 0) {
    throw new OrbitError('CONTRACT_INVALID', `goal contract is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'}): ${problems.join('; ')}`, {
      problems,
    });
  }
  return contract as GoalContract;
}

function crossCheck(c: GoalContract, snapshot: PolicySnapshot, expectedHash: string): string[] {
  const problems: string[] = [];
  const config = snapshot.config;
  const checks = config.checks ?? {};
  const isCheck = (id: string) => Object.prototype.hasOwnProperty.call(checks, id);

  if (c.policy_hash !== expectedHash) problems.push('policy_hash does not match the frozen policy snapshot');

  const seenCriteria = new Set<string>();
  for (const ac of c.acceptance_criteria) {
    if (seenCriteria.has(ac.id)) problems.push(`criterion id ${ac.id} is used more than once`);
    seenCriteria.add(ac.id);
    if (ac.statement.trim() === '') problems.push(`criterion ${ac.id} has an empty statement`);
    if (ac.mandatory && !ac.proof.some((p) => p.trim() !== '')) problems.push(`mandatory criterion ${ac.id} has no proof`);
    for (const id of ac.check_ids ?? []) {
      if (!isCheck(id)) problems.push(`criterion ${ac.id} cites check "${id}", which the policy does not define`);
      else if (!c.required_check_ids.includes(id)) problems.push(`criterion ${ac.id} cites check "${id}", which is not in required_check_ids`);
    }
  }
  if (!c.acceptance_criteria.some((ac) => ac.mandatory)) problems.push('at least one acceptance criterion must be mandatory');

  const seenAssumptions = new Set<string>();
  for (const a of c.assumptions) {
    if (seenAssumptions.has(a.id)) problems.push(`assumption id ${a.id} is used more than once`);
    seenAssumptions.add(a.id);
  }

  // An exception excuses one required check's pre-existing failure; one for any other check could never be consulted.
  const seenExceptions = new Set<string>();
  for (const e of c.baseline_exceptions ?? []) {
    if (!c.required_check_ids.includes(e.check_id)) problems.push(`baseline exception for check "${e.check_id}", which is not in required_check_ids`);
    if (seenExceptions.has(e.check_id)) problems.push(`check "${e.check_id}" has more than one baseline exception`);
    seenExceptions.add(e.check_id);
  }

  for (const id of c.required_check_ids) {
    if (!isCheck(id)) problems.push(`required check "${id}" is not defined by the policy`);
  }
  // A contract cannot opt out of a check the policy marks mandatory.
  for (const [id, def] of Object.entries(checks)) {
    if (def.mandatory && !c.required_check_ids.includes(id)) problems.push(`policy check "${id}" is mandatory but not in required_check_ids`);
  }

  const scope = config.scope?.allowed_paths ?? [];
  c.allowed_paths.forEach((glob, i) => {
    if (!isAnalysableGlob(glob)) {
      problems.push(`allowed_paths[${i}] "${glob}" uses glob syntax that cannot be checked against the policy scope`);
    } else if (!containedInAny(glob, scope)) {
      problems.push(`allowed_paths[${i}] "${glob}" is not contained in the policy scope`);
    }
  });

  const ui = config.ui;
  const uiCriteria = c.acceptance_criteria.filter((ac) => ac.ui === true);
  // Only a mandatory criterion needs evidence before completion, so an
  // optional ui criterion would make the policy's required UI evidence optional.
  if (ui && ui.required_when_ui_changes && !uiCriteria.some((ac) => ac.mandatory)) {
    const touchesUi = c.allowed_paths.some((p) => ui.ui_paths.some((u) => globsMayOverlap(p, u)));
    if (touchesUi) problems.push('allowed_paths can change UI paths and the policy requires UI evidence, but no mandatory criterion is marked ui');
  }
  if (!ui) {
    for (const ac of uiCriteria) {
      if (ac.mandatory) problems.push(`mandatory criterion ${ac.id} needs browser evidence, but the policy has no ui configuration`);
    }
  }

  if (c.delivery.merge && !config.actions?.merge) problems.push('delivery.merge is true but the policy does not allow merge');
  if (c.delivery.draft_pr && (!config.actions?.open_pull_request || config.delivery?.pull_request === 'none')) {
    problems.push('delivery.draft_pr is true but the policy does not allow opening a pull request');
  }

  return problems;
}
