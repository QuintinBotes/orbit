/**
 * The owner's inbox files a run's spend requests wrote (issue #254), and their removal once the request they name is
 * over. A leaf module, so that every path that ends a run (recovery included, issue #288) can remove them.
 */
import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import type { OrbitDb } from '../storage/db.ts';

export const SPEND_REQUEST_EVENT = 'budget.spend-requested';

/** Remove every inbox file the run's spend requests wrote. Only a file this module names for this run is ever removed. */
export function removeSpendFiles(db: OrbitDb, runId: string): void {
  const rows = db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', runId, SPEND_REQUEST_EVENT);
  for (const row of rows) {
    const file = (JSON.parse(row.data_json) as { file?: unknown }).file;
    if (typeof file !== 'string' || !basename(file).startsWith(`orbit-${runId}-`) || !file.endsWith('.json')) continue;
    try {
      rmSync(file, { force: true });
    } catch {
      /* an inbox that cannot be changed never changes the run's outcome */
    }
  }
}
