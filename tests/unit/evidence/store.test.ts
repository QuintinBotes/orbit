import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun, requestCancel } from '../../../src/controller/run-store.ts';
import {
  CANDIDATE_STATUSES,
  CHECK_RUN_STATUSES,
  EVIDENCE_VERDICTS,
  FAILURE_SOURCES,
  FINAL_CHECK_STATUSES,
  checkRunToResult,
  finalizeCandidate,
  findCandidateBySeq,
  finishCheckRun,
  getCheckRun,
  latestCandidate,
  listCandidates,
  listCheckRuns,
  listFailures,
  markCheckRunning,
  planCheckRun,
  recordFailure,
  reserveCandidate,
  setCandidateScope,
  setCandidateStatus,
  type NewCheckRun,
} from '../../../src/evidence/store.ts';
import { openDb } from '../../../src/storage/db.ts';
import { CLEAN_SCOPE } from './report-fixtures.ts';

function setup() {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  for (const id of ['r1', 'r2']) createRun(db, { id, repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  return { db, clock };
}

const newCheck = (over: Partial<NewCheckRun> = {}): NewCheckRun => ({
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
  ...over,
});

const done = (over: Record<string, unknown> = {}) => ({ status: 'PASSED' as const, exitCode: 0, timedOut: false, cancelled: false, logPath: '/l', logSha256: 'h', fingerprint: null, excerpt: null, artifacts: [], endedAt: 5, ...over });

describe('status vocabularies', () => {
  it('are runtime constants other modules can import', () => {
    expect(CANDIDATE_STATUSES).toContain('READY');
    expect(CHECK_RUN_STATUSES).toEqual(['PLANNED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR', 'TIMEOUT', 'CANCELLED']);
    expect(FINAL_CHECK_STATUSES).toEqual(['PASSED', 'FAILED', 'ERROR', 'TIMEOUT', 'CANCELLED']);
    expect(EVIDENCE_VERDICTS).toEqual(['PASS', 'FAIL', 'INCOMPLETE']);
    expect(FAILURE_SOURCES).toContain('baseline');
  });
});

describe('candidates', () => {
  const input = (over: Record<string, unknown> = {}) => ({ runId: 'r1', attempt: 1, workerId: 'w1', treeHash: 'tree-a', parentSha: 'base', ...over });

  it('assigns seq per run, unique and increasing, starting at 1 for each run', () => {
    const { db, clock } = setup();
    expect(reserveCandidate(db, input(), clock).seq).toBe(1);
    expect(reserveCandidate(db, input({ treeHash: 'tree-b' }), clock).seq).toBe(2);
    expect(reserveCandidate(db, input({ runId: 'r2' }), clock).seq).toBe(1);
    expect(() => db.run("INSERT INTO candidates (id, run_id, seq, attempt, commit_sha, tree_hash, parent_sha, status, created_at) VALUES ('dup', 'r1', 2, 1, '', 't', 'p', 'CREATING', 0)")).toThrow(/UNIQUE/);
  });

  it('returns the existing candidate for the same tree in the same run', () => {
    const { db, clock } = setup();
    const a = reserveCandidate(db, input(), clock);
    expect(reserveCandidate(db, input({ attempt: 2 }), clock).id).toBe(a.id);
    expect(listCandidates(db, 'r1')).toHaveLength(1);
  });

  it('finalizes once, with an event, and hides unfinished rows from latestCandidate', () => {
    const { db, clock } = setup();
    const a = reserveCandidate(db, input(), clock);
    expect(a.status).toBe('CREATING');
    expect(latestCandidate(db, 'r1')).toBeNull();
    const stat = { files: 1, insertions: 2, deletions: 0, binaryFiles: 0, paths: ['a'], truncated: false };
    const f = finalizeCandidate(db, a.id, 'commit1', stat, clock);
    expect(f).toMatchObject({ status: 'READY', commitSha: 'commit1', diffStat: stat });
    expect(finalizeCandidate(db, a.id, 'commit2', stat, clock).commitSha).toBe('commit1');
    expect(latestCandidate(db, 'r1')?.id).toBe(a.id);
    expect(db.all("SELECT * FROM events WHERE type = 'candidate.created'")).toHaveLength(1);
    expect(findCandidateBySeq(db, 'r1', 1)?.id).toBe(a.id);
    expect(findCandidateBySeq(db, 'r1', 9)).toBeNull();
  });

  it('stores status and scope', () => {
    const { db, clock } = setup();
    const a = reserveCandidate(db, input(), clock);
    setCandidateStatus(db, a.id, 'SUPERSEDED');
    setCandidateScope(db, a.id, CLEAN_SCOPE);
    expect(listCandidates(db, 'r1')[0]).toMatchObject({ status: 'SUPERSEDED', scope: CLEAN_SCOPE });
  });
});

describe('check runs', () => {
  it('follows PLANNED, RUNNING, final with events, and finishing is idempotent', () => {
    const { db, clock } = setup();
    const p = planCheckRun(db, newCheck(), clock);
    expect(p).toMatchObject({ status: 'PLANNED', pid: null, limitations: ['no network restriction'], command: ['node', '-e', '0'], rerunOf: null });
    clock.advance(100);
    const r = markCheckRunning(db, p.id, 4242, clock);
    expect(r).toMatchObject({ status: 'RUNNING', pid: 4242, startedAt: clock.now() });
    const f = finishCheckRun(db, p.id, done());
    expect(f).toMatchObject({ status: 'PASSED', exitCode: 0, endedAt: 5, limitations: ['no network restriction'] });
    expect(finishCheckRun(db, p.id, done({ status: 'FAILED', exitCode: 1 })).status).toBe('PASSED');
    expect(markCheckRunning(db, p.id, 1, clock).status).toBe('PASSED');
    expect(db.all<{ type: string }>("SELECT type FROM events WHERE type LIKE 'check.%' ORDER BY id").map((e) => e.type)).toEqual(['check.planned', 'check.started', 'check.finished']);
  });

  it('refuses to plan new work for a cancelled run and for an ended one', () => {
    const { db, clock } = setup();
    requestCancel(db, 'r1', 'test', clock);
    expect(() => planCheckRun(db, newCheck(), clock)).toThrowError(expect.objectContaining({ code: 'CANCELLED' }));
    expect(() => planCheckRun(db, newCheck({ runId: 'nope' }), clock)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    db.run("UPDATE runs SET state = 'SUCCEEDED' WHERE id = 'r2'");
    expect(() => planCheckRun(db, newCheck({ runId: 'r2' }), clock)).toThrowError(expect.objectContaining({ code: 'CANCELLED' }));
    expect(listCheckRuns(db, { runId: 'r1' })).toHaveLength(0);
  });

  it('queries by candidate, check, baseline and first attempts, in insertion order', () => {
    const { db, clock } = setup();
    const a = planCheckRun(db, newCheck(), clock);
    planCheckRun(db, newCheck({ rerunOf: a.id }), clock);
    planCheckRun(db, newCheck({ checkId: 'lint' }), clock);
    planCheckRun(db, newCheck({ candidateId: null }), clock);
    expect(listCheckRuns(db, { runId: 'r1' })).toHaveLength(4);
    expect(listCheckRuns(db, { runId: 'r1', candidateId: 'c1', checkId: 'tests' }).map((r) => r.rerunOf)).toEqual([null, a.id]);
    expect(listCheckRuns(db, { runId: 'r1', candidateId: null })).toHaveLength(1);
    expect(listCheckRuns(db, { runId: 'r1', candidateId: 'c1', rootsOnly: true })).toHaveLength(2);
  });

  it('converts a final row to a result carrying the binding, and refuses a row that is not final', () => {
    const { db, clock } = setup();
    const p = planCheckRun(db, newCheck(), clock);
    const binding = { candidateId: 'c1', treeHash: 'tree-a', checkConfigHash: 'sha256:cfg', policyHash: 'sha256:x' };
    expect(() => checkRunToResult(getCheckRun(db, p.id), binding)).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
    finishCheckRun(db, p.id, done({ status: 'FAILED', exitCode: 2, fingerprint: 'fp:1', excerpt: 'Error: x', artifacts: [{ path: '/a', sha256: 's', kind: 'log' }] }));
    expect(checkRunToResult(getCheckRun(db, p.id), binding)).toMatchObject({ id: p.id, checkId: 'tests', status: 'FAILED', exitCode: 2, binding, fingerprint: 'fp:1', artifacts: [{ path: '/a', sha256: 's', kind: 'log' }], isolationLimitations: ['no network restriction'] });
  });
});

describe('failures', () => {
  it('records once per source id and lists by run and fingerprint', () => {
    const { db, clock } = setup();
    const f = { runId: 'r1', candidateId: 'c1', source: 'check' as const, sourceId: 'chk-1', fingerprint: 'fp:a', excerpt: 'Error: a' };
    const first = recordFailure(db, f, clock);
    expect(recordFailure(db, f, clock).id).toBe(first.id);
    recordFailure(db, { ...f, sourceId: 'chk-2', fingerprint: 'fp:b' }, clock);
    recordFailure(db, { ...f, source: 'baseline', sourceId: 'chk-1' }, clock);
    recordFailure(db, { ...f, sourceId: null }, clock);
    recordFailure(db, { ...f, sourceId: null }, clock);
    expect(listFailures(db, 'r1')).toHaveLength(5);
    expect(listFailures(db, 'r1', 'fp:a')).toHaveLength(4);
    expect(listFailures(db, 'r2')).toEqual([]);
  });
});
