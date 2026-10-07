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
import { BASELINE_FILE, runBaseline, type BaseFailureClassification, type BaselineReport } from '../../evidence/baseline.ts';
import type { EnvironmentSignal } from '../../evidence/environment-failure.ts';
import { raiseBaselineExceptionQuestions } from '../../inquisition/baseline-exception.ts';
import { validateCredentials, type BlockedCredentialState, type CredentialCheck } from '../../recovery/credentials.ts';
import { mandatoryReviewProvider, selectReviewer, selectionDecisionRecord, type ReviewerSelection } from '../../review/select.ts';
import type { ProviderCapabilities, CredentialStatus } from '../../adapters/types.ts';
import { homeOf, runWorktreeRoot, toolchainCacheRootFor, type RunContext } from '../context.ts';
import { baselineGate, environmentGate, intakeGate, type GateResult } from '../gates.ts';
import { deliveryEnvironmentProblem } from '../delivery-env.ts';
import { baselineBlockReason, baselineEnvironmentFailures, baselineMisconfiguredChecks, misconfiguredRecord, type AmendedCheck, type BlockedCheck, type MisconfiguredBlock } from '../environment-block.ts';
import { MISSING_TARGET_KIND } from './baseline-questions.ts';
import { blockOnAuth, decide, finishRun, move, safePoint, type StepResult } from './common.ts';
import { workerPluginsStep } from './worker-plugins.ts';
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
  // Issue #22: workers that would load a plugin the policy does not allow are all refused after they start, so the run is
  // refused here, before a base-revision check, a question or a worker costs anything.
  const plugins = await workerPluginsStep(ctx);
  if (plugins) return plugins;

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
    toolchainCacheRoot: toolchainCacheRootFor(ctx),
  });
  const after = await safePoint(ctx);
  if (after) return after;
  // Every failure of the base revision is classified before any is called pre-existing (ADR 0010), the gate included. A
  // check whose tool rejected its command line (issue #23) or that the environment stopped (issue #10) never tested the
  // repository's code, so it is no pre-existing failure and gets no baseline-exception question: approving one would let
  // a run pass with a check that never ran. A check whose command names something that does not exist yet (a missing
  // target) goes on to CONTRACTING, which expects it to flip when the contract names it and blocks on it as misconfigured
  // when the contract does not (steps/baseline-questions.ts); it is never accepted as an exception either. Only what is
  // left is a failure of the code.
  const found = classifyBaseline(ctx, baseline.report, join(wtRoot, 'baseline'));
  const { report: classified, misconfigured, missingTargets, environment: notRun } = found;
  const bg = baselineGate(classified);
  recordGate(ctx, bg);
  if (!bg.passed && bg.status === 'fail') return finishRun(ctx, 'BLOCKED', `baseline gate: ${bg.reasons.join('; ')}`, { outcome: { gate: bg } });
  if (misconfigured.length > 0 || notRun.length > 0) return blockOnBaseline(ctx, classified, { environment: notRun, misconfigured });
  const { preExisting } = askAboutBaseFailures(ctx, found, { baseRevision: head, key: '' });

  const worktree = await ensureWorktree(repo, join(wtRoot, 'implementer'), head);
  const branch = `${ctx.snapshot.config.repository.branch_prefix}${ctx.run.id}`;
  const noted = [...(preExisting.length > 0 ? [`${preExisting.length} pre-existing failure(s)`] : []), ...(missingTargets.length > 0 ? [`${missingTargets.length} check(s) whose target does not exist yet (${missingTargets.map((m) => m.checkId).join(', ')})`] : [])];
  return move(ctx, 'CONTRACTING', `preflight passed at ${head.slice(0, 12)}${noted.length > 0 ? ` with ${noted.join(' and ')}` : ''}`, {
    patch: { baseRevision: head, baseTree, worktreePath: worktree, branch },
    data: { base_revision: head, base_tree: baseTree, worktree, environment: env.gate.notes },
  });
}

/** What the base revision's failures are (ADR 0010), as PREFLIGHT or a baseline amendment (ADR 0012) classified them. */
export interface BaselineClassification {
  /** The baseline with each failure that is not the repository's code marked with its classification. */
  report: BaselineReport;
  /** Checks whose tool rejected the command line they run. */
  misconfigured: MisconfiguredBlock[];
  /** Checks whose command names something the base revision does not have. */
  missingTargets: MisconfiguredBlock[];
  /** Checks the environment stopped before they ran anything of the repository. */
  environment: BlockedCheck[];
}

/**
 * Classify the failures of `report` (only those of the checks in `only`, when given: a baseline amendment judges the
 * checks it ran, and the rest were judged when they ran), in the order of ADR 0010: a misconfigured check, a missing
 * target, an environment failure, and what is left a pre-existing failure of the code.
 */
