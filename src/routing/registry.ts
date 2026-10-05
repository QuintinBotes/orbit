import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import seedJson from '../../data/models.json' with { type: 'json' };
import { estimateCost, inputIncludesCacheRead, roundUsd } from './pricing.ts';
import {
  SURFACES,
  type ClaudeModelUsage,
  type EligibilityAssessment,
  type EligibilityRequirements,
  type ModelEntry,
  type ModelPricing,
  type ObservedCost,
  type Provenance,
  type Surface,
  type SurfaceState,
} from './types.ts';

/**
 * Model registry over the `model_registry` table (spec section 8).
 *
 * The seed (data/models.json) is a starting point, not the truth: limits and
 * cost are refreshed from every Claude result's modelUsage, codex models are
 * registered from the live catalog, and a model is available on a surface
 * only after something validated it there. API availability never implies CLI
 * availability.
 */

/** Capability ladder used by routing. Other providers have no tier; they qualify by other means. */
export const FAMILY_TIER: Readonly<Record<string, number>> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

export function tierOf(entry: Pick<ModelEntry, 'family'>): number | null {
  return entry.family ? (FAMILY_TIER[entry.family] ?? null) : null;
}

/**
 * Cost of the most expensive single request a model can make: a full context
 * plus the largest output, at list price. The CLI's own spend cap is checked
 * after each request and overshoots by up to one (gaps-and-contradictions
 * V1), so this is the headroom to hold back. One request can write its whole
 * prompt to the cache, and cache writes cost more than base input (2x at the
 * 1 hour TTL), so the context is priced at the dearest prompt rate; pricing
 * it as plain input would understate the overshoot. The observed CLI request
 * cap is used when known; null without pricing or limits.
 */
export function worstCaseRequestUsd(entry: Pick<ModelEntry, 'pricing' | 'limits'>): number | null {
  const p = entry.pricing;
  const context = entry.limits?.contextTokens ?? null;
  const output = entry.limits?.cliMaxOutputTokens ?? entry.limits?.maxOutputTokens ?? null;
  if (!p || context === null || output === null) return null;
  const promptRate = Math.max(p.input, p.cache_write_5m, p.cache_write_1h);
  return roundUsd((context * promptRate + output * p.output) / 1_000_000);
}

// ---------------------------------------------------------------------------
// Seed file

interface SeedModel {
  model_id: string;
  provider: string;
  family: string;
  display_name: string;
  aliases: string[];
  cli_alias: string | null;
  min_cli_version: string | null;
  surfaces: Surface[];
  capabilities: { tools: boolean; structured_output: boolean; vision: boolean | null; effort_levels: string[]; default_effort: string | null };
  limits: { context_tokens: number; max_output_tokens: number };
  pricing: ModelPricing | null;
  requires_explicit_policy: boolean;
  provenance: Record<string, Provenance>;
  notes: string[];
}

export interface RuntimeProviderSeed {
  provider: string;
  family: string;
  surface: Surface;
  source: string;
  model_resolution: Record<string, unknown>;
  capabilities: { tools: boolean; structured_output: boolean; vision: boolean | null; excluded_efforts: string[] };
  pricing: ModelPricing | null;
  provenance: Record<string, Provenance>;
  notes: string[];
}

export interface SeedFile {
  schema: 'orbit.models/1';
  refreshed_at: string;
  models: SeedModel[];
  runtime_providers: RuntimeProviderSeed[];
}

