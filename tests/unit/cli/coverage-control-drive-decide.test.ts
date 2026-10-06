/**
 * pause / resume / cancel, the foreground driver and decide / questions:
 * the paths the main tests do not take. The foreground driver runs against a
 * scripted controller (its start() is a function the test supplies), so what
 * is checked is what the driver itself does: the events it prints, how it
 * treats Ctrl-C and SIGTERM, and the exit code it ends with.
 */
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driveForeground, formatEvent } from '../../../src/cli/commands/drive.ts';
import { createContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import { acquireLease, getRun, releaseLease, setPaused, transition } from '../../../src/controller/run-store.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { registerController } from '../../../src/storage/controllers.ts';
import { makeLab, type Lab } from './lab.ts';

const hooks = vi.hoisted(() => ({
  fake: false,
  start: null as null | ((runId: string) => Promise<void>),
  stops: [] as string[],
  ctor: [] as Array<Record<string, unknown>>,
  answer: null as null | (() => unknown),
  loadRunContext: null as null | (() => unknown),
  lenientContext: null as null | (() => unknown),
  liveLeaseNull: 0,
}));

vi.mock('../../../src/controller/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/index.ts')>();
  class Fake {
    private readonly runId: string;
    constructor(opts: { runId: string } & Record<string, unknown>) {
      this.runId = opts.runId;
      hooks.ctor.push(opts);
    }
    async start(): Promise<void> {
      await hooks.start?.(this.runId);
    }
    async stop(reason: string): Promise<void> {
      hooks.stops.push(reason);
    }
  }
  const Wrapper = function (this: unknown, opts: ConstructorParameters<typeof actual.Controller>[0]) {
    return hooks.fake ? new Fake(opts as never) : new actual.Controller(opts);
  } as unknown as typeof actual.Controller;
  return { ...actual, Controller: Wrapper };
});
vi.mock('../../../src/inquisition/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/inquisition/index.ts')>();
  return { ...actual, answerQuestion: (...a: Parameters<typeof actual.answerQuestion>) => (hooks.answer ? hooks.answer() : actual.answerQuestion(...a)) } as typeof actual;
});
vi.mock('../../../src/controller/context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/context.ts')>();
  return {
    ...actual,
    loadRunContext: (...a: Parameters<typeof actual.loadRunContext>) => (hooks.loadRunContext ? hooks.loadRunContext() : actual.loadRunContext(...a)),
    lenientContext: (...a: Parameters<typeof actual.lenientContext>) => (hooks.lenientContext ? hooks.lenientContext() : actual.lenientContext(...a)),
  } as typeof actual;
});
vi.mock('../../../src/cli/context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/context.ts')>();
  return {
    ...actual,
    liveLease: (...a: Parameters<typeof actual.liveLease>) => {
      if (hooks.liveLeaseNull > 0) {
        hooks.liveLeaseNull--;
        return null;
      }
      return actual.liveLease(...a);
    },
  } as typeof actual;
});

