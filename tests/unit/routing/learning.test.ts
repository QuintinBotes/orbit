/**
 * Issue #168: routing learns from measured outcomes. The router is pure, so every scenario here is a set of
 * statistics in and a decision out: the same statistics always give the same decision, and the decision says what it
 * read and why it did or did not displace the routing table.
 */
import { describe, expect, it } from 'vitest';
import { route, MIN_MEASURED_SAMPLES, type RegistryView } from '../../../src/routing/router.ts';
import { recordRouteOutcome, routeStats } from '../../../src/routing/usage.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { DEFAULT_ROUTING_LEARNING } from '../../../src/policy/config.ts';
import type { EligibilityAssessment, EligibilityRequirements, ModelEntry, ModelPricing, RouteStat, RoutingLearning, RoutingPolicy, WorkKind } from '../../../src/routing/types.ts';
import { HAIKU, OPUS, SONNET, policy, setup, signals } from './fixtures.ts';

const price = (k: number): ModelPricing => ({ input: 3 * k, output: 15 * k, cache_write_5m: 3.75 * k, cache_write_1h: 6 * k, cache_read: 0.3 * k });

function model(id: string, family: string, o: { k?: number; pricing?: ModelPricing | null } = {}): ModelEntry {
  return {
    modelId: id,
    provider: 'claude',
    family,
    displayName: id,
    surfaces: [],
    capabilities: { tools: true, structuredOutput: true, vision: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null },
    limits: null,
    pricing: o.pricing === undefined ? price(o.k ?? 1) : o.pricing,
    eligibility: { aliases: [], cliAlias: null, minCliVersion: null, requiresExplicitPolicy: false, providerDefault: false, notes: [], provenance: {} },
    evaluation: { observedCost: null, qualifiedFor: [], justifiedWorkKinds: [] },
    latencyMs: null,
    available: true,
    refreshedAt: null,
  };
}

/** A registry that answers with exactly the models it is given: what the policy made eligible. */
function fake(models: ModelEntry[]): RegistryView {
  return {
    assess(req: EligibilityRequirements): EligibilityAssessment {
      return { eligible: models.filter((m) => !req.provider || m.provider === req.provider), excluded: [] };
    },
    get: (id: string) => models.find((m) => m.modelId === id) ?? null,
  };
}

function stat(workKind: WorkKind, m: ModelEntry, verified: number, failed: number, meanCostUsd: number | null, over: Partial<RouteStat> = {}): RouteStat {
  const judged = verified + failed;
  return { workKind, provider: m.provider, modelId: m.modelId, samples: judged, verified, failed, rejected: 0, errors: 0, successRate: judged ? verified / judged : null, meanCostUsd, costSamples: meanCostUsd === null ? 0 : judged, meanTokens: null, ...over };
}

const haiku = model('h-1', 'haiku', { k: 0.3 });
const sonnet = model('s-1', 'sonnet', { k: 1 });
const opus = model('o-1', 'opus', { k: 2 });
const all = fake([haiku, sonnet, opus]);

function withLearning(l: Partial<RoutingLearning>, overrides: Record<string, string> = {}): RoutingPolicy {
  return { ...policy(), routing: { allowed_models: ['haiku', 'sonnet', 'opus'], overrides, learning: l } };
}

const decide = (outcomes: RouteStat[], p: RoutingPolicy = policy(), sig = signals()) => route({ workKind: 'routine-code', signals: sig, registry: all, policy: p, outcomes });

