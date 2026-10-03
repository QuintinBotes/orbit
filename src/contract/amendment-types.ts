/**
 * Proposed contract amendments (spec section 6 Amendments). The inquisitor
 * proposes them in this shape (schemas/inquisitor-output.schema.json,
 * `amendments[].change`); `applyAmendment` decides whether each one may
 * apply directly, needs a human decision, or is never allowed.
 *
 * Changes are typed operations rather than free-form field patches so that
 * every operation has one meaning the controller can classify: a patch that
 * replaced a whole criterion list would hide a removal inside a rewrite.
 */
export type AssumptionStatusValue = 'unverified' | 'supported' | 'rejected' | 'needs-decision';

export type AmendmentChange =
  | { op: 'clarify_objective'; objective: string }
  | { op: 'clarify_criterion'; criterion_id: string; statement: string }
  | { op: 'add_criterion'; statement: string; proof: string[]; mandatory: boolean; ui: boolean; check_ids: string[] }
  | { op: 'add_proof'; criterion_id: string; proof: string[] }
  | { op: 'replace_proof'; criterion_id: string; proof: string[] }
  | { op: 'set_mandatory'; criterion_id: string; mandatory: boolean }
  | { op: 'remove_criterion'; criterion_id: string }
  /** criterion_id null: the contract's required checks only; otherwise also that criterion's check_ids. */
  | { op: 'add_required_checks'; criterion_id: string | null; check_ids: string[] }
  /** criterion_id null: remove from required checks and every criterion; otherwise from that criterion only. */
  | { op: 'remove_required_checks'; criterion_id: string | null; check_ids: string[] }
  | { op: 'set_allowed_paths'; allowed_paths: string[] }
  | { op: 'add_non_goal'; non_goal: string }
  | { op: 'remove_non_goal'; non_goal: string }
  /** assumption_id null adds a new assumption. */
  | { op: 'set_assumption'; assumption_id: string | null; statement: string; status: AssumptionStatusValue }
  | { op: 'add_escalation_topic'; topic: string }
  | { op: 'remove_escalation_topic'; topic: string }
  | { op: 'set_delivery'; draft_pr: boolean; merge: boolean };

export type AmendmentOp = AmendmentChange['op'];

export interface AmendmentProposal {
  change: AmendmentChange;
  /** What was observed that motivates the change. Required: no amendment without evidence. */
  evidence: string;
  reason: string;
}
