/**
 * Issue #176: Codex and Muse can implement bounded work, and a risky change is reviewed by one fresh pass from the
 * implementer's family plus one cross-model pass. The real controller drives examples/demo-app; Codex and Muse are the
 * fake CLIs behind the real adapters and shim. No model is called.
 *
 * SC-001: the lab passes with each of Claude, Codex and Muse as implementer.
 * US1 scenario 1: a unit routed to Codex runs in a writable worktree under the same scope and policy gates.
 * US1 scenario 2: a partner whose candidates failed verification twice hands the third attempt to Claude.
 * US2 scenario 1: a Codex implementer and a risky change: Claude reviews across models and Codex again in a fresh session.
 * Edge case: a partner out of quota is skipped for the rest of the run without costing an attempt (FR-005).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapter } from '../../src/adapters/index.ts';
import type { IsolationProvider } from '../../src/isolation/types.ts';
import type { OrbitConfig } from '../../src/policy/types.ts';
import type { ReviewerSelection } from '../../src/review/select.ts';
import { listReviews } from '../../src/review/store.ts';
import type { RouteDecision } from '../../src/routing/types.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { verifySnapshot } from '../../src/policy/snapshot.ts';
import { argvCalls, drive, labAdapters, makeLab, ORBIT_ROOT, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { diagnosis, GOAL, GOOD_IMPLEMENTATION, implementer, planner, REGRESSION_DIAGNOSIS, scenario, SRC_FIX_REGRESSION, SRC_REGRESSION, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const FAKE_MUSE = join(ORBIT_ROOT, 'tests', 'fakes', 'fake-muse.mjs');

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(tweak?: (c: OrbitConfig) => void): Lab {
  const l = makeLab({ tweak });
  labs.push(l);
  return l;
}

/** Let `ids` implement before Claude (the switch is off by default). */
function implementers(...ids: string[]): (c: OrbitConfig) => void {
  return (c) => void (c.routing.implementers = [...ids, 'claude']);
}
function withMuse(c: OrbitConfig): void {
  c.providers.muse = { command: FAKE_MUSE, data_policy_eligible: true, model: 'muse-wonder-full-1.0', reasoning_effort: 'high', extra_args: [], tier: 'auto' };
}

/**
 * A stand-in for srt that wraps without confining, so the lab can drive Muse's writable tier, which runs only inside
 * srt. The wrapper is not under test here; the adapter's refusal without srt is (tests/unit/adapters).
 */
const passThroughSrt: IsolationProvider = {
  kind: 'sandbox-runtime',
  available: async () => ({ ok: true, detail: 'acceptance lab stand-in' }),
  wrap: (argv, _profile, opts) => ({ argv: ['/usr/bin/env', ...argv], env: opts.env, cleanup() {}, limitations: ['acceptance lab stand-in for srt: nothing is confined'] }),
} as IsolationProvider;

function adapters(l: Lab) {
  const out = labAdapters(l);
  const muse = l.config.providers.muse;
  if (muse) out.muse = createAdapter('muse', muse, { isolation: passThroughSrt, graceMs: 300, baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: l.scenarioPath, ORBIT_FAKE_ARGV_LOG: l.argvLog, META_API_KEY: 'acme-meta-0176' } });
  return out;
}

const routeOf = (l: Lab, runId: string, purpose: string) => listDecisions(l.db(), runId, { kind: 'route' }).map((d) => d.data as RouteDecision & { purpose: string }).find((d) => d.purpose === purpose);
const implementerWorkers = (l: Lab, runId: string) => listWorkers(l.db(), { runId, role: 'implementer' });
const outcomes = (l: Lab, runId: string) => l.db().all<{ provider: string; outcome: string; attempt_key: string }>('SELECT provider, outcome, attempt_key FROM route_outcomes WHERE run_id = ? ORDER BY id', runId);
const attemptsUsed = (l: Lab, runId: string) => l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'implementation_attempts'", runId)!.used;

