import type { OrbitDb } from '../storage/db.ts';
import type { OrbitConfig } from '../policy/types.ts';

/**
 * Task-sized per-session turn caps (issue #177).
 *
 * A session's cap is the 75th percentile of the model requests that successful sessions of the same role and task class
 * (the run's difficulty) took in this repository, kept within floor..ceiling and never above the policy hard cap.
 * Without history the default applies. Without a `scheduler.turn_cap` section the floor is 10 and the ceiling and the
 * default are the hard cap, so a repository with no history runs as before.
 */

export const TURN_CAP_PERCENTILE = 0.75;
export const DEFAULT_TURN_FLOOR = 10;
export const DEFAULT_REMINDER_FRACTION = 0.8;
/** The worker environment the guard hook reads to remind a session of the turns it has left (policy/guard-hook.ts). */
export const ENV_TURN_CAP = 'ORBIT_TURN_CAP';
export const ENV_TURN_REMIND_AT = 'ORBIT_TURN_REMIND_AT';

export interface TurnCapBounds {
  floor: number;
  ceiling: number;
  default: number;
  reminderFraction: number;
}

/** The nearest-rank percentile `p` (0..1) of `values`; null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * xs.length));
  return xs[Math.min(rank, xs.length) - 1]!;
}

/** The bounds for a config: its `turn_cap` section, or the defaults, clamped under the hard cap. */
export function turnCapBounds(config: Pick<OrbitConfig, 'scheduler'>): TurnCapBounds {
  const hard = config.scheduler.hard_limits.worker_turns_per_session;
  const tc = config.scheduler.turn_cap ?? { floor: DEFAULT_TURN_FLOOR, ceiling: hard, default: hard, reminder_fraction: DEFAULT_REMINDER_FRACTION };
  const ceiling = Math.min(tc.ceiling, hard);
  const floor = Math.min(tc.floor, ceiling);
  return { floor, ceiling, default: Math.min(Math.max(tc.default, floor), ceiling), reminderFraction: tc.reminder_fraction };
}

/** The cap for a new session: the 75th percentile of `history` (turns of successful sessions), within the bounds. */
export function deriveTurnCap(history: readonly number[], bounds: TurnCapBounds): number {
  const p = percentile(history, TURN_CAP_PERCENTILE);
  if (p === null) return bounds.default;
  return Math.min(bounds.ceiling, Math.max(bounds.floor, Math.ceil(p)));
}

/**
 * Turns taken by successful worker sessions of `role` in runs of the same repository and difficulty. Only a session
 * that returned its result with a recorded model-request count contributes; failed and capped sessions do not.
 */
export function successfulTurnHistory(db: OrbitDb, runId: string, role: string): number[] {
  const rows = db.all<{ turns: number | null }>(
    `SELECT json_extract(w.result_json, '$.modelRequests') AS turns
       FROM workers w
       JOIN runs r ON r.id = w.run_id
       JOIN runs me ON me.id = ?
      WHERE w.role = ? AND w.result_status = 'succeeded'
        AND r.repo_root = me.repo_root AND r.difficulty IS me.difficulty`,
    runId,
    role,
  );
  return rows.map((r) => r.turns).filter((t): t is number => typeof t === 'number' && Number.isSafeInteger(t) && t > 0);
}

/** The cap a new session of `role` in run `runId` starts with. */
export function turnCapFor(db: OrbitDb, runId: string, role: string, config: Pick<OrbitConfig, 'scheduler'>): number {
  return deriveTurnCap(successfulTurnHistory(db, runId, role), turnCapBounds(config));
}

/** The number of turns taken at which the worker is first reminded: 80% of the cap, and at least one turn before it. */
export function reminderThreshold(cap: number, fraction: number = DEFAULT_REMINDER_FRACTION): number {
  return Math.min(Math.max(1, Math.ceil(cap * fraction)), Math.max(1, cap - 1));
}

/** The reminder for the turn about to start, given the turns already taken: null before `remindAt` and at the cap. */
export function turnReminder(turnsTaken: number, cap: number, remindAt: number): string | null {
  if (cap < 2 || turnsTaken >= cap || turnsTaken < remindAt) return null;
  const left = cap - turnsTaken;
  return `Orbit turn budget: ${left} turn${left === 1 ? '' : 's'} of ${cap} remain${left === 1 ? 's' : ''} in this session. Wrap up and return your structured output. If work remains, say exactly what remains in it; an implementer sets next_action.kind to continue-implementation with the remainder in next_action.detail, and its attempt gets one extension.`;
}

/**
 * Whether a session that asked to continue gets its attempt's one extension (issue #177): it stated what remains, it
 * reached its reminder (80% of its cap), and the attempt has had no extension yet.
 */
export function decideTurnExtension(ask: { remainder: string | null | undefined; turns: number | null | undefined; remindAt: number | null; granted: number }): { granted: boolean; reason: string } {
  if (!ask.remainder || ask.remainder.trim() === '') return { granted: false, reason: 'no remainder stated' };
  if (ask.granted > 0) return { granted: false, reason: 'the attempt already had its one extension' };
  if (ask.remindAt === null || typeof ask.turns !== 'number' || ask.turns < ask.remindAt) return { granted: false, reason: 'the session stopped before its turn reminder' };
  return { granted: true, reason: 'the session reached its turn reminder and stated what remains' };
}
