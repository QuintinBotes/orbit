// Running the fail-before probe (ADR 0014 section 2) on a real repository with the real runner: each affected check on
// a checkout of the probe tree, a failing run once more, its attempts in fail_before_probes and never in check_runs,
// one decision per probe, reuse for the same tree, and every way the probe ends not established: its time bound, the
// run's remaining wall time, a refused tree, a failed install, an environment signal, a cancelled run, a crash.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { processStartTime } from '../../../src/core/proc.ts';
import { snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { atomicWriteJson } from '../../../src/core/fsx.ts';
import { changesBetween, closeInterruptedProbes, judgeProbeAttempts, listProbeAttempts, probeRecords, runFailBeforeProbe, type FailBeforeEvidence, type ProbeChange, type ProbeRequest, type ProbeResult } from '../../../src/evidence/fail-before.ts';
import { evaluateEvidence } from '../../../src/evidence/report.ts';
import { recordDecision } from '../../../src/storage/decisions.ts';
import type { EvidenceReport } from '../../../src/evidence/types.ts';
import { routeFailBefore } from '../../../src/controller/fail-before.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { CANDIDATE, CLEAN_SCOPE, contract, fakeSnapshot, result } from '../../unit/evidence/report-fixtures.ts';
import { addCandidate, addEvidence, makeUnitLab, setContract } from '../../unit/controller/coverage-helpers.ts';
import { shimPath } from '../../../src/evidence/check-shim.ts';
import { listCheckRuns } from '../../../src/evidence/store.ts';
import type { CandidateRecord } from '../../../src/evidence/store.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { isTestOwnedPath } from '../../../src/policy/test-files.ts';
import type { CheckDefinition, OrbitConfig } from '../../../src/policy/types.ts';
import { addWorktree, checkDef, makeRepo, makeRun, tempRoot, write, type TestRun } from '../../unit/evidence/fixtures.ts';

const RUNNER = "import { readdirSync } from 'node:fs';\nconst here = new URL('.', import.meta.url);\nfor (const f of readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) await import(new URL(f, here));\nconsole.log('all tests passed');\n";
const BASE = { '.gitignore': 'node_modules/\n', 'apps/calc.mjs': 'export const add = (a, b) => a + b;\n', 'tests/run.mjs': RUNNER, 'tests/add.test.mjs': "import { add } from '../apps/calc.mjs';\nif (add(2, 3) !== 5) process.exit(1);\n" };
const MUL_TEST = "import { mul } from '../apps/calc.mjs';\nif (mul(2, 3) !== 6) process.exit(1);\n";

interface Env {
  run: TestRun;
  repo: string;
  base: string;
  root: string;
  candidate: CandidateRecord;
  changes: ProbeChange[];
  decisions: { id: string; kind: string; summary: string; data: unknown }[];
  request(over?: Partial<ProbeRequest>): ProbeRequest;
}

const envs: (() => void)[] = [];
afterEach(() => envs.splice(0).forEach((close) => close()));

async function env(checks: CheckDefinition[], edit: (wt: string) => void, configure?: (c: OrbitConfig) => void): Promise<Env> {
  const t = tempRoot('orbit-probe-');
  const r = makeRepo(t.root, BASE);
  const run = makeRun(t.root, r.repo, checks, configure ? { configure } : {});
  envs.push(() => {
    run.db.close();
    t.remove();
  });
  const wt = addWorktree(r.repo, join(t.root, 'wt', 'w1'));
  edit(wt);
  const candidate = await snapshotCandidate({ db: run.db, clock: systemClock, repoRoot: r.repo, worktree: wt, runId: run.runId, baseRev: r.base, attempt: 1, workerId: 'w1' });
  const changes = (await changesBetween(r.repo, r.base, candidate.commitSha)).filter((c) => isTestOwnedPath(c.path));
  const decisions: Env['decisions'] = [];
  const e: Env = {
    run,
    repo: r.repo,
    base: r.base,
    root: t.root,
    candidate,
    changes,
    decisions,
    request: (over = {}) => ({
      runner: { db: run.db, run: { id: run.runId, policyHash: run.policyHash }, snapshot: run.snapshot, isolation: new NoIsolation(), runDir: run.runDir, clock: systemClock, pollMs: 20, killGraceMs: 300, homeDir: join(t.root, 'home') },
      repoRoot: r.repo,
      baseRev: r.base,
      candidate,
      checks: [{ checkId: 'unit', criteria: ['AC-1'] }],
      changes,
      checkoutDir: join(t.root, 'worktrees', `fail-before-${candidate.seq}`),
      timeoutMs: 120_000,
      wallRemainingMs: null,
      decide: (d) => decisions.push(d),
      ...over,
    }),
  };
  return e;
}

const unit = (over: Partial<CheckDefinition> = {}) => checkDef('unit', { command: [process.execPath, 'tests/run.mjs'], timeout_seconds: 60, ...over });
const addMul = (wt: string) => {
  write(join(wt, 'apps/calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  write(join(wt, 'tests/mul.test.mjs'), MUL_TEST);
};

describe('runFailBeforeProbe', () => {
  it('runs a failing check once more, records its attempts apart from check_runs, decides once, and reuses the result for the same tree', async () => {
    const e = await env([unit()], addMul);
    const result = await runFailBeforeProbe(e.request());
    expect(result).toMatchObject({ probeTree: expect.stringMatching(/^[0-9a-f]{40}$/), baseRevision: e.base, testPaths: ['tests/mul.test.mjs'], reused: false });
    expect(result.checks).toEqual([expect.objectContaining({ checkId: 'unit', outcome: 'failed-before', reason: 'unit failed on the base revision with the new tests (exit 1, 2 attempts)' })]);
    expect(result.checks[0]!.attempts.map((a) => [a.attempt, a.status, a.log])).toEqual([
      [1, 'FAILED', `evidence/${e.candidate.seq}/fail-before/unit.log`],
      [2, 'FAILED', `evidence/${e.candidate.seq}/fail-before/unit~1.log`],
    ]);
    expect(listProbeAttempts(e.run.db, e.run.runId).map((a) => [a.checkId, a.attempt, a.status, a.probeTree])).toEqual([
      ['unit', 1, 'FAILED', result.probeTree],
      ['unit', 2, 'FAILED', result.probeTree],
    ]);
    expect(listCheckRuns(e.run.db, { runId: e.run.runId })).toEqual([]);
    expect(e.run.db.all('SELECT * FROM failures')).toEqual([]);
    expect(e.decisions).toHaveLength(1);
    expect(e.decisions[0]).toMatchObject({ kind: 'verification.fail-before', summary: 'unit failed on the base revision with the new tests (exit 1, 2 attempts): AC-1' });

    // The decision is what a later probe of the same tree reads back; without it nothing is reused.
    recordDecision(e.run.db, e.run.runDir, { ...e.decisions[0]!, runId: e.run.runId }, systemClock);
    const again = await runFailBeforeProbe(e.request());
    expect(again).toMatchObject({ reused: true, probeTree: result.probeTree, probeId: result.probeId });
    expect(again.checks[0]).toMatchObject({ outcome: 'failed-before' });
    expect(listProbeAttempts(e.run.db, e.run.runId)).toHaveLength(2);
    expect(e.decisions).toHaveLength(1);
  }, 120_000);

  it('a check that passes on the probe tree runs once', async () => {
    const e = await env([unit()], (wt) => write(join(wt, 'tests/mul.test.mjs'), 'if (2 * 3 !== 6) process.exit(1);\n'));
    const result = await runFailBeforeProbe(e.request());
    expect(result.checks).toEqual([expect.objectContaining({ outcome: 'passed-before', attempts: [expect.objectContaining({ attempt: 1, status: 'PASSED', exitCode: 0 })] })]);
  }, 120_000);

  it('is not established when the run has less wall time left than the probe\'s bound, and nothing runs', async () => {
    const e = await env([unit()], addMul);
    const result = await runFailBeforeProbe(e.request({ timeoutMs: 900_000, wallRemainingMs: 60_000 }));
    expect(result.checks).toEqual([expect.objectContaining({ outcome: 'not-established', cause: 'budget', reason: "unit was not probed: the run has 60 s of wall time left, less than the probe's bound of 900 s (verification.fail_before_timeout_seconds)" })]);
    expect(listProbeAttempts(e.run.db, e.run.runId)).toEqual([]);
    expect(e.decisions).toEqual([]);
  }, 120_000);

  it('is not established when the probe\'s own bound runs out during a check', async () => {
    const e = await env([unit()], (wt) => write(join(wt, 'tests/slow.test.mjs'), 'await new Promise((r) => setTimeout(r, 30_000));\n'));
    const result = await runFailBeforeProbe(e.request({ timeoutMs: 2_000 }));
    expect(result.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'budget' });
    expect(result.checks[0]!.attempts.map((a) => a.status)).toEqual(['TIMEOUT']);
    expect(e.decisions).toHaveLength(1);
  }, 120_000);

  it('is not established when git refuses the probe tree', async () => {
    const e = await env([unit()], addMul);
    const gitlink: ProbeChange = { path: 'tests/vendor', status: 'A', srcMode: '000000', dstMode: '160000', srcSha: '0'.repeat(40), dstSha: e.candidate.commitSha };
    const result = await runFailBeforeProbe(e.request({ changes: [...e.changes, gitlink] }));
    expect(result.probeTree).toBeNull();
    expect(result.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'refused-tree', reason: expect.stringContaining('tests/vendor is a gitlink') });
  }, 120_000);

  it('is not established, and never offered for acceptance, when the locked install fails on the probe tree', async () => {
    const e = await env([unit()], addMul, (c) => (c.dependencies.install_command = [process.execPath, '-e', "console.error('registry unreachable'); process.exit(3)"]));
    const result = await runFailBeforeProbe(e.request());
    expect(result.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'install', reason: expect.stringMatching(/^unit was not probed: the locked install \(orbit-install\) ended FAILED on the probe tree/) });
    expect(listProbeAttempts(e.run.db, e.run.runId).map((a) => [a.checkId, a.status])).toEqual([
      ['orbit-install', 'FAILED'],
      ['orbit-install', 'FAILED'],
    ]);
  }, 120_000);

  it('is not established when the output shows an environment cause, read as on the base revision', async () => {
    const script = "console.error(\"Error: EPERM: operation not permitted, mkdir '/private/var/orbit-elsewhere/cache'\"); process.exit(1);";
    const e = await env([unit({ command: [process.execPath, '-e', script] })], addMul);
    const result = await runFailBeforeProbe(e.request());
    expect(result.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'environment' });
    expect(result.checks[0]!.attempts[0]!.signals).toEqual(['filesystem-denied']);
    expect(listProbeAttempts(e.run.db, e.run.runId)[0]!.signals).toEqual(['filesystem-denied']);
  }, 120_000);

  it('is not established, as an ERROR, when the runner cannot start a check on the probe tree', async () => {
    const e = await env([unit({ cwd: 'packages/absent' })], addMul);
    const result = await runFailBeforeProbe(e.request());
    expect(result.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'error', reason: expect.stringMatching(/^unit could not be run on the probe tree: check cwd packages\/absent does not exist in the checkout/) });
    expect(e.decisions).toHaveLength(1);
  }, 120_000);

  // Adversarial review (finding 3): only the first 4 MiB of a log were read for environment signals, so a denial after
  // that much output, on two failing attempts, was judged failed-before.
  it('reads the whole log for environment signals: a denial after 4 MiB of output is not established, not failed-before', async () => {
    // One write, on stdout, so the denial is surely after the padding: about 4.8 MB of plain lines, then the EPERM line.
    const script = ["const line = 'y'.repeat(1023) + String.fromCharCode(10);", "let out = '';", 'for (let i = 0; i < 4700; i++) out += line;', "out += \"Error: EPERM: operation not permitted, mkdir '/private/var/orbit-elsewhere/cache'\" + String.fromCharCode(10);", 'process.stdout.write(out);', 'process.exitCode = 1;'].join(' ');
    const e = await env([unit({ command: [process.execPath, '-e', script] })], addMul);
    const result = await runFailBeforeProbe(e.request());
    expect(result.checks[0]!.attempts[0]!.signals).toEqual(['filesystem-denied']);
    expect(result.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'environment' });
  }, 120_000);

  it('an attempt whose output was cut short cannot be fully scanned, so it is never failed-before', async () => {
    const script = "process.stdout.write('z'.repeat(5000)); process.exitCode = 1;";
    const e = await env([unit({ command: [process.execPath, '-e', script] })], addMul);
    const result = await runFailBeforeProbe(e.request({ runner: { ...e.request().runner, maxOutputBytes: 1000 } }));
    expect(result.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'unscanned' });
    expect(result.checks[0]!.reason).toMatch(/output was cut short/);
  }, 120_000);

  it('starts nothing for a cancelled run and records no decision', async () => {
    const e = await env([unit()], addMul);
    e.run.db.run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', e.run.runId);
    const result = await runFailBeforeProbe(e.request());
    expect(result.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'cancelled' });
    expect(e.decisions).toEqual([]);
  }, 120_000);
});

