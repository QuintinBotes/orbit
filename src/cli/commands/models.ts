/**
 * `orbit models list|refresh`: the model registry as the router sees it.
 * Availability is per execution surface and is never assumed from API
 * availability: a model is "unvalidated" until Orbit has seen it run (or a
 * live probe succeeded), and "unavailable" when a check said so.
 */
import { existsSync } from 'node:fs';
import { OrbitError } from '../../core/errors.ts';
import { execCapture } from '../../core/exec.ts';
import { defaultConfig, loadConfig } from '../../policy/index.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import type { OrbitDb } from '../../storage/db.ts';
import { openDb } from '../../storage/db.ts';
import { ClaudeAdapter, commandArgv, compareVersions, createAdapter, providerKind } from '../../adapters/index.ts';
import { ModelRegistry, allowMatch } from '../../routing/registry.ts';
import { saveSharedCatalog, sharedCatalogPath } from '../../routing/shared-catalog.ts';
import type { EligibilityAssessment, ModelEntry, Surface } from '../../routing/types.ts';
import { stateDbPath } from '../../controller/start.ts';
import type { Args, OptionSpec } from '../args.ts';
import { openState, resolveRepo, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { flat, json, line, table } from '../io.ts';

export const MODELS_REFRESH_OPTIONS: OptionSpec = {
  probe: { type: 'boolean', description: 'also make one tiny live request per allowed Claude model to validate it (costs a few cents)' },
};

function configOrDefault(repo: string): { config: OrbitConfig; loaded: boolean } {
  try {
    return { config: loadConfig(repo), loaded: true };
  } catch {
    return { config: defaultConfig(), loaded: false };
  }
}

export async function modelsListCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const { config, loaded } = configOrDefault(repo);
  const persisted = existsSync(stateDbPath(repo));
  const db: OrbitDb = persisted ? openState(repo) : openDb(':memory:');
  try {
    const registry = new ModelRegistry(db, ctx.clock).useSharedCatalog(sharedCatalogPath(ctx.orbitHome));
    // A fresh registry shows the shipped seed; an existing one is shown as it is, runtime observations and all.
    if (!persisted || registry.list().length === 0) registry.seed();
    // The Codex catalog a refresh in any repository saved for this user counts here too (NM6).
    registry.adoptSharedCatalog();
    const entries = registry.list();
    const assessments = new Map<Surface, EligibilityAssessment>();
    for (const surface of ['claude-cli', 'codex-cli'] as const) assessments.set(surface, registry.assess({ surface, allowedModels: config.routing.allowed_models }));
    // Reviewer selection (review/select.ts) offers a provider's own models for review on top of routing.allowed_models,
    // and a Claude reviewer must also be allowed by policy: the list judges the same way, so it cannot contradict doctor.
    const reviewKey = (surface: Surface, provider: string) => `${surface}|${provider}`;
    const reviewAssessments = new Map<string, EligibilityAssessment>();
    for (const e of entries) {
      for (const s of e.surfaces) {
        const key = reviewKey(s.surface, e.provider);
        if (!reviewAssessments.has(key)) reviewAssessments.set(key, registry.assess({ surface: s.surface, provider: e.provider, allowedModels: [...config.routing.allowed_models, `${e.provider}:*`], structuredOutput: true }));
      }
    }
    const rows = entries.flatMap((e) =>
      (e.surfaces.length ? e.surfaces : [{ surface: 'claude-cli' as Surface, available: null, detail: null, checkedAt: null }]).map((s) => {
        const a = assessments.get(s.surface);
        const reasons = a?.excluded.find((x) => x.model.modelId === e.modelId)?.reasons ?? [];
        const eligible = a?.eligible.some((x) => x.modelId === e.modelId) ?? false;
        const policy = allowMatch(e, config.routing.allowed_models);
        // "Not yet validated" is not a reason to refuse a model: doctor calls it eligible, unvalidated, and so does this list.
        const onlyUnvalidated = !eligible && reasons.length > 0 && reasons.every((r) => /not yet validated$/.test(r));
        const forReview = reviewAssessments.get(reviewKey(s.surface, e.provider));
        const reviewEligible = (forReview?.eligible.some((x) => x.modelId === e.modelId) ?? false) && (e.provider !== 'claude' || policy !== null);
        const reviewUnvalidated = !reviewEligible && (e.provider !== 'claude' || policy !== null) && (forReview?.excluded.find((x) => x.model.modelId === e.modelId)?.reasons ?? []).length > 0 && (forReview?.excluded.find((x) => x.model.modelId === e.modelId)?.reasons ?? []).every((r) => /not yet validated$/.test(r));
        return {
          review_eligible: reviewEligible || reviewUnvalidated,
          review: reviewEligible ? 'yes' : reviewUnvalidated ? 'yes, unvalidated' : 'no',
          model: e.modelId,
          provider: e.provider,
          family: e.family,
          surface: s.surface,
          availability: s.available === true ? 'available' : s.available === false ? 'unavailable' : 'unvalidated',
          availability_detail: s.detail,
          policy: policy === 'explicit' ? 'allowed' : policy === 'wildcard' ? 'wildcard' : 'not allowed',
          eligible,
          status: eligible ? 'eligible' : onlyUnvalidated ? 'eligible-unvalidated' : 'excluded',
          reasons,
        };
      }),
    );
    if (args.bool('json')) {
      json(ctx.io, { config_loaded: loaded, persisted, allowed_models: config.routing.allowed_models, models: rows });
      return EXIT.OK;
    }
    ctx.io.out(table(rows.map((r) => [r.model, r.surface, r.availability, r.policy, r.status === 'eligible' ? 'yes' : r.status === 'eligible-unvalidated' ? 'yes, unvalidated' : `no: ${r.reasons.join('; ')}`, r.review]), ['MODEL', 'SURFACE', 'AVAILABILITY', 'POLICY', 'ELIGIBLE', 'REVIEW']));
    if (!loaded) line(ctx.io, '\n(no valid .orbit/config.yaml: showing eligibility under the default allowed_models)');
    if (!persisted) line(ctx.io, '(no state database yet: showing the shipped registry seed)');
    line(ctx.io, '\nELIGIBLE is for implementation (routing.allowed_models); REVIEW is whether the model can be the independent reviewer, which also accepts any model of the reviewing provider.');
    line(ctx.io, 'unvalidated means Orbit has not yet seen the model run on that surface; "orbit models refresh --probe" checks it live.');
    return EXIT.OK;
  } finally {
    db.close();
  }
}

