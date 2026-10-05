import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checksNotExecutedFor, environmentBlockReason, environmentFailuresFor, type BlockedCheck } from '../../../src/controller/environment-block.ts';
import { defaultCheck, defaultUi } from '../../../src/policy/config.ts';
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

// ---------------------------------------------------------------------------
// A mandatory check that could not execute at all

const ABORT_LOG = ['----- Native stack trace -----', '', ' 1: 0x106eb9cf4 node::InitializeOncePerProcessInternal(std::vector<std::string> const&) [/opt/acme/bin/node]', 'Process killed by signal: SIGABRT', ''].join('\n');

const notExecuted = (over: Partial<BlockedCheck> = {}): BlockedCheck => ({
  checkId: 'ui',
  fingerprint: null,
  signals: ['process-aborted'],
  cause: 'the process was killed by a fatal signal before it printed anything of its own (SIGABRT)',
  lines: ['Process killed by signal: SIGABRT', '1: 0x106eb9cf4 node::InitializeOncePerProcessInternal(std::vector<std::string> const&) [/opt/acme/bin/node]'],
  questionId: null,
  logPath: '/orbit/runs/acme/evidence/1/ui/app/app.log',
  ...over,
});

describe('environmentBlockReason: a check that could not execute', () => {
  it('says the check could not execute, names the cause, the signal line and the log, and offers the one way forward that applies', () => {
    const reason = environmentBlockReason({ runId: 'orb-3', candidateSeq: 2, failures: [notExecuted()] });
    expect(reason).toMatch(/^check ui could not execute on candidate 2, and the output shows an environment cause, not a defect in the change: ui: the process was killed by a fatal signal before it printed anything of its own \(SIGABRT\)/);
    expect(reason).toContain('"Process killed by signal: SIGABRT"');
    expect(reason).toContain('output in /orbit/runs/acme/evidence/1/ui/app/app.log');
    expect(reason).toMatch(/no repair attempt was spent/);
    expect(reason).toMatch(/way forward: fix the environment \(orbit doctor checks the isolation provider and its limits\) or the check definition and start a new run/);
    // There is no failure to except, so no baseline question is offered.
    expect(reason).not.toMatch(/orbit decide/);
    expect(reason).not.toMatch(/exactly as on the base revision/);
    expect(reason).not.toMatch(/[\u2013\u2014]/);
  });

  it('keeps both sentences and both ways forward when a check failed like the base revision and another could not execute', () => {
    const reason = environmentBlockReason({ runId: 'orb-4', candidateSeq: 1, failures: [unit, notExecuted()] });
    expect(reason).toMatch(/^check unit fails on candidate 1 exactly as on the base revision/);
    expect(reason).toMatch(/\. check ui could not execute on candidate 1/);
    expect(reason).toContain('orbit decide orb-4 q-baseline-aaaaaaaaaaaa Approve');
    expect(reason.match(/orbit decide/g)).toHaveLength(1);
    expect(reason).toMatch(/two ways forward/);
  });
});

let uiLab: UnitLab;
afterEach(() => uiLab?.cleanup());

interface Arranged {
  cand: CandidateRecord;
  report: EvidenceReport;
  uiDir: string;
}

/**
 * A run with a mandatory `unit` command check, an optional `lint` one and a UI journey check `ui` (the contract is
 * validated against the policy, so the journey check is not a mandatory one here), one candidate, and the evidence the
 * VERIFYING step would have stored.
 */