const labs: Lab[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
beforeEach(() => {
  hooks.fake = false;
  hooks.start = null;
  hooks.stops = [];
  hooks.ctor = [];
  hooks.answer = null;
  hooks.loadRunContext = null;
  hooks.lenientContext = null;
  hooks.liveLeaseNull = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  labs.splice(0).forEach((l) => l.close());
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await sleep(5);
  }
}
const setState = (l: Lab, runId: string, state: string) => l.db().run('UPDATE runs SET state = ?, updated_at = ?, ended_at = ? WHERE id = ?', state, Date.now(), Date.now(), runId);

/** The CLI with a scripted controller and fast polling. */
function drive(l: Lab, argv: string[], over: Parameters<Lab['cli']>[1] = {}) {
  hooks.fake = true;
  const signals = new EventEmitter();
  const exits: number[] = [];
  const result = l.cli(argv, { seams: { pollMs: 5, controllerDeps: () => ({}) as never, admission: async () => null, signals, exit: ((c: number) => void exits.push(c)) as never }, ...over });
  return { result, signals, exits };
}

describe('formatEvent', () => {
  const at = Date.UTC(2026, 9, 5, 13, 4, 9);
  const row = (over: Partial<Parameters<typeof formatEvent>[0]>) => ({ id: 1, ts: at, type: 'x', from_state: null, to_state: null, actor: 'a', data_json: null, ...over });

  it('shows a state transition with its reason, or with dashes for missing states', () => {
    expect(formatEvent(row({ type: 'state.transition', from_state: 'PLANNING', to_state: 'IMPLEMENTING', data_json: '{"reason":"contract accepted"}' }))).toBe('[13:04:09] PLANNING -> IMPLEMENTING  contract accepted');
    expect(formatEvent(row({ type: 'state.transition' }))).toBe('[13:04:09] - -> -');
    // A reason says what to do next, so it is shown whole (it used to be cut at 140 characters, mid-sentence).
    expect(formatEvent(row({ type: 'state.transition', data_json: JSON.stringify({ reason: 'r '.repeat(100) }) }))).toBe(`[13:04:09] - -> -  ${'r '.repeat(100).trim()}`);
  });

  it('names a progress or decision event by its kind, with a fallback', () => {
    expect(formatEvent(row({ type: 'progress', data_json: '{"kind":"worker.started"}' }))).toBe('[13:04:09] progress: worker.started');
    expect(formatEvent(row({ type: 'progress', data_json: '{"kind":5}' }))).toBe('[13:04:09] progress: recorded');
    expect(formatEvent(row({ type: 'decision.recorded', data_json: '{"kind":"answer"}' }))).toBe('[13:04:09] decision recorded: answer');
    expect(formatEvent(row({ type: 'decision.recorded' }))).toBe('[13:04:09] decision recorded: ');
  });

  it('prints any other event by type, with its reason when it has a string one', () => {
    expect(formatEvent(row({ type: 'run.paused' }))).toBe('[13:04:09] run.paused');
    expect(formatEvent(row({ type: 'worker.failed', data_json: '{"reason":"timed out"}' }))).toBe('[13:04:09] worker.failed: timed out');
    expect(formatEvent(row({ type: 'worker.failed', data_json: '{"reason":7}' }))).toBe('[13:04:09] worker.failed');
  });

  it('treats null, array, scalar and unreadable data as no data', () => {
    for (const data_json of ['null', '[1]', '"s"', '3', '{not json', '']) expect(formatEvent(row({ type: 'e', data_json }))).toBe('[13:04:09] e');
  });
});

describe('orbit run --foreground and resume --foreground, with a scripted controller', () => {
  it('prints the run\'s events from the start, hides lease and budget noise, and ends with the report pointer and the state\'s exit code', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async (id) => {
      const d = l.db();
      appendEvent(d, id, 'lease.renewed', 'c', null, Date.now());
      appendEvent(d, id, 'budget.charged', 'c', null, Date.now());
      appendEvent(d, id, 'progress', 'c', { kind: 'planning' }, Date.now());
      await sleep(40);
      l.moveTo(id, ['PREFLIGHT', 'CANCELLED'], 'enough');
    };
    const { result } = drive(l, ['run', '--goal', 'Add a mul function.', '--foreground']);
    const r = await result;
    expect(r.code, r.err).toBe(13);
    expect(r.out).toMatch(/^run orb-\S+ started \(autonomous, foreground; Ctrl-C pauses it, it does not cancel\)\n/);
    expect(r.out).toMatch(/progress: planning\n/);
    expect(r.out).toMatch(/PREFLIGHT -> CANCELLED {2}enough\n/);
    expect(r.out).not.toMatch(/lease\.|budget\./);
    expect(r.out).toMatch(/ended CANCELLED\nreport: orbit report orb-\S+\n$/);
    expect(hooks.ctor[0]).toMatchObject({ mode: 'foreground', handleSignals: false });
  });

  it.each([
    ['SUCCEEDED', 0],
    ['EXHAUSTED', 11],
    ['IMPOSSIBLE', 12],
  ])('ends %s with exit code %i and says why', async (state, code) => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async (id) => {
      l.db().run('UPDATE runs SET state = ?, outcome_reason = ?, ended_at = ? WHERE id = ?', state, `the reason is ${state}`, Date.now(), id);
    };
    const r = await drive(l, ['run', '--goal', 'g', '--foreground']).result;
    expect(r.code).toBe(code);
    expect(r.out).toContain(`ended ${state}: the reason is ${state}\n`);
  });

  it('with --json prints one JSON object per line: the start, each event, and a result with the open questions', async () => {
    const l = lab();
    await l.cli(['init']);
    let runId = '';
    hooks.start = async (id) => {
      runId = id;
      l.ask(id, { id: 'q-open-1' });
      l.moveTo(id, ['PREFLIGHT', 'BLOCKED'], 'needs an answer');
    };
    const r = await drive(l, ['run', '--goal', 'g', '--foreground', '--json']).result;
    expect(r.code).toBe(10);
    const lines = r.out.trim().split('\n').map((x) => JSON.parse(x) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: 'started', run_id: runId });
    expect(lines.some((x) => x.type === 'event' && x.to_state === 'BLOCKED')).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: 'result', run_id: runId, state: 'BLOCKED', paused: false, exit_code: 10, open_questions: ['q-open-1'] });
  });

  it('lists the open questions of a blocked run and what to do next, or says to resolve the reason when there are none', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async (id) => {
      l.ask(id, { id: 'q-1', question: 'Should mul   round\nits result?' });
      l.moveTo(id, ['PREFLIGHT', 'BLOCKED']);
    };
    const withQ = await drive(l, ['run', '--goal', 'one', '--foreground']).result;
    expect(withQ.out).toMatch(/ended BLOCKED: waiting for a decision\n/);
    expect(withQ.out).toContain('  open question q-1: Should mul round its result?\n');
    expect(withQ.out).toMatch(/answer with "orbit decide orb-\S+ <question-id> <answer>", then "orbit resume orb-\S+ --foreground"\n$/);

    hooks.start = async (id) => {
      l.moveTo(id, ['PREFLIGHT', 'BLOCKED']);
    };
    const without = await drive(l, ['run', '--goal', 'two', '--foreground']).result;
    expect(without.out).toMatch(/resolve the reason above, then "orbit resume orb-\S+ --foreground"\n$/);
    expect(without.out).not.toContain('open question');
  });

  it('Ctrl-C pauses the run instead of cancelling it, stops the controller, and exits 20', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async () => {
      await until(() => hooks.stops.length > 0);
    };
    const d = drive(l, ['run', '--goal', 'g', '--foreground']);
    await until(() => d.signals.listenerCount('SIGINT') === 1);
    expect(d.signals.listenerCount('SIGTERM')).toBe(1);
    d.signals.emit('SIGINT');
    const r = await d.result;
    expect(r.code).toBe(20);
    // The poll may also notice the pause and ask for the stop once more; the Ctrl-C reason always comes first.
    expect(hooks.stops[0]).toBe('paused by Ctrl-C');
    expect(hooks.stops.slice(1).every((x) => x === 'run paused')).toBe(true);
    expect(r.err).toMatch(/^\ninterrupt: pausing the run \(not cancelling it\)\. Workers keep running; continue with: orbit resume orb-\S+ --foreground\n$/);
    expect(r.out).toMatch(/is CREATED and paused; continue with "orbit resume orb-\S+ --foreground"\n$/);
    expect(d.signals.listenerCount('SIGINT')).toBe(0);
    expect(d.signals.listenerCount('SIGTERM')).toBe(0);
    expect(d.exits).toEqual([]);
  });

  it('a second Ctrl-C ends the process at once with the paused exit code', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async () => {
      await until(() => hooks.stops.length > 0);
    };
    const d = drive(l, ['run', '--goal', 'g', '--foreground']);
    await until(() => d.signals.listenerCount('SIGINT') === 1);
    d.signals.emit('SIGINT');
    d.signals.emit('SIGINT');
    const r = await d.result;
    expect(d.exits).toEqual([20]);
    expect(r.err).toContain('second interrupt: exiting now; the run stays paused\n');
    expect(hooks.stops[0]).toBe('paused by Ctrl-C');
  });

  it('says when the pause could not be recorded, and still stops', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async (id) => {
      setState(l, id, 'CANCELLED');
      await until(() => hooks.stops.length > 0);
    };
    const d = drive(l, ['run', '--goal', 'g', '--foreground']);
    await until(() => d.signals.listenerCount('SIGINT') === 1);
    await sleep(30);
    d.signals.emit('SIGINT');
    const r = await d.result;
    expect(r.err).toMatch(/could not record the pause: run orb-\S+ is CANCELLED; nothing to pause\n/);
    expect(hooks.stops).toEqual(['paused by Ctrl-C']);
    expect(r.code).toBe(13);
  });

  it('SIGTERM stops the controller without pausing, and a run that is neither finished nor paused exits 1', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async () => {
      await until(() => hooks.stops.length > 0);
    };
    const d = drive(l, ['run', '--goal', 'g', '--foreground']);
    await until(() => d.signals.listenerCount('SIGTERM') === 1);
    d.signals.emit('SIGTERM');
    const r = await d.result;
    expect(hooks.stops).toEqual(['received SIGTERM']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/run orb-\S+ is CREATED; continue with "orbit resume orb-\S+ --foreground"\n$/);
    expect(r.out).not.toContain('and paused');
  });

  it('ends the session once when the run is paused from another terminal', async () => {
    const l = lab();
    await l.cli(['init']);
    hooks.start = async (id) => {
      setPaused(l.db(), id, true, 'cli:other', systemClock);
      await until(() => hooks.stops.length > 0);
      await sleep(40);
    };
    const r = await drive(l, ['run', '--goal', 'g', '--foreground']).result;
    expect(hooks.stops).toEqual(['run paused']);
    expect(r.code).toBe(20);
    expect(r.out).toContain('run.paused');
  });

  it('keeps going when a poll finds the database busy', async () => {
    const l = lab();
    const run = l.newRun();
    const db = l.db();
    const ctx = createContext({ io: memoryIo(), cwd: l.repo, env: process.env, seams: { pollMs: 5, controllerDeps: () => ({}) as never, signals: new EventEmitter() } });
    hooks.fake = true;
    hooks.start = async () => {
      await sleep(40);
      setState(l, run.id, 'CANCELLED');
    };
    const real = db.all.bind(db);
    let failed = 0;
    vi.spyOn(db, 'all').mockImplementation(((sql: string, ...p: never[]) => {
      if (failed < 2 && /FROM events/.test(sql)) {
        failed++;
        throw new Error('database is locked');
      }
      return real(sql, ...p);
    }) as typeof db.all);
    const result = await driveForeground(ctx, { repoRoot: l.repo, config: defaultConfig('autonomous'), db, runId: run.id, json: false, fromStart: true });
    expect(failed).toBe(2);
    expect(result.exitCode).toBe(13);
    expect((ctx.io as ReturnType<typeof memoryIo>).stdout).toContain('created');
  });

  it('refuses a run that a live controller owns, or that is paused, before starting anything', async () => {
    const l = lab();
    const run = l.newRun();
    const db = l.db();
    hooks.fake = true;
    const ctx = () => createContext({ io: memoryIo(), cwd: l.repo, env: process.env, seams: { pollMs: 5, controllerDeps: () => ({}) as never } });
    const opts = { repoRoot: l.repo, config: defaultConfig('autonomous'), db, runId: run.id, json: false, fromStart: false };
    acquireLease(db, run.id, 'other-controller', 60_000, systemClock);
    await expect(driveForeground(ctx(), opts)).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE', message: expect.stringContaining('owned by a live controller (other-controller)') });
    releaseLease(db, run.id, 'other-controller');
    setPaused(db, run.id, true, 'test', systemClock);
    await expect(driveForeground(ctx(), opts)).rejects.toMatchObject({ code: 'TRANSITION_INVALID', message: `run ${run.id} is paused; run "orbit resume ${run.id}" first` });
    expect(hooks.ctor).toEqual([]);
  });

  it('prints only what happens from now on when resuming', async () => {
    const l = lab();
    await l.cli(['init']);
    const run = l.newRun('A goal.');
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED'], 'old news');
    hooks.start = async (id) => {
      appendEvent(l.db(), id, 'worker.started', 'c', { reason: 'fresh' }, Date.now());
    };
    const d = drive(l, ['resume', run.id, '--foreground']);
    const r = await d.result;
    expect(r.out).toContain(`run ${run.id}: resumed BLOCKED run at `);
    expect(r.out).toContain('; driving it in the foreground (Ctrl-C pauses it)\n');
    expect(r.out).toContain('worker.started: fresh\n');
    expect(r.out).not.toContain('old news');
    expect(r.code).toBe(1);
  });

  it('with --json the resume prints no banner, and --policy names the policy file', async () => {
    const l = lab();
    await l.cli(['init']);
    const run = l.newRun('A goal.');
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    hooks.start = async () => {};
    const r = await drive(l, ['resume', run.id, '--foreground', '--json', '--policy', '.orbit/config.yaml']).result;
    const lines = r.out.trim().split('\n').map((x) => JSON.parse(x) as { type: string });
    expect(lines.every((x) => ['event', 'result'].includes(x.type))).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: 'result', run_id: run.id });
  });
});

