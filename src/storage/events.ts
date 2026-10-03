import type { OrbitDb } from './db.ts';

/**
 * Append one row to the run's event log. Callers run this inside the same
 * transaction as the change it describes, which is what makes "every
 * transition has a durable event" hold.
 */
export function appendEvent(
  db: OrbitDb,
  runId: string,
  type: string,
  actor: string,
  data: unknown,
  ts: number,
  fromState: string | null = null,
  toState: string | null = null,
): void {
  db.run(
    'INSERT INTO events (run_id, ts, type, from_state, to_state, actor, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    runId,
    ts,
    type,
    fromState,
    toState,
    actor,
    data === undefined ? null : JSON.stringify(data),
  );
}