describe('closeInterruptedProbes', () => {
  it('stops the check a stopped controller left running and closes its attempt as interrupted', async () => {
    const e = await env([unit()], addMul);
    const records = probeRecords('probe-crashed');
    const row = records.plan(e.run.db, { runId: e.run.runId, candidateId: e.candidate.id, checkId: 'unit', kind: 'command', treeHash: 'tree-x', checkConfigHash: 'h', policyHash: e.run.policyHash, command: ['node'], cwd: '.', isolation: 'none', limitations: [] }, systemClock);
    // A process standing in for the shim and its check group, as the attempt's launch and pid records name them.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { detached: true, stdio: 'ignore' });
    const pid = child.pid!;
    records.running(e.run.db, row.id, pid, systemClock);
    const dir = join(e.run.runDir, 'evidence', String(e.candidate.seq), 'fail-before', 'unit');
    mkdirSync(dir, { recursive: true });
    atomicWriteJson(shimPath(dir, 'intent'), { token: 't1', checkRunId: row.id, argv: ['node'], cwd: '.', timeoutMs: 1000, killGraceMs: 100, maxOutputBytes: 1000, writtenAt: Date.now() });
    atomicWriteJson(shimPath(dir, 'launch'), { token: 't1', pid, procStart: processStartTime(pid) });
    atomicWriteJson(shimPath(dir, 'pid'), { token: 't1', shimPid: pid, childPgid: pid, startedAt: Date.now() });
    const exited = new Promise<void>((done) => child.on('exit', () => done()));

    expect(closeInterruptedProbes(e.run.db, e.run.runDir, e.run.runId, systemClock)).toEqual([row.id]);
    await exited;
    const [closed] = listProbeAttempts(e.run.db, e.run.runId);
    expect(closed).toMatchObject({ id: row.id, status: 'CANCELLED' });
    expect(e.run.db.get<{ excerpt: string }>('SELECT excerpt FROM fail_before_probes WHERE id = ?', row.id)?.excerpt).toMatch(/^interrupted/);
    expect(closeInterruptedProbes(e.run.db, e.run.runDir, e.run.runId, systemClock)).toEqual([]);
  }, 60_000);
});