export function classifyBaseline(ctx: RunContext, report: BaselineReport, checkoutDir: string, only: ReadonlySet<string> | null = null): BaselineClassification {
  const judged = only === null ? report : { ...report, failures: report.failures.filter((f) => only.has(f.checkId)) };
  const commandErrors = baselineMisconfiguredChecks(ctx, judged);
  const misconfigured = commandErrors.filter((m) => m.kind === 'argument');
  const missingTargets = commandErrors.filter((m) => m.kind === 'missing-target');
  const environment = baselineEnvironmentFailures(ctx, judged, checkoutDir).filter((f) => !commandErrors.some((m) => m.checkId === f.checkId));
  return { report: classifiedBaseline(report, environment, misconfigured, missingTargets), misconfigured, missingTargets, environment };
}

/**
 * The baseline report with each failure PREFLIGHT found was not the repository's code marked with its classification,
 * and an environment failure with the signals that showed it (a candidate's denial counts only when its signal is there).
 */
function classifiedBaseline(report: BaselineReport, environment: readonly BlockedCheck[], misconfigured: readonly MisconfiguredBlock[], missingTargets: readonly MisconfiguredBlock[]): BaselineReport {
  if (environment.length === 0 && misconfigured.length === 0 && missingTargets.length === 0) return report;
  const marks = new Map<string, { classification: BaseFailureClassification; signals?: EnvironmentSignal[] }>([
    ...environment.map((f) => [f.checkId, { classification: 'environment' as const, signals: f.signals }] as const),
    ...misconfigured.map((m) => [m.checkId, { classification: 'misconfigured' as const }] as const),
    ...missingTargets.map((m) => [m.checkId, { classification: 'missing-target' as const }] as const),
  ]);
  return { ...report, failures: report.failures.map((f) => ({ ...f, ...(marks.get(f.checkId) ?? {}) })) };
}

/**
 * Record the base revision's failures that do not block the run (a baseline that blocks records its own,
 * blockOnBaseline): the missing targets, with the baseline that marks them, and the pre-existing failures of the code,
 * and ask a person about each of both (P18 settles a missing target's question against the contract,
 * steps/baseline-questions.ts). `key` sets the decisions of a baseline amendment apart from PREFLIGHT's, and `only`
 * limits it to the checks the amendment ran.
 */
export function askAboutBaseFailures(ctx: RunContext, found: BaselineClassification, opts: { baseRevision: string; key: string; only?: ReadonlySet<string> }): { preExisting: BaselineReport['failures'] } {
  const { report: classified, missingTargets } = found;
  const head = opts.baseRevision;
  const suffix = opts.key === '' ? '' : `-${opts.key}`;
  const mine = classified.failures.filter((f) => opts.only === undefined || opts.only.has(f.checkId));
  const preExisting = mine.filter((f) => f.classification === undefined);
  if (missingTargets.length > 0) {
    // Recorded with the baseline, so CONTRACTING and the baseline-exception guard know these checks' targets are missing.
    atomicWriteJson(join(ctx.runDir, BASELINE_FILE), classified);
    decide(ctx, {
      id: `dec-${ctx.run.id}-baseline-missing-target-${opts.key === '' ? classified.recordedAt : opts.key}`,
      kind: MISSING_TARGET_KIND,
      summary: `on ${head.slice(0, 12)} the command of ${missingTargets.length > 1 ? 'checks' : 'check'} ${missingTargets.map((m) => m.checkId).join(', ')} names something that does not exist yet: expected to flip if the contract names ${missingTargets.length > 1 ? 'them' : 'it'} as the proof of a criterion, otherwise misconfigured; never a baseline exception`,
      data: { base_revision: head, checks: missingTargets.map((m) => misconfiguredRecord(m)) },
    });
  }
  if (preExisting.length > 0) {
    decide(ctx, {
      id: `dec-${ctx.run.id}-baseline-failures${suffix}`,
      kind: 'baseline.failures',
      summary: `pre-existing failures on ${head.slice(0, 12)}: ${preExisting.map((f) => f.checkId).join(', ')}`,
      data: { failures: preExisting },
    });
  }
  // Spec section 6: a run is never green while a mandatory check fails, unless the contract accepts a documented
  // baseline exception. Only a person can accept one, so each pre-existing failure becomes a question; the run goes
  // on, and an approved answer (`orbit decide`) adds the exception to the contract, bound to the recorded fingerprint. A
  // missing target is asked about too, so that P18 settles it like any failure the goal may make pass: its question is
  // withdrawn once the contract names the check, and an approval of it is refused (inquisition/baseline-exception.ts).
  const asked = mine.filter((f) => f.classification === undefined || f.classification === 'missing-target');
  if (asked.length > 0) {
    const raised = raiseBaselineExceptionQuestions({ db: ctx.db, clock: ctx.clock, runId: ctx.run.id, runDir: ctx.runDir }, { failures: asked, baseRevision: head });
    if (raised.skipped.length > 0) {
      decide(ctx, {
        id: `dec-${ctx.run.id}-baseline-exception-skipped${suffix}`,
        kind: 'baseline.exception-unavailable',
        summary: `no baseline exception can be offered for: ${raised.skipped.map((s) => s.checkId).join(', ')} (${raised.skipped[0]!.why})`,
        data: { skipped: raised.skipped },
      });
    }
  }
  return { preExisting };
}

