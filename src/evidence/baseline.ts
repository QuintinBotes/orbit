import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { sha256 } from '../core/hash.ts';
import type { IsolationProvider } from '../isolation/types.ts';
import { prepareWorkerTmpDir } from '../isolation/profiles.ts';
import type { CheckDefinition, PolicySnapshot } from '../policy/types.ts';
import type { OrbitDb } from '../storage/db.ts';
import { appendEvent } from '../storage/events.ts';
import { cleanupCandidateCheckout, materializeCandidate } from './candidate.ts';
import { resolveCommit, treeOf } from './git.ts';
import { assertRunPolicy, baselineSubject, candidateSubject, INSTALL_CHECK_ID, INSTALL_SCRIPTS_CHECK_ID, runCheckSet, type CheckSubject, type RunnerContext } from './runner.ts';
import type { Candidate, CheckResult, CheckStatus } from './types.ts';

/**
 * Baseline and dependency install (spec §6 Preflight, §5 dependency gate).
 * Before the implementer changes anything, the mandatory checks run on the
 * base revision so failures that were already there are recorded and never
 * blamed on the candidate. Dependencies come from the existing lockfile only,
 * with install scripts denied unless policy allows or allowlists them, and the
 * only network the install gets is the package registry.
 */

export const BASELINE_FILE = 'baseline.json';
export { INSTALL_SCRIPTS_CHECK_ID };
export const NPM_REGISTRY_HOSTS: readonly string[] = ['registry.npmjs.org'];

const INSTALL_TIMEOUT_SECONDS = 900;
const OTHER_LOCKFILES = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock'];

export type InstallPlan =
  | { skip: true; reason: string }
  | { skip: false; definitions: CheckDefinition[] };

export interface InstallPolicyOptions {
  /** Hosts the install may reach. Default: the public npm registry. */
  registryHosts?: readonly string[];
}

/** Decide, from policy and the checkout's lockfile, which install commands (if any) to run. */
export function planInstall(snapshot: PolicySnapshot, checkoutDir: string, opts: InstallPolicyOptions = {}): InstallPlan {
  const deps = snapshot.config.dependencies;
  if (!deps.install_existing_lockfile) return { skip: true, reason: 'policy does not allow installing dependencies from the existing lockfile' };
  const hosts = [...(opts.registryHosts ?? NPM_REGISTRY_HOSTS)];
  const base = { shell: false, cwd: '.', timeout_seconds: INSTALL_TIMEOUT_SECONDS, network_hosts: hosts, mandatory: false, flaky_reruns: 1, kind: 'command' as const };
  const quiet = { npm_config_fund: 'false', npm_config_audit: 'false', npm_config_progress: 'false', npm_config_update_notifier: 'false' };
  const scriptsDenied = deps.install_scripts !== 'allow';

  if (deps.install_command) {
    return {
      skip: false,
      definitions: [
        {
          ...base,
          id: INSTALL_CHECK_ID,
          command: [...deps.install_command],
          // A configured command cannot be given a flag blindly, so scripts are denied through the package managers' own environment switches.
          env: { ...quiet, ...(scriptsDenied ? { npm_config_ignore_scripts: 'true', YARN_ENABLE_SCRIPTS: 'false' } : {}) },
        },
      ],
    };
  }
  const hasNpmLock = existsSync(join(checkoutDir, 'package-lock.json')) || existsSync(join(checkoutDir, 'npm-shrinkwrap.json'));
  if (!hasNpmLock) {
    const other = OTHER_LOCKFILES.find((f) => existsSync(join(checkoutDir, f)));
    return {
      skip: true,
      reason: other
        ? `found ${other}, which Orbit does not install by itself; set dependencies.install_command to install from it`
        : 'no lockfile to install from; Orbit never creates one',
    };
  }
  const defs: CheckDefinition[] = [{ ...base, id: INSTALL_CHECK_ID, command: scriptsDenied ? ['npm', 'ci', '--ignore-scripts'] : ['npm', 'ci'], env: quiet }];
  if (deps.install_scripts === 'deny-unless-allowlisted' && deps.install_script_allowlist.length > 0) {
    // Only the named packages get their lifecycle scripts, after the install that ran none.
    defs.push({ ...base, id: INSTALL_SCRIPTS_CHECK_ID, command: ['npm', 'rebuild', ...deps.install_script_allowlist], env: quiet, flaky_reruns: 0 });
  }
  return { skip: false, definitions: defs };
}

