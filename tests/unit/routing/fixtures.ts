import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import type { RouteSignals, RoutingPolicy } from '../../../src/routing/types.ts';

export const HAIKU = 'claude-haiku-4-5-20251001';
export const SONNET = 'claude-sonnet-5-5';
export const OPUS = 'claude-opus-5-5';
export const FABLE = 'claude-fable-5-1';
export const CLAUDE_MODELS = [HAIKU, SONNET, OPUS, FABLE];

/** Fake codex catalog in the documented per-model shape (codex-cli.md section 6). */
export function codexCatalog(): unknown {
  return {
    models: [
      {
        slug: 'codex-alpha',
        display_name: 'Codex Alpha',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'ultra' }],
        visibility: 'list',
        supported_in_api: true,
        priority: 1,
      },
      {
        slug: 'codex-beta',
        display_name: 'Codex Beta',
        default_reasoning_level: 'low',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
        visibility: 'list',
        supported_in_api: true,
        priority: 2,
      },
      { slug: 'codex-internal', display_name: 'Hidden', supported_reasoning_levels: [], visibility: 'hide', priority: 0 },
    ],
  };
}

export interface Fixture {
  db: OrbitDb;
  clock: ManualClock;
  registry: ModelRegistry;
}

/** A seeded registry with every Claude model validated on the CLI and, optionally, the codex catalog loaded. */
export function setup(opts: { codex?: boolean; available?: string[] } = {}): Fixture {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  createRun(db, { id: 'run-1', repoRoot: '/repo/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  const registry = new ModelRegistry(db, clock);
  registry.seed();
  for (const id of opts.available ?? CLAUDE_MODELS) registry.markAvailability(id, 'claude-cli', true, 'validated by a minimal run');
  if (opts.codex !== false) registry.registerCodexCatalog(codexCatalog(), { source: 'live' });
  return { db, clock, registry };
}

export function policy(patch: Partial<RoutingPolicy> & { allowed?: string[] } = {}): RoutingPolicy {
  return {
    routing: patch.routing ?? { allowed_models: patch.allowed ?? [HAIKU, SONNET, OPUS, 'codex:*'], overrides: {} },
    review: patch.review ?? { independent_provider_required: true, preferred_provider: 'codex', fallback_same_provider_allowed: false },
    providers: patch.providers ?? { codex: { model: null, data_policy_eligible: true, reasoning_effort: null } },
    scheduler: patch.scheduler ?? { repeated_failure_threshold: 2 },
  };
}

export function signals(patch: Partial<RouteSignals> = {}): RouteSignals {
  return { difficulty: 'simple', attempt: 1, repeatedFingerprints: 0, ...patch };
}