describe('user story 1: a cheaper tier that works gets used', () => {
  it('scenario 1: twenty recorded outcomes where the cheaper tier passed route the class to it, and the justification cites the measured rate', () => {
    const table = decide([]);
    expect(table.model).toBe('s-1');
    expect(table.learning).toBeUndefined();

    const d = decide([stat('routine-code', haiku, 20, 0, 0.05)]);
    expect(d.model).toBe('h-1');
    expect(d.learning).toMatchObject({
      applied: true,
      table_choice: { provider: 'claude', model: 's-1' },
      task_class: { work_kind: 'routine-code', difficulty: 'simple' },
      min_samples: 20,
      min_pass_rate: 0.8,
      window_days: 90,
    });
    expect(d.learning!.reason).toMatch(/measured pass rate 100% over 20 outcomes of routine-code \(simple\) in the last 90 days for h-1 \(minimum 20 outcomes, threshold 80%\)/);
    expect(d.learning!.measured).toEqual([expect.objectContaining({ model: 'h-1', judged: 20, verified: 20, pass_rate: 1, cost_samples: 20, mean_cost_usd: 0.05, verdict: 'qualifies' })]);
    // The recorded reason of the decision says it too, and the table's choice is listed as considered and not taken.
    expect(d.reason).toMatch(/calibrated by measured outcomes: measured pass rate 100% over 20 outcomes/);
    expect(d.alternatives_considered.find((a) => a.model === 's-1')?.rejected_because).toMatch(/measured outcomes give h-1 a lower expected cost per verified task/);
    // A cheaper tier is not an escalation: no observed-difficulty signal, so effort is not raised by it.
    expect(d.justification.signals).toEqual([]);
    // Each cost says where it comes from: Haiku's is measured, Sonnet's (no outcomes) is its list price.
    expect(d.learning!.reason).toMatch(/; expected cost per verified task \$[\d.]+ for h-1 \(measured\) vs \$[\d.]+ for s-1 \(list price\)$/);
    expect(d.learning!.reason).not.toMatch(/measured expected cost/);
  });

  it('scenario 2: when the cheaper tier\'s measured pass rate falls below the threshold, the table default is restored and the decision says why', () => {
    expect(decide([stat('routine-code', haiku, 20, 0, 0.05)]).model).toBe('h-1');
    // Six failures later: 20 of 26 is 77%, below the 80% threshold.
    const d = decide([stat('routine-code', haiku, 20, 6, 0.05)]);
    expect(d.model).toBe('s-1');
    expect(d.learning).toMatchObject({ applied: false, table_choice: { model: 's-1' } });
    expect(d.learning!.reason).toBe('measured pass rate 77% over 26 outcomes is below 80% for h-1, so s-1 from the routing table is used');
    expect(d.reason).toMatch(/table default kept: measured pass rate 77% over 26 outcomes is below 80% for h-1/);
    // Exactly at the threshold still counts as meeting it.
    expect(decide([stat('routine-code', haiku, 16, 4, 0.05)]).model).toBe('h-1');
  });

  it('a route recovers: once the failures are outside what is read and the cheaper tier is measured above the threshold again, it is used again', () => {
    expect(decide([stat('routine-code', haiku, 20, 6, 0.05)]).model).toBe('s-1');
    // Nothing left in the window: the table decides, and nothing remembers the earlier restoration.
    expect(decide([]).model).toBe('s-1');
    expect(decide([stat('routine-code', haiku, 20, 1, 0.05)]).model).toBe('h-1');
  });
});

