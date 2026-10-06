import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec } from '../../../src/adapters/types.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import type { BudgetLedger } from '../../../src/scheduling/budget.ts';
import { getWorker, listWorkers } from '../../../src/storage/workers.ts';
import { curatorModelFor, finalizeRun, learnAtTerminal, runCurator, type CuratorHost } from '../../../src/controller/report.ts';
import { getRun, transition } from '../../../src/controller/run-store.ts';
import { initLedger, makeUnitLab, OWNER, type UnitLab } from './coverage-helpers.ts';
import { capturingLogger } from './coverage-log.ts';

let lab: UnitLab;
afterEach(() => {
  vi.useRealTimers();
  lab?.cleanup();
});

const usage = { provider: 'claude', model: 'claude-haiku-x', inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.02, costSource: 'reported' as const };
const ok = (over: Partial<TaskResult> = {}): TaskResult => ({ status: 'succeeded', structured: { lessons: [] }, text: null, error: null, exitCode: 0, usage, durationMs: 4, ...over });

interface Stub extends ProviderAdapter {
  specs: TaskSpec[];
  cancelled: number;
}
function adapter(over: { start?: () => Promise<TaskHandle>; collect?: () => Promise<TaskResult | null> } = {}): Stub {
  const a = {
    id: 'claude',
    specs: [] as TaskSpec[],
    cancelled: 0,
    async startTask(spec: TaskSpec): Promise<TaskHandle> {
      a.specs.push(spec);
      if (over.start) return over.start();
      return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x', logPath: '', exitPath: '' };
    },
    async collectResult(): Promise<TaskResult | null> {
      return over.collect ? over.collect() : ok();
    },
    async cancelTask(): Promise<void> {
      a.cancelled++;
    },
  } as unknown as Stub;
  return a;
}

function host(over: Partial<CuratorHost> = {}, recorded = false): CuratorHost {
  const ctx = lab.ctx();
  return {
    deps: { adapters: lab.deps.adapters, registry: lab.deps.registry, orbitInstallDir: lab.deps.orbitInstallDir, hostEnv: { PATH: process.env.PATH }, homeDir: join(lab.base, 'home2') },
    clock: lab.clock,
    snapshot: ctx.snapshot,
    policyPath: ctx.run.policyPath,
    policyHash: ctx.run.policyHash,
    runId: lab.runId,
    dir: join(ctx.runDir, 'learning'),
    budgetUsd: 0.5,
    ...(recorded ? { recorded: ctx } : {}),
    ...over,
  };
}

describe('curatorModelFor', () => {
  it('is the Haiku model validated on the CLI surface, and none when there is none', () => {
    lab = makeUnitLab();
    expect(curatorModelFor(lab.deps.registry)).toBeNull();
    lab.deps.registry.seed();
    for (const e of lab.deps.registry.list()) if (e.provider === 'claude') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
    const model = curatorModelFor(lab.deps.registry);
    expect(lab.deps.registry.get(model!)?.family).toBe('haiku');
    for (const e of lab.deps.registry.list()) if (e.family === 'haiku') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', false, 'withdrawn');
    expect(curatorModelFor(lab.deps.registry)).toBeNull();
  });
});

describe('runCurator without a run', () => {
  it('needs a claude provider', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await expect(runCurator(host(), { prompt: 'p' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('runs the task read-only under the run\'s policy and returns the structured output with no worker recorded', async () => {
    const a = adapter();
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: a } });
    const out = await runCurator(host({ deps: { ...host().deps, adapters: { claude: a } } }), { prompt: 'curate this' }, 'claude-haiku-x');
    expect(out).toEqual({ output: { lessons: [] }, model: 'claude-haiku-x', workerId: null });
    const spec = a.specs[0]!;
    // 6 turns, not 3: a structured-output retry counts as a turn, and 3 ended live curators max_turns (e2e retest Nm6).
    expect(spec).toMatchObject({ role: 'curator', readOnly: true, maxTurns: 6, prompt: 'curate this', model: 'claude-haiku-x', maxBudgetUsd: 0.5, workerId: `${lab.runId}-curator` });
    expect(spec.workerDir.endsWith(join('learning', 'curator'))).toBe(true);
    expect(listWorkers(lab.db, { runId: lab.runId })).toEqual([]);
  });

  it('a result that is not a success is an error naming the status, and a rejected credential is an authentication error', async () => {
    let result: TaskResult = ok({ status: 'failed', error: 'model refused sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' });
    const a = adapter({ collect: async () => result });
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: a } });
    const h = host({ deps: { ...host().deps, adapters: { claude: a } } });
    const failed = await runCurator(h, { prompt: 'p' }, null).catch((e: unknown) => e);
    expect(failed).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect((failed as Error).message).toContain('the curator ended failed: model refused');
    expect((failed as Error).message).not.toContain('abcdefghijklmnopqrstuvwxyz');
    result = ok({ status: 'auth_failed', error: null });
    expect(await runCurator(h, { prompt: 'p' }, null).catch((e: unknown) => e)).toMatchObject({ code: 'AUTH_EXPIRED', message: 'the curator ended auth_failed' });
  });

  it('polls until the provider has a result', async () => {
    let calls = 0;
    const a = adapter({ collect: async () => (++calls < 3 ? null : ok()) });
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: a } });
    const out = await runCurator(host({ deps: { ...host().deps, adapters: { claude: a } } }), { prompt: 'p' }, null);
    expect(out.output).toEqual({ lessons: [] });
    expect(calls).toBe(3);
  });

  it('uses the host environment for the provider configuration directory', async () => {
    const a = adapter();
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: a } });
    const h = host({ deps: { ...host().deps, adapters: { claude: a }, hostEnv: undefined }, env: { CLAUDE_CONFIG_DIR: join(lab.base, 'claude-cfg'), PATH: process.env.PATH }, homeDir: join(lab.base, 'h3') });
    await runCurator(h, { prompt: 'p' }, null);
    expect(JSON.stringify(a.specs[0]!.sandbox)).toContain('claude-cfg');
  });
});

