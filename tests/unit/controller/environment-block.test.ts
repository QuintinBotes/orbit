import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { environmentBlockReason, environmentFailuresFor } from '../../../src/controller/environment-block.ts';
import { baselineQuestionId } from '../../../src/inquisition/baseline-exception.ts';
import { finishCheckRun, planCheckRun, type CandidateRecord } from '../../../src/evidence/store.ts';
import type { EnvironmentFailure } from '../../../src/evidence/environment-failure.ts';
import type { EvidenceReport } from '../../../src/evidence/types.ts';
import { addCandidate, addEvidence, BASE_REV, makeUnitLab, setContract, type UnitLab } from './coverage-helpers.ts';

const unit: EnvironmentFailure & { questionId: string } = {
  checkId: 'unit',
  fingerprint: 'fp:0123456789abcdef',
  signals: ['eperm', 'operation-not-permitted'],
  cause: 'an operation the sandbox does not permit failed with EPERM; the operating system answered "operation not permitted"',
  lines: ['Error: listen EPERM: operation not permitted 127.0.0.1'],
  questionId: 'q-baseline-aaaaaaaaaaaa',
};

describe('environmentBlockReason', () => {
  it('names the check, the environment cause, that no repair was spent, and both ways forward', () => {
    const reason = environmentBlockReason({ runId: 'orb-1', candidateSeq: 1, failures: [unit] });
    expect(reason).toMatch(/^check unit fails on candidate 1 exactly as on the base revision/);
    expect(reason).toMatch(/environment cause/);
    expect(reason).toContain('listen EPERM: operation not permitted 127.0.0.1');
    expect(reason).toMatch(/sandbox/);
    expect(reason).toMatch(/no repair attempt was spent/);
    // Way one: the environment or the definition. The definition is frozen into the run's policy.
    expect(reason).toMatch(/fix the environment or the check definition/);
    expect(reason).toMatch(/new run/);
    // Way two: the existing baseline-exception question, with the command that answers it.
    expect(reason).toMatch(/baseline exception/);
    expect(reason).toContain('orbit decide orb-1 q-baseline-aaaaaaaaaaaa Approve');
    expect(reason).toContain('orbit resume orb-1');
  });

  it('lists every blocked check, each with its own question, and writes no em or en dashes', () => {
    const legacy = { ...unit, checkId: 'legacy', fingerprint: 'fp:ffffffffffffffff', cause: 'permission was denied (EACCES) on a path outside the worktree', lines: [], questionId: 'q-baseline-bbbbbbbbbbbb' };
    const reason = environmentBlockReason({ runId: 'orb-2', candidateSeq: 3, failures: [unit, legacy] });
    expect(reason).toMatch(/^checks unit, legacy fail on candidate 3/);
    expect(reason).toContain('legacy: permission was denied (EACCES) on a path outside the worktree');
    expect(reason).toContain('orbit decide orb-2 q-baseline-aaaaaaaaaaaa Approve');
    expect(reason).toContain('orbit decide orb-2 q-baseline-bbbbbbbbbbbb Approve');
    expect(reason).not.toMatch(/[\u2013\u2014]/);
  });
});

// ---------------------------------------------------------------------------
// environmentFailuresFor: what the VERIFYING step reads from the run's records

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const FP = 'fp:0123456789abcdef';
const DENIED = 'Error: listen EPERM: operation not permitted 127.0.0.1\n';

interface Setup {
  cand: CandidateRecord;
  report: EvidenceReport;
}

/** A run whose base revision has a baseline record, one candidate, and one failing `unit` check row with the given output. */
function arrange(opts: { baseline?: { baseRevision?: string; failures: { checkId: string; fingerprint: string | null; excerpt: string | null }[] } | null; log?: string | null | ((l: UnitLab) => string); excerpt?: string | null; fingerprint?: string | null; status?: 'FAILED' | 'PASSED' | 'TIMEOUT'; row?: boolean; exceptions?: { check_id: string; fingerprint: string; reason: string }[] } = {}): Setup {
  lab = makeUnitLab();
  const contract = setContract(lab, opts.exceptions ? { baseline_exceptions: opts.exceptions } : {});
  void contract;
  const ctx = lab.ctx();
  if (opts.baseline !== null) {
    const baseline = opts.baseline ?? { failures: [{ checkId: 'unit', fingerprint: FP, excerpt: null }] };
    writeFileSync(join(ctx.runDir, 'baseline.json'), JSON.stringify({ schema: 'orbit.baseline/1', runId: lab.runId, baseRevision: BASE_REV, complete: true, ...baseline }));
  }
  const cand = addCandidate(lab);
  const status = opts.status ?? 'FAILED';
  const report = addEvidence(lab, cand, { verdict: status === 'PASSED' ? 'PASS' : 'FAIL', checks: [{ id: 'unit', status, exit_code: status === 'PASSED' ? 0 : 1, flaky: false, log: 'unit.log' }] }).report;
  if (opts.row !== false) {
    const evidenceDir = join(ctx.runDir, 'evidence', String(cand.seq));
    mkdirSync(evidenceDir, { recursive: true });
    const logPath = opts.log === null ? null : join(evidenceDir, 'unit.log');
    if (logPath !== null) writeFileSync(logPath, typeof opts.log === 'function' ? opts.log(lab) : (opts.log ?? DENIED));
    const row = planCheckRun(lab.db, { runId: lab.runId, candidateId: cand.id, checkId: 'unit', kind: 'command', treeHash: cand.treeHash, checkConfigHash: 'h', policyHash: ctx.run.policyHash, command: ['node'], cwd: join(lab.home, 'check-1'), isolation: 'none', limitations: [] }, lab.clock);
    finishCheckRun(lab.db, row.id, { status, exitCode: 1, timedOut: status === 'TIMEOUT', cancelled: false, logPath, logSha256: null, fingerprint: opts.fingerprint === undefined ? FP : opts.fingerprint, excerpt: opts.excerpt ?? null, artifacts: [], endedAt: lab.clock.now() });
  }
  return { cand, report };
}

