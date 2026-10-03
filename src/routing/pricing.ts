import type { ModelPricing } from './types.ts';

export interface TokenCounts {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface CostEstimate {
  costUsd: number | null;
  costSource: 'estimated' | 'unavailable';
  /** Token fields that were unknown and counted as zero, or 'pricing' / 'tokens' when nothing could be estimated. */
  missing: string[];
  assumptions: string[];
}

export interface EstimateOptions {
  /**
   * Whether input_tokens already contains the cached tokens. Claude reports
   * them separately; the codex sample (input 24763, cached 24448) is only
   * consistent with cached being a subset of input. That reading is inferred,
   * not documented, so it is a per-provider switch rather than a constant.
   */
  inputIncludesCacheRead?: boolean;
  /**
   * The cache TTL is not reported per request. The 1 hour rate is the higher
   * of the two, so the default never understates spend.
   */
  cacheWriteTtl?: '5m' | '1h';
}

const INCLUDES_CACHE_READ: Record<string, boolean> = { codex: true };

export function inputIncludesCacheRead(provider: string): boolean {
  return INCLUDES_CACHE_READ[provider] ?? false;
}

/** Cost from token counts and per-MTok pricing. Always labelled 'estimated'; never a reported figure. */
export function estimateCost(usage: TokenCounts, pricing: ModelPricing | null, opts: EstimateOptions = {}): CostEstimate {
  if (!pricing) return { costUsd: null, costSource: 'unavailable', missing: ['pricing'], assumptions: [] };
  if (!isCount(usage.inputTokens) && !isCount(usage.outputTokens)) {
    return { costUsd: null, costSource: 'unavailable', missing: ['tokens'], assumptions: [] };
  }
  const missing: string[] = [];
  const count = (name: keyof TokenCounts): number => {
    const v = usage[name];
    if (isCount(v)) return v;
    missing.push(name);
    return 0;
  };
  const input = count('inputTokens');
  const output = count('outputTokens');
  const cacheRead = count('cacheReadTokens');
  const cacheWrite = count('cacheWriteTokens');
  const ttl = opts.cacheWriteTtl ?? '1h';
  const uncached = opts.inputIncludesCacheRead ? Math.max(0, input - cacheRead) : input;
  const writeRate = ttl === '5m' ? pricing.cache_write_5m : pricing.cache_write_1h;
  const usd = (uncached * pricing.input + output * pricing.output + cacheRead * pricing.cache_read + cacheWrite * writeRate) / 1_000_000;
  const assumptions = cacheWrite > 0 ? [`cache writes priced at the ${ttl} rate because the TTL is not reported`] : [];
  return { costUsd: roundUsd(usd), costSource: 'estimated', missing, assumptions };
}

/** Six decimal places: below a millionth of a dollar is float noise, not spend. */
export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isCount(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}
