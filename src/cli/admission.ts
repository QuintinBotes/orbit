/**
 * Admission: the problems `orbit run` can detect cheaply, before it creates a
 * run. A run that is created and then blocked at preflight has already frozen
 * a policy that cannot be corrected (the fix does not change the snapshot),
 * and goes on to spend a curator call for nothing, so a dirty working tree, a
 * repository whose git configuration holds credentials, and a failing
 * environment gate (isolation, credentials, reviewer) are refused here. The
 * controller's preflight judges the same things again, with the same gate
 * functions, so the two cannot disagree about what a problem is.
 *
 * The checks that need nothing from this process's environment apply to every run, detached or not: no commits, no
 * checks defined, a UI policy without Playwright, a dirty tree, credentials in git configuration. Only a run that this
 * process will drive (`--foreground`) is judged against this process's environment (isolation, credentials, the
 * reviewer, and the gh CLI and GH_TOKEN of a delivering mode): a detached run is picked up by the service, whose
 * credentials and PATH are its own, and the controller's preflight judges those again there.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { OrbitError, type OrbitErrorCode } from '../core/errors.ts';
import { openDb } from '../storage/db.ts';
import type { OrbitConfig, PolicySnapshot } from '../policy/types.ts';
import type { ProviderCapabilities, CredentialStatus } from '../adapters/types.ts';
import { getIsolation } from '../isolation/index.ts';
import { validateCredentials } from '../recovery/credentials.ts';
import { selectReviewer, type ReviewerSelection } from '../review/select.ts';
import { defaultControllerDeps, environmentGate, orbitInstallDir, stateDbPath } from '../controller/index.ts';
import { deliveryEnvironmentProblem } from '../controller/delivery-env.ts';
import { git } from '../evidence/git.ts';
import { IMPLEMENTER_PROVIDER, dirtyPaths, gitCredentialProblems } from '../controller/steps/preflight.ts';
import type { RunRecord } from '../controller/run-store.ts';
import type { CliContext } from './context.ts';
import { reviewFix } from './review-fix.ts';
import { orbitHint } from '../core/invocation.ts';

export interface AdmissionInput {
  repo: string;
  config: OrbitConfig;
  /** This process will drive the run, so its environment is the one that matters. */
  foreground: boolean;
}

/** Why a run may not start: the reasons, the code the exit status derives from, and what to do. */
export interface Refusal {
  reasons: string[];
  code: OrbitErrorCode;
  fix: string;
}

export type AdmissionCheck = (ctx: CliContext, input: AdmissionInput) => Promise<Refusal | null>;

const ENVIRONMENT_CODES: ReadonlySet<string> = new Set(['AUTH_EXPIRED', 'AUTH_MISSING', 'PROVIDER_UNAVAILABLE', 'ISOLATION_UNAVAILABLE', 'POLICY_DENIED']);

/** Refuses with an OrbitError (so the CLI's exit code follows the cause) before anything has been created. */
export async function admitRun(ctx: CliContext, input: AdmissionInput): Promise<void> {
  const check: AdmissionCheck = ctx.seams.admission ?? checkAdmission;
  const refusal = await check(ctx, input);
  if (!refusal) return;
  // A reason that already ends in a full stop must not double it, and the fix starts its own line: it is the part a person acts on.
  const reasons = refusal.reasons.map((r) => r.trim().replace(/[.\s]+$/, ''));
  throw new OrbitError(refusal.code, `cannot start a run: ${reasons.join('; ')}.\nNo run was created and no model was called. To fix: ${refusal.fix.trim().replace(/[.\s]+$/, '')}.`, { problems: refusal.reasons });
}

export const checkAdmission: AdmissionCheck = async (ctx, input) => {
  const { repo, config } = input;
  const cheap: string[] = [];
  const fixes: string[] = [];

  // A repository with no commits has no base revision: preflight would retry git five times, spend a model call, and
  // end with an empty "git rev-parse failed". Its files are all "uncommitted", so that is not reported on top of it.
  const hasCommits = await repositoryHasCommits(repo);
  if (!hasCommits) {
    cheap.push('the repository has no commits, so a run has no base revision to start from');
    fixes.push('make an initial commit (git add -A && git commit -m "initial commit"), then run again');
  }
  // No checks: no acceptance criterion can cite one, so the contract is "not measurable" and the run blocks after
  // spending planner and curator calls.
  if (Object.keys(config.checks).length === 0) {
    cheap.push('no checks are defined in the policy, so no acceptance criterion can be measured');
    fixes.push('define at least one check under checks: in .orbit/config.yaml (the starter lists commented examples)');
  }
  // The policy asks for UI verification, which runs through Playwright, and the repository has none.
  if ((config.ui !== null || Object.values(config.checks).some((c) => c.kind === 'playwright')) && !playwrightInstalled(repo)) {
    cheap.push('the policy has a ui section or a playwright check, but @playwright/test is not installed in this repository');
    fixes.push('npm install -D @playwright/test, then npx playwright install (or remove the ui section and the playwright check from .orbit/config.yaml)');
  }
  const credentialProblems = await gitCredentialProblems(repo);
  if (credentialProblems.length > 0) {
    cheap.push(`the repository's git configuration carries credentials a worker could read (${credentialProblems.join('; ')})`);
    fixes.push('remove them and authenticate through a credential helper outside the repository');
  }
  const dirty = hasCommits ? await dirtyPaths(repo) : [];
  if (dirty.length > 0 && !config.repository.allow_dirty_start) {
    cheap.push(`the repository has uncommitted changes (${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ', ...' : ''})`);
    fixes.push('commit or stash them, or set repository.allow_dirty_start in .orbit/config.yaml, then run again');
  }
  if (cheap.length > 0) return { reasons: cheap, code: 'POLICY_DENIED', fix: fixes.join('; ') };

  if (!input.foreground) return null;
  const gate = await environmentProblems(ctx, input);
  // Delivery needs its credentials as much as the models do, and finds out only at the end, after the usage is spent.
  const delivery = deliveryEnvironmentProblem(config, ctx.env);
  if (gate === null && delivery === null) return null;
  const reasons = [...(gate?.reasons ?? []), ...(delivery ? [`mode ${config.mode} delivers through GitHub, but ${delivery.summary}`] : [])];
  const fix = [gate ? (gate.fix ?? `${orbitHint('doctor')} shows each failing capability with the command that fixes it; then run again`) : null, delivery ? `${delivery.fix} (or set mode: autonomous to run without delivery), then run again` : null].filter((f): f is string => f !== null).join('; and ');
  return { reasons, code: gate?.code ?? delivery!.code, fix };
};

