/**
 * PREFLIGHT (spec section 6 "Preflight"): intake of the repository, the
 * environment gate, repository status and revision with dirty-start refusal,
 * the baseline (pre-existing failures recorded, never blamed on the run),
 * and the implementer's worktree outside the repository.
 *
 * Idempotent: the baseline is reused when complete for the same revision and
 * policy, the worktree is reused when it is already registered, and nothing
 * is recorded on the run row until the transition that leaves PREFLIGHT.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { atomicWriteJson } from '../../core/fsx.ts';
import { isOrbitError } from '../../core/errors.ts';
import { adminDirFor, git, resolveCommit, treeOf } from '../../evidence/git.ts';
import { runBaseline } from '../../evidence/baseline.ts';
import { raiseBaselineExceptionQuestions } from '../../inquisition/baseline-exception.ts';
import { validateCredentials, type BlockedCredentialState, type CredentialCheck } from '../../recovery/credentials.ts';
import { selectReviewer, selectionDecisionRecord, type ReviewerSelection } from '../../review/select.ts';
import type { ProviderCapabilities, CredentialStatus } from '../../adapters/types.ts';
import { homeOf, runWorktreeRoot, type RunContext } from '../context.ts';
import { baselineGate, environmentGate, intakeGate, type GateResult } from '../gates.ts';
import { deliveryEnvironmentProblem } from '../delivery-env.ts';
import { blockOnAuth, decide, finishRun, move, safePoint, type StepResult } from './common.ts';
import { messageOf } from '../workers.ts';

/** The provider that implements. Routing only offers claude-cli models for implementation (spec section 8). */
export const IMPLEMENTER_PROVIDER = 'claude';

export async function preflightStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;

  const intake = intakeGate({ run: ctx.run, snapshot: ctx.snapshot });
  recordGate(ctx, intake);
  if (!intake.passed) return finishRun(ctx, 'BLOCKED', `intake gate: ${intake.reasons.join('; ')}`, { outcome: { gate: intake } });

  const env = await checkEnvironment(ctx);
  recordGate(ctx, env.gate);
  if (!env.gate.passed) {
    const auth = env.credentials.find((c) => c.provider === env.gate.details.blockedProvider && c.verdict === 'blocked');
    if (auth?.status) return blockOnAuth(ctx, auth.provider, auth.status.state as BlockedCredentialState, auth.status.detail);
    return finishRun(ctx, 'BLOCKED', `environment gate: ${env.gate.reasons.join('; ')}`, { outcome: { gate: env.gate } });
  }

  const repo = ctx.run.repoRoot;
  // ADR 0005: the worker may read the shared git directory, so credentials in the git configuration are refused up front.
  const credentialProblems = await gitCredentialProblems(repo);
  if (credentialProblems.length > 0) {
    return finishRun(
      ctx,
      'BLOCKED',
      `the repository's git configuration carries credentials a worker could read (${credentialProblems.join('; ')}); remove them and authenticate through a credential helper outside the repository`,
      { outcome: { git_credentials: credentialProblems } },
    );
  }
  const head = await resolveCommit(repo, 'HEAD');
  const baseTree = await treeOf(repo, head);
  const dirty = await dirtyPaths(repo);
  if (dirty.length > 0) {
    if (!ctx.snapshot.config.repository.allow_dirty_start) {
      return finishRun(ctx, 'BLOCKED', `the repository has uncommitted changes (${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ', ...' : ''}); commit or stash them, or set repository.allow_dirty_start`, { outcome: { dirty: dirty.slice(0, 50) } });
    }
    decide(ctx, { id: `dec-${ctx.run.id}-dirty-start`, kind: 'preflight.dirty-start', summary: `dirty start allowed by policy; ${dirty.length} uncommitted path(s) are not part of the run, which starts from ${head}`, data: { paths: dirty.slice(0, 200) } });
  }

  // The baseline checkout lives with the run's other checkouts, outside the repository.
  const wtRoot = runWorktreeRoot(ctx);
  mkdirSync(wtRoot, { recursive: true, mode: 0o700 });
  const baseline = await runBaseline({
    db: ctx.db,
    run: { id: ctx.run.id, policyHash: ctx.run.policyHash },
    repoRoot: repo,
    baseRev: head,
    snapshot: ctx.snapshot,
    isolation: ctx.isolation(),
    runDir: ctx.runDir,
    clock: ctx.clock,
    signal: ctx.signal,
    pollMs: ctx.timing.checkPollMs,
    killGraceMs: ctx.timing.killGraceMs,
    homeDir: homeOf(ctx.deps),
    checkoutDir: join(wtRoot, 'baseline'),
  });
  const after = await safePoint(ctx);
  if (after) return after;
  const bg = baselineGate(baseline.report);
  recordGate(ctx, bg);
  if (!bg.passed && bg.status === 'fail') return finishRun(ctx, 'BLOCKED', `baseline gate: ${bg.reasons.join('; ')}`, { outcome: { gate: bg } });
  if (baseline.report.failures.length > 0) {
    decide(ctx, {
      id: `dec-${ctx.run.id}-baseline-failures`,
      kind: 'baseline.failures',
      summary: `pre-existing failures on ${head.slice(0, 12)}: ${baseline.report.failures.map((f) => f.checkId).join(', ')}`,
      data: { failures: baseline.report.failures },
    });
    // Spec section 6: a run is never green while a mandatory check fails, unless the contract accepts a documented
    // baseline exception. Only a person can accept one, so each pre-existing failure becomes a question; the run goes
    // on, and an approved answer (`orbit decide`) adds the exception to the contract, bound to the recorded fingerprint.
    const raised = raiseBaselineExceptionQuestions({ db: ctx.db, clock: ctx.clock, runId: ctx.run.id, runDir: ctx.runDir }, { failures: baseline.report.failures, baseRevision: head });
    if (raised.skipped.length > 0) {
      decide(ctx, {
        id: `dec-${ctx.run.id}-baseline-exception-skipped`,
        kind: 'baseline.exception-unavailable',
        summary: `no baseline exception can be offered for: ${raised.skipped.map((s) => s.checkId).join(', ')} (${raised.skipped[0]!.why})`,
        data: { skipped: raised.skipped },
      });
    }
  }

  const worktree = await ensureWorktree(repo, join(wtRoot, 'implementer'), head);
  const branch = `${ctx.snapshot.config.repository.branch_prefix}${ctx.run.id}`;
  return move(ctx, 'CONTRACTING', `preflight passed at ${head.slice(0, 12)}${baseline.report.failures.length ? ` with ${baseline.report.failures.length} pre-existing failure(s)` : ''}`, {
    patch: { baseRevision: head, baseTree, worktreePath: worktree, branch },
    data: { base_revision: head, base_tree: baseTree, worktree, environment: env.gate.notes },
  });
}

