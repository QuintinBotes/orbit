// Gap G23 end to end: the verifying step judges the candidate's secret scan and SAST output under the run's
// frozen `static_security` policy (severities and exceptions), not under the built-in default.
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { listEvidenceReports } from '../../../src/evidence/store.ts';
import { readJsonIfExists } from '../../../src/core/fsx.ts';
import { baseScenario, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

// A token shape the built-in scanner knows (github-token), assembled at runtime so no token-shaped literal is in the source.
const FIXTURE_TOKEN = ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join('');

describe.skipIf(!canStripTypes)('controller: static security policy', () => {
  it('a secret finding waived by static_security.exceptions does not block the candidate, and the waiver is recorded with its reason', async () => {
    const l = makeLab({
      tweak: (c) => {
        c.static_security = {
          block_severities: ['critical', 'high'],
          exceptions: [{ rule_id: 'github-token', path_glob: 'tests/fixtures/**', reason: 'revoked token used by the acme parser fixture', expires: null }],
        };
      },
    });
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*', [{ op: 'write', path: 'tests/fixtures/token.txt', content: `${FIXTURE_TOKEN}\n` }])] }));
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: { ...labDeps(l), gitleaksPath: null }, tickIntervalMs: 20, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const report = listEvidenceReports(l.db(), run.id).at(-1)!;
    expect(report.report.verdict).toBe('PASS');
    const scan = readJsonIfExists<{ findings: unknown[]; excepted: { rule_id: string; reason: string }[] }>(join(l.repo, '.orbit', 'runs', run.id, 'evidence', '1', 'security', 'secret-scan.json'));
    expect(scan?.findings).toEqual([]);
    expect(scan?.excepted).toEqual([expect.objectContaining({ rule_id: 'github-token', reason: 'revoked token used by the acme parser fixture' })]);
  }, 90_000);

  it('the same finding outside the excepted path still blocks the candidate', async () => {
    const l = makeLab({
      tweak: (c) => {
        c.static_security = {
          block_severities: ['critical', 'high'],
          exceptions: [{ rule_id: 'github-token', path_glob: 'tests/fixtures/**', reason: 'revoked token used by the acme parser fixture', expires: null }],
        };
      },
    });
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*', [{ op: 'write', path: 'apps/token.txt', content: `${FIXTURE_TOKEN}\n` }])] }));
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: { ...labDeps(l), gitleaksPath: null }, tickIntervalMs: 20, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state).not.toBe('SUCCEEDED');
    expect(listEvidenceReports(l.db(), run.id)[0]!.report.verdict).toBe('FAIL');
  }, 90_000);
});

describe.skipIf(!canStripTypes)('controller: dependency audit disclosure', () => {
  it('a candidate dependency audit that could not run is disclosed as unverified in the evidence report, not dropped', async () => {
    const l = makeLab({
      tweak: (c) => {
        c.dependencies = { ...c.dependencies, audit: { enabled: true, fail_on: 'high', license_allowlist: null, exceptions: [] } };
      },
    });
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: { ...labDeps(l), gitleaksPath: null }, tickIntervalMs: 20, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const report = listEvidenceReports(l.db(), run.id).at(-1)!;
    expect(report.report.unverified.join('\n')).toMatch(/dependency audit unverified: no npm lockfile/);
  }, 90_000);
});