/** Validates the seed's shape so a hand-edited file fails loudly instead of seeding garbage. */
export function parseSeedFile(raw: unknown): SeedFile {
  const fail = (msg: string): never => {
    throw new OrbitError('CONFIG_INVALID', `models seed: ${msg}`);
  };
  if (!isObject(raw) || raw.schema !== 'orbit.models/1') fail('schema must be orbit.models/1');
  const file = raw as Record<string, unknown>;
  if (typeof file.refreshed_at !== 'string' || Number.isNaN(Date.parse(file.refreshed_at))) fail('refreshed_at must be a date');
  if (!Array.isArray(file.models)) fail('models must be an array');
  const seen = new Set<string>();
  for (const m of file.models as unknown[]) {
    if (!isObject(m) || typeof m.model_id !== 'string' || !m.model_id) fail('every model needs a model_id');
    const model = m as Record<string, unknown>;
    const id = model.model_id as string;
    if (seen.has(id)) fail(`duplicate model_id ${id}`);
    seen.add(id);
    if (typeof model.provider !== 'string') fail(`${id}: provider missing`);
    if (!Array.isArray(model.surfaces) || !(model.surfaces as unknown[]).every((s) => (SURFACES as readonly unknown[]).includes(s))) fail(`${id}: unknown surface`);
    const limits = model.limits as Record<string, unknown> | undefined;
    if (!isObject(limits) || !isPositive(limits.context_tokens) || !isPositive(limits.max_output_tokens)) fail(`${id}: limits must be positive numbers`);
    if (model.pricing !== null) {
      const p = model.pricing as Record<string, unknown>;
      for (const k of ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read']) {
        if (!isObject(p) || !isNonNegative(p[k])) fail(`${id}: pricing.${k} must be a non-negative number`);
      }
    }
    if (!isObject(model.capabilities) || !Array.isArray((model.capabilities as Record<string, unknown>).effort_levels)) fail(`${id}: capabilities.effort_levels missing`);
  }
  if (!Array.isArray(file.runtime_providers)) fail('runtime_providers must be an array');
  return raw as SeedFile;
}

export function defaultSeed(): SeedFile {
  return parseSeedFile(seedJson);
}

// ---------------------------------------------------------------------------
// Row mapping

interface RegistryRow {
  model_id: string;
  provider: string;
  family: string | null;
  surfaces_json: string;
  capabilities_json: string;
  limits_json: string | null;
  pricing_json: string | null;
  eligibility_json: string | null;
  eval_json: string | null;
  latency_ms: number | null;
  available: number;
  refreshed_at: number | null;
}

interface StoredSurface {
  surface: Surface;
  available: boolean | null;
  detail: string | null;
  checked_at: number | null;
}
interface StoredCapabilities {
  tools: boolean | null;
  structured_output: boolean | null;
  vision: boolean | null;
  effort_levels: string[];
  default_effort: string | null;
}
interface StoredLimits {
  context_tokens: number | null;
  max_output_tokens: number | null;
  cli_max_output_tokens: number | null;
  observed_at: number | null;
}
/** eligibility_json also carries descriptive metadata; the table has no other free-form column for it. */
interface StoredEligibility {
  display_name: string | null;
  aliases: string[];
  cli_alias: string | null;
  min_cli_version: string | null;
  requires_explicit_policy: boolean;
  provider_default: boolean;
  notes: string[];
  provenance: Record<string, Provenance>;
}
interface StoredEval {
  observed_cost: { samples: number; cost_usd: number; list_estimate_usd: number | null; cost_basis: string | null; last_at: number } | null;
  qualified_for: string[];
  justified_work_kinds: string[];
  /** Most recent time-to-first-event samples in milliseconds, oldest first; latency_ms is their median. */
  latency_samples_ms: number[];
}

interface Draft {
  modelId: string;
  provider: string;
  family: string | null;
  surfaces: StoredSurface[];
  capabilities: StoredCapabilities;
  limits: StoredLimits | null;
  pricing: ModelPricing | null;
  eligibility: StoredEligibility;
  evaluation: StoredEval;
  latencyMs: number | null;
  refreshedAt: number | null;
}

function parse<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  return JSON.parse(json) as T;
}

function rowToDraft(r: RegistryRow): Draft {
  return {
    modelId: r.model_id,
    provider: r.provider,
    family: r.family,
    surfaces: parse<StoredSurface[]>(r.surfaces_json, []),
    capabilities: parse<StoredCapabilities>(r.capabilities_json, { tools: null, structured_output: null, vision: null, effort_levels: [], default_effort: null }),
    limits: parse<StoredLimits | null>(r.limits_json, null),
    pricing: parse<ModelPricing | null>(r.pricing_json, null),
    eligibility: { ...emptyEligibility(), ...parse<Partial<StoredEligibility>>(r.eligibility_json, {}) },
    evaluation: { ...emptyEval(), ...parse<Partial<StoredEval>>(r.eval_json, {}) },
    latencyMs: r.latency_ms,
    refreshedAt: r.refreshed_at,
  };
}

