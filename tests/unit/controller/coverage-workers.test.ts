import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec, UsageReport, WorkerRole } from '../../../src/adapters/types.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';
import { ROLE_OUTPUT_KIND } from '../../../src/adapters/prompt.ts';
import { BudgetLedger, ROLE_COST_CEILING_USD } from '../../../src/scheduling/budget.ts';
import { finishWorker, getWorker, listWorkers, markWorkerRunning, planWorker, type WorkerRecord } from '../../../src/storage/workers.ts';
import { getDecision } from '../../../src/storage/decisions.ts';
import { acquireLease, releaseLease } from '../../../src/controller/run-store.ts';
import {
  accountWorker,
  adapterFor,
  authFailureSpentNothing,
  collectIfFinished,
  committedSpendUsd,
  ensureWorker,
  messageOf,
  outcomeOf,
  recordSpendCap,
  routeFor,
  schemaFor,
  sessionSpendCap,
  stopActiveWorkers,
  storedResult,
  systemPromptFor,
  workersFor,
  type WorkerRequest,
} from '../../../src/controller/workers.ts';
import { capturingLogger } from './coverage-log.ts';
import { makeUnitLab, OWNER, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const usage = (over: Partial<UsageReport> = {}): UsageReport => ({ provider: 'claude', model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable', ...over });
const result = (over: Partial<TaskResult> = {}): TaskResult => ({ status: 'succeeded', structured: { ok: true }, text: null, error: null, exitCode: 0, usage: usage(), durationMs: 12, ...over });
const DEAD = 2_000_000_000;

interface Stub extends ProviderAdapter {
  specs: TaskSpec[];
  collects: number;
}

/** A provider that records what it is asked and writes the files a real shim would. */
function stub(over: { startTask?: (spec: TaskSpec) => Promise<TaskHandle>; collect?: () => Promise<TaskResult | null>; reattach?: (dir: string) => TaskHandle | null } = {}): Stub {
  const s = {
    id: 'claude',
    specs: [] as TaskSpec[],
    collects: 0,
    async startTask(spec: TaskSpec): Promise<TaskHandle> {
      s.specs.push(spec);
      if (over.startTask) return over.startTask(spec);
      writePid(spec.workerDir);
      return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: DEAD, pgid: DEAD, procStart: 'x', logPath: join(spec.workerDir, 'log.jsonl'), exitPath: join(spec.workerDir, 'exit.json') };
    },
    async collectResult(): Promise<TaskResult | null> {
      s.collects++;
      return over.collect ? over.collect() : null;
    },
    ...(over.reattach ? { reattach: over.reattach } : {}),
  } as unknown as Stub;
  return s;
}

function writePid(dir: string, shimPid = DEAD): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pid.json'), JSON.stringify({ version: 1, shimPid, shimStart: 'x', pgid: shimPid, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
}

function request(over: Partial<WorkerRequest> = {}): WorkerRequest {
  return { role: 'planner', purpose: 'plan:1', provider: 'claude', model: 'claude-sonnet-x', effort: null, cwd: lab.repo, readOnly: true, prompt: (id) => `work for ${id}`, ...over };
}

function withLedger(): void {
  new BudgetLedger(lab.db, lab.clock).init(lab.runId, lab.ctx().snapshot, 'medium');
}

function active(role: WorkerRole = 'planner', purpose = 'plan:1'): WorkerRecord {
  return planWorker(lab.db, { id: `wrk-${purpose}`, runId: lab.runId, role, purpose, provider: 'claude', model: null, workerDir: join(lab.base, 'w', purpose.replace(/\W/g, '_')), cwd: lab.repo }, lab.clock, OWNER);
}

describe('ensureWorker: a fresh work unit', () => {
  it('plans the worker, starts it with the role prompt, schema, sandbox and bounds, and marks it running', async () => {
    const adapter = stub();
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    const out = await ensureWorker(ctx, request({ maxBudgetUsd: 2.5, ownedPaths: ['apps/**'], attempt: 2, candidateId: 'cand-1' }));
    expect(out.status).toBe('running');
    expect(out.worker).toMatchObject({ state: 'RUNNING', role: 'planner', purpose: 'plan:1', attempt: 2, candidateId: 'cand-1', pid: DEAD });
    expect(out.worker.ownedPaths).toEqual(['apps/**']);
    const spec = adapter.specs[0]!;
    expect(spec).toMatchObject({ runId: lab.runId, role: 'planner', cwd: lab.repo, readOnly: true, maxBudgetUsd: 2.5, env: {}, policyPath: ctx.run.policyPath, policyHash: ctx.run.policyHash });
    expect(spec.prompt).toBe(`work for ${out.worker.id}`);
    expect(spec.systemPrompt.length).toBeGreaterThan(100);
    expect(spec.outputSchema).toBe(MODEL_OUTPUT_SCHEMAS[ROLE_OUTPUT_KIND.planner]);
    expect(spec.maxTurns).toBe(ctx.snapshot.config.scheduler.hard_limits.worker_turns_per_session);
    expect(spec.timeoutMs).toBeLessThanOrEqual(ctx.timing.workerTimeoutMs);
    expect(spec.workerDir).toBe(join(ctx.runDir, 'workers', out.worker.id));
    expect(existsSync(spec.workerDir)).toBe(true);
    expect(spec.sandbox).toBeDefined();
  });

  it('leaves the spend cap out of the spec unless the request names one, and carries an explicit null', async () => {
    const adapter = stub();
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    await ensureWorker(lab.ctx(), request({ purpose: 'a' }));
    await ensureWorker(lab.ctx(), request({ purpose: 'b', maxBudgetUsd: null }));
    expect('maxBudgetUsd' in adapter.specs[0]!).toBe(false);
    expect((adapter.specs[1] as { maxBudgetUsd?: number | null }).maxBudgetUsd).toBeNull();
  });

  it('uses the ledger turn cap and the remaining wall time, never less than a minute, and a Codex model gets the Codex sandbox', async () => {
    const adapter = stub();
    lab = makeUnitLab({ adapters: { claude: adapter, codex: adapter }, path: ['PREFLIGHT'] });
    withLedger();
    const ctx = lab.ctx();
    expect(ctx.ledger).not.toBeNull();
    await ensureWorker(ctx, request({ purpose: 'ledgered' }));
    expect(adapter.specs[0]!.maxTurns).toBe(ctx.ledger!.maxTurnsPerSession());
    const wall = ctx.ledger!.state('wall_ms');
    expect(adapter.specs[0]!.timeoutMs).toBe(Math.max(60_000, Math.min(ctx.timing.workerTimeoutMs, wall.hard_cap - wall.used)));
    // Wall time nearly spent: the floor applies.
    lab.db.run("UPDATE budget_counters SET used = hard_cap - 1000 WHERE run_id = ? AND counter = 'wall_ms'", lab.runId);
    await ensureWorker(lab.ctx(), request({ purpose: 'late', provider: 'codex' }));
    expect(adapter.specs[1]!.timeoutMs).toBe(60_000);
  });

  it('runs every request under the run\'s frozen policy: a request cannot name a wider one', async () => {
    const adapter = stub();
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    const dirs: string[] = [];
    // A caller that still tries to hand a session another policy is ignored (docs/decisions/0005, finding 7).
    const widened = { ...request(), policy: (dir: string) => (dirs.push(dir), { path: join(dir, 'grant.json'), hash: 'sha256:grant', snapshot: ctx.snapshot }) };
    await ensureWorker(ctx, widened as Parameters<typeof ensureWorker>[1]);
    expect(dirs).toEqual([]);
    expect(adapter.specs[0]).toMatchObject({ policyPath: ctx.run.policyPath, policyHash: ctx.run.policyHash });
  });

  it('refuses a provider with no adapter before recording the start', async () => {
    lab = makeUnitLab({ adapters: {}, path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    await expect(ensureWorker(ctx, request())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(() => adapterFor(ctx, 'ghost')).toThrow(/no adapter is configured for provider "ghost"/);
    expect(workersFor(ctx, 'plan:1')[0]?.state).toBe('PLANNED');
  });

  it('does nothing for an aborted step', async () => {
    lab = makeUnitLab({ adapters: { claude: stub() }, path: ['PREFLIGHT'] });
    const ac = new AbortController();
    ac.abort(new Error('step timed out'));
    await expect(ensureWorker(lab.ctx(ac.signal), request())).rejects.toThrow('step timed out');
    expect(listWorkers(lab.db, { runId: lab.runId })).toEqual([]);
  });

  it('a controller that lost the lease cannot record a worker for the purpose', async () => {
    lab = makeUnitLab({ adapters: { claude: stub() }, path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    releaseLease(lab.db, lab.runId, OWNER);
    acquireLease(lab.db, lab.runId, 'ctl-other', 60_000, lab.clock);
    await expect(ensureWorker(ctx, request())).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(listWorkers(lab.db, { runId: lab.runId })).toEqual([]);
  });

  it('a request that cannot be turned into a task fails the worker row and rethrows', async () => {
    lab = makeUnitLab({ adapters: { claude: stub() }, path: ['PREFLIGHT'] });
    await expect(
      ensureWorker(
        lab.ctx(),
        request({
          prompt: () => {
            throw new Error('prompt could not be built');
          },
        }),
      ),
    ).rejects.toThrow('prompt could not be built');
    expect(workersFor(lab.ctx(), 'plan:1')[0]).toMatchObject({ state: 'FAILED', resultStatus: 'failed', error: 'prompt could not be built' });
  });
});

describe('ensureWorker: starting can fail', () => {
  it.each([
    ['AUTH_EXPIRED', 'auth_failed'],
    ['AUTH_MISSING', 'auth_failed'],
    ['PROVIDER_UNAVAILABLE', 'failed'],
  ])('%s finishes the worker as %s and surfaces the error', async (code, status) => {
    const adapter = stub({
      startTask: async () => {
        throw new OrbitError(code as 'AUTH_EXPIRED', `provider said ${code}`);
      },
    });
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    await expect(ensureWorker(lab.ctx(), request())).rejects.toMatchObject({ code });
    expect(workersFor(lab.ctx(), 'plan:1')[0]).toMatchObject({ state: 'FAILED', resultStatus: status });
  });

  it('a launch that already happened and is already gone is observed through its files, not started again', async () => {
    let starts = 0;
    const adapter = stub({
      startTask: async (spec) => {
        starts++;
        writePid(spec.workerDir);
        writeFileSync(join(spec.workerDir, 'launch.json'), '{}');
        throw new OrbitError('TRANSITION_INVALID', 'the shim of this attempt is gone');
      },
      collect: async () => result(),
    });
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    const out = await ensureWorker(lab.ctx(), request());
    expect(starts).toBe(1);
    expect(out.status).toBe('finished');
    if (out.status === 'finished') expect(out.result.status).toBe('succeeded');
  });

  it('a gone launch with no usable pid record is archived and started again exactly once', async () => {
    let starts = 0;
    const adapter = stub({
      startTask: async (spec) => {
        starts++;
        if (starts === 1) {
          writeFileSync(join(spec.workerDir, 'launch.json'), '{}');
          throw new OrbitError('TRANSITION_INVALID', 'the shim of this attempt is gone');
        }
        writePid(spec.workerDir);
        return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: DEAD, pgid: DEAD, procStart: 'x', logPath: '', exitPath: '' };
      },
    });
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    const out = await ensureWorker(lab.ctx(), request());
    expect(starts).toBe(2);
    expect(out.status).toBe('running');
    const dir = out.worker.workerDir;
    expect(existsSync(join(dir, 'attempts', '1', 'launch.json'))).toBe(true);
    expect(readdirSync(dir)).not.toContain('launch.json');
  });

  it('a TRANSITION_INVALID without a launch record is an ordinary failure', async () => {
    const adapter = stub({
      startTask: async () => {
        throw new OrbitError('TRANSITION_INVALID', 'nope');
      },
    });
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    await expect(ensureWorker(lab.ctx(), request())).rejects.toMatchObject({ code: 'TRANSITION_INVALID' });
    expect(workersFor(lab.ctx(), 'plan:1')[0]?.state).toBe('FAILED');
  });
});

describe('ensureWorker: a unit that already exists', () => {
  it('a running worker whose result is not ready is still running', async () => {
    const adapter = stub();
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    await ensureWorker(lab.ctx(), request());
    const again = await ensureWorker(lab.ctx(), request());
    expect(again.status).toBe('running');
    expect(adapter.specs).toHaveLength(1);
    expect(adapter.collects).toBe(1);
  });

  it('collects the result once, validates it against a custom schema, records the usage and keeps it finished', async () => {
    const schemas: unknown[] = [];
    const adapter = stub({ collect: async () => result({ usage: usage({ model: 'claude-sonnet-x', inputTokens: 10, outputTokens: 5, costUsd: 0.25, costSource: 'reported' }) }) });
    const original = adapter.collectResult.bind(adapter);
    adapter.collectResult = async (h, o) => (schemas.push(o?.outputSchema), original(h, o));
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    await ensureWorker(lab.ctx(), request());
    const custom = { type: 'object', title: 'custom' };
    const done = await ensureWorker(lab.ctx(), request({ outputSchema: custom, phase: 'work' }));
    expect(done.status).toBe('finished');
    expect(schemas).toEqual([custom]);
    expect(done.worker.state).toBe('SUCCEEDED');
    const rows = lab.db.all<{ cost_usd: number }>('SELECT cost_usd FROM usage WHERE run_id = ?', lab.runId);
    expect(rows).toHaveLength(1);
    // Asked again, a finished unit is returned from its stored result and charged no second time.
    const later = await ensureWorker(lab.ctx(), request());
    expect(later.status).toBe('finished');
    expect(lab.db.all('SELECT 1 FROM usage WHERE run_id = ?', lab.runId)).toHaveLength(1);
  });

  it('a worker with a cancellation request is stopped, not observed', async () => {
    const adapter = stub();
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    const first = await ensureWorker(lab.ctx(), request());
    lab.db.run('UPDATE workers SET cancel_requested = 1 WHERE id = ?', first.worker.id);
    const out = await ensureWorker(lab.ctx(), request());
    expect(out.status).toBe('finished');
    expect(out.worker.state).toBe('CANCELLED');
    if (out.status === 'finished') expect(out.result.status).toBe('cancelled');
  });

  it('a PLANNED row from a controller that died before starting is started now', async () => {
    const adapter = stub();
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    const w = planWorker(lab.db, { id: 'wrk-planned', runId: lab.runId, role: 'planner', purpose: 'plan:1', provider: 'claude', workerDir: join(lab.base, 'pw'), cwd: lab.repo }, lab.clock, OWNER);
    const out = await ensureWorker(lab.ctx(), request());
    expect(out.status).toBe('running');
    expect(out.worker.id).toBe(w.id);
    expect(adapter.specs).toHaveLength(1);
  });

  it('a RUNNING row with no pid file is lost, with nothing usable produced', async () => {
    lab = makeUnitLab({ adapters: { claude: stub() }, path: ['PREFLIGHT'] });
    const w = active();
    markWorkerRunning(lab.db, w.id, { pid: DEAD, pgid: DEAD, procStart: 'x' }, lab.clock, OWNER);
    const out = await ensureWorker(lab.ctx(), request());
    expect(out.status).toBe('finished');
    expect(out.worker).toMatchObject({ state: 'LOST', error: 'the worker directory has no pid.json' });
    if (out.status === 'finished') expect(out.result).toMatchObject({ status: 'lost', error: 'the worker directory has no pid.json' });
  });

  it('reattaches through the adapter when it knows how, binding the handle to the worker', async () => {
    const seen: TaskHandle[] = [];
    const adapter = stub({
      reattach: (dir) => ({ provider: 'claude', workerId: 'stale', workerDir: dir, pid: 1, pgid: 1, procStart: null, logPath: '', exitPath: '' }),
      collect: async () => result(),
    });
    const collect = adapter.collectResult.bind(adapter);
    adapter.collectResult = async (h, o) => (seen.push(h), collect(h, o));
    lab = makeUnitLab({ adapters: { claude: adapter }, path: ['PREFLIGHT'] });
    const w = active();
    markWorkerRunning(lab.db, w.id, { pid: DEAD, pgid: DEAD, procStart: 'x' }, lab.clock, OWNER);
    const out = await ensureWorker(lab.ctx(), request());
    expect(out.status).toBe('finished');
    expect(seen[0]?.workerId).toBe(w.id);
  });

  it('a reattach that finds nothing is a lost worker', async () => {
    lab = makeUnitLab({ adapters: { claude: stub({ reattach: () => null }) }, path: ['PREFLIGHT'] });
    const w = active();
    markWorkerRunning(lab.db, w.id, { pid: DEAD, pgid: DEAD, procStart: 'x' }, lab.clock, OWNER);
    expect((await ensureWorker(lab.ctx(), request())).worker.state).toBe('LOST');
  });
});

describe('storedResult', () => {
  const base = (over: Partial<WorkerRecord>): WorkerRecord => ({ id: 'w', state: 'FAILED', provider: 'claude', resultJson: null, resultStatus: null, error: 'boom', exitCode: 3, ...over }) as WorkerRecord;

  it('returns the stored result when it is a result', () => {
    const r = result({ status: 'transient_error' });
    expect(storedResult(base({ resultJson: JSON.stringify(r) }))).toEqual(r);
  });

  it('synthesises one from the row when the stored text is missing, unreadable or not a result', () => {
    for (const resultJson of [null, '{broken', 'null', '"text"', '{"status":5}']) {
      const r = storedResult(base({ resultJson, resultStatus: 'failed' }));
      expect(r).toMatchObject({ status: 'failed', structured: null, text: null, error: 'boom', exitCode: 3, durationMs: null });
      expect(r.usage).toMatchObject({ provider: 'claude', costSource: 'unavailable', costUsd: null });
    }
  });

  it('calls a cancelled row cancelled and anything else without a status lost', () => {
    expect(storedResult(base({ state: 'CANCELLED' })).status).toBe('cancelled');
    expect(storedResult(base({ state: 'LOST' })).status).toBe('lost');
  });
});

describe('outcomeOf and small helpers', () => {
  it('maps task statuses to worker states and bounds the error text', () => {
    expect(outcomeOf(result()).state).toBe('SUCCEEDED');
    expect(outcomeOf(result({ status: 'cancelled' })).state).toBe('CANCELLED');
    expect(outcomeOf(result({ status: 'lost' })).state).toBe('LOST');
    for (const status of ['failed', 'timeout', 'auth_failed', 'max_turns', 'malformed_output', 'transient_error'] as const) expect(outcomeOf(result({ status })).state).toBe('FAILED');
    expect(outcomeOf(result({ status: 'failed', error: 'x'.repeat(5000) })).error).toHaveLength(2000);
    expect(outcomeOf(result()).error).toBeNull();
  });

  it('describes any thrown value', () => {
    expect(messageOf(new Error('e'))).toBe('e');
    expect(messageOf('s')).toBe('s');
    expect(messageOf(7)).toBe('7');
  });

  it('knows each role schema', () => {
    expect(schemaFor('reviewer')).toBe(MODEL_OUTPUT_SCHEMAS[ROLE_OUTPUT_KIND.reviewer]);
  });
});

describe('accountWorker', () => {
  it('records usage once and skips a worker already accounted', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    const w = active();
    accountWorker(ctx, w, result({ usage: usage({ inputTokens: 5, outputTokens: 2 }) }));
    accountWorker(ctx, w, result({ usage: usage({ inputTokens: 500 }) }));
    const rows = lab.db.all<{ input_tokens: number }>('SELECT input_tokens FROM usage WHERE worker_id = ?', w.id);
    expect(rows).toEqual([{ input_tokens: 5 }]);
  });

  it('charges the reported cost to the ledger', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    withLedger();
    const ctx = lab.ctx();
    accountWorker(ctx, active(), result({ usage: usage({ costUsd: 0.4, costSource: 'reported' }) }), 'work');
    expect(ctx.ledger!.state('cost_usd').used).toBeCloseTo(0.4, 6);
  });

  it('charges the role ceiling when no cost is known, and the recorded session cap plus one request when there is one', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    withLedger();
    const ctx = lab.ctx();
    accountWorker(ctx, active('planner', 'plan:1'), result());
    expect(ctx.ledger!.state('cost_usd').used).toBeCloseTo(ROLE_COST_CEILING_USD.planner, 6);
    const before = ctx.ledger!.state('cost_usd').used;
    recordSpendCap(ctx, 'plan:2', 1.5, 0.25);
    accountWorker(ctx, active('planner', 'plan:2'), result());
    expect(ctx.ledger!.state('cost_usd').used - before).toBeCloseTo(1.75, 6);
  });

  it('a lost session is charged at most the role ceiling even under a larger cap', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    withLedger();
    const ctx = lab.ctx();
    recordSpendCap(ctx, 'impl:1', 100, 5);
    accountWorker(ctx, active('implementer', 'impl:1'), result({ status: 'lost' }));
    expect(ctx.ledger!.state('cost_usd').used).toBeCloseTo(ROLE_COST_CEILING_USD.implementer, 6);
    // And a session whose cap is below the ceiling is charged that cap.
    const before = ctx.ledger!.state('cost_usd').used;
    recordSpendCap(ctx, 'impl:2', 0.5, 0.1);
    accountWorker(ctx, active('implementer', 'impl:2'), result({ status: 'lost' }));
    expect(ctx.ledger!.state('cost_usd').used - before).toBeCloseTo(0.6, 6);
  });

  it('an authentication failure that ran no model costs a measured zero', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    withLedger();
    const ctx = lab.ctx();
    accountWorker(ctx, active(), result({ status: 'auth_failed', usage: usage() }));
    expect(ctx.ledger!.state('cost_usd').used).toBe(0);
    expect(lab.db.get<{ cost_usd: number; cost_source: string }>('SELECT cost_usd, cost_source FROM usage WHERE run_id = ?', lab.runId)).toMatchObject({ cost_usd: 0, cost_source: 'reported' });
  });

  it('an authentication failure that did spend is charged like any unknown cost', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    withLedger();
    const ctx = lab.ctx();
    accountWorker(ctx, active(), result({ status: 'auth_failed', usage: usage({ inputTokens: 9 }) }));
    expect(ctx.ledger!.state('cost_usd').used).toBeCloseTo(ROLE_COST_CEILING_USD.planner, 6);
  });

  it('a budget that runs out while charging an auth-failed session is logged, not thrown, and the usage is still recorded', () => {
    const cap = capturingLogger();
    lab = makeUnitLab({ path: ['PREFLIGHT'], logger: cap.logger });
    const ctx = lab.ctx();
    ctx.ledger = {
      consumeCost: () => {
        throw new OrbitError('BUDGET_EXHAUSTED', 'cost_usd exhausted');
      },
    } as unknown as BudgetLedger;
    const w = active();
    expect(() => accountWorker(ctx, w, result({ status: 'auth_failed' }))).not.toThrow();
    expect(cap.lines().some((l) => l.msg.includes('budget exhausted while charging an auth-failed session'))).toBe(true);
    expect(lab.db.all('SELECT 1 FROM usage WHERE worker_id = ?', w.id)).toHaveLength(1);
    // Any other session surfaces the exhaustion, and nothing is recorded for it.
    const other = active('planner', 'plan:9');
    expect(() => accountWorker(ctx, other, result({ status: 'succeeded' }))).toThrow(/cost_usd exhausted/);
    expect(lab.db.all('SELECT 1 FROM usage WHERE worker_id = ?', other.id)).toHaveLength(0);
  });

  it('marks the model a succeeded session actually ran on as available, and only then', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    lab.deps.registry.seed();
    const model = lab.deps.registry.list().find((e) => e.provider === 'claude')!.modelId;
    const ctx = lab.ctx();
    accountWorker(ctx, active('planner', 'p1'), result({ status: 'failed', usage: usage({ model }) }));
    expect(lab.deps.registry.get(model)!.surfaces.find((s) => s.surface === 'claude-cli')?.available).not.toBe(true);
    accountWorker(ctx, active('planner', 'p2'), result({ usage: usage({ model }) }));
    expect(lab.deps.registry.get(model)!.surfaces.find((s) => s.surface === 'claude-cli')?.available).toBe(true);
    // A model the registry has never heard of is ignored; a Codex worker marks the Codex surface.
    accountWorker(ctx, active('planner', 'p3'), result({ usage: usage({ model: 'model-nobody-knows' }) }));
    expect(lab.deps.registry.get('model-nobody-knows')).toBeNull();
  });

  it('a registry that fails never fails the step', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], deps: { registry: { get: () => { throw new Error('registry down'); } } as never } });
    expect(() => accountWorker(lab.ctx(), active(), result({ usage: usage({ model: 'm' }) }))).not.toThrow();
  });

  it('logs a transcript whose denials cannot be recorded and goes on accounting', () => {
    const cap = capturingLogger();
    lab = makeUnitLab({ path: ['PREFLIGHT'], logger: cap.logger });
    const ctx = lab.ctx();
    const w = active();
    mkdirSync(w.workerDir, { recursive: true });
    const events = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Orbit policy (protected_path): no', is_error: true }] } },
    ];
    writeFileSync(join(w.workerDir, 'log.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
    // The run directory is read-only, so the decision cannot be written.
    chmodSync(ctx.runDir, 0o500);
    try {
      accountWorker(ctx, w, result());
    } finally {
      chmodSync(ctx.runDir, 0o700);
    }
    if (process.getuid?.() === 0) return;
    expect(cap.lines().some((l) => l.msg === 'could not read the worker transcript for policy denials')).toBe(true);
    expect(lab.db.all('SELECT 1 FROM usage WHERE worker_id = ?', w.id)).toHaveLength(1);
  });

  it('a worker without a purpose has no recorded cap', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    withLedger();
    const ctx = lab.ctx();
    const w = planWorker(lab.db, { id: 'wrk-nopurpose', runId: lab.runId, role: 'planner', provider: 'claude', workerDir: join(lab.base, 'np'), cwd: lab.repo }, lab.clock, OWNER);
    accountWorker(ctx, w, result());
    expect(ctx.ledger!.state('cost_usd').used).toBeCloseTo(ROLE_COST_CEILING_USD.planner, 6);
  });

  it('a spend cap event without a worst-case amount adds nothing to the cap', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    withLedger();
    const ctx = lab.ctx();
    const w = active('planner', 'plan:5');
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'worker.spend-cap', 'x', ?)", lab.runId, lab.clock.now(), JSON.stringify({ purpose: 'plan:5', cap_usd: 0.75 }));
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'worker.spend-cap', 'x', NULL)", lab.runId, lab.clock.now());
    accountWorker(ctx, w, result());
    expect(ctx.ledger!.state('cost_usd').used).toBeCloseTo(0.75, 6);
  });
});

