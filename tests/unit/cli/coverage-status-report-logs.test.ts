/** `orbit status`, `orbit report` and `orbit logs`: rendering, fallbacks and the follow loop. */
import { EventEmitter } from 'node:events';
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRunStatus, renderRunStatus, requireRun, type RunStatus } from '../../../src/cli/commands/status.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { acquireLease, getRun, listRuns } from '../../../src/controller/run-store.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { BudgetLedger } from '../../../src/scheduling/budget.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { registerController } from '../../../src/storage/controllers.ts';
import { planWorker } from '../../../src/storage/workers.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await sleep(5);
  }
}

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
function status(over: Partial<RunStatus> = {}): RunStatus {
  return {
    id: 'orb-1',
    goal: 'Add a mul function',
    mode: 'autonomous',
    state: 'PLANNING',
    stage: 'PLANNING',
    paused: false,
    cancel_requested: false,
    outcome_reason: null,
    branch: null,
    candidate_ref: null,
    difficulty: null,
    created_at: NOW - 3_600_000,
    started_at: null,
    ended_at: null,
    last_progress_at: null,
    last_event: null,
    owner: null,
    heartbeat: null,
    budgets: null,
    workers: { active: [], counts: {} },
    questions: { open: [], answered: 0 },
    ...over,
  };
}

