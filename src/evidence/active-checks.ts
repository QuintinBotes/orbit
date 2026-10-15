/**
 * Which check records may still be running in a checkout. A check run or a fail-before probe attempt stays PLANNED or
 * RUNNING while its stop could not be confirmed (recovery closes a record only when its process is confirmed gone), so
 * its shim or its check may still use the checkout. Verification and the baseline keep such a checkout rather than
 * remove it from under a running check.
 */
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { OrbitDb } from '../storage/db.ts';

export interface ActiveCheck {
  id: string;
  check_id: string;
  status: string;
  /** "check run" or "fail-before probe attempt". */
  what: string;
}

/** The run's check records still active in `dir`: PLANNED or RUNNING, with their cwd in it. */
export function activeChecksIn(db: OrbitDb, runId: string, dir: string): ActiveCheck[] {
  const open = db.all<ActiveCheck & { cwd: string }>(
    "SELECT id, check_id, status, cwd, 'check run' AS what, started_at FROM check_runs WHERE run_id = ? AND status IN ('PLANNED', 'RUNNING') UNION ALL SELECT id, check_id, status, cwd, 'fail-before probe attempt' AS what, started_at FROM fail_before_probes WHERE run_id = ? AND status IN ('PLANNED', 'RUNNING') ORDER BY started_at, id",
    runId,
    runId,
  );
  return open.filter((c) => withinPath(c.cwd, dir)).map((c) => ({ id: c.id, check_id: c.check_id, status: c.status, what: c.what }));
}

/** Why a checkout is kept for `active`, as the decision and the log say it. */
export function activeChecksReason(active: readonly ActiveCheck[]): string {
  return `${active.map((c) => `${c.what} ${c.id} (${c.check_id}, ${c.status})`).join(', ')} may still be running in it; the checkout is kept until a later pass closes ${active.length === 1 ? 'that record' : 'those records'}`;
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Whether `path` is `dir` or lies inside it, links resolved where they exist. */
export function withinPath(path: string, dir: string): boolean {
  const p = realOrResolved(path);
  const d = realOrResolved(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}
