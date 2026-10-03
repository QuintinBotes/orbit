import { describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { estimateCost, recordRouteOutcome, recordUsage, routeStats, summarizeUsage } from '../../../src/routing/usage.ts';
import type { UsageReport } from '../../../src/adapters/types.ts';
import { HAIKU, OPUS, SONNET, setup } from './fixtures.ts';

const SONNET_PRICING = { input: 2, output: 10, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.2 };

function report(patch: Partial<UsageReport>): UsageReport {
  return {
    provider: 'claude',
    model: SONNET,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    costSource: 'unavailable',
    ...patch,
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? err.code : String(err);
  }
  return undefined;
}

describe('estimateCost', () => {
  it('prices tokens per MTok and labels the figure estimated', () => {
    const est = estimateCost({ inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 50_000, cacheWriteTokens: 10_000 }, SONNET_PRICING);
    // 0.2 input + 0.1 output + 0.01 cache read + 0.04 cache write at the 1h rate
    expect(est).toEqual({ costUsd: 0.35, costSource: 'estimated', missing: [], assumptions: ['cache writes priced at the 1h rate because the TTL is not reported'] });
    expect(estimateCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10_000 }, SONNET_PRICING, { cacheWriteTtl: '5m' }).costUsd).toBe(0.025);
  });

  it('subtracts cached tokens when the provider counts them inside input', () => {
    const tokens = { inputTokens: 24_763, outputTokens: 122, cacheReadTokens: 24_448, cacheWriteTokens: 0 };
    const inclusive = estimateCost(tokens, SONNET_PRICING, { inputIncludesCacheRead: true }).costUsd!;
    const exclusive = estimateCost(tokens, SONNET_PRICING).costUsd!;
    expect(inclusive).toBeCloseTo((315 * 2 + 122 * 10 + 24_448 * 0.2) / 1e6, 6);
    expect(exclusive).toBeGreaterThan(inclusive);
  });

  it('is unavailable without pricing or tokens, and reports unknown fields counted as zero', () => {
    expect(estimateCost({ inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, null)).toMatchObject({ costUsd: null, costSource: 'unavailable', missing: ['pricing'] });
    expect(estimateCost({ inputTokens: null, outputTokens: null, cacheReadTokens: 5, cacheWriteTokens: 0 }, SONNET_PRICING)).toMatchObject({ costUsd: null, missing: ['tokens'] });
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }, SONNET_PRICING)).toMatchObject({
      costUsd: 2,
      missing: ['outputTokens', 'cacheReadTokens', 'cacheWriteTokens'],
    });
  });
});

describe('recordUsage', () => {
  it('keeps a reported cost as reported', () => {
    const { db, clock } = setup();
    const r = recordUsage(db, { runId: 'run-1', workerId: 'w1', usage: report({ inputTokens: 10, outputTokens: 5, costUsd: 0.42, costSource: 'reported' }), durationMs: 1200 }, clock);
    expect(r).toMatchObject({ costUsd: 0.42, costSource: 'reported', provider: 'claude', model: SONNET });
    const row = db.get<{ cost_usd: number; cost_source: string; duration_ms: number; ts: number }>('SELECT * FROM usage WHERE id = ?', r.id)!;
    expect(row).toMatchObject({ cost_usd: 0.42, cost_source: 'reported', duration_ms: 1200, ts: clock.now() });
  });

  it('estimates from registry pricing when the provider gave tokens but no cost', () => {
    const { db, clock } = setup();
    const r = recordUsage(
      db,
      { runId: 'run-1', workerId: 'w1', usage: report({ model: 'haiku', inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }), durationMs: null },
      clock,
    );
    expect(r).toMatchObject({ costUsd: 1.5, costSource: 'estimated' });
    expect(registryPricingUsed(r.notes)).toBe(true);
  });

  it('records unavailable cost for codex usage (no pricing) and for missing usage, never zero', () => {
    const { db, clock } = setup();
    const codex = recordUsage(
      db,
      { runId: 'run-1', workerId: 'w2', usage: report({ provider: 'codex', model: 'codex-alpha', inputTokens: 1234, outputTokens: 56, cacheReadTokens: 1000, cacheWriteTokens: 0 }), durationMs: 5 },
      clock,
    );
    expect(codex).toMatchObject({ costUsd: null, costSource: 'unavailable' });
    expect(codex.notes.join(' ')).toMatch(/no pricing/);
    const failed = recordUsage(db, { runId: 'run-1', workerId: 'w3', provider: 'codex', model: 'codex-alpha', usage: null, durationMs: null }, clock);
    expect(failed).toMatchObject({ costUsd: null, costSource: 'unavailable', notes: ['provider reported no usage'] });
    const row = db.get<{ input_tokens: number | null; cost_usd: number | null }>('SELECT input_tokens, cost_usd FROM usage WHERE id = ?', failed.id)!;
    expect(row).toEqual({ input_tokens: null, cost_usd: null });
  });

  it('can be forbidden to estimate, and flags a claimed cost source with no cost', () => {
    const { db, clock } = setup();
    const r = recordUsage(db, { runId: 'run-1', workerId: null, usage: report({ inputTokens: 10, outputTokens: 10, costSource: 'reported' }), durationMs: null, pricing: null }, clock);
    expect(r.costSource).toBe('unavailable');
    expect(r.notes[0]).toMatch(/claimed cost source 'reported' without a cost/);
  });

  it('requires a provider', () => {
    const { db, clock } = setup();
    expect(code(() => recordUsage(db, { runId: 'run-1', workerId: null, usage: null, durationMs: null }, clock))).toBe('SCHEMA_INVALID');
  });
});