describe.skipIf(!READY)('acceptance: partner implementers (issue #176)', () => {
  it.each([
    ['claude', undefined],
    ['codex', implementers('codex')],
    ['muse', (c: OrbitConfig): void => (withMuse(c), implementers('muse')(c))],
  ] as const)('SC-001: the lab passes with %s as implementer', async (provider, tweak) => {
    const l = lab(tweak);
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id, { adapters: adapters(l) });
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(implementerWorkers(l, run.id).map((w) => w.provider)).toEqual([provider]);
    expect(routeOf(l, run.id, 'implement:1')?.provider).toBe(provider);
    // The partner wrote in the run's own worktree, and the reviewer was never the implementer's family alone.
    expect(implementerWorkers(l, run.id)[0]!.cwd).toBe(done.worktreePath);
    const reviews = listReviews(l.db(), run.id);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every((r) => r.provider !== provider)).toBe(true);
    expect(outcomes(l, run.id)).toEqual([{ provider, outcome: 'verified', attempt_key: 'attempt:1' }]);
    if (provider === 'codex') {
      const call = argvCalls(l).find((c) => c.tool === 'codex' && c.role === 'implementer') as unknown as { argv: string[] };
      expect(call.argv[call.argv.indexOf('--sandbox') + 1]).toBe('workspace-write');
      expect(call.argv[call.argv.indexOf('-C') + 1]).toBe(done.worktreePath);
    }
    if (provider === 'muse') {
      const call = argvCalls(l).find((c) => c.tool === 'muse' && c.role === 'implementer') as unknown as { argv: string[] };
      expect(call.argv[call.argv.indexOf('--workspace') + 1]).toBe(done.worktreePath);
      expect(call.argv[call.argv.indexOf('--contributor-mode') + 1]).toBe('off');
      // The writable tier ran inside (the stand-in for) srt.
      const launch = JSON.parse(readFileSync(join(implementerWorkers(l, run.id)[0]!.workerDir, 'launch.json'), 'utf8')) as { argv: string[]; meta: { tier: string; writable: boolean } };
      expect(launch.meta).toMatchObject({ tier: 'os-sandbox', writable: true });
    }
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('US1 scenario 1: a Codex candidate that edits protected paths meets the same policy gate as a Claude one: rejected outright', async () => {
    const l = lab(implementers('codex'));
    const widen = { op: 'replace', path: '.orbit/config.yaml', find: 'allowed_paths: ["src/**", "tests/**"]', replace: 'allowed_paths: ["**"]' };
    writeScenario(l, scenario({ implementer: [implementer([SRC_TEXT, TEST_TEXT, widen as never])] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/policy violation/);
    expect(done.outcomeReason).toMatch(/\.orbit\/config\.yaml/);
    expect(implementerWorkers(l, run.id).map((w) => w.provider)).toEqual(['codex']);
    expect(transitions(l.db(), run.id).slice(-2)).toEqual(['VERIFYING', 'BLOCKED']);
    expect(listReviews(l.db(), run.id, { includeInvalidated: true })).toEqual([]);
    expect(verifySnapshot(done.policyPath, done.policyHash).config.scope.allowed_paths).toEqual(['src/**', 'tests/**']);
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('US1 scenario 2: a partner whose candidates failed verification twice hands the third attempt to Claude', async () => {
    const l = lab((c) => {
      implementers('codex')(c);
      c.scheduler.initial_allowances = { simple_attempts: 4, medium_attempts: 4, complex_attempts: 6 };
      // Codex and Claude both implemented, so neither reviews independently (FR-003); a same-provider review may stand.
      c.review = { providers: ['codex'], when_unavailable: 'claude', block_unresolved_high_impact_findings: true, security: c.review.security } as OrbitConfig['review'];
    });
    const again = implementer([{ op: 'write', path: 'tests/unit/attempt-2.txt', content: 'attempt 2\n' }], { summary: 'attempt 2: adjusted the handler', changed: [['src/server.ts', 'modify']] });
    // Each failure gets a diagnosis with a hypothesis of its own: a reworded one is no new hypothesis.
    const second = diagnosis({ evidence: "tests/unit/server.test.ts 'answers 404 for anything else': expected 404, got 200", hypothesis: 'the response writer overrides the status with 200 for plain text', alternative: 'a default status of 200 is applied before the branch runs', experiment: "Call handle('/nope') and inspect the response writer", expected: 'the writer shows status 200', fix: 'Restore status 404 in src/server.ts and keep the new text' });
    writeScenario(
      l,
      scenario({
        implementer: [implementer([SRC_REGRESSION, TEST_TEXT]), again, implementer([SRC_FIX_REGRESSION], { summary: 'Restored status 404; kept the new text.', changed: [['src/server.ts', 'modify']] })],
        verifier: [REGRESSION_DIAGNOSIS, second],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(implementerWorkers(l, run.id).map((w) => w.provider)).toEqual(['codex', 'codex', 'claude']);
    expect(outcomes(l, run.id)).toEqual([
      { provider: 'codex', outcome: 'failed', attempt_key: 'attempt:1' },
      { provider: 'codex', outcome: 'failed', attempt_key: 'attempt:2' },
      { provider: 'claude', outcome: 'verified', attempt_key: 'attempt:3' },
    ]);
    const third = routeOf(l, run.id, 'implement:3')!;
    expect(third.provider).toBe('claude');
    expect(third.justification.ignored.join(' ')).toMatch(/codex 2 of its candidates in this run failed verification or review; Claude implements/);
    // FR-003: who implemented decides independence, so the review of a tree both wrote is not called independent.
    const sel = listDecisions(l.db(), run.id, { kind: 'review.select' }).at(-1)!.data as Extract<ReviewerSelection, { decision: 'SELECT' }>;
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'claude', independent: false });
    assertRunInvariants(l, run.id);
  }, 300_000);

  it('edge case: a partner out of quota is skipped for the rest of the run, classed credentials, and the attempt goes on with Claude at no extra attempt', async () => {
    const l = lab((c) => {
      implementers('codex')(c);
      // Codex counts as having implemented (below), so no reviewer is independent; a same-provider review may stand.
      c.review = { providers: ['codex'], when_unavailable: 'claude', block_unresolved_high_impact_findings: true, security: c.review.security } as OrbitConfig['review'];
    });
    writeScenario(l, scenario({ implementer: [{ outcome: 'quota' }, GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(attemptsUsed(l, run.id)).toBe(1);
    const workers = implementerWorkers(l, run.id);
    expect(workers.map((w) => [w.provider, w.resultStatus])).toEqual([
      ['codex', 'auth_failed'],
      ['claude', 'succeeded'],
    ]);
    const skipped = listDecisions(l.db(), run.id, { kind: 'routing.partner-skipped' });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.data).toMatchObject({ provider: 'codex', attempt: 1, failure_class: 'credentials', reason: expect.stringMatching(/out of quota: You've hit your usage limit/) });
    expect(routeOf(l, run.id, 'implement:1')?.provider).toBe('codex');
    expect(routeOf(l, run.id, 'implement:1~codex')?.provider).toBe('claude');
    // The attempt's outcome is Claude's; the partner's quota is charged to no candidate.
    expect(outcomes(l, run.id)).toEqual([{ provider: 'claude', outcome: 'verified', attempt_key: 'attempt:1' }]);
    // FR-003, failing closed: a partner session that ended on its quota or login counts as implementing, since it may
    // have edited the worktree before failing part way through a turn. So Codex does not review the tree as
    // independent; Claude reviews in a separate session, not independent.
    const sel = listDecisions(l.db(), run.id, { kind: 'review.select' }).at(-1)!.data as Extract<ReviewerSelection, { decision: 'SELECT' }>;
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'claude', independent: false });
    expect(listReviews(l.db(), run.id).map((r) => r.provider)).toEqual(['claude']);
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('edge case: a partner whose writable tier cannot run here (Muse without srt and META_API_KEY) is skipped at preflight, and Claude implements', async () => {
    const l = lab((c) => (withMuse(c), implementers('muse')(c)));
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    // The lab's own adapters: no srt, no key.
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(implementerWorkers(l, run.id).map((w) => w.provider)).toEqual(['claude']);
    const skipped = listDecisions(l.db(), run.id, { kind: 'routing.partner-skipped' });
    expect(skipped.map((d) => d.data)).toEqual([expect.objectContaining({ provider: 'muse', attempt: null, failure_class: 'credentials', reason: expect.stringMatching(/no writable tier here: Muse implements only in the os-sandbox tier/) })]);
    expect(routeOf(l, run.id, 'implement:1')?.justification.ignored.join(' ')).toMatch(/muse skipped for the rest of this run/);
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('US2 scenario 1: a Codex implementer and a risky change: Claude reviews at its top tier across models, and Codex reviews again in a fresh session', async () => {
    const l = lab(implementers('codex'));
    // Security-sensitive and spread over three areas: the planning assessment classes it complex, which is risky.
    const risky = planner({
      allowed: ['src/server.ts', 'src/notes/**', 'tests/unit/**'],
      files: [
        ['src/server.ts', 'modify', 'new not-found text'],
        ['tests/unit/server.test.ts', 'modify', 'assert the text'],
        ['src/notes/not-found.md', 'add', 'note the text'],
      ],
      risks: [{ risk: 'the not-found handler sits in front of the auth token check', impact: 'high', mitigation: 'keep the check order' }],
    });
    writeScenario(l, scenario({ planner: [risky], implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(done.difficulty).toBe('complex');
    expect(implementerWorkers(l, run.id).map((w) => w.provider)).toEqual(['codex']);
    const reviews = listReviews(l.db(), run.id);
    expect(reviews.map((r) => r.provider).sort()).toEqual(['claude', 'codex']);
    const sel = listDecisions(l.db(), run.id, { kind: 'review.select' }).at(-1)!.data as Extract<ReviewerSelection, { decision: 'SELECT' }>;
    expect(sel).toMatchObject({ provider: 'claude', independent: true, sameFamily: { provider: 'codex', model: 'gpt-6-astra' }, crossModelSkipped: null });
    expect(sel.model).toMatch(/opus/);
    // The Codex review is its own session, under its own purpose, after the cross-model one.
    const reviewers = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    expect(reviewers.find((w) => w.provider === 'codex')!.purpose).toMatch(/^review-family:/);
    expect(reviewers.find((w) => w.provider === 'claude')!.purpose).toMatch(/^review:/);
    const report = readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8');
    expect(report).toMatch(/Reviewer: claude\/\S+ \(independent\)/);
    expect(report).toMatch(/Same-family review: codex\/gpt-6-astra \(the implementer's family, in a fresh session; the change is risky\)/);
    assertRunInvariants(l, run.id);
  }, 300_000);
});