function draftToEntry(d: Draft): ModelEntry {
  const oc = d.evaluation.observed_cost;
  const observedCost: ObservedCost | null = oc
    ? {
        samples: oc.samples,
        costUsd: oc.cost_usd,
        listEstimateUsd: oc.list_estimate_usd,
        ratioToList: oc.list_estimate_usd && oc.list_estimate_usd > 0 ? Math.round((oc.cost_usd / oc.list_estimate_usd) * 1000) / 1000 : null,
        costBasis: oc.cost_basis,
        lastAt: oc.last_at,
      }
    : null;
  return {
    modelId: d.modelId,
    provider: d.provider,
    family: d.family,
    displayName: d.eligibility.display_name,
    surfaces: d.surfaces.map<SurfaceState>((s) => ({ surface: s.surface, available: s.available, detail: s.detail, checkedAt: s.checked_at })),
    capabilities: {
      tools: d.capabilities.tools,
      structuredOutput: d.capabilities.structured_output,
      vision: d.capabilities.vision,
      effortLevels: [...d.capabilities.effort_levels],
      defaultEffort: d.capabilities.default_effort,
    },
    limits: d.limits
      ? {
          contextTokens: d.limits.context_tokens,
          maxOutputTokens: d.limits.max_output_tokens,
          cliMaxOutputTokens: d.limits.cli_max_output_tokens,
          observedAt: d.limits.observed_at,
        }
      : null,
    pricing: d.pricing,
    eligibility: {
      aliases: [...d.eligibility.aliases],
      cliAlias: d.eligibility.cli_alias,
      minCliVersion: d.eligibility.min_cli_version,
      requiresExplicitPolicy: d.eligibility.requires_explicit_policy,
      providerDefault: d.eligibility.provider_default,
      notes: [...d.eligibility.notes],
      provenance: { ...d.eligibility.provenance },
    },
    evaluation: { observedCost, qualifiedFor: [...d.evaluation.qualified_for], justifiedWorkKinds: [...d.evaluation.justified_work_kinds] },
    latencyMs: d.latencyMs,
    available: d.surfaces.some((s) => s.available === true),
    refreshedAt: d.refreshedAt,
  };
}

function emptyEligibility(): StoredEligibility {
  return { display_name: null, aliases: [], cli_alias: null, min_cli_version: null, requires_explicit_policy: false, provider_default: false, notes: [], provenance: {} };
}

/** How many recent time-to-first-event samples the rolling median covers. */
export const LATENCY_WINDOW = 25;

/** Median of a non-empty list; the mean of the two middle values for an even count, rounded. */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

function emptyEval(): StoredEval {
  return { observed_cost: null, qualified_for: [], justified_work_kinds: [], latency_samples_ms: [] };
}

// ---------------------------------------------------------------------------
// Codex catalog

export interface CodexCatalogModel {
  slug: string;
  displayName: string | null;
  defaultEffort: string | null;
  efforts: string[];
  visibility: string | null;
  supportedInApi: boolean | null;
  priority: number | null;
}

/**
 * Parses `codex debug models` output. Only the per-model fields listed in
 * codex-cli.md section 6 are read; the top-level wrapper is not documented,
 * so both a bare array and an object holding a `models` array are accepted.
 * Entries without a slug are skipped rather than guessed at.
 */