function arrangeNotRun(opts: {
  unit?: { status: 'FAILED' | 'ERROR' | 'PASSED' | 'TIMEOUT'; log?: string; excerpt?: string | null; fingerprint?: string | null } | null;
  lint?: { status: 'FAILED'; log: string };
  ui?: { statuses: ('ERROR' | 'PASSED' | 'FAILED')[]; result?: unknown; appLog?: string; journeyLog?: string; rawResult?: string } | null;
  exceptions?: { check_id: string; fingerprint: string; reason: string }[];
} = {}): Arranged {
  uiLab = makeUnitLab({
    tweak: (c) => {
      c.checks.lint = { ...defaultCheck('lint'), command: [process.execPath, '-e', '0'], mandatory: false };
      c.checks.ui = { ...defaultCheck('ui'), kind: 'playwright', command: ['npx', '--no-install', 'playwright', 'test'], mandatory: false };
      c.ui = { ...defaultUi(), journey_check_ids: ['ui'], ui_paths: ['web/**'], required_when_ui_changes: false };
    },
  });
  setContract(uiLab, opts.exceptions ? { baseline_exceptions: opts.exceptions } : {});
  const ctx = uiLab.ctx();
  const cand = addCandidate(uiLab);
  const evidenceDir = join(ctx.runDir, 'evidence', String(cand.seq));
  mkdirSync(evidenceDir, { recursive: true });
  const row = (checkId: string, status: 'FAILED' | 'ERROR' | 'PASSED' | 'TIMEOUT', log: string, extra: { excerpt?: string | null; fingerprint?: string | null } = {}): void => {
    const logPath = join(evidenceDir, `${checkId}.log`);
    writeFileSync(logPath, log);
    const planned = planCheckRun(uiLab.db, { runId: uiLab.runId, candidateId: cand.id, checkId, kind: 'command', treeHash: cand.treeHash, checkConfigHash: 'h', policyHash: ctx.run.policyHash, command: ['node'], cwd: join(uiLab.home, 'check-1'), isolation: 'none', limitations: [] }, uiLab.clock);
    finishCheckRun(uiLab.db, planned.id, { status, exitCode: status === 'PASSED' ? 0 : 1, timedOut: status === 'TIMEOUT', cancelled: false, logPath, logSha256: null, fingerprint: extra.fingerprint === undefined ? (status === 'PASSED' ? null : FP) : extra.fingerprint, excerpt: extra.excerpt ?? null, artifacts: [], endedAt: uiLab.clock.now() });
  };
  const checks: EvidenceReport['checks'] = [];
  if (opts.unit !== null) {
    const u = opts.unit ?? { status: 'FAILED' as const, log: ABORT_LOG };
    row('unit', u.status, u.log ?? '', { ...(u.excerpt !== undefined ? { excerpt: u.excerpt } : {}), ...(u.fingerprint !== undefined ? { fingerprint: u.fingerprint } : {}) });
    checks.push({ id: 'unit', status: u.status === 'TIMEOUT' ? 'TIMEOUT' : u.status, exit_code: 1, flaky: false, log: 'unit.log' });
  }
  if (opts.lint) {
    row('lint', opts.lint.status, opts.lint.log);
    checks.push({ id: 'lint', status: opts.lint.status, exit_code: 1, flaky: false, log: 'lint.log' });
  }
  const uiDir = join(evidenceDir, 'ui');
  const uiEntries: EvidenceReport['ui'] = [];
  if (opts.ui) {
    mkdirSync(join(uiDir, 'app'), { recursive: true });
    mkdirSync(join(uiDir, 'ui'), { recursive: true });
    if (opts.ui.appLog !== undefined) writeFileSync(join(uiDir, 'app', 'app.log'), opts.ui.appLog);
    if (opts.ui.journeyLog !== undefined) writeFileSync(join(uiDir, 'ui', 'run.log'), opts.ui.journeyLog);
    if (opts.ui.rawResult !== undefined) writeFileSync(join(uiDir, 'ui-result.json'), opts.ui.rawResult);
    else if (opts.ui.result !== undefined) writeFileSync(join(uiDir, 'ui-result.json'), JSON.stringify(opts.ui.result));
    for (const [i, status] of opts.ui.statuses.entries()) uiEntries.push({ journey: `j${i}`, status, artifacts: [] });
  }
  const report = addEvidence(uiLab, cand, { verdict: 'INCOMPLETE', checks, ui: uiEntries }).report;
  return { cand, report, uiDir };
}

const appEntry = (uiDir: string, over: Record<string, unknown> = {}) => ({ stage: 'application', checkId: null, logPath: join(uiDir, 'app', 'app.log'), signal: null, ...over });