describe('renderRunStatus', () => {
  it('shows a quiet run: no flags, no owner, no heartbeat, no budgets, no workers, no questions', () => {
    expect(renderRunStatus(status(), NOW)).toBe(
      [
        'run orb-1  PLANNING',
        'goal:      Add a mul function',
        'mode:      autonomous',
        'stage:     PLANNING',
        'progress:  last progress never',
        'owner:     none (no controller currently owns this run)',
        'heartbeat: no controller is running (start one with "orbit service run" or "orbit resume <run-id> --foreground")',
        'budgets:   not initialized yet (the run has not reached planning)',
        'workers:   0 active',
        'questions: 0 open, 0 answered',
        '',
      ].join('\n'),
    );
  });

  it('shows flags, the outcome, difficulty and branch, and the last event with or without a target state', () => {
    const out = renderRunStatus(
      status({ paused: true, cancel_requested: true, outcome_reason: 'out of budget', difficulty: 'complex', branch: 'orbit/x', state: 'BLOCKED', last_progress_at: NOW - 5_000, last_event: { type: 'state.transition', at: NOW - 120_000, to_state: 'BLOCKED' } }),
      NOW,
    );
    expect(out).toContain('run orb-1  BLOCKED  (paused, cancel requested)\n');
    expect(out).toContain('mode:      autonomous   difficulty: complex   branch: orbit/x\n');
    expect(out).toContain('outcome:   out of budget\n');
    expect(out).toContain('progress:  last progress 5s ago; last event state.transition -> BLOCKED 2m ago\n');
    const noTarget = renderRunStatus(status({ paused: true, last_event: { type: 'run.paused', at: NOW - 1000, to_state: null } }), NOW);
    expect(noTarget).toContain('(paused)\n');
    expect(noTarget).toContain('last event run.paused 1s ago\n');
    expect(renderRunStatus(status({ cancel_requested: true }), NOW)).toContain('PLANNING  (cancel requested)\n');
  });

  it('shows who owns the run and whether the heartbeat is live or stale', () => {
    const owned = renderRunStatus(
      status({
        owner: { owner_id: 'ctl-1', lease_expires_at: NOW + 60_000 },
        heartbeat: { controller_id: 'ctl-1', mode: 'service', heartbeat_at: NOW - 2000, age_ms: 2000, live: true, last_progress_at: NOW - 30_000 },
      }),
      NOW,
    );
    expect(owned).toContain('owner:     ctl-1 (lease until 2026-10-05T12:01:00.000Z)\n');
    expect(owned).toContain('heartbeat: service controller ctl-1 2s ago (live), last progress 30s ago\n');
    const stale = renderRunStatus(status({ heartbeat: { controller_id: 'ctl-2', mode: 'foreground', heartbeat_at: NOW - 600_000, age_ms: 600_000, live: false, last_progress_at: null } }), NOW);
    expect(stale).toContain('foreground controller ctl-2 10m ago (STALE), last progress never');
  });

  it('formats the budgets by kind, with the reserve and the cost note, and marks unverified counters', () => {
    const counters = [
      { counter: 'implementation_attempts', used: 1, allowance: 4, hard_cap: 12, remaining: 3 },
      { counter: 'cost_usd', used: 1.5, allowance: 10, hard_cap: 30, remaining: 8.5 },
      { counter: 'wall_ms', used: 90_000, allowance: 600_000, hard_cap: 7_200_000, remaining: 510_000 },
    ];
    const verified = renderRunStatus(
      status({ budgets: { counters, sessions: [], reserve: { cost_usd: 2, wall_ms: 300_000 } as never, cost_measurement: { note: 'estimated from token counts' } as never, verified_policy: true } }),
      NOW,
    );
    expect(verified).toContain('budgets:\n');
    expect(verified).toMatch(/ {2}implementation_attempts {2,}1 used \/ 4 allowed \(hard cap 12\)\n/);
    expect(verified).toMatch(/ {2}cost_usd {2,}\$1\.50 used \/ \$10\.00 allowed \(hard cap \$30\.00\)\n/);
    expect(verified).toMatch(/ {2}wall_ms {2,}1\.5m used \/ 10\.0m allowed \(hard cap 120\.0m\)\n/);
    expect(verified).toContain('  final reserve: $2.00 and 5.0m held back\n');
    expect(verified).toContain('  cost: estimated from token counts\n');
    const unverified = renderRunStatus(status({ budgets: { counters, sessions: [], reserve: null, cost_measurement: null, verified_policy: false } }), NOW);
    expect(unverified).toContain('budgets (policy snapshot did not verify; stored counters shown):\n');
    expect(unverified).not.toContain('final reserve');
    expect(unverified).not.toContain('  cost:');
  });

  it('lists active workers with their provider and model, and what is waiting on an answer', () => {
    const out = renderRunStatus(
      status({
        workers: {
          active: [
            { id: 'w1', role: 'planner', provider: 'claude', model: 'sonnet', state: 'RUNNING', spawned_at: NOW - 61_000 },
            { id: 'w2', role: 'implementer', provider: 'codex', model: null, state: 'PLANNED', spawned_at: null },
          ],
          counts: { RUNNING: 1, PLANNED: 1, FAILED: 2 },
        },
        questions: {
          open: [
            { id: 'q1', question: 'Round\nthe result?', material: true, affected: ['AC-1'] },
            { id: 'q2', question: 'Name it?', material: false, affected: [] },
          ],
          answered: 3,
        },
      }),
      NOW,
    );
    expect(out).toContain('workers:   2 active (all: 1 running, 1 planned, 2 failed)\n');
    expect(out).toContain('  w1  planner  claude/sonnet  RUNNING  started 61s ago\n');
    expect(out).toContain('  w2  implementer  codex/default  PLANNED\n');
    expect(out).toContain('questions: 2 open, 3 answered\n');
    expect(out).toContain('  q1  [material]  Round the result?\n');
    expect(out).toContain('  q2  Name it?\n');
    expect(out).toContain('  answer with: orbit decide orb-1 <question-id> <answer>\n');
  });
});

