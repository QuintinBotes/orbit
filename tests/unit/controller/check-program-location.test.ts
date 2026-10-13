// 0.3.0 retest (python): a check that runs a virtualenv's interpreter by an absolute path, in the repository or in a
// folder beside it, failed on the base revision with exit 126, "Operation not permitted", on its own executable: the
// check sandbox denies the repository and the folder that holds it and its sibling projects. PREFLIGHT passed "with 1
// pre-existing failure" and offered a baseline exception for it, which ADR 0010 never offers for an environment cause.
// Now PREFLIGHT blocks there, the reason names the repository and the folder the sandbox denies, and the fix, a change to
// the check's command in the frozen policy, needs a new run, not a resume.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { baselineBlockReason, environmentFix, environmentFixSettings } from '../../../src/controller/environment-block.ts';
import { buildFinalReport } from '../../../src/controller/report.ts';
import { newRunNeeded } from '../../../src/controller/resume.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { askAboutBaseFailures, blockOnBaseline, classifyBaseline } from '../../../src/controller/steps/preflight.ts';
import type { BaselineReport } from '../../../src/evidence/baseline.ts';
import { finishCheckRun, planCheckRun } from '../../../src/evidence/store.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { defaultCheck } from '../../../src/policy/config.ts';
import { BASE_REV, makeUnitLab, type UnitLab } from './coverage-helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** Captured under Orbit's runner and srt 0.0.78 on macOS (the retest's in-repository virtualenv), the path renamed. */
const CAPTURED = readFileSync(join(here, '../../fixtures/environment/exec-denied-orbit-limits.log'), 'utf8');
const FP = 'fp:8e87d7c8ad6670a2';

let lab: UnitLab;
const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  lab?.cleanup();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/**
 * A run whose check `unit-tests` runs `program -m pytest`, and a baseline on which it failed as the captured log shows,
 * with the program's path in place of the captured one. The home directory is outside the lab, so the folder that holds
 * the repository is one the check profile denies (isolation/profiles.ts repoParentDenial).
 */
function deniedBaseline(
  program: (lab: { base: string; repo: string }) => string,
  shape: { command?: (path: string) => string[]; shell?: boolean; log?: (path: string) => string; exitCode?: number; env?: (lab: { base: string; repo: string }) => Record<string, string> } = {},
): { report: BaselineReport; checkout: string; program: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-home-')));
  homes.push(home);
  let path = '';
  const command = shape.command ?? ((p: string) => [p, '-m', 'pytest']);
  const exitCode = shape.exitCode ?? 126;
  lab = makeUnitLab({
    deps: { homeDir: home },
    tweak: (c, at) => {
      path = program(at!);
      c.checks['unit-tests'] = { ...defaultCheck('unit-tests'), command: command(path), shell: shape.shell ?? false, mandatory: true, ...(shape.env ? { env: shape.env(at!) } : {}) };
    },
  });
  const ctx = lab.ctx();
  const dir = join(ctx.runDir, 'baseline');
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'unit-tests.log');
  writeFileSync(logPath, shape.log ? `${shape.log(path)}[orbit] check=unit-tests status=FAILED exit=${exitCode}\n` : CAPTURED.replaceAll('/home/acme/projects/shop/.venv/bin/python', path));
  const checkout = join(lab.home, 'worktrees', 'baseline');
  const row = planCheckRun(lab.db, { runId: lab.runId, candidateId: null, checkId: 'unit-tests', kind: 'command', treeHash: 'b'.repeat(40), checkConfigHash: 'h', policyHash: ctx.run.policyHash, command: command(path), cwd: checkout, isolation: 'none', limitations: [] }, lab.clock);
  finishCheckRun(lab.db, row.id, { status: 'FAILED', exitCode, timedOut: false, cancelled: false, logPath, logSha256: null, fingerprint: FP, excerpt: null, artifacts: [], endedAt: lab.clock.now() });
  const report: BaselineReport = {
    schema: 'orbit.baseline/1',
    runId: lab.runId,
    baseRevision: BASE_REV,
    baseTree: 'b'.repeat(40),
    policyHash: ctx.run.policyHash,
    checkIds: ['unit-tests'],
    install: { skipped: true, reason: null, ok: false },
    checks: [{ checkId: 'unit-tests', mandatory: true, status: 'FAILED', exitCode, flaky: false, fingerprint: FP, excerpt: null, log: logPath }],
    failures: [{ checkId: 'unit-tests', fingerprint: FP, excerpt: null }],
    complete: true,
    recordedAt: lab.clock.now(),
  };
  return { report, checkout, program: path };
}

