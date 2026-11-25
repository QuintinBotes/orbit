// Issue #167, through the real controller loop with the fake providers: a run that a broken check environment ends is
// `environment`, a run that succeeds has no class, and each stores the Orbit version that started it. `orbit stats`
// then reports each run under its class (the independent test of user story 1).
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORBIT_VERSION } from '../../../src/cli/version.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { metricsFor } from '../../../src/observability/metrics.ts';
import { buildTimeline } from '../../../src/observability/timeline.ts';
import { baseScenario, DIAGNOSIS, implementMul, labDeps, makeLab, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

async function drive(l: Lab, runId: string): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

const finalJson = (l: Lab, runId: string): Record<string, unknown> => JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', runId, 'final.json'), 'utf8')) as Record<string, unknown>;

/** A diagnosis whose every competing hypothesis was ruled out by evidence. */
const ALL_RULED_OUT = (() => {
  const d = structuredClone(DIAGNOSIS) as { structured: { competing_hypotheses: { status: string; refuting_evidence: string[] }[]; confidence: string } };
  for (const h of d.structured.competing_hypotheses) {
    h.status = 'ruled-out';
    h.refuting_evidence = ['the experiment recorded for it showed the opposite of what it predicts'];
  }
  d.structured.confidence = 'low';
  return d;
})();

describe.skipIf(!canStripTypes)('controller: why a run ended and which Orbit version ran it', () => {
  it('a run that ends because a check environment was broken has the class environment (US1 scenario 1)', async () => {
    const l = lab({ tweak: (c) => void (c.checks.unit = { ...c.checks.unit!, command: ['/nonexistent/acme/bin/run-tests'] }) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = getRun(l.db(), run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done).toMatchObject({ failureClass: 'environment', failureSecondary: null, orbitVersion: ORBIT_VERSION });
    expect(finalJson(l, run.id)).toMatchObject({ outcome: 'BLOCKED', failure_class: 'environment', failure_secondary: null, orbit_version: ORBIT_VERSION });
    const t = buildTimeline(l.db(), done);
    expect(t.entries.filter((e) => e.event === 'state.transition').at(-1)!.data).toMatchObject({ failure_class: 'environment' });
    expect(t.entries.find((e) => e.event === 'run.created')!.data).toMatchObject({ orbit_version: ORBIT_VERSION });
    expect(metricsFor(l.db()).failure_classes.by_class).toMatchObject({ environment: 1, model: 0 });
  }, 60_000);

  it('a run that succeeds has no class (US1 scenario 2)', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = getRun(l.db(), run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(done).toMatchObject({ failureClass: null, failureSecondary: null, orbitVersion: ORBIT_VERSION });
    expect(finalJson(l, run.id)).toMatchObject({ outcome: 'SUCCEEDED', failure_class: null, orbit_version: ORBIT_VERSION });
    const m = metricsFor(l.db());
    expect(m.failure_classes).toMatchObject({ ended: 1, without_class: 1, unclassified: 0 });
    expect(m.by_version).toEqual([expect.objectContaining({ orbit_version: ORBIT_VERSION, runs: 1, accepted: 1, pass_rate: 1 })]);
  }, 60_000);

  it('a run no hypothesis is left for is the model, and a refused dirty start is the environment', async () => {
    const impossible = lab();
    writeScenario(impossible, baseScenario({ implementer: [implementMul('+'), implementMul('*')], verifier: [ALL_RULED_OUT] }));
    const first = startLabRun(impossible);
    await drive(impossible, first.id);
    expect(getRun(impossible.db(), first.id)).toMatchObject({ state: 'IMPOSSIBLE', failureClass: 'model', failureSecondary: null });

    const dirty = lab();
    writeScenario(dirty, baseScenario({ implementer: [implementMul('*')] }));
    writeFileSync(join(dirty.repo, 'apps/notes.txt'), 'uncommitted work in progress\n');
    const second = startLabRun(dirty);
    await drive(dirty, second.id);
    expect(getRun(dirty.db(), second.id)).toMatchObject({ state: 'BLOCKED', failureClass: 'environment', failureSecondary: null });
  }, 120_000);
});