describe('buildRunStatus', () => {
  it('names the stage an interrupted run will return to, only for the interrupted states', () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'CONTRACTING', 'BLOCKED']);
    const blocked = buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), run.id));
    expect(blocked.stage).toBe('BLOCKED (will return to CONTRACTING)');
    expect(blocked.state).toBe('BLOCKED');
    const active = getRun(l.db(), run.id);
    expect(buildRunStatus({ clock: systemClock }, l.db(), { ...active, state: 'IMPLEMENTING', resumeState: 'CONTRACTING' }).stage).toBe('IMPLEMENTING');
    expect(buildRunStatus({ clock: systemClock }, l.db(), { ...active, resumeState: null }).stage).toBe('BLOCKED');
    expect(buildRunStatus({ clock: systemClock }, l.db(), { ...active, state: 'INQUISITION', resumeState: 'PLANNING' }).stage).toBe('INQUISITION (will return to PLANNING)');
    expect(buildRunStatus({ clock: systemClock }, l.db(), { ...active, state: 'RECOVERING', resumeState: 'PLANNING' }).stage).toBe('RECOVERING (will return to PLANNING)');
  });

  it('shows the heartbeat of the controller that owns the run, or else of any live controller, or none', () => {
    const l = lab();
    const run = l.newRun();
    const db = l.db();
    expect(buildRunStatus({ clock: systemClock }, db, getRun(db, run.id)).heartbeat).toBeNull();
    registerController(db, { id: 'ctl-other', pid: process.pid, host: hostname(), mode: 'service' }, systemClock);
    const other = buildRunStatus({ clock: systemClock }, db, getRun(db, run.id));
    expect(other.owner).toBeNull();
    expect(other.heartbeat).toMatchObject({ controller_id: 'ctl-other', mode: 'service', live: true });
    registerController(db, { id: 'ctl-owner', pid: process.pid, host: hostname(), mode: 'foreground' }, systemClock);
    acquireLease(db, run.id, 'ctl-owner', 60_000, systemClock);
    const owned = buildRunStatus({ clock: systemClock }, db, getRun(db, run.id));
    expect(owned.owner?.owner_id).toBe('ctl-owner');
    expect(owned.heartbeat?.controller_id).toBe('ctl-owner');
    // A lease held by something that is not a registered controller still counts as an owner.
    const l2 = lab();
    const r2 = l2.newRun();
    acquireLease(l2.db(), r2.id, 'cli-xyz', 60_000, systemClock);
    expect(buildRunStatus({ clock: systemClock }, l2.db(), getRun(l2.db(), r2.id))).toMatchObject({ owner: { owner_id: 'cli-xyz' }, heartbeat: null });
  });

  it('reads verified budgets from the ledger, and falls back to the stored counters when the snapshot is gone', () => {
    const l = lab();
    const run = l.newRun();
    new BudgetLedger(l.db(), systemClock).init(run.id, verifySnapshot(run.policyPath, run.policyHash), 'medium');
    const ok = buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), run.id));
    expect(ok.budgets?.verified_policy).toBe(true);
    expect(ok.budgets?.counters.length).toBeGreaterThan(0);
    expect(ok.budgets?.reserve).not.toBeNull();
    chmodSync(run.policyPath, 0o644);
    writeFileSync(run.policyPath, '{}');
    const bad = buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), run.id));
    expect(bad.budgets).toMatchObject({ verified_policy: false, reserve: null, cost_measurement: null });
    expect(bad.budgets?.counters.some((c) => c.counter === 'implementation_attempts' && c.remaining === Math.max(0, c.allowance - c.used))).toBe(true);
    l.db().run("INSERT INTO budget_counters (run_id, counter, used, allowance, hard_cap) VALUES (?, 'turns:s1', 9, 5, 20)", run.id);
    const withSession = buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), run.id));
    expect(withSession.budgets?.sessions).toEqual([{ counter: 'turns:s1', used: 9, allowance: 5, hard_cap: 20, remaining: 0 }]);
    expect(withSession.budgets?.counters.every((c) => !c.counter.includes(':'))).toBe(true);
  });

  it('counts workers by state, lists the active ones, and counts questions', () => {
    const l = lab();
    const run = l.newRun();
    planWorker(l.db(), { id: 'w-a', runId: run.id, role: 'planner', provider: 'claude', workerDir: '/w', cwd: '/c' }, systemClock);
    planWorker(l.db(), { id: 'w-b', runId: run.id, role: 'implementer', provider: 'codex', model: 'gpt-x', workerDir: '/w2', cwd: '/c' }, systemClock);
    l.db().run("UPDATE workers SET state = 'FAILED' WHERE id = 'w-b'");
    const q1 = l.ask(run.id);
    l.ask(run.id);
    l.db().run("UPDATE questions SET status = 'answered' WHERE id = ?", q1.id);
    const s = buildRunStatus({ clock: systemClock }, l.db(), getRun(l.db(), run.id));
    expect(s.workers.counts).toEqual({ PLANNED: 1, FAILED: 1 });
    expect(s.workers.active.map((w) => w.id)).toEqual(['w-a']);
    expect(s.questions).toMatchObject({ answered: 1 });
    expect(s.questions.open).toHaveLength(1);
    expect(s.last_event).not.toBeNull();
  });
});

