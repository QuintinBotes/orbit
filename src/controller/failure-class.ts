/**
 * Why a run ended, as one class from a fixed list (docs/decisions/0018-run-end-record.md). The list is published in
 * schemas/failure-class.schema.json; a test holds the two in step.
 *
 * The class is set by rules over what the run recorded: the state it ended in, the structured outcome its last step
 * wrote, the data of the ending transition, and the worker-ended events. No model is asked, and no rule reads the
 * wording of a reason, so the same records always give the same class and nothing a reason quotes (a path, a host
 * name, a token) can reach the stored value.
 */
import type { OrbitDb } from '../storage/db.ts';
import { TERMINAL_STATES, type RunState } from '../core/run-states.ts';
import { OrbitError } from '../core/errors.ts';

export const FAILURE_CLASSES = ['environment', 'check-misconfigured', 'gate-deadlock', 'scope', 'budget', 'turn-cap', 'model', 'review-dispute', 'credentials', 'cancelled'] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export function isFailureClass(value: unknown): value is FailureClass {
  return typeof value === 'string' && (FAILURE_CLASSES as readonly string[]).includes(value);
}

/** A stored class as a class, or null for anything else (a row written before the column existed, an unknown value). */
export function failureClassOrNull(value: unknown): FailureClass | null {
  return isFailureClass(value) ? value : null;
}

/** The event an implementing step writes when an attempt's session ended without finishing (steps/implementing.ts WORKER_ENDED_EVENT). */
export const TURN_CAP_EVENT = 'implementation.worker-ended';

export interface RunEndEvidence {
  /** The terminal state the run ends in. */
  state: RunState;
  /** The structured outcome the ending step wrote (runs.outcome_json), when it wrote one. */
  outcome: Record<string, unknown> | null;
  /** The data of the ending transition (an error code, a budget counter). */
  data: Record<string, unknown> | null;
  /** The class the ending step names for an end its records carry no marker for; used only when no marker says otherwise. */
  cause: FailureClass | null;
  /** Implementer sessions of this run that ended at their turn cap. */
  turnCapSessions: number;
}

export interface RunEndClass {
  failureClass: FailureClass | null;
  /** The next cause after the first, when the run had two. */
  secondary: FailureClass | null;
}

const CODE_CLASS: Readonly<Record<string, FailureClass>> = {
  AUTH_EXPIRED: 'credentials',
  AUTH_MISSING: 'credentials',
  SCOPE_VIOLATION: 'scope',
  POLICY_DENIED: 'scope',
  ISOLATION_UNAVAILABLE: 'environment',
  PROVIDER_UNAVAILABLE: 'environment',
  POLICY_TAMPERED: 'environment',
  CONFIG_INVALID: 'environment',
  CONTRACT_INVALID: 'environment',
};

