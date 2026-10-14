// 0.3.0 retest (python): a check that runs a virtualenv's interpreter by an absolute path, in the repository or in a
// folder beside it, failed on the base revision with exit 126, "Operation not permitted", on its own executable: the
// check sandbox denies the repository and the folder that holds it and its sibling projects. PREFLIGHT passed "with 1
// pre-existing failure" and offered a baseline exception for it, which ADR 0010 never offers for an environment cause.
// Now PREFLIGHT blocks there, the reason names the repository and the folder the sandbox denies, and the fix, a change to
// the check's command in the frozen policy, needs a new run, not a resume.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { BASE_REV, gitIn, makeUnitLab, type UnitLab } from './coverage-helpers.ts';

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
  // The base revision the report names is a real commit of the lab repository as the program callback left it, so a
  // classification that follows a link reads the base tree, as it does for a run. A link a test makes after this
  // helper returns is uncommitted, as one is with repository.allow_dirty_start.
  writeFileSync(join(lab.repo, 'base-revision.txt'), 'base\n');
  gitIn(lab.repo, 'init', '-q', '-b', 'main');
  gitIn(lab.repo, 'add', '-A');
  gitIn(lab.repo, 'commit', '-q', '-m', 'base');
  const baseRevision = gitIn(lab.repo, 'rev-parse', 'HEAD');
  const baseTree = gitIn(lab.repo, 'rev-parse', 'HEAD^{tree}');
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
    baseRevision,
    baseTree,
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