describe('orbit status', () => {
  it('lists runs with their flags and the live controllers; --all lifts the limit of ten', async () => {
    const l = lab();
    for (let i = 0; i < 12; i++) l.newRun(`goal number ${i}`);
    const [first] = listRuns(l.db(), { limit: 1 });
    await l.cli(['pause', first!.id]);
    const cancelling = l.newRun('being cancelled');
    l.db().run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', cancelling.id);
    registerController(l.db(), { id: 'svc-1', pid: process.pid, host: hostname(), mode: 'service' }, systemClock);
    const r = await l.cli(['status']);
    expect(r.out.split('\n')[0]).toMatch(/^RUN\s+STATE\s+MODE\s+/);
    expect(r.out).toContain('CREATED (cancelling)');
    expect(r.out.trim().split('\n').filter((x) => x.startsWith('orb-'))).toHaveLength(10);
    expect(r.out).toMatch(new RegExp(`controllers: service pid ${process.pid} \\(heartbeat \\d+s ago\\)\\n$`));
    const all = await l.cli(['status', '--all']);
    expect(all.out.trim().split('\n').filter((x) => x.startsWith('orb-'))).toHaveLength(13);
    expect(all.out).toContain('CREATED (paused)');
    const j = JSON.parse((await l.cli(['status', '--json'])).out) as { runs: Array<{ paused: boolean; cancel_requested: boolean }>; controllers: Array<{ id: string; live: boolean; pid: number }> };
    expect(j.runs.some((x) => x.paused)).toBe(true);
    expect(j.runs.some((x) => x.cancel_requested)).toBe(true);
    expect(j.controllers).toMatchObject([{ id: 'svc-1', live: true, pid: process.pid }]);
  });

  it('says there are no runs yet when the state exists but is empty', async () => {
    const l = lab();
    l.db();
    const r = await l.cli(['status']);
    expect(r.out).toBe('no runs yet; start one with: orbit run --goal "..."\ncontrollers: none running\n');
  });

  it('prints one run as text with the status block', async () => {
    const l = lab();
    const run = l.newRun('Add a mul function.');
    const r = await l.cli(['status', run.id]);
    expect(r.out).toContain(`run ${run.id}  CREATED\n`);
    expect(r.out).toContain('goal:      Add a mul function.\n');
  });

  it('requireRun needs an id, and finds a run by it', () => {
    const l = lab();
    const run = l.newRun();
    expect(() => requireRun(l.db(), undefined)).toThrow('a run id is required');
    expect(() => requireRun(l.db(), '')).toThrow('a run id is required');
    expect(requireRun(l.db(), run.id).id).toBe(run.id);
  });
});