describe('checksNotExecutedFor: command checks', () => {
  it('finds a mandatory check whose process was killed by a crash signal before it printed anything, without any baseline', () => {
    const { cand, report } = arrangeNotRun();
    const found = checksNotExecutedFor(uiLab.ctx(), cand, report);
    expect(found).toEqual([expect.objectContaining({ checkId: 'unit', fingerprint: null, questionId: null, signals: ['process-aborted'], logPath: join(uiLab.ctx().runDir, 'evidence', '1', 'unit.log') })]);
  });

  it('finds a check the runner could not start (status ERROR with the runner\'s note), reading the stored excerpt when the log has none', () => {
    const { cand, report } = arrangeNotRun({ unit: { status: 'ERROR', log: '[orbit] check=unit status=ERROR exit=none note=could not start the check: spawn npx ENOENT\n', fingerprint: null } });
    expect(checksNotExecutedFor(uiLab.ctx(), cand, report)).toEqual([expect.objectContaining({ checkId: 'unit', signals: ['start-failed'], lines: ['could not start the check: spawn npx ENOENT'] })]);
  });

  it('leaves alone a check that ran: assertion output, a segfault after test output, a timeout, a passing check', () => {
    for (const unit of [
      { status: 'FAILED' as const, log: 'AssertionError: expected 3 to equal 4\n' },
      { status: 'FAILED' as const, log: `3 tests passed\n${ABORT_LOG}` },
      { status: 'TIMEOUT' as const, log: '' },
      { status: 'PASSED' as const, log: '' },
      // An ERROR that is not "could not start": the process vanished, which is not this rule's to judge.
      { status: 'ERROR' as const, log: '[orbit] check=unit status=ERROR exit=none note=the check process disappeared without writing an exit record\n', fingerprint: null },
    ]) {
      const { cand, report } = arrangeNotRun({ unit });
      expect(checksNotExecutedFor(uiLab.ctx(), cand, report), JSON.stringify(unit)).toEqual([]);
      uiLab.cleanup();
    }
  });

  it('leaves alone a check that is not mandatory, and one whose failure the contract already accepts as a baseline exception', () => {
    const optional = arrangeNotRun({ unit: null, lint: { status: 'FAILED', log: ABORT_LOG } });
    expect(checksNotExecutedFor(uiLab.ctx(), optional.cand, optional.report)).toEqual([]);
    uiLab.cleanup();
    const accepted = arrangeNotRun({ exceptions: [{ check_id: 'unit', fingerprint: FP, reason: 'accepted' }] });
    expect(checksNotExecutedFor(uiLab.ctx(), accepted.cand, accepted.report)).toEqual([]);
    uiLab.cleanup();
    const other = arrangeNotRun({ exceptions: [{ check_id: 'unit', fingerprint: 'fp:ffffffffffffffff', reason: 'accepted' }] });
    expect(checksNotExecutedFor(uiLab.ctx(), other.cand, other.report)).toHaveLength(1);
  });
});

