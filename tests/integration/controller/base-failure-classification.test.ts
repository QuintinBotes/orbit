// How PREFLIGHT classifies a mandatory check that fails on the base revision (ADR 0010), driven end to end with real
// failing commands: a stand-in `dotnet` on the check's PATH that prints exactly what the real one printed and exits as it
// did, a program that is not installed under a real shell, the real npm, and a real Python unittest.
//
// Issue #10, retested: three .NET checks died in the sandbox with "MSBUILD : error MSB1025" and
// "System.Net.Sockets.SocketException (13): Permission denied", and PREFLIGHT went on to CONTRACTING "with 3 pre-existing
// failure(s)", each with a baseline-exception question. Issue #23: `dotnet build A.csproj B.csproj`, which dotnet rejects
// with "MSBUILD : error MSB1008: Only one project can be specified." in under a second, was offered as a baseline
// exception. Both now end the run BLOCKED at PREFLIGHT with the classification, the first error line and the fix, and no
// question; a test that merely reports "permission denied" in a failing assertion is still a pre-existing failure. A
// check whose command names something that does not exist yet (npm's missing script) goes on to CONTRACTING: expected
// to flip when the contract names it, misconfigured when it does not. A denial a candidate brings goes to repair.
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { frozenPolicySetting, resumeTarget } from '../../../src/controller/resume.ts';
import { acquireLease, getRun, releaseLease, transition } from '../../../src/controller/run-store.ts';
import { listCheckRuns } from '../../../src/evidence/store.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { which } from '../../../src/isolation/util.ts';
import { buildTimeline } from '../../../src/observability/timeline.ts';
import type { CheckDefinition } from '../../../src/policy/types.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { baseScenario, DIAGNOSIS, IMPLEMENTER_OUTPUT, implementMul, labDeps, makeLab, MUL_TEST, PLANNER_OUTPUT, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (dir: string, name: string): string => readFileSync(join(here, '../../fixtures', dir, name), 'utf8').replace(/^\[orbit\] .*\n?$/m, '');

const labs: Lab[] = [];
const bins: string[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
  for (const b of bins.splice(0)) rmSync(b, { recursive: true, force: true });
});

/** A directory for the check's PATH holding a stand-in program that prints `output` and exits with `exit`. */
function binWith(name: string, output: string, exit: number): string {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-bin-')));
  bins.push(bin);
  install(bin, name, output, exit);
  return bin;
}

function install(bin: string, name: string, output: string, exit: number): void {
  const path = join(bin, name);
  writeFileSync(path, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(${exit});\n`);
  chmodSync(path, 0o755);
}

const PACKAGE_JSON = JSON.stringify({ name: 'acme', version: '1.0.0', private: true, scripts: { test: 'node tests/run.mjs' } });

function labWith(checks: Record<string, Partial<CheckDefinition>>, files: Record<string, string> = {}, tweak?: (c: Lab['config']) => void): Lab {
  const l = makeLab({
    files,
    tweak: (c) => {
      for (const [id, d] of Object.entries(checks)) c.checks[id] = { ...c.checks.unit!, id, mandatory: true, ...d };
      tweak?.(c);
    },
  });
  labs.push(l);
  writeScenario(l, baseScenario({ implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
  return l;
}

async function drive(l: Lab, runId: string): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

function transitions(l: Lab, runId: string): string[] {
  return l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id", runId).map((r) => r.to_state);
}

/** What `orbit resume --force` does for a run blocked at PREFLIGHT. */
function resume(l: Lab, runId: string): void {
  acquireLease(l.db(), runId, 'person-resume', 60_000, systemClock);
  transition(l.db(), { runId, to: resumeTarget(l.db(), getRun(l.db(), runId)), ownerId: 'person-resume', reason: 'resumed with --force', actor: 'acme-dev', expectedFrom: 'BLOCKED' }, systemClock);
  releaseLease(l.db(), runId, 'person-resume');
}

const PATH = (bin: string): Record<string, string> => ({ PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` });