describe('orbit report', () => {
  it('rebuilds a finished run\'s report as JSON when final.json is missing, and as text with a banner when final.md is', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT', 'CANCELLED']);
    const runDir = dirname(run.policyPath);
    writeFileSync(join(runDir, 'final.md'), '# written by the controller\n');
    expect((await l.cli(['report', run.id])).out).toBe('# written by the controller\n');
    const j = await l.cli(['report', run.id, '--json']);
    expect(j.code, j.err).toBe(0);
    expect(JSON.parse(j.out)).toMatchObject({ outcome: 'CANCELLED', run_id: run.id });
    // --interim ignores what is on disk.
    const interim = await l.cli(['report', run.id, '--interim']);
    expect(interim.out).toMatch(/^> Report rebuilt from current records \(no final\.md was found for this CANCELLED run\)\.\n\n/);
    rmSync(join(runDir, 'final.md'));
    const nofinal = await l.cli(['report', run.id]);
    expect(nofinal.out).toMatch(/^> Report rebuilt from current records \(no final\.md was found for this CANCELLED run\)\./);
    const rebuilt = JSON.parse((await l.cli(['report', run.id, '--json'])).out) as { interim: boolean };
    expect(rebuilt.interim).toBe(false);
  });

  it('says a running report is paused when it is, and still builds one when the policy snapshot no longer verifies', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['PREFLIGHT']);
    await l.cli(['pause', run.id]);
    chmodSync(run.policyPath, 0o644);
    writeFileSync(run.policyPath, '{}');
    const r = await l.cli(['report', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^> INTERIM report: the run is PREFLIGHT \(paused\) and nothing below is final\. It is not saved to disk\.\n\n/);
  });

  it('needs one run id unless --learning is given', async () => {
    const l = lab();
    l.db();
    expect((await l.cli(['report'])).err).toContain('expected 1 argument(s), got 0');
    expect((await l.cli(['report', 'a', 'b'])).code).toBe(2);
  });
});

describe('orbit report --learning', () => {
  function finished(l: Lab, goal: string, state: string, createdAt: number) {
    const run = l.newRun(goal);
    l.db().run('UPDATE runs SET state = ?, created_at = ? WHERE id = ?', state, createdAt, run.id);
    return run;
  }
  const overlay = (id: string, role: string, version: number, status: string, activatedAt: string | null) => ({ id, role, scope: 'repo' as const, version, content: 'be careful', lesson_ids: [], status: status as never, parent_id: null, eval: null, created_at: '2026-01-01T00:00:00.000Z', activated_at: activatedAt });

  it('groups finished runs by the implementer overlay in force, with attempts and cost per accepted run', async () => {
    const l = lab();
    const before = l.newRun('before the overlay');
    const failed = l.newRun('failed before');
    const after = l.newRun('after the overlay');
    for (const [run, n] of [[before, 2], [after, 1]] as const) {
      for (let i = 0; i < n; i++) planWorker(l.db(), { id: `${run.id}-impl-${i}`, runId: run.id, role: 'implementer', provider: 'claude', workerDir: '/w', cwd: '/c' }, systemClock);
    }
    for (const [run, state, at] of [[before, 'SUCCEEDED', '2026-02-01'], [failed, 'EXHAUSTED', '2026-02-02'], [after, 'SUCCEEDED', '2026-04-01']] as const) {
      l.db().run('UPDATE runs SET state = ?, created_at = ? WHERE id = ?', state, Date.parse(`${at}T00:00:00Z`), run.id);
    }
    finished(l, 'still running', 'IMPLEMENTING', Date.parse('2026-04-02T00:00:00Z'));
    l.db().run("INSERT INTO usage (run_id, provider, cost_usd, cost_source, ts) VALUES (?, 'claude', 1.5, 'reported', 1)", before.id);
    l.db().run("INSERT INTO usage (run_id, provider, cost_usd, cost_source, ts) VALUES (?, 'claude', NULL, 'unknown', 1)", after.id);
    l.db().run("INSERT INTO usage (run_id, provider, cost_usd, cost_source, ts) VALUES (?, 'claude', 0.5, 'reported', 2)", after.id);
    mkdirSync(join(l.repo, '.orbit'), { recursive: true });
    const store = KnowledgeStore.open(join(l.repo, '.orbit', 'knowledge.sqlite'), { clock: systemClock });
    store.insertOverlay(overlay('ov-late', 'implementer', 2, 'active', '2026-03-01T00:00:00.000Z'));
    store.insertOverlay(overlay('ov-early', 'implementer', 1, 'retired', '2026-02-15T00:00:00.000Z'));
    store.insertOverlay(overlay('ov-planner', 'planner', 1, 'active', '2026-03-15T00:00:00.000Z'));
    store.insertOverlay(overlay('ov-draft', 'implementer', 3, 'candidate', null));
    store.close();

    const j = JSON.parse((await l.cli(['report', '--learning', '--json'])).out) as { windows: Array<Record<string, unknown>>; overlays: Array<{ id: string }> };
    expect(j.overlays.map((o) => o.id).sort()).toEqual(['ov-draft', 'ov-early', 'ov-late', 'ov-planner']);
    expect(j.windows).toEqual([
      { window: 'base prompt', runs: 2, accepted: 1, pass_rate: 0.5, mean_attempts_per_accepted: 2, cost_per_accepted_usd: 1.5, cost_complete: true },
      // Windows follow the order the overlays were activated in, whatever order they were stored in.
      { window: 'implementer overlay v1', runs: 0, accepted: 0, pass_rate: null, mean_attempts_per_accepted: null, cost_per_accepted_usd: null, cost_complete: true },
      { window: 'implementer overlay v2', runs: 1, accepted: 1, pass_rate: 1, mean_attempts_per_accepted: 1, cost_per_accepted_usd: 0.5, cost_complete: false },
    ]);
    const text = await l.cli(['report', '--learning']);
    expect(text.out).toContain('Learning report: finished runs');
    expect(text.out).toMatch(/base prompt\s+2\s+1\s+50%\s+2\.0\s+\$1\.50\n/);
    expect(text.out).toMatch(/implementer overlay v2\s+1\s+1\s+100%\s+1\.0\s+\$0\.50 \(partial\)/);
    expect(text.out).toMatch(/OVERLAY\s+ROLE\s+VERSION\s+STATUS\n/);
    expect(text.out).toMatch(/ov-late\s+implementer\s+v2\s+active/);
    expect(text.out).not.toContain('nothing to compare');
    expect(failed.id).toBeTruthy();
  });

  it('shows dashes where there is nothing to average and says so when no run has finished', async () => {
    const l = lab();
    l.db();
    const r = await l.cli(['report', '--learning']);
    expect(r.out).toMatch(/base prompt\s+0\s+0\s+-\s+-\s+-/);
    expect(r.out).toContain('\nNo finished runs yet, so there is nothing to compare.\n');
    expect(r.out).not.toContain('OVERLAY');
    const j = JSON.parse((await l.cli(['report', '--learning', '--json'])).out) as { windows: Array<{ pass_rate: number | null }>; overlays: unknown[] };
    expect(j.windows[0]!.pass_rate).toBeNull();
    expect(j.overlays).toEqual([]);
  });
});

