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
import { afterEach, describe, expect, it } from 'vitest';
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
  lab?.cleanup();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/**
 * A run whose check `unit-tests` runs `program -m pytest`, and a baseline on which it failed as the captured log shows,
 * with the program's path in place of the captured one. The home directory is outside the lab, so the folder that holds
 * the repository is one the check profile denies (isolation/profiles.ts repoParentDenial).
 */
function deniedBaseline(program: (lab: { base: string; repo: string }) => string): { report: BaselineReport; checkout: string; program: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-home-')));
  homes.push(home);
  let path = '';
  lab = makeUnitLab({
    deps: { homeDir: home },
    tweak: (c, at) => {
      path = program(at!);
      c.checks['unit-tests'] = { ...defaultCheck('unit-tests'), command: [path, '-m', 'pytest'], mandatory: true };
    },
  });
  const ctx = lab.ctx();
  const dir = join(ctx.runDir, 'baseline');
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'unit-tests.log');
  writeFileSync(logPath, CAPTURED.replaceAll('/home/acme/projects/shop/.venv/bin/python', path));
  const checkout = join(lab.home, 'worktrees', 'baseline');
  const row = planCheckRun(lab.db, { runId: lab.runId, candidateId: null, checkId: 'unit-tests', kind: 'command', treeHash: 'b'.repeat(40), checkConfigHash: 'h', policyHash: ctx.run.policyHash, command: [path, '-m', 'pytest'], cwd: checkout, isolation: 'none', limitations: [] }, lab.clock);
  finishCheckRun(lab.db, row.id, { status: 'FAILED', exitCode: 126, timedOut: false, cancelled: false, logPath, logSha256: null, fingerprint: FP, excerpt: null, artifacts: [], endedAt: lab.clock.now() });
  const report: BaselineReport = {
    schema: 'orbit.baseline/1',
    runId: lab.runId,
    baseRevision: BASE_REV,
    baseTree: 'b'.repeat(40),
    policyHash: ctx.run.policyHash,
    checkIds: ['unit-tests'],
    install: { skipped: true, reason: null, ok: false },
    checks: [{ checkId: 'unit-tests', mandatory: true, status: 'FAILED', exitCode: 126, flaky: false, fingerprint: FP, excerpt: null, log: logPath }],
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
