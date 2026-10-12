// Running the fail-before probe (ADR 0014 section 2) on a real repository with the real runner: each affected check on
// a checkout of the probe tree, a failing run once more, its attempts in fail_before_probes and never in check_runs,
// one decision per probe, reuse for the same tree, and every way the probe ends not established: its time bound, the
// run's remaining wall time, a refused tree, a failed install, an environment signal, a cancelled run, a crash.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { processStartTime } from '../../../src/core/proc.ts';
import { snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { atomicWriteJson } from '../../../src/core/fsx.ts';
import { changesBetween, closeInterruptedProbes, listProbeAttempts, probeRecords, runFailBeforeProbe, type ProbeChange, type ProbeRequest } from '../../../src/evidence/fail-before.ts';
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
    const { recordDecision } = await import('../../../src/storage/decisions.ts');
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
