/**
 * The goal contract (spec §6). Mirrors schemas/contract.schema.json, which is
 * the authority: model-produced contracts are validated against the schema
 * before any field is trusted.
 *
 * A contract never carries executable commands. `required_check_ids` names
 * checks defined in trusted configuration; a check id the policy does not
 * define makes the contract invalid.
 */
import type { PracticeSelection } from './practices.ts';

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  /** How the criterion will be proven: tests, journeys, artifacts. */
  proof: string[];
  mandatory: boolean;
  /** Criterion is about user-visible UI behaviour and needs browser evidence. */
  ui?: boolean;
  /** Check ids whose passing result counts as evidence for this criterion. */
  check_ids?: string[];
}

export interface ContractAssumption {
  id: string;
  statement: string;
  status: 'unverified' | 'supported' | 'rejected' | 'needs-decision';
}

/**
 * A failure that already exists on the base revision and that the contract
 * accepts. It applies only while the failing check still produces exactly the
 * recorded fingerprint, so a different breakage of the same check is never
 * excused by it.
 */
export interface BaselineException {
  /** Must be one of the contract's required_check_ids. */
  check_id: string;
  /** Failure fingerprint recorded from the base revision (see evidence/fingerprint.ts). */
  fingerprint: string;
  reason: string;
}

export interface GoalContract {
  version: '1.0';
  task_id: string;
  original_goal: string;
  objective: string;
  acceptance_criteria: AcceptanceCriterion[];
  non_goals: string[];
  /** Must be a subset of the policy's scope.allowed_paths. */
  allowed_paths: string[];
  required_check_ids: string[];
  assumptions: ContractAssumption[];
  /**
   * The planner's selection of engineering practices (spec section 5), one entry per practice: applicable, or
   * omitted with its reason. Absent on a contract created before the selection existed; every new contract has it.
   */
  practices?: PracticeSelection[];
  /** Optional: documented pre-existing failures the evidence report may accept. */
  baseline_exceptions?: BaselineException[];
  delivery: {
    draft_pr: boolean;
    merge: boolean;
    /**
     * Optional: the one release environment this run deploys to (a key of the policy's `release.environments`, set by
     * `orbit run --environment`). Absent, release mode deploys every defined environment the deployed branch is allowed for.
     */
    environment?: string;
  };
  /** Filled at run start from the policy snapshot. */
  policy_hash: string;
  baseline_revision: string;
  escalation: {
    /** Ask (supervised) or block (unattended) instead of guessing these. */
    material_topics: string[];
  };
}

/** Recorded change to a contract (spec §6 Amendments). */
export interface ContractAmendment {
  field: string;
  old_value: unknown;
  new_value: unknown;
  evidence: string;
  reason: string;
  approval_required: boolean;
  affected_verification: string[];
}
