import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { ModelRegistry, allowMatch, defaultSeed, parseCodexCatalog, parseSeedFile, tierOf, worstCaseRequestUsd } from '../../../src/routing/registry.ts';
import { CLAUDE_MODELS, FABLE, HAIKU, OPUS, SONNET, codexCatalog, setup } from './fixtures.ts';

function bare() {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  const registry = new ModelRegistry(db, clock);
  registry.seed();
  return { db, clock, registry };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(isOrbitError(err) ? err.code : err).toBe(code);
    return;
  }
  throw new Error(`expected OrbitError ${code}`);
}

describe('data/models.json seed', () => {
  const raw = JSON.parse(readFileSync(new URL('../../../data/models.json', import.meta.url), 'utf8'));

  it('validates and carries the four seeded models with exact ids', () => {
    const seed = parseSeedFile(raw);
    expect(seed.refreshed_at).toBe('2026-09-25');
    expect(seed.models.map((m) => m.model_id).sort()).toEqual([...CLAUDE_MODELS].sort());
  });

  it('marks every pricing field as stated or derived, with cache writes derived', () => {
    for (const m of raw.models) {
      for (const k of ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read']) {
        expect(['stated', 'derived']).toContain(m.provenance[`pricing.${k}`]);
      }
      expect(m.provenance['pricing.cache_write_5m']).toBe('derived');
      expect(m.provenance['pricing.cache_write_1h']).toBe('derived');
    }
    const byId = Object.fromEntries(raw.models.map((m: { model_id: string }) => [m.model_id, m]));
    expect(byId[HAIKU].provenance['pricing.cache_read']).toBe('derived');
    expect(byId[OPUS].provenance['pricing.cache_read']).toBe('stated');
    expect(byId[OPUS].pricing).toEqual({ input: 4, output: 20, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2 });
    expect(byId[HAIKU].limits).toEqual({ context_tokens: 200000, max_output_tokens: 64000 });
    expect(byId[HAIKU].capabilities.effort_levels).toEqual([]);
    expect(byId[FABLE].requires_explicit_policy).toBe(true);
  });

  it('resolves codex models at runtime instead of hardcoding them', () => {
    const codex = raw.runtime_providers.find((p: { provider: string }) => p.provider === 'codex');
    expect(codex.model_resolution.command).toEqual(['codex', 'debug', 'models']);
    expect(codex.model_resolution.provenance).toBe('runtime');
    expect(codex).not.toHaveProperty('model_id');
    expect(codex.capabilities.excluded_efforts).toContain('ultra');
    expect(codex.pricing).toBeNull();
  });

  it('rejects malformed seeds loudly', () => {
    expectCode(() => parseSeedFile({ schema: 'other' }), 'CONFIG_INVALID');
    const dup = structuredClone(raw);
    dup.models.push(structuredClone(dup.models[0]));
    expectCode(() => parseSeedFile(dup), 'CONFIG_INVALID');
    const badPrice = structuredClone(raw);
    delete badPrice.models[0].pricing.cache_read;
    expectCode(() => parseSeedFile(badPrice), 'CONFIG_INVALID');
    const badSurface = structuredClone(raw);
    badSurface.models[0].surfaces = ['api'];
    expectCode(() => parseSeedFile(badSurface), 'CONFIG_INVALID');
  });
});

