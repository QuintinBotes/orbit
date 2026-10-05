import { describe, expect, it } from 'vitest';
import { recordRouteOutcome, recordUsage, routeStats, summarizeUsage } from '../../../src/routing/usage.ts';
import type { UsageReport } from '../../../src/adapters/types.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { SONNET, setup } from './fixtures.ts';

const PRICING = { input: 2, output: 10, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.2 };

function report(patch: Partial<UsageReport>): UsageReport {
  return { provider: 'claude', model: SONNET, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable', ...patch };
}

describe('recordUsage details', () => {
  it('lets an explicit null model override the report and skips registry pricing for it', () => {
    const { db, clock } = setup();
    const r = recordUsage(db, { runId: 'run-1', workerId: null, model: null, usage: report({ inputTokens: 1000, outputTokens: 10 }), durationMs: null }, clock);
    expect(r.model).toBeNull();
    expect(r).toMatchObject({ costUsd: null, costSource: 'unavailable' });
    expect(r.notes.join(' ')).toMatch(/cost unavailable: no pricing/);
  });

  it('keeps a cost the provider labelled as an estimate', () => {
    const { db, clock } = setup();
    const r = recordUsage(db, { runId: 'run-1', workerId: null, usage: report({ costUsd: 0.1, costSource: 'estimated' }), durationMs: null }, clock);
    expect(r).toMatchObject({ costUsd: 0.1, costSource: 'estimated' });
  });

  it('prices from an explicit pricing argument without consulting the registry', () => {
    const { db, clock } = setup();
    const r = recordUsage(db, { runId: 'run-1', workerId: null, model: 'not-in-registry', usage: report({ model: 'not-in-registry', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), durationMs: null, pricing: PRICING }, clock);
    expect(r).toMatchObject({ costUsd: 2, costSource: 'estimated' });
  });

  it('notes tokens counted as zero when some fields are missing', () => {
    const { db, clock } = setup();
    const r = recordUsage(db, { runId: 'run-1', workerId: null, usage: report({ inputTokens: 1000 }), durationMs: null, pricing: PRICING }, clock);
    expect(r.costSource).toBe('estimated');
    expect(r.notes.some((n) => n.startsWith('estimate counts unknown'))).toBe(true);
  });

  it('takes the output budget from the report and names the role found for the worker', () => {
    const { db, clock } = setup();
    db.run("INSERT INTO workers (id, run_id, role, provider, state, worker_dir, cwd, created_at) VALUES ('w-impl', 'run-1', 'implementer', 'claude', 'running', '/w', '/c', 1)");
    const r = recordUsage(db, { runId: 'run-1', workerId: 'w-impl', usage: report({ outputTokens: 50, outputBudgetTokens: 10 }), durationMs: null }, clock);
    expect(r.outputBudgetExceeded).toBe(true);
    expect(r.notes).toContain('output 50 tokens exceeded the 10 token budget for implementer');
  });

  it('records an overrun without a role when none is known, and honours a null budget override', () => {
    const { db, clock } = setup();
    const over = recordUsage(db, { runId: 'run-1', workerId: 'w-unknown', usage: report({ outputTokens: 50 }), outputBudgetTokens: 10, durationMs: null }, clock);
    expect(over.notes).toContain('output 50 tokens exceeded the 10 token budget');
    const none = recordUsage(db, { runId: 'run-1', workerId: null, usage: report({ outputTokens: 50, outputBudgetTokens: 10 }), outputBudgetTokens: null, durationMs: null }, clock);
    expect(none.outputBudgetExceeded).toBe(false);
    const zero = recordUsage(db, { runId: 'run-1', workerId: null, usage: report({ outputTokens: 50 }), outputBudgetTokens: 0, durationMs: null }, clock);
    expect(zero.outputBudgetExceeded).toBe(false);
  });

  it('prefers an explicit first-event latency of null over the report', () => {
    const { db, clock, registry } = setup();
    recordUsage(db, { runId: 'run-1', workerId: null, usage: report({ timeToFirstEventMs: 900 }), timeToFirstEventMs: null, durationMs: null }, clock);
    expect(registry.get(SONNET)?.latencyMs ?? null).toBeNull();
  });
});

describe('summarizeUsage details', () => {
  it('describes a run whose every cost was estimated, and groups a record with no model apart', () => {
    const { db, clock } = setup();
    recordUsage(db, { runId: 'run-1', workerId: null, usage: report({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), durationMs: null, pricing: PRICING }, clock);
    const s = summarizeUsage(db, 'run-1');
    expect(s.costComplete).toBe(true);
    expect(s.note).toBe('cost includes 1 estimated record(s) priced from tokens and registry pricing');
    recordUsage(db, { runId: 'run-1', workerId: null, model: null, usage: report({ costUsd: 1, costSource: 'reported', inputTokens: 100, outputTokens: 1 }), durationMs: null }, clock);
    const mixed = summarizeUsage(db, 'run-1');
    expect(mixed.byProviderModel.map((g) => g.model)).toEqual([SONNET, null]);
  });

  it('says every cost was reported when none was estimated', () => {
    const { db, clock } = setup();
    recordUsage(db, { runId: 'run-1', workerId: null, usage: report({ costUsd: 1, costSource: 'reported', inputTokens: 10, outputTokens: 1 }), durationMs: null }, clock);
    expect(summarizeUsage(db, 'run-1').note).toBe('cost reported by providers for every record');
  });

  it('leaves the cache hit ratio unknown when no record reported input tokens', () => {
    const { db, clock } = setup();
    recordUsage(db, { runId: 'run-1', workerId: null, provider: 'codex', model: 'codex-alpha', usage: null, durationMs: null }, clock);
    const s = summarizeUsage(db, 'run-1');
    expect(s.totals.cacheHitRatio).toBeNull();
    expect(s.byProviderModel[0]?.cacheHitRatio).toBeNull();
  });

  it('counts cache writes toward the prompt for a provider whose input includes cache reads', () => {
    const { db, clock } = setup();
    recordUsage(db, { runId: 'run-1', workerId: null, provider: 'codex', model: 'codex-alpha', usage: report({ provider: 'codex', model: 'codex-alpha', inputTokens: 800, outputTokens: 1, cacheReadTokens: 400, cacheWriteTokens: 200 }), durationMs: null }, clock);
    expect(summarizeUsage(db, 'run-1').totals.cacheHitRatio).toBe(0.4);
  });

  it('treats a cost without a recognised source as unavailable', () => {
    const { db, clock } = setup();
    const { id } = recordUsage(db, { runId: 'run-1', workerId: null, usage: report({ costUsd: 1, costSource: 'reported', inputTokens: 1, outputTokens: 1 }), durationMs: null }, clock);
    db.run("UPDATE usage SET cost_source = 'unavailable' WHERE id = ?", id);
    const s = summarizeUsage(db, 'run-1');
    expect(s.totals.bySource).toEqual({ reported: 0, estimated: 0, unavailable: 1 });
    expect(s.costComplete).toBe(false);
  });
});

describe('route outcomes details', () => {
  it('requires a provider and a model', () => {
    const { db, clock } = setup();
    for (const patch of [{ provider: '' }, { modelId: '' }]) {
      try {
        recordRouteOutcome(db, { runId: 'run-1', workKind: 'routine-code', provider: 'claude', modelId: SONNET, outcome: 'verified', ...patch }, clock);
        expect.unreachable();
      } catch (err) {
        expect(isOrbitError(err, 'SCHEMA_INVALID')).toBe(true);
        expect((err as Error).message).toBe('route outcome needs a provider and a model');
      }
    }
  });

  it('filters statistics by provider, model and time, and keeps unmeasured means null', () => {
    const { db, clock } = setup();
    recordRouteOutcome(db, { runId: 'run-1', workKind: 'routine-code', provider: 'claude', modelId: SONNET, outcome: 'verified', costUsd: 0.5, tokens: 100 }, clock);
    clock.advance(1000);
    recordRouteOutcome(db, { runId: 'run-1', workKind: 'extraction', provider: 'codex', modelId: 'codex-alpha', outcome: 'error', costUsd: -1, tokens: Number.NaN }, clock);
    expect(routeStats(db, { provider: 'codex' }).map((s) => s.modelId)).toEqual(['codex-alpha']);
    expect(routeStats(db, { modelId: SONNET }).map((s) => s.provider)).toEqual(['claude']);
    expect(routeStats(db, { sinceMs: clock.now() }).map((s) => s.modelId)).toEqual(['codex-alpha']);
    const [codex] = routeStats(db, { workKind: 'extraction' });
    expect(codex).toMatchObject({ errors: 1, successRate: null, meanCostUsd: null, meanTokens: null, costSamples: 0 });
  });
});
