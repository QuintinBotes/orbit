import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { checkRunToResult, getCandidate, getCheckRun, getEvidenceReport, markCheckRunning, planCheckRun, setCheckFlaky, type NewCheckRun } from '../../../src/evidence/store.ts';
import { openDb } from '../../../src/storage/db.ts';

function setup() {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  createRun(db, { id: 'r1', repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  return { db, clock };
}

const newCheck: NewCheckRun = {
  runId: 'r1',
  candidateId: 'c1',
  checkId: 'tests',
  kind: 'command',
  treeHash: 'tree-a',
  checkConfigHash: 'sha256:cfg',
  policyHash: 'sha256:x',
  command: ['node', '-e', '0'],
  cwd: '/checkout',
  isolation: 'none',
  limitations: ['no network restriction'],
};

const binding = { candidateId: 'c1', treeHash: 'tree-a', policyHash: 'sha256:x', checkConfigHash: 'sha256:cfg' };

describe('lookups of rows that do not exist', () => {
  it('say what is missing', () => {
    const { db } = setup();
    expect(() => getCandidate(db, 'cand-nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: 'no candidate cand-nope' }));
    expect(() => getCheckRun(db, 'chk-nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: 'no check run chk-nope' }));
    expect(() => getEvidenceReport(db, 'ev-nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: 'no evidence report ev-nope' }));
  });
});

describe('check runs', () => {
  it('keeps the first start time when a running check is marked running again', () => {
    const { db, clock } = setup();
    const row = planCheckRun(db, newCheck, clock);
    clock.advance(1_000);
    const first = markCheckRunning(db, row.id, 4242, clock);
    expect(first.startedAt).toBe(clock.now());
    clock.advance(5_000);
    const again = markCheckRunning(db, row.id, 4343, clock);
    expect(again).toMatchObject({ status: 'RUNNING', pid: 4343, startedAt: first.startedAt });
  });

  it('can set a check flaky and clear it again', () => {
    const { db, clock } = setup();
    const row = planCheckRun(db, newCheck, clock);
    setCheckFlaky(db, row.id, true);
    expect(getCheckRun(db, row.id).flaky).toBe(true);
    setCheckFlaky(db, row.id, false);
    expect(getCheckRun(db, row.id).flaky).toBe(false);
  });

  it('reads a row with no artifacts blob, or a blob with neither key, as empty lists', () => {
    const { db, clock } = setup();
    const row = planCheckRun(db, newCheck, clock);
    db.run('UPDATE check_runs SET artifacts_json = NULL WHERE id = ?', row.id);
    expect(getCheckRun(db, row.id)).toMatchObject({ artifacts: [], limitations: [] });
    db.run("UPDATE check_runs SET artifacts_json = '{}' WHERE id = ?", row.id);
    expect(getCheckRun(db, row.id)).toMatchObject({ artifacts: [], limitations: [] });
  });

  it('turns a final row with no end time and no log into a result with the start time and empty log fields', () => {
    const { db, clock } = setup();
    const row = planCheckRun(db, newCheck, clock);
    db.run("UPDATE check_runs SET status = 'PASSED', exit_code = 0 WHERE id = ?", row.id);
    const result = checkRunToResult(getCheckRun(db, row.id), binding);
    expect(result).toMatchObject({ status: 'PASSED', startedAt: row.startedAt, endedAt: row.startedAt, logPath: '', logSha256: '' });
  });

  it('refuses to turn a row that is not final into a result', () => {
    const { db, clock } = setup();
    const row = planCheckRun(db, newCheck, clock);
    expect(() => checkRunToResult(row, binding)).toThrow(expect.objectContaining({ code: 'INTERNAL', message: expect.stringContaining('PLANNED, not final') }));
  });
});