/**
 * The environment a provider CLI is started with when Orbit only asks it a question: no repository, no delivery
 * credentials. USER and LOGNAME let a macOS keychain login be found (see doctor's toolEnv).
 */
export function probeEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME', 'CODEX_API_KEY', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

export async function modelsRefreshCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const { config } = configOrDefault(repo);
  const db = openState(repo, { create: true });
  const notes: string[] = [];
  const changes: Record<string, unknown> = {};
  try {
    const registry = new ModelRegistry(db, ctx.clock).useSharedCatalog(sharedCatalogPath(ctx.orbitHome));
    const seeded = registry.seed();
    changes.seed = seeded;
    notes.push(`seeded the registry: ${seeded.inserted.length} added, ${seeded.updated.length} refreshed`);

    for (const [id, pc] of Object.entries(config.providers)) {
      let kind: 'claude' | 'codex';
      try {
        kind = providerKind(id);
      } catch (err) {
        notes.push(`provider ${id}: skipped (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      if (kind === 'claude') {
        const adapter = createAdapter(id, pc, { baseEnv: { ...probeEnv(ctx.env) }, clock: ctx.clock });
        const caps = await adapter.discoverCapabilities();
        if (!caps.available || !caps.version) {
          notes.push(`provider ${id}: claude CLI unavailable (${flat(caps.detail)}); registry availability left as it was`);
          continue;
        }
        notes.push(`provider ${id}: claude ${caps.version}`);
        for (const e of registry.list().filter((m) => m.provider === 'claude')) {
          const min = e.eligibility.minCliVersion;
          if (min && compareVersions(caps.version, min) < 0) {
            registry.markAvailability(e.modelId, 'claude-cli', false, `installed claude ${caps.version} is older than ${min}, which ${e.modelId} needs`);
            notes.push(`  ${e.modelId}: unavailable (needs claude >= ${min})`);
          }
        }
        if (args.bool('probe')) {
          const probe = (adapter as { probeCredentials?: ClaudeAdapter['probeCredentials'] }).probeCredentials;
          if (typeof probe !== 'function') {
            notes.push(`  --probe: ${id} has no live probe`);
            continue;
          }
          for (const e of registry.list().filter((m) => m.provider === 'claude' && allowMatch(m, config.routing.allowed_models) !== null)) {
            if (e.surfaces.some((s) => s.surface === 'claude-cli' && s.available === false)) continue;
            const st = await probe.call(adapter, { model: e.eligibility.cliAlias ?? e.modelId, timeoutMs: 90_000 });
            if (st.state === 'valid') {
              registry.markAvailability(e.modelId, 'claude-cli', true, `live probe succeeded (${st.method ?? 'credential'})`);
              notes.push(`  ${e.modelId}: validated by a live request`);
            } else notes.push(`  ${e.modelId}: probe inconclusive (${st.state}: ${flat(st.detail)}); not marked`);
          }
        }
      } else {
        const r = await execCapture([...commandArgv(pc.command), 'debug', 'models'], { env: probeEnv(ctx.env), timeoutMs: 60_000, cwd: repo }).catch((err: unknown) => err as Error);
        if (r instanceof Error) {
          notes.push(`provider ${id}: ${flat(r.message)}`);
          continue;
        }
        if (r.exitCode !== 0) {
          notes.push(`provider ${id}: "${pc.command} debug models" exited ${r.exitCode ?? 'by signal'}; registry availability left as it was`);
          continue;
        }
        try {
          const catalog = JSON.parse(r.stdout) as unknown;
          const res = registry.registerCodexCatalog(catalog, { source: 'live' });
          // Kept for the user, so the next repository does not need its own refresh (routing/shared-catalog.ts).
          saveSharedCatalog(sharedCatalogPath(ctx.orbitHome), catalog, ctx.clock.now());
          changes[`catalog:${id}`] = res;
          notes.push(`provider ${id}: ${res.listed.length} model(s) listed${res.hidden.length ? `, ${res.hidden.length} hidden` : ''}${res.absent.length ? `, ${res.absent.length} no longer offered` : ''}${res.providerDefault ? `; default ${res.providerDefault}` : ''}`);
        } catch (err) {
          throw new OrbitError('MALFORMED_OUTPUT', `${id}: "debug models" printed something that is not a model catalog (${err instanceof Error ? flat(err.message) : 'unreadable'})`);
        }
      }
    }
    if (args.bool('json')) json(ctx.io, { notes, changes, models: registry.list().map((e: ModelEntry) => ({ model: e.modelId, available: e.available })) });
    else for (const n of notes) line(ctx.io, n);
    return EXIT.OK;
  } finally {
    db.close();
  }
}
