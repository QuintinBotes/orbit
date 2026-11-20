/** `orbit export --otel` (issue #178, FR-003): OTLP/JSON traces of a run under the pinned GenAI conventions, built from the durable records only. */
import { afterEach, describe, expect, it } from 'vitest';
import { getRun } from '../../../src/controller/run-store.ts';
import { exportRunOtel, OTEL_SCHEMA_URL, type OtlpSpan } from '../../../src/observability/otel.ts';
import { recordUsage } from '../../../src/routing/usage.ts';
import { makeLab, type Lab } from '../cli/lab.ts';
import { buildFullRun, startFixture, T0, worker } from '../cli/timeline-fixture.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  return l;
}

const attr = (s: OtlpSpan, key: string) => s.attributes.find((a) => a.key === key)?.value;
const ns = (ms: number) => `${ms}000000`;

describe('exportRunOtel', () => {
  it('is deterministic and times each span from its records, with a span per worker under the run', () => {
    const l = lab();
    const fx = buildFullRun(l);
    const run = getRun(l.db(), fx.runId);
    const otlp = exportRunOtel(l.db(), run, T0 + 999_000);
    expect(exportRunOtel(l.db(), run, T0 + 999_000)).toEqual(otlp);
    expect(otlp.resourceSpans[0]!.schemaUrl).toBe(OTEL_SCHEMA_URL);
    const spans = otlp.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.map((s) => s.name)).toEqual(['orbit run', 'invoke_agent implementer', 'invoke_agent implementer', 'invoke_agent reviewer']);
    const [root, impl1, impl2, rev] = spans as [OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan];
    expect(root).toMatchObject({ kind: 1, startTimeUnixNano: ns(run.createdAt), endTimeUnixNano: ns(run.endedAt!), status: { code: 0 } });
    expect(root.parentSpanId).toBeUndefined();
    // Spawned one second after it was planned, finished 39 seconds later.
    expect(impl1).toMatchObject({ parentSpanId: root.spanId, kind: 3, startTimeUnixNano: ns(T0 + 74_000), endTimeUnixNano: ns(T0 + 113_000), status: { code: 0 } });
    expect(attr(impl1, 'gen_ai.request.model')).toEqual({ stringValue: 'claude-sonnet-4-6' });
    expect(attr(impl1, 'gen_ai.usage.input_tokens')).toEqual({ intValue: '1200' });
    expect(attr(impl1, 'gen_ai.usage.output_tokens')).toEqual({ intValue: '300' });
    expect(attr(impl1, 'orbit.cost_usd')).toEqual({ doubleValue: 0.12 });
    expect(attr(impl1, 'orbit.cost_source')).toEqual({ stringValue: 'reported' });
    expect(attr(impl1, 'orbit.attempt')).toEqual({ intValue: '1' });
    // The session that reported no cost: absent, and said to be, never 0.
    expect(attr(impl2, 'orbit.cost_usd')).toBeUndefined();
    expect(attr(impl2, 'orbit.cost_source')).toEqual({ stringValue: 'unavailable' });
    expect(attr(rev, 'gen_ai.provider.name')).toEqual({ stringValue: 'openai' });
    expect(attr(rev, 'gen_ai.request.model')).toEqual({ stringValue: 'gpt-6.1-sol' });
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(4);
    expect(JSON.stringify(otlp)).not.toContain('Add a mul function');
  });

  it('marks a worker that failed as an error with its error type, and ends what is still open at the export time', () => {
    const l = lab();
    const fx = startFixture(l);
    worker(fx, 'w-plan-1', 'planner', 'claude', 'claude-sonnet-4-6', null, 10, 'FAILED', 0.01);
    const run = getRun(l.db(), fx.runId);
    const otlp = exportRunOtel(l.db(), run, T0 + 600_000);
    const [root, plan] = otlp.resourceSpans[0]!.scopeSpans[0]!.spans as [OtlpSpan, OtlpSpan];
    expect(root.endTimeUnixNano).toBe(ns(T0 + 600_000));
    // No message: a worker's error can quote provider output, which an export never carries.
    expect(plan.status).toEqual({ code: 2 });
    expect(attr(plan, 'error.type')).toEqual({ stringValue: 'max_turns' });
    expect(attr(plan, 'gen_ai.agent.name')).toEqual({ stringValue: 'planner' });
  });

  it('counts cached prompt tokens once for a provider id of the codex family, whose input already holds them', () => {
    const l = lab();
    const fx = startFixture(l);
    worker(fx, 'w-rev-1', 'reviewer', 'codex-fast', 'gpt-6.1-sol', null, 10, 'SUCCEEDED', null);
    recordUsage(fx.db, { runId: fx.runId, workerId: 'w-rev-1', usage: { provider: 'codex-fast', model: 'gpt-6.1-sol', inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 0, costUsd: null, costSource: 'unavailable' }, durationMs: 1000, pricing: null }, fx.clock);
    const [, rev] = exportRunOtel(fx.db, getRun(fx.db, fx.runId), T0 + 600_000).resourceSpans[0]!.scopeSpans[0]!.spans as [OtlpSpan, OtlpSpan];
    expect(attr(rev, 'gen_ai.provider.name')).toEqual({ stringValue: 'openai' });
    expect(attr(rev, 'gen_ai.usage.input_tokens')).toEqual({ intValue: '2200' });
  });
});
