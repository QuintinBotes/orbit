/** `orbit timeline`: one readable line per significant step of a run, built from its events, decisions and worker records. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { clockTime } from '../../../src/cli/io.ts';
import { buildTimeline } from '../../../src/observability/timeline.ts';
import { findRunByPrefix } from '../../../src/cli/context.ts';
import { COMMANDS } from '../../../src/cli/cli.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { recordDecision } from '../../../src/storage/decisions.ts';
import { makeLab, type Lab } from './lab.ts';
import { RUN_ID, T0, buildFullRun, startFixture, worker } from './timeline-fixture.ts';

const labs: Lab[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const at = (seconds: number): string => clockTime(T0 + seconds * 1000);
/** The printed line for a step: its local time, its category column and a fragment of its text. */
function line(out: string, seconds: number, category: string, fragment: string): string {
  const found = out.split('\n').find((l) => l.startsWith(`${at(seconds)}  ${category.padEnd(9)} `) && l.includes(fragment));
  if (!found) throw new Error(`no ${category} line at +${seconds}s containing ${JSON.stringify(fragment)} in:\n${out}`);
  return found;
}
const order = (out: string, fragments: string[]): void => {
  let last = -1;
  for (const f of fragments) {
    const i = out.indexOf(f, last + 1);
    expect(i, `${f} should come after the previous step`).toBeGreaterThan(last);
    last = i;
  }
};