// Second review of the fix: a bare name a chain starts, hidden by srt on Linux (`cd tests && pytest -q` with
// a PATH into the repository, exit 127), and the program of a shell the check script starts (`sh -c "<venv>/python -m
// pytest"`, exit 126) were left unclassified, so PREFLIGHT offered a baseline exception for tests that never started.
// And whatever the command looks like (`eval "$CMD"`), a refusal of a path in a folder the check sandbox denies, or a
// "not found" for a name the check's PATH finds there, is the environment's; a test that ran and failed stays the code's.
describe('PREFLIGHT: a program a chain, a nested shell or eval starts, in a folder the check sandbox denies', () => {
  const installPytest = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pytest'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  };
  const inRepoPytest = (set: (bin: string) => void) => ({ repo }: { repo: string }): string => {
    const bin = join(repo, '.venv', 'bin');
    installPytest(bin);
    set(bin);
    return join(bin, 'pytest');
  };
  const blocksWithoutQuestion = (denied: { report: BaselineReport; checkout: string }) => {
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, denied.report, denied.checkout);
    expect(found.report.complete).toBe(false);
    expect(askAboutBaseFailures(ctx, found, { baseRevision: BASE_REV, key: '' }).preExisting).toEqual([]);
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
    return found;
  };

  it('a bare name a chain starts, not found on a PATH into the repository (exit 127)', () => {
    let bin = '';
    const denied = deniedBaseline(inRepoPytest((b) => (bin = b)), { command: () => ['cd tests && pytest -q'], shell: true, exitCode: 127, log: () => '/bin/sh: 1: pytest: not found\n' });
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const found = blocksWithoutQuestion(denied);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-not-found'], programDenial: expect.objectContaining({ program: denied.program, under: 'repository', onPath: { name: 'pytest', setBy: null } }) })]);
  });

  it('the program of a shell the check script starts with -c (exit 126)', () => {
    const denied = deniedBaseline(({ repo }) => join(repo, '.venv', 'bin', 'python'), { command: (p) => [`sh -c "${p} -m pytest"`], shell: true, log: (p) => `/bin/sh: ${p}: Operation not permitted\n` });
    const found = blocksWithoutQuestion(denied);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-denied'], programDenial: expect.objectContaining({ program: denied.program, under: 'repository' }) })]);
    expect(found.environment[0]!.programDenial!.onPath).toBeUndefined();
    expect(environmentFixSettings(found.environment)).toEqual(['checks.unit-tests.command']);
  });

  it('eval of a program the parser cannot see, refused in the repository (exit 126): the backstop', () => {
    const denied = deniedBaseline(({ repo }) => join(repo, '.venv', 'bin', 'python'), {
      command: () => ['eval "$CMD"'],
      shell: true,
      env: ({ repo }) => ({ CMD: `${join(repo, '.venv', 'bin', 'python')} -m pytest` }),
      log: (p) => `/bin/sh: 1: ${p}: Operation not permitted\n`,
    });
    const found = blocksWithoutQuestion(denied);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-denied'], programDenial: expect.objectContaining({ program: denied.program, under: 'repository' }) })]);
    expect(found.environment[0]!.cause).toContain(`the program "${denied.program}" the check runs lies in the repository`);
  });

  it('eval of a bare name not found on a PATH into the repository (exit 127): the backstop', () => {
    let bin = '';
    const denied = deniedBaseline(inRepoPytest((b) => (bin = b)), { command: () => ['eval "$CMD"'], shell: true, env: () => ({ CMD: 'pytest -q' }), exitCode: 127, log: () => '/bin/sh: 1: pytest: not found\n' });
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const found = blocksWithoutQuestion(denied);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-not-found'], programDenial: expect.objectContaining({ program: denied.program, under: 'repository', onPath: { name: 'pytest', setBy: null } }) })]);
  });

  it('eval of a bare name refused where a PATH into the repository finds it, as dash names it (exit 126): the backstop', () => {
    let bin = '';
    const denied = deniedBaseline(inRepoPytest((b) => (bin = b)), { command: () => ['eval "$CMD"'], shell: true, env: () => ({ CMD: 'pytest -q' }), log: () => '/bin/dash: 1: eval: pytest: Operation not permitted\n' });
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const found = blocksWithoutQuestion(denied);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-denied'], programDenial: expect.objectContaining({ program: denied.program, under: 'repository', onPath: { name: 'pytest', setBy: null } }) })]);
    expect(found.environment[0]!.cause).toContain(`the program "pytest" the check runs is "${denied.program}" on the PATH Orbit runs its checks with, which leads into the repository`);
  });

  it('a refusal of another path in the repository: a filesystem denial there, not a program', () => {
    const denied = deniedBaseline(({ repo }) => join(repo, '.git', 'config'), { command: () => ['./scripts/sync.sh && npm test'], shell: true, exitCode: 1, log: (p) => `error: could not lock config file ${p}: Operation not permitted\n` });
    const found = blocksWithoutQuestion(denied);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['filesystem-denied'] })]);
    expect(found.environment[0]!.programDenial).toBeUndefined();
    expect(found.environment[0]!.cause).toBe(`the sandbox or the operating system refused "${denied.program}" ("operation not permitted"), which lies in the repository (${lab.repo}), a folder the check sandbox denies: a check runs in a checkout of its own and may not use it`);
  });

  it('a test that ran and failed, whose assertion message names a refused path in the repository, stays a pre-existing failure', () => {
    const denied = deniedBaseline(({ repo }) => join(repo, '.venv', 'bin', 'python'), {
      command: () => ['eval "$CMD"'],
      shell: true,
      env: ({ repo }) => ({ CMD: `${join(repo, '.venv', 'bin', 'python')} -m pytest` }),
      exitCode: 1,
      log: (p) => `tests/test_perm.py F\nE   AssertionError: assert 'ok' == '/bin/sh: ${p}: Operation not permitted'\nFAILED tests/test_perm.py::test_refused - AssertionError\n1 failed in 0.02s\n`,
    });
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, denied.report, denied.checkout);
    expect(found.environment).toEqual([]);
    expect(found.report.failures[0]!.classification).toBeUndefined();
    expect(askAboutBaseFailures(ctx, found, { baseRevision: BASE_REV, key: '' }).preExisting.map((f) => f.checkId)).toEqual(['unit-tests']);
  });
});

