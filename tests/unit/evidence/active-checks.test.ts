/**
 * Which check records may still run in a checkout (review of the worktree release): verification and the baseline keep a
 * checkout while a check run or a fail-before probe attempt in it is PLANNED or RUNNING, since a stop that could not be
 * confirmed leaves the record open and its shim or check may still use the checkout.
 */
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activeChecksIn, activeChecksReason, withinPath } from '../../../src/evidence/active-checks.ts';
import { makeUnitLab, type UnitLab } from '../controller/coverage-helpers.ts';

let lab: UnitLab | undefined;
afterEach(() => {
  lab?.cleanup();
  lab = undefined;
});

function checkRun(l: UnitLab, id: string, cwd: string, status: string, startedAt: number): void {
  l.db.run(
    "INSERT INTO check_runs (id, run_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, started_at) VALUES (?, ?, 'unit', 'test', 't', 'h', 'p', '[]', ?, 'none', ?, ?)",
    id,
    l.runId,
    cwd,
    status,
    startedAt,
  );
}

function probeAttempt(l: UnitLab, id: string, cwd: string, status: string, startedAt: number): void {
  l.db.run(
    "INSERT INTO fail_before_probes (id, run_id, candidate_id, probe_id, probe_tree, check_id, check_config_hash, policy_hash, attempt, command_json, cwd, isolation, status, started_at) VALUES (?, ?, 'cand-1', 'probe-1', 't', 'unit', 'h', 'p', 1, '[]', ?, 'none', ?, ?)",
    id,
    l.runId,
    cwd,
    status,
    startedAt,
  );
}

describe('activeChecksIn', () => {
  it('names the open check runs and probe attempts whose cwd lies in the checkout, oldest first', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const checkout = join(lab.base, 'check-1');
    mkdirSync(join(checkout, 'tests'), { recursive: true });
    checkRun(lab, 'cr-root', checkout, 'RUNNING', 2);
    checkRun(lab, 'cr-sub', join(checkout, 'tests'), 'PLANNED', 3);
    probeAttempt(lab, 'fbp-1', checkout, 'RUNNING', 1);

    expect(activeChecksIn(lab.db, lab.runId, checkout)).toEqual([
      { id: 'fbp-1', check_id: 'unit', status: 'RUNNING', what: 'fail-before probe attempt' },
      { id: 'cr-root', check_id: 'unit', status: 'RUNNING', what: 'check run' },
      { id: 'cr-sub', check_id: 'unit', status: 'PLANNED', what: 'check run' },
    ]);
  });

  it('ignores closed records, records of other checkouts and a sibling whose name only starts the same', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const checkout = join(lab.base, 'check-1');
    mkdirSync(checkout, { recursive: true });
    checkRun(lab, 'cr-done', checkout, 'PASSED', 1);
    checkRun(lab, 'cr-cancelled', checkout, 'CANCELLED', 2);
    checkRun(lab, 'cr-other', join(lab.base, 'check-2'), 'RUNNING', 3);
    checkRun(lab, 'cr-sibling', join(lab.base, 'check-10'), 'RUNNING', 4);
    probeAttempt(lab, 'fbp-done', checkout, 'FAILED', 5);

    expect(activeChecksIn(lab.db, lab.runId, checkout)).toEqual([]);
  });

  it('matches a cwd reached through a link to the checkout', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const checkout = join(lab.base, 'check-1');
    mkdirSync(checkout, { recursive: true });
    const link = join(lab.base, 'check-link');
    symlinkSync(checkout, link);
    checkRun(lab, 'cr-linked', link, 'RUNNING', 1);

    expect(activeChecksIn(lab.db, lab.runId, checkout).map((c) => c.id)).toEqual(['cr-linked']);
    expect(withinPath(link, checkout)).toBe(true);
  });

  it('says why the checkout is kept, naming each record', () => {
    expect(activeChecksReason([{ id: 'cr-1', check_id: 'unit', status: 'RUNNING', what: 'check run' }])).toBe('check run cr-1 (unit, RUNNING) may still be running in it; the checkout is kept until a later pass closes that record');
    expect(activeChecksReason([
      { id: 'cr-1', check_id: 'unit', status: 'RUNNING', what: 'check run' },
      { id: 'fbp-1', check_id: 'unit', status: 'PLANNED', what: 'fail-before probe attempt' },
    ])).toMatch(/closes those records$/);
  });
});
