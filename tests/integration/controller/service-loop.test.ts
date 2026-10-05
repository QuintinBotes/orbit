// Recovery wiring in the controller loop, each pinned by a test that failed before it: no work on a run
// reconciliation could not reconcile, finished checks collected after reconciliation, the watchdog run by
// the service loop, a run ended by reconciliation getting its report at once, and periodic credential
// checks with a live probe for Claude.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { systemClock } from '../../../src/core/clock.ts';
import { killGroup } from '../../../src/core/proc.ts';
import type { ControllerDeps } from '../../../src/controller/context.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { acquireLease, getRun } from '../../../src/controller/run-store.ts';
import { step, STEPS } from '../../../src/controller/steps/index.ts';
import type { StepResult } from '../../../src/controller/steps/common.ts';
import { getCheckRun, listCheckRuns } from '../../../src/evidence/store.ts';
import { getController, registerController } from '../../../src/storage/controllers.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { baseScenario, implementMul, labDeps, makeLab, runState, startLabRun, waitFor, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
const groups: number[] = [];
const controllers: { c: Controller; done: Promise<void> }[] = [];
afterEach(async () => {
  for (const { c, done } of controllers.splice(0)) {
    await c.stop('test over');
    await done;
  }
  for (const g of groups.splice(0)) {
    try {
      killGroup(g, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const l of labs.splice(0)) l.close();
});

/** run.mjs waits while the file named in tests/slow.flag exists, so a test decides when the check finishes. */
const GATED_RUNNER = [
  "import { existsSync, readFileSync, readdirSync } from 'node:fs';",
  "const here = new URL('.', import.meta.url);",
  "const flag = new URL('slow.flag', here);",
  'if (existsSync(flag)) { const gate = readFileSync(flag, "utf8").trim(); while (existsSync(gate)) await new Promise((r) => setTimeout(r, 50)); }',
  "for (const f of readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) await import(new URL(f, here));",
  "console.log('all tests passed');",
  '',
].join('\n');

function lab(roles: Record<string, object[]>, files: Record<string, string> = {}): Lab {
  const l = makeLab({ files });
  labs.push(l);
  writeScenario(l, baseScenario(roles));
  return l;
}

function depsFor(l: Lab, ownerId: string): ControllerDeps {
  return { ...labDeps(l), ownerId };
}

function service(l: Lab, extra: Partial<ConstructorParameters<typeof Controller>[0]> = {}, deps: Omit<ControllerDeps, 'ownerId'> = labDeps(l)): Controller {
  const c = new Controller({ mode: 'service', deps, tickIntervalMs: 50, leaseTtlMs: 30_000, graceMs: 300, shutdownGraceMs: 200, ...extra });
  controllers.push({ c, done: c.start() });
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function driveTo(l: Lab, deps: ControllerDeps, runId: string, state: string): Promise<void> {
  for (let i = 0; i < 1_200 && runState(l, runId).state !== state; i++) {
    await step(deps, runId, new AbortController().signal);
    if (runState(l, runId).state !== state) await sleep(25);
  }
  expect(runState(l, runId).state).toBe(state);
}

function runDirOf(l: Lab, runId: string): string {
  return dirname(getRun(l.db(), runId).policyPath);
}

function transitions(l: Lab, runId: string): string[] {
  return l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id", runId).map((r) => r.to_state);
}

describe.skipIf(!canStripTypes)('controller loop: recovery wiring', () => {
  it('a run whose reconciliation failed is not worked on until a later pass reconciles it', async () => {
    const l = lab({ implementer: [implementMul('*')] });
    const run = startLabRun(l);
    // An app fixture record reconciliation cannot read: the pass for this run fails.
    const broken = join(runDirOf(l, run.id), 'evidence', '1', 'ui', 'app', 'app.json');
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, '{ not json');
    const c = service(l);
    await waitFor(() => (c.lastReconcile?.errors.some((e) => e.runId === run.id) ? true : null), 10_000);
    await sleep(500);
    expect(transitions(l, run.id)).toEqual([]);
    expect(c.ownedRuns()).toEqual([]);
    rmSync(broken);
    await waitFor(() => (transitions(l, run.id).includes('PREFLIGHT') ? true : null), 20_000);
  }, 60_000);

  it('a check that finished while nobody supervised it is recorded by the next controller after reconciliation', async () => {
    const gate = join(makeGateDir(), 'gate');
    const l = lab({ implementer: [implementMul('*', [{ op: 'write', path: 'tests/slow.flag', content: `${gate}\n` }])] }, { 'tests/run.mjs': GATED_RUNNER });
    writeFileSync(gate, '1');
    const run = startLabRun(l);
    const a = depsFor(l, 'controller-a');
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    await driveTo(l, a, run.id, 'VERIFYING');
    const ac = new AbortController();
    const verifying = step(a, run.id, ac.signal).catch(() => null);
    const check = await waitFor(() => listCheckRuns(l.db(), { runId: run.id }).find((r) => r.candidateId !== null && r.checkId === 'unit' && r.status === 'RUNNING' && r.pid !== null), 30_000);
    groups.push(check.pid!);
    ac.abort(new Error('lease lost'));
    await verifying;
    expect(getCheckRun(l.db(), check.id).status).toBe('RUNNING');
    // The check finishes with no controller watching.
    rmSync(gate);
    const seq = l.db().get<{ seq: number }>('SELECT seq FROM candidates WHERE id = ?', check.candidateId)!.seq;
    await waitFor(() => existsSync(join(runDirOf(l, run.id), 'evidence', String(seq), 'unit', 'exit.json')) || null, 30_000);
    l.db().run('UPDATE leases SET expires_at = ? WHERE run_id = ?', Date.now() - 1, run.id);
    // The verifying step would also reattach; it is held back so only reconciliation can have recorded the result.
    const table = STEPS as Record<string, (ctx: unknown) => Promise<StepResult>>;
    const original = table.VERIFYING!;
    table.VERIFYING = async () => ({ progressed: false, waiting: 'held by the test' });
    try {
      const c = service(l);
      await waitFor(() => (c.ownedRuns().includes(run.id) ? true : null), 10_000);
      expect(getCheckRun(l.db(), check.id).status).toBe('PASSED');
    } finally {
      table.VERIFYING = original;
    }
  }, 90_000);

  it('the service loop runs the watchdog: a dead controller with a stale heartbeat is marked stopped', async () => {
    const l = lab({ implementer: [implementMul('*')] });
    registerController(l.db(), { id: 'ctl-dead', pid: 999_999, host: hostname(), procStart: null, mode: 'service' }, systemClock);
    l.db().run('UPDATE controllers SET heartbeat_at = 0 WHERE id = ?', 'ctl-dead');
    service(l, { watchdogMs: 100 });
    await waitFor(() => (getController(l.db(), 'ctl-dead').stoppedAt !== null ? true : null), 10_000);
    expect(getController(l.db(), 'ctl-dead').stoppedAt).not.toBeNull();
  }, 30_000);

  it('a run that reconciliation ends (recovery budget spent) gets its final report from the same pass', async () => {
    const l = lab({ implementer: [{ ...implementMul('*'), sleepMs: 60_000 }] });
    const run = startLabRun(l);
    const a = depsFor(l, 'controller-a');
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    await driveTo(l, a, run.id, 'IMPLEMENTING');
    await step(a, run.id, new AbortController().signal);
    const w = await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'implementer' }).find((x) => x.state === 'RUNNING' && x.pgid !== null), 30_000);
    groups.push(w.pgid!);
    l.db().run("UPDATE budget_counters SET used = allowance WHERE run_id = ? AND counter = 'recovery_attempts'", run.id);
    // controller-a dies; controller-b is already running when its lease expires and claims the run mid-life.
    const c = service(l);
    await sleep(300);
    expect(c.ownedRuns()).toEqual([]);
    l.db().run('UPDATE leases SET expires_at = ? WHERE run_id = ?', Date.now() - 1, run.id);
    await waitFor(() => (runState(l, run.id).state === 'EXHAUSTED' ? true : null), 20_000);
    await waitFor(() => existsSync(join(runDirOf(l, run.id), 'final.md')) || null, 5_000);
  }, 90_000);

  it('credentials are checked again while a run works, with a live probe for Claude, and an expired one blocks the run', async () => {
    // Every Claude call that is not a worker role (the live probe) fails authentication.
    const l = lab({ implementer: [{ ...implementMul('*'), sleepMs: 60_000 }], '*': [{ outcome: 'auth_failure' }] });
    const run = startLabRun(l);
    // The check is due a fixed interval after the run's start. A real short interval would race the run's own
    // start-up on a slow host (the run could be blocked before any worker ran), so the interval is long and the
    // controller's clock is moved past it once the worker is running. The lease and worker timeout outlast the jump.
    const interval = 300_000;
    let skewMs = 0;
    const skewed = { ...systemClock, now: () => Date.now() + skewMs };
    const deps = { ...labDeps(l), clock: skewed, timing: { ...labDeps(l).timing, workerTimeoutMs: 3_600_000 } };
    const c = service(l, { credentialCheckMs: interval, leaseTtlMs: 3_600_000 }, deps);
    const w = await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'implementer' }).find((x) => x.state === 'RUNNING' && x.pgid !== null), 30_000);
    groups.push(w.pgid!);
    expect(runState(l, run.id).state).not.toBe('BLOCKED');
    skewMs = interval + 1_000;
    await waitFor(() => (runState(l, run.id).state === 'BLOCKED' ? true : null), 30_000);
    const checked = l.db().all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'credentials.checked'", run.id).map((r) => JSON.parse(r.data_json) as { providers: { provider: string; live: boolean; verdict: string }[] });
    expect(checked.at(-1)!.providers).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'claude', live: true, verdict: 'blocked' })]));
    expect(runState(l, run.id).outcomeReason).toMatch(/claude/i);
    // The blocked run keeps nothing running and has its report.
    await waitFor(() => (listWorkers(l.db(), { runId: run.id, role: 'implementer' }).every((x) => x.state !== 'RUNNING') ? true : null), 10_000);
    await waitFor(() => existsSync(join(runDirOf(l, run.id), 'final.md')) || null, 5_000);
    expect(c.ownedRuns()).not.toContain(run.id);
  }, 90_000);
});

function makeGateDir(): string {
  const l = makeLab();
  labs.push(l);
  return l.base;
}

