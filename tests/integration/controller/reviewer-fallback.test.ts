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
import { frozenPolicySetting } from '../../../src/controller/resume.ts';
import type { ReviewFallback } from '../../../src/policy/review.ts';
import type { OrbitConfig, ProviderConfig } from '../../../src/policy/types.ts';
import { APPROVE, FAKES, FAKE_CODEX, IMPLEMENTER_OUTPUT, baseScenario, implementMul, labDeps, makeLab, readText, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
// A session's wall clock never drops below 60 s while a budget is set (controller/workers.ts), so a real timeout costs 60 s.
const WORKER_TIMEOUT_MS = 60_000;

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

/** Two independent reviewers listed in order; `reviewer` is the fake's answer per reviewer session, in order. */
function lab(mode: ReviewFallback, reviewer: object[], tweak?: (c: OrbitConfig) => void, roles: Record<string, object[]> = {}): Lab {
  const l = makeLab({
    tweak: (c) => {
      c.providers['codex-b'] = { command: FAKE_CODEX, data_policy_eligible: true, model: 'gpt-6-astra', reasoning_effort: null, extra_args: [] };
      c.review = { ...c.review, providers: ['codex', 'codex-b'], when_unavailable: mode };
      tweak?.(c);
    },
  });
  labs.push(l);
  writeScenario(l, baseScenario({ implementer: [implementMul('*')], reviewer, ...roles }));
  return l;
}

/** Muse and Codex listed in `providers` order, each through its own fake CLI. */
function museLab(providers: string[], mode: ReviewFallback, reviewer: object[], museEligible = true): Lab {
  const muse: ProviderConfig = { command: join(FAKES, 'fake-muse.mjs'), data_policy_eligible: museEligible, model: 'muse-wonder-full-1.0', reasoning_effort: 'high', extra_args: [], tier: 'muse-sandbox' };
  const l = makeLab({
    tweak: (c) => {
      c.providers.muse = muse;
      c.review = { ...c.review, providers, when_unavailable: mode };
    },
  });
  labs.push(l);
  writeScenario(l, baseScenario({ implementer: [implementMul('*')], reviewer }));
  return l;
}

async function resume(l: Lab, runId: string): Promise<void> {
  const io = memoryIo('');
  expect(await main(['resume', runId, '--detach'], { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome }, user: 'acme' }), io.stderr).toBe(0);
}

