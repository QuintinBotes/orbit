// A reviewer that fails at run time (#116): once its regenerations are used, Orbit records why and selects again
// without it. The next listed independent reviewer reviews under its own name; with none left, review.when_unavailable
// applies as it does at selection. Two Codex-family providers stand in for any two listed reviewers.
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listReviews } from '../../../src/review/store.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { MAX_REGENERATIONS } from '../../../src/controller/steps/common.ts';
import type { ReviewFallback } from '../../../src/policy/review.ts';
import { APPROVE, FAKE_CODEX, baseScenario, implementMul, labDeps, makeLab, readText, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
// A session's wall clock never drops below 60 s while a budget is set (controller/workers.ts), so a real timeout costs 60 s.
const WORKER_TIMEOUT_MS = 60_000;

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

/** Two independent reviewers listed in order; `reviewer` is the fake's answer per reviewer session, in order. */
function lab(mode: ReviewFallback, reviewer: object[]): Lab {
  const l = makeLab({
    tweak: (c) => {
      // Room for every session these tests start: two failed reviewers' attempts and one review.
      c.scheduler.hard_limits.review_rounds = 2 * MAX_REGENERATIONS + 1;
      c.providers['codex-b'] = { command: FAKE_CODEX, data_policy_eligible: true, model: 'gpt-6-astra', reasoning_effort: null, extra_args: [] };
      c.review = { ...c.review, providers: ['codex', 'codex-b'], when_unavailable: mode };
    },
  });
  labs.push(l);
  writeScenario(l, baseScenario({ implementer: [implementMul('*')], reviewer }));
  return l;
}

async function drive(l: Lab, runId: string): Promise<void> {
  const deps = labDeps(l);
  await new Controller({ mode: 'foreground', runId, deps: { ...deps, timing: { ...deps.timing, workerTimeoutMs: WORKER_TIMEOUT_MS } }, tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

const reviewRounds = (l: Lab, runId: string): number | undefined => l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'review_rounds'", runId)?.used;
const HANG = { sleepMs: 90_000 };
const EXIT = { outcome: 'no_result', exitCode: 1 };

describe.skipIf(!canStripTypes)('controller: a reviewer that fails at run time', () => {
  it('times out on every attempt: the next listed reviewer reviews, under its own name, and the decisions name both', async () => {
    const l = lab('block', [...Array(MAX_REGENERATIONS).fill(HANG), APPROVE]);
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reviews = listReviews(l.db(), run.id);
    expect(reviews.map((r) => r.provider)).toEqual(['codex-b']);

    const sessions = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(sessions.map((w) => w.provider)).toEqual([...Array(MAX_REGENERATIONS).fill('codex'), 'codex-b']);
    // Every session that ran is a review round.
    expect(reviewRounds(l, run.id)).toBe(sessions.length);

    const [failed, ...more] = listDecisions(l.db(), run.id, { kind: 'review.reviewer-failed' });
    expect(more).toEqual([]);
    expect(failed!.data).toMatchObject({ provider: 'codex', reason: expect.stringMatching(/^timeout/) });
    const selections = listDecisions(l.db(), run.id, { kind: 'review.select' }).map((d) => d.data as { provider: string; substitutedForPreferred: boolean; reason: string });
    expect(selections.map((s) => s.provider)).toEqual(['codex', 'codex-b']);
    expect(selections[1]).toMatchObject({ substitutedForPreferred: true, reason: expect.stringMatching(/"codex" failed at run time: timeout/) });

    const final = readText(join(l.repo, '.orbit', 'runs', run.id, 'final.md'));
    expect(final).toMatch(/Reviewer: codex-b\/\S+ \(independent\)\n- Tried first: codex\/\S+, which failed \(timeout/);
    const json = JSON.parse(readText(join(l.repo, '.orbit', 'runs', run.id, 'final.json'))) as { reviewer: { provider: string; failed_reviewers: { provider: string }[] } };
    expect(json.reviewer).toMatchObject({ provider: 'codex-b', failed_reviewers: [{ provider: 'codex' }] });
  }, 300_000);

  it('block: when every listed reviewer fails, the run blocks and names each failure', async () => {
    const l = lab('block', Array(2 * MAX_REGENERATIONS).fill(EXIT));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/independent review is required \(review\.when_unavailable: block\)/);
    expect(done.outcomeReason).toMatch(/"codex" failed at run time: /);
    expect(done.outcomeReason).toMatch(/"codex-b" failed at run time: /);
    expect(listReviews(l.db(), run.id)).toEqual([]);
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' }).map((w) => w.provider)).toEqual([...Array(MAX_REGENERATIONS).fill('codex'), ...Array(MAX_REGENERATIONS).fill('codex-b')]);
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' }).some((w) => w.provider === 'claude')).toBe(false);
    // The packet the second reviewer saw was built, and its eligibility checked, for that reviewer.
    expect(JSON.parse(readText(join(l.repo, '.orbit', 'runs', run.id, 'reviews', '1', 'packet.json'))).eligibility.provider).toBe('codex-b');
    expect(reviewRounds(l, run.id)).toBe(2 * MAX_REGENERATIONS);
  }, 120_000);

  it('claude: when every listed reviewer fails, Claude reviews in a separate session and says it is not independent and why', async () => {
    const l = lab('claude', [...Array(2 * MAX_REGENERATIONS).fill(EXIT), APPROVE]);
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listReviews(l.db(), run.id).map((r) => r.provider)).toEqual(['claude']);
    const final = readText(join(l.repo, '.orbit', 'runs', run.id, 'final.md'));
    expect(final).toMatch(/Reviewer: claude\/\S+ \(same provider, NOT independent: no independent reviewer was usable: "codex" failed at run time: .*"codex-b" failed at run time/);
    expect(final).toMatch(/- Tried first: codex\/\S+, which failed/);
    expect(final).toMatch(/- Tried first: codex-b\/\S+, which failed/);
  }, 120_000);

  it('resume after every listed reviewer failed tries them in order again: the first continues at its next attempt, for one recovery attempt', async () => {
    const l = lab('block', [...Array(2 * MAX_REGENERATIONS).fill(EXIT), APPROVE]);
    const run = startLabRun(l);
    await drive(l, run.id);
    expect(runState(l, run.id).state).toBe('BLOCKED');

    const io = memoryIo('');
    expect(await main(['resume', run.id, '--detach'], { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome }, user: 'acme' }), io.stderr).toBe(0);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const sessions = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(sessions.at(-1)).toMatchObject({ provider: 'codex', purpose: expect.stringMatching(new RegExp(`^review:cand-[^~#]+#${MAX_REGENERATIONS + 1}$`)) });
    expect(l.db().get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'resume.reset'", run.id)?.n).toBe(1);
    // The failures before the resume no longer excluded anyone, so the report does not say they did.
    const final = readText(join(l.repo, '.orbit', 'runs', run.id, 'final.md'));
    expect(final).toMatch(/Reviewer: codex\/\S+ \(independent\)\n/);
    expect(final).not.toMatch(/Tried first/);
  }, 120_000);
});