describe('PREFLIGHT: a check whose program the sandbox does not let it start (exit 126)', () => {
  it('is an environment failure, not a pre-existing one: no baseline-exception question, and the baseline is incomplete', () => {
    const { report, checkout, program } = deniedBaseline(({ repo }) => join(repo, '.venv', 'bin', 'python'));
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, report, checkout);
    expect(found.environment).toEqual([expect.objectContaining({ checkId: 'unit-tests', signals: ['program-denied'], questionId: null })]);
    expect(found.report.complete).toBe(false);
    expect(found.report.failures).toEqual([expect.objectContaining({ checkId: 'unit-tests', classification: 'environment', signals: ['program-denied'] })]);
    expect(askAboutBaseFailures(ctx, found, { baseRevision: BASE_REV, key: '' }).preExisting).toEqual([]);
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
  });

  it('names the repository and the folder the sandbox denies, where the program lies, and the fix', () => {
    const inRepo = deniedBaseline(({ repo }) => join(repo, '.venv', 'bin', 'python'));
    const ctx = lab.ctx();
    const { environment } = classifyBaseline(ctx, inRepo.report, inRepo.checkout);
    const reason = baselineBlockReason({ runId: lab.runId, baseRevision: BASE_REV, environment, misconfigured: [] });
    expect(reason).toContain(
      `Check unit-tests could not run on the base revision aaaaaaaaaaaa, and the output shows an environment cause, not a pre-existing failure: the check sandbox denies the repository (${lab.repo}) and the folder that holds it and its sibling projects (${lab.base}), and the program "${inRepo.program}" the check runs lies in the repository, so it cannot start in a check ("orbit-limits: ${inRepo.program}: Operation not permitted")`,
    );
    expect(reason).toContain('dependencies.install_command');
    expect(reason).toContain(`outside ${lab.base}`);
    expect(reason).toContain('docs/configuration.md, "Tool environments"');
    expect(reason).not.toMatch(/[\u2013\u2014]/);
    for (const sentence of reason.split(/(?<=[a-z0-9)"\]])\. (?=\S)/)) expect(sentence, sentence).toMatch(/^[A-Z]/);
  });

  it('says "a folder beside the repository" for a virtualenv in a sibling folder', () => {
    const sibling = deniedBaseline(({ base }) => join(base, 'shop-venv', 'bin', 'python'));
    const ctx = lab.ctx();
    const { environment } = classifyBaseline(ctx, sibling.report, sibling.checkout);
    expect(environment).toHaveLength(1);
    expect(environment[0]!.cause).toBe(`the check sandbox denies the repository (${lab.repo}) and the folder that holds it and its sibling projects (${lab.base}), and the program "${sibling.program}" the check runs lies in a folder beside the repository, so it cannot start in a check`);
  });

  it('needs a new run: the fix changes the check in the frozen policy, so the reason, the outcome, the stage and the report say cancel and start a new run', async () => {
    const { report, checkout, program } = deniedBaseline(({ repo }) => join(repo, '.venv', 'bin', 'python'));
    lab.walk(['PREFLIGHT']);
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, report, checkout);
    expect(environmentFixSettings(found.environment)).toEqual(['checks.unit-tests.command']);
    await blockOnBaseline(ctx, found.report, { environment: found.environment, incomplete: [], misconfigured: [] });
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('BLOCKED');
    const reason = run.outcomeReason ?? '';
    expect(reason).toMatch(/\. The fix changes checks\.unit-tests\.command, which this run's frozen policy keeps as it started, so resuming would run the same check again: cancel this run \(orbit cancel orb-unit\) and start a new run with orbit run\.$/);
    expect(reason).not.toMatch(/orbit resume/);
    expect(JSON.parse(run.outcomeJson ?? '{}')).toMatchObject({ policy_fix: { settings: ['checks.unit-tests.command'] }, environment_failures: [expect.objectContaining({ check_id: 'unit-tests', signals: ['program-denied'] })] });
    expect(newRunNeeded(lab.db, run)).toBe("the fix changes checks.unit-tests.command, which this run's frozen policy keeps as it started");
    const next = buildFinalReport(lab.db, run, { runDir: ctx.runDir, clock: lab.clock, snapshot: null }).next_action;
    expect(next).toBe(reason);
    expect(next).not.toMatch(/orbit resume/);
  });

  it('keeps the resume advice for an environment fix outside the policy', () => {
    const fill: Parameters<typeof environmentFix>[0][number] = { checkId: 'build', fingerprint: null, signals: ['nuget-tls-denied'], cause: 'NuGet could not establish the SSL connection', lines: ['error NU1301: The SSL connection could not be established'] };
    expect(environmentFixSettings([fill])).toEqual([]);
    const reason = baselineBlockReason({ runId: 'orb-1', baseRevision: BASE_REV, environment: [{ ...fill, questionId: null }], misconfigured: [] });
    expect(reason).toMatch(/\. Then orbit resume orb-1 runs the baseline again; a changed check definition needs a new run, because this run's policy is frozen\.$/);
  });
});

// Verifier of the fix: a check whose command is not one simple command (a chain, `exec`, a sibling virtualenv run for lint
// and tests) or whose program's path has a space was still filed as pre-existing with a q-baseline question, while doctor
// named the same program. The sandbox's words are the shell's (captured under srt 0.0.78 and Seatbelt on macOS).
describe('PREFLIGHT: a refused program of a chain, of exec, or with a space in its path (exit 126)', () => {
  const refused = (shell: string) => (p: string) => `${shell}: ${p}: Operation not permitted\n`;
  const cases: [string, (lab: { base: string; repo: string }) => string, Parameters<typeof deniedBaseline>[1], 'repository' | 'parent'][] = [
    ['a chain that changes folder first', ({ repo }) => join(repo, '.venv', 'bin', 'python'), { command: (p) => [`cd tests && ${p} -m pytest`], shell: true, log: refused('/bin/sh') }, 'repository'],
    ['a chain of lint and tests', ({ base }) => join(base, 'shop-venv', 'bin', 'python'), { command: (p) => [`${p} -m ruff check . && ${p} -m pytest`], shell: true, log: refused('/bin/sh') }, 'parent'],
    ['a script that execs it', ({ base }) => join(base, 'shop-venv', 'bin', 'python'), { command: (p) => ['/bin/sh', '-c', `exec ${p} -m pytest`], log: (p) => `${refused('/bin/sh')(p)}/bin/sh: line 0: exec: ${p}: cannot execute: Operation not permitted\n` }, 'parent'],
    ['a path with a space', ({ base }) => join(base, 'my venvs', 'bin', 'python'), { log: (p) => `orbit-limits: ${p}: Operation not permitted\norbit-limits: line 0: exec: ${p}: cannot execute: Operation not permitted\n` }, 'parent'],
  ];
  for (const [name, program, shape, under] of cases) {
    it(`${name}: an environment failure naming the denied folders, with no baseline-exception question`, () => {
      const denied = deniedBaseline(program, shape);
      const ctx = lab.ctx();
      const found = classifyBaseline(ctx, denied.report, denied.checkout);
      expect(found.environment).toEqual([expect.objectContaining({ checkId: 'unit-tests', signals: ['program-denied'], questionId: null, programDenial: expect.objectContaining({ program: denied.program, under }) })]);
      expect(found.environment[0]!.cause).toContain(`the program "${denied.program}" the check runs lies in ${under === 'repository' ? 'the repository' : 'a folder beside the repository'}`);
      expect(askAboutBaseFailures(ctx, found, { baseRevision: BASE_REV, key: '' }).preExisting).toEqual([]);
      expect(listQuestions(lab.db, lab.runId)).toEqual([]);
      expect(environmentFixSettings(found.environment)).toEqual(['checks.unit-tests.command']);
    });
  }
});

// Verifier of the fix: a check that runs a bare name (`pytest -q`) found on a PATH that leads into the repository (an
// activated virtualenv there) was blocked with no word of the denied folders, and told that only a new run with a
// changed command would help, while the check's PATH is Orbit's own and a resume from a shell without the virtualenv
// clears it. Under srt 0.0.78 on macOS such a name is not found (exit 127, the wrapper's "exec: pytest: not found"), as
// on Linux; a shell that does find it names the path it found it at, refused (exit 126).
describe('PREFLIGHT: a bare name found on a PATH that leads into a folder the check sandbox denies', () => {
  const installPytest = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pytest'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  };

  it('refused at the path the shell found it at: names the folders and Orbit\'s PATH, and keeps the resume', () => {
    const denied = deniedBaseline(({ repo }) => join(repo, '.venv', 'bin', 'pytest'), {
      command: () => ['pytest', '-q'],
      log: (p) => `orbit-limits: ${p}: Operation not permitted\norbit-limits: line 0: exec: ${p}: cannot execute: Operation not permitted\n`,
    });
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, denied.report, denied.checkout);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-denied'], programDenial: expect.objectContaining({ program: denied.program, under: 'repository', onPath: { name: 'pytest', setBy: null } }) })]);
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
    expect(environmentFixSettings(found.environment)).toEqual([]);
    const reason = baselineBlockReason({ runId: lab.runId, baseRevision: BASE_REV, environment: found.environment, misconfigured: [] });
    expect(reason).toContain(`the check sandbox denies the repository (${lab.repo}) and the folder that holds it and its sibling projects (${lab.base}), and the program "pytest" the check runs is "${denied.program}" on the PATH Orbit runs its checks with, which leads into the repository, so it cannot start in a check`);
    expect(reason).toContain('deactivate');
    expect(reason).toContain('dependencies.install_command');
    expect(reason).toMatch(/\. Then orbit resume orb-unit runs the baseline again; a changed check definition needs a new run, because this run's policy is frozen\.$/);
    expect(reason).not.toMatch(/cancel this run/);
    expect(reason).not.toMatch(/[\u2013\u2014]/);
    for (const sentence of reason.split(/(?<=[a-z0-9)"\]])\. (?=\S)/)) expect(sentence, sentence).toMatch(/^[A-Z]/);
  });

  it('not found (exit 127) on the PATH Orbit runs its checks with: located by that PATH, and the resume kept', () => {
    let bin = '';
    const denied = deniedBaseline(
      ({ repo }) => {
        bin = join(repo, '.venv', 'bin');
        installPytest(bin);
        return join(bin, 'pytest');
      },
      { command: () => ['pytest', '-q'], exitCode: 127, log: () => 'orbit-limits: line 0: exec: pytest: not found\n' },
    );
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, denied.report, denied.checkout);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-not-found'], programDenial: expect.objectContaining({ program: denied.program, under: 'repository', onPath: { name: 'pytest', setBy: null } }) })]);
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
    expect(environmentFixSettings(found.environment)).toEqual([]);
    const reason = baselineBlockReason({ runId: lab.runId, baseRevision: BASE_REV, environment: found.environment, misconfigured: [] });
    expect(reason).toContain(`the program "pytest" the check runs is "${denied.program}" on the PATH Orbit runs its checks with, which leads into the repository`);
    expect(reason).not.toMatch(/install the program where the check runs/);
    expect(reason).toMatch(/Then orbit resume orb-unit runs the baseline again/);
  });

  it('on a PATH the check\'s env sets: the fix changes checks.<id>.env, so a new run', () => {
    let bin = '';
    const denied = deniedBaseline(
      ({ base }) => {
        bin = join(base, 'shop-venv', 'bin');
        installPytest(bin);
        return join(bin, 'pytest');
      },
      { command: () => ['pytest', '-q'], exitCode: 127, log: () => 'orbit-limits: line 1: exec: pytest: not found\n', env: ({ base }) => ({ PATH: `${join(base, 'shop-venv', 'bin')}:/usr/bin:/bin` }) },
    );
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, denied.report, denied.checkout);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-not-found'], programDenial: expect.objectContaining({ program: denied.program, under: 'parent', onPath: { name: 'pytest', setBy: 'checks.unit-tests.env' } }) })]);
    expect(environmentFixSettings(found.environment)).toEqual(['checks.unit-tests.env']);
    const reason = baselineBlockReason({ runId: lab.runId, baseRevision: BASE_REV, environment: found.environment, misconfigured: [] });
    expect(reason).toContain(`the program "pytest" the check runs is "${denied.program}" on the PATH checks.unit-tests.env sets, which leads into a folder beside the repository`);
    expect(reason).toMatch(/\. The fix changes checks\.unit-tests\.env, which this run's frozen policy keeps as it started, so resuming would run the same check again: cancel this run \(orbit cancel orb-unit\) and start a new run with orbit run\.$/);
  });

  it('a bare name not found anywhere in the denied folders stays a program to install', () => {
    const denied = deniedBaseline(({ repo }) => join(repo, '.venv', 'bin', 'pytest'), { command: () => ['pytest', '-q'], exitCode: 127, log: () => 'orbit-limits: line 0: exec: pytest: not found\n' });
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const found = classifyBaseline(lab.ctx(), denied.report, denied.checkout);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-not-found'] })]);
    expect(found.environment[0]!.programDenial).toBeUndefined();
    expect(baselineBlockReason({ runId: lab.runId, baseRevision: BASE_REV, environment: found.environment, misconfigured: [] })).toContain('install the program where the check runs');
  });
});