describe('edge cases', () => {
  it('fewer outcomes than the minimum sample: the table decides, and the decision says how many there were', () => {
    const d = decide([stat('routine-code', haiku, 19, 0, 0.05)]);
    expect(d.model).toBe('s-1');
    expect(d.learning).toMatchObject({ applied: false });
    expect(d.learning!.reason).toBe('the routing table decides: h-1 has 19 of the 20 judged outcomes needed');
    expect(MIN_MEASURED_SAMPLES).toBe(20);
    expect(DEFAULT_ROUTING_LEARNING).toEqual({ enabled: true, min_samples: 20, min_pass_rate: 0.8, window_days: 90 });
  });

  it('the minimum sample and the threshold are configurable', () => {
    const five = [stat('routine-code', haiku, 5, 0, 0.05)];
    expect(decide(five).model).toBe('s-1');
    expect(decide(five, withLearning({ min_samples: 5 })).model).toBe('h-1');
    const weak = [stat('routine-code', haiku, 15, 5, 0.05)];
    expect(decide(weak).model).toBe('s-1');
    const lower = decide(weak, withLearning({ min_pass_rate: 0.7 }));
    expect(lower.model).toBe('h-1');
    expect(lower.learning!.reason).toMatch(/measured pass rate 75% over 20 outcomes.*threshold 70%/);
    // A snapshot written before routing.learning existed reads the defaults.
    const old = { ...policy(), routing: { allowed_models: ['haiku', 'sonnet'], overrides: {} } };
    expect(route({ workKind: 'routine-code', signals: signals(), registry: all, policy: old, outcomes: [stat('routine-code', haiku, 20, 0, 0.05)] }).model).toBe('h-1');
  });

  it('outcomes that were not judged on the work (errors, cancellations) are neither passes nor failures, and no rate is taken over nothing', () => {
    const noise = stat('routine-code', haiku, 0, 0, null, { samples: 40, errors: 40 });
    const d = decide([noise]);
    expect(d.model).toBe('s-1');
    expect(d.learning!.measured[0]).toMatchObject({ judged: 0, pass_rate: null, mean_cost_usd: null });
    expect(d.learning!.reason).toBe('the routing table decides: h-1 has 0 of the 20 judged outcomes needed');
    expect(Number.isFinite(d.success_probability)).toBe(true);
    // Forty errors beside twenty passes do not lower the rate.
    expect(decide([stat('routine-code', haiku, 20, 0, 0.05, { samples: 60, errors: 40 })]).model).toBe('h-1');
  });

  it('an unknown cost is not a zero cost: without a measured cost the list price is used, and without either nothing is displaced', () => {
    const unpriced = model('h-np', 'haiku', { pricing: null });
    const reg = fake([unpriced, sonnet]);
    const d = route({ workKind: 'routine-code', signals: signals(), registry: reg, policy: policy(), outcomes: [stat('routine-code', unpriced, 20, 0, null)] });
    expect(d.model).toBe('s-1');
    expect(d.learning!.measured[0]).toMatchObject({ model: 'h-np', cost_samples: 0, mean_cost_usd: null, verdict: 'its cost is unknown, and an unknown cost is not counted as a lower one' });
    // With a list price and no measured cost, the estimate is priced from tokens, never from zero.
    const priced = decide([stat('routine-code', haiku, 20, 0, null)]);
    expect(priced.model).toBe('h-1');
    expect(priced.expected_cost_per_verified_task).toBeGreaterThan(0);
    // A cheaper tier that costs more per verified task than the table's choice does not displace it.
    const dear = decide([stat('routine-code', haiku, 20, 0, 50)]);
    expect(dear.model).toBe('s-1');
    expect(dear.learning!.measured[0]!.verdict).toMatch(/is not clearly below/);
  });

  it('outcomes of another task class are not comparable: another work kind or difficulty class decides nothing', () => {
    expect(decide([stat('focused-tests', haiku, 20, 0, 0.05)]).model).toBe('s-1');
    expect(decide([stat('routine-code', haiku, 20, 0, 0.05, { difficulty: 'simple' })], policy(), signals({ difficulty: 'complex' })).model).toBe('s-1');
    expect(decide([stat('routine-code', haiku, 20, 0, 0.05, { difficulty: 'complex' })], policy(), signals({ difficulty: 'complex' })).model).toBe('h-1');
  });
});