/** Whether HEAD names a commit. */
async function repositoryHasCommits(repo: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    return true;
  } catch {
    return false;
  }
}

function playwrightInstalled(repo: string): boolean {
  try {
    createRequire(join(repo, 'package.json')).resolve('@playwright/test/package.json');
    return true;
  } catch {
    return false;
  }
}

async function environmentProblems(ctx: CliContext, input: AdmissionInput): Promise<{ reasons: string[]; code: OrbitErrorCode; fix?: string } | null> {
  const { repo, config } = input;
  // The repository's own registry when it has one (so a refreshed Codex catalog counts), otherwise the shipped seed in memory.
  const persisted = existsSync(stateDbPath(repo));
  const db = persisted ? openDb(stateDbPath(repo)) : openDb(':memory:');
  try {
    const factory = ctx.seams.controllerDeps ?? defaultControllerDeps;
    const deps = factory({ repoRoot: repo, db, clock: ctx.clock, config, env: ctx.env, orbitHome: ctx.orbitHome });
    try {
      deps.registry.seed();
    } catch {
      // The same tolerance as the controller's preflight: a registry that cannot be seeded shows up as a missing model below.
    }
    const snapshot: PolicySnapshot = { schema: 'orbit.policy/1', run_id: 'admission', created_at: new Date(ctx.clock.now()).toISOString(), repo_root: repo, config, effective_protected_paths: [], check_config_hashes: {} };

    let isolation: Parameters<typeof environmentGate>[0]['isolation'];
    try {
      const iso = deps.isolationFor ? deps.isolationFor(snapshot, { id: 'admission', mode: config.mode } as RunRecord) : getIsolation(config.isolation, { orbitInstallDir: deps.orbitInstallDir ?? orbitInstallDir(), mode: config.mode });
      const status = await iso.available();
      isolation = { kind: iso.kind, available: status.ok, detail: status.detail };
    } catch (err) {
      isolation = { error: err instanceof Error ? err.message : String(err) };
    }

    const capabilities: Record<string, ProviderCapabilities> = {};
    for (const [id, adapter] of Object.entries(deps.adapters)) {
      try {
        capabilities[id] = await adapter.discoverCapabilities();
      } catch (err) {
        capabilities[id] = { provider: id, available: false, version: null, models: [], structuredOutput: false, readOnlySandbox: false, usageReporting: 'none', costReporting: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }
    const required = new Set<string>([IMPLEMENTER_PROVIDER]);
    if (config.review.independent_provider_required && config.review.preferred_provider !== IMPLEMENTER_PROVIDER) required.add(config.review.preferred_provider);
    const all = await validateCredentials({ adapters: deps.adapters, providers: [...new Set([...required, ...Object.keys(deps.adapters)])] });
    const credentialsById: Record<string, CredentialStatus | undefined> = {};
    for (const c of all) credentialsById[c.provider] = c.status ?? undefined;

    let reviewer: ReviewerSelection | null = null;
    if (config.review.independent_provider_required) {
      reviewer = selectReviewer({ snapshot, capabilities, credentials: credentialsById, implementer: { provider: IMPLEMENTER_PROVIDER, model: null }, registry: deps.registry });
      if (reviewer.decision === 'SELECT') {
        required.delete(config.review.preferred_provider);
        required.add(reviewer.provider);
      }
    }
    const gate = environmentGate({ snapshot, mode: config.mode, isolation, credentials: all.filter((c) => required.has(c.provider)), reviewer });
    if (gate.passed) return null;
    const code = gate.details.code;
    return {
      reasons: gate.reasons.map((r) => `environment gate: ${r}`),
      code: code !== null && ENVIRONMENT_CODES.has(code) ? (code as OrbitErrorCode) : 'PROVIDER_UNAVAILABLE',
      // The reviewer is the most common cause on a fresh setup, and its fix is specific.
      ...(reviewer?.decision === 'BLOCK' ? { fix: `${reviewFix(reviewer.alternatives)}, then run again (${orbitHint('doctor')} shows every failing capability)` } : {}),
    };
  } finally {
    db.close();
  }
}
