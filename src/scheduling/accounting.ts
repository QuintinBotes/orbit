import type { OrbitDb } from '../storage/db.ts';

/**
 * The accounting a run is charged by, recorded when the run is created (`accounting` in its run.created event). Version 1
 * (0.3.1): every charge marks the usage record it covers (budget.usage-charged, with the amount and its basis), a session
 * stored without a usage record has one recorded from its result, and every session is settled by the run's end. A run
 * created before 0.3.1 names none and keeps the accounting of the version that started it.
 */
export const RUN_ACCOUNTING_VERSION = 1;

/** Whether the run was created with 0.3.1's accounting (RUN_ACCOUNTING_VERSION); false for a run started before 0.3.1. */
export function marksCharges(db: OrbitDb, runId: string): boolean {
  const v = db.get<{ v: unknown }>("SELECT json_extract(data_json, '$.accounting') AS v FROM events WHERE run_id = ? AND type = 'run.created' ORDER BY id LIMIT 1", runId)?.v;
  return typeof v === 'number' && v >= RUN_ACCOUNTING_VERSION;
}