// Second adversarial review (findings A and B), and the decision the coordinator took on them: failed-before needs the
// whole log classified in ONE pass of the classifier (200,000 lines) and nothing dropped; every log is still scanned for
// causes in overlapping windows, and a cause no person may accept wins; an ERROR stays ERROR whatever its log. Each case
// runs through the probe, the report under required and VERIFYING's routing.
const required = fakeSnapshot([checkDef('unit')], (c) => (c.verification.fail_before = 'required'));
const oneCriterion = contract({ acceptance_criteria: [{ id: 'AC-1', statement: 'mul multiplies', proof: ['tests/mul.test.mjs'], mandatory: true, check_ids: ['unit'] }], required_check_ids: ['unit'] });
const report = (probe: ProbeResult, accepted: FailBeforeEvidence['accepted'] = []) =>
  evaluateEvidence({
    contract: oneCriterion,
    candidate: CANDIDATE,
    checkResults: [result(required, 'unit')],
    scope: CLEAN_SCOPE,
    snapshot: required,
    base: { treeHash: 'tree-base', checks: [{ checkId: 'unit', status: 'PASSED' }], changedPaths: ['tests/mul.test.mjs'] },
    failBefore: { mode: 'required', probe, skipped: null, accepted },
  }).report;
/** What VERIFYING does with the report: whether it asks a person, and why it blocks. */
const route = async (r: EvidenceReport): Promise<{ questions: number; reason: string }> => {
  const lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING'] });
  try {
    setContract(lab);
    const cand = addCandidate(lab);
    const ev = addEvidence(lab, cand, { verdict: r.verdict, acceptance_evidence: r.acceptance_evidence });
    await routeFailBefore(lab.ctx(), cand, ev, async () => null);
    return { questions: listQuestions(lab.db, lab.runId).length, reason: getRun(lab.db, lab.runId).outcomeReason ?? '' };
  } finally {
    lab.cleanup();
  }
};
const ACCEPTED = [{ criterionId: 'AC-1', questionId: 'q-fb-1', by: 'acme-dev' }];
const nodeScript = (lines: string[]) => unit({ command: [process.execPath, '-e', lines.join(' ')], timeout_seconds: 120 });