describe('authFailureSpentNothing', () => {
  const writeLog = (dir: string, events: object[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'log.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  };

  it('is false as soon as tokens were reported', () => {
    lab = makeUnitLab();
    expect(authFailureSpentNothing({ workerDir: join(lab.base, 'x') }, usage({ inputTokens: 1 }))).toBe(false);
    expect(authFailureSpentNothing({ workerDir: join(lab.base, 'x') }, usage({ outputTokens: 1 }))).toBe(false);
  });

  it('is true without a transcript', () => {
    lab = makeUnitLab();
    expect(authFailureSpentNothing({ workerDir: join(lab.base, 'none') }, usage())).toBe(true);
  });

  it('is true for a result line that reports zero cost and no model usage, with or without the field', () => {
    lab = makeUnitLab();
    const a = join(lab.base, 'a');
    writeLog(a, [{ type: 'assistant', message: {} }, { type: 'result', total_cost_usd: 0, modelUsage: {} }]);
    expect(authFailureSpentNothing({ workerDir: a }, usage())).toBe(true);
    const b = join(lab.base, 'b');
    writeLog(b, [{ type: 'assistant', message: {} }, { type: 'result', total_cost_usd: 0 }]);
    expect(authFailureSpentNothing({ workerDir: b }, usage())).toBe(true);
  });

  it('is judged on the assistant messages when the result line shows spend or model usage', () => {
    lab = makeUnitLab();
    const a = join(lab.base, 'a');
    writeLog(a, [{ type: 'assistant', message: {} }, { type: 'result', total_cost_usd: 0.2, modelUsage: {} }]);
    expect(authFailureSpentNothing({ workerDir: a }, usage())).toBe(false);
    const b = join(lab.base, 'b');
    writeLog(b, [{ type: 'assistant', error: 'authentication_failed', message: {} }, { type: 'result', total_cost_usd: 0, modelUsage: { m: {} } }]);
    expect(authFailureSpentNothing({ workerDir: b }, usage())).toBe(true);
    const c = join(lab.base, 'c');
    writeLog(c, [{ type: 'assistant', is_api_error_message: true, message: {} }]);
    expect(authFailureSpentNothing({ workerDir: c }, usage())).toBe(true);
    const d = join(lab.base, 'd');
    writeLog(d, [{ type: 'assistant', message: { content: 'hello' } }]);
    expect(authFailureSpentNothing({ workerDir: d }, usage())).toBe(false);
  });
});

describe('spend caps and committed spend', () => {
  it('commits the cap plus one request for each live session, the role ceiling for a session with no cap', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    expect(committedSpendUsd(ctx)).toBe(0);
    active('implementer', 'impl:1');
    active('reviewer', 'review:1');
    recordSpendCap(ctx, 'impl:1', 2, 0.5);
    expect(committedSpendUsd(ctx)).toBeCloseTo(2.5 + ROLE_COST_CEILING_USD.reviewer, 6);
  });

  it('without a ledger there is no cap, only the worst-case request, taken from the registry when the model is known', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    lab.deps.registry.seed();
    const ctx = lab.ctx();
    const unknown = sessionSpendCap(ctx, null, 'implementer');
    expect(unknown).toEqual({ capUsd: null, worstCaseUsd: ROLE_COST_CEILING_USD.implementer / 4 });
    expect(sessionSpendCap(ctx, 'model-nobody-knows', 'planner').worstCaseUsd).toBe(ROLE_COST_CEILING_USD.planner / 4);
    const known = lab.deps.registry.list().find((e) => e.pricing && e.limits?.contextTokens)!;
    const priced = sessionSpendCap(ctx, known.modelId, 'planner');
    expect(priced.capUsd).toBeNull();
    expect(priced.worstCaseUsd).toBeGreaterThan(0);
  });

  it('with a ledger the cap is what the budget can fund after what is already committed', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    withLedger();
    const ctx = lab.ctx();
    const first = sessionSpendCap(ctx, null, 'implementer', 'work');
    expect(first.capUsd).toBeGreaterThan(0);
    active('implementer', 'impl:1');
    recordSpendCap(ctx, 'impl:1', 1_000_000, 0);
    const second = sessionSpendCap(ctx, null, 'implementer');
    expect(second.capUsd).toBe(0);
  });
});