describe('ModelRegistry seeding and lookup', () => {
  it('seeds models with unknown availability; nothing is assumed available', () => {
    const { registry } = bare();
    const entries = registry.list();
    expect(entries).toHaveLength(4);
    for (const e of entries) {
      expect(e.available).toBe(false);
      expect(e.surfaces).toEqual([{ surface: 'claude-cli', available: null, detail: null, checkedAt: null }]);
    }
    const a = registry.assess({ surface: 'claude-cli', allowedModels: CLAUDE_MODELS });
    expect(a.eligible).toEqual([]);
    expect(a.excluded[0]?.reasons).toContain('availability on claude-cli not yet validated');
  });

  it('resolves ids, snapshot aliases and CLI aliases', () => {
    const { registry } = bare();
    expect(registry.resolve('claude-haiku-4-5')).toBe(HAIKU);
    expect(registry.resolve('haiku')).toBe(HAIKU);
    expect(registry.resolve('OPUS')).toBe(OPUS);
    expect(registry.resolve('fable')).toBe(FABLE);
    expect(registry.resolve('gpt-unknown')).toBeNull();
    expect(registry.get(SONNET)?.pricing?.cache_read).toBe(0.2);
    expect(tierOf(registry.get(SONNET)!)).toBe(2);
  });

  it('records the seed date and keeps runtime learning across a re-seed', () => {
    const { registry, clock } = bare();
    expect(registry.get(OPUS)?.refreshedAt).toBe(Date.parse('2026-09-25'));
    registry.markAvailability(OPUS, 'claude-cli', true, 'ok');
    clock.advance(1000);
    registry.refreshFromUsage({ [OPUS]: { contextWindow: 900_000, maxOutputTokens: 32_000, costUSD: 1 } });
    registry.recordEvaluation(OPUS, { qualifiedFor: ['safety-review'] });
    const again = registry.seed();
    expect(again.updated).toContain(OPUS);
    const e = registry.get(OPUS)!;
    expect(e.available).toBe(true);
    expect(e.limits?.contextTokens).toBe(900_000);
    expect(e.limits?.cliMaxOutputTokens).toBe(32_000);
    expect(e.limits?.maxOutputTokens).toBe(128_000);
    expect(e.eligibility.provenance['limits.context_tokens']).toBe('observed');
    expect(e.evaluation.qualifiedFor).toEqual(['safety-review']);
  });
});

describe('ModelRegistry availability and eligibility', () => {
  it('tracks availability per surface and refuses unknown models', () => {
    const { registry } = bare();
    registry.markAvailability(SONNET, 'claude-cli', false, 'model not found in CLI 2.1.280');
    const e = registry.get(SONNET)!;
    expect(e.available).toBe(false);
    expect(e.surfaces[0]).toMatchObject({ available: false, detail: 'model not found in CLI 2.1.280' });
    const a = registry.assess({ surface: 'claude-cli', allowedModels: [SONNET] });
    expect(a.excluded.find((x) => x.model.modelId === SONNET)?.reasons[0]).toMatch(/unavailable on claude-cli: model not found/);
    expectCode(() => registry.markAvailability('nope', 'claude-cli', true, 'x'), 'NOT_FOUND');
    expectCode(() => registry.markAvailability(SONNET, 'api' as never, true, 'x'), 'SCHEMA_INVALID');
  });

  it('excludes models outside routing.allowed_models, and an empty list allows nothing', () => {
    const { registry } = setup({ codex: false });
    expect(registry.eligible({ surface: 'claude-cli', allowedModels: [] })).toEqual([]);
    expect(registry.eligible({ surface: 'claude-cli', allowedModels: ['sonnet'] }).map((m) => m.modelId)).toEqual([SONNET]);
    expect(registry.eligible({ surface: 'claude-cli', allowedModels: ['claude-haiku-4-5'] }).map((m) => m.modelId)).toEqual([HAIKU]);
  });

  it('never lets a wildcard authorize Fable; naming it does', () => {
    const { registry } = setup({ codex: false });
    const wild = registry.assess({ surface: 'claude-cli', allowedModels: ['claude:*'] });
    expect(wild.eligible.map((m) => m.modelId)).toEqual([HAIKU, SONNET, OPUS]);
    expect(wild.excluded.find((x) => x.model.modelId === FABLE)?.reasons[0]).toMatch(/explicit/);
    expect(registry.eligible({ surface: 'claude-cli', allowedModels: ['claude:*', 'fable'] }).map((m) => m.modelId)).toContain(FABLE);
    expect(allowMatch(registry.get(FABLE)!, [FABLE])).toBe('explicit');
    expect(allowMatch(registry.get(FABLE)!, ['*'])).toBe('wildcard');
    expect(allowMatch(registry.get(FABLE)!, ['opus'])).toBeNull();
  });

  it('filters by context window, vision, structured output and provider', () => {
    const { registry } = setup();
    const big = registry.assess({ surface: 'claude-cli', allowedModels: CLAUDE_MODELS, minContext: 500_000 });
    expect(big.eligible.map((m) => m.modelId)).not.toContain(HAIKU);
    expect(big.excluded.find((x) => x.model.modelId === HAIKU)?.reasons).toContain('context window 200000 is below the required 500000');
    expect(registry.eligible({ surface: 'claude-cli', allowedModels: CLAUDE_MODELS, vision: true }).map((m) => m.modelId)).toEqual([HAIKU, SONNET, OPUS, FABLE]);
    const codexVision = registry.assess({ surface: 'codex-cli', allowedModels: ['codex:*'], vision: true });
    expect(codexVision.eligible).toEqual([]);
    expect(codexVision.excluded.find((x) => x.model.modelId === 'codex-alpha')?.reasons).toEqual(['vision support unknown']);
    expect(registry.eligible({ surface: 'codex-cli', allowedModels: ['codex:*'], structuredOutput: true, provider: 'codex' }).map((m) => m.modelId)).toEqual([
      'codex-alpha',
      'codex-beta',
    ]);
    expect(registry.eligible({ surface: 'claude-cli', allowedModels: CLAUDE_MODELS, provider: 'codex' })).toEqual([]);
  });
});

