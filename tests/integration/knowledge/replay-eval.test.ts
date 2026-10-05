import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { ReplayEvalRunner } from '../../../src/controller/eval-runner.ts';
import { repoKey } from '../../../src/controller/context.ts';
import { buildReplaySuite } from '../../../src/knowledge/evals.ts';
import { evaluateAndDecide } from '../../../src/controller/eval-runner.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import type { OrbitDb } from '../../../src/storage/db.ts';
import { baseScenario, DIAGNOSIS, git, implementMul, labDeps, makeLab, startLabRun, writeScenario, type Lab } from '../controller/harness.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { completeEvaluation, startEvaluation } from '../../../src/knowledge/overlays.ts';
import { seedCandidateOverlay, seedLessons, variantDeps, type Variants } from './helpers.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
function lab(): Lab {
  const l = makeLab({
    tweak: (c) => {
      c.scheduler.hard_limits.implementation_attempts = 1;
      c.scheduler.initial_allowances = { simple_attempts: 1, medium_attempts: 1, complex_attempts: 1 };
      // A replayed run is capped at what is left of this, and a run needs headroom for one implementer ceiling.
      c.knowledge = { ...c.knowledge, enabled: true, curator_budget_usd: 0, eval_budget_usd: 40, auto_adopt_overlays: true };
    },
  });
  labs.push(l);
  return l;
}
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

const TIMING = { tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 };

async function drive(deps: ConstructorParameters<typeof Controller>[0]['deps'], runId: string): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps, ...TIMING }).start();
}

/** One past task that succeeded (the replay suite's only case), run through the real controller. */
async function succeededSourceRun(l: Lab): Promise<string> {
  writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
  const run = startLabRun(l);
  await drive(labDeps(l), run.id);
  expect(l.db().get<{ state: string }>('SELECT state FROM runs WHERE id = ?', run.id)?.state).toBe('SUCCEEDED');
  return run.id;
}

/** With the overlay the implementer does the right thing; without it, it does not (and the attempt budget is one). */
const IMPROVES: Variants = {
  withOverlay: baseScenario({ implementer: [implementMul('*')] }),
  without: baseScenario({ implementer: [implementMul('+')], verifier: [DIAGNOSIS] }),
};

function runnerFor(l: Lab, variants: Variants, over: Partial<ConstructorParameters<typeof ReplayEvalRunner>[0]> = {}): ReplayEvalRunner {
  const deps = variantDeps(l, variants);
  return new ReplayEvalRunner({ repoRoot: l.repo, config: l.config, clock: systemClock, orbitHome: l.orbitHome, budgetUsd: 40, registryDb: l.db(), deps: (input) => deps(input.db as OrbitDb), controller: TIMING, ...over });
}