/** Budget counters whose exhaustion means the host or the provider kept failing, not that the work was expensive. */
const INFRASTRUCTURE_COUNTERS: ReadonlySet<string> = new Set(['recovery_attempts', 'infrastructure_retries']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A marker is present when its key holds something: a non-empty list, an object, a true flag, a non-empty string or a number. */
const has = (o: Record<string, unknown>, key: string): boolean => {
  const v = o[key];
  if (v === undefined || v === null || v === false || v === '') return false;
  return Array.isArray(v) ? v.length > 0 : true;
};

/** The outcome keys that mark each class, by name; `orbit retro` groups on the names a run's class was set from, never their contents. */
const MARKER_KEYS: Partial<Record<FailureClass, readonly string[]>> = {
  credentials: ['git_credentials'],
  'check-misconfigured': ['misconfigured_checks'],
  environment: ['environment_failures', 'incomplete_checks', 'worker_refusal', 'dirty', 'reviewer', 'release_error', 'release_pending', 'base_conflict'],
  scope: ['scope', 'ungranted', 'largest_changes'],
  'review-dispute': ['open_findings', 'held_findings'],
  'gate-deadlock': ['questions', 'blocked_criteria', 'authorization', 'ledger_entries', 'ledger_declined', 'fail_before', 'review_gate', 'shallow_reviews'],
};

/** The outcome markers of `cls` that `outcome` carries, by key name: the same test classifyRunEnd applies. */
export function classMarkers(cls: FailureClass, outcome: Record<string, unknown>): string[] {
  const found = (MARKER_KEYS[cls] ?? []).filter((k) => has(outcome, k));
  // A gate list (not a gate record, which names the environment) marks a deadlock.
  if (cls === 'gate-deadlock' && Array.isArray(outcome.gate)) found.push('gate');
  return found;
}

/**
 * The causes the records show, in the order they stop a run: what made the work impossible to judge comes before
 * what then held it at a gate. Each rule reads one structured marker; the first that holds is the run's class.
 */
function markedCauses(outcome: Record<string, unknown>, data: Record<string, unknown>): FailureClass[] {
  const causes: FailureClass[] = [];
  const add = (c: FailureClass, when: boolean): void => {
    if (when && !causes.includes(c)) causes.push(c);
  };
  const code = typeof data.code === 'string' ? CODE_CLASS[data.code] : undefined;
  const counter = typeof data.counter === 'string' ? data.counter : typeof outcome.limit === 'string' ? outcome.limit : null;
  const frozen = isRecord(outcome.frozen_policy) && typeof outcome.frozen_policy.setting === 'string' ? outcome.frozen_policy.setting : '';
  const gate = isRecord(outcome.gate) && typeof outcome.gate.gate === 'string' ? outcome.gate.gate : null;

  const marked = (c: FailureClass): boolean => classMarkers(c, outcome).length > 0;
  add('credentials', (isRecord(outcome.blocker) && outcome.blocker.kind === 'authentication') || data.kind === 'authentication' || marked('credentials') || code === 'credentials');
  add('check-misconfigured', marked('check-misconfigured') || /^checks\./.test(frozen));
  add('environment', marked('environment') || gate === 'environment' || gate === 'baseline' || code === 'environment' || (counter !== null && INFRASTRUCTURE_COUNTERS.has(counter)));
  add('scope', marked('scope') || /^(scope\.|scheduler\.hard_limits\.changed_)/.test(frozen) || code === 'scope');
  add('review-dispute', marked('review-dispute') || counter === 'review_rounds');
  add('gate-deadlock', marked('gate-deadlock'));
  return causes;
}

/**
 * The class of a run that ends in `state`, and its second cause when it had two. Success has none; a cancelled run is
 * `cancelled` whatever the step had decided. For the rest the first cause that stopped progress is the class: sessions
 * that ended at their turn cap (they came first, in a run that then ran out), what the records mark, the fallback the
 * step names, and `model` only when nothing else explains the end. An EXHAUSTED run always ran out of a budget last, and
 * so did a BLOCKED one whose step had decided EXHAUSTED (`outcome.decided`): it holds a verified candidate (issue #169).
 */
export function classifyRunEnd(e: RunEndEvidence): RunEndClass {
  if (!TERMINAL_STATES.has(e.state)) throw new OrbitError('INTERNAL', `${e.state} is not a terminal state: it has no failure class`);
  if (e.cause !== null && !isFailureClass(e.cause)) throw new OrbitError('INTERNAL', 'the cause named for the end of a run is not a failure class');
  if (e.state === 'SUCCEEDED') return { failureClass: null, secondary: null };
  if (e.state === 'CANCELLED') return { failureClass: 'cancelled', secondary: null };

  const outcome = e.outcome ?? {};
  const data = e.data ?? {};
  // Issue #169: a run that ran out while it held a verified candidate ends BLOCKED so a person can deliver it. It stopped
  // for what would have ended it EXHAUSTED, so it is classified as that end (verified-candidate.ts).
  const state = e.state === 'BLOCKED' && outcome.decided === 'EXHAUSTED' ? 'EXHAUSTED' : e.state;
  const causes: FailureClass[] = [];
  const ranOut = state === 'EXHAUSTED' || state === 'IMPOSSIBLE';
  if (ranOut && e.turnCapSessions > 0) causes.push('turn-cap');
  for (const c of markedCauses(outcome, data)) if (!causes.includes(c)) causes.push(c);
  if (causes.length === 0) {
    if (e.cause !== null) causes.push(e.cause);
    else if (state !== 'EXHAUSTED' || workDidNotConverge(outcome, data)) causes.push('model');
  }
  if (state === 'EXHAUSTED' && !causes.includes('budget')) causes.push('budget');
  return { failureClass: causes[0] ?? null, secondary: causes[1] ?? null };
}

/** An EXHAUSTED run whose attempts went into the same failure: the work did not converge, which no harness cause explains. */
function workDidNotConverge(outcome: Record<string, unknown>, data: Record<string, unknown>): boolean {
  return has(outcome, 'non_progress') || has(outcome, 'extension') || has(outcome, 'fingerprint') || has(outcome, 'hypotheses') || data.counter === 'implementation_attempts';
}

/** Implementer sessions of the run that ended at their turn cap, from the worker-ended events. */
export function turnCapSessions(db: OrbitDb, runId: string): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.status') = 'max_turns'", runId, TURN_CAP_EVENT)?.n ?? 0);
}

/** The outcome a transition patches in, as a record; null for none or for text that is not a JSON object. */
export function parseOutcome(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const o: unknown = JSON.parse(json);
    return isRecord(o) ? o : null;
  } catch {
    return null;
  }
}
