import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { sha256 } from '../core/hash.ts';
import { redact } from '../core/redact.ts';
import type { IsolationProvider } from '../isolation/types.ts';
import { prepareWorkerTmpDir } from '../isolation/profiles.ts';
import { dependencyAuditPolicy } from '../policy/config.ts';
import type { AuditSeverity, CheckDefinition, DependencyAuditConfig, PolicySnapshot } from '../policy/types.ts';
import { exceptionExpiryMs } from '../review/resolve.ts';
import type { OrbitDb } from '../storage/db.ts';
import { appendEvent } from '../storage/events.ts';
import { cleanupCandidateCheckout, materializeCandidate } from './candidate.ts';
import { resolveCommit, treeOf } from './git.ts';
import { assertRunPolicy, baselineSubject, candidateSubject, INSTALL_CHECK_ID, INSTALL_SCRIPTS_CHECK_ID, runCheckSet, type CheckSubject, type RunnerContext } from './runner.ts';
import { recordFailure } from './store.ts';
import type { Candidate, CheckResult, CheckStatus } from './types.ts';

/**
 * Baseline and dependency install (spec §6 Preflight, §5 dependency gate).
 * Before the implementer changes anything, the mandatory checks run on the
 * base revision so failures that were already there are recorded and never
 * blamed on the candidate. Dependencies come from the existing lockfile only,
 * with install scripts denied unless policy allows or allowlists them, and the
 * only network the install gets is the package registry.
 *
 * Vulnerability and license policy (`dependencies.audit`, spec section 5
 * baseline gate): when enabled, `npm audit` runs on the base revision and its
 * findings, with the licenses the lockfile records, are part of the
 * baseline. A candidate that changes package.json or the lockfile is audited
 * again, and its install is refused (with a recorded failure per finding,
 * which drives the repair brief) when it introduces a vulnerability at or
 * above `fail_on`, or a package whose license is not on `license_allowlist`,
 * that no unexpired `exceptions` entry accepts. Findings already on the base
 * are recorded, never blamed on the candidate.
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
  /** True when the install ran and every step passed (flaky passes included, the install is not evidence), and the dependency audit found nothing new that blocks. */
  ok: boolean;
  results: CheckResult[];
  /** The candidate's dependency audit against the baseline, when `dependencies.audit` is enabled. */
  audit?: AuditGateOutcome | null;
}

/**
 * Install dependencies into `ctx.checkoutDir` from the existing lockfile,
 * inside isolation with registry-only network. Bound to `candidate` when
 * given (a candidate checkout), otherwise to the base revision tree.
 */
export async function installDependencies(ctx: RunnerContext & { baseTree?: string; candidate?: Candidate; registryHosts?: readonly string[] }): Promise<InstallOutcome> {
  const plan = planInstall(ctx.snapshot, ctx.checkoutDir, { registryHosts: ctx.registryHosts });
  if (plan.skip) {
    // Nothing to install, but a candidate's lockfile can still bring in what the audit policy forbids.
    const audit = ctx.candidate ? await auditCandidate({ ...ctx, candidate: ctx.candidate }) : null;
    if (audit && audit.blocking.length > 0) return { skipped: false, reason: audit.summary, ok: false, results: [], audit };
    return { skipped: true, reason: plan.reason, ok: false, results: [], audit };
  }
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
  const ok = results.length === plan.definitions.length && results.every((r) => r.status === 'PASSED');
  if (!ok || !ctx.candidate) return { skipped: false, reason: null, ok, results };
  const audit = await auditCandidate({ ...ctx, candidate: ctx.candidate });
  if (audit && audit.blocking.length > 0) return { skipped: false, reason: audit.summary, ok: false, results, audit };
  return { skipped: false, reason: null, ok, results, audit };
}

// ---------------------------------------------------------------------------
// dependency audit

/** Check id of the generated npm audit step. */
export const AUDIT_CHECK_ID = 'orbit-dependency-audit';
const AUDIT_TIMEOUT_SECONDS = 300;
const AUDIT_REPORT = 'npm-audit.json';
const MANIFEST_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'];
const SEVERITY_RANK: Record<AuditSeverity, number> = { critical: 4, high: 3, moderate: 2, low: 1 };

export interface AuditFinding {
  /** GHSA-... (or npm:<source>) for a vulnerability; license:<package>@<version> for a license. */
  id: string;
  kind: 'vulnerability' | 'license';
  package: string;
  /** Vulnerabilities only. */
  severity: AuditSeverity | null;
  /** Advisory title or the license expression, redacted and bounded. */
  detail: string;
}

