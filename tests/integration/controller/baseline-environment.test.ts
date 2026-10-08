// Issue #10: a `dotnet build` check run at PREFLIGHT inside srt died in about two seconds with errno EPERM in the SDK's
// first-run NuGet migrations, before it built anything. Orbit recorded that as a pre-existing failure of the base
// revision and asked the person to accept a baseline exception; accepting it would have let a run pass with a build that
// never ran. A check the environment stopped on the base revision now ends the run BLOCKED at PREFLIGHT, with the first
// error line and the fix, and no baseline-exception question is created. A real pre-existing failure still gets one.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../../../src/controller/loop.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { baseScenario, DIAGNOSIS, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

async function drive(l: Lab, runId: string): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

function transitions(l: Lab, runId: string): string[] {
  return l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id", runId).map((r) => r.to_state);
}

/** A check script that prints what `dotnet build` printed under the sandbox (a captured log, without Orbit's footer) and fails. */
function replaying(fixture: string): string {
  const log = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/environment', fixture), 'utf8').replace(/^\[orbit\] .*\n?$/m, '');
  return `process.stdout.write(${JSON.stringify(log)});\nprocess.exit(1);\n`;
}

/** The `complete` each baseline.recorded event of the run states. */
function recordedCompleteness(l: Lab, runId: string): boolean[] {
  return l.db().all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'baseline.recorded' ORDER BY id", runId).map((r) => (JSON.parse(r.data_json) as { complete: boolean }).complete);
}

function buildLab(script: string): Lab {
  const l = makeLab({
    files: { 'tools/build.mjs': script },
    tweak: (c) => {
      c.checks.build = { ...c.checks.unit!, id: 'build', command: [process.execPath, 'tools/build.mjs'], mandatory: true };
    },
  });
  labs.push(l);
  writeScenario(l, baseScenario({ implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
  return l;
}

describe.skipIf(!canStripTypes)('controller: a check the environment stopped on the base revision', () => {
  it('the live sequence: the dotnet build dies with EPERM at PREFLIGHT, and the run ends BLOCKED with no baseline-exception question', async () => {
    const l = buildLab(replaying('dotnet-build-eperm-shm.log'));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(transitions(l, run.id)).toEqual(['PREFLIGHT', 'BLOCKED']);
    const reason = done.outcomeReason ?? '';
    expect(reason).toMatch(/^Check build could not run on the base revision [0-9a-f]{12}, and the output shows an environment cause, not a pre-existing failure/);
    // The first error line, and the fix.
    expect(reason).toContain('mkdir(\\"/tmp/.dotnet/shm/session');
    expect(reason).toContain('errno == EPERM;');
    expect(reason).toMatch(/no baseline exception is offered/);
    expect(reason).toMatch(/\. Fix: this is the \.NET runtime asking for \/tmp\/\.dotnet/);
    expect(reason).toMatch(/orbit resume \S+ runs the baseline again/);
    expect(reason).not.toMatch(/orbit decide/);
    expect(reason).not.toMatch(/[\u2013\u2014]/);

    // No question, no request to accept the failure, and no pre-existing failure recorded as such.
    expect(listQuestions(l.db(), run.id)).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.exception-request' })).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.failures' })).toEqual([]);
    const [decision] = listDecisions(l.db(), run.id, { kind: 'baseline.environment-failure' });
    expect(decision?.data).toMatchObject({ checks: [expect.objectContaining({ check_id: 'build', signals: ['filesystem-denied'], log_path: expect.stringContaining('build.log') })] });

    // The baseline is kept for the record, but a resume runs it again rather than reusing it.
    const baseline = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'baseline.json'), 'utf8')) as { complete: boolean; failures: { checkId: string }[] };
    expect(baseline.complete).toBe(false);
    // The gate and the event say what baseline.json says (issue #33): the check produced no result of its own, so the
    // baseline is incomplete, the gate is unverified (not "pass"), and baseline.recorded does not claim complete.
    const [gate] = listDecisions(l.db(), run.id, { kind: 'gate.baseline' });
    expect(gate?.data).toMatchObject({ status: 'unverified' });
    expect(gate?.summary).toMatch(/^baseline gate unverified \(notes: environment failure on the base revision, not a pre-existing failure: build/);
    expect(gate?.summary).toContain('the baseline is incomplete');
    expect(recordedCompleteness(l, run.id)).toEqual([false]);
    const final = readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'final.md'), 'utf8');
    expect(final).toMatch(/Check build could not run on the base revision/);
  }, 180_000);

  it('a real compile error on the base revision is still a pre-existing failure with its baseline-exception question', async () => {
    const l = buildLab(replaying('dotnet-build-compile-error.log'));
    const run = startLabRun(l);
    await drive(l, run.id);

    expect(transitions(l, run.id).slice(0, 2)).toEqual(['PREFLIGHT', 'CONTRACTING']);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.environment-failure' })).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.exception-request' })).toHaveLength(1);
    expect(listQuestions(l.db(), run.id).map((q) => q.id)).toEqual([expect.stringMatching(/^q-baseline-/)]);
    // A pre-existing failure is a decisive result: complete, and the gate passes with it noted.
    expect(listDecisions(l.db(), run.id, { kind: 'gate.baseline' })[0]?.data).toMatchObject({ status: 'pass' });
    expect(recordedCompleteness(l, run.id)).toEqual([true]);
  }, 240_000);
});
