/**
 * The run state machine (spec §6). Every edge the controller may take is
 * listed here; `assertTransition` rejects anything else, and every accepted
 * transition is written as a durable event in the same transaction.
 *
 * AWAITING_CI is a delivery sub-state the spec folds into DELIVERING. It is a
 * separate state so that a restarted controller knows whether the push and PR
 * already happened (reconcile receipts) or only CI is left to observe.
 */
import { RUN_STATES, TERMINAL_STATES, isRunState, type RunState } from '../core/run-states.ts';

export { RUN_STATES, TERMINAL_STATES, isRunState, type RunState };

/** BLOCKED is terminal for the controller loop but resumable by an authorized decision. */
export const RESUMABLE_STATES: ReadonlySet<RunState> = new Set(['BLOCKED']);

/** States from which work proceeds; INQUISITION returns to the stage it interrupted. */
const WORKING: RunState[] = ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING', 'AWAITING_CI', 'DIAGNOSING', 'REPAIRING'];

/** Exits available from every non-terminal state. */
const ALWAYS: RunState[] = ['BLOCKED', 'EXHAUSTED', 'CANCELLED', 'RECOVERING'];

const EDGES: Record<RunState, RunState[]> = {
  CREATED: ['PREFLIGHT', ...ALWAYS],
  PREFLIGHT: ['CONTRACTING', 'IMPOSSIBLE', ...ALWAYS],
  CONTRACTING: ['PLANNING', 'INQUISITION', 'IMPOSSIBLE', ...ALWAYS],
  PLANNING: ['IMPLEMENTING', 'INQUISITION', 'IMPOSSIBLE', ...ALWAYS],
  IMPLEMENTING: ['VERIFYING', 'INQUISITION', 'DIAGNOSING', ...ALWAYS],
  // No VERIFYING -> SUCCEEDED edge: every successful run passes independent review.
  VERIFYING: ['REVIEWING', 'DIAGNOSING', 'INQUISITION', ...ALWAYS],
  REVIEWING: ['DELIVERING', 'REPAIRING', 'DIAGNOSING', 'INQUISITION', 'SUCCEEDED', ...ALWAYS],
  DELIVERING: ['AWAITING_CI', 'SUCCEEDED', 'VERIFYING', ...ALWAYS],
  // VERIFYING: a task branch rebased onto a moved base branch is a new candidate (actions.rebase_task_branch).
  AWAITING_CI: ['SUCCEEDED', 'DIAGNOSING', 'VERIFYING', ...ALWAYS],
  INQUISITION: [...WORKING, 'IMPOSSIBLE', ...ALWAYS],
  DIAGNOSING: ['REPAIRING', 'INQUISITION', 'IMPOSSIBLE', ...ALWAYS],
  REPAIRING: ['VERIFYING', 'DIAGNOSING', 'INQUISITION', ...ALWAYS],
  // Recovery resumes whichever stage the crash interrupted.
  RECOVERING: [...WORKING, 'INQUISITION', 'BLOCKED', 'EXHAUSTED', 'CANCELLED', 'IMPOSSIBLE'],
  SUCCEEDED: [],
  // An authorized decision or environment repair resumes a blocked run at the stage it stopped in.
  BLOCKED: [...WORKING, 'INQUISITION', 'CANCELLED'],
  EXHAUSTED: [],
  IMPOSSIBLE: [],
  CANCELLED: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return EDGES[from].includes(to);
}

export function allowedTransitions(from: RunState): readonly RunState[] {
  return EDGES[from];
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