/** What one audit of one tree found. */
export interface DependencyAudit {
  ran: boolean;
  /** Why it did not run, or what was partial. */
  reason: string | null;
  /** sha256 of package.json and the lockfile, so a candidate that leaves them alone is not audited again. */
  manifestHash: string | null;
  vulnerabilities: AuditFinding[];
  /** Packages whose license is not on the allowlist (empty when there is no license policy). */
  licenses: AuditFinding[];
  logPath: string | null;
}

export interface AuditGateOutcome {
  /** False when the candidate's manifests equal the base's, so there was nothing new to audit. */
  audited: boolean;
  candidate: DependencyAudit | null;
  /** New findings at or above fail_on, and new disallowed licenses, not excepted. */
  blocking: AuditFinding[];
  /** New vulnerabilities below fail_on: disclosed, not blocking. */
  advisory: AuditFinding[];
  excepted: { finding: AuditFinding; reason: string; expires: string | null }[];
  /** Exceptions that matched but had expired. */
  expired: { id: string; expires: string }[];
  /** Findings the base revision already had. */
  preexisting: AuditFinding[];
  summary: string | null;
}

export function manifestHash(dir: string): string | null {
  const parts: string[] = [];
  for (const f of MANIFEST_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) parts.push(`${f}\0${sha256(readFileSync(p))}`);
  }
  return parts.length > 0 ? sha256(parts.join('\n')) : null;
}

/**
 * Findings from `npm audit --json` (report version 2, npm 7 and later). Each
 * advisory a vulnerable package carries directly becomes one finding; the
 * string entries of `via` only point at another package's advisory, which is
 * listed under that package. A report npm wrote for an error is refused.
 */
export function parseNpmAudit(text: string): AuditFinding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('npm audit did not write a JSON report');
  }
  const d = doc as { error?: { summary?: unknown; code?: unknown }; vulnerabilities?: unknown };
  if (d.error) throw new Error(`npm audit failed: ${redact(String(d.error.summary ?? d.error.code ?? 'error')).slice(0, 200)}`);
  if (!d.vulnerabilities || typeof d.vulnerabilities !== 'object') throw new Error('the npm audit report has no vulnerabilities section (npm 7 or later is needed)');
  const out = new Map<string, AuditFinding>();
  for (const [name, v] of Object.entries(d.vulnerabilities as Record<string, { via?: unknown }>)) {
    if (!Array.isArray(v?.via)) continue;
    for (const via of v.via as unknown[]) {
      if (!via || typeof via !== 'object') continue;
      const a = via as { source?: unknown; url?: unknown; severity?: unknown; title?: unknown; name?: unknown };
      const ghsa = typeof a.url === 'string' ? /GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/.exec(a.url)?.[0] : undefined;
      const id = ghsa ?? (typeof a.source === 'number' || typeof a.source === 'string' ? `npm:${a.source}` : null);
      const severity = typeof a.severity === 'string' && Object.hasOwn(SEVERITY_RANK, a.severity) ? (a.severity as AuditSeverity) : null;
      if (!id || !severity) continue;
      const pkg = typeof a.name === 'string' ? a.name : name;
      out.set(`${id}\0${pkg}`, { id, kind: 'vulnerability', package: pkg, severity, detail: redact(typeof a.title === 'string' ? a.title : '').slice(0, 200) });
    }
  }
  return [...out.values()].sort((x, y) => x.id.localeCompare(y.id) || x.package.localeCompare(y.package));
}

/**
 * Packages in an npm lockfile (v2 and v3 record each package's license)
 * whose license is not allowed. An SPDX `OR` is allowed when one side is,
 * an `AND` only when every part is; a package with no license field is not
 * allowed. The root project itself is not judged.
 */
export function disallowedLicenses(lockText: string, allowlist: readonly string[]): AuditFinding[] {
  let lock: { packages?: Record<string, { name?: unknown; version?: unknown; license?: unknown; link?: unknown }> };
  try {
    lock = JSON.parse(lockText) as typeof lock;
  } catch {
    throw new Error('the lockfile is not valid JSON');
  }
  if (!lock.packages || typeof lock.packages !== 'object') throw new Error('the lockfile has no packages section (lockfileVersion 2 or later records licenses)');
  const allowed = new Set(allowlist.map((l) => l.toLowerCase()));
  const out = new Map<string, AuditFinding>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || !entry || typeof entry !== 'object' || entry.link === true) continue;
    const name = typeof entry.name === 'string' ? entry.name : key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const version = typeof entry.version === 'string' ? entry.version : '0.0.0';
    const license = typeof entry.license === 'string' ? entry.license : null;
    if (license !== null && licenseAllowed(license, allowed)) continue;
    const id = `license:${name}@${version}`;
    out.set(id, { id, kind: 'license', package: name, severity: null, detail: license ?? 'no license recorded' });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function licenseAllowed(expr: string, allowed: ReadonlySet<string>): boolean {
  const e = expr.replace(/[()]/g, ' ').trim().toLowerCase();
  return e.split(/\s+or\s+/).some((alt) => alt.split(/\s+and\s+/).every((part) => allowed.has(part.trim())));
}