describe('second review: how a probe attempt\'s log is judged', () => {
  it('A: an MSBuild crash header and its refused socket on either side of line 100,000 are one environment cause, never failed-before', async () => {
    const e = await env(
      [
        nodeScript([
          "const nl = String.fromCharCode(10);",
          "let out = 'ok' + nl;",
          'out = out.repeat(99999);',
          "out += 'MSBUILD : error MSB1025: An internal failure occurred while running MSBuild.' + nl;",
          "out += 'System.Net.Sockets.SocketException (13): Permission denied' + nl;",
          'process.stdout.write(out);',
          'process.exitCode = 1;',
        ]),
      ],
      addMul,
    );
    const probed = await runFailBeforeProbe(e.request());
    expect(probed.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'environment' });
    expect(probed.checks[0]!.attempts[0]!.signals).toEqual(['socket-denied']);
    expect(report(probed, ACCEPTED).acceptance_evidence[0]).toMatchObject({ status: 'blocked', fail_before: { outcome: 'not-established', cause: 'environment' } });
    expect(report(probed, ACCEPTED).acceptance_evidence[0]!.fail_before!.accepted).toBeUndefined();
    const routed = await route(report(probed));
    expect(routed.questions).toBe(0);
    expect(routed.reason).toMatch(/AC-1: the cause is the environment's/);
  }, 180_000);

  it('B: a denial in the retained part of a cut-short log is an environment cause, not unscanned, and no acceptance is offered', async () => {
    const e = await env([nodeScript(["process.stdout.write(\"Error: EPERM: operation not permitted, mkdir '/private/var/orbit-elsewhere/cache'\" + String.fromCharCode(10) + 'z'.repeat(5000));", 'process.exitCode = 1;'])], addMul);
    const probed = await runFailBeforeProbe(e.request({ runner: { ...e.request().runner, maxOutputBytes: 2000 } }));
    expect(probed.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'environment' });
    expect(report(probed, ACCEPTED).acceptance_evidence[0]).toMatchObject({ status: 'blocked', fail_before: { cause: 'environment' } });
    const routed = await route(report(probed));
    expect(routed.questions).toBe(0);
    expect(routed.reason).toMatch(/AC-1: the cause is the environment's/);
  }, 180_000);

  it('B: an ERROR attempt whose log was cut short stays ERROR, and no acceptance is offered', async () => {
    const attempts = [{ attempt: 1, status: 'ERROR' as const, exitCode: null, signals: [], unscanned: 'its output was cut short (the runner kept only part of it), so an environment cause in the dropped part cannot be ruled out', log: 'evidence/1/fail-before/unit.log' }];
    const judged = judgeProbeAttempts('unit', attempts);
    expect(judged).toMatchObject({ outcome: 'not-established', cause: 'error' });
    const probed: ProbeResult = { probeId: 'probe-1', probeTree: 'tree-probe', baseRevision: 'b'.repeat(40), testPaths: ['tests/mul.test.mjs'], checks: [judged], reused: false };
    expect(report(probed, ACCEPTED).acceptance_evidence[0]).toMatchObject({ status: 'blocked', fail_before: { cause: 'error' } });
    const routed = await route(report(probed));
    expect(routed.questions).toBe(0);
  });

  it('a long clean failing log over one pass of the classifier is not failed-before: not established as unscanned, and a person may accept it', async () => {
    const e = await env([nodeScript(["process.stdout.write(('ok' + String.fromCharCode(10)).repeat(200001));", 'process.exitCode = 1;'])], addMul);
    const probed = await runFailBeforeProbe(e.request());
    expect(probed.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'unscanned' });
    expect(probed.checks[0]!.attempts.map((a) => a.status)).toEqual(['FAILED', 'FAILED']);
    expect(probed.checks[0]!.reason).toMatch(/more than one pass of the environment classifier reads \(200000\)/);
    expect(report(probed, ACCEPTED).acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { cause: 'unscanned', accepted: { question_id: 'q-fb-1' } } });
    const routed = await route(report(probed));
    expect(routed.questions).toBe(1);
    expect(routed.reason).toMatch(/could not be judged on the probe tree/);
  }, 180_000);
});