describe('learning stays inside what the policy and the person allow', () => {
  const proven = [stat('routine-code', haiku, 40, 0, 0.01)];

  it('never routes to a model the policy did not make eligible, however good its record', () => {
    const d = route({ workKind: 'routine-code', signals: signals(), registry: fake([sonnet, opus]), policy: policy(), outcomes: proven });
    expect(d.model).toBe('s-1');
    expect(d.learning).toBeUndefined();
    // With the real registry: haiku is registered and validated, and routing.allowed_models leaves it out.
    const { registry } = setup();
    const real = route({ workKind: 'routine-code', signals: signals(), registry, policy: policy({ allowed: [SONNET, OPUS] }), outcomes: [{ ...proven[0]!, modelId: HAIKU }] });
    expect(real.model).toBe(SONNET);
    expect(real.alternatives_considered.find((a) => a.model === HAIKU)).toMatchObject({ eligible: false });
  });

  it('an explicit routing.overrides entry always wins over measured outcomes, and the decision says so', () => {
    const d = decide(proven, withLearning({}, { 'routine-code': 'sonnet' }));
    expect(d.model).toBe('s-1');
    expect(d.learning).toMatchObject({ applied: false, reason: 'routing.overrides.routine-code is an explicit choice, so measured outcomes do not displace it' });
    const up = decide(proven, withLearning({}, { 'routine-code': 'opus' }));
    expect(up.model).toBe('o-1');
  });

  it('does not displace a route while difficulty is being escalated', () => {
    // Sonnet has the record that would otherwise displace Opus, the tier the repeated failures escalated to.
    const d = decide([stat('routine-code', sonnet, 40, 0, 0.01)], policy(), signals({ attempt: 3, repeatedFingerprints: 2, evidence: ['failure:1'], previousRoute: { provider: 'claude', model: 's-1', outcome: 'failed' } }));
    expect(d.model).toBe('o-1');
    expect(d.learning).toMatchObject({ applied: false, reason: 'difficulty is being escalated, so measured outcomes do not displace the route' });
  });

  it('never routes below the tier an earlier attempt of this run was escalated or held to', () => {
    // Attempt 1 ran on Opus; with no solved diagnosis attempt 2 stays there. Sonnet, the table's default, has the
    // record that would otherwise displace Opus.
    const held = signals({ attempt: 2, previousRoute: { provider: 'claude', model: 'o-1', outcome: 'failed' } });
    const d = decide([stat('routine-code', sonnet, 40, 0, 0.01)], policy(), held);
    expect(d.model).toBe('o-1');
    expect(d.learning).toMatchObject({ applied: false });
    expect(d.learning!.reason).toBe('the routing table decides: s-1 is below opus, where an earlier attempt of this run ran');
    expect(d.learning!.measured.find((m) => m.model === 's-1')?.verdict).toBe('an earlier attempt of this run ran on opus, and measured outcomes never route the run below it');
    // An attempt after one on Sonnet is not sent down to Haiku either.
    const after = signals({ attempt: 2, previousRoute: { provider: 'claude', model: 's-1', outcome: 'failed' } });
    expect(decide([stat('routine-code', haiku, 40, 0, 0.01)], policy(), after).model).toBe('s-1');
    // Without an earlier attempt the same record moves the work as usual.
    expect(decide([stat('routine-code', haiku, 40, 0, 0.01)]).model).toBe('h-1');
  });

  it('without outcomes (routing.learning.enabled false passes none) the table decides exactly as before', () => {
    const d = decide([]);
    expect(d.model).toBe('s-1');
    expect(d.cost_basis).toBe('prior');
    expect(d.learning).toBeUndefined();
  });
});

describe('determinism', () => {
  it('the same recorded outcomes give the same decision, whatever order they arrive in', () => {
    const a = [stat('routine-code', haiku, 22, 1, 0.05), stat('routine-code', sonnet, 30, 2, 0.6), stat('routine-code', opus, 3, 0, 2)];
    const first = decide(a);
    expect(decide([...a].reverse())).toEqual(first);
    expect(decide(a)).toEqual(first);
    expect(first.model).toBe('h-1');
  });

  it('breaks a tie between two equally measured models of a tier by model id', () => {
    const h2 = model('h-0', 'haiku', { k: 0.3 });
    const reg = fake([haiku, h2, sonnet]);
    const outcomes = [stat('routine-code', haiku, 20, 0, 0.05), stat('routine-code', h2, 20, 0, 0.05)];
    const d = route({ workKind: 'routine-code', signals: signals(), registry: reg, policy: policy(), outcomes });
    expect(d.model).toBe('h-0');
    expect(route({ workKind: 'routine-code', signals: signals(), registry: fake([h2, sonnet, haiku]), policy: policy(), outcomes: [...outcomes].reverse() }).model).toBe('h-0');
  });
});