function expectNoException(l: Lab, runId: string): void {
  expect(listQuestions(l.db(), runId)).toEqual([]);
  expect(listDecisions(l.db(), runId, { kind: 'baseline.exception-request' })).toEqual([]);
  expect(listDecisions(l.db(), runId, { kind: 'baseline.failures' })).toEqual([]);
}

describe.skipIf(!canStripTypes)('PREFLIGHT classifies a base-revision failure', () => {
  it('issue #10: three .NET checks refused a socket by the sandbox are an environment failure: BLOCKED with the first error line once and the verified fix, and no question', async () => {
    // The real MSB1025 crash, captured under Orbit's runner and srt on macOS: `dotnet test` of an xunit project that
    // references two class libraries, after about five minutes of MSBuild's node retries.
    const bin = binWith('dotnet', fixture('environment', 'dotnet-test-msbuild-node-pipe-eacces.log'), 1);
    const l = labWith({ build: { command: ['dotnet', 'build'], env: PATH(bin) }, test: { command: ['dotnet', 'test'], env: PATH(bin) }, format: { command: ['dotnet', 'format', '--verify-no-changes'], env: PATH(bin) } });
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(transitions(l, run.id)).toEqual(['PREFLIGHT', 'BLOCKED']);
    const reason = done.outcomeReason ?? '';
    expect(reason).toMatch(/^Checks build, test, format could not run on the base revision [0-9a-f]{12}, and the output shows an environment cause, not a pre-existing failure: the sandbox or the operating system refused the tool a socket/);
    // Named once, then the shared evidence once: not once per check.
    expect(reason.match(/MSBUILD : error MSB1025: An internal failure occurred while running MSBuild\./g)).toHaveLength(1);
    expect(reason.match(/System\.Net\.Sockets\.SocketException \(13\): Permission denied/g)).toHaveLength(1);
    // -m:1 for the two MSBuild commands; dotnet format takes no -m:1 (it reads it as a project and fails).
    expect(reason).toMatch(/\. Fix: for checks build, test: this is MSBuild starting a worker node, whose named pipe \.NET makes a Unix socket under \/tmp.*-m:1 on the check's dotnet command/);
    expect(reason).toMatch(/; and dotnet format \(check format\) takes no -m:1, which it reads as the project to format/);
    expect(reason.match(/-m:1 on the check's dotnet command/g)).toHaveLength(1);
    expect(reason).not.toMatch(/nodeReuse|UseSharedCompilation|MSBUILDDISABLENODEREUSE|DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER/);
    expect(reason).not.toMatch(/orbit decide/);
    expect(reason).not.toMatch(/[\u2013\u2014]/);
    for (const sentence of reason.split(/(?<=[a-z0-9)"\]])\. (?=\S)/)) expect(sentence, sentence).toMatch(/^[A-Z]/);
    expectNoException(l, run.id);

    const [decision] = listDecisions(l.db(), run.id, { kind: 'baseline.environment-failure' });
    expect((decision?.data as { checks: unknown[] }).checks).toEqual(['build', 'test', 'format'].map((id) => expect.objectContaining({ check_id: id, classification: 'environment', signals: ['socket-denied'] })));
    const baseline = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'baseline.json'), 'utf8')) as { complete: boolean; failures: { checkId: string; classification?: string; signals?: string[] }[] };
    expect(baseline.complete).toBe(false);
    expect(baseline.failures.map((f) => [f.checkId, f.classification, f.signals])).toEqual([['build', 'environment', ['socket-denied']], ['test', 'environment', ['socket-denied']], ['format', 'environment', ['socket-denied']]]);
    const timeline = buildTimeline(l.db(), getRun(l.db(), run.id)).entries.map((e) => e.text);
    expect(timeline).toContainEqual(expect.stringContaining('build, test, format classified as an environment failure, not a pre-existing failure: "MSBUILD : error MSB1025: An internal failure occurred while running MSBuild."'));

    // The environment is not in the frozen policy: once it is fixed, `orbit resume` runs the three checks again.
    expect(frozenPolicySetting(getRun(l.db(), run.id))).toBeNull();
    install(bin, 'dotnet', 'Build succeeded.\n', 0);
    resume(l, run.id);
    await drive(l, run.id);
    expect(transitions(l, run.id).slice(0, 4)).toEqual(['PREFLIGHT', 'BLOCKED', 'PREFLIGHT', 'CONTRACTING']);
    for (const id of ['build', 'test', 'format']) expect(listCheckRuns(l.db(), { runId: run.id, candidateId: null, checkId: id, rootsOnly: true }).map((r) => r.status), id).toEqual(['FAILED', 'PASSED']);
    expectNoException(l, run.id);
  }, 240_000);

  it('issue #23: a dotnet command line the tool rejects is a misconfigured check: BLOCKED naming the check, the error line and checks.build.command, and no question', async () => {
    const bin = binWith('dotnet', fixture('misconfigured', 'dotnet-msb1008-one-project.log'), 1);
    const l = labWith({ build: { command: ['dotnet', 'build', 'A.csproj', 'B.csproj'], env: PATH(bin) } });
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(transitions(l, run.id)).toEqual(['PREFLIGHT', 'BLOCKED']);
    const reason = done.outcomeReason ?? '';
    expect(reason).toMatch(/^Check build is misconfigured, not a pre-existing failure: on the base revision [0-9a-f]{12} /);
    expect(reason).toContain('"MSBUILD : error MSB1008: Only one project can be specified."');
    expect(reason).toContain('command in checks.build.command');
    expect(reason).toMatch(/no baseline exception is offered/);
    // The command is in the run's frozen policy: a resume alone would only block again.
    expect(reason).toMatch(/This comes from the run's frozen policy \(checks\.build\.command\)/);
    expect(frozenPolicySetting(getRun(l.db(), run.id))).toBe('checks.build.command');
    expect(reason).not.toMatch(/orbit decide/);
    expect(reason).not.toMatch(/[\u2013\u2014]/);
    expectNoException(l, run.id);

    const [decision] = listDecisions(l.db(), run.id, { kind: 'baseline.check-misconfigured' });
    expect(decision?.data).toMatchObject({ checks: [expect.objectContaining({ check_id: 'build', classification: 'misconfigured', signature: 'msbuild-one-project', config_key: 'checks.build.command', evidence_lines: ['MSBUILD : error MSB1008: Only one project can be specified.', 'Switch: B.csproj'] })] });
    expect(JSON.parse(getRun(l.db(), run.id).outcomeJson ?? '{}')).toMatchObject({ misconfigured_checks: [expect.objectContaining({ check_id: 'build', classification: 'misconfigured' })] });
    const timeline = buildTimeline(l.db(), getRun(l.db(), run.id)).entries.map((e) => e.text);
    expect(timeline).toContainEqual(expect.stringContaining('build classified as a misconfigured check (checks.build.command), not a pre-existing failure: "MSBUILD : error MSB1008: Only one project can be specified."'));
    expect(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'final.md'), 'utf8')).toMatch(/Check build is misconfigured/);
    const [gate] = listDecisions(l.db(), run.id, { kind: 'gate.baseline' });
    expect(gate?.summary).toContain('misconfigured check on the base revision, not a pre-existing failure: build');
    expect(gate?.summary).not.toContain('pre-existing failure on the base revision: build');

    // `orbit resume --force` with nothing fixed runs the baseline again and blocks again, cleanly.
    resume(l, run.id);
    await drive(l, run.id);
    const again = runState(l, run.id);
    expect(again.state).toBe('BLOCKED');
    expect(again.outcomeReason).toMatch(/^Check build is misconfigured/);
    expect(l.db().all("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'step.error'", run.id)).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.check-misconfigured' })).toHaveLength(2);
    expectNoException(l, run.id);
  }, 240_000);

  it('issue #23: a forced resume of a misconfigured check runs the same command again, so it goes on once the tool changed outside the policy', async () => {
    // The command stays what the frozen policy says (a PREFLIGHT block marks the baseline incomplete, so the check runs
    // again): what changes is the tool the command runs, as when a plugin that was missing is installed.
    const bin = binWith('dotnet', fixture('misconfigured', 'dotnet-msb1008-one-project.log'), 1);
    const l = labWith({ build: { command: ['dotnet', 'build', 'A.csproj', 'B.csproj'], env: PATH(bin) } });
    const run = startLabRun(l);
    await drive(l, run.id);
    expect(runState(l, run.id).state).toBe('BLOCKED');
    expect(frozenPolicySetting(getRun(l.db(), run.id))).toBe('checks.build.command');

    install(bin, 'dotnet', 'Build succeeded.\n', 0);
    resume(l, run.id);
    await drive(l, run.id);
    expect(transitions(l, run.id).slice(0, 4)).toEqual(['PREFLIGHT', 'BLOCKED', 'PREFLIGHT', 'CONTRACTING']);
    expect(listCheckRuns(l.db(), { runId: run.id, candidateId: null, checkId: 'build', rootsOnly: true }).map((r) => r.status)).toEqual(['FAILED', 'PASSED']);
    expectNoException(l, run.id);
  }, 240_000);

  it('a program that is not installed (exit 127) is an environment failure, and orbit resume goes on once it is installed', async () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-bin-')));
    bins.push(bin);
    const l = labWith({ build: { command: ['orbit-acme-missing-tool build'], shell: true, env: PATH(bin) } });
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/^Check build could not run on the base revision [0-9a-f]{12}, and the output shows an environment cause, not a pre-existing failure: the program "orbit-acme-missing-tool" was not found where the check runs \(exit 127\)/);
    expect(done.outcomeReason).toMatch(/orbit-acme-missing-tool: (?:command )?not found/);
    expect(done.outcomeReason).toMatch(/\. Fix: install the program where the check runs, or give the check a PATH that holds it/);
    // Not the frozen policy's: installing the program is the fix, and a plain resume runs the baseline again.
    expect(frozenPolicySetting(getRun(l.db(), run.id))).toBeNull();
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.environment-failure' })[0]?.data).toMatchObject({ checks: [expect.objectContaining({ check_id: 'build', signals: ['program-not-found'] })] });
    expectNoException(l, run.id);

    install(bin, 'orbit-acme-missing-tool', 'built\n', 0);
    resume(l, run.id);
    await drive(l, run.id);
    expect(transitions(l, run.id).slice(0, 4)).toEqual(['PREFLIGHT', 'BLOCKED', 'PREFLIGHT', 'CONTRACTING']);
    expect(listCheckRuns(l.db(), { runId: run.id, candidateId: null, checkId: 'build', rootsOnly: true }).map((r) => r.status)).toEqual(['FAILED', 'PASSED']);
    expect(listCheckRuns(l.db(), { runId: run.id, candidateId: null, checkId: 'unit', rootsOnly: true })).toHaveLength(1);
  }, 240_000);

  it.skipIf(which('npm', process.env.PATH) === null)('the real npm with a missing script the contract does not name: a missing target, BLOCKED at CONTRACTING as misconfigured', async () => {
    const l = labWith({ lint: { command: ['npm', 'run', 'lint'] } }, { 'package.json': PACKAGE_JSON });
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    // PREFLIGHT lets it through to CONTRACTING, where the contract (unit is the only proof) does not expect it to flip.
    expect(transitions(l, run.id)).toEqual(['PREFLIGHT', 'CONTRACTING', 'BLOCKED']);
    const reason = done.outcomeReason ?? '';
    expect(reason).toMatch(/^Check lint is misconfigured, not a pre-existing failure: on the base revision [0-9a-f]{12} the check's command names something that does not exist, and the contract does not name it as the proof of any criterion/);
    expect(reason).toMatch(/"npm (?:error|ERR!) Missing script: \\"lint\\""/);
    // The block's own advice, not the generic frozen-policy one: three causes, each with what a new run needs.
    expect(reason).toMatch(/\. Fix, by cause: when the goal is meant to create what the command names, say so in the goal of a new run, so that the contract names the check as the proof of a criterion and expects it to flip; when a tool that is not installed or restored yet provides it \(a cargo plugin, a dotnet local tool\), install or restore it and then start a new run, because this run reads the baseline it recorded and does not look again; when the command is wrong, correct checks\.lint\.command in \.orbit\/config\.yaml and start a new run\. Resuming this run would only block again, so cancel it \(orbit cancel orb-[\w-]+\) and start the new run with orbit run\.$/);
    expect(reason).not.toMatch(/This comes from the run's frozen policy|Fix the config/);
    // Still a frozen-policy block: `orbit resume` refuses it (exit 5).
    expect(frozenPolicySetting(getRun(l.db(), run.id))).toBe('checks.lint.command');
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.missing-target' })[0]?.data).toMatchObject({ checks: [expect.objectContaining({ check_id: 'lint', kind: 'missing-target', signature: 'npm-missing-script' })] });
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.check-misconfigured' })[0]?.data).toMatchObject({ stage: 'CONTRACTING', checks: [expect.objectContaining({ check_id: 'lint', classification: 'misconfigured', kind: 'missing-target' })] });
    // Its question was raised for P18 and withdrawn by the block; it was never a pre-existing failure.
    expect(listQuestions(l.db(), run.id).map((q) => q.status)).toEqual(['withdrawn']);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.failures' })).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.expected-to-flip' })).toEqual([]);
    // A frozen-policy block a forced resume cannot clear: the reason names a new run, not orbit resume --force.
    expect(reason).not.toMatch(/--force/);
    expect(reason).not.toMatch(/orbit resume/);
  }, 180_000);

  it('a cargo plugin nothing provides yet is a missing target too: BLOCKED at CONTRACTING, and installing it does not clear the block, only a new run does', async () => {
    // `cargo nextest run` with cargo-nextest not installed: cargo's own words, exit 101. The plugin is supplied from
    // outside the repository, so no contract of this run creates it.
    const bin = binWith('cargo', fixture('misconfigured', 'cargo-plugin-not-installed.log'), 101);
    const l = labWith({ nextest: { command: ['cargo', 'nextest', 'run'], env: PATH(bin) } });
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(transitions(l, run.id)).toEqual(['PREFLIGHT', 'CONTRACTING', 'BLOCKED']);
    const reason = done.outcomeReason ?? '';
    expect(reason).toMatch(/^Check nextest is misconfigured, not a pre-existing failure: on the base revision [0-9a-f]{12} /);
    expect(reason).toContain('"error: no such command: `nextest`"');
    expect(reason).toContain('when a tool that is not installed or restored yet provides it (a cargo plugin, a dotnet local tool), install or restore it and then start a new run, because this run reads the baseline it recorded and does not look again');
    expect(reason).not.toMatch(/--force|orbit resume|This comes from the run's frozen policy/);
    expect(frozenPolicySetting(getRun(l.db(), run.id))).toBe('checks.nextest.command');

    // What the advice says: the plugin is installed now, and resuming still blocks on the recorded baseline.
    install(bin, 'cargo', 'tested\n', 0);
    resume(l, run.id);
    await drive(l, run.id);
    const again = runState(l, run.id);
    expect(again.state).toBe('BLOCKED');
    expect(again.outcomeReason).toMatch(/^Check nextest is misconfigured/);
    expect(l.db().all("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'step.error'", run.id)).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.check-misconfigured' })).toHaveLength(2);
  }, 180_000);

  it.skipIf(which('npm', process.env.PATH) === null)('a missing target the contract does not name blocks before the contract settles anything: another check\'s question stays open', async () => {
    // unit fails on the base revision (tests/mul.test.mjs needs mul) and is the contract's proof, so a contract that
    // went on would withdraw its question as expected to flip; lint's script is missing and no criterion names it.
    const l = labWith({ lint: { command: ['npm', 'run', 'lint'] } }, { 'package.json': PACKAGE_JSON, 'tests/mul.test.mjs': MUL_TEST });
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(transitions(l, run.id)).toEqual(['PREFLIGHT', 'CONTRACTING', 'BLOCKED']);
    expect(done.outcomeReason).toMatch(/^Check lint is misconfigured/);
    const questions = listQuestions(l.db(), run.id);
    const asked = listDecisions(l.db(), run.id, { kind: 'baseline.exception-request' }).map((d) => d.data as { check_id: string; question_id: string });
    const status = (checkId: string): string | undefined => questions.find((q) => q.id === asked.find((a) => a.check_id === checkId)?.question_id)?.status;
    expect(status('lint')).toBe('withdrawn');
    expect(status('unit')).toBe('open');
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.expected-to-flip' })).toEqual([]);
    // The contract that blocked is not the run's: none is written.
    expect(existsSync(join(l.repo, '.orbit', 'runs', run.id, 'contract.json'))).toBe(false);
    expect(getRun(l.db(), run.id).contractJson ?? null).toBeNull();
  }, 180_000);

  it.skipIf(which('npm', process.env.PATH) === null)('the real npm with a missing script the contract names as a proof: expected to flip, and the run creates it and succeeds', async () => {
    const l = labWith({ lint: { command: ['npm', 'run', 'lint'] } }, { 'package.json': PACKAGE_JSON }, (c) => {
      c.scope.allowed_paths = [...c.scope.allowed_paths, 'package.json'];
      c.dependencies = { ...c.dependencies, add_packages: true };
    });
    const planner = {
      ...PLANNER_OUTPUT,
      criteria: [...PLANNER_OUTPUT.criteria, { key: 'lint', statement: 'npm run lint passes.', mandatory: true, ui: false, proof: ['npm run lint exits 0'], check_ids: ['lint'], changes: [{ path: 'package.json', summary: 'add the lint script' }] }],
      expected_changed_files: [...PLANNER_OUTPUT.expected_changed_files, { path: 'package.json', change: 'modify', reason: 'the lint script' }],
      allowed_paths: [...PLANNER_OUTPUT.allowed_paths, 'package.json'],
      required_check_ids: ['unit', 'lint'],
    };
    const withLint = JSON.stringify({ ...JSON.parse(PACKAGE_JSON), scripts: { ...JSON.parse(PACKAGE_JSON).scripts, lint: 'node -e 0' } });
    const implementer = {
      edits: [...(implementMul('*') as { edits: object[] }).edits, { op: 'write', path: 'package.json', content: `${withLint}\n` }],
      structured: { ...IMPLEMENTER_OUTPUT, changed_paths: [...IMPLEMENTER_OUTPUT.changed_paths, { path: 'package.json', change: 'modify', purpose: 'the lint script' }] },
    };
    writeScenario(l, baseScenario({ planner: [{ structured: planner }], implementer: [implementer], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const flips = listDecisions(l.db(), run.id, { kind: 'baseline.expected-to-flip' });
    expect(flips.map((d) => d.data)).toEqual([expect.objectContaining({ check_id: 'lint', criteria: ['AC-2'], missing_target: true })]);
    expect(listQuestions(l.db(), run.id).map((q) => q.status)).toEqual(['withdrawn']);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.check-misconfigured' })).toEqual([]);
    // Nothing was excepted: the check passes on the candidate.
    const contract = JSON.parse(getRun(l.db(), run.id).contractJson ?? '{}') as { baseline_exceptions?: unknown[] };
    expect(contract.baseline_exceptions ?? []).toEqual([]);
  }, 240_000);

  it('a .NET test that fails on a path it may not read (Microsoft.Testing.Platform\'s report) stays a pre-existing failure with its question', async () => {
    // What MSTest 4.4.1's runner printed for a test reading /etc/sudoers (EACCES), with exit 2, as `dotnet run` gives it.
    const bin = binWith('dotnet', fixture('environment', 'dotnet-mstest-runner-eacces.log'), 2);
    const l = labWith({ test: { command: ['dotnet', 'run', '--project', 'tests/Acme.Tests'], env: PATH(bin) } });
    const run = startLabRun(l);
    await drive(l, run.id);

    expect(transitions(l, run.id).slice(0, 2)).toEqual(['PREFLIGHT', 'CONTRACTING']);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.environment-failure' })).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.check-misconfigured' })).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.exception-request' }).map((d) => (d.data as { check_id: string }).check_id)).toEqual(['test']);
  }, 240_000);

  it('a failing test whose assertion reports "permission denied" stays a pre-existing failure with its baseline-exception question', async () => {
    const tap = ['TAP version 13', 'not ok 1 - reports a config it may not read', '  ---', '  error: |-', "    expected the loader to report EACCES: permission denied, open '/etc/acme/config.json'", '  ...', '1..1', '# fail 1', ''].join('\n');
    const l = labWith({ build: { command: [process.execPath, 'tools/test.mjs'] } }, { 'tools/test.mjs': `process.stdout.write(${JSON.stringify(tap)});\nprocess.exit(1);\n` });
    const run = startLabRun(l);
    await drive(l, run.id);

    expect(transitions(l, run.id).slice(0, 2)).toEqual(['PREFLIGHT', 'CONTRACTING']);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.environment-failure' })).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.check-misconfigured' })).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.exception-request' })).toHaveLength(1);
    expect(listQuestions(l.db(), run.id).map((q) => q.id)).toEqual([expect.stringMatching(/^q-baseline-/)]);
  }, 240_000);
});