describe('orbit pause, resume and cancel: the other paths', () => {
  it('pause --json reports the run and its paused flag', async () => {
    const l = lab();
    const run = l.newRun();
    const r = await l.cli(['pause', run.id, '--json']);
    expect(JSON.parse(r.out)).toEqual({ run_id: run.id, state: 'CREATED', paused: true });
  });

  it('resumes a blocked run at the stage it stopped in when that stage can be re-entered', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'CONTRACTING', 'BLOCKED']);
    expect(getRun(l.db(), run.id).resumeState).toBe('CONTRACTING');
    const r = await l.cli(['resume', run.id, '--detach']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('resumed BLOCKED run at CONTRACTING');
    expect(getRun(l.db(), run.id).state).toBe('CONTRACTING');
    const ev = l.db().get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'run.resumed'", run.id);
    expect(JSON.parse(ev!.data_json)).toEqual({ from: 'BLOCKED', to: 'CONTRACTING', forced: false });
  });

  it('without a usable stage, goes back to VERIFYING when a candidate exists, PLANNING when there is a contract, else PREFLIGHT', async () => {
    const l = lab();
    const make = (goal: string) => {
      const run = l.newRun(goal);
      l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
      l.db().run('UPDATE runs SET resume_state = NULL WHERE id = ?', run.id);
      return run;
    };
    const plain = make('plain');
    const withContract = make('contract');
    l.db().run("UPDATE runs SET contract_json = '{}' WHERE id = ?", withContract.id);
    const withCandidate = make('candidate');
    l.db().run(
      `INSERT INTO candidates (id, run_id, seq, attempt, commit_sha, tree_hash, parent_sha, status, created_at) VALUES ('cand-1', ?, 1, 1, ?, ?, ?, 'READY', ?)`,
      withCandidate.id,
      'a'.repeat(40),
      'b'.repeat(40),
      'c'.repeat(40),
      Date.now(),
    );
    const at = async (id: string) => {
      const r = await l.cli(['resume', id, '--detach']);
      expect(r.code, r.err).toBe(0);
      return /resumed BLOCKED run at (\w+)/.exec(r.out)![1];
    };
    expect(await at(plain.id)).toBe('PREFLIGHT');
    expect(await at(withContract.id)).toBe('PLANNING');
    expect(await at(withCandidate.id)).toBe('VERIFYING');
  });

  it('says there is nothing to change for a run that is already going, and whether a controller is running', async () => {
    const l = lab();
    const run = l.newRun();
    const none = await l.cli(['resume', run.id, '--detach']);
    expect(none.out).toBe(`run ${run.id}: created but not started; a controller picks it up (CREATED)\nNo service is running, so nothing continues this run until one is started ("orbit service install"). To drive it here instead: orbit resume ${run.id} --foreground\n`);
    registerController(l.db(), { id: 'svc-1', pid: process.pid, host: hostname(), mode: 'service' }, systemClock);
    const served = await l.cli(['resume', run.id]);
    expect(served.out).toBe(`run ${run.id}: created but not started; a controller picks it up (CREATED)\n`);
    const j = await l.cli(['resume', run.id, '--json']);
    expect(JSON.parse(j.out)).toEqual({ run_id: run.id, state: 'CREATED', paused: false, actions: ['created but not started; a controller picks it up'], service_running: true });
    // A run that is past CREATED and not paused really is already going.
    l.moveTo(run.id, ['PREFLIGHT']);
    expect(JSON.parse((await l.cli(['resume', run.id, '--json'])).out)).toMatchObject({ actions: ['already running; nothing to change'] });
  });

  it('unpauses and reports it', async () => {
    const l = lab();
    const run = l.newRun();
    await l.cli(['pause', run.id]);
    const r = await l.cli(['resume', run.id, '--detach']);
    expect(r.out).toContain('run ' + run.id + ': unpaused (CREATED)');
    expect(getRun(l.db(), run.id).paused).toBe(false);
  });

  it('waits for a live controller to finish a cancellation and reports a cancelled run', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT']);
    acquireLease(l.db(), run.id, 'live-controller', 60_000, systemClock);
    const pending = l.cli(['cancel', run.id, '--wait', '5'], { seams: { pollMs: 10 } });
    await until(() => getRun(l.db(), run.id).cancelRequested);
    transition(l.db(), { runId: run.id, to: 'CANCELLED', ownerId: 'live-controller', reason: 'cancel honored', actor: 'live-controller' }, systemClock);
    const r = await pending;
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(`run ${run.id}: cancelled\n`);
  });

  it('gives up waiting at the deadline and says the controller will end the run at its next safe point', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT']);
    acquireLease(l.db(), run.id, 'live-controller', 60_000, systemClock);
    const started = Date.now();
    const r = await l.cli(['cancel', run.id, '--wait', '1', '--json']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(JSON.parse(r.out)).toMatchObject({ run_id: run.id, state: 'PREFLIGHT', cancel_requested: true, how: 'cancellation recorded; the controller that owns the run ends it at its next safe point' });
  });

  it('does not wait without --wait, and rejects a bad one', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT']);
    acquireLease(l.db(), run.id, 'live-controller', 60_000, systemClock);
    const r = await l.cli(['cancel', run.id]);
    expect(r.out).toContain('cancellation recorded; the controller that owns the run ends it at its next safe point (PREFLIGHT)');
    expect((await l.cli(['cancel', run.id, '--wait', 'soon'])).code).toBe(2);
  });

  it('says a controller took the run when one appears between the check and the lease', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    acquireLease(l.db(), run.id, 'late-controller', 60_000, systemClock);
    hooks.liveLeaseNull = 1;
    const r = await l.cli(['cancel', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(`run ${run.id}: cancellation recorded; a controller took the run just now and will end it (BLOCKED)\n`);
  });

  it('passes on an error from ending the run that is not a lost race', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    hooks.loadRunContext = () => {
      throw new Error('policy does not verify');
    };
    hooks.lenientContext = () => {
      throw new OrbitError('INTERNAL', 'cannot even read the snapshot');
    };
    const r = await l.cli(['cancel', run.id]);
    expect(r.code).toBe(1);
    expect(r.err).toBe('orbit: cannot even read the snapshot\n');
    // The CLI lease did not outlive the failure.
    expect(l.db().get('SELECT 1 FROM leases WHERE run_id = ?', run.id)).toBeUndefined();
  });
});