describe('runCurator as a recorded worker of the run', () => {
  it('records the worker before the spawn, finishes it with the result, and charges its cost to the closing budget', async () => {
    const a = adapter();
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: a } });
    initLedger(lab);
    const h = host({ deps: { ...host().deps, adapters: { claude: a } } }, true);
    const out = await runCurator(h, { prompt: 'p' }, 'claude-haiku-x');
    expect(out.workerId).toBe(`${lab.runId}-curator-1`);
    const w = getWorker(lab.db, out.workerId!);
    expect(w).toMatchObject({ role: 'curator', purpose: 'curate:1', state: 'SUCCEEDED' });
    expect(lab.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM usage WHERE worker_id = ?', w.id)?.n).toBe(1);
    const second = await runCurator({ ...h, recorded: lab.ctx() }, { prompt: 'p' }, null);
    expect(second.workerId).toBe(`${lab.runId}-curator-2`);
    expect(lab.db.get('SELECT 1 AS x FROM events WHERE type = ?', 'worker.spend-cap')).toBeTruthy();
  });

  it('a spawn that fails finishes the worker FAILED with the redacted error and rethrows', async () => {
    const a = adapter({
      start: async () => {
        throw new Error('spawn failed sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF');
      },
    });
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: a } });
    const h = host({ deps: { ...host().deps, adapters: { claude: a } } }, true);
    await expect(runCurator(h, { prompt: 'p' }, null)).rejects.toThrow('spawn failed');
    const [w] = listWorkers(lab.db, { runId: lab.runId, role: 'curator' });
    expect(w).toMatchObject({ state: 'FAILED', resultStatus: 'failed' });
    expect(w?.error).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('a failed result is recorded and its cost still charged; a cost that cannot be charged is logged, not thrown', async () => {
    const cap = capturingLogger();
    const a = adapter({ collect: async () => ok({ status: 'failed', error: 'x' }) });
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: a }, logger: cap.logger });
    initLedger(lab);
    const ctx = lab.ctx();
    ctx.ledger = Object.assign(Object.create(ctx.ledger!), {
      consumeCost: () => {
        throw new OrbitError('BUDGET_EXHAUSTED', 'closing reserve spent');
      },
    }) as BudgetLedger;
    const h = host({ deps: { ...host().deps, adapters: { claude: a } } }, true);
    await expect(runCurator({ ...h, recorded: ctx }, { prompt: 'p' }, null)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(cap.lines().some((l) => l.msg === 'curator cost could not be charged' && l.error === 'closing reserve spent')).toBe(true);
    expect(listWorkers(lab.db, { runId: lab.runId, role: 'curator' })[0]?.state).toBe('FAILED');
  });

  it('a curator that outlives its timeout is cancelled and reported as timed out, its late result still recorded', async () => {
    let n = 0;
    const a = adapter({ collect: async () => (++n === 1 ? null : ok()) });
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: a } });
    const h = host({ deps: { ...host().deps, adapters: { claude: a } }, timeoutMs: -31_000 }, true);
    await expect(runCurator(h, { prompt: 'p' }, null)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: 'the curator timed out' });
    expect(a.cancelled).toBe(1);
    expect(listWorkers(lab.db, { runId: lab.runId, role: 'curator' })[0]?.state).toBe('SUCCEEDED');
  });

  it('a curator that never answers after being cancelled is recorded LOST', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const a = adapter({ collect: async () => null });
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: a } });
    const h = host({ deps: { ...host().deps, adapters: { claude: a } }, timeoutMs: -31_000 }, true);
    const outcome = runCurator(h, { prompt: 'p' }, null).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await outcome).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: 'the curator timed out' });
    expect(listWorkers(lab.db, { runId: lab.runId, role: 'curator' })[0]).toMatchObject({ state: 'LOST', error: 'the curator did not stop after it timed out' });
  });
});