describe('stopActiveWorkers', () => {
  it('stops every live worker and reports the ones that cannot be stopped', async () => {
    lab = makeUnitLab({ adapters: { claude: stub() }, path: ['PREFLIGHT'] });
    const ok = active('planner', 'plan:1');
    markWorkerRunning(lab.db, ok.id, { pid: DEAD, pgid: DEAD, procStart: 'x' }, lab.clock, OWNER);
    // A worker whose recorded process is ours and unverifiable cannot be stopped.
    const stuck = active('planner', 'plan:2');
    markWorkerRunning(lab.db, stuck.id, { pid: process.pid, pgid: process.pid, procStart: null }, lab.clock, OWNER);
    const failed = await stopActiveWorkers(lab.ctx(), 'run cancelled');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(stuck.id);
    expect(getWorker(lab.db, ok.id)).toMatchObject({ state: 'CANCELLED', error: 'run cancelled' });
    expect(getWorker(lab.db, stuck.id).state).toBe('RUNNING');
  });
});

describe('collectIfFinished', () => {
  it('cancels a PLANNED worker that was never launched and says nothing is running', async () => {
    lab = makeUnitLab({ adapters: { claude: stub() }, path: ['PREFLIGHT'] });
    const w = active();
    expect(await collectIfFinished(lab.ctx(), w)).toBe(false);
    expect(getWorker(lab.db, w.id)).toMatchObject({ state: 'CANCELLED', error: 'never started before the controller restarted' });
  });

  it('a PLANNED worker whose launch is recorded but has no pid yet is still running', async () => {
    lab = makeUnitLab({ adapters: { claude: stub() }, path: ['PREFLIGHT'] });
    const w = active();
    mkdirSync(w.workerDir, { recursive: true });
    writeFileSync(join(w.workerDir, 'launch.json'), '{}');
    expect(await collectIfFinished(lab.ctx(), w)).toBe(true);
    expect(getWorker(lab.db, w.id).state).toBe('PLANNED');
  });

  it('a PLANNED worker whose process started is adopted from its pid file and then collected', async () => {
    lab = makeUnitLab({ adapters: { claude: stub({ collect: async () => result() }) }, path: ['PREFLIGHT'] });
    const w = active();
    mkdirSync(w.workerDir, { recursive: true });
    writeFileSync(join(w.workerDir, 'launch.json'), '{}');
    writePid(w.workerDir);
    expect(await collectIfFinished(lab.ctx(), w)).toBe(false);
    expect(getWorker(lab.db, w.id).state).toBe('SUCCEEDED');
    expect(lab.db.all('SELECT 1 FROM usage WHERE worker_id = ?', w.id)).toHaveLength(1);
  });

  it('a finished worker is nothing to wait for', async () => {
    lab = makeUnitLab({ adapters: { claude: stub() }, path: ['PREFLIGHT'] });
    const w = active();
    const done = finishWorker(lab.db, w.id, { state: 'CANCELLED', resultStatus: 'cancelled' }, lab.clock, OWNER);
    expect(await collectIfFinished(lab.ctx(), done)).toBe(false);
  });

  it('a RUNNING worker is waited for until its result is ready, then recorded and charged', async () => {
    let ready = false;
    lab = makeUnitLab({ adapters: { claude: stub({ collect: async () => (ready ? result() : null) }) }, path: ['PREFLIGHT'] });
    const w = active();
    writePid(w.workerDir);
    const running = markWorkerRunning(lab.db, w.id, { pid: DEAD, pgid: DEAD, procStart: 'x' }, lab.clock, OWNER);
    expect(await collectIfFinished(lab.ctx(), running)).toBe(true);
    ready = true;
    expect(await collectIfFinished(lab.ctx(), running)).toBe(false);
    expect(getWorker(lab.db, w.id).state).toBe('SUCCEEDED');
  });

  it('a RUNNING worker whose directory lost its pid record is lost', async () => {
    lab = makeUnitLab({ adapters: { claude: stub() }, path: ['PREFLIGHT'] });
    const w = active();
    const running = markWorkerRunning(lab.db, w.id, { pid: DEAD, pgid: DEAD, procStart: 'x' }, lab.clock, OWNER);
    expect(await collectIfFinished(lab.ctx(), running)).toBe(false);
    expect(getWorker(lab.db, w.id)).toMatchObject({ state: 'LOST', error: 'the worker directory has no pid.json' });
  });
});