describe('environmentFailuresFor', () => {
  it('finds a failing check that failed on the base revision the same way, reading its log, and names the baseline question to answer', () => {
    const { cand, report } = arrange();
    const found = environmentFailuresFor(lab.ctx(), cand, report);
    expect(found).toEqual([expect.objectContaining({ checkId: 'unit', fingerprint: FP, signals: ['eperm', 'operation-not-permitted'], questionId: baselineQuestionId(lab.runId, 'unit', FP) })]);
  });

  it('reads the stored excerpt when the log is gone', () => {
    const { cand, report } = arrange({ log: null, excerpt: DENIED });
    expect(environmentFailuresFor(lab.ctx(), cand, report).map((f) => f.checkId)).toEqual(['unit']);
    const gone = arrange({ log: null, excerpt: null });
    expect(environmentFailuresFor(lab.ctx(), gone.cand, gone.report)).toEqual([]);
  });

  it('treats a timeout like a failure', () => {
    const { cand, report } = arrange({ status: 'TIMEOUT' });
    expect(environmentFailuresFor(lab.ctx(), cand, report)).toHaveLength(1);
  });

  it('finds nothing when the output shows no denial (a plain pre-existing bug)', () => {
    const { cand, report } = arrange({ log: 'AssertionError: expected 3 to equal 4\n' });
    expect(environmentFailuresFor(lab.ctx(), cand, report)).toEqual([]);
  });

  it('finds nothing without a baseline record, with one of another revision, or when the check did not fail on the base revision', () => {
    for (const baseline of [null, { baseRevision: 'b'.repeat(40), failures: [{ checkId: 'unit', fingerprint: FP, excerpt: null }] }, { failures: [] }]) {
      const { cand, report } = arrange({ baseline });
      expect(environmentFailuresFor(lab.ctx(), cand, report), JSON.stringify(baseline)).toEqual([]);
      lab.cleanup();
    }
  });

  it('finds nothing when the candidate fails differently from the base revision, has no fingerprint, or has no recorded run', () => {
    for (const over of [{ fingerprint: 'fp:ffffffffffffffff' }, { fingerprint: null }, { row: false }]) {
      const { cand, report } = arrange(over);
      expect(environmentFailuresFor(lab.ctx(), cand, report), JSON.stringify(over)).toEqual([]);
      lab.cleanup();
    }
  });

  it('finds nothing for a check that passed on the candidate', () => {
    const { cand, report } = arrange({ status: 'PASSED' });
    expect(environmentFailuresFor(lab.ctx(), cand, report)).toEqual([]);
  });

  it('leaves out a failure the contract already accepts as a baseline exception, and not one accepted for another fingerprint', () => {
    const accepted = arrange({ exceptions: [{ check_id: 'unit', fingerprint: FP, reason: 'accepted' }] });
    expect(environmentFailuresFor(lab.ctx(), accepted.cand, accepted.report)).toEqual([]);
    lab.cleanup();
    const other = arrange({ exceptions: [{ check_id: 'unit', fingerprint: 'fp:ffffffffffffffff', reason: 'accepted' }] });
    expect(environmentFailuresFor(lab.ctx(), other.cand, other.report)).toHaveLength(1);
  });

  it('reads EACCES inside the check\'s own evidence directory as the code\'s, and outside it as the host\'s', () => {
    const inside = arrange({ log: (l) => `Error: EACCES: permission denied, mkdir '${join(l.home, 'check-1', 'build')}'\n` });
    expect(environmentFailuresFor(lab.ctx(), inside.cand, inside.report)).toEqual([]);
    lab.cleanup();
    const outside = arrange({ log: "Error: EACCES: permission denied, mkdir '/var/db/acme'\n" });
    expect(environmentFailuresFor(lab.ctx(), outside.cand, outside.report).map((f) => f.signals)).toEqual([['eacces-outside-worktree']]);
  });
});