async function drive(l: Lab, runId: string): Promise<void> {
  const deps = labDeps(l);
  await new Controller({ mode: 'foreground', runId, deps: { ...deps, timing: { ...deps.timing, workerTimeoutMs: WORKER_TIMEOUT_MS } }, tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

const reviewRounds = (l: Lab, runId: string): number | undefined => l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'review_rounds'", runId)?.used;
const rawCap = (l: Lab, runId: string): number | undefined => l.db().get<{ hard_cap: number }>("SELECT hard_cap FROM budget_counters WHERE run_id = ? AND counter = 'review_rounds'", runId)?.hard_cap;
const grants = (l: Lab, runId: string) => listDecisions(l.db(), runId, { kind: 'review.reviewer-failed' }).map((d) => (d.data as { provider: string; rounds_granted?: number }));
const finalMd = (l: Lab, runId: string): string => readText(join(l.repo, '.orbit', 'runs', runId, 'final.md'));
const purposes = (l: Lab, runId: string): string[] => listWorkers(l.db(), { runId, role: 'reviewer' }).map((w) => w.purpose!.replace(/:cand-[^#~]+/, ':cand'));
const HANG = { sleepMs: 90_000 };
const EXIT = { outcome: 'no_result', exitCode: 1 };
const REPAIR_REQUIRED = { structured: { verdict: 'REPAIR_REQUIRED', candidate_revision: '$CANDIDATE', findings: [{ id: 'COR-1', severity: 'high', category: 'correctness', location: 'apps/calc.mjs:2', claim: 'mul returns NaN for a string argument.', evidence: 'mul("a", 2) is NaN.', suggested_validation: 'Assert that mul("a", 2) throws.' }] } };

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
    // At the default review_rounds of 4: each attempt still counts, and each failed reviewer's rounds were granted back.
    expect(grants(l, run.id).map((g) => [g.provider, g.rounds_granted])).toEqual([
      ['codex', MAX_REGENERATIONS],
      ['codex-b', MAX_REGENERATIONS],
    ]);
    expect(reviewRounds(l, run.id)).toBe(2 * MAX_REGENERATIONS + 1);
    expect(final).toContain(`review_rounds: ${2 * MAX_REGENERATIONS + 1} used of ${4 + 2 * MAX_REGENERATIONS} allowed (hard cap ${4 + 2 * MAX_REGENERATIONS}, including ${2 * MAX_REGENERATIONS} for replaced reviewers)`);
    // The frozen limit itself is untouched: a restart still verifies it against the policy snapshot.
    expect(rawCap(l, run.id)).toBe(4);
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
    // Every reviewer tried is named, the failures before the resume included.
    const failed = `failed: exited 1 without turn.completed or turn.failed after ${MAX_REGENERATIONS} attempt(s)`;
    expect(finalMd(l, run.id)).toContain(`Reviewer: codex/gpt-6-astra (independent)\n- Tried first: codex/gpt-6-astra, which failed (${failed})\n- Tried first: codex-b/gpt-6-astra, which failed (${failed})\n`);
  }, 120_000);

  it('a reviewer that fails again after a resume is granted only the rounds spent since its last grant', async () => {
    const l = lab('block', [...Array(3 * MAX_REGENERATIONS).fill(EXIT), APPROVE]);
    const run = startLabRun(l);
    await drive(l, run.id);
    await resume(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(grants(l, run.id).map((g) => [g.provider, g.rounds_granted])).toEqual([
      ['codex', MAX_REGENERATIONS],
      ['codex-b', MAX_REGENERATIONS],
      ['codex', MAX_REGENERATIONS],
    ]);
    expect(reviewRounds(l, run.id)).toBe(3 * MAX_REGENERATIONS + 1);
  }, 120_000);

  it('a hard cap reached with rounds granted prints the effective cap and says it includes them', async () => {
    const l = lab('block', [...Array(MAX_REGENERATIONS).fill(EXIT), REPAIR_REQUIRED, REPAIR_REQUIRED], (c) => void (c.scheduler.hard_limits.review_rounds = 2), {
      // The repair names a test for COR-1 that does not tell the trees apart: the finding stays open until the cap.
      implementer: [implementMul('*'), { ...implementMul('*', [{ op: 'write', path: 'tests/extra.test.mjs', content: '// unrelated\n' }]), structured: { ...IMPLEMENTER_OUTPUT, evidence_refs: [{ criterion_id: null, ref: 'tests/extra.test.mjs', note: 'validation for finding COR-1' }] } }],
    });
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('EXHAUSTED');
    expect(done.outcomeReason).toContain('review_rounds hard cap reached (4 of 4, including 2 for replaced reviewers) with 1 open finding(s)');
    expect(rawCap(l, run.id)).toBe(2);
  }, 120_000);

  it('a run-time failure beside an ineligible listed reviewer is no frozen-policy block: a plain resume tries the failed reviewer again', async () => {
    const l = museLab(['codex', 'muse'], 'block', [...Array(MAX_REGENERATIONS).fill(EXIT), APPROVE], false);
    const run = startLabRun(l);
    await drive(l, run.id);

    const blocked = runState(l, run.id);
    expect(blocked.state).toBe('BLOCKED');
    expect(blocked.outcomeReason).toMatch(/providers\.muse\.data_policy_eligible is not true/);
    expect(frozenPolicySetting(blocked)).toBeNull();

    await resume(l, run.id);
    await drive(l, run.id);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listReviews(l.db(), run.id).map((r) => r.provider)).toEqual(['codex']);
  }, 120_000);

  it('a blocked report with no review at all says none stands and names each reviewer tried', async () => {
    const l = lab('block', Array(2 * MAX_REGENERATIONS).fill(EXIT));
    const run = startLabRun(l);
    await drive(l, run.id);

    const failed = `failed: exited 1 without turn.completed or turn.failed after ${MAX_REGENERATIONS} attempt(s)`;
    expect(finalMd(l, run.id)).toContain(`Reviewer: none, no review of this tree stands\n- Tried first: codex/gpt-6-astra, which failed (${failed})\n- Tried first: codex-b/gpt-6-astra, which failed (${failed})\n`);
    const json = JSON.parse(readText(join(l.repo, '.orbit', 'runs', run.id, 'final.json'))) as { reviewer: unknown; no_standing_review: { failed_reviewers: { provider: string }[] } };
    expect(json.reviewer).toBeNull();
    expect(json.no_standing_review.failed_reviewers.map((f) => f.provider)).toEqual(['codex', 'codex-b']);
  }, 120_000);

  it('a fresh review (ADR 0016) whose reviewer fails is finished by the next listed reviewer, under review-fresh:<candidate>~<provider>', async () => {
    const shallow = { ...APPROVE, inspect: false };
    const l = lab('block', [shallow, ...Array(MAX_REGENERATIONS).fill(EXIT), APPROVE]);
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(purposes(l, run.id)).toEqual(['review:cand#1', 'review-fresh:cand#1', 'review-fresh:cand#2', 'review-fresh:cand~codex-b#1']);
    expect(listDecisions(l.db(), run.id, { kind: 'review.fresh' })).toHaveLength(1);
    expect(listReviews(l.db(), run.id).map((r) => r.provider)).toEqual(['codex-b']);
    // The shallow review and both fresh attempts were codex's: all three are granted back.
    expect(grants(l, run.id).map((g) => [g.provider, g.rounds_granted])).toEqual([['codex', 3]]);
    expect(finalMd(l, run.id)).toMatch(/Reviewer: codex-b\/gpt-6-astra \(independent\)\n- Tried first: codex\/gpt-6-astra, which failed \(failed: /);
  }, 120_000);

  it('a fresh review finished by the next listed reviewer does not clear when that reviewer blocks', async () => {
    const BLOCK = { structured: { verdict: 'BLOCK', candidate_revision: '$CANDIDATE', findings: [] } };
    const l = lab('block', [{ ...APPROVE, inspect: false }, ...Array(MAX_REGENERATIONS).fill(EXIT), BLOCK]);
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(purposes(l, run.id)).toEqual(['review:cand#1', 'review-fresh:cand#1', 'review-fresh:cand#2', 'review-fresh:cand~codex-b#1']);
    expect(listReviews(l.db(), run.id).map((r) => [r.provider, r.verdict])).toEqual([['codex-b', 'BLOCK']]);
  }, 120_000);

  it('a resume after every listed reviewer failed the fresh review: the one general unit clears only on the fresh review that came back', async () => {
    const l = lab('block', [{ ...APPROVE, inspect: false }, ...Array(2 * MAX_REGENERATIONS).fill(EXIT), APPROVE]);
    const run = startLabRun(l);
    await drive(l, run.id);
    expect(runState(l, run.id).state).toBe('BLOCKED');
    expect(listReviews(l.db(), run.id)).toEqual([]);

    await resume(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(purposes(l, run.id)).toEqual(['review:cand#1', 'review-fresh:cand#1', 'review-fresh:cand#2', 'review-fresh:cand~codex-b#1', 'review-fresh:cand~codex-b#2', 'review-fresh:cand#3']);
    expect(listReviews(l.db(), run.id).map((r) => [r.provider, r.verdict])).toEqual([['codex', 'APPROVE']]);
  }, 120_000);

  for (const [first, next, firstLabel, nextLabel] of [
    ['muse', 'codex', 'muse/muse-wonder-full-1.0', 'codex/gpt-6-astra'],
    ['codex', 'muse', 'codex/gpt-6-astra', 'muse/muse-wonder-full-1.0'],
  ] as const) {
    it(`${first} fails on every attempt and ${next} reviews under its own label`, async () => {
      const l = museLab([first, next], 'block', [...Array(MAX_REGENERATIONS).fill(EXIT), APPROVE]);
      const run = startLabRun(l);
      await drive(l, run.id);

      const done = runState(l, run.id);
      expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
      expect(purposes(l, run.id)).toEqual(['review:cand#1', 'review:cand#2', `review:cand~${next}#1`]);
      expect(listReviews(l.db(), run.id).map((r) => r.provider)).toEqual([next]);
      expect(grants(l, run.id).map((g) => [g.provider, g.rounds_granted])).toEqual([[first, MAX_REGENERATIONS]]);
      const selections = listDecisions(l.db(), run.id, { kind: 'review.select' }).map((d) => d.data as { provider: string; substitutedForPreferred: boolean });
      expect(selections.map((s) => [s.provider, s.substitutedForPreferred])).toEqual([
        [first, false],
        [next, true],
      ]);
      const md = finalMd(l, run.id);
      expect(md).toContain(`Reviewer: ${nextLabel} (independent)`);
      expect(md).toContain(`\n- Tried first: ${firstLabel}, which failed (`);
    }, 120_000);
  }

  it('[codex, muse] with when_unavailable claude: both fail at the default review_rounds, and Claude reviews instead of the run ending EXHAUSTED', async () => {
    const l = museLab(['codex', 'muse'], 'claude', [...Array(2 * MAX_REGENERATIONS).fill(EXIT), APPROVE]);
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listReviews(l.db(), run.id).map((r) => r.provider)).toEqual(['claude']);
    expect(reviewRounds(l, run.id)).toBe(2 * MAX_REGENERATIONS + 1);
    expect(rawCap(l, run.id)).toBe(4);
  }, 120_000);
});
