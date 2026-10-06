/**
 * `orbit run` end to end, in this process, over the real controller loop, git
 * repository, SQLite state, worker shim and the fake provider CLIs.
 */
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import type { CliContext, CliSeams } from '../../../src/cli/context.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { registerController } from '../../../src/storage/controllers.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { listRuns } from '../../../src/controller/run-store.ts';
import { baseScenario, git as labGit, implementMul, labDeps, makeLab, seedRegistry, waitFor, writeScenario, type Lab } from '../controller/harness.ts';
import { openDb } from '../../../src/storage/db.ts';
import { stateDbPath } from '../../../src/controller/start.ts';
import { repoKey } from '../../../src/controller/context.ts';

const labs: Lab[] = [];
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}
afterEach(() => labs.splice(0).forEach((l) => l.close()));

function seams(l: Lab, extra: Partial<CliSeams> = {}): CliSeams {
  return {
    pollMs: 20,
    controller: { tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300, shutdownGraceMs: 400, startGraceMs: 2_000 },
    controllerDeps: (input) => {
      seedRegistry(input.db!);
      return labDeps(l, input.db);
    },
    ...extra,
  };
}

async function cli(l: Lab, argv: string[], over: Partial<CliContext> = {}) {
  const io = memoryIo();
  const code = await main(argv, { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome, HOME: l.base }, user: 'alice', seams: seams(l), ...over });
  return { code, out: io.stdout, err: io.stderr };
}

const GOAL = 'Add a mul function to the calculator.';