describe('ModelRegistry.refreshFromUsage', () => {
  it('maps keys to canonical ids, stores the CLI output cap apart, and records observed cost against list', () => {
    const { registry, clock } = bare();
    clock.advance(5_000);
    const touched = registry.refreshFromUsage({
      'claude-haiku-4-5': {
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.15,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        canonicalModel: HAIKU,
        costBasis: 'list',
      },
    });
    expect(touched).toEqual([HAIKU]);
    const e = registry.get(HAIKU)!;
    expect(e.limits).toMatchObject({ contextTokens: 200_000, maxOutputTokens: 64_000, cliMaxOutputTokens: 32_000, observedAt: clock.now() });
    // 100k input at $1 + 10k output at $5 = $0.15 list.
    expect(e.evaluation.observedCost).toMatchObject({ samples: 1, costUsd: 0.15, listEstimateUsd: 0.15, ratioToList: 1, costBasis: 'list' });
    expect(e.available).toBe(true);
    expect(e.surfaces[0]?.detail).toMatch(/modelUsage/);
    registry.refreshFromUsage({ [HAIKU]: { inputTokens: 100_000, outputTokens: 10_000, costUSD: 0.075 } });
    expect(registry.get(HAIKU)?.evaluation.observedCost).toMatchObject({ samples: 2, costUsd: 0.225, listEstimateUsd: 0.3, ratioToList: 0.75 });
  });

  it('registers a fallback model it has never seen, without authorizing it implicitly', () => {
    const { registry } = bare();
    registry.refreshFromUsage({ 'claude-opus-5': { costUSD: 0.5, contextWindow: 1_000_000 }, 'claude-mythos-5': { costUSD: 0 } });
    const fallback = registry.get('claude-opus-5')!;
    expect(fallback.family).toBe('opus');
    expect(fallback.pricing).toBeNull();
    expect(fallback.available).toBe(true);
    expect(fallback.evaluation.observedCost?.listEstimateUsd).toBeNull();
    expect(fallback.eligibility.requiresExplicitPolicy).toBe(false);
    expect(registry.get('claude-mythos-5')?.eligibility.requiresExplicitPolicy).toBe(true);
    expect(registry.eligible({ surface: 'claude-cli', allowedModels: ['claude:*'] }).map((m) => m.modelId)).not.toContain('claude-mythos-5');
  });

  it('prices the worst single request from limits, preferring the observed CLI output cap', () => {
    const { registry } = setup();
    // 1M prompt written to the 1 hour cache at $8 + 128k output at $20
    expect(worstCaseRequestUsd(registry.get(OPUS)!)).toBe(10.56);
    registry.refreshFromUsage({ [HAIKU]: { contextWindow: 200_000, maxOutputTokens: 32_000 } });
    // 200k at the $2 cache-write rate + 32k at $5
    expect(worstCaseRequestUsd(registry.get(HAIKU)!)).toBe(0.56);
    expect(worstCaseRequestUsd(registry.get('codex-alpha')!)).toBeNull();
  });

  it('rejects a non-object modelUsage and skips malformed entries', () => {
    const { registry } = bare();
    expectCode(() => registry.refreshFromUsage(null as never), 'MALFORMED_OUTPUT');
    expect(registry.refreshFromUsage({ '': {}, [SONNET]: 'nonsense' as never })).toEqual([]);
  });
});

