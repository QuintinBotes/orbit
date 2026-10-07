import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec } from '../../../src/adapters/types.ts';
import { defaultUi } from '../../../src/policy/config.ts';
import type { ExplorationResult, ExplorerRun, SpecResponse } from '../../../src/ui/explore.ts';
import { listFailures } from '../../../src/evidence/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { getWorker, listWorkers } from '../../../src/storage/workers.ts';
import { SPEC_OUTPUT_SCHEMA, exploreCandidate, explorationEnabled, explorationUnverified } from '../../../src/controller/exploration.ts';
import { repoKey } from '../../../src/controller/context.ts';
import { addCandidate, makeUnitLab, setContract, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const usage = { provider: 'claude', model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.05, costSource: 'reported' as const };
const result = (over: Partial<TaskResult> = {}): TaskResult => ({ status: 'succeeded', structured: { findings: [] }, text: null, error: null, exitCode: 0, usage, durationMs: 3, ...over });

/** Answers each collect from a script; null means "not finished yet". */
function adapter(script: (purpose: string, n: number) => TaskResult | null | 'never'): ProviderAdapter & { specs: TaskSpec[] } {
  const seen = new Map<string, number>();
  const a = {
    id: 'claude',
    specs: [] as TaskSpec[],
    async startTask(spec: TaskSpec): Promise<TaskHandle> {
      a.specs.push(spec);
      mkdirSync(spec.workerDir, { recursive: true });
      writeFileSync(join(spec.workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: 2_000_000_000, shimStart: 'x', pgid: 2_000_000_000, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
      return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x', logPath: '', exitPath: '' };
    },
    async collectResult(h: TaskHandle): Promise<TaskResult | null> {
      const purpose = lab.db.get<{ purpose: string }>('SELECT purpose FROM workers WHERE id = ?', h.workerId)?.purpose ?? '';
      const n = (seen.get(purpose) ?? 0) + 1;
      seen.set(purpose, n);
      const r = script(purpose, n);
      return r === 'never' ? null : r;
    },
    async cancelTask(): Promise<void> {},
  };
  return a as unknown as ProviderAdapter & { specs: TaskSpec[] };
}

function setup(a: ProviderAdapter, exploration: object | null = { enabled: true, max_minutes: 1, budget_usd: 1 }) {
  lab = makeUnitLab({
    path: ['PREFLIGHT'],
    adapters: { claude: a },
    tweak: (c) => {
      c.ui = { ...defaultUi(), journey_check_ids: [], ...(exploration ? { exploration } : {}) } as never;
    },
  });
  setContract(lab, { allowed_paths: ['apps/calc.mjs'] });
  lab.deps.registry.seed();
  for (const e of lab.deps.registry.list()) if (e.provider === 'claude') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
  const cand = addCandidate(lab);
  const outDir = join(lab.base, 'out');
  mkdirSync(outDir, { recursive: true });
  return { ctx: lab.ctx(), cand, outDir };
}

const finding = { id: 'UX-1', severity: 'high', summary: 'The total is wrong', steps: ['open /'], expected: '6', observed: '5', proposed_test: 'checks the total', status: 'reproduced', reason: '', spec: { path: 'tests/ui/ux-1.spec.ts', source: 'spec' }, reproduction: 'npx playwright test tests/ui/ux-1.spec.ts' };
const explored = (over: Partial<ExplorationResult> = {}): ExplorationResult =>
  ({ outcome: 'completed', findings: [finding as never], reproduced: [finding as never], unreproduced: [{ id: 'UX-2', status: 'not_reproduced' } as never], observations: [], coverageNotes: null, budgetUsd: 1, maxMinutes: 1, costUsd: 0.1, reasons: [], unverified: [], acceptanceEvidence: false, baseUrl: 'http://127.0.0.1:3000', outDir: '/o', startedAt: 0, endedAt: 1, ...over }) as ExplorationResult;

describe('explorationEnabled and explorationUnverified', () => {
  it('is on only when ui.exploration says so', () => {
    expect(explorationEnabled(null)).toBe(false);
    expect(explorationEnabled(defaultUi())).toBe(false);
    expect(explorationEnabled({ ...defaultUi(), exploration: { enabled: true, max_minutes: 1, budget_usd: 1 } } as never)).toBe(true);
  });

  it('discloses what was not verified, an exploration that did not complete, and candidates that did not reproduce', () => {
    expect(explorationUnverified(explored({ unreproduced: [], unverified: ['no dark mode'] }))).toEqual(['no dark mode']);
    expect(explorationUnverified(explored({ outcome: 'timeout', reasons: ['too slow', 'no app'], unreproduced: [{ id: 'a' } as never, { id: 'b' } as never] }))).toEqual(['UI exploration timeout: too slow; no app', '2 UI exploration candidate(s) did not reproduce as failing tests and do not count']);
    expect(explorationUnverified(explored({ outcome: 'app_failed', reasons: [], unreproduced: [] }))).toEqual(['UI exploration app_failed: no detail']);
  });

  it('the spec output schema asks for the spec source and a note', () => {
    expect(SPEC_OUTPUT_SCHEMA.required).toEqual(['source', 'notes']);
  });
});

describe('exploreCandidate', () => {
  it('does nothing when UI exploration is not configured', async () => {
    const { ctx, cand, outDir } = setup(adapter(() => result()), null);
    expect(await exploreCandidate(ctx, cand, lab.repo, outDir, { exploreUi: async () => { throw new Error('must not run'); } })).toBeNull();
    const off = setup(adapter(() => result()), { enabled: false, max_minutes: 1, budget_usd: 1 });
    expect(await exploreCandidate(off.ctx, off.cand, lab.repo, off.outDir, { exploreUi: async () => { throw new Error('must not run'); } })).toBeNull();
  });

  it('records each reproduced finding as a failure of the candidate, writes the report and one decision, and returns the result', async () => {
    const { ctx, cand, outDir } = setup(adapter(() => result()));
    const res = await exploreCandidate(ctx, cand, lab.repo, outDir, {
      exploreUi: async (o) => {
        expect(o.goal).toBe('Add a mul function to the calculator.');
        // The application under test reads the repository's dependency caches, as the checks do (issue #26).
        expect(o.toolchainCacheRoot).toBe(join(lab.home, 'toolchains', repoKey(lab.repo)));
        return explored();
      },
    });
    expect(res?.outcome).toBe('completed');
    const failures = listFailures(lab.db, lab.runId);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ fingerprint: 'ui-exploration:UX-1', source: 'check', candidateId: cand.id });
    expect(failures[0]?.excerpt).toContain('reproduced UI defect UX-1 (high): The total is wrong; failing spec tests/ui/ux-1.spec.ts; reproduce with: npx playwright test');
    expect(readFileSync(join(outDir, 'exploration.md'), 'utf8')).toContain('# UI exploration (completed)');
    const d = listDecisions(lab.db, lab.runId, { kind: 'ui.exploration' });
    expect(d).toHaveLength(1);
    expect(d[0]?.summary).toBe(`UI exploration of candidate ${cand.seq}: completed; 1 reproduced, 1 not counted`);
    expect(d[0]?.data).toMatchObject({ reproduced: ['UX-1'], unreproduced: [{ id: 'UX-2', status: 'not_reproduced' }], cost_usd: 0.1 });
  });

  it('a finding with no spec or reproduction is not a failure', async () => {
    const { ctx, cand, outDir } = setup(adapter(() => result()));
    const loose = { ...finding, spec: null, reproduction: null };
    await exploreCandidate(ctx, cand, lab.repo, outDir, { exploreUi: async () => explored({ reproduced: [loose as never] }) });
    expect(listFailures(lab.db, lab.runId)).toEqual([]);
  });

  it('runs the explorer as a read-only worker of the run and maps its result', async () => {
    const statuses: Record<string, TaskResult> = { succeeded: result(), timeout: result({ status: 'timeout', error: 't' }), cancelled: result({ status: 'cancelled' }), failed: result({ status: 'failed', error: 'x' }), malformed: result({ status: 'malformed_output' }) };
    const a = adapter((purpose, n) => (n < 2 ? null : (statuses[purpose.split(':')[0] === 'explore' ? current : 'succeeded'] ?? result())));
    let current = 'succeeded';
    const { ctx, cand, outDir } = setup(a);
    const seen: ExplorerRun[] = [];
    for (const key of Object.keys(statuses)) {
      current = key;
      // A fresh purpose per iteration: the finished worker of the previous one would otherwise be returned.
      const c2 = addCandidate(lab, { tree: key.padEnd(40, 'x'), commit: key.padEnd(40, 'y') });
      await exploreCandidate(lab.ctx(), c2, lab.repo, outDir, {
        exploreUi: async (o) => {
          seen.push(await o.explore({ role: 'explorer', baseUrl: 'http://x', viewports: [], browsers: [], goal: 'g', workUnit: 'look around', timeoutMs: 60_000, budgetUsd: 0.5, signal: new AbortController().signal }));
          return explored({ reproduced: [], unreproduced: [] });
        },
      });
    }
    expect(seen.map((s) => s.status)).toEqual(['succeeded', 'timeout', 'cancelled', 'failed', 'failed']);
    expect(seen[0]).toMatchObject({ output: { findings: [] }, costUsd: 0.05, error: null });
    const workers = listWorkers(lab.db, { runId: lab.runId, role: 'explorer' });
    expect(workers).toHaveLength(5);
    expect(workers.every((w) => w.state !== 'RUNNING')).toBe(true);
    const spec = a as unknown as { specs: TaskSpec[] };
    expect(spec.specs[0]).toMatchObject({ role: 'explorer', readOnly: true, maxBudgetUsd: 0.5 });
    expect(spec.specs[0]!.prompt).toContain('look around');
  });

  it('an explorer that does not finish within its allowance is stopped and charged, and reported as a timeout', async () => {
    const a = adapter(() => {
      // Each look at the worker finds it still running, and the run's clock moves on.
      lab.clock.advance(20);
      return 'never';
    });
    const { ctx, cand, outDir } = setup(a);
    let run: ExplorerRun | null = null;
    await exploreCandidate(ctx, cand, lab.repo, outDir, {
      exploreUi: async (o) => {
        run = await o.explore({ role: 'explorer', baseUrl: 'http://x', viewports: [], browsers: [], goal: 'g', workUnit: 'w', timeoutMs: 30, budgetUsd: 1, signal: new AbortController().signal });
        return explored({ reproduced: [], unreproduced: [] });
      },
    });
    expect(run).toMatchObject({ output: null, costUsd: null, status: 'timeout', error: 'the explorer did not finish in time' });
    const [w] = listWorkers(lab.db, { runId: lab.runId, role: 'explorer' });
    expect(w).toMatchObject({ state: 'CANCELLED', cancelRequested: true });
    expect(w?.error).toContain('explore:');
    expect(lab.db.get('SELECT 1 AS x FROM usage WHERE worker_id = ?', w!.id)).toBeTruthy();
  }, 15_000);

  it('an exploration told to stop returns without starting anything', async () => {
    const a = adapter(() => result());
    const { ctx, cand, outDir } = setup(a);
    const ac = new AbortController();
    ac.abort();
    let run: ExplorerRun | null = null;
    await exploreCandidate(ctx, cand, lab.repo, outDir, {
      exploreUi: async (o) => {
        run = await o.explore({ role: 'explorer', baseUrl: 'http://x', viewports: [], browsers: [], goal: 'g', workUnit: 'w', timeoutMs: 1000, budgetUsd: 1, signal: ac.signal });
        return explored({ reproduced: [], unreproduced: [] });
      },
    });
    expect(run).toEqual({ output: null, costUsd: null, status: 'cancelled', error: 'the explorer did not finish in time' });
    expect(listWorkers(lab.db, { runId: lab.runId, role: 'explorer' })).toEqual([]);
  });

  it('a step that was itself aborted is cancelled the same way, and a controller that was aborted reports a timeout', async () => {
    const ac = new AbortController();
    const { ctx, cand, outDir } = setup(adapter(() => result()));
    const runs: ExplorerRun[] = [];
    ac.abort();
    const aborted = lab.ctx(ac.signal);
    await exploreCandidate(aborted, cand, lab.repo, outDir, {
      exploreUi: async (o) => {
        runs.push(await o.explore({ role: 'explorer', baseUrl: 'http://x', viewports: [], browsers: [], goal: 'g', workUnit: 'w', timeoutMs: 1000, budgetUsd: 1, signal: new AbortController().signal }));
        return explored({ reproduced: [], unreproduced: [] });
      },
    });
    expect(runs[0]?.status).toBe('timeout');
  });

  it('asks a second worker to write one spec per candidate finding and returns its source', async () => {
    const a = adapter((purpose, n) => (n < 2 ? null : result({ structured: { source: 'import { test } from "@playwright/test";', notes: 'n' } })));
    const { ctx, cand, outDir } = setup(a);
    const out: (SpecResponse | null)[] = [];
    await exploreCandidate(ctx, cand, lab.repo, outDir, {
      exploreUi: async (o) => {
        const req = { finding: { id: 'UX-9', summary: 's', steps: ['a'], expected: 'e', observed: 'o', proposed_test: 'p' } as never, baseUrl: 'http://x', viewport: { width: 390, height: 844 }, fileName: 'ux-9.spec.ts', budgetUsd: 0.2, signal: new AbortController().signal };
        out.push(await o.authorSpec(req));
        out.push(await o.authorSpec({ ...req, viewport: null, finding: { ...(req.finding as object), id: 'UX-10' } as never }));
        return explored({ reproduced: [], unreproduced: [] });
      },
    });
    expect(out[0]).toEqual({ source: 'import { test } from "@playwright/test";', costUsd: 0.05 });
    expect(out[1]).toEqual({ source: 'import { test } from "@playwright/test";', costUsd: 0.05 });
    const spec = (a as unknown as { specs: TaskSpec[] }).specs;
    expect(spec[0]!.prompt).toContain('Viewport 390x844.');
    expect(spec[0]!.prompt).not.toContain('Viewport undefined');
    expect(spec[1]!.prompt).not.toContain('Viewport 390');
    expect(spec[0]!.outputSchema).toBe(SPEC_OUTPUT_SCHEMA);
    expect(listWorkers(lab.db, { runId: lab.runId }).map((w) => w.purpose)).toEqual([`explore-spec:${cand.id}:UX-9`, `explore-spec:${cand.id}:UX-10`]);
  });

  it.each([
    ['a failed worker', result({ status: 'failed' })],
    ['no output', result({ structured: null })],
    ['a source that is not text', result({ structured: { source: 5 } })],
    ['an empty source', result({ structured: { source: '   ' } })],
  ])('no spec comes back from %s', async (_why, r) => {
    const a = adapter((_p, n) => (n < 2 ? null : r));
    const { ctx, cand, outDir } = setup(a);
    let out: SpecResponse | null = { source: 'x', costUsd: null };
    await exploreCandidate(ctx, cand, lab.repo, outDir, {
      exploreUi: async (o) => {
        out = await o.authorSpec({ finding: { id: 'UX-1', summary: 's', steps: [], expected: 'e', observed: 'o', proposed_test: 'p' } as never, baseUrl: 'http://x', viewport: null, fileName: 'a.spec.ts', budgetUsd: 0.2, signal: new AbortController().signal });
        return explored({ reproduced: [], unreproduced: [] });
      },
    });
    expect(out).toBeNull();
    expect(existsSync(join(outDir, 'exploration.md'))).toBe(true);
  });

  it('requires the contract: exploration before CONTRACTING finished is an error', async () => {
    const a = adapter(() => result());
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: a }, tweak: (c) => void (c.ui = { ...defaultUi(), exploration: { enabled: true, max_minutes: 1, budget_usd: 1 } } as never) });
    const cand = addCandidate(lab);
    await expect(exploreCandidate(lab.ctx(), cand, lab.repo, lab.base, { exploreUi: async () => explored() })).rejects.toMatchObject({ code: 'CONTRACT_INVALID' });
  });
});