// Third review of the fix. A check that starts its program through a wrapper (`timeout 600 pytest`, srt hiding a PATH
// folder in the repository on Linux), a make whose recipe's program the sandbox hid (make exits 2), and a program that
// links into a denied folder (a link outside the projects folder to a tool environment in the repository, or a link the
// repository commits to a sibling one) were filed as pre-existing failures with a baseline-exception question.
describe('PREFLIGHT: a wrapper\'s program, a make recipe\'s, and a link into a folder the check sandbox denies', () => {
  const installPytest = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pytest'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  };
  /** A folder of the user's own outside the projects folder (~/bin), so the check profile does not deny it. */
  const userBin = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-userbin-')));
    homes.push(dir);
    return dir;
  };
  const blocksWithoutQuestion = (denied: { report: BaselineReport; checkout: string }) => {
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, denied.report, denied.checkout);
    expect(found.report.complete).toBe(false);
    expect(askAboutBaseFailures(ctx, found, { baseRevision: BASE_REV, key: '' }).preExisting).toEqual([]);
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
    return found;
  };

  it('timeout 600 pytest, not found on a PATH into the repository (exit 127, GNU coreutils\' words)', () => {
    let bin = '';
    const denied = deniedBaseline(
      ({ repo }) => {
        bin = join(repo, '.venv', 'bin');
        installPytest(bin);
        return join(bin, 'pytest');
      },
      { command: () => ['timeout', '600', 'pytest', '-q'], exitCode: 127, log: () => "timeout: failed to run command 'pytest': No such file or directory\n" },
    );
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const found = blocksWithoutQuestion(denied);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-not-found'], programDenial: expect.objectContaining({ program: denied.program, under: 'repository', onPath: { name: 'pytest', setBy: null } }) })]);
  });

  it('timeout of an interpreter in the repository by its path (exit 127)', () => {
    const denied = deniedBaseline(({ repo }) => join(repo, '.venv', 'bin', 'python'), {
      command: (p) => ['timeout', '600', p, '-m', 'pytest'],
      exitCode: 127,
      log: (p) => `timeout: failed to run command '${p}': No such file or directory\n`,
    });
    const found = blocksWithoutQuestion(denied);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-not-found'], programDenial: expect.objectContaining({ program: denied.program, under: 'repository' }) })]);
  });

  it('make test whose recipe\'s program a PATH into the repository finds (make exits 2)', () => {
    for (const log of ['cd . && pytest -q\n/bin/sh: pytest: command not found\nmake: *** [test] Error 127\n', 'pytest -q\nmake: pytest: No such file or directory\nmake: *** [test] Error 1\n']) {
      let bin = '';
      const denied = deniedBaseline(
        ({ repo }) => {
          bin = join(repo, '.venv', 'bin');
          installPytest(bin);
          return join(bin, 'pytest');
        },
        { command: () => ['make', 'test'], exitCode: 2, log: () => log },
      );
      vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
      const found = blocksWithoutQuestion(denied);
      expect(found.environment, log).toEqual([expect.objectContaining({ signals: ['program-not-found'], programDenial: expect.objectContaining({ program: denied.program, under: 'repository', onPath: { name: 'pytest', setBy: null } }) })]);
      lab.cleanup();
    }
  });

  it('a link outside the projects folder to a program in the repository: refused by its path, through eval, a script, or not found by its name', () => {
    const cases: [string, Parameters<typeof deniedBaseline>[1], (link: string) => void, 'program-denied' | 'program-not-found'][] = [
      ['its path', { command: (l) => [l, '-q'], log: (l) => `/bin/sh: ${l}: Operation not permitted\n` }, () => {}, 'program-denied'],
      ['eval', { command: () => ['eval "$CMD"'], shell: true, env: () => ({ CMD: '"$LINK" -q' }), log: (l) => `/bin/sh: ${l}: Operation not permitted\n` }, () => {}, 'program-denied'],
      ['a script of the repository', { command: () => ['./scripts/test.sh'], log: (l) => `./scripts/test.sh: line 2: ${l}: Operation not permitted\n` }, () => {}, 'program-denied'],
      ['its name', { command: () => ['eval "$CMD"'], shell: true, env: () => ({ CMD: 'shop-pytest -q' }), exitCode: 127, log: () => '/bin/sh: shop-pytest: command not found\n' }, (l) => vi.stubEnv('PATH', `${dirname(l)}:/usr/bin:/bin`), 'program-not-found'],
    ];
    for (const [name, shape, setup, signal] of cases) {
      const ub = userBin();
      let target = '';
      const denied = deniedBaseline(({ repo }) => {
        const bin = join(repo, '.venv', 'bin');
        installPytest(bin);
        target = join(bin, 'pytest');
        symlinkSync(target, join(ub, 'shop-pytest'));
        return join(ub, 'shop-pytest');
      }, shape);
      setup(denied.program);
      const found = blocksWithoutQuestion(denied);
      expect(found.environment, name).toEqual([expect.objectContaining({ signals: [signal], programDenial: expect.objectContaining({ program: denied.program, under: 'repository', target }) })]);
      expect(found.environment[0]!.cause, name).toContain(`"${denied.program}"`);
      expect(found.environment[0]!.cause, name).toContain(`links to "${target}"`);
      lab.cleanup();
    }
  });

  it('a link the repository commits, run by a path relative to the check\'s cwd, to a tool environment beside it (exit 126)', () => {
    let target = '';
    const denied = deniedBaseline(
      ({ base, repo }) => {
        target = join(base, 'shop-venv', 'bin', 'python');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        mkdirSync(join(repo, 'tools'), { recursive: true });
        symlinkSync(target, join(repo, 'tools', 'python'));
        return './tools/python';
      },
      { log: (p) => `orbit-limits: ${p}: Operation not permitted\norbit-limits: line 0: exec: ${p}: cannot execute: Operation not permitted\n` },
    );
    const found = blocksWithoutQuestion(denied);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-denied'], programDenial: expect.objectContaining({ program: './tools/python', under: 'parent', target }) })]);
    expect(found.environment[0]!.cause).toBe(`the check sandbox denies the repository (${lab.repo}) and the folder that holds it and its sibling projects (${lab.base}), and the program "./tools/python" the check runs links to "${target}", which lies in a folder beside the repository, so it cannot start in a check`);
    expect(environmentFixSettings(found.environment)).toEqual(['checks.unit-tests.command']);
  });

  it('a relative path that climbs out of the check\'s checkout is not read in the repository\'s tree', () => {
    const denied = deniedBaseline(
      ({ base }) => {
        const target = join(base, 'shop-venv', 'bin', 'python');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        return '../shop-venv/bin/python';
      },
      { log: (p) => `orbit-limits: ${p}: Operation not permitted\n` },
    );
    const found = classifyBaseline(lab.ctx(), denied.report, denied.checkout);
    expect(found.environment.filter((f) => f.programDenial !== undefined)).toEqual([]);
  });

  it('a relative link that stays in the repository is the checkout\'s own, and stays the code\'s', () => {
    const denied = deniedBaseline(
      ({ repo }) => {
        const bin = join(repo, '.venv', 'bin');
        installPytest(bin);
        mkdirSync(join(repo, 'tools'), { recursive: true });
        symlinkSync('../.venv/bin/pytest', join(repo, 'tools', 'pytest'));
        return './tools/pytest';
      },
      { command: (p) => [p, '-q'], log: (p) => `orbit-limits: ${p}: Operation not permitted\n` },
    );
    const found = classifyBaseline(lab.ctx(), denied.report, denied.checkout);
    expect(found.environment).toEqual([]);
  });
});