describe('orbit run --foreground', () => {
  it('drives a run to success, streams its progress and leaves a final report', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const r = await cli(l, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    const id = /^run (orb-\S+) started/m.exec(r.out)?.[1];
    expect(id).toBeTruthy();
    expect(r.out).toMatch(/\[\d\d:\d\d:\d\d\] CREATED -> PREFLIGHT/);
    expect(r.out).toMatch(/-> IMPLEMENTING/);
    expect(r.out).toMatch(/-> SUCCEEDED/);
    expect(r.out).toContain(`run ${id} ended SUCCEEDED`);
    expect(getRun(l.db(), id!).state).toBe('SUCCEEDED');
    // The controller wrote the report; the CLI only reads it.
    expect(existsSync(join(l.repo, '.orbit', 'runs', id!, 'final.md'))).toBe(true);
    const rep = await cli(l, ['report', id!]);
    expect(rep.out).toMatch(/^# Orbit run .*: SUCCEEDED/);
    const st = JSON.parse((await cli(l, ['status', id!, '--json'])).out) as { state: string; budgets: { counters: { counter: string; used: number }[] } };
    expect(st.state).toBe('SUCCEEDED');
    expect(st.budgets.counters.find((c) => c.counter === 'implementation_attempts')?.used).toBe(1);
  });

  it('streams machine-readable events with --json', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const r = await cli(l, ['run', '--goal', GOAL, '--foreground', '--json', '--policy', l.configPath]);
    expect(r.code, r.err).toBe(0);
    const lines = r.out.trim().split('\n').map((x) => JSON.parse(x) as { type: string; state?: string; exit_code?: number; to_state?: string });
    expect(lines[0]).toMatchObject({ type: 'started' });
    expect(lines.some((x) => x.type === 'event' && x.to_state === 'SUCCEEDED')).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: 'result', state: 'SUCCEEDED', exit_code: 0 });
  });

  it('treats Ctrl-C as a pause, not a cancellation, and resumes where it stopped', async () => {
    const l = lab();
    // The first implementation takes a while, so the run is mid-worker when the interrupt arrives.
    writeScenario(l, baseScenario({ implementer: [{ ...(implementMul('*') as object), sleepMs: 2_500 }] }));
    const signals = new EventEmitter();
    const started = cli(l, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath], { seams: seams(l, { signals }) });
    const id = await waitFor(() => listRuns(l.db(), { limit: 1 })[0]?.id);
    await waitFor(() => listWorkers(l.db(), { runId: id, role: 'implementer' }).find((w) => w.state === 'RUNNING'));
    signals.emit('SIGINT');
    const r = await started;
    expect(r.code, `${r.out}\n${r.err}`).toBe(20);
    expect(r.err).toMatch(/pausing the run \(not cancelling it\)/);
    expect(r.out).toMatch(/is IMPLEMENTING and paused; continue with "orbit resume/);
    const paused = getRun(l.db(), id);
    expect(paused).toMatchObject({ state: 'IMPLEMENTING', paused: true, cancelRequested: false });
    // The worker is detached: it is still there for the next controller to collect.
    expect(listWorkers(l.db(), { runId: id, role: 'implementer' }).length).toBe(1);

    const resumed = await cli(l, ['resume', id, '--foreground', '--policy', l.configPath]);
    expect(resumed.code, `${resumed.out}\n${resumed.err}`).toBe(0);
    expect(resumed.out).toMatch(/unpaused/);
    expect(resumed.out).toMatch(/-> SUCCEEDED/);
    expect(getRun(l.db(), id).state).toBe('SUCCEEDED');
    // One implementation attempt in total: resuming reattached to the worker instead of starting another.
    expect(listWorkers(l.db(), { runId: id, role: 'implementer' })).toHaveLength(1);
  }, 120_000);

  it('ends the foreground session when the run is paused from another terminal', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [{ ...(implementMul('*') as object), sleepMs: 2_000 }] }));
    const started = cli(l, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath]);
    const id = await waitFor(() => listRuns(l.db(), { limit: 1 })[0]?.id);
    await waitFor(() => listWorkers(l.db(), { runId: id, role: 'implementer' }).find((w) => w.state === 'RUNNING'));
    expect((await cli(l, ['pause', id])).code).toBe(0);
    const r = await started;
    expect(r.code).toBe(20);
    expect(getRun(l.db(), id).paused).toBe(true);
    // Leave nothing running behind the test.
    expect((await cli(l, ['cancel', id])).code).toBe(0);
  }, 120_000);

  it('reports a blocked run with the way forward and a distinct exit code', async () => {
    const l = lab({ tweak: (c) => void (c.scope.allowed_paths = ['docs/**']) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const r = await cli(l, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath]);
    // Planning proposes paths outside the policy's scope, so the run cannot proceed under its authority.
    expect(r.code, r.out).toBe(10);
    expect(r.out).toMatch(/ended BLOCKED/);
    // The scope is in the run's frozen policy, so resuming cannot help: the way forward is a new run (P12, P17).
    expect(r.out).toMatch(/frozen policy: fix \.orbit\/config\.yaml, then "orbit cancel orb-[^"]+" and start a new run/);
    expect(r.out).not.toMatch(/resolve the reason above, then "orbit resume/);
    expect(r.out).toMatch(/report: orbit report orb-/);
  });
});