describe('checksNotExecutedFor: the UI run', () => {
  it('finds the application that was killed by a crash signal before it printed anything, naming the journey checks and the app log', () => {
    const a = arrangeNotRun({ unit: null, ui: { statuses: ['ERROR'], appLog: ABORT_LOG } });
    writeFileSync(join(a.uiDir, 'ui-result.json'), JSON.stringify({ verdict: 'ERROR', notExecuted: [appEntry(a.uiDir)] }));
    expect(checksNotExecutedFor(uiLab.ctx(), a.cand, a.report)).toEqual([expect.objectContaining({ checkId: 'ui', fingerprint: null, questionId: null, signals: ['process-aborted'], logPath: join(a.uiDir, 'app', 'app.log') })]);
  });

  it('finds a journey check whose Playwright process crashed with no report, by the signal the runner recorded', () => {
    const a = arrangeNotRun({ unit: null, ui: { statuses: ['ERROR'], journeyLog: '' } });
    writeFileSync(join(a.uiDir, 'ui-result.json'), JSON.stringify({ verdict: 'ERROR', notExecuted: [{ stage: 'journeys', checkId: 'ui', logPath: join(a.uiDir, 'ui', 'run.log'), signal: 'SIGSEGV' }] }));
    expect(checksNotExecutedFor(uiLab.ctx(), a.cand, a.report)).toEqual([expect.objectContaining({ checkId: 'ui', cause: expect.stringContaining('(SIGSEGV)') })]);
  });

  it('finds a journey check whose browser the sandbox stopped, by the runner\'s finding, though Playwright printed its own output', () => {
    const a = arrangeNotRun({ unit: null, ui: { statuses: ['ERROR'], journeyLog: 'Running 8 tests using 2 workers\n  8 failed\n' } });
    const environment = 'Chromium could not register its Mach rendezvous service: bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.1: Permission denied (1100)';
    writeFileSync(join(a.uiDir, 'ui-result.json'), JSON.stringify({ verdict: 'ERROR', notExecuted: [{ stage: 'journeys', checkId: 'ui', logPath: join(a.uiDir, 'ui', 'run.log'), signal: null, environment }] }));
    expect(checksNotExecutedFor(uiLab.ctx(), a.cand, a.report)).toEqual([expect.objectContaining({ checkId: 'ui', signals: ['browser-isolation'], cause: 'the browser could not start under sandbox-runtime', lines: [environment] })]);
    // A finding that is not text is not trusted.
    writeFileSync(join(a.uiDir, 'ui-result.json'), JSON.stringify({ verdict: 'ERROR', notExecuted: [{ stage: 'journeys', checkId: 'ui', logPath: join(a.uiDir, 'ui', 'run.log'), signal: null, environment: { x: 1 } }] }));
    expect(checksNotExecutedFor(uiLab.ctx(), a.cand, a.report)).toEqual([]);
  });

  it('leaves alone an application that threw while loading, and a UI run that was not an ERROR', () => {
    const threw = arrangeNotRun({ unit: null, ui: { statuses: ['ERROR'], appLog: "SyntaxError: Unexpected token '}'\n" } });
    writeFileSync(join(threw.uiDir, 'ui-result.json'), JSON.stringify({ verdict: 'ERROR', notExecuted: [appEntry(threw.uiDir)] }));
    expect(checksNotExecutedFor(uiLab.ctx(), threw.cand, threw.report)).toEqual([]);
    uiLab.cleanup();
    const passed = arrangeNotRun({ unit: null, ui: { statuses: ['PASSED'], appLog: ABORT_LOG } });
    writeFileSync(join(passed.uiDir, 'ui-result.json'), JSON.stringify({ verdict: 'PASS', notExecuted: [appEntry(passed.uiDir)] }));
    expect(checksNotExecutedFor(uiLab.ctx(), passed.cand, passed.report)).toEqual([]);
  });

  it('reads nothing it cannot trust: a missing or unreadable result, a malformed entry, a log outside the UI evidence directory or at a relative path', () => {
    const missing = arrangeNotRun({ unit: null, ui: { statuses: ['ERROR'], appLog: ABORT_LOG } });
    expect(checksNotExecutedFor(uiLab.ctx(), missing.cand, missing.report)).toEqual([]);
    uiLab.cleanup();
    const broken = arrangeNotRun({ unit: null, ui: { statuses: ['ERROR'], appLog: ABORT_LOG, rawResult: '{not json' } });
    expect(checksNotExecutedFor(uiLab.ctx(), broken.cand, broken.report)).toEqual([]);
    uiLab.cleanup();
    const shapes = arrangeNotRun({ unit: null, ui: { statuses: ['ERROR'], appLog: ABORT_LOG } });
    const outside = join(uiLab.base, 'elsewhere.log');
    writeFileSync(outside, ABORT_LOG);
    const entries: unknown[] = [null, 'x', { stage: 'application' }, { stage: 'other', logPath: join(shapes.uiDir, 'app', 'app.log') }, appEntry(shapes.uiDir, { logPath: outside }), appEntry(shapes.uiDir, { logPath: 'app/app.log' }), appEntry(shapes.uiDir, { logPath: shapes.uiDir })];
    writeFileSync(join(shapes.uiDir, 'ui-result.json'), JSON.stringify({ verdict: 'ERROR', notExecuted: entries }));
    expect(checksNotExecutedFor(uiLab.ctx(), shapes.cand, shapes.report)).toEqual([]);
    writeFileSync(join(shapes.uiDir, 'ui-result.json'), JSON.stringify({ verdict: 'ERROR', notExecuted: 'nope' }));
    expect(checksNotExecutedFor(uiLab.ctx(), shapes.cand, shapes.report)).toEqual([]);
  });

  it('lists one failure per check id when a command check and the UI run both could not execute', () => {
    const a = arrangeNotRun({ ui: { statuses: ['ERROR'], appLog: ABORT_LOG } });
    writeFileSync(join(a.uiDir, 'ui-result.json'), JSON.stringify({ verdict: 'ERROR', notExecuted: [appEntry(a.uiDir), appEntry(a.uiDir)] }));
    expect(checksNotExecutedFor(uiLab.ctx(), a.cand, a.report).map((f) => f.checkId)).toEqual(['unit', 'ui']);
  });
});