// Third adversarial review. (1) A passing attempt's log was never read, so a check whose shell pipeline hides a failing
// command's exit status, with the sandbox's network refusal in its output, was passed-before, and under required reached
// a person's acceptance. (2) The locked install ignored the probe's one bound: it ran with its own 900 s timeout and
// started its retry after the bound had run out.
describe('third review: every attempt\'s log is read, and the install keeps to the probe\'s bound', () => {
  it('an exit 0 attempt whose log shows a network denial is not established as an environment cause, never passed-before, and not reused', async () => {
    const e = await env([unit({ command: ["false || echo 'curl: (56) CONNECT tunnel failed, response 403; Connection blocked by network allowlist'; true"], shell: true })], addMul);
    const probed = await runFailBeforeProbe(e.request());
    expect(probed.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'environment' });
    expect(probed.checks[0]!.attempts.map((a) => [a.status, a.signals])).toEqual([['PASSED', ['network-denied']]]);
    expect(report(probed, ACCEPTED).acceptance_evidence[0]).toMatchObject({ status: 'blocked', fail_before: { outcome: 'not-established', cause: 'environment' } });
    expect(report(probed, ACCEPTED).acceptance_evidence[0]!.fail_before!.accepted).toBeUndefined();
    const routed = await route(report(probed));
    expect(routed.questions).toBe(0);
    expect(routed.reason).toMatch(/AC-1: the cause is the environment's/);
    // The decision a later candidate of the same tree reads back holds no reusable passed-before.
    recordDecision(e.run.db, e.run.runDir, { ...e.decisions[0]!, runId: e.run.runId }, systemClock);
    const again = await runFailBeforeProbe(e.request());
    expect(again.reused).toBe(false);
    expect(again.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'environment' });
  }, 120_000);

  it('cuts the install at the probe\'s bound, starts no retry after it, and ends not established for the budget, not as an install failure', async () => {
    const slow = [process.execPath, '-e', 'setTimeout(() => process.exit(1), 20_000)'];
    const e = await env([unit()], addMul, (c) => (c.dependencies.install_command = slow));
    const started = Date.now();
    const probed = await runFailBeforeProbe(e.request({ timeoutMs: 2_000, wallRemainingMs: 60_000 }));
    const took = Date.now() - started;
    expect(probed.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'budget' });
    expect(probed.checks[0]!.reason).toMatch(/the probe's bound of 2 s \(verification\.fail_before_timeout_seconds\) ran out/);
    expect(listProbeAttempts(e.run.db, e.run.runId).map((a) => [a.checkId, a.status])).toEqual([['orbit-install', 'TIMEOUT']]);
    expect(took).toBeLessThan(15_000);
  }, 120_000);

  it('does not probe after an install that exits 0 but whose log shows an environment cause', async () => {
    // An install that could not reach a host can still exit 0. On the candidate that only makes its tests fail; on the
    // probe tree a failing test is the evidence, so such an install must stop the probe as an environment cause.
    const denied = ['sh', '-c', "echo 'curl: (56) CONNECT tunnel failed, response 403; Connection blocked by network allowlist'; exit 0"];
    const e = await env([unit()], addMul, (c) => (c.dependencies.install_command = denied));
    const probed = await runFailBeforeProbe(e.request());
    expect(probed.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'environment' });
    expect(listProbeAttempts(e.run.db, e.run.runId).map((a) => [a.checkId, a.status])).toEqual([['orbit-install', 'PASSED']]);
  }, 120_000);

  it('does not probe after a passing install whose log was cut short, since a dropped line may hold an environment cause', async () => {
    const padded = ['sh', '-c', "head -c 1500 /dev/zero | tr '\\0' x; echo; echo 'curl: (56) CONNECT tunnel failed, response 403; Connection blocked by network allowlist'; exit 0"];
    const e = await env([unit()], addMul, (c) => (c.dependencies.install_command = padded));
    const probed = await runFailBeforeProbe(e.request({ runner: { ...e.request().runner, maxOutputBytes: 1000 } }));
    expect(probed.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'unscanned' });
    expect(probed.checks[0]!.outcome).not.toBe('failed-before');
  }, 120_000);

  it('does not probe after a passing retry when an earlier install attempt\'s log was cut short', async () => {
    // The first attempt fails with its denial past the output cap; the retry passes with a complete, clean log.
    const marker = join(mkdtempSync(join(tmpdir(), 'orbit-fb-install-')), 'tried');
    const script = `if [ -e '${marker}' ]; then exit 0; fi; touch '${marker}'; head -c 1500 /dev/zero | tr '\\0' x; echo; echo 'curl: (56) CONNECT tunnel failed, response 403; Connection blocked by network allowlist'; exit 1`;
    const e = await env([unit()], addMul, (c) => (c.dependencies.install_command = ['sh', '-c', script]));
    const probed = await runFailBeforeProbe(e.request({ runner: { ...e.request().runner, maxOutputBytes: 1000 } }));
    expect(listProbeAttempts(e.run.db, e.run.runId).map((a) => [a.checkId, a.status])).toEqual([['orbit-install', 'FAILED'], ['orbit-install', 'PASSED']]);
    expect(probed.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'unscanned' });
  }, 120_000);

  it('keeps an install that failed as the install\'s cause, never accepted, when its retry is cut short by the bound', async () => {
    // The first attempt fails at about 1.2 s; the retry gets what is left of the 2 s bound and is cut short.
    const failing = [process.execPath, '-e', 'setTimeout(() => process.exit(1), 1_200)'];
    const e = await env([unit()], addMul, (c) => (c.dependencies.install_command = failing));
    const probed = await runFailBeforeProbe(e.request({ timeoutMs: 2_000, wallRemainingMs: 60_000 }));
    expect(probed.checks[0]).toMatchObject({ outcome: 'not-established', cause: 'install' });
    expect(listProbeAttempts(e.run.db, e.run.runId)[0]).toMatchObject({ checkId: 'orbit-install', status: 'FAILED' });
  }, 120_000);
});