export function recordGate(ctx: RunContext, g: GateResult<unknown>): void {
  decide(ctx, {
    kind: `gate.${g.gate}`,
    summary: `${g.gate} gate ${g.status}${g.reasons.length ? `: ${g.reasons.join('; ')}` : ''}${g.notes.length ? ` (notes: ${g.notes.join('; ')})` : ''}`,
    data: { status: g.status, reasons: g.reasons, evidence: g.evidence, notes: g.notes, on_failure: g.onFailure },
  });
}

const URL_USERINFO = /^([a-z][a-z0-9+.-]*):\/\/([^/?#@]*)@/i;
const AUTH_HEADER = /authorization|cookie|bearer|token|api[-_]?key|secret/i;

/** Whether a URL carries userinfo that is a secret: any `user:password@`, or a bare userinfo on http(s), where it is a token. */
function urlCarriesCredentials(value: string): boolean {
  const m = URL_USERINFO.exec(value.trim());
  if (!m) return false;
  return m[2]!.includes(':') || /^https?$/i.test(m[1]!);
}

/**
 * Credential material in the repository's own git configuration (local and the common configuration of a linked
 * worktree), as plain descriptions that name the setting and never its value: userinfo in remote or rewritten
 * URLs, authorization headers in `http.*.extraheader`, literal credential settings, and a credential store file
 * inside the repository. A worker may read the shared git directory, so none of this may be there (ADR 0005).
 */
export async function gitCredentialProblems(repo: string): Promise<string[]> {
  const entries: { key: string; value: string }[] = [];
  for (const scope of ['--local', '--worktree']) {
    let out: string;
    try {
      out = await git(repo, ['config', scope, '--list', '-z']);
    } catch {
      continue; // no worktree-specific configuration
    }
    for (const raw of out.split('\0')) {
      if (!raw) continue;
      const nl = raw.indexOf('\n');
      entries.push(nl === -1 ? { key: raw, value: '' } : { key: raw.slice(0, nl), value: raw.slice(nl + 1) });
    }
  }
  const root = resolve(repo);
  const problems: string[] = [];
  const note = (text: string): void => {
    if (!problems.includes(text)) problems.push(text);
  };
  for (const { key, value } of entries) {
    const k = key.toLowerCase();
    if (/^remote\..+\.(?:url|pushurl)$/.test(k) && urlCarriesCredentials(value)) note(`${key} has credentials in its URL`);
    else if (/^url\..+\.(?:insteadof|pushinsteadof)$/.test(k) && (urlCarriesCredentials(value) || urlCarriesCredentials(key.slice(4, key.toLowerCase().lastIndexOf('.'))))) note('a url.<base>.insteadOf rewrite has credentials in a URL');
    else if (/^http\.(?:.+\.)?extraheader$/.test(k) && AUTH_HEADER.test(value)) note(`${key} sets an authorization header`);
    else if (/^credential\.(?:.+\.)?(?:password|token|secret)$/.test(k)) note(`${key} holds a literal credential`);
    else if (/^credential(?:\..+)?\.helper$/.test(k)) {
      const v = value.trim();
      if (v.startsWith('!') && /password|token|secret/i.test(v)) note(`${key} embeds a credential in a shell helper`);
      const store = /^store\b.*?--file(?:=|\s+)(\S+)/.exec(v);
      if (store) {
        const file = store[1]!.replace(/^["']|["']$/g, '');
        const abs = isAbsolute(file) ? resolve(file) : resolve(root, file);
        if (!isAbsolute(file) || abs === root || abs.startsWith(`${root}/`)) note(`${key} stores credentials in a file inside the repository`);
      }
    }
  }
  return problems;
}

/** Paths git reports as changed or untracked, leaving out Orbit's own state directory. */
export async function dirtyPaths(repo: string): Promise<string[]> {
  const out = await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).orbit']);
  return out
    .split('\0')
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3));
}

/**
 * The implementer's worktree, detached at the base revision, outside the
 * repository. Reused when already registered (a restart); a leftover
 * directory that git does not know is removed first.
 */
export async function ensureWorktree(repo: string, path: string, base: string): Promise<string> {
  if (existsSync(path)) {
    try {
      return (await adminDirFor(repo, path)).worktree;
    } catch (err) {
      if (!isOrbitError(err)) throw err;
      rmSync(path, { recursive: true, force: true });
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await git(repo, ['worktree', 'prune']);
  await git(repo, ['worktree', 'add', '--detach', '--force', path, base]);
  return (await adminDirFor(repo, path)).worktree;
}

export interface EnvironmentCheck {
  gate: GateResult<{ blockedProvider: string | null; code: string | null }>;
  credentials: CredentialCheck[];
  capabilities: Record<string, ProviderCapabilities>;
  reviewer: ReviewerSelection | null;
}

/**
 * Probe isolation, the providers the run cannot do without (the implementer,
 * and the reviewer when independent review is mandatory) and reviewer
 * selection, and judge them with the environment gate. Used at preflight and
 * again before review, because credentials can expire during a run.
 */
export async function checkEnvironment(ctx: RunContext): Promise<EnvironmentCheck> {
  const config = ctx.snapshot.config;
  try {
    ctx.deps.registry.seed();
  } catch (err) {
    ctx.log.warn('model registry seed failed', { error: messageOf(err) });
  }
  let isolation: Parameters<typeof environmentGate>[0]['isolation'];
  try {
    const iso = ctx.isolation();
    const status = await iso.available();
    isolation = { kind: iso.kind, available: status.ok, detail: status.detail };
  } catch (err) {
    isolation = { error: messageOf(err) };
  }

  const capabilities: Record<string, ProviderCapabilities> = {};
  for (const [id, adapter] of Object.entries(ctx.deps.adapters)) {
    try {
      capabilities[id] = await adapter.discoverCapabilities();
    } catch (err) {
      capabilities[id] = { provider: id, available: false, version: null, models: [], structuredOutput: false, readOnlySandbox: false, usageReporting: 'none', costReporting: false, detail: messageOf(err) };
    }
  }
  const required = new Set<string>([IMPLEMENTER_PROVIDER]);
  if (config.review.independent_provider_required && config.review.preferred_provider !== IMPLEMENTER_PROVIDER) required.add(config.review.preferred_provider);
  const all = await validateCredentials({ adapters: ctx.deps.adapters, providers: [...new Set([...required, ...Object.keys(ctx.deps.adapters)])] });
  const credentialsById: Record<string, CredentialStatus | undefined> = {};
  for (const c of all) credentialsById[c.provider] = c.status ?? undefined;

  let reviewer: ReviewerSelection | null = null;
  if (config.review.independent_provider_required) {
    reviewer = selectReviewer({ snapshot: ctx.snapshot, capabilities, credentials: credentialsById, implementer: { provider: IMPLEMENTER_PROVIDER, model: null }, registry: ctx.deps.registry });
    // With independent review mandatory, any usable independent provider is enough; the preferred one need not be.
    if (reviewer.decision === 'SELECT') {
      required.delete(config.review.preferred_provider);
      required.add(reviewer.provider);
    }
  }
  const credentials = all.filter((c) => required.has(c.provider));
  // A run handed to the service is judged for its delivery credentials here, in the service's own environment.
  const delivery = deliveryEnvironmentProblem(config, ctx.deps.hostEnv ?? process.env);
  const gate = environmentGate({ snapshot: ctx.snapshot, mode: ctx.run.mode, isolation, credentials, reviewer, delivery });
  atomicWriteJson(join(ctx.runDir, 'environment.json'), {
    checked_at: ctx.clock.now(),
    gate,
    capabilities,
    credentials: all.map((c) => ({ provider: c.provider, verdict: c.verdict, state: c.status?.state ?? null, method: c.status?.method ?? null, error: c.error })),
    reviewer: reviewer ? selectionDecisionRecord(reviewer).summary : null,
  });
  return { gate, credentials: all, capabilities, reviewer };
}