describe.skipIf(!canStripTypes)('replay evaluation of a candidate overlay, with fake providers', () => {
  it('adopts a candidate that raises the verified pass rate, replaying real runs in throwaway clones', async () => {
    const l = lab();
    await succeededSourceRun(l);
    const overlay = seedCandidateOverlay(l);
    const runner = runnerFor(l, IMPROVES);
    const store = KnowledgeStore.open(join(l.repo, '.orbit', 'knowledge.sqlite'));
    try {
      const suite = buildReplaySuite(l.db(), { limit: 5, role: 'implementer' }, systemClock);
      expect(suite.cases).toHaveLength(1);
      const out = await evaluateAndDecide({ store, overlay, runner, suite });
      expect(out.adopted, out.reason).toBe(true);
      expect(out.overlay).toMatchObject({ status: 'active', eval: { improved: true, cases: 1, baseline: { verified_pass_rate: 0 }, candidate: { verified_pass_rate: 1 } } });
      expect(store.activeOverlay('implementer', 'repo')?.id).toBe(overlay.id);
    } finally {
      store.close();
    }
    // Bounded by the budget, and nothing leaked out of the clones.
    // (The Codex review reports no cost, so its ceiling is charged: unmeasured is never counted as free.)
    expect(runner.spentUsd).toBeGreaterThan(0);
    expect(runner.spentUsd).toBeLessThan(40);
    const branches = git(l.repo, 'branch', '--list', 'orbit/*').split('\n').filter(Boolean);
    expect(branches).toHaveLength(1);
    expect(readdirSync(join(l.orbitHome, 'eval', repoKey(l.repo)))).toEqual([]);
    expect(l.db().all('SELECT id FROM runs')).toHaveLength(1);
  }, 120_000);

  it('rejects a candidate that regresses a metric, and keeps the evaluation', async () => {
    const l = lab();
    await succeededSourceRun(l);
    const overlay = seedCandidateOverlay(l);
    // The overlay makes the implementer worse: the base prompt verifies, the candidate does not.
    const worse: Variants = { withOverlay: IMPROVES.without, without: IMPROVES.withOverlay };
    const store = KnowledgeStore.open(join(l.repo, '.orbit', 'knowledge.sqlite'));
    try {
      const suite = buildReplaySuite(l.db(), { limit: 5, role: 'implementer' }, systemClock);
      const out = await evaluateAndDecide({ store, overlay, runner: runnerFor(l, worse), suite });
      expect(out.adopted).toBe(false);
      expect(out.reason).toMatch(/regression in .*verified_pass_rate/);
      expect(out.overlay).toMatchObject({ status: 'rejected', eval: { improved: false, regressions: expect.arrayContaining(['verified_pass_rate']), baseline: { verified_pass_rate: 1 }, candidate: { verified_pass_rate: 0 } } });
      expect(store.activeOverlay('implementer', 'repo')).toBeNull();
    } finally {
      store.close();
    }
  }, 120_000);

  it('stops when the evaluation budget is spent instead of replaying more cases', async () => {
    const l = lab();
    await succeededSourceRun(l);
    const overlay = seedCandidateOverlay(l);
    // The baseline arm costs more than the whole budget, so the candidate arm is never started.
    const pricey: Variants = { ...IMPROVES, without: baseScenario({ implementer: [{ ...(implementMul('*') as object), usage: { costUSD: 9.5 } }] }) };
    const store = KnowledgeStore.open(join(l.repo, '.orbit', 'knowledge.sqlite'));
    try {
      const suite = buildReplaySuite(l.db(), { limit: 5, role: 'implementer' }, systemClock);
      const runner = runnerFor(l, pricey, { budgetUsd: 9 });
      await expect(evaluateAndDecide({ store, overlay, runner, suite })).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED', message: expect.stringMatching(/budget of \$9\.00 is spent/) });
      expect(runner.spentUsd).toBeGreaterThanOrEqual(9);
      expect(store.getOverlay(overlay.id)?.status).toBe('evaluating');
    } finally {
      store.close();
    }
  }, 120_000);

  it('says so when the budget is too small for the replayed run to start, instead of recording two identical failures', async () => {
    const l = lab();
    await succeededSourceRun(l);
    const overlay = seedCandidateOverlay(l);
    const store = KnowledgeStore.open(join(l.repo, '.orbit', 'knowledge.sqlite'));
    try {
      const suite = buildReplaySuite(l.db(), { limit: 5, role: 'implementer' }, systemClock);
      await expect(evaluateAndDecide({ store, overlay, runner: runnerFor(l, IMPROVES, { budgetUsd: 0.5 }), suite })).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED', message: expect.stringMatching(/too small/) });
    } finally {
      store.close();
    }
  }, 120_000);

  it('orbit learn eval replays through the controller without an injected runner (no more exit 7)', async () => {
    const l = lab();
    await succeededSourceRun(l);
    seedLessons(l);
    // The CLI loads the repository's policy from .orbit/config.yaml; JSON is YAML.
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), JSON.stringify(l.config));
    const deps = variantDeps(l, IMPROVES);
    const io = memoryIo('');
    const code = await main(['learn', 'eval', '--role', 'implementer', '--json'], {
      io,
      cwd: l.repo,
      homeDir: l.base,
      orbitHome: l.orbitHome,
      env: { ...process.env, ORBIT_HOME: l.orbitHome },
      user: 'alice',
      seams: { controllerDeps: (input) => deps(input.db as OrbitDb), controller: TIMING },
    });
    expect(code, io.stderr).toBe(0);
    const j = JSON.parse(io.stdout) as { decision: { adopt: boolean }; overlay: { status: string; eval: { baseline: { verified_pass_rate: number }; candidate: { verified_pass_rate: number } } } };
    expect(j.decision.adopt).toBe(true);
    expect(j.overlay.status).toBe('active');
    expect([j.overlay.eval.baseline.verified_pass_rate, j.overlay.eval.candidate.verified_pass_rate]).toEqual([0, 1]);
  }, 120_000);

  it('finalizeRun evaluates a waiting candidate when auto_adopt_overlays is on and the budget allows, and adopts on improvement', async () => {
    const l = lab();
    await succeededSourceRun(l);
    const overlay = seedCandidateOverlay(l);
    // A live run without the overlay: the buggy implementer exhausts the one-attempt budget, so the run ends EXHAUSTED and finalizes.
    const deps = variantDeps(l, IMPROVES);
    const run = startLabRun(l, 'Add a mul function again.');
    await drive(deps(l.db()), run.id);
    const done = l.db().get<{ state: string }>('SELECT state FROM runs WHERE id = ?', run.id);
    expect(done?.state).toBe('EXHAUSTED');
    const learning = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'learning.json'), 'utf8')) as { overlays: { evaluated: { overlay: string; adopted: boolean; spent_usd: number } } };
    expect(learning.overlays.evaluated).toMatchObject({ overlay: overlay.id, adopted: true });
    expect(learning.overlays.evaluated.spent_usd).toBeGreaterThan(0);
    const store = KnowledgeStore.open(join(l.repo, '.orbit', 'knowledge.sqlite'));
    try {
      expect(store.getOverlay(overlay.id)).toMatchObject({ status: 'active', eval: { improved: true } });
    } finally {
      store.close();
    }
  }, 180_000);

  it('does not evaluate when auto_adopt_overlays is off or the evaluation budget is 0', async () => {
    for (const tweak of [(c: Lab['config']) => void (c.knowledge.auto_adopt_overlays = false), (c: Lab['config']) => void (c.knowledge.eval_budget_usd = 0)]) {
      const l = lab();
      tweak(l.config);
      writeFileSync(l.configPath, JSON.stringify(l.config));
      await succeededSourceRun(l);
      const overlay = seedCandidateOverlay(l);
      const run = startLabRun(l, 'Add a mul function again.');
      await drive(variantDeps(l, IMPROVES)(l.db()), run.id);
      const learning = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'learning.json'), 'utf8')) as { overlays: { evaluated: { skipped: string } } };
      expect(learning.overlays.evaluated.skipped).toMatch(/auto_adopt_overlays is off|eval_budget_usd is 0/);
      const store = KnowledgeStore.open(join(l.repo, '.orbit', 'knowledge.sqlite'));
      try {
        expect(store.getOverlay(overlay.id)?.status).toBe('candidate');
      } finally {
        store.close();
      }
      expect(existsSync(join(l.orbitHome, 'eval'))).toBe(false);
    }
  }, 240_000);

  it('finalizeRun rolls an adopted overlay back when live runs regress against its adoption baseline', async () => {
    const l = lab();
    await succeededSourceRun(l);
    const candidate = seedCandidateOverlay(l);
    const store = KnowledgeStore.open(join(l.repo, '.orbit', 'knowledge.sqlite'));
    try {
      // Adopted on replay evidence of a 90% verified pass rate...
      startEvaluation(store, candidate.id);
      const adopted = completeEvaluation(store, candidate.id, {
        cases: 4,
        suite_id: 'suite-test',
        baseline: { verified_pass_rate: 0.9, mean_attempts: 1, mean_cost_usd: 0.1, false_pass_rate: 0 },
        candidate: { verified_pass_rate: 1, mean_attempts: 1, mean_cost_usd: 0.1, false_pass_rate: 0 },
        baseline_overlay_id: null,
      });
      expect(adopted.overlay.status).toBe('active');
      // ...and then four tasks settle without a verified result, and a fifth run (a real one) ends the same way.
      for (let i = 0; i < 4; i++) {
        createRun(l.db(), { id: `live-${i}`, repoRoot: l.repo, goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, systemClock);
        l.db().run("UPDATE runs SET state = 'EXHAUSTED' WHERE id = ?", `live-${i}`);
      }
      writeScenario(l, baseScenario({ implementer: [implementMul('+')], verifier: [DIAGNOSIS] }));
      const run = startLabRun(l, 'Add a mul function again.');
      await drive(labDeps(l), run.id);
      expect(l.db().get<{ state: string }>('SELECT state FROM runs WHERE id = ?', run.id)?.state).toBe('EXHAUSTED');

      const learning = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'learning.json'), 'utf8')) as { overlays: { live: { overlay_id: string; rollback: boolean; tasks: number }[] } };
      expect(learning.overlays.live).toEqual([expect.objectContaining({ overlay_id: candidate.id, rollback: true, tasks: 5 })]);
      expect(store.getOverlay(candidate.id)?.status).toBe('rolled_back');
      expect(store.activeOverlay('implementer', 'repo')).toBeNull();
    } finally {
      store.close();
    }
  }, 120_000);
});
