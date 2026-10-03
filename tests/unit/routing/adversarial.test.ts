import { describe, expect, it } from 'vitest';
import { route } from '../../../src/routing/router.ts';
import { worstCaseRequestUsd } from '../../../src/routing/registry.ts';
import { HAIKU, OPUS, SONNET, policy, setup, signals } from './fixtures.ts';

/**
 * Defects found by the adversarial verification pass. Each test failed
 * against the first implementation.
 */

describe('worst-case request headroom', () => {
  it('prices a full context at the dearest prompt rate, because one request can write the whole context to the cache', () => {
    const { registry } = setup();
    // 1M tokens written to the 1 hour cache at $8 + 128k output at $20.
    expect(worstCaseRequestUsd(registry.get(OPUS)!)).toBe(10.56);
    // A model whose base input rate is the dearest still uses it.
    expect(worstCaseRequestUsd({ pricing: { input: 9, output: 1, cache_write_5m: 2, cache_write_1h: 3, cache_read: 0.1 }, limits: { contextTokens: 1_000_000, maxOutputTokens: 0, cliMaxOutputTokens: null, observedAt: null } })).toBe(9);
  });
});

describe('repeated-failure escalation needs recorded evidence', () => {
  it('does not escalate on a bare repeated-failure count with no evidence references, and says why', () => {
    const { registry } = setup();
    const d = route({ workKind: 'routine-code', signals: signals({ attempt: 3, repeatedFingerprints: 4 }), registry, policy: policy() });
    expect(d.model).toBe(SONNET);
    expect(d.escalated_from).toBeUndefined();
    expect(d.justification.signals).toEqual([]);
    expect(d.justification.ignored.join(' ')).toMatch(/4 repeated equivalent failures reported without evidence references/);
    // The same count backed by failure records escalates.
    const backed = route({ workKind: 'routine-code', signals: signals({ attempt: 3, repeatedFingerprints: 4, evidence: ['failure:fp-1'] }), registry, policy: policy() });
    expect(backed.model).toBe(OPUS);
    expect(backed.justification.signals[0]).toMatchObject({ signal: 'repeated-equivalent-failures', evidence: ['failure:fp-1'] });
  });

  it('applies the same rule to extraction and screenshots', () => {
    const { registry } = setup();
    expect(route({ workKind: 'extraction', signals: signals({ repeatedFingerprints: 3 }), registry, policy: policy() }).model).toBe(HAIKU);
    expect(route({ workKind: 'screenshot', signals: signals({ repeatedFingerprints: 3 }), registry, policy: policy() }).model).toBe(HAIKU);
  });

  it('still refuses to down-route while equivalent failures repeat, evidence or not', () => {
    const { registry } = setup();
    const d = route({
      workKind: 'routine-code',
      signals: signals({ attempt: 5, diagnosisSolved: true, repeatedFingerprints: 3, previousRoute: { provider: 'claude', model: OPUS, outcome: 'failed' } }),
      registry,
      policy: policy(),
    });
    expect(d.model).toBe(OPUS);
    expect(d.down_routed_from).toBeUndefined();
    expect(d.reason).toMatch(/equivalent failures still repeat/);
  });
});

describe('registry identity cannot be hijacked by runtime input', () => {
  it('never lets a codex catalog slug overwrite or disable a model of another provider', () => {
    const { registry } = setup();
    const r = registry.registerCodexCatalog(
      { models: [{ slug: OPUS, visibility: 'list', priority: 0, supported_reasoning_levels: [{ effort: 'low' }] }, { slug: SONNET, visibility: 'hide' }, { slug: 'codex-alpha', visibility: 'list', priority: 1 }] },
      { source: 'live' },
    );
    expect(r.conflicting).toEqual([OPUS, SONNET]);
    expect(r.listed).toEqual(['codex-alpha']);
    expect(r.providerDefault).toBe('codex-alpha');
    const opus = registry.get(OPUS)!;
    expect(opus.provider).toBe('claude');
    expect(opus.pricing?.input).toBe(4);
    expect(opus.surfaces.map((s) => s.surface)).toEqual(['claude-cli']);
    expect(registry.get(SONNET)!.surfaces.map((s) => s.surface)).toEqual(['claude-cli']);
  });

  it('never learns an alias that already names a different model, so an allow-list entry for one model cannot authorize another', () => {
    const { registry } = setup();
    registry.refreshFromUsage({ [OPUS]: { canonicalModel: HAIKU, contextWindow: 200_000 } });
    expect(registry.get(HAIKU)!.eligibility.aliases).not.toContain(OPUS);
    expect(registry.eligible({ surface: 'claude-cli', allowedModels: [OPUS] }).map((m) => m.modelId)).toEqual([OPUS]);
    expect(registry.resolve(OPUS)).toBe(OPUS);
  });
});

describe('a predicted difficulty class is not observed difficulty', () => {
  it('keeps complex routine code on Sonnet at raised effort until something is observed', () => {
    const { registry } = setup();
    const d = route({ workKind: 'routine-code', signals: signals({ difficulty: 'complex' }), registry, policy: policy() });
    expect(d.model).toBe(SONNET);
    expect(d.effort).toBe('high');
    expect(d.escalated_from).toBeUndefined();
    expect(d.justification.signals).toEqual([]);
    expect(d.reason).toMatch(/complex classification raises effort, not tier/);
    // The router's own priors agree: Sonnet is the cheaper route per verified task.
    const opus = d.alternatives_considered.find((a) => a.model === OPUS)!;
    expect(opus.expected_cost_per_verified_task!).toBeGreaterThan(d.expected_cost_per_verified_task!);
  });
});