describe('codex catalog', () => {
  it('registers listed models with runtime efforts, picks the provider default, and skips hidden ones', () => {
    const { registry } = bare();
    const r = registry.registerCodexCatalog(codexCatalog(), { source: 'live' });
    expect(r).toEqual({ listed: ['codex-alpha', 'codex-beta'], hidden: ['codex-internal'], absent: [], conflicting: [], providerDefault: 'codex-alpha' });
    const alpha = registry.get('codex-alpha')!;
    expect(alpha.provider).toBe('codex');
    expect(alpha.capabilities.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(alpha.capabilities.structuredOutput).toBe(true);
    expect(alpha.pricing).toBeNull();
    expect(alpha.eligibility.providerDefault).toBe(true);
    expect(alpha.eligibility.provenance.model_id).toBe('runtime');
    expect(alpha.surfaces).toEqual([expect.objectContaining({ surface: 'codex-cli', available: true })]);
    expect(registry.get('codex-beta')?.eligibility.providerDefault).toBe(false);
    expect(registry.get('codex-internal')).toBeNull();
  });

  it('marks models that leave a live catalog unavailable, and a bundled catalog proves nothing', () => {
    const { registry } = bare();
    registry.registerCodexCatalog(codexCatalog(), { source: 'live' });
    const next = (codexCatalog() as { models: { slug: string }[] }).models.filter((m) => m.slug !== 'codex-alpha');
    const r = registry.registerCodexCatalog(next, { source: 'live' });
    expect(r.absent).toEqual(['codex-alpha']);
    expect(r.providerDefault).toBe('codex-beta');
    expect(registry.get('codex-alpha')).toMatchObject({ available: false });
    expect(registry.get('codex-alpha')?.eligibility.providerDefault).toBe(false);

    const fresh = bare().registry;
    fresh.registerCodexCatalog(codexCatalog(), { source: 'bundled' });
    expect(fresh.get('codex-alpha')?.surfaces[0]?.available).toBeNull();
  });

  it('parses tolerantly but refuses output that is not a catalog', () => {
    expect(parseCodexCatalog([{ slug: 'x', supported_reasoning_levels: ['low', { effort: 'high' }, 7] }, { nope: 1 }])).toEqual([
      { slug: 'x', displayName: null, defaultEffort: null, efforts: ['low', 'high'], visibility: null, supportedInApi: null, priority: null },
    ]);
    expectCode(() => parseCodexCatalog('not json'), 'MALFORMED_OUTPUT');
    expectCode(() => parseCodexCatalog({ data: [] }), 'MALFORMED_OUTPUT');
  });

  it('exposes the runtime provider description from the seed', () => {
    const { registry } = bare();
    const [codex] = registry.runtimeProviders();
    expect(codex?.provider).toBe('codex');
    expect(defaultSeed().runtime_providers[0]?.surface).toBe('codex-cli');
  });
});