/**
 * End the run BLOCKED at PREFLIGHT for checks that are misconfigured or could not run on the base revision. The
 * baseline is kept for the record, each such failure marked with its classification (classifiedBaseline; which also
 * keeps a baseline exception from ever being applied to it, inquisition/baseline-exception.ts, and makes the next
 * baseline run it again, evidence/baseline.ts), and marked incomplete, which is what it is (a check produced no result
 * of its own), so `orbit resume` runs the baseline again once the cause is fixed instead of reusing it. The decisions
 * name the classification and the first error line of each check (orbit timeline shows them); their ids carry the
 * baseline's time, so a resumed run that blocks again records the new baseline's decisions next to the old.
 *
 * A baseline amendment (`amendment`, ADR 0012) blocks the same way at the step that ran it, with the reason saying why the
 * check ran on the base revision after PREFLIGHT and the decisions keyed by the amendment's time. It leaves the baseline
 * complete: the classification it records is what makes the next amendment run the check again.
 */
export async function blockOnBaseline(
  ctx: RunContext,
  report: BaselineReport,
  blocked: { environment: BlockedCheck[]; misconfigured: MisconfiguredBlock[] },
  amendment: { at: number; stage: string; checks: readonly AmendedCheck[] } | null = null,
): Promise<StepResult> {
  const { environment, misconfigured } = blocked;
  atomicWriteJson(join(ctx.runDir, BASELINE_FILE), (amendment ? report : { ...report, complete: false }) satisfies BaselineReport);
  const reason = baselineBlockReason({ runId: ctx.run.id, baseRevision: report.baseRevision, environment, misconfigured, ...(amendment ? { amended: amendment.checks } : {}) });
  const environmentChecks = environment.map((f) => ({ check_id: f.checkId, classification: 'environment', signals: f.signals, cause: f.cause, evidence_lines: f.lines, ...(f.logPath ? { log_path: f.logPath } : {}) }));
  const misconfiguredChecks = misconfigured.map((m) => misconfiguredRecord(m));
  const at = amendment ? `amended-${amendment.at}` : String(report.recordedAt);
  const stage = amendment ? { stage: amendment.stage } : {};
  if (misconfiguredChecks.length > 0) decide(ctx, { id: `dec-${ctx.run.id}-baseline-misconfigured-${at}`, kind: 'baseline.check-misconfigured', summary: reason, data: { base_revision: report.baseRevision, ...stage, checks: misconfiguredChecks } });
  if (environmentChecks.length > 0) decide(ctx, { id: `dec-${ctx.run.id}-baseline-environment-${at}`, kind: 'baseline.environment-failure', summary: reason, data: { base_revision: report.baseRevision, ...stage, checks: environmentChecks } });
  return finishRun(ctx, 'BLOCKED', reason, {
    outcome: { base_revision: report.baseRevision, ...stage, ...(environmentChecks.length > 0 ? { environment_failures: environmentChecks } : {}), ...(misconfiguredChecks.length > 0 ? { misconfigured_checks: misconfiguredChecks } : {}) },
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
  const mandatory = mandatoryReviewProvider(config.review, IMPLEMENTER_PROVIDER);
  if (mandatory !== null) required.add(mandatory);
  const all = await validateCredentials({ adapters: ctx.deps.adapters, providers: [...new Set([...required, ...Object.keys(ctx.deps.adapters)])] });
  const credentialsById: Record<string, CredentialStatus | undefined> = {};
  for (const c of all) credentialsById[c.provider] = c.status ?? undefined;

  // Who would review, judged in every mode (decision 0007): an independent reviewer, a same-provider review that
  // review.when_unavailable allows (stated in the gate and the report), or a block.
  const reviewer: ReviewerSelection = selectReviewer({ snapshot: ctx.snapshot, capabilities, credentials: credentialsById, implementer: { provider: IMPLEMENTER_PROVIDER, model: null }, registry: ctx.deps.registry });
  // With independent review mandatory, any usable independent provider is enough; the preferred one need not be.
  if (mandatory !== null && reviewer.decision === 'SELECT') {
    required.delete(mandatory);
    required.add(reviewer.provider);
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