describe('orbit timeline: the readable history of a run', () => {
  it('prints the header, then one line per step in the order they happened, each with its local time', async () => {
    const l = lab();
    buildFullRun(l);
    const r = await l.cli(['timeline', RUN_ID]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^run orb-timeline-1 {2}SUCCEEDED/);
    expect(r.out).toContain('goal:      Add a mul function to the calculator.');
    for (const l2 of r.out.split('\n').slice(2).filter((x) => /^\d\d:\d\d:\d\d /.test(x))) expect(l2).toMatch(/^\d\d:\d\d:\d\d {2}\S+ +\S/);
    order(r.out, [
      'run created',
      'CREATED -> PREFLIGHT',
      'PLANNING -> INQUISITION',
      'Should mul round its result?',
      'answered by alice',
      'attempt 1 started',
      'candidate 1 created',
      'unit-tests FAILED',
      'candidate 1 FAIL',
      'DIAGNOSING -> REPAIRING',
      'escalated',
      'attempt 2 started',
      'candidate 2 created',
      'unit-tests PASSED',
      'candidate 2 PASS',
      'round 1 APPROVE',
      'push_task_branch',
      'delivered commit2000000',
      'DELIVERING -> SUCCEEDED',
    ]);
  });

  it('shows each state transition with its reason', async () => {
    const l = lab();
    buildFullRun(l);
    const out = (await l.cli(['timeline', RUN_ID])).out;
    expect(line(out, 4, 'state', 'PLANNING -> INQUISITION: ambiguity: rounding of the product')).toBeTruthy();
    expect(line(out, 126, 'state', 'VERIFYING -> DIAGNOSING: verification FAIL on candidate 1: unit-tests')).toBeTruthy();
    expect(line(out, 234, 'state', 'DELIVERING -> SUCCEEDED: delivered and reviewed')).toBeTruthy();
  });

  it('shows a routing decision and an escalation with the evidence that justified it', async () => {
    const l = lab();
    buildFullRun(l);
    const out = (await l.cli(['timeline', RUN_ID])).out;
    const first = line(out, 71, 'route', 'implementation');
    expect(first).toContain('claude/claude-sonnet-4-6');
    expect(first).toContain('(high)');
    expect(first).toContain('implementation starts at the sonnet tier');
    expect(first).not.toContain('escalated');
    const esc = line(out, 129, 'route', 'escalated');
    expect(esc).toContain('claude/claude-sonnet-4-6 -> claude/claude-opus-4-8');
    expect(esc).toContain('repeated failure fingerprint fp-mul-undefined');
    expect(esc).toContain('evidence: chk:unit-tests, cand:1');
    expect(esc).toContain('repeated-failure (fp-mul-undefined seen twice)');
  });

  it('shows each attempt and candidate with its verification verdict, and every check result', async () => {
    const l = lab();
    buildFullRun(l);
    const out = (await l.cli(['timeline', RUN_ID])).out;
    expect(line(out, 72, 'attempt', 'attempt 1 started')).toContain('spend cap $2.00');
    expect(line(out, 114, 'candidate', 'candidate 1 created')).toContain('attempt 1');
    expect(line(out, 122, 'check', 'unit-tests FAILED')).toMatch(/\(exit 1\) on candidate 1 in 5s; fingerprint fp-mul-undefined/);
    expect(line(out, 125, 'verdict', 'candidate 1 FAIL')).toContain('failing checks: unit-tests');
    expect(line(out, 130, 'attempt', 'attempt 2 started')).toContain('spend cap $3.00');
    expect(line(out, 180, 'check', 'unit-tests PASSED')).toContain('on candidate 2');
    expect(line(out, 183, 'verdict', 'candidate 2 PASS')).not.toContain('failing');
  });

  it('shows the review outcome, the reviewer and the findings', async () => {
    const l = lab();
    buildFullRun(l);
    const out = (await l.cli(['timeline', RUN_ID])).out;
    const review = line(out, 226, 'review', 'round 1 APPROVE');
    expect(review).toContain('by codex/gpt-6.1-sol');
    expect(review).toContain('candidate 2');
    expect(review).toContain('1 finding: 1 low');
  });

  it('shows a question when it was asked and when it was answered, and by whom', async () => {
    const l = lab();
    buildFullRun(l);
    const out = (await l.cli(['timeline', RUN_ID])).out;
    const asked = line(out, 5, 'question', 'Should mul round its result?');
    expect(asked).toContain('[material]');
    expect(asked).toContain('affects AC-1');
    const answered = line(out, 65, 'question', 'answered by alice');
    expect(answered).toContain(': A');
  });

  it('shows the worker lifecycle with who ran it and how it ended', async () => {
    const l = lab();
    buildFullRun(l);
    const out = (await l.cli(['timeline', RUN_ID])).out;
    expect(line(out, 74, 'worker', 'w-impl-1')).toContain('implementer claude/claude-sonnet-4-6 started (attempt 1)');
    expect(line(out, 113, 'worker', 'w-impl-1')).toContain('SUCCEEDED after 39s (exit 0)');
    expect(line(out, 186, 'worker', 'w-rev-1')).toContain('reviewer codex/gpt-6.1-sol');
  });

  it('shows how a worker that failed ended: its status, exit code and error', async () => {
    const l = lab();
    const fx = startFixture(l);
    worker(fx, 'w-bad', 'implementer', 'claude', 'claude-sonnet-4-6', 1, 10, 'FAILED', null);
    const out = (await l.cli(['timeline', RUN_ID])).out;
    expect(line(out, 50, 'worker', 'w-bad')).toContain('FAILED after 39s (max_turns, exit 1): ran out of turns');
  });

  it('shows delivery actions with their outcome', async () => {
    const l = lab();
    buildFullRun(l);
    const out = (await l.cli(['timeline', RUN_ID])).out;
    expect(line(out, 228, 'delivery', 'push_task_branch')).toContain('intent recorded');
    expect(line(out, 229, 'delivery', 'push_task_branch')).toContain('executing (attempt 1)');
    expect(line(out, 232, 'delivery', 'push_task_branch')).toContain('succeeded');
    expect(line(out, 233, 'delivery', 'delivered commit2000000')).toContain('orbit/mul');
  });

  it('shows the cost so far as measured and as charged', async () => {
    const l = lab();
    buildFullRun(l);
    const out = (await l.cli(['timeline', RUN_ID])).out;
    expect(line(out, 113, 'cost', 'w-impl-1')).toContain('$0.12 reported');
    expect(line(out, 113, 'cost', 'w-impl-1')).toContain('measured so far $0.12');
    expect(line(out, 171, 'cost', 'w-impl-2')).toContain('no cost reported');
    expect(line(out, 171, 'cost', 'ceiling')).toContain('$1.00');
    const last = out.trimEnd().split('\n').at(-1)!;
    expect(last).toMatch(/^cost so far: measured \$0\.17 \(2 reported\); charged \$1\.17 to the cost budget/);
    expect(last).toContain('1 session with no reported cost');
  });

  it('prints events it has no special wording for rather than hiding them, and hides housekeeping unless asked', async () => {
    const l = lab();
    const fx = startFixture(l);
    fx.event('something.new', { hello: 'world', n: 3 }, 1);
    fx.event('progress', { kind: 'heartbeat' }, 2);
    const plain = (await l.cli(['timeline', RUN_ID])).out;
    expect(line(plain, 1, 'event', 'something.new')).toContain('hello=world n=3');
    expect(plain).not.toContain('progress');
    const all = (await l.cli(['timeline', RUN_ID, '--all'])).out;
    expect(line(all, 2, 'event', 'progress')).toBeTruthy();
    expect(all).toContain('lease.acquired');
  });

  it('says what a run with no history yet looks like', async () => {
    const l = lab();
    const run = l.newRun();
    const r = await l.cli(['timeline', run.id]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`run ${run.id}  CREATED`);
    expect(r.out).toContain('run created');
    expect(r.out).toContain('cost so far: no usage recorded yet');
  });

  it('redacts secrets in reasons, like every other command', async () => {
    const l = lab();
    const fx = startFixture(l);
    fx.at(1, () => fx.to('PREFLIGHT', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked'));
    const out = (await l.cli(['timeline', RUN_ID])).out;
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('shows a decision with no event of its own, and any other decision as kind and summary', async () => {
    const l = lab();
    const fx = startFixture(l);
    fx.at(3, () => recordDecision(fx.db, fx.runDir, { runId: RUN_ID, kind: 'policy.deny', summary: 'candidate 1 denied by scope inspection: touches package.json', data: {} }, fx.clock));
    // A row written by another tool, without the decision.recorded event.
    fx.db.run("INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES ('dec-orphan', ?, 'planning.difficulty', 'difficulty simple', NULL, ?)", RUN_ID, T0 + 4000);
    const out = (await l.cli(['timeline', RUN_ID])).out;
    expect(line(out, 3, 'policy', 'policy.deny')).toContain('candidate 1 denied by scope inspection');
    expect(line(out, 4, 'decision', 'planning.difficulty')).toContain('difficulty simple');
  });

  it('resolves a run by a unique prefix, and refuses an unknown run', async () => {
    const l = lab();
    buildFullRun(l);
    expect((await l.cli(['timeline', 'orb-timeline'])).code).toBe(0);
    const bad = await l.cli(['timeline', 'orb-nope-1']);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toMatch(/no run orb-nope-1/);
  });

  it('shows only the last n steps with --last, keeping the header and the cost line', async () => {
    const l = lab();
    buildFullRun(l);
    const out = (await l.cli(['timeline', RUN_ID, '--last', '3'])).out;
    expect(out).toMatch(/^run orb-timeline-1/);
    expect(out.split('\n').filter((x) => /^\d\d:\d\d:\d\d /.test(x))).toHaveLength(3);
    expect(out).toContain('DELIVERING -> SUCCEEDED');
    expect(out).not.toContain('PLANNING -> INQUISITION');
    expect(out).toContain('cost so far:');
  });
});

describe('orbit timeline --json', () => {
  it('prints the run, every entry in order with an ISO time and its structured data, and the cost', async () => {
    const l = lab();
    buildFullRun(l);
    const r = await l.cli(['timeline', RUN_ID, '--json']);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as {
      run: { id: string; state: string; goal: string };
      entries: { at: number; time: string; category: string; kind: string; text: string; event_id: number | null; data: Record<string, unknown> }[];
      cost: { measured_usd: number; estimated_usd: number; charged_usd: number | null; reported_records: number; unavailable_records: number; ceiling_charged_usd: number; note: string };
    };
    expect(j.run).toMatchObject({ id: RUN_ID, state: 'SUCCEEDED' });
    expect(j.entries.length).toBeGreaterThan(30);
    const times = j.entries.map((e) => e.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const e of j.entries) expect(e.time).toBe(new Date(e.at).toISOString());
    const esc = j.entries.find((e) => e.kind === 'route.escalation')!;
    expect(esc.category).toBe('route');
    expect(esc.data).toMatchObject({ model: 'claude-opus-4-8', escalated_from: { model: 'claude-sonnet-4-6' } });
    const review = j.entries.find((e) => e.kind === 'review.recorded')!;
    expect(review.data).toMatchObject({ verdict: 'APPROVE', provider: 'codex', model: 'gpt-6.1-sol', round: 1 });
    expect(j.entries.find((e) => e.kind === 'state.transition' && e.text.includes('DELIVERING -> SUCCEEDED'))).toBeTruthy();
    expect(j.cost).toMatchObject({ measured_usd: 0.17, estimated_usd: 0, charged_usd: 1.17, reported_records: 2, unavailable_records: 1, ceiling_charged_usd: 1 });
  });

  it('says the same thing as the text form: every entry text appears in it', async () => {
    const l = lab();
    buildFullRun(l);
    const j = JSON.parse((await l.cli(['timeline', RUN_ID, '--json'])).out) as { entries: { text: string }[] };
    const text = (await l.cli(['timeline', RUN_ID])).out;
    for (const e of j.entries) expect(text).toContain(e.text);
  });
});

describe('buildTimeline', () => {
  it('keeps the order events were written in even when a clock stepped back, and puts a usage record where it happened', () => {
    const l = lab();
    const fx = startFixture(l);
    fx.event('first.thing', {}, 10);
    // The clock steps back (NTP): the later event has the earlier time, but it is still later in the log.
    fx.db.tx(() => appendEvent(fx.db, RUN_ID, 'second.thing', 'controller', {}, T0 + 5_000));
    const t = buildTimeline(fx.db, getRun(fx.db, RUN_ID), {});
    const kinds = t.entries.map((e) => e.kind);
    expect(kinds.indexOf('first.thing')).toBeLessThan(kinds.indexOf('second.thing'));
  });

  it('gives every entry a stable key, so a follower can print only what is new', () => {
    const l = lab();
    const fx = buildFullRun(l);
    const run = getRun(fx.db, RUN_ID);
    const a = buildTimeline(fx.db, run, {});
    const b = buildTimeline(fx.db, run, {});
    expect(a.entries.map((e) => e.key)).toEqual(b.entries.map((e) => e.key));
    expect(new Set(a.entries.map((e) => e.key)).size).toBe(a.entries.length);
  });

  it('reports charged as null before the ledger has a cost counter', () => {
    const l = lab();
    const run = l.newRun();
    const t = buildTimeline(l.db(), findRunByPrefix(l.db(), run.id), {});
    expect(t.cost.charged_usd).toBeNull();
    expect(t.cost.note).toBe('no usage recorded yet');
  });
});

describe('orbit timeline --follow', () => {
  it('streams new steps of a running run as they are written, and stops once the run is over', async () => {
    const l = lab();
    const fx = startFixture(l);
    // Another process owns the run: leave the lease with the fixture's owner and write from here.
    const done = l.cli(['timeline', RUN_ID, '--follow'], { seams: { pollMs: 10 } });
    await new Promise((r) => setTimeout(r, 60));
    fx.at(1, () => fx.to('PREFLIGHT', 'starting'));
    await new Promise((r) => setTimeout(r, 60));
    fx.at(2, () => fx.to('CANCELLED', 'stopped by test'));
    const r = await done;
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('CREATED -> PREFLIGHT: starting');
    expect(r.out).toContain('PREFLIGHT -> CANCELLED: stopped by test');
    // Each step once, even though the whole history is re-read on every poll.
    expect(r.out.split('CREATED -> PREFLIGHT').length).toBe(2);
    expect(r.out.split('run created').length).toBe(2);
    expect(r.out).toContain('cost so far:');
  });

  it('prints one JSON object per line with --json, and stops on SIGINT', async () => {
    const l = lab();
    const fx = startFixture(l);
    fx.at(1, () => fx.to('PREFLIGHT', 'starting'));
    const handlers = new Map<string, () => void>();
    const signals = { on: (s: string, f: () => void) => void handlers.set(s, f), off: (s: string) => void handlers.delete(s) };
    const done = l.cli(['timeline', RUN_ID, '--follow', '--json'], { seams: { pollMs: 10, signals: signals as never } });
    await new Promise((r) => setTimeout(r, 60));
    handlers.get('SIGINT')?.();
    const r = await done;
    expect(r.code).toBe(0);
    const lines = r.out.trim().split('\n').map((x) => JSON.parse(x) as { kind: string });
    expect(lines.map((x) => x.kind)).toEqual(expect.arrayContaining(['run.created', 'state.transition']));
  });

  it('does not wait for a run that is already over', async () => {
    const l = lab();
    buildFullRun(l);
    const r = await l.cli(['timeline', RUN_ID, '--follow'], { seams: { pollMs: 10 } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('DELIVERING -> SUCCEEDED');
  });
});

describe('where the timeline is offered', () => {
  it('is a registered, read-only command that workers may run, and logs and status point to it', async () => {
    const def = COMMANDS.find((c) => c.name === 'timeline');
    expect(def?.usage).toMatch(/^orbit timeline <run-id>/);
    const l = lab();
    const help = (await l.cli(['logs', '--help'])).out;
    expect(help).toMatch(/orbit timeline/);
    const top = (await l.cli(['--help'])).out;
    expect(top).toMatch(/^ {2}timeline /m);
    // /orbit:status <run-id> points at it.
    const skill = readFileSync(new URL('../../../plugin/skills/status/SKILL.md', import.meta.url), 'utf8');
    expect(skill).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/orbit" timeline <run-id>');
    // A worker's shell may read it (it changes nothing), like status and logs.
    const run = l.newRun();
    const r = await l.cli(['timeline', run.id], { env: { ...process.env, ORBIT_WORKER: '1', HOME: l.home, ORBIT_HOME: l.orbitHome } });
    expect(r.code, r.err).toBe(0);
  });
});