describe('summarizeUsage', () => {
  it('totals by provider and model, lists unavailable cost explicitly, and computes cache hit ratio per token semantics', () => {
    const { db, clock } = setup();
    recordUsage(db, { runId: 'run-1', workerId: 'w1', usage: report({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 3000, cacheWriteTokens: 0, costUsd: 0.5, costSource: 'reported' }), durationMs: 100 }, clock);
    recordUsage(db, { runId: 'run-1', workerId: 'w2', usage: report({ model: OPUS, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), durationMs: 50 }, clock);
    // codex: cached tokens are inside input_tokens, so the hit ratio is 1000/1234.
    recordUsage(db, { runId: 'run-1', workerId: 'w3', usage: report({ provider: 'codex', model: 'codex-alpha', inputTokens: 1234, outputTokens: 56, cacheReadTokens: 1000, cacheWriteTokens: 0 }), durationMs: 10 }, clock);
    recordUsage(db, { runId: 'run-1', workerId: 'w4', provider: 'codex', model: 'codex-alpha', usage: null, durationMs: null }, clock);
    const s = summarizeUsage(db, 'run-1');
    expect(s.totals.records).toBe(4);
    expect(s.totals.costUsd).toBe(4.5);
    expect(s.totals.reportedCostUsd).toBe(0.5);
    expect(s.totals.estimatedCostUsd).toBe(4);
    expect(s.totals.bySource).toEqual({ reported: 1, estimated: 1, unavailable: 2 });
    expect(s.costComplete).toBe(false);
    expect(s.unavailableCost.map((u) => u.workerId)).toEqual(['w3', 'w4']);
    expect(s.note).toMatch(/cost unavailable for 2 of 4 record\(s\)/);
    const sonnet = s.byProviderModel.find((g) => g.model === SONNET)!;
    expect(sonnet.cacheHitRatio).toBe(0.75);
    const codex = s.byProviderModel.find((g) => g.provider === 'codex')!;
    expect(codex.records).toBe(2);
    expect(codex.cacheHitRatio).toBeCloseTo(1000 / 1234, 4);
    expect(s.totals.cacheHitRatio).toBeCloseTo(4000 / (4000 + 1_000_000 + 1234), 4);
  });

  it('reports an empty run plainly', () => {
    const { db } = setup();
    const s = summarizeUsage(db, 'run-1');
    expect(s.totals.records).toBe(0);
    expect(s.totals.cacheHitRatio).toBeNull();
    expect(s.costComplete).toBe(true);
    expect(s.note).toBe('no usage recorded');
  });
});

describe('route outcomes', () => {
  it('aggregates success rate over judged outcomes and mean cost over known costs', () => {
    const { db, clock } = setup();
    const add = (outcome: 'verified' | 'failed' | 'rejected' | 'error', costUsd: number | null, modelId = SONNET) =>
      recordRouteOutcome(db, { runId: 'run-1', workKind: 'routine-code', provider: 'claude', modelId, outcome, costUsd, tokens: 1000 }, clock);
    add('verified', 1);
    add('verified', 3);
    add('failed', null);
    add('rejected', 2);
    add('error', null);
    add('verified', 0.1, HAIKU);
    recordRouteOutcome(db, { runId: 'run-1', workKind: 'extraction', provider: 'claude', modelId: HAIKU, outcome: 'verified' }, clock);
    const stats = routeStats(db, { workKind: 'routine-code' });
    expect(stats).toHaveLength(2);
    const sonnet = stats.find((s) => s.modelId === SONNET)!;
    expect(sonnet).toMatchObject({ samples: 5, verified: 2, failed: 1, rejected: 1, errors: 1, costSamples: 3, meanCostUsd: 2, meanTokens: 1000 });
    expect(sonnet.successRate).toBeCloseTo(0.5, 6);
    expect(routeStats(db)).toHaveLength(3);
    expect(routeStats(db, { modelId: HAIKU, workKind: 'extraction' })[0]).toMatchObject({ meanCostUsd: null, costSamples: 0 });
    clock.advance(1000);
    expect(routeStats(db, { sinceMs: clock.now() })).toEqual([]);
  });

  it('rejects unknown work kinds and outcomes', () => {
    const { db, clock } = setup();
    expect(code(() => recordRouteOutcome(db, { runId: 'run-1', workKind: 'poetry' as never, provider: 'claude', modelId: SONNET, outcome: 'verified' }, clock))).toBe('SCHEMA_INVALID');
    expect(code(() => recordRouteOutcome(db, { runId: 'run-1', workKind: 'extraction', provider: 'claude', modelId: SONNET, outcome: 'great' as never }, clock))).toBe('SCHEMA_INVALID');
  });
});

function registryPricingUsed(notes: string[]): boolean {
  return !notes.some((n) => n.startsWith('cost unavailable'));
}