describe.skipIf(!canStripTypes)('a denial a candidate brings goes to repair (ADR 0010)', () => {
  /** A scenario whose first implementation brings `bad` (written with mul), and whose repair puts the test right. */
  function scenarioWith(bad: { path: string; content: string }, good: { path: string; content: string } | null): object {
    const first = { edits: [...(implementMul('*') as { edits: object[] }).edits, { op: 'write', ...bad }], structured: IMPLEMENTER_OUTPUT };
    const repair = { edits: [good === null ? { op: 'delete', path: bad.path } : { op: 'write', ...good }, { op: 'write', path: 'tests/mul.test.mjs', content: MUL_TEST }], structured: IMPLEMENTER_OUTPUT };
    return baseScenario({ implementer: [first, repair, repair], verifier: [DIAGNOSIS, DIAGNOSIS] });
  }

  it.skipIf(which('python3', process.env.PATH) === null)('a Python unittest that errors with PermissionError on a candidate is a failing test: repair, not BLOCKED', async () => {
    const l = labWith({ py: { command: ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'] } }, { 'tests/test_ok.py': 'import unittest\n\n\nclass OkTests(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n' });
    const denied = "import unittest\n\n\nclass ConfigTests(unittest.TestCase):\n    def test_reads_secret(self):\n        raise PermissionError(13, 'Permission denied', '/etc/acme/secret.conf')\n";
    writeScenario(l, scenarioWith({ path: 'tests/test_config.py', content: denied }, null));
    const run = startLabRun(l);
    await drive(l, run.id);

    const path = transitions(l, run.id);
    expect(path.slice(0, 2)).toEqual(['PREFLIGHT', 'CONTRACTING']);
    expect(path).toContain('DIAGNOSING');
    expect(listDecisions(l.db(), run.id, { kind: 'verification.environment-failure' })).toEqual([]);
    const first = listCheckRuns(l.db(), { runId: run.id, checkId: 'py', rootsOnly: true }).find((r) => r.candidateId !== null);
    expect(readFileSync(first!.logPath!, 'utf8')).toMatch(/PermissionError: \[Errno 13\] Permission denied: '\/etc\/acme\/secret\.conf'/);
    expect(runState(l, run.id).outcomeReason ?? '').not.toMatch(/environment cause/);
  }, 240_000);

  it('a .NET test the change brings that writes outside the checkout (Microsoft.Testing.Platform\'s report): repair, not BLOCKED', async () => {
    // A stand-in test run that prints what MSTest 3.6.4's runner printed for a test creating a directory under /System
    // (EPERM) once the change adds it (tests/cache.ref), and passes before it.
    const test = `import { existsSync } from 'node:fs';\nif (existsSync('tests/cache.ref')) { process.stdout.write(${JSON.stringify(fixture('environment', 'dotnet-mstest-runner-eperm.log'))}); process.exit(2); }\nconsole.log('Test run summary: Passed!');\n`;
    const l = labWith({ dotnet: { command: [process.execPath, 'tools/test.mjs'] } }, { 'tools/test.mjs': test });
    writeScenario(l, scenarioWith({ path: 'tests/cache.ref', content: 'WritesCache\n' }, null));
    const run = startLabRun(l);
    await drive(l, run.id);

    const path = transitions(l, run.id);
    expect(path.slice(0, 2)).toEqual(['PREFLIGHT', 'CONTRACTING']);
    expect(path).toContain('DIAGNOSING');
    expect(listDecisions(l.db(), run.id, { kind: 'verification.environment-failure' })).toEqual([]);
    const first = listCheckRuns(l.db(), { runId: run.id, checkId: 'dotnet', rootsOnly: true }).find((r) => r.candidateId !== null);
    expect(readFileSync(first!.logPath!, 'utf8')).toMatch(/System\.IO\.IOException: Operation not permitted/);
    expect(runState(l, run.id).outcomeReason ?? '').not.toMatch(/environment cause/);
  }, 240_000);

  it('a build that starts fetching from a denied host on a candidate, after passing on the base revision: repair, not BLOCKED', async () => {
    // A stand-in build that prints what the real NuGet printed when srt's proxy refused api.nuget.org, once the change
    // adds a package reference (apps/package.ref), and passes before it.
    const build = `import { existsSync } from 'node:fs';\nif (existsSync('apps/package.ref')) { process.stdout.write(${JSON.stringify(fixture('environment', 'dotnet-build-nuget-proxy-403.log'))}); process.exit(1); }\nconsole.log('Build succeeded.');\n`;
    const l = labWith({ build: { command: [process.execPath, 'tools/build.mjs'] } }, { 'tools/build.mjs': build });
    writeScenario(l, scenarioWith({ path: 'apps/package.ref', content: 'Newtonsoft.Json 13.0.3\n' }, null));
    const run = startLabRun(l);
    await drive(l, run.id);

    const path = transitions(l, run.id);
    expect(path.slice(0, 2)).toEqual(['PREFLIGHT', 'CONTRACTING']);
    expect(path).toContain('DIAGNOSING');
    expect(listDecisions(l.db(), run.id, { kind: 'verification.environment-failure' })).toEqual([]);
    const first = listCheckRuns(l.db(), { runId: run.id, checkId: 'build', rootsOnly: true }).find((r) => r.candidateId !== null);
    expect(readFileSync(first!.logPath!, 'utf8')).toMatch(/failed with status code '403'/);
    expect(runState(l, run.id).outcomeReason ?? '').not.toMatch(/environment cause/);
  }, 240_000);
});