describe('learnAtTerminal', () => {
  const enable = (c: { knowledge: { enabled: boolean } }): void => {
    c.knowledge.enabled = true;
  };
  const events = (type: string): { data_json: string | null }[] => lab.db.all('SELECT data_json FROM events WHERE run_id = ? AND type = ?', lab.runId, type);

  it('does nothing while learning is off', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await learnAtTerminal(lab.ctx());
    expect(existsSync(join(lab.ctx().runDir, 'learning.json'))).toBe(false);
  });

  it.each([
    ['the curator budget is zero', { claude: true }, (c: { knowledge: { enabled: boolean; curator_budget_usd: number } }) => void (c.knowledge.curator_budget_usd = 0), 'knowledge.curator_budget_usd is 0'],
    ['there is no Claude adapter', { claude: false }, () => undefined, 'no claude adapter for the curator'],
  ])('skips curation when %s, and records why', async (_why, flags, tweak, reason) => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: flags.claude ? { claude: adapter() } : {}, tweak: (c) => (enable(c), tweak(c as never)) });
    await learnAtTerminal(lab.ctx());
    const summary = JSON.parse(readFileSync(join(lab.ctx().runDir, 'learning.json'), 'utf8'));
    expect(summary).toMatchObject({ learn: null, skipped: reason });
    expect(JSON.parse(events('learning.curation-skipped')[0]!.data_json!)).toEqual({ reason });
    expect(events('learning.completed')).toHaveLength(1);
  });

  it('skips curation of a cancelled run and does not evaluate overlays for it', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter() }, tweak: enable });
    transition(lab.db, { runId: lab.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'x' }, lab.clock);
    await learnAtTerminal(lab.ctx());
    expect(JSON.parse(readFileSync(join(lab.ctx().runDir, 'learning.json'), 'utf8'))).toMatchObject({ skipped: 'cancelled runs are not curated', overlays: null });
  });

  it('skips curation when the closing reserve cannot pay for it', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter() }, tweak: enable });
    initLedger(lab);
    lab.db.run("UPDATE budget_counters SET used = hard_cap WHERE counter = 'cost_usd'");
    await learnAtTerminal(lab.ctx());
    const summary = JSON.parse(readFileSync(join(lab.ctx().runDir, 'learning.json'), 'utf8'));
    expect(summary.skipped).toMatch(/^the budget reserve cannot pay for curation: /);
  });

  it('with curation admitted and nothing to learn from, settles the run and evaluates overlays', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter() }, tweak: enable });
    initLedger(lab);
    transition(lab.db, { runId: lab.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'x' }, lab.clock);
    lab.db.run("UPDATE runs SET state = 'EXHAUSTED' WHERE id = ?", lab.runId);
    await learnAtTerminal(lab.ctx());
    const summary = JSON.parse(readFileSync(join(lab.ctx().runDir, 'learning.json'), 'utf8'));
    expect(summary.learn).toMatchObject({ skipped: 'no observations' });
    expect(summary.skipped).toBeNull();
    expect(summary.overlays).toMatchObject({ live: [], evaluated: expect.anything() });
  });

  it('promotes to the global graph only when the repository opted in', async () => {
    lab = makeUnitLab({
      path: ['PREFLIGHT'],
      adapters: { claude: adapter() },
      tweak: (c) => {
        enable(c);
        c.knowledge.share_globally = true;
      },
    });
    lab.db.run("UPDATE runs SET state = 'EXHAUSTED' WHERE id = ?", lab.runId);
    await learnAtTerminal(lab.ctx());
    const summary = JSON.parse(readFileSync(join(lab.ctx().runDir, 'learning.json'), 'utf8'));
    expect(summary.promoted).not.toBeNull();
    expect(existsSync(join(lab.home, 'knowledge.sqlite'))).toBe(true);
  });

  it('finalizeRun runs the whole hook for a settled run', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter() }, tweak: enable });
    lab.db.run("UPDATE runs SET state = 'EXHAUSTED' WHERE id = ?", lab.runId);
    await finalizeRun(lab.ctx());
    expect(existsSync(join(lab.ctx().runDir, 'final.md'))).toBe(true);
    expect(events('learning.completed')).toHaveLength(1);
    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
  });
});