export interface InstallOutcome {
  skipped: boolean;
  reason: string | null;
  /** True when the install ran and every step passed (flaky passes included, the install is not evidence). */
  ok: boolean;
  results: CheckResult[];
}

/**
 * Install dependencies into `ctx.checkoutDir` from the existing lockfile,
 * inside isolation with registry-only network. Bound to `candidate` when
 * given (a candidate checkout), otherwise to the base revision tree.
 */
export async function installDependencies(ctx: RunnerContext & { baseTree?: string; candidate?: Candidate; registryHosts?: readonly string[] }): Promise<InstallOutcome> {
  const plan = planInstall(ctx.snapshot, ctx.checkoutDir, { registryHosts: ctx.registryHosts });
  if (plan.skip) return { skipped: true, reason: plan.reason, ok: false, results: [] };
  const definitions = { ...ctx.definitions, ...Object.fromEntries(plan.definitions.map((d) => [d.id, d])) };
  let subject: CheckSubject;
  if (ctx.candidate) subject = { ...candidateSubject(ctx.runDir, ctx.candidate), source: 'install' };
  else if (ctx.baseTree) subject = baselineSubject(ctx.runDir, ctx.baseTree, 'install');
  else throw new OrbitError('INTERNAL', 'installDependencies needs a candidate or a base tree to bind to');
  const results: CheckResult[] = [];
  for (const def of plan.definitions) {
    const [r] = await runCheckSet({ ...ctx, definitions }, subject, [def]);
    if (!r) break; // cancelled before it started
    results.push(r);
    if (r.status !== 'PASSED') break; // the allowlisted rebuild is pointless after a failed install
  }
  return { skipped: false, reason: null, ok: results.length === plan.definitions.length && results.every((r) => r.status === 'PASSED'), results };
}

// ---------------------------------------------------------------------------
// baseline

export interface BaselineCheckEntry {
  checkId: string;
  mandatory: boolean;
  status: CheckStatus;
  exitCode: number | null;
  flaky: boolean;
  fingerprint: string | null;
  excerpt: string | null;
  log: string;
}

export interface BaselineReport {
  schema: 'orbit.baseline/1';
  runId: string;
  baseRevision: string;
  baseTree: string;
  /** Policy hash and the sorted check ids this baseline covers: a later call reuses it only for the same policy and set. */
  policyHash: string;
  checkIds: string[];
  install: { skipped: boolean; reason: string | null; ok: boolean };
  checks: BaselineCheckEntry[];
  /** Mandatory checks that already fail (or time out) on the base revision. */
  failures: { checkId: string; fingerprint: string | null; excerpt: string | null }[];
  /** False when the run was cancelled or a check could not run; such a baseline is not reused. */
  complete: boolean;
  recordedAt: number;
}

export interface RunBaselineInput {
  db: OrbitDb;
  run: { id: string; policyHash: string };
  repoRoot: string;
  baseRev: string;
  snapshot: PolicySnapshot;
  isolation: IsolationProvider;
  runDir: string;
  clock: Clock;
  signal?: AbortSignal;
  parallelism?: number;
  pollMs?: number;
  killGraceMs?: number;
  homeDir?: string;
  /** Checks to run; default is every mandatory command check in the snapshot. */
  checkIds?: readonly string[];
  /** Where to check out the base revision; default is a private temp directory. */
  checkoutDir?: string;
  registryHosts?: readonly string[];
}

export interface BaselineOutcome {
  report: BaselineReport;
  results: CheckResult[];
  /** True when an earlier complete baseline for the same revision was returned without running anything. */
  reused: boolean;
}