function lockfileIn(dir: string): string | null {
  for (const f of ['npm-shrinkwrap.json', 'package-lock.json']) if (existsSync(join(dir, f))) return join(dir, f);
  return null;
}

/**
 * Audit the checkout in `ctx.checkoutDir` for `subject`: npm audit inside
 * isolation with registry-only network (no scripts run; the lockfile is all
 * it reads), and the license policy from the lockfile. Null when the policy
 * has the audit off.
 */
export async function runDependencyAudit(ctx: RunnerContext & { registryHosts?: readonly string[] }, subject: CheckSubject): Promise<DependencyAudit | null> {
  const policy = dependencyAuditPolicy(ctx.snapshot.config);
  if (!policy.enabled) return null;
  const hash = manifestHash(ctx.checkoutDir);
  const lock = lockfileIn(ctx.checkoutDir);
  if (!lock) return { ran: false, reason: 'no npm lockfile (package-lock.json or npm-shrinkwrap.json); the dependency audit supports npm lockfiles only', manifestHash: hash, vulnerabilities: [], licenses: [], logPath: null };
  const problems: string[] = [];
  let licenses: AuditFinding[] = [];
  if (policy.license_allowlist !== null) {
    try {
      licenses = disallowedLicenses(readFileSync(lock, 'utf8'), policy.license_allowlist);
    } catch (err) {
      problems.push(`license policy not checked: ${(err as Error).message}`);
    }
  }
  const def: CheckDefinition = {
    id: AUDIT_CHECK_ID,
    // The report goes to a file, so warnings on stderr cannot corrupt it; a written report is success even when it lists vulnerabilities.
    command: [`npm audit --json --package-lock-only > "$ORBIT_ARTIFACTS_DIR/${AUDIT_REPORT}"; s=$?; if [ -s "$ORBIT_ARTIFACTS_DIR/${AUDIT_REPORT}" ]; then exit 0; fi; exit $s`],
    shell: true,
    cwd: '.',
    timeout_seconds: AUDIT_TIMEOUT_SECONDS,
    network_hosts: [...(ctx.registryHosts ?? NPM_REGISTRY_HOSTS)],
    env: { npm_config_fund: 'false', npm_config_progress: 'false', npm_config_update_notifier: 'false' },
    mandatory: false,
    flaky_reruns: 0,
    kind: 'command',
  };
  const [r] = await runCheckSet({ ...ctx, definitions: { ...ctx.definitions, [AUDIT_CHECK_ID]: def } }, subject, [def]);
  let vulnerabilities: AuditFinding[] = [];
  let ran = false;
  if (!r) problems.push('npm audit did not start (cancelled)');
  else if (r.status !== 'PASSED') problems.push(`npm audit ${r.status === 'TIMEOUT' ? 'timed out' : `could not produce a report (${r.status})`}`);
  else {
    const report = r.artifacts.find((a) => a.path.endsWith(`/${AUDIT_REPORT}`));
    try {
      if (!report) throw new Error('npm audit wrote no report');
      vulnerabilities = parseNpmAudit(readFileSync(report.path, 'utf8'));
      ran = true;
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  return { ran, reason: problems.length ? problems.join('; ') : null, manifestHash: hash, vulnerabilities, licenses, logPath: r?.logPath ?? null };
}

/**
 * Judge a candidate's audit against the base's. A finding is new when the
 * base audit did not have it; when the base could not be audited every
 * finding counts as new, since nothing shows it was already there.
 */
export function evaluateDependencyAudit(base: DependencyAudit | null | undefined, candidate: DependencyAudit, policy: DependencyAuditConfig, now: number | undefined): Omit<AuditGateOutcome, 'audited' | 'candidate' | 'summary'> {
  const known = new Set(base?.ran ? [...base.vulnerabilities, ...base.licenses].map(key) : base ? base.licenses.map(key) : []);
  const out: Omit<AuditGateOutcome, 'audited' | 'candidate' | 'summary'> = { blocking: [], advisory: [], excepted: [], expired: [], preexisting: [] };
  for (const f of [...candidate.vulnerabilities, ...candidate.licenses]) {
    if (known.has(key(f))) {
      out.preexisting.push(f);
      continue;
    }
    const exception = policy.exceptions.find((e) => e.id === f.id || (f.kind === 'license' && e.id === `license:${f.package}`));
    if (exception) {
      if (exception.expires !== null && (now === undefined || now > exceptionExpiryMs(exception.expires))) {
        if (!out.expired.some((x) => x.id === exception.id)) out.expired.push({ id: exception.id, expires: exception.expires });
      } else {
        out.excepted.push({ finding: f, reason: exception.reason, expires: exception.expires });
        continue;
      }
    }
    if (f.kind === 'license' || SEVERITY_RANK[f.severity!] >= SEVERITY_RANK[policy.fail_on]) out.blocking.push(f);
    else out.advisory.push(f);
  }
  return out;
}

function key(f: AuditFinding): string {
  return `${f.id}\0${f.package}`;
}

function describeFinding(f: AuditFinding): string {
  return f.kind === 'license' ? `${f.package} is licensed ${f.detail}, which is not on the license allowlist` : `${f.package}: ${f.id} (${f.severity})${f.detail ? ` ${f.detail}` : ''}`;
}

/** The candidate side of the dependency gate, called from installDependencies after a successful candidate install. */
async function auditCandidate(ctx: RunnerContext & { candidate: Candidate; registryHosts?: readonly string[] }): Promise<AuditGateOutcome | null> {
  const policy = dependencyAuditPolicy(ctx.snapshot.config);
  if (!policy.enabled) return null;
  const baseline = readJsonIfExists<BaselineReport>(join(ctx.runDir, BASELINE_FILE));
  const baseAudit = baseline?.audit ?? null;
  const empty = { blocking: [], advisory: [], excepted: [], expired: [], preexisting: [] };
  if (baseAudit && baseAudit.manifestHash !== null && baseAudit.manifestHash === manifestHash(ctx.checkoutDir)) {
    return { audited: false, candidate: null, ...empty, summary: null };
  }
  const subject: CheckSubject = { ...candidateSubject(ctx.runDir, ctx.candidate), source: 'install' };
  const audit = await runDependencyAudit(ctx, subject);
  if (!audit) return null;
  const judged = evaluateDependencyAudit(baseAudit, audit, policy, ctx.clock.now());
  const summary = judged.blocking.length
    ? `dependency audit: the candidate introduces ${judged.blocking.length} finding(s) the policy blocks: ${judged.blocking.slice(0, 5).map(describeFinding).join('; ')}`
    : audit.ran
      ? null
      : `dependency audit unverified: ${audit.reason ?? 'npm audit did not run'}`;
  for (const f of judged.blocking) {
    recordFailure(ctx.db, { runId: ctx.run.id, candidateId: ctx.candidate.id, source: 'install', sourceId: `dependency-audit:${ctx.candidate.id}:${f.id}:${f.package}`, fingerprint: `dependency-audit:${f.id}`, excerpt: describeFinding(f) }, ctx.clock);
  }
  ctx.db.tx(() =>
    appendEvent(ctx.db, ctx.run.id, 'dependency.audit', 'controller', {
      candidate_id: ctx.candidate.id,
      ran: audit.ran,
      reason: audit.reason,
      blocking: judged.blocking.map((f) => f.id),
      advisory: judged.advisory.map((f) => f.id),
      excepted: judged.excepted.map((e) => ({ id: e.finding.id, reason: e.reason })),
      expired: judged.expired,
      preexisting: judged.preexisting.length,
    }, ctx.clock.now()),
  );
  return { audited: true, candidate: audit, ...judged, summary };
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
  /** The base revision's dependency audit; absent when `dependencies.audit` is off (or in baselines recorded before it existed). */
  audit?: DependencyAudit | null;
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
    const audit = await runDependencyAudit({ ...ctx, registryHosts: input.registryHosts }, baselineSubject(runDir, baseTree, 'install'));

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
      ...(audit ? { audit } : {}),
      checks: entries,
      failures: entries.filter((e) => e.mandatory && (e.status === 'FAILED' || e.status === 'TIMEOUT')).map((e) => ({ checkId: e.checkId, fingerprint: e.fingerprint, excerpt: e.excerpt })),
      // Every requested check produced a decisive result (no ERROR, no CANCELLED, none skipped).
      complete: (install.skipped || install.ok) && entries.length === defs.length && entries.every((e) => e.status === 'PASSED' || e.status === 'FAILED' || e.status === 'TIMEOUT'),
      recordedAt: clock.now(),
    };
    atomicWriteJson(file, report);
    const auditSummary = audit ? { ran: audit.ran, reason: audit.reason, vulnerabilities: audit.vulnerabilities.length, disallowed_licenses: audit.licenses.length } : null;
    db.tx(() => appendEvent(db, run.id, 'baseline.recorded', 'controller', { base_revision: baseRevision, base_tree: baseTree, failures: report.failures.map((f) => f.checkId), complete: report.complete, audit: auditSummary }, clock.now()));
    return { report, results, reused: false };
  } finally {
    await cleanupCandidateCheckout(input.repoRoot, checkoutDir);
  }
}
