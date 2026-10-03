/**
 * The goal contract (spec §6). Mirrors schemas/contract.schema.json, which is
 * the authority: model-produced contracts are validated against the schema
 * before any field is trusted.
 *
 * A contract never carries executable commands. `required_check_ids` names
 * checks defined in trusted configuration; a check id the policy does not
 * define makes the contract invalid.
 */
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
  delivery: { draft_pr: boolean; merge: boolean };
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
