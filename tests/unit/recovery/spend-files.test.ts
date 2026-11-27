// Issue #288: a spend request written just before a crash names a run that recovery then ends EXHAUSTED; the inbox file
// goes with it, so the owner is never asked to approve spend for a run that is over.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRun } from '../../../src/controller/run-store.ts';
import { SPEND_REQUEST_EVENT } from '../../../src/controller/spend-request.ts';
import { enterRecovery, exhaustRecovery } from '../../../src/recovery/budget.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { counters, makeRun, setup } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A spend request recorded for `runId` with its file in a temporary inbox, plus a file of another run beside it. */
function written(db: ReturnType<typeof setup>['db'], clock: ReturnType<typeof setup>['clock'], runId: string): { mine: string; other: string } {
  const inbox = join(mkdtempSync(join(tmpdir(), 'orbit-inbox-')), 'stack', 'inbox', 'spend');
  dirs.push(inbox);
  mkdirSync(inbox, { recursive: true });
  const mine = join(inbox, `orbit-${runId}-24.json`);
  const other = join(inbox, 'orbit-r2-24.json');
  writeFileSync(mine, '{}');
  writeFileSync(other, '{}');
  appendEvent(db, runId, SPEND_REQUEST_EVENT, 'ctl-1', { question_id: 'q-spend-1', file: mine, total_usd: 24 }, clock.now());
  return { mine, other };
}

describe('a spend file left by a crash (issue #288)', () => {
  it('is removed when the recovery budget ends the run', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    counters(db, 'r1', { recovery_attempts: 2 });
    const { mine, other } = written(db, clock, 'r1');
    expect(enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash 1' }).outcome).toBe('recovering');
    expect(existsSync(mine)).toBe(true);
    expect(enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash 2' }).outcome).toBe('already-recovering');
    expect(enterRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', reason: 'crash 3' }).outcome).toBe('exhausted');
    expect(getRun(db, 'r1').state).toBe('EXHAUSTED');
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('is removed when a lost worker cannot be restarted and the run is exhausted', () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    const { mine, other } = written(db, clock, 'r1');
    expect(exhaustRecovery(db, clock, { runId: 'r1', ownerId: 'ctl-1', why: 'lost implementer' })?.state).toBe('EXHAUSTED');
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});
