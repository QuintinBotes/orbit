/**
 * Run lifecycle across separate `orbit` processes: durable cancellation, the
 * decide then resume flow, and a real service controller picking work up.
 * State is prepared with the controller's own modules; every command under
 * test runs as its own child process, so nothing is shared but the files.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import { startRun, stateDbPath } from '../../../src/controller/start.ts';
import { acquireLease, getRun, releaseLease, transition, type RunRecord } from '../../../src/controller/run-store.ts';
import type { RunState } from '../../../src/controller/states.ts';
import { insertQuestion } from '../../../src/inquisition/store.ts';
import { CLI_ENTRY, makeSandbox, type Sandbox } from './helpers.ts';

const boxes: Sandbox[] = [];
const dbs: OrbitDb[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  for (const d of dbs.splice(0)) d.close();
  for (const b of boxes.splice(0)) b.close();
});

function setup(): { box: Sandbox; db: OrbitDb; newRun: (goal?: string) => RunRecord; moveTo: (id: string, states: RunState[]) => void; ask: (id: string) => string } {
  const box = makeSandbox();
  boxes.push(box);
  const db = openDb(stateDbPath(box.repo));
  dbs.push(db);
  return {
    box,
    db,
    newRun: (goal = 'Add a mul function to the calculator.') => startRun({ db, repoRoot: box.repo, goal, config: defaultConfig('autonomous'), clock: systemClock }),
    moveTo(id, states) {
      acquireLease(db, id, 'prep', 60_000, systemClock);
      for (const to of states) transition(db, { runId: id, to, ownerId: 'prep', reason: 'prepared', actor: 'prep', ...(to === 'BLOCKED' ? { patch: { outcomeReason: 'needs a decision' } } : {}) }, systemClock);
      releaseLease(db, id, 'prep');
    },
    ask: (id) =>
      insertQuestion(
        db,
        {
          runId: id,
          mode: 'clarify',
          question: 'Should mul round its result?',
          evidence: [],
          options: [
            { label: 'A', description: 'exact product', consequences: 'none' },
            { label: 'B', description: 'round to cents', consequences: 'money formatting' },
          ],
          changes: ['implementation'],
          recommendation: { option: 'A', reason: 'simplest' },
          safeDefault: { exists: true, option: 'A', reason: 'reversible' },
          material: true,
          affected: ['AC-1'],
          unblocked: [],
        },
        systemClock,
      ).id,
  };
}

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function startService(box: Sandbox): ChildProcess & { output: () => string } {
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', CLI_ENTRY, 'service', 'run', '--repo', box.repo], { cwd: box.repo, env: box.env({ ORBIT_HOME: box.orbitHome }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  children.push(child);
  return Object.assign(child, { output: () => out });
}

describe('cancel is durable across processes', () => {
  it('cancels an unowned BLOCKED run, and a later process sees it cancelled, reported and not resumable', async () => {
    const s = setup();
    const run = s.newRun();
    s.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);

    const cancel = await s.box.run(['cancel', run.id]);
    expect(cancel.code, cancel.stderr).toBe(0);
    expect(cancel.stdout).toMatch(/cancelled \(the run was blocked and unowned\)/);

    // A different process, started afterwards, reads the same answer from the files.
    const status = JSON.parse((await s.box.run(['status', run.id, '--json'])).stdout) as { state: string; cancel_requested: boolean; owner: unknown };
    expect(status).toMatchObject({ state: 'CANCELLED', cancel_requested: true, owner: null });
    const report = await s.box.run(['report', run.id]);
    expect(report.stdout).toMatch(/^# Orbit run .*: CANCELLED/);
    const resume = await s.box.run(['resume', run.id]);
    expect(resume.code).toBe(5);
    expect(resume.stderr).toMatch(/CANCELLED; nothing to resume|durable cancellation/);
    // And once more: cancelling twice is not an error.
    expect((await s.box.run(['cancel', run.id])).stdout).toMatch(/already CANCELLED/);
  });

  it('records the request while a controller owns the run, and the next controller honors it after a restart', async () => {
    const s = setup();
    const run = s.newRun();
    s.moveTo(run.id, ['PREFLIGHT', 'CONTRACTING', 'PLANNING']);
    // A controller that died: its lease is still unexpired, so the CLI must not take the run. The TTL is far
    // longer than any child start-up, so slow hosts cannot expire it early; the test expires it explicitly below.
    acquireLease(s.db, run.id, 'dead-controller', 600_000, systemClock);
    const cancel = await s.box.run(['cancel', run.id]);
    expect(cancel.code, cancel.stderr).toBe(0);
    expect(cancel.stdout).toMatch(/cancellation recorded; the controller that owns the run ends it at its next safe point/);
    const mid = JSON.parse((await s.box.run(['status', run.id, '--json'])).stdout) as { state: string; cancel_requested: boolean; owner: { owner_id: string } | null };
    expect(mid).toMatchObject({ state: 'PLANNING', cancel_requested: true, owner: { owner_id: 'dead-controller' } });

    // The request survives with no process alive. The dead lease expires (driven here, not waited for), and a
    // fresh service takes the run and ends it.
    s.db.run('UPDATE leases SET expires_at = ? WHERE run_id = ? AND owner_id = ?', systemClock.now() - 1, run.id, 'dead-controller');
    const service = startService(s.box);
    await waitFor(() => getRun(s.db, run.id).state === 'CANCELLED', 40_000).catch((err: Error) => {
      throw new Error(`${err.message}\nservice output:\n${service.output()}`);
    });
    const done = JSON.parse((await s.box.run(['status', run.id, '--json'])).stdout) as { state: string; owner: unknown; outcome_reason: string | null };
    expect(done.state).toBe('CANCELLED');
    expect(done.outcome_reason).toMatch(/cancelled by request/);
    expect(existsSync(join(s.box.repo, '.orbit', 'runs', run.id, 'final.md'))).toBe(true);

    service.kill('SIGTERM');
    const code = await new Promise<number | null>((r) => service.on('close', (c) => r(c)));
    expect(code).toBe(0);
    expect(service.output()).toMatch(/started in service mode/);
    const status = await s.box.run(['status', '--json']);
    const j = JSON.parse(status.stdout) as { controllers: { live: boolean }[] };
    expect(j.controllers.filter((c) => c.live)).toEqual([]);
  }, 90_000);
});

describe('decide, then resume', () => {
  it('blocks resuming until the question is answered, then hands the run to a controller', async () => {
    const s = setup();
    const run = s.newRun();
    s.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    const qid = s.ask(run.id);

    const listed = await s.box.run(['questions', run.id, '--json']);
    expect((JSON.parse(listed.stdout) as { id: string; status: string }[]).map((q) => [q.id, q.status])).toEqual([[qid, 'open']]);
    const status = JSON.parse((await s.box.run(['status', run.id, '--json'])).stdout) as { state: string; questions: { open: { id: string }[] } };
    expect(status.state).toBe('BLOCKED');
    expect(status.questions.open.map((q) => q.id)).toEqual([qid]);

    const refused = await s.box.run(['resume', run.id]);
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain(qid);
    expect(getRun(s.db, run.id).state).toBe('BLOCKED');

    // A model or worker identity cannot supply the decision.
    const bad = await s.box.run(['decide', run.id, qid, 'A', '--by', 'implementer']);
    expect(bad.code).toBe(4);
    expect(getRun(s.db, run.id).state).toBe('BLOCKED');

    const decided = await s.box.run(['decide', run.id, qid, 'A']);
    expect(decided.code, decided.stderr).toBe(0);
    expect(decided.stdout).toMatch(/chose option A by alice/);
    expect(decided.stdout).toContain(`orbit resume ${run.id}`);
    const decisions = readFileSync(join(s.box.repo, '.orbit', 'runs', run.id, 'decisions.jsonl'), 'utf8');
    expect(decisions).toContain('inquisition.answer');

    const resumed = await s.box.run(['resume', run.id, '--json', '--detach']);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ state: 'PREFLIGHT', paused: false, service_running: false });
    expect(getRun(s.db, run.id)).toMatchObject({ state: 'PREFLIGHT', endedAt: null });

    // With the answer recorded and the run live again, a controller process takes it from here.
    const service = startService(s.box);
    await waitFor(() => s.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'state.transition' AND from_state = 'PREFLIGHT' AND actor NOT LIKE 'cli%'", run.id), 40_000).catch((err: Error) => {
      throw new Error(`${err.message}\nservice output:\n${service.output()}`);
    });
    service.kill('SIGTERM');
    await new Promise((r) => service.on('close', r));
    // Stop whatever the controller started so the sandbox can be removed cleanly.
    await s.box.run(['cancel', run.id]);
  }, 120_000);
});

describe('pause and resume across processes', () => {
  it('is a durable flag a different process can read and clear', async () => {
    const s = setup();
    const run = s.newRun();
    s.moveTo(run.id, ['PREFLIGHT']);
    expect((await s.box.run(['pause', run.id])).code).toBe(0);
    expect((JSON.parse((await s.box.run(['status', run.id, '--json'])).stdout) as { paused: boolean }).paused).toBe(true);
    // No controller runs in this test, so the flag is cleared explicitly for a service that is started later.
    expect((await s.box.run(['resume', run.id, '--detach'])).code).toBe(0);
    expect((JSON.parse((await s.box.run(['status', run.id, '--json'])).stdout) as { paused: boolean }).paused).toBe(false);
  });
});
