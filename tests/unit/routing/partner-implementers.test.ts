/**
 * Issue #176: Codex and Muse can implement bounded work. Routing is pure, so every rule is a decision of route().
 *
 * US1 scenario 1: with policy that lets Codex implement, a bounded unit is routed to it.
 * US1 scenario 2: a partner whose candidates failed verification twice hands the third attempt to Claude.
 * Edge cases: partners set to none route everything to Claude; a skipped partner (quota, login) is passed over for the
 * rest of the run; FR-004: measured outcomes below the floor drop a partner.
 */
import { describe, expect, it } from 'vitest';
import { PARTNER_MAX_FAILURES, route } from '../../../src/routing/router.ts';
import type { RouteStat, RoutingPolicy } from '../../../src/routing/types.ts';
import type { RouteSignals } from '../../../src/routing/types.ts';
import { HAIKU, OPUS, SONNET, policy, setup, signals as anySignals } from './fixtures.ts';

/** An implementation attempt's signals, as routeFor gives them for `implement:<n>`. */
const signals = (patch: Partial<RouteSignals> = {}): RouteSignals => anySignals({ implementation: true, ...patch });

function partners(implementers: string[], patch: Partial<RoutingPolicy['providers']> = {}): RoutingPolicy {
  return policy({
    routing: { allowed_models: [HAIKU, SONNET, OPUS], overrides: {}, implementers },
    providers: {
      claude: { model: null, data_policy_eligible: true, reasoning_effort: null },
      codex: { model: 'codex-alpha', data_policy_eligible: true, reasoning_effort: 'high' },
      muse: { model: 'muse-wonder-full-1.0', data_policy_eligible: true, reasoning_effort: 'high' },
      ...patch,
    } as RoutingPolicy['providers'],
  });
}

describe('issue #176: partner implementers', () => {
  it('US1 scenario 1: policy that lets Codex implement routes a bounded unit to it, on its configured model and effort', () => {
    const { registry } = setup();
    const d = route({ workKind: 'routine-code', signals: signals(), registry, policy: partners(['codex', 'claude']) });
    expect(d).toMatchObject({ provider: 'codex', model: 'codex-alpha', surface: 'codex-cli', effort: 'high', work_kind: 'routine-code' });
    expect(d.reason).toMatch(/routing\.implementers lets codex implement routine-code/);
    expect(d.reason).toMatch(/Claude's verification decides whether its candidate is kept/);
    // Muse comes next in the list only when Codex may not.
    const muse = route({ workKind: 'focused-tests', signals: signals({ partnersSkipped: { codex: 'out of quota' } }), registry, policy: partners(['codex', 'muse']) });
    expect(muse).toMatchObject({ provider: 'muse', model: 'muse-wonder-full-1.0', surface: 'muse-cli' });
    expect(muse.alternatives_considered).toEqual([expect.objectContaining({ provider: 'codex', eligible: false, rejected_because: 'skipped for the rest of this run: out of quota' })]);
  });

  it('US1 scenario 2: a partner whose candidates failed verification twice hands the third attempt to Claude', () => {
    const { registry } = setup();
    const p = partners(['codex']);
    const second = route({ workKind: 'routine-code', signals: signals({ attempt: 2, partnerFailures: { codex: 1 } }), registry, policy: p });
    expect(second.provider).toBe('codex');
    expect(PARTNER_MAX_FAILURES).toBe(2);
    const third = route({ workKind: 'routine-code', signals: signals({ attempt: 3, partnerFailures: { codex: 2 }, previousRoute: { provider: 'codex', model: 'codex-alpha', outcome: 'failed' } }), registry, policy: p });
    expect(third.provider).toBe('claude');
    expect(third.surface).toBe('claude-cli');
    expect(third.justification.ignored.join(' ')).toMatch(/codex 2 of its candidates in this run failed verification or review; Claude implements/);
  });

  it('edge case: partners set to none (the default, Claude only) route everything to Claude', () => {
    const { registry } = setup();
    for (const implementers of [['claude'], []]) {
      const d = route({ workKind: 'routine-code', signals: signals(), registry, policy: partners(implementers) });
      expect(d.provider).toBe('claude');
      expect(d.justification.ignored.join(' ')).not.toMatch(/partner/);
    }
    // A snapshot written before the key existed reads Claude only.
    expect(route({ workKind: 'routine-code', signals: signals(), registry, policy: policy() }).provider).toBe('claude');
  });

  it('edge case: a partner skipped for the run is passed over without costing anything, and Claude takes the attempt', () => {
    const { registry } = setup();
    const d = route({ workKind: 'routine-code', signals: signals({ partnersSkipped: { codex: 'out of quota: usage limit reached' } }), registry, policy: partners(['codex']) });
    expect(d.provider).toBe('claude');
    expect(d.justification.ignored.join(' ')).toMatch(/codex skipped for the rest of this run: out of quota: usage limit reached/);
  });

  it('a partner the data policy does not cover, or without a model, never implements; work that is not a bounded unit stays on Claude', () => {
    const { registry } = setup();
    const ineligible = route({ workKind: 'routine-code', signals: signals(), registry, policy: partners(['codex'], { codex: { model: 'codex-alpha', data_policy_eligible: false, reasoning_effort: null } }) });
    expect(ineligible.provider).toBe('claude');
    expect(ineligible.justification.ignored.join(' ')).toMatch(/providers\.codex\.data_policy_eligible is not true/);
    const noModel = route({ workKind: 'routine-code', signals: signals(), registry, policy: partners(['codex'], { codex: { model: null, data_policy_eligible: true, reasoning_effort: null } }) });
    expect(noModel.provider).toBe('claude');
    for (const workKind of ['architecture', 'complex-diagnosis', 'long-horizon', 'extraction'] as const) {
      const d = route({ workKind, signals: signals(), registry, policy: partners(['codex']) });
      expect(d.provider, workKind).toBe('claude');
      expect(d.justification.ignored.join(' '), workKind).toMatch(/is not a bounded unit a partner implements/);
    }
    // A planner, a diagnosis or an inquiry of routine work is not an implementation attempt: it never goes to a partner.
    expect(route({ workKind: 'routine-code', signals: anySignals(), registry, policy: partners(['codex']) }).provider).toBe('claude');
    expect(route({ workKind: 'focused-tests', signals: anySignals(), registry, policy: partners(['codex']) }).provider).toBe('claude');
  });

  it('FR-004: measured outcomes of the task class drop a partner below the pass-rate floor, and never decide below min_samples', () => {
    const { registry } = setup();
    const stat = (verified: number, failed: number): RouteStat => ({ workKind: 'routine-code', provider: 'codex', modelId: 'codex-alpha', samples: verified + failed, verified, failed, rejected: 0, errors: 0, successRate: verified / (verified + failed), meanCostUsd: null, costSamples: 0, meanTokens: null, difficulty: 'simple' });
    const p = partners(['codex']);
    p.routing.learning = { enabled: true, min_samples: 10, min_pass_rate: 0.7, window_days: 30 };
    const dropped = route({ workKind: 'routine-code', signals: signals(), registry, policy: p, outcomes: [stat(3, 9)] });
    expect(dropped.provider).toBe('claude');
    expect(dropped.justification.ignored.join(' ')).toMatch(/measured pass rate 25% over 12 outcomes of routine-code \(simple\) is below 70%/);
    expect(route({ workKind: 'routine-code', signals: signals(), registry, policy: p, outcomes: [stat(1, 5)] }).provider).toBe('codex');
    expect(route({ workKind: 'routine-code', signals: signals(), registry, policy: p, outcomes: [stat(9, 3)] }).provider).toBe('codex');
  });
});
