// Issue #133: a recorded dependency install is reused only in the checkout it ran in. Its value is the untracked state
// it leaves there, so a checkout materialized again (a VERIFYING retry, `orbit verify`) installs again. Real checks run
// under isolation none in a real repository; the install leaves an ignored marker directory a check looks for.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyCandidate } from '../../../src/cli/commands/verify.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { INSTALL_CHECK_ID } from '../../../src/evidence/runner.ts';
import { listCheckRuns } from '../../../src/evidence/store.ts';
import { defaultCheck } from '../../../src/policy/config.ts';
import { giveRepository, makeUnitLab, setContract, type UnitLab } from './coverage-helpers.ts';

const labs: UnitLab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.cleanup();
});

const sh = (script: string): string[] => ['sh', '-c', script];

async function installLab(checks: Record<string, string>): Promise<UnitLab> {
  const lab = makeUnitLab({
    path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING'],
    tweak: (c) => {
      c.dependencies.install_command = sh('mkdir -p apps/deps');
      c.checks = Object.fromEntries(Object.entries(checks).map(([id, script]) => [id, { ...defaultCheck(id), command: sh(script), timeout_seconds: 60 }]));
    },
  });
  labs.push(lab);
  const { base, worktree } = await giveRepository(lab, { 'apps/calc.mjs': 'export const add = (a, b) => a + b;\n', 'apps/.gitignore': 'deps/\n', 'tests/add.test.mjs': 'export {};\n' });
  const ids = Object.keys(checks);
  setContract(lab, { baseline_revision: base, required_check_ids: ids, acceptance_criteria: [{ id: 'AC-1', statement: 'mul(a, b) returns the product', proof: ['the checks pass'], mandatory: true, check_ids: ids }] });
  writeFileSync(join(worktree, 'apps/calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree, runId: lab.runId, baseRev: base, attempt: 1, workerId: null });
  return lab;
}

const rows = (lab: UnitLab, checkId: string) => listCheckRuns(lab.db, { runId: lab.runId, checkId }).filter((r) => r.candidateId !== null);
const installRoots = (lab: UnitLab) => rows(lab, INSTALL_CHECK_ID).filter((r) => r.rerunOf === null);

describe('a dependency install in a checkout materialized again (#133)', () => {
  it('a VERIFYING retry after a check rewrote a tracked file installs again before the other checks run', async () => {
    const lab = await installLab({ mutate: 'echo "// rewritten" >> apps/calc.mjs', marker: 'test -d apps/deps' });
    const first = await step(lab.deps, lab.runId, new AbortController().signal);
    expect(first).toMatchObject({ progressed: false, waiting: expect.stringContaining('STALE_EVIDENCE') });
    expect(installRoots(lab)).toHaveLength(1);
    expect(rows(lab, 'marker')).toHaveLength(0);

    await step(lab.deps, lab.runId, new AbortController().signal);
    // mutate's pass is reused from the first try, so marker is the first check in the new checkout.
    expect(rows(lab, 'mutate')).toHaveLength(1);
    expect(rows(lab, 'marker').map((r) => r.status)).toEqual(['PASSED']);
    expect(installRoots(lab).map((r) => r.status)).toEqual(['PASSED', 'PASSED']);
  }, 120_000);

  it('orbit verify after the controller recorded an install runs the install again in its own checkout', async () => {
    const lab = await installLab({ marker: 'test -d apps/deps' });
    await step(lab.deps, lab.runId, new AbortController().signal);
    expect(installRoots(lab)).toHaveLength(1);
    expect(rows(lab, 'marker').map((r) => r.status)).toEqual(['PASSED']);

    const out = await verifyCandidate(lab.ctx());
    expect(installRoots(lab).map((r) => r.status)).toEqual(['PASSED', 'PASSED']);
    // The report reads the newest install, not the set-aside one.
    const newest = installRoots(lab).at(-1)!;
    const reported = out.report.checks.find((c) => c.id === INSTALL_CHECK_ID)!;
    expect(reported.status).toBe('PASSED');
    expect(newest.logPath!.endsWith(reported.log)).toBe(true);
    expect(reported.log).toMatch(/orbit-install~1\.log$/);
  }, 120_000);
});