// Codex's review of the third fix. A link the repository commits with an absolute target into the repository still
// leads there from the check's checkout, so the sandbox refuses it (exit 126), even where the file it reaches links on
// to an interpreter elsewhere; the reading followed the link to its last file and called it the checkout's own. A
// virtualenv folder the repository links to beside it by a relative link (`.venv -> ../shop-venv`) is gone from the
// checkout's view (exit 127): the shell's "not found" for a relative path read as a script that does not exist yet (a
// missing target) before the link was read. And `git diff --no-index` whose output shows such a refusal as a line of
// the compared files is a comparison that ran and failed.
describe('PREFLIGHT: links the repository commits, and a comparison that names a refusal (Codex review)', () => {
  /** An interpreter outside the projects folder, as a virtualenv's python links to the one it was made from. */
  const interpreter = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-python-')));
    homes.push(dir);
    writeFileSync(join(dir, 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return join(dir, 'python3');
  };
  /** A virtualenv at `dir` whose bin/python links to an interpreter elsewhere. */
  const venv = (dir: string): string => {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    symlinkSync(interpreter(), join(dir, 'bin', 'python'));
    return join(dir, 'bin', 'python');
  };
  const blocksWithoutQuestion = (denied: { report: BaselineReport; checkout: string }) => {
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, denied.report, denied.checkout);
    expect(found.misconfigured).toEqual([]);
    expect(found.missingTargets).toEqual([]);
    expect(found.report.complete).toBe(false);
    expect(askAboutBaseFailures(ctx, found, { baseRevision: BASE_REV, key: '' }).preExisting).toEqual([]);
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
    return found;
  };

  it('an absolute link into the repository, run by a path relative to the check\'s cwd, is refused for the path it names (exit 126)', () => {
    let target = '';
    const denied = deniedBaseline(
      ({ repo }) => {
        target = venv(join(repo, '.venv'));
        mkdirSync(join(repo, 'tools'), { recursive: true });
        symlinkSync(target, join(repo, 'tools', 'python'));
        return './tools/python';
      },
      { log: (p) => `orbit-limits: ${p}: Operation not permitted\norbit-limits: line 0: exec: ${p}: cannot execute: Operation not permitted\n` },
    );
    const found = blocksWithoutQuestion(denied);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-denied'], programDenial: expect.objectContaining({ program: './tools/python', under: 'repository', target }) })]);
    expect(found.environment[0]!.cause).toBe(`the check sandbox denies the repository (${lab.repo}) and the folder that holds it and its sibling projects (${lab.base}), and the program "./tools/python" the check runs links to "${target}", which lies in the repository, so it cannot start in a check`);
  });

  it('an absolute link to a folder of the repository on the way counts too, and a relative link that stays in the repository does not', () => {
    const denied = deniedBaseline(
      ({ repo }) => {
        venv(join(repo, 'envs', 'py312'));
        symlinkSync(join(repo, 'envs', 'py312'), join(repo, '.venv'));
        return '.venv/bin/python';
      },
      { log: (p) => `orbit-limits: line 0: exec: ${p}: cannot execute: Operation not permitted\n` },
    );
    const found = blocksWithoutQuestion(denied);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-denied'], programDenial: expect.objectContaining({ program: '.venv/bin/python', under: 'repository', target: join(lab.repo, 'envs', 'py312', 'bin', 'python') }) })]);
    lab.cleanup();
    const relocated = deniedBaseline(
      ({ repo }) => {
        venv(join(repo, 'envs', 'py312'));
        symlinkSync(join('envs', 'py312'), join(repo, '.venv'));
        return '.venv/bin/python';
      },
      { log: (p) => `orbit-limits: line 0: exec: ${p}: cannot execute: Operation not permitted\n` },
    );
    expect(classifyBaseline(lab.ctx(), relocated.report, relocated.checkout).environment).toEqual([]);
  });

  it('a relative link to a sibling virtualenv is not found in the checkout (exit 127): an environment failure, not a missing target', () => {
    // Its interpreter, which links on to one elsewhere, and its pytest script, which the shell's words also fit as a
    // script of the repository that does not exist yet.
    const shapes: [string, (p: string) => string[], (venvDir: string) => string][] = [
      ['.venv/bin/python', (p) => [p, '-m', 'pytest'], (dir) => venv(dir)],
      [
        '.venv/bin/pytest',
        (p) => [p, '-q'],
        (dir) => {
          venv(dir);
          writeFileSync(join(dir, 'bin', 'pytest'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
          return join(dir, 'bin', 'pytest');
        },
      ],
    ];
    for (const [program, command, make] of shapes) {
      let target = '';
      const denied = deniedBaseline(
        ({ base, repo }) => {
          target = make(join(base, 'shop-venv'));
          symlinkSync('../shop-venv', join(repo, '.venv'));
          return program;
        },
        { command, exitCode: 127, log: (p) => `orbit-limits: line 0: exec: ${p}: not found\n` },
      );
      const found = blocksWithoutQuestion(denied);
      expect(found.environment, program).toEqual([expect.objectContaining({ signals: ['program-not-found'], programDenial: expect.objectContaining({ program, under: 'parent', target }) })]);
      expect(found.report.failures, program).toEqual([expect.objectContaining({ checkId: 'unit-tests', classification: 'environment' })]);
      lab.cleanup();
    }
  });

  it('a relative path to a script that does not exist (exit 127) stays a missing target', () => {
    const denied = deniedBaseline(() => './scripts/test.sh', { command: (p) => [p, '-q'], exitCode: 127, log: (p) => `orbit-limits: line 0: exec: ${p}: not found\n` });
    const found = classifyBaseline(lab.ctx(), denied.report, denied.checkout);
    expect(found.environment).toEqual([]);
    expect(found.missingTargets).toEqual([expect.objectContaining({ checkId: 'unit-tests', signature: 'script-not-found' })]);
  });

  // Regression: with repository.allow_dirty_start the working repository can hold an uncommitted link the base
  // revision does not have. Following it classified the baseline's "./tools/python: not found", a missing target
  // the goal may add, as an environment failure of the sibling virtualenv the link points into.
  it('an uncommitted link the base revision does not hold is not followed: ./tools/python not found stays a missing target (exit 127)', () => {
    const denied = deniedBaseline(
      ({ base }) => {
        const target = join(base, 'shop-venv', 'bin', 'python');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        return './tools/python';
      },
      { command: (p) => [p, '-q'], exitCode: 127, log: (p) => `orbit-limits: line 0: exec: ${p}: not found\n` },
    );
    // The link exists only in the working repository, made after the base commit the helper recorded: the baseline
    // checkout never held it, so the sibling virtualenv it points into must not classify the failure.
    mkdirSync(join(lab.repo, 'tools'), { recursive: true });
    symlinkSync(join(lab.base, 'shop-venv', 'bin', 'python'), join(lab.repo, 'tools', 'python'));
    const found = classifyBaseline(lab.ctx(), denied.report, denied.checkout);
    expect(found.environment).toEqual([]);
    expect(found.missingTargets).toEqual([expect.objectContaining({ checkId: 'unit-tests', signature: 'script-not-found' })]);
  });

  it('git diff --no-index whose compared lines show a refusal in the repository stays a pre-existing failure', () => {
    const denied = deniedBaseline(({ repo }) => join(repo, '.venv', 'bin', 'python'), {
      command: () => ['git', 'diff', '--no-index', '--exit-code', 'tests/expected.txt', 'out/actual.txt'],
      exitCode: 1,
      log: (p) =>
        [
          'diff --git a/tests/expected.txt b/out/actual.txt',
          'index 3b18e51..8c7e5a6 100644',
          '--- a/tests/expected.txt',
          '+++ b/out/actual.txt',
          '@@ -1,2 +1,2 @@',
          ' running the interpreter',
          '-ok',
          `+/bin/sh: ${p}: Operation not permitted`,
          '',
        ].join('\n'),
    });
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, denied.report, denied.checkout);
    expect(found.environment).toEqual([]);
    expect(found.report.failures[0]!.classification).toBeUndefined();
    expect(askAboutBaseFailures(ctx, found, { baseRevision: BASE_REV, key: '' }).preExisting.map((f) => f.checkId)).toEqual(['unit-tests']);
  });
});

// Regressions from the review of the backstop. A Python exception filename that matched an executable on PATH inside
// the repository was read as a failed launch of that program, although Python ran and never tried to start it; and a
// relative program a shell refused after `cd tests` was followed from the check's configured cwd, so the repository
// root's link decided a run that happened in tests. Both made a genuine code failure an environment block.
describe('PREFLIGHT: a runtime file error, and a relative program after cd (review regressions)', () => {
  it('python3 opening a file named like a program on a PATH into the repository stays a pre-existing failure', () => {
    const denied = deniedBaseline(
      ({ repo }) => {
        const bin = join(repo, 'node_modules', '.bin');
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, 'tsc'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        return join(bin, 'tsc');
      },
      {
        command: () => ['python3', '-c', 'open("tsc")'],
        exitCode: 1,
        env: ({ repo }) => ({ PATH: `${join(repo, 'node_modules', '.bin')}:/usr/bin:/bin` }),
        log: () => 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nFileNotFoundError: [Errno 2] No such file or directory: \'tsc\'\n',
      },
    );
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, denied.report, denied.checkout);
    expect(found.environment).toEqual([]);
    expect(askAboutBaseFailures(ctx, found, { baseRevision: BASE_REV, key: '' }).preExisting.map((f) => f.checkId)).toEqual(['unit-tests']);
  });

  /** A sibling tool environment's interpreter, the file a denied link leads to. */
  const siblingPython = (base: string): string => {
    const target = join(base, 'shop-venv', 'bin', 'python');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return target;
  };
  const toolAt = (repo: string, dir: string, target: string | null): void => {
    const tools = join(repo, dir, 'tools');
    mkdirSync(tools, { recursive: true });
    if (target === null) writeFileSync(join(tools, 'python'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    else symlinkSync(target, join(tools, 'python'));
  };

  it('cd tests && ./tools/python is read in tests: the root link into a denied folder does not classify a run of the checkout\'s own file there', () => {
    const denied = deniedBaseline(
      ({ base, repo }) => {
        const target = siblingPython(base);
        toolAt(repo, '.', target);
        toolAt(repo, 'tests', null);
        return './tools/python';
      },
      { command: () => ['cd tests && ./tools/python -m pytest'], shell: true, log: () => '/bin/sh: ./tools/python: Operation not permitted\n' },
    );
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, denied.report, denied.checkout);
    expect(found.environment).toEqual([]);
    expect(askAboutBaseFailures(ctx, found, { baseRevision: BASE_REV, key: '' }).preExisting.map((f) => f.checkId)).toEqual(['unit-tests']);
  });

  it('cd tests && ./tools/python is read in tests: a denied link there blocks, though the root holds a plain file', () => {
    let target = '';
    const denied = deniedBaseline(
      ({ base, repo }) => {
        target = siblingPython(base);
        toolAt(repo, '.', null);
        toolAt(repo, 'tests', target);
        return './tools/python';
      },
      { command: () => ['cd tests && ./tools/python -m pytest'], shell: true, log: () => '/bin/sh: ./tools/python: Operation not permitted\n' },
    );
    const ctx = lab.ctx();
    const found = classifyBaseline(ctx, denied.report, denied.checkout);
    expect(found.environment).toEqual([expect.objectContaining({ signals: ['program-denied'], questionId: null, programDenial: expect.objectContaining({ program: './tools/python', under: 'parent', target }) })]);
    expect(askAboutBaseFailures(ctx, found, { baseRevision: BASE_REV, key: '' }).preExisting).toEqual([]);
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
  });
});