describe('systemPromptFor', () => {
  it('is the base role prompt without an overlay', () => {
    lab = makeUnitLab();
    const p = systemPromptFor(lab.ctx(), 'reviewer');
    expect(p.length).toBeGreaterThan(100);
    expect(p.endsWith('\n')).toBe(true);
  });

  it('uses the configured agents directory and fails when it has no such role', () => {
    lab = makeUnitLab({ deps: { agentsDir: join('/nonexistent', 'agents') } });
    expect(() => systemPromptFor(lab.ctx(), 'reviewer')).toThrow();
  });
});

describe('routeFor', () => {
  const signals = { difficulty: 'medium' as const, attempt: 1, repeatedFingerprints: 0 };

  function seed(validated: boolean): void {
    lab.deps.registry.seed();
    if (validated) for (const e of lab.deps.registry.list()) if (e.provider === 'claude' && e.family !== 'fable') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
  }

  it('routes once, records why, and a retried step reuses the recorded choice even if the registry changed', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    seed(true);
    const ctx = lab.ctx();
    const first = routeFor(ctx, 'implement:1', 'routine-code', signals);
    expect(first.provider).toBe('claude');
    expect(first.decisionId).toBe(`dec-route-${lab.runId}-implement_1`);
    const rec = getDecision(lab.db, first.decisionId)!;
    expect(rec.kind).toBe('route');
    expect((rec.data as { purpose: string }).purpose).toBe('implement:1');
    // Everything is withdrawn; the recorded route stands.
    for (const e of lab.deps.registry.list()) lab.deps.registry.markAvailability(e.modelId, 'claude-cli', false, 'withdrawn');
    const again = routeFor(lab.ctx(), 'implement:1', 'routine-code', signals);
    expect(again).toMatchObject({ provider: first.provider, model: first.model, effort: first.effort, decisionId: first.decisionId });
  });

  it('with no validated model it picks an allowed, seeded one and says it is unvalidated', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    seed(false);
    const ctx = lab.ctx();
    const choice = routeFor(ctx, 'plan:1', 'extraction', signals);
    expect(choice.provider).toBe('claude');
    expect(choice.model).toBeTruthy();
    const rec = getDecision(lab.db, choice.decisionId)!;
    expect(rec.data).toMatchObject({ unvalidated: true, provider: 'claude', model: choice.model });
    expect(rec.summary).toContain('allowed but not yet validated on claude-cli');
  });

  it('prefers the configured provider model when it is one of the allowed seeded models', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    seed(false);
    const target = lab.deps.registry.list().find((e) => e.provider === 'claude' && e.family === 'opus' && e.surfaces.some((s) => s.surface === 'claude-cli'))!;
    lab.cleanup();
    lab = makeUnitLab({
      path: ['PREFLIGHT'],
      tweak: (c) => {
        c.providers = { ...c.providers, claude: { ...c.providers.claude!, model: target.modelId, reasoning_effort: 'high' } };
      },
    });
    seed(false);
    const choice = routeFor(lab.ctx(), 'plan:1', 'extraction', signals);
    expect(choice).toMatchObject({ model: target.modelId, effort: 'high' });
  });

  it('matches a configured alias as well as a model id', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    seed(false);
    const target = lab.deps.registry.list().find((e) => e.provider === 'claude' && e.eligibility.cliAlias && e.surfaces.some((s) => s.surface === 'claude-cli'))!;
    lab.cleanup();
    lab = makeUnitLab({
      path: ['PREFLIGHT'],
      tweak: (c) => {
        c.providers = { ...c.providers, claude: { ...c.providers.claude!, model: target.eligibility.cliAlias } };
        c.routing = { ...c.routing, allowed_models: [target.modelId] };
      },
    });
    seed(false);
    const choice = routeFor(lab.ctx(), 'plan:1', 'extraction', signals);
    expect(choice.model).toBe(target.modelId);
    expect(choice.effort).toBeNull();
  });

  it('escalates to a stronger tier only on repeated failures backed by evidence', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    seed(false);
    const routine = routeFor(lab.ctx(), 'impl:1', 'routine-code', signals);
    const hard = routeFor(lab.ctx(), 'impl:2', 'routine-code', { ...signals, repeatedFingerprints: 3, evidence: ['dec-1'] });
    const bare = routeFor(lab.ctx(), 'impl:3', 'routine-code', { ...signals, repeatedFingerprints: 3 });
    const tier = (m: string | null) => lab.deps.registry.get(m!)!.family;
    expect(tier(routine.model)).toBe('sonnet');
    expect(tier(hard.model)).toBe('opus');
    expect(tier(bare.model)).toBe('sonnet');
  });

  it('rethrows the routing failure when nothing allowed is available at all', () => {
    lab = makeUnitLab({
      path: ['PREFLIGHT'],
      tweak: (c) => {
        c.routing = { ...c.routing, allowed_models: ['no-such-model'] };
      },
    });
    seed(false);
    expect(() => routeFor(lab.ctx(), 'plan:1', 'extraction', signals)).toThrow(OrbitError);
    expect(getDecision(lab.db, `dec-route-${lab.runId}-plan_1`)).toBeNull();
  });

  it('does not hide a routing error that is not about availability', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    seed(true);
    expect(() => routeFor(lab.ctx(), 'plan:1', 'extraction', { ...signals, attempt: 0 })).toThrow(/attempt must be a positive integer/);
  });
});