export async function runBaseline(input: RunBaselineInput): Promise<BaselineOutcome> {
  const { db, run, snapshot, runDir, clock } = input;
  assertRunPolicy(db, run, snapshot);
  const baseRevision = await resolveCommit(input.repoRoot, input.baseRev);
  const baseTree = await treeOf(input.repoRoot, baseRevision);

  const ids = input.checkIds ?? Object.values(snapshot.config.checks).filter((c) => c.mandatory && c.kind === 'command').map((c) => c.id);
  for (const id of ids) {
    if (!snapshot.config.checks[id]) throw new OrbitError('POLICY_DENIED', `baseline check ${JSON.stringify(id)} is not defined in the policy snapshot`, { checkId: id });
  }
  const defs = [...new Set(ids)].map((id) => snapshot.config.checks[id]!).filter((d) => d.kind === 'command');
  const checkIds = defs.map((d) => d.id).sort();

  const file = join(runDir, BASELINE_FILE);
  const prior = readJsonIfExists<BaselineReport>(file);
  // Reused only when it answers exactly this question: a baseline of fewer checks would leave the extra ones without a pre-existing record.
  if (
    prior &&
    prior.schema === 'orbit.baseline/1' &&
    prior.complete &&
    prior.baseRevision === baseRevision &&
    prior.policyHash === run.policyHash &&
    Array.isArray(prior.checkIds) &&
    prior.checkIds.join('\0') === checkIds.join('\0')
  ) {
    return { report: prior, results: [], reused: true };
  }

  const checkoutDir = input.checkoutDir ?? join(prepareWorkerTmpDir(join(runDir, 'baseline-checkout')), `base-${sha256(run.id).slice(0, 8)}`);
  await cleanupCandidateCheckout(input.repoRoot, checkoutDir);
  await materializeCandidate(input.repoRoot, baseRevision, checkoutDir, { readOnly: false });
  try {
    const ctx: RunnerContext = {
      db,
      run,
      snapshot,
      isolation: input.isolation,
      checkoutDir,
      runDir,
      clock,
      signal: input.signal,
      parallelism: input.parallelism,
      pollMs: input.pollMs,
      killGraceMs: input.killGraceMs,
      homeDir: input.homeDir,
    };
    const install = await installDependencies({ ...ctx, baseTree, registryHosts: input.registryHosts });
    const results = install.skipped || install.ok ? await runCheckSet(ctx, baselineSubject(runDir, baseTree), defs) : [];

    const entries: BaselineCheckEntry[] = results.map((r) => ({
      checkId: r.checkId,
      mandatory: snapshot.config.checks[r.checkId]?.mandatory === true,
      status: r.status,
      exitCode: r.exitCode,
      flaky: r.flaky,
      fingerprint: r.fingerprint,
      excerpt: r.excerpt,
      log: r.logPath,
    }));
    const report: BaselineReport = {
      schema: 'orbit.baseline/1',
      runId: run.id,
      baseRevision,
      baseTree,
      policyHash: run.policyHash,
      checkIds,
      install: { skipped: install.skipped, reason: install.reason, ok: install.ok },
      checks: entries,
      failures: entries.filter((e) => e.mandatory && (e.status === 'FAILED' || e.status === 'TIMEOUT')).map((e) => ({ checkId: e.checkId, fingerprint: e.fingerprint, excerpt: e.excerpt })),
      // Every requested check produced a decisive result (no ERROR, no CANCELLED, none skipped).
      complete: (install.skipped || install.ok) && entries.length === defs.length && entries.every((e) => e.status === 'PASSED' || e.status === 'FAILED' || e.status === 'TIMEOUT'),
      recordedAt: clock.now(),
    };
    atomicWriteJson(file, report);
    db.tx(() => appendEvent(db, run.id, 'baseline.recorded', 'controller', { base_revision: baseRevision, base_tree: baseTree, failures: report.failures.map((f) => f.checkId), complete: report.complete }, clock.now()));
    return { report, results, reused: false };
  } finally {
    await cleanupCandidateCheckout(input.repoRoot, checkoutDir);
  }
}