describe('orbit logs', () => {
  const controllerLog = (l: Lab) => join(l.orbitHome, 'logs', 'controller.jsonl');
  const entry = (run: string | null, msg: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ ts: '2026-01-01T10:20:30.000Z', level: 'info', msg, ...(run ? { run_id: run } : {}), ...extra })}\n`;

  it('shows only the end of a very large log, never starting in the middle of a line', async () => {
    const l = lab();
    const run = l.newRun();
    mkdirSync(dirname(controllerLog(l)), { recursive: true });
    const pad = 'x'.repeat(200);
    const lines = Array.from({ length: 4000 }, (_, i) => entry(run.id, `line ${i}`, { pad })).join('');
    writeFileSync(controllerLog(l), lines);
    const r = await l.cli(['logs', run.id, '--lines', '100000']);
    const out = r.out.trim().split('\n');
    expect(out.length).toBeLessThan(4000);
    expect(out.length).toBeGreaterThan(1000);
    expect(out.every((x) => /^\[10:20:30\] info {2}line \d+/.test(x))).toBe(true);
    expect(out.at(-1)).toMatch(/line 3999/);
    const first = Number(/line (\d+)/.exec(out[0]!)![1]);
    expect(first).toBeGreaterThan(0);
    expect(out).toHaveLength(4000 - first);
  });

  it('prints nothing for --lines 0 and does not claim there are no logs', async () => {
    const l = lab();
    const run = l.newRun();
    mkdirSync(dirname(controllerLog(l)), { recursive: true });
    writeFileSync(controllerLog(l), entry(run.id, 'hello'));
    const r = await l.cli(['logs', run.id, '--lines', '0']);
    expect(r).toMatchObject({ code: 0, out: '', err: '' });
  });

  it('--controller leaves out the worker logs, and the run\'s own controller log is shown whole', async () => {
    const l = lab();
    const run = l.newRun();
    const dir = join(l.base, 'workers', 'w1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'log.jsonl'), '{"type":"system"}\n');
    planWorker(l.db(), { id: 'w1', runId: run.id, role: 'planner', provider: 'claude', workerDir: dir, cwd: dir }, systemClock);
    const own = join(dirname(run.policyPath), 'logs', 'controller.jsonl');
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, `${entry('another-run', 'in the run dir')}plain text line\n${JSON.stringify({ note: 'no standard fields' })}\n${JSON.stringify({ ts: 5, level: 'warn', msg: 'odd timestamp', n: 1, obj: { a: 1 } })}\n`);
    const r = await l.cli(['logs', run.id, '--controller']);
    expect(r.out).toContain('[10:20:30] info  in the run dir\n');
    expect(r.out).toContain('plain text line\n');
    expect(r.out).toContain('[--:--:--] info    note=no standard fields\n');
    expect(r.out).toContain('[--:--:--] warn  odd timestamp  n=1 obj={"a":1}\n');
    expect(r.out).not.toContain('[w1]');
    const workersOnly = await l.cli(['logs', run.id, '--workers']);
    expect(workersOnly.out).toBe('[w1] {"type":"system"}\n');
    const other = await l.cli(['logs', run.id, '--worker', 'nope']);
    expect(other.err).toContain('no logs found for run');
  });

  it('follows new lines as they are written: whole lines only, only this run\'s, and again from the top after a truncation', async () => {
    const l = lab();
    const run = l.newRun();
    mkdirSync(dirname(controllerLog(l)), { recursive: true });
    writeFileSync(controllerLog(l), entry(run.id, 'first'));
    const signals = new EventEmitter();
    const done = l.cli(['logs', run.id, '--follow'], { seams: { pollMs: 10, signals } });
    await until(() => signals.listenerCount('SIGINT') === 1);
    appendFileSync(controllerLog(l), entry('someone-else', 'not mine'));
    appendFileSync(controllerLog(l), `{"ts":"2026-01-01T10:20:31.000Z","level":"info","run_id":"${run.id}","msg":"par`);
    await sleep(80);
    appendFileSync(controllerLog(l), 'tial"}\n');
    await sleep(80);
    writeFileSync(controllerLog(l), entry(run.id, 'after truncation'));
    await sleep(80);
    signals.emit('SIGINT');
    const r = await done;
    expect(r.code).toBe(0);
    const lines = r.out.trim().split('\n');
    expect(lines).toEqual(['[10:20:30] info  first', '[10:20:31] info  partial', '[10:20:30] info  after truncation']);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('picks up a worker log that appears while following, and SIGTERM stops it too', async () => {
    const l = lab();
    const run = l.newRun();
    const dir = join(l.base, 'workers', 'late');
    mkdirSync(dir, { recursive: true });
    planWorker(l.db(), { id: 'late', runId: run.id, role: 'planner', provider: 'claude', workerDir: dir, cwd: dir }, systemClock);
    const signals = new EventEmitter();
    const done = l.cli(['logs', run.id, '--follow', '--json'], { seams: { pollMs: 10, signals } });
    await until(() => signals.listenerCount('SIGTERM') === 1);
    writeFileSync(join(dir, 'log.jsonl'), '{"type":"assistant"}\n');
    await sleep(100);
    signals.emit('SIGTERM');
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out.trim())).toEqual({ source: 'late', line: '{"type":"assistant"}' });
  });

  it('after the run ends it prints what is left and stops, at the default polling pace', async () => {
    const l = lab();
    const run = l.newRun();
    l.moveTo(run.id, ['CANCELLED']);
    mkdirSync(dirname(controllerLog(l)), { recursive: true });
    writeFileSync(controllerLog(l), entry(run.id, 'last words'));
    const started = Date.now();
    const r = await l.cli(['logs', run.id, '--follow']);
    expect(r.out).toContain('last words');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