describe('orbit decide', () => {
  const canned = (baselineException: unknown) => () => ({
    question: { answer: 'Approve' },
    chosenOption: { label: 'Approve' },
    decision: { id: 'dec-1' },
    unblocks: [],
    baselineException,
  });

  it.each([
    ['already-applied', null, 'baseline exception for check lint was already in the contract'],
    ['applied', null, 'baseline exception recorded: the contract now accepts the pre-existing failure of check lint, bound to its recorded fingerprint'],
    ['deferred', null, 'baseline exception for check lint approved; it is applied as soon as the run has a contract'],
    ['refused', 'fingerprint changed', 'baseline exception for check lint refused (fingerprint changed): the contract is unchanged'],
    ['declined', 'answered "Reject"', 'baseline exception for check lint not accepted (answered "Reject"): the contract is unchanged'],
    ['unanswered', null, 'baseline exception for check lint not accepted: the contract is unchanged'],
  ])('describes a %s baseline exception in one line', async (status, detail, text) => {
    const l = lab();
    const run = l.newRun();
    const q = l.ask(run.id);
    hooks.answer = canned({ questionId: q.id, checkId: 'lint', status, detail });
    const r = await l.cli(['decide', run.id, q.id, 'Approve']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`${text}\n`);
  });

  it('prints the answer as JSON with the option chosen, what it unblocks and the baseline outcome', async () => {
    const l = lab();
    const run = l.newRun();
    const q = l.ask(run.id);
    const r = await l.cli(['decide', run.id, q.id, 'A', '--json']);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(j).toMatchObject({ run_id: run.id, question_id: q.id, answer: 'A', chosen_option: 'A', baseline_exception: null });
    expect(String(j.decision_id)).toMatch(/^dec-/);
  });

  it('with --json lists the questions that are still open', async () => {
    const l = lab();
    const run = l.newRun();
    const first = l.ask(run.id, { id: 'q-one' });
    l.ask(run.id, { id: 'q-two' });
    const r = await l.cli(['decide', run.id, first.id, 'A', '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ open_questions: ['q-two'], run_state: 'CREATED', unblocks: ['AC-1'] });
  });

  it('lists the other open questions and tells a blocked run how to continue', async () => {
    const l = lab();
    const run = l.newRun();
    const q1 = l.ask(run.id, { id: 'q-first' });
    const q2 = l.ask(run.id, { id: 'q-second' });
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    const r = await l.cli(['decide', run.id, q1.id, 'A']);
    expect(r.out).toContain(`1 question(s) still open: ${q2.id}\n`);
    expect(r.out).toContain(`The run is BLOCKED. Continue it with: orbit resume ${run.id} --foreground\n`);
    expect(r.out).toMatch(/recorded dec-\S+: chose option A by alice\n/);
    const free = await l.cli(['decide', run.id, q2.id, 'something else entirely']);
    expect(free.out).toMatch(/free-text answer by alice/);
    expect(free.out).not.toContain('still open');
  });

  it('needs a non-empty answer, and says which prefix is ambiguous', async () => {
    const l = lab();
    const run = l.newRun();
    l.ask(run.id, { id: 'q-same-1' });
    l.ask(run.id, { id: 'q-same-2' });
    const empty = await l.cli(['decide', run.id, 'q-same-1', '   ']);
    expect(empty).toMatchObject({ code: 2 });
    expect(empty.err).toContain('an answer is required (an option label such as "A", or free text)');
    const piped = await l.cli(['decide', run.id, 'q-same-1', '-'], {}, '  \n');
    expect(piped.code).toBe(2);
    const amb = await l.cli(['decide', run.id, 'q-sam', 'A']);
    expect(amb.code).toBe(3);
    expect(amb.err).toContain(`"q-sam" matches more than one question of run ${run.id} (q-same-1, q-same-2)`);
    const short = await l.cli(['decide', run.id, 'q-', 'A']);
    expect(short.err).toContain('has no question q-; its questions: q-same-1, q-same-2');
    const nothing = lab();
    const other = nothing.newRun();
    expect((await nothing.cli(['decide', other.id, 'q-x', 'A'])).err).toContain('has no question q-x (it has asked none)');
  });
});

describe('orbit questions', () => {
  it('says there are none, with wording for open-only and for --all, and prints JSON', async () => {
    const l = lab();
    const run = l.newRun();
    expect((await l.cli(['questions', run.id])).out).toBe(`run ${run.id} has no open questions\n`);
    expect((await l.cli(['questions', run.id, '--all'])).out).toBe(`run ${run.id} has asked no questions\n`);
    expect(JSON.parse((await l.cli(['questions', run.id, '--json'])).out)).toEqual([]);
    const q = l.ask(run.id);
    const j = JSON.parse((await l.cli(['questions', run.id, '--json'])).out) as Array<{ id: string }>;
    expect(j.map((x) => x.id)).toEqual([q.id]);
  });

  it('prints each question with its evidence, options, recommendation, safe default and what it blocks, then how to answer', async () => {
    const l = lab();
    const run = l.newRun();
    const q = l.ask(run.id, { id: 'q-full', question: 'Should mul   round?', options: [{ label: 'A', description: 'exact', consequences: '' }, { label: 'B', description: 'rounded', consequences: 'matches money' }], affected: ['AC-1', 'AC-2'] });
    const r = await l.cli(['questions', run.id]);
    expect(r.out).toBe(
      [
        `${q.id}  [open] [material]  Should mul round?`,
        '  evidence: apps/calc.mjs:1',
        '  A) exact',
        '  B) rounded (consequences: matches money)',
        '  recommended: A (simplest)',
        '  safe default: A (reversible)',
        '  blocks: AC-1, AC-2',
        '',
        `Answer with: orbit decide ${run.id} <question-id> <answer>`,
        '',
      ].join('\n'),
    );
  });

  it('leaves out what a question does not have, and shows who answered one when everything is listed', async () => {
    const l = lab();
    const run = l.newRun();
    const bare = l.ask(run.id, { id: 'q-bare', material: false, evidence: [], affected: [] });
    l.db().run("UPDATE questions SET recommendation = NULL, safe_default = NULL WHERE id = ?", bare.id);
    const unsafe = l.ask(run.id, { id: 'q-unsafe', safeDefault: { exists: false, option: null, reason: 'none' }, affected: [] });
    const yes = l.ask(run.id, { id: 'q-yes', safeDefault: { exists: true, option: null, reason: 'harmless' } });
    await l.cli(['decide', run.id, yes.id, 'A']);
    const r = await l.cli(['questions', run.id, '--all']);
    const text = r.out;
    expect(text).toContain('q-bare  [open]  ');
    expect(text.split('q-bare')[1]!.split('q-unsafe')[0]).not.toMatch(/evidence|recommended|safe default|blocks/);
    expect(text.split('q-unsafe')[1]!.split('q-yes')[0]).not.toContain('safe default');
    expect(text).toContain(`  answered by alice: A\n`);
    expect(unsafe.id).toBe('q-unsafe');
    // Only answered questions remain when every open one is answered: no prompt to answer.
    await l.cli(['decide', run.id, bare.id, 'A']);
    await l.cli(['decide', run.id, unsafe.id, 'A']);
    const done = await l.cli(['questions', run.id, '--all']);
    expect(done.out).not.toContain('Answer with:');
  });
});
