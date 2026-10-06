import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { baselineEnvironmentBlockReason, baselineEnvironmentFailures, checksNotExecutedFor, environmentBlockReason, environmentFix, type BlockedCheck } from '../../../src/controller/environment-block.ts';
import type { BaselineReport } from '../../../src/evidence/baseline.ts';
import { finishCheckRun, planCheckRun } from '../../../src/evidence/store.ts';
import { addCandidate, addEvidence, BASE_REV, makeUnitLab, setContract, type UnitLab } from './coverage-helpers.ts';

// Issue #10: a check the environment stopped before it ran anything of the repository.

const fixture = (name: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/environment', name), 'utf8');
const DOTNET_CRASH = fixture('dotnet-build-eperm-shm.log');
const COMPILE_ERROR = fixture('dotnet-build-compile-error.log');
const FORMAT_BUILD_HOST = fixture('dotnet-format-build-host-timeout.log');
const FORMAT_RESTORE_NODE = fixture('dotnet-format-restore-node-denied.log');
const FP = 'fp:0123456789abcdef';

const dotnet: BlockedCheck = {
  checkId: 'build',
  fingerprint: null,
  signals: ['filesystem-denied'],
  cause: 'the sandbox or the operating system refused a filesystem operation outside the check\'s checkout (EPERM, "operation not permitted")',
  lines: ['...mkdir("/tmp/.dotnet/shm/session53858", AllUsers_ReadWriteExecute) == -1; errno == EPERM;'],
  questionId: null,
  logPath: '/orbit/runs/acme/baseline/build.log',
};

describe('baselineEnvironmentBlockReason', () => {
  it('names the check, the base revision, the first error line and the log, says why no exception is offered, and gives the fix', () => {
    const reason = baselineEnvironmentBlockReason({ runId: 'orb-1', baseRevision: BASE_REV, failures: [dotnet] });
    expect(reason).toMatch(/^Check build could not run on the base revision aaaaaaaaaaaa, and the output shows an environment cause, not a pre-existing failure: the sandbox or the operating system refused a filesystem operation outside the check's checkout/);
    expect(reason).toContain('errno == EPERM;');
    expect(reason).toContain('output in /orbit/runs/acme/baseline/build.log');
    expect(reason).toMatch(/\. It is not recorded as a pre-existing failure and no baseline exception is offered: the check never got as far as the repository's code, so accepting its failure would let a run pass with a check that never ran/);
    expect(reason).toMatch(/\. Fix: this is the \.NET runtime asking for \/tmp\/\.dotnet/);
    expect(reason).toContain('docs/troubleshooting.md');
    expect(reason).toMatch(/\. Then orbit resume orb-1 runs the baseline again; a changed check definition needs a new run/);
    expect(reason).not.toMatch(/orbit decide/);
    expect(reason).not.toMatch(/[\u2013\u2014]/);
  });

  it('lists several checks, and falls back to orbit doctor for a cause it has no specific fix for', () => {
    const crash: BlockedCheck = { checkId: 'unit', fingerprint: null, signals: ['process-aborted'], cause: 'the process was killed by a fatal signal before it printed anything of its own (SIGABRT)', lines: [], questionId: null };
    const reason = baselineEnvironmentBlockReason({ runId: 'orb-2', baseRevision: BASE_REV, failures: [crash, { ...crash, checkId: 'lint' }] });
    expect(reason).toMatch(/^Checks unit, lint could not run on the base revision/);
    expect(reason).toMatch(/\. They are not recorded as a pre-existing failure/);
    expect(reason).toMatch(/\. Fix: let the check run in this environment \(orbit doctor checks the isolation provider and starts each check's executable in the sandbox\), or change the check definition/);
  });
});

describe('environmentFix', () => {
  it('names the .NET case, sends any other denial to orbit doctor, and has nothing to add for a crash', () => {
    expect(environmentFix([dotnet])).toMatch(/\.NET runtime asking for \/tmp\/\.dotnet/);
    expect(environmentFix([{ ...dotnet, signals: ['sandbox-violation'], lines: ['Sandbox: make(1) deny(1) file-write-create /usr/local/var/acme'] }])).toMatch(/^run orbit doctor, which starts each check's executable in the sandbox/);
    expect(environmentFix([{ ...dotnet, signals: ['process-aborted'] }])).toBeNull();
    expect(environmentFix([])).toBeNull();
  });

  it('names the fix for a .NET named pipe the sandbox refused: the check\'s own fix in its log for a worker node, whitespace --folder for dotnet format', () => {
    const pipe = (line: string): BlockedCheck => ({ ...dotnet, signals: ['pipe-denied'], lines: [line] });
    const node = 'the check sandbox denied MSBuild node (pid 4242) its named pipe /tmp/MSBuild4242 (System.Net.Sockets.SocketException (13): Permission denied)';
    const host = 'Unhandled exception: System.TimeoutException: The operation has timed out.';
    expect(environmentFix([pipe(node)])).toMatch(
      /^the sandbox refuses MSBuild worker nodes their named pipe under \/tmp: the check's log ends with the fix for its command \(docs\/troubleshooting\.md, "\.NET builds and MSBuild worker nodes"\)$/,
    );
    const format = environmentFix([pipe(host)]);
    expect(format).toMatch(/^dotnet format \(check build\) takes no -m:1, which it reads as the project to format, and it loads the project through a build host whose named pipe \.NET binds under \/tmp, which no check sandbox may use: check whitespace with the form that loads no project/);
    expect(format).toContain('dotnet format whitespace --folder --verify-no-changes in place of its dotnet format, in the folder of the solution or project it formats and with its --include and --exclude');
    expect(format).toContain('docs/troubleshooting.md, "dotnet format under the sandbox"');
    // With the check's command known, the fix is that command in the form that loads no project, as doctor names it: the
    // folder of the solution it formats, and its --exclude, kept.
    const exact = environmentFix([{ ...pipe(host), checkId: 'fmt', command: { argv: ['dotnet', 'format', 'src/Acme.sln', '--verify-no-changes', '--exclude', 'gen'], shell: false } }]);
    expect(exact).toContain('checks.fmt.command: ["dotnet", "format", "whitespace", "src", "--folder", "--verify-no-changes", "--exclude", "gen"]');
    // Both kinds: each fix names its checks, and neither says -m:1 to dotnet format.
    const both = environmentFix([pipe(node), { ...pipe(host), checkId: 'fmt' }])!;
    expect(both).toMatch(/^for check build: the sandbox refuses MSBuild worker nodes .*; and dotnet format \(check fmt\) takes no -m:1/);
  });

  it('is added to the candidate reason for a check that could not execute because of a denial', () => {
    const reason = environmentBlockReason({ runId: 'orb-3', candidateSeq: 2, failures: [dotnet] });
    expect(reason).toMatch(/^Check build could not execute on candidate 2/);
    expect(reason).toMatch(/there is no baseline exception to approve, because the check never ran\. Fix: this is the \.NET runtime/);
  });
});

// ---------------------------------------------------------------------------
// What PREFLIGHT and VERIFYING read from the run's records

let lab: UnitLab;
afterEach(() => lab?.cleanup());

/** A baseline report with failing mandatory checks, each with a recorded baseline run whose log holds `logs[checkId]`. */
function baselineWith(logs: Record<string, string | null>, opts: { excerpt?: string | null; row?: boolean } = {}): { report: BaselineReport; checkout: string } {
  lab = makeUnitLab();
  const ctx = lab.ctx();
  const dir = join(ctx.runDir, 'baseline');
  mkdirSync(dir, { recursive: true });
  const checkout = join(lab.home, 'worktrees', 'baseline');
  const failures: BaselineReport['failures'] = [];
  const checks: BaselineReport['checks'] = [];
  for (const [checkId, log] of Object.entries(logs)) {
    const logPath = join(dir, `${checkId}.log`);
    if (log !== null) writeFileSync(logPath, log);
    if (opts.row !== false) {
      const row = planCheckRun(lab.db, { runId: lab.runId, candidateId: null, checkId, kind: 'command', treeHash: 'b'.repeat(40), checkConfigHash: 'h', policyHash: ctx.run.policyHash, command: ['dotnet', 'build'], cwd: checkout, isolation: 'none', limitations: [] }, lab.clock);
      finishCheckRun(lab.db, row.id, { status: 'FAILED', exitCode: 1, timedOut: false, cancelled: false, logPath: log === null ? null : logPath, logSha256: null, fingerprint: FP, excerpt: opts.excerpt ?? null, artifacts: [], endedAt: lab.clock.now() });
    }
    failures.push({ checkId, fingerprint: FP, excerpt: opts.excerpt ?? null });
    checks.push({ checkId, mandatory: true, status: 'FAILED', exitCode: 1, flaky: false, fingerprint: FP, excerpt: opts.excerpt ?? null, log: logPath });
  }
  const report: BaselineReport = { schema: 'orbit.baseline/1', runId: lab.runId, baseRevision: BASE_REV, baseTree: 'b'.repeat(40), policyHash: ctx.run.policyHash, checkIds: Object.keys(logs), install: { skipped: true, reason: null, ok: false }, checks, failures, complete: true, recordedAt: lab.clock.now() };
  return { report, checkout };
}

describe('baselineEnvironmentFailures', () => {
  it('finds a baseline failure whose log shows the sandbox refusing a filesystem call outside the checkout, and leaves a real compile error alone', () => {
    const { report, checkout } = baselineWith({ build: DOTNET_CRASH, compile: COMPILE_ERROR });
    const found = baselineEnvironmentFailures(lab.ctx(), report, checkout);
    expect(found).toEqual([expect.objectContaining({ checkId: 'build', fingerprint: null, signals: ['filesystem-denied'], questionId: null, logPath: join(lab.ctx().runDir, 'baseline', 'build.log') })]);
    expect(found[0]!.lines[0]).toContain('/tmp/.dotnet/shm/session53858');
  });

  it('finds a check killed by a crash signal before it printed anything', () => {
    const { report, checkout } = baselineWith({ unit: '----- Native stack trace -----\n 1: 0x1 node::Abort() [/opt/acme/bin/node]\nProcess killed by signal: SIGABRT\n' });
    expect(baselineEnvironmentFailures(lab.ctx(), report, checkout).map((f) => f.signals)).toEqual([['process-aborted']]);
  });

  it('reads the excerpt when the log is gone, and the report\'s log when there is no recorded run', () => {
    const gone = baselineWith({ build: null }, { excerpt: DOTNET_CRASH });
    expect(baselineEnvironmentFailures(lab.ctx(), gone.report, gone.checkout).map((f) => f.checkId)).toEqual(['build']);
    lab.cleanup();
    const norow = baselineWith({ build: DOTNET_CRASH }, { row: false });
    expect(baselineEnvironmentFailures(lab.ctx(), norow.report, norow.checkout).map((f) => [f.checkId, f.logPath])).toEqual([['build', join(lab.ctx().runDir, 'baseline', 'build.log')]]);
    lab.cleanup();
    const nothing = baselineWith({ build: null }, { excerpt: null });
    expect(baselineEnvironmentFailures(lab.ctx(), nothing.report, nothing.checkout)).toEqual([]);
  });

  it('finds a dotnet format check whose build host or implicit restore the sandbox refused its named pipe: no baseline exception for it', () => {
    const { report, checkout } = baselineWith({ format: FORMAT_BUILD_HOST, lint: FORMAT_RESTORE_NODE });
    const found = baselineEnvironmentFailures(lab.ctx(), report, checkout);
    expect(found.map((f) => [f.checkId, f.signals, f.questionId])).toEqual([
      ['format', ['pipe-denied'], null],
      ['lint', ['pipe-denied'], null],
    ]);
    expect(baselineEnvironmentBlockReason({ runId: 'orb-4', baseRevision: BASE_REV, failures: found })).toMatch(
      /no baseline exception is offered.*Fix: for check lint: the sandbox refuses MSBuild worker nodes their named pipe under \/tmp: the check's log ends with the fix for its command .*; and dotnet format \(check format\) takes no -m:1, which it reads as the project to format, and it loads the project through a build host/,
    );
  });

  it('reads a denial inside the baseline checkout as the code\'s', () => {
    const checkout = '/orbit/runs/acme/worktrees/baseline';
    const { report } = baselineWith({ unit: `Error: EPERM: operation not permitted, chmod '${checkout}/bin/tool'\n` });
    expect(baselineEnvironmentFailures(lab.ctx(), report, checkout)).toEqual([]);
    expect(baselineEnvironmentFailures(lab.ctx(), report, '/orbit/runs/acme/worktrees/other')).toHaveLength(1);
  });
});

describe('checksNotExecutedFor: a candidate check the sandbox refused before it ran anything', () => {
  function candidateWith(log: string, status: 'FAILED' | 'ERROR' = 'FAILED') {
    lab = makeUnitLab();
    setContract(lab);
    const ctx = lab.ctx();
    const cand = addCandidate(lab);
    const dir = join(ctx.runDir, 'evidence', String(cand.seq));
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, 'unit.log');
    writeFileSync(logPath, log);
    const row = planCheckRun(lab.db, { runId: lab.runId, candidateId: cand.id, checkId: 'unit', kind: 'command', treeHash: cand.treeHash, checkConfigHash: 'h', policyHash: ctx.run.policyHash, command: ['dotnet', 'test'], cwd: join(lab.home, 'check-1'), isolation: 'none', limitations: [] }, lab.clock);
    finishCheckRun(lab.db, row.id, { status, exitCode: 1, timedOut: false, cancelled: false, logPath, logSha256: null, fingerprint: FP, excerpt: null, artifacts: [], endedAt: lab.clock.now() });
    const report = addEvidence(lab, cand, { verdict: 'FAIL', checks: [{ id: 'unit', status, exit_code: 1, flaky: false, log: 'unit.log' }] }).report;
    return { cand, report };
  }

  it('blocks on it like a check that could not execute, with no baseline needed', () => {
    const { cand, report } = candidateWith(DOTNET_CRASH);
    expect(checksNotExecutedFor(lab.ctx(), cand, report)).toEqual([expect.objectContaining({ checkId: 'unit', fingerprint: null, signals: ['filesystem-denied'], questionId: null })]);
  });

  it('keeps a real compile error on the repair path, and judges a check that errored only by the runner\'s note', () => {
    const compile = candidateWith(COMPILE_ERROR);
    expect(checksNotExecutedFor(lab.ctx(), compile.cand, compile.report)).toEqual([]);
    lab.cleanup();
    const errored = candidateWith(DOTNET_CRASH, 'ERROR');
    expect(checksNotExecutedFor(lab.ctx(), errored.cand, errored.report)).toEqual([]);
  });
});
