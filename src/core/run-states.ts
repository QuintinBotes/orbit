/**
 * Run state names, shared by storage (which must not import controller/) and
 * the controller's state machine (controller/states.ts holds the edges).
 */
export const RUN_STATES = [
  'CREATED',
  'PREFLIGHT',
  'CONTRACTING',
  'PLANNING',
  'IMPLEMENTING',
  'VERIFYING',
  'REVIEWING',
  'DELIVERING',
  'AWAITING_CI',
  'INQUISITION',
  'DIAGNOSING',
  'REPAIRING',
  'RECOVERING',
  'SUCCEEDED',
  'BLOCKED',
  'EXHAUSTED',
  'IMPOSSIBLE',
  'CANCELLED',
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(['SUCCEEDED', 'BLOCKED', 'EXHAUSTED', 'IMPOSSIBLE', 'CANCELLED']);

export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}