describe('orbit run from a linked worktree (#3)', () => {
  it('runs in the worktree, creates its worker worktrees from it, and leaves the dirty main working tree alone', async () => {
    const l = lab({ tweak: (c) => void (c.repository.base_branch = 'feature') });
    // A clean linked worktree nested inside the main working tree, which is on another branch and dirty.
    const wt = join(l.repo, '.claude', 'worktrees', 'wt');
    labGit(l.repo, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
    labGit(l.repo, 'checkout', '-q', '-b', 'busy');
    writeFileSync(join(l.repo, 'README.md'), '# acme, edited\n');
    writeFileSync(join(l.repo, 'notes.txt'), 'scratch\n');
    const mainStatus = labGit(l.repo, 'status', '--porcelain');
    let db: ReturnType<Lab['db']> | null = null;
    const w: Lab = {
      ...l,
      repo: wt,
      db() {
        db ??= openDb(stateDbPath(wt));
        return db;
      },
      close() {
        db?.close();
      },
    };
    labs.push(w);
    writeScenario(w, baseScenario({ implementer: [implementMul('*')] }));
    const r = await cli(w, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    const id = /^run (orb-\S+) started/m.exec(r.out)?.[1];
    const run = getRun(w.db(), id!);
    expect(run.state).toBe('SUCCEEDED');
    expect(run.repoRoot).toBe(wt);
    // The implementer worked in a checkout added from the linked worktree, kept under the worktree's own key.
    expect(run.worktreePath).toBe(join(l.orbitHome, 'worktrees', repoKey(wt), id!, 'implementer'));
    expect(existsSync(join(wt, '.orbit', 'runs', id!, 'final.md'))).toBe(true);
    expect(existsSync(join(l.repo, '.orbit'))).toBe(false);
    expect(labGit(l.repo, 'branch', '--show-current')).toBe('busy');
    expect(labGit(l.repo, 'status', '--porcelain')).toBe(mainStatus);
    expect(labGit(wt, 'branch', '--show-current')).toBe('feature');
    // The candidate is a commit on the base the worktree was on, and the finished run released its worker checkouts.
    const cand = labGit(wt, 'for-each-ref', '--format=%(refname)', `refs/orbit/${id}/`);
    expect(cand).toMatch(/candidates/);
    expect(labGit(wt, 'worktree', 'list', '--porcelain')).not.toContain(join(l.orbitHome, 'worktrees'));
  });
});

describe('orbit run: starting', () => {
  it('rejects an invalid policy before any state exists', async () => {
    const l = lab();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(l.repo, '.orbit'), { recursive: true });
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), 'version: 1\nmode: sideways\nunknown_key: true\n');
    const r = await cli(l, ['run', '--goal', GOAL, '--foreground']);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/mode/);
    expect(existsSync(join(l.repo, '.orbit', 'state.sqlite'))).toBe(false);
  });

  it('points at orbit init when there is no config', async () => {
    const l = lab();
    const r = await cli(l, ['run', '--goal', GOAL, '--detach']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/orbit init/);
  });

  it('hands the run to the service with --detach and warns when none is running', async () => {
    const l = lab();
    const r = await cli(l, ['run', '--goal', GOAL, '--detach', '--policy', l.configPath, '--mode', 'supervised', '--json']);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { run_id: string; state: string; mode: string; detached: boolean; service_running: boolean };
    expect(j).toMatchObject({ state: 'CREATED', mode: 'supervised', detached: true, service_running: false });
    const run = getRun(l.db(), j.run_id);
    expect(run.mode).toBe('supervised');
    // The policy is frozen before the run exists, and the frozen file is read-only.
    expect(existsSync(run.policyPath)).toBe(true);
    const text = await cli(l, ['run', '--goal', 'another goal', '--detach', '--policy', l.configPath]);
    expect(text.err).toMatch(/no service is running/);
    expect(text.out).toMatch(/handed to the service/);
  });

  it('defaults to detaching when a live service controller is registered', async () => {
    const l = lab();
    const db = l.db();
    registerController(db, { id: 'svc-1', pid: process.pid, host: (await import('node:os')).hostname(), procStart: null, mode: 'service' }, systemClock);
    const r = await cli(l, ['run', '--goal', GOAL, '--policy', l.configPath, '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ detached: true, service_running: true });
    expect(r.err).toBe('');
  });

  it('reads the goal from standard input', async () => {
    const l = lab();
    const io = memoryIo(`${GOAL}\n`);
    const code = await main(['run', '--goal', '-', '--detach', '--policy', l.configPath, '--json'], { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome }, user: 'alice', seams: seams(l) });
    expect(code).toBe(0);
    const { run_id } = JSON.parse(io.stdout) as { run_id: string };
    expect(getRun(l.db(), run_id).goal).toBe(GOAL);
    expect(readFileSync(getRun(l.db(), run_id).policyPath, 'utf8')).toContain('"schema": "orbit.policy/1"');
  });
});