export function parseCodexCatalog(raw: unknown): CodexCatalogModel[] {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.models) ? (raw.models as unknown[]) : null;
  if (!list) throw new OrbitError('MALFORMED_OUTPUT', 'codex model catalog: expected an array of models or an object with a models array');
  const out: CodexCatalogModel[] = [];
  for (const item of list) {
    if (!isObject(item) || typeof item.slug !== 'string' || !item.slug.trim()) continue;
    const levels = Array.isArray(item.supported_reasoning_levels) ? (item.supported_reasoning_levels as unknown[]) : [];
    const efforts = levels
      .map((l) => (typeof l === 'string' ? l : isObject(l) && typeof l.effort === 'string' ? l.effort : null))
      .filter((e): e is string => e !== null);
    out.push({
      slug: item.slug.trim(),
      displayName: typeof item.display_name === 'string' ? item.display_name : null,
      defaultEffort: typeof item.default_reasoning_level === 'string' ? item.default_reasoning_level : null,
      efforts: [...new Set(efforts)],
      visibility: typeof item.visibility === 'string' ? item.visibility : null,
      supportedInApi: typeof item.supported_in_api === 'boolean' ? item.supported_in_api : null,
      priority: typeof item.priority === 'number' && Number.isFinite(item.priority) ? item.priority : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

export interface SeedResult {
  inserted: string[];
  updated: string[];
}

export interface CatalogResult {
  listed: string[];
  hidden: string[];
  absent: string[];
  /** Slugs that already name another provider's model; skipped, never overwritten. */
  conflicting: string[];
  providerDefault: string | null;
}

type AllowMatch = 'explicit' | 'wildcard' | null;

export class ModelRegistry {
  private readonly db: OrbitDb;
  private readonly clock: Clock;
  private readonly seedFile: SeedFile;
  private readonly runtime: RuntimeProviderSeed[];

  constructor(db: OrbitDb, clock: Clock, seedFile: SeedFile = defaultSeed()) {
    this.db = db;
    this.clock = clock;
    this.seedFile = seedFile;
    this.runtime = seedFile.runtime_providers;
  }

  /**
   * Insert seed models, or refresh their static facts. Availability, observed
   * limits and evaluation results already recorded are kept: a re-seed must
   * never erase what Orbit learned at runtime.
   */
  seed(): SeedResult {
    const seededAt = Date.parse(this.seedFile.refreshed_at);
    const result: SeedResult = { inserted: [], updated: [] };
    this.db.tx(() => {
      for (const m of this.seedFile.models) {
        const existing = this.readDraft(m.model_id);
        const surfaces = mergeSurfaces(existing?.surfaces ?? [], m.surfaces);
        const observed = existing?.limits?.observed_at ?? null;
        const draft: Draft = {
          modelId: m.model_id,
          provider: m.provider,
          family: m.family,
          surfaces,
          capabilities: { ...m.capabilities, effort_levels: [...m.capabilities.effort_levels] },
          limits: {
            context_tokens: observed !== null ? (existing?.limits?.context_tokens ?? m.limits.context_tokens) : m.limits.context_tokens,
            max_output_tokens: m.limits.max_output_tokens,
            cli_max_output_tokens: existing?.limits?.cli_max_output_tokens ?? null,
            observed_at: observed,
          },
          pricing: m.pricing ? { ...m.pricing } : null,
          eligibility: {
            display_name: m.display_name,
            aliases: uniq([...m.aliases, ...(existing?.eligibility.aliases ?? [])]),
            cli_alias: m.cli_alias,
            min_cli_version: m.min_cli_version,
            requires_explicit_policy: m.requires_explicit_policy,
            provider_default: false,
            notes: [...m.notes],
            provenance: { ...m.provenance, ...observedProvenance(existing) },
          },
          evaluation: existing?.evaluation ?? emptyEval(),
          latencyMs: existing?.latencyMs ?? null,
          refreshedAt: Math.max(existing?.refreshedAt ?? 0, seededAt),
        };
        this.writeDraft(draft);
        (existing ? result.updated : result.inserted).push(m.model_id);
      }
    });
    return result;
  }

  /** Runtime-resolved providers from the seed (codex), with how their models are found. */
  runtimeProviders(): RuntimeProviderSeed[] {
    return this.runtime.map((p) => structuredClone(p));
  }

  list(): ModelEntry[] {
    return this.db
      .all<RegistryRow>('SELECT * FROM model_registry ORDER BY provider, model_id')
      .map((r) => draftToEntry(rowToDraft(r)));
  }

  get(modelOrAlias: string): ModelEntry | null {
    const draft = this.findDraft(modelOrAlias);
    return draft ? draftToEntry(draft) : null;
  }

  /** The canonical model id for an id, alias or CLI alias; null when unknown. */
  resolve(modelOrAlias: string): string | null {
    return this.findDraft(modelOrAlias)?.modelId ?? null;
  }

  /**
   * Record a validation result for one surface (a minimal run, `system/init.model`,
   * or a failed spawn). Availability is per surface because a model the API
   * serves may still be missing from the installed CLI.
   */
  markAvailability(model: string, surface: Surface, ok: boolean, detail: string): ModelEntry {
    if (!(SURFACES as readonly string[]).includes(surface)) throw new OrbitError('SCHEMA_INVALID', `unknown surface ${surface}`);
    const now = this.clock.now();
    return this.db.tx(() => {
      const draft = this.findDraft(model);
      if (!draft) throw new OrbitError('NOT_FOUND', `model ${model} is not in the registry`);
      setSurface(draft.surfaces, surface, ok, detail, now);
      this.writeDraft(draft);
      return draftToEntry(draft);
    });
  }

  /**
   * Refresh from a Claude result's `modelUsage`. Each key is a model that
   * actually ran (content fallback can switch models mid-session), so it is
   * also proof of availability on the surface. `maxOutputTokens` there is
   * Claude Code's per-request cap, not the model maximum, and is stored apart.
   */
  refreshFromUsage(modelUsage: Record<string, ClaudeModelUsage>, surface: Surface = 'claude-cli'): string[] {
    if (!isObject(modelUsage)) throw new OrbitError('MALFORMED_OUTPUT', 'modelUsage must be an object keyed by model id');
    const now = this.clock.now();
    const touched: string[] = [];
    this.db.tx(() => {
      for (const [key, raw] of Object.entries(modelUsage)) {
        if (!key.trim() || !isObject(raw)) continue;
        const mu = raw as ClaudeModelUsage;
        const canonical = typeof mu.canonicalModel === 'string' && mu.canonicalModel.trim() ? mu.canonicalModel.trim() : key.trim();
        const draft = this.findDraft(canonical) ?? this.findDraft(key) ?? newObservedDraft(canonical, surface);
        for (const name of [canonical, key.trim()]) {
          if (name === draft.modelId || draft.eligibility.aliases.includes(name)) continue;
          // Aliases authorize (allowMatch treats them as explicit entries), so
          // a name that already resolves to a different model is never
          // learned: an allow-list entry for one model must not admit another.
          const other = this.findDraft(name);
          if (other && other.modelId !== draft.modelId) continue;
          draft.eligibility.aliases.push(name);
        }
        const limits = draft.limits ?? { context_tokens: null, max_output_tokens: null, cli_max_output_tokens: null, observed_at: null };
        if (isPositive(mu.contextWindow)) {
          limits.context_tokens = mu.contextWindow;
          draft.eligibility.provenance['limits.context_tokens'] = 'observed';
        }
        if (isPositive(mu.maxOutputTokens)) {
          limits.cli_max_output_tokens = mu.maxOutputTokens;
          draft.eligibility.provenance['limits.cli_max_output_tokens'] = 'observed';
        }
        limits.observed_at = now;
        draft.limits = limits;
        if (isNonNegative(mu.costUSD)) {
          const est = estimateCost(
            {
              inputTokens: num(mu.inputTokens),
              outputTokens: num(mu.outputTokens),
              cacheReadTokens: num(mu.cacheReadInputTokens),
              cacheWriteTokens: num(mu.cacheCreationInputTokens),
            },
            draft.pricing,
            { inputIncludesCacheRead: inputIncludesCacheRead(draft.provider) },
          );
          const prev = draft.evaluation.observed_cost;
          // The ratio only means something if every sample was priced, so one
          // unpriced sample drops the list estimate for good.
          const listEstimate = est.costUsd === null || (prev && prev.list_estimate_usd === null) ? null : roundUsd((prev?.list_estimate_usd ?? 0) + est.costUsd);
          draft.evaluation.observed_cost = {
            samples: (prev?.samples ?? 0) + 1,
            cost_usd: roundUsd((prev?.cost_usd ?? 0) + mu.costUSD),
            list_estimate_usd: listEstimate,
            cost_basis: typeof mu.costBasis === 'string' ? mu.costBasis : (prev?.cost_basis ?? null),
            last_at: now,
          };
        }
        setSurface(draft.surfaces, surface, true, 'observed in a result modelUsage', now);
        draft.refreshedAt = now;
        this.writeDraft(draft);
        touched.push(draft.modelId);
      }
    });
    return uniq(touched);
  }

  /**
   * Register codex models from `codex debug models`. A live catalog lists what
   * this client version can use, so listed models become available; the
   * bundled catalog proves nothing about the server and leaves availability
   * unknown. Codex models that dropped out of a live catalog become unavailable.
   */
  registerCodexCatalog(raw: unknown, opts: { source: 'live' | 'bundled' }): CatalogResult {
    const spec = this.runtime.find((p) => p.provider === 'codex');
    if (!spec) throw new OrbitError('CONFIG_INVALID', 'models seed has no codex runtime provider');
    const models = parseCodexCatalog(raw);
    const excluded = new Set(spec.capabilities.excluded_efforts);
    const now = this.clock.now();
    const absent: string[] = [];
    const conflicting: string[] = [];
    let listed: CodexCatalogModel[] = [];
    let hidden: CodexCatalogModel[] = [];
    let providerDefault: string | null = null;
    this.db.tx(() => {
      // A slug that already names another provider's model is reported and
      // skipped: catalog output must never rewrite (or disable) a Claude
      // entry's provider, pricing or availability.
      const foreign = new Set(
        models.filter((m) => {
          const d = this.readDraft(m.slug);
          return d !== null && d.provider !== spec.provider;
        }).map((m) => m.slug),
      );
      conflicting.push(...uniq(models.filter((m) => foreign.has(m.slug)).map((m) => m.slug)));
      const own = models.filter((m) => !foreign.has(m.slug));
      listed = own.filter((m) => m.visibility === 'list');
      hidden = own.filter((m) => m.visibility !== 'list');
      const ranked = listed.filter((m) => m.priority !== null).sort((a, b) => (a.priority as number) - (b.priority as number));
      providerDefault = ranked[0]?.slug ?? null;
      for (const m of listed) {
        const existing = this.readDraft(m.slug);
        const surfaces = mergeSurfaces(existing?.surfaces ?? [], [spec.surface]);
        if (opts.source === 'live') setSurface(surfaces, spec.surface, true, 'listed by codex debug models', now);
        this.writeDraft({
          modelId: m.slug,
          provider: spec.provider,
          family: spec.family,
          surfaces,
          capabilities: {
            tools: spec.capabilities.tools,
            structured_output: spec.capabilities.structured_output,
            vision: spec.capabilities.vision,
            effort_levels: m.efforts.filter((e) => !excluded.has(e)),
            default_effort: m.defaultEffort && !excluded.has(m.defaultEffort) ? m.defaultEffort : null,
          },
          limits: existing?.limits ?? null,
          pricing: spec.pricing,
          eligibility: {
            display_name: m.displayName,
            aliases: existing?.eligibility.aliases ?? [],
            cli_alias: null,
            min_cli_version: null,
            requires_explicit_policy: false,
            provider_default: m.slug === providerDefault,
            notes: [...spec.notes, `catalog source: ${opts.source}`],
            provenance: { ...spec.provenance, model_id: 'runtime', 'capabilities.effort_levels': 'runtime' },
          },
          evaluation: existing?.evaluation ?? emptyEval(),
          latencyMs: existing?.latencyMs ?? null,
          refreshedAt: now,
        });
      }
      const listedIds = new Set(listed.map((m) => m.slug));
      for (const m of hidden) {
        const draft = this.readDraft(m.slug);
        if (!draft) continue;
        setSurface(draft.surfaces, spec.surface, false, 'hidden in codex debug models', now);
        draft.eligibility.provider_default = false;
        this.writeDraft(draft);
      }
      if (opts.source === 'live') {
        for (const r of this.db.all<RegistryRow>('SELECT * FROM model_registry WHERE provider = ?', spec.provider)) {
          if (listedIds.has(r.model_id) || hidden.some((h) => h.slug === r.model_id)) continue;
          const draft = rowToDraft(r);
          setSurface(draft.surfaces, spec.surface, false, 'absent from codex debug models', now);
          draft.eligibility.provider_default = false;
          this.writeDraft(draft);
          absent.push(r.model_id);
        }
      }
    });
    return { listed: listed.map((m) => m.slug), hidden: hidden.map((m) => m.slug), absent, conflicting, providerDefault };
  }

  /** Record an evaluation outcome (replay suite, review calibration) that routing may rely on. */
  recordEvaluation(model: string, result: { qualifiedFor?: string[]; justifiedWorkKinds?: string[] }): ModelEntry {
    const now = this.clock.now();
    return this.db.tx(() => {
      const draft = this.findDraft(model);
      if (!draft) throw new OrbitError('NOT_FOUND', `model ${model} is not in the registry`);
      draft.evaluation.qualified_for = uniq([...draft.evaluation.qualified_for, ...(result.qualifiedFor ?? [])]);
      draft.evaluation.justified_work_kinds = uniq([...draft.evaluation.justified_work_kinds, ...(result.justifiedWorkKinds ?? [])]);
      draft.refreshedAt = now;
      this.writeDraft(draft);
      return draftToEntry(draft);
    });
  }

  /**
   * Record one time-to-first-event sample for a model (spawn to the first
   * line of provider output, from the worker log) and set latency_ms to the
   * median of the most recent `window` samples. Returns null, recording
   * nothing, for an unregistered model or a sample that is not a finite,
   * non-negative number.
   */
  recordLatency(model: string, ms: number | null | undefined, window = LATENCY_WINDOW): ModelEntry | null {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
    const size = Math.max(1, Math.floor(window));
    return this.db.tx(() => {
      const draft = this.findDraft(model);
      if (!draft) return null;
      const samples = [...(draft.evaluation.latency_samples_ms ?? []), Math.round(ms)].slice(-size);
      draft.evaluation.latency_samples_ms = samples;
      draft.latencyMs = medianOf(samples);
      this.writeDraft(draft);
      return draftToEntry(draft);
    });
  }

  /** Every model with the reasons it is or is not eligible, for recorded route alternatives. */
  assess(req: EligibilityRequirements): EligibilityAssessment {
    const out: EligibilityAssessment = { eligible: [], excluded: [] };
    for (const entry of this.list()) {
      const reasons: string[] = [];
      if (req.provider && entry.provider !== req.provider) reasons.push(`provider ${entry.provider} is not ${req.provider}`);
      const state = entry.surfaces.find((s) => s.surface === req.surface);
      if (!state) reasons.push(`not offered on ${req.surface}`);
      else if (state.available === false) reasons.push(`unavailable on ${req.surface}${state.detail ? `: ${state.detail}` : ''}`);
      else if (state.available !== true) reasons.push(`availability on ${req.surface} not yet validated`);
      const match = allowMatch(entry, req.allowedModels);
      if (match === null) reasons.push('not in routing.allowed_models');
      else if (match === 'wildcard' && entry.eligibility.requiresExplicitPolicy) reasons.push('requires an explicit routing.allowed_models entry; a wildcard does not authorize it');
      if (req.minContext !== undefined) {
        const ctx = entry.limits?.contextTokens ?? null;
        if (ctx === null) reasons.push('context window unknown');
        else if (ctx < req.minContext) reasons.push(`context window ${ctx} is below the required ${req.minContext}`);
      }
      if (req.vision && entry.capabilities.vision !== true) reasons.push(entry.capabilities.vision === false ? 'no vision support' : 'vision support unknown');
      if (req.structuredOutput && entry.capabilities.structuredOutput !== true) reasons.push('structured output not supported on this surface');
      if (reasons.length === 0) out.eligible.push(entry);
      else out.excluded.push({ model: entry, reasons });
    }
    out.eligible.sort((a, b) => (tierOf(a) ?? 99) - (tierOf(b) ?? 99) || a.modelId.localeCompare(b.modelId));
    return out;
  }

  eligible(req: EligibilityRequirements): ModelEntry[] {
    return this.assess(req).eligible;
  }

  // -------------------------------------------------------------------------

  private readDraft(modelId: string): Draft | null {
    const row = this.db.get<RegistryRow>('SELECT * FROM model_registry WHERE model_id = ?', modelId);
    return row ? rowToDraft(row) : null;
  }

  private findDraft(modelOrAlias: string): Draft | null {
    const key = modelOrAlias.trim();
    if (!key) return null;
    const exact = this.readDraft(key);
    if (exact) return exact;
    const lower = key.toLowerCase();
    // Aliases are few and the table is small; a scan keeps the schema unchanged.
    for (const r of this.db.all<RegistryRow>('SELECT * FROM model_registry ORDER BY model_id')) {
      const d = rowToDraft(r);
      if (d.modelId.toLowerCase() === lower) return d;
      if (d.eligibility.aliases.some((a) => a.toLowerCase() === lower)) return d;
      if (d.eligibility.cli_alias && d.eligibility.cli_alias.toLowerCase() === lower) return d;
    }
    return null;
  }

  private writeDraft(d: Draft): void {
    const available = d.surfaces.some((s) => s.available === true) ? 1 : 0;
    this.db.run(
      `INSERT INTO model_registry (model_id, provider, family, surfaces_json, capabilities_json, limits_json, pricing_json, eligibility_json, eval_json, latency_ms, available, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id) DO UPDATE SET
         provider = excluded.provider, family = excluded.family, surfaces_json = excluded.surfaces_json,
         capabilities_json = excluded.capabilities_json, limits_json = excluded.limits_json, pricing_json = excluded.pricing_json,
         eligibility_json = excluded.eligibility_json, eval_json = excluded.eval_json, latency_ms = excluded.latency_ms,
         available = excluded.available, refreshed_at = excluded.refreshed_at`,
      d.modelId,
      d.provider,
      d.family,
      JSON.stringify(d.surfaces),
      JSON.stringify(d.capabilities),
      d.limits ? JSON.stringify(d.limits) : null,
      d.pricing ? JSON.stringify(d.pricing) : null,
      JSON.stringify(d.eligibility),
      JSON.stringify(d.evaluation),
      d.latencyMs,
      available,
      d.refreshedAt,
    );
  }
}

/** How an allowed_models list authorizes an entry. Exact ids, aliases and family names are explicit. */
export function allowMatch(entry: Pick<ModelEntry, 'modelId' | 'provider' | 'family' | 'eligibility'>, allowed: readonly string[]): AllowMatch {
  let match: AllowMatch = null;
  for (const raw of allowed) {
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (
      a === entry.modelId.toLowerCase() ||
      entry.eligibility.aliases.some((x) => x.toLowerCase() === a) ||
      (entry.eligibility.cliAlias !== null && entry.eligibility.cliAlias.toLowerCase() === a) ||
      (entry.family !== null && entry.family.toLowerCase() === a)
    ) {
      return 'explicit';
    }
    if (a === `${entry.provider.toLowerCase()}:*` || a === '*') match = 'wildcard';
  }
  return match;
}

function newObservedDraft(modelId: string, surface: Surface): Draft {
  const fam = /^claude-(fable|opus|sonnet|haiku|mythos)-/.exec(modelId)?.[1] ?? null;
  return {
    modelId,
    provider: surface === 'codex-cli' ? 'codex' : 'claude',
    family: fam,
    surfaces: [],
    capabilities: { tools: null, structured_output: null, vision: null, effort_levels: [], default_effort: null },
    limits: null,
    pricing: null,
    eligibility: {
      ...emptyEligibility(),
      // Unknown or top-tier families never route on a wildcard: they may bill
      // differently and nobody chose them.
      requires_explicit_policy: fam === null || fam === 'fable' || fam === 'mythos',
      notes: ['first seen in a result modelUsage; not in the seed registry'],
      provenance: { model_id: 'observed' },
    },
    evaluation: emptyEval(),
    latencyMs: null,
    refreshedAt: null,
  };
}

function observedProvenance(existing: Draft | null): Record<string, Provenance> {
  if (!existing) return {};
  const out: Record<string, Provenance> = {};
  for (const [k, v] of Object.entries(existing.eligibility.provenance)) if (v === 'observed') out[k] = v;
  return out;
}

function mergeSurfaces(existing: StoredSurface[], seeded: readonly Surface[]): StoredSurface[] {
  const out = existing.map((s) => ({ ...s }));
  for (const s of seeded) if (!out.some((x) => x.surface === s)) out.push({ surface: s, available: null, detail: null, checked_at: null });
  return out;
}

function setSurface(surfaces: StoredSurface[], surface: Surface, ok: boolean, detail: string, now: number): void {
  const s = surfaces.find((x) => x.surface === surface);
  if (s) {
    s.available = ok;
    s.detail = detail;
    s.checked_at = now;
  } else {
    surfaces.push({ surface, available: ok, detail, checked_at: now });
  }
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isPositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}