describe('route outcomes in the state database', () => {
  it('records role, effort, difficulty and the attempt it settles, once per attempt', () => {
    const { db, clock } = setup();
    const input = { runId: 'run-1', workKind: 'routine-code' as const, provider: 'claude', modelId: HAIKU, outcome: 'verified' as const, costUsd: 0.4, tokens: 1200, role: 'implementer', effort: 'medium', difficulty: 'simple', attemptKey: 'cand-1', evidenceRef: 'ev-1' };
    const id = recordRouteOutcome(db, input, clock);
    // A step retried after a crash settles the same attempt again: nothing is written, whatever it says this time.
    expect(recordRouteOutcome(db, { ...input, outcome: 'failed' }, clock)).toBe(id);
    expect(db.all('SELECT role, effort, difficulty, attempt_key, evidence_ref, outcome, cost_usd FROM route_outcomes')).toEqual([
      { role: 'implementer', effort: 'medium', difficulty: 'simple', attempt_key: 'cand-1', evidence_ref: 'ev-1', outcome: 'verified', cost_usd: 0.4 },
    ]);
    // Another attempt of the run is another row; an outcome without a key is always written.
    recordRouteOutcome(db, { ...input, attemptKey: 'cand-2', outcome: 'failed' }, clock);
    recordRouteOutcome(db, { runId: 'run-1', workKind: 'routine-code', provider: 'claude', modelId: HAIKU, outcome: 'verified' }, clock);
    recordRouteOutcome(db, { runId: 'run-1', workKind: 'routine-code', provider: 'claude', modelId: HAIKU, outcome: 'verified' }, clock);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM route_outcomes')!.n).toBe(4);
  });

  it('reads statistics for one difficulty class and one window, and keeps an unknown cost out of the mean', () => {
    const { db, clock } = setup();
    const rec = (difficulty: string | null, outcome: 'verified' | 'failed', costUsd: number | null) => recordRouteOutcome(db, { runId: 'run-1', workKind: 'routine-code', provider: 'claude', modelId: HAIKU, outcome, costUsd, difficulty }, clock);
    rec('simple', 'failed', 9);
    const old = clock.now();
    clock.advance(10 * 86_400_000);
    rec('simple', 'verified', 0.2);
    rec('simple', 'verified', null);
    rec('complex', 'failed', 3);
    rec(null, 'failed', 3);

    const [inWindow] = routeStats(db, { workKind: 'routine-code', difficulty: 'simple', sinceMs: old + 1 });
    expect(inWindow).toMatchObject({ difficulty: 'simple', samples: 2, verified: 2, failed: 0, successRate: 1, costSamples: 1, meanCostUsd: 0.2, runs: 1 });
    expect(inWindow!.firstTs).toBe(clock.now());
    // Without the window the old failure counts; without the class filter every difficulty does.
    expect(routeStats(db, { workKind: 'routine-code', difficulty: 'simple' })[0]).toMatchObject({ samples: 3, verified: 2, failed: 1 });
    expect(routeStats(db, { workKind: 'routine-code' })[0]).toMatchObject({ samples: 5, verified: 2, failed: 3 });
    expect(routeStats(db, { workKind: 'routine-code', difficulty: 'medium' })).toEqual([]);
  });

  it('FR-002: only the attempt a run ended on for an environment or misconfigured-check cause is left out; its other attempts count', () => {
    const { db, clock } = setup();
    for (const [id, cls] of [['run-env', 'environment'], ['run-chk', 'check-misconfigured'], ['run-model', 'model']] as const) {
      createRun(db, { id, repoRoot: '/repo/acme', goal: id, mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
      // The end record names the evidence of the attempt whose failure was the environment's (verifying.ts).
      db.run("UPDATE runs SET state = 'BLOCKED', failure_class = ?, outcome_json = ? WHERE id = ?", cls, JSON.stringify({ report_id: `ev-${id}-last` }), id);
      const rec = (outcome: 'verified' | 'failed' | 'rejected', evidenceRef: string) => recordRouteOutcome(db, { runId: id, workKind: 'routine-code', provider: 'claude', modelId: HAIKU, outcome, costUsd: 0.1, difficulty: 'simple', evidenceRef }, clock);
      rec('failed', `ev-${id}-first`);
      rec('rejected', 'review-gate:t');
      rec('verified', 'review-gate:u');
      rec('failed', `ev-${id}-last`);
    }
    // Left out: the last attempt of run-env and of run-chk. Earlier real failures and review rejections of those runs
    // count, and in run-model the last failure was the model's.
    expect(routeStats(db, { workKind: 'routine-code', difficulty: 'simple' })[0]).toMatchObject({ samples: 10, verified: 3, failed: 4, rejected: 3, successRate: 0.3 });
    // The rows are kept: the record of what happened is not rewritten.
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM route_outcomes')!.n).toBe(12);
  });
});
