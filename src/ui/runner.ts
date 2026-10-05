import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { systemClock, type Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { execCapture } from '../core/exec.ts';
import { atomicWriteJson, ensureDir } from '../core/fsx.ts';
import { hashObject, sha256 } from '../core/hash.ts';
import { redact, redactValue } from '../core/redact.ts';
import type { Candidate } from '../evidence/types.ts';
import { profileForCheck } from '../isolation/profiles.ts';
import type { IsolationProvider, SandboxProfile } from '../isolation/types.ts';
import { defaultCheck } from '../policy/config.ts';
import { compileGlobs } from '../policy/globs.ts';
import { snapshotHash } from '../policy/snapshot.ts';
import type { CheckDefinition, PolicySnapshot, UiConfig } from '../policy/types.ts';
import { assertBaseUrl, startApp, stopApp, type AppHandle } from './app-fixture.ts';
import { safeBaseEnv } from './env.ts';
import {
  describeError,
  failedStepPath,
  parseA11y,
  parseBrowserInfo,
  parseDiagnostics,
  parseErrorContext,
  parsePlaywrightReport,
  relativeTo,
  summarizeSteps,
  type ParsedReport,
  type RawAttachment,
  type RawResult,
  type RawTest,
} from './report.ts';
import type {
  UiA11yScan,
  UiArtifact,
  UiArtifactKind,
  UiCheckRun,
  UiDiagnostics,
  UiEvidenceEntry,
  UiJourneyResult,
  UiJourneyStatus,
  UiReproduction,
  UiRunResult,
  UiRunVerdict,
  Viewport,
} from './types.ts';

/**
 * Running the repository's Playwright journeys as trusted evidence (spec
 * section 13). The repository chooses the journeys and the config; Orbit
 * chooses everything that decides whether a result can be believed: where the
 * report goes, that snapshots are never updated, that traces are kept on
 * failure, and that the results are bound to one candidate.
 */

/**
 * Arguments the configured check may not carry. Each either rewrites a
 * stored expectation (-u, --update-snapshots, --ignore-snapshots), lets an
 * empty run pass (--pass-with-no-tests), changes what is recorded
 * (--reporter, --output, --trace, --retries) or needs a person
 * (--ui, --headed, --debug). Orbit adds its own values for the recording ones.
 */
const FORBIDDEN_ARG = /^(?:-u|--update-snapshots(?:=.*)?|--update-source-method(?:=.*)?|--ignore-snapshots|--pass-with-no-tests|--run-agents(?:=.*)?|--ui|--headed|--debug|--reporter(?:=.*)?|--add-reporter(?:=.*)?|--output(?:=.*)?|--trace(?:=.*)?|--retries(?:=.*)?)$/;

/** Spelling an author may repeat because it equals what Orbit enforces anyway (the example config does). */
const SAME_AS_ENFORCED = new Set(['--reporter=json', '--update-snapshots=none', '--trace=retain-on-failure']);

/** Bump when the enforced flags change: the version is part of the configuration hash. */
export const UI_ENFORCEMENT_VERSION = 1;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const GIT_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL'];

export const UI_LIMITATIONS: readonly string[] = [
  'Automated accessibility scans (axe-core) find only part of the possible accessibility problems; a clean scan is not a claim that the interface is accessible.',
  'Visual checks compare pixels against stored baselines on one browser and platform; they do not judge whether a layout is usable or correct.',
];

export interface UiRunInput {
  /** Checkout of the candidate tree (a worktree at the candidate commit). */
  checkoutDir: string;
  snapshot: PolicySnapshot;
  candidate: Candidate;
  uiConfig: UiConfig;
  /** Check ids of kind playwright; the config lists them in ui.journey_check_ids. */
  journeyCheckIds: string[];
  isolation: IsolationProvider;
  /** Evidence directory for this candidate's UI run, e.g. evidence/<seq>/ui. */
  outDir: string;
  clock?: Clock;
  /** Orbit's own environment, used only to build the safe base environment. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  /** Added to the application's environment (test data seeding). Never reaches the browser run. */
  appEnv?: Record<string, string>;
  /** Restrict the run to these Playwright projects (--project). */
  projects?: string[];
  abortSignal?: AbortSignal;
  homeDir?: string;
  /** Overrides the app start used by the run (tests). */
  appPollMs?: number;
}

export interface BaselineChange {
  status: string;
  path: string;
}

export async function runUiChecks(input: UiRunInput): Promise<UiRunResult> {
  const clock = input.clock ?? systemClock;
  const { snapshot, uiConfig, candidate } = input;
  const checkoutDir = realpathSync(input.checkoutDir);
  // Real path: attachment paths are resolved the same way, and macOS temp directories sit behind a symlink.
  const outDir = realpathSync(ensureDir(resolve(input.outDir)));
  const startedAt = clock.now();

  const checks = resolveChecks(snapshot, input.journeyCheckIds);
  for (const check of checks) assertCheckCommandAllowed(check);
  const baseUrl = uiConfig.environment.base_url;
  // Refused as a configuration error, not reported as a failed run: the journeys must not start at all.
  assertBaseUrl(baseUrl, uiConfig.environment.isolated_test_data);
  if (uiConfig.environment.production_accounts !== false) {
    throw new OrbitError('POLICY_DENIED', 'ui.environment.production_accounts must be false', { rule: 'ui.environment.production_accounts' });
  }

  await assertCheckoutMatchesCandidate(checkoutDir, candidate, outDir);
  const globs = compileGlobs(uiConfig.visual.baseline_globs, { nocase: false });
  const candidateChanges = await changedBetween(checkoutDir, candidate.parentSha, candidate.commitSha);
  const visualFromDiff = candidateChanges.filter((c) => globs(c.path)).map((c) => c.path);

  const configHash = hashObject({
    ui: uiConfig,
    checks: checks.map((c) => [c.id, snapshot.check_config_hashes[c.id] ?? hashObject(c)]),
    enforcement: UI_ENFORCEMENT_VERSION,
    projects: input.projects ?? null,
  });
  atomicWriteJson(join(outDir, 'ui-run.json'), { state: 'running', candidate: candidate.id, startedAt, checks: checks.map((c) => c.id) });

  const reasons: string[] = [];
  const unverified: string[] = [];
  const checkRuns: UiCheckRun[] = [];
  const journeys: UiJourneyResult[] = [];
  let terminal: UiRunVerdict | null = null;
  let app: AppHandle | null = null;
  const tmpDir = ensureDir(join(outDir, 'tmp'));
  const baseEnv = safeBaseEnv(input.hostEnv ?? process.env);
  const port = new URL(baseUrl).port;

  try {
    if (uiConfig.environment.start_command !== null) {
      const appCheck: CheckDefinition = { ...defaultCheck('ui-app'), command: uiConfig.environment.start_command, network_hosts: [], timeout_seconds: uiConfig.environment.ready_timeout_seconds };
      // startApp adds allowLocalBinding: the application is the one process here that must listen on loopback.
      const profile = profileForCheck({ worktree: checkoutDir, check: appCheck, snapshot, extraWritable: [tmpDir], homeDir: input.homeDir, env: input.hostEnv });
      try {
        app = await startApp({
          command: uiConfig.environment.start_command,
          cwd: checkoutDir,
          baseUrl,
          readyTimeoutMs: uiConfig.environment.ready_timeout_seconds * 1000,
          env: { ...(input.appEnv ?? {}), ORBIT_UI_BASE_URL: baseUrl, ...(port ? { PORT: port, ORBIT_UI_PORT: port } : {}), ORBIT_UI_ISOLATED_TEST_DATA: uiConfig.environment.isolated_test_data ? '1' : '0', TMPDIR: tmpDir },
          isolation: { provider: input.isolation, profile },
          isolatedTestData: uiConfig.environment.isolated_test_data,
          stateDir: join(outDir, 'app'),
          clock,
          pollMs: input.appPollMs,
          hostEnv: input.hostEnv,
        });
      } catch (err) {
        // Isolation that is missing or a policy refusal must stop the run; a server that will not start is a failed run.
        if (err instanceof OrbitError && (err.code === 'ISOLATION_UNAVAILABLE' || err.code === 'POLICY_DENIED')) throw err;
        terminal = 'ERROR';
        reasons.push(`the application did not start: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      unverified.push('ui.environment.start_command is not set: the application at base_url was started by something other than Orbit, so its build is not bound to this candidate');
    }

    if (terminal === null) {
      for (const check of checks) {
        const run = await runOneCheck({ input, check, checkoutDir, outDir, tmpDir, baseEnv, baseUrl, clock });
        checkRuns.push(run.run);
        journeys.push(...run.journeys);
        reasons.push(...run.reasons);
        unverified.push(...run.unverified);
        if (run.terminal && terminal === null) terminal = run.terminal;
        if (run.terminal === 'CANCELLED') break;
      }
    }
  } finally {
    if (app) await stopApp(app, { clock });
  }

  const written = await baselineFilesWrittenDuringRun(checkoutDir, candidate.commitSha, globs);
  const visualBaselineChanges = [...new Set([...visualFromDiff, ...written])].sort();
  const changedPaths = new Set([...candidateChanges.map((c) => c.path), ...(await touchedSince(checkoutDir, candidate.commitSha))]);
  const a11yBaselineChanges = [...new Set([...changedA11yBaselines(journeys, checkoutDir, changedPaths), ...[...changedPaths].filter(looksLikeA11yBaseline)])].sort();
  if (written.length > 0) reasons.push(`the run itself wrote baseline files: ${written.join(', ')}`);

  // A journey or the app that edits the code under test makes the evidence describe something other than the candidate.
  const drift = await driftSince(checkoutDir, candidate.commitSha);
  const outside = (p: string): boolean => !isInside(resolve(checkoutDir, p), outDir);
  const mutated = drift.modified.filter((p) => !globs(p) && !looksLikeA11yBaseline(p) && outside(p));
  if (mutated.length > 0) {
    reasons.push(`the run modified tracked files, so its evidence no longer describes the candidate: ${mutated.slice(0, 10).join(', ')}`);
    terminal ??= 'ERROR';
  }
  const leftovers = drift.untracked.filter((p) => !globs(p) && !looksLikeA11yBaseline(p) && outside(p));
  if (leftovers.length > 0) unverified.push(`the run left untracked files in the checkout: ${leftovers.slice(0, 10).join(', ')}`);

  const journeyFiles = new Set(journeys.map((j) => j.file));
  const deletedJourneys = candidateChanges.filter((c) => c.status === 'D' && JOURNEY_FILE.test(c.path)).map((c) => c.path);
  if (deletedJourneys.length > 0) unverified.push(`the candidate deleted journey files, so their coverage is gone: ${deletedJourneys.join(', ')}`);
  const editedJourneys = candidateChanges.filter((c) => c.status !== 'D' && journeyFiles.has(c.path)).map((c) => c.path);
  if (editedJourneys.length > 0) unverified.push(`the candidate changed journey definitions that this run executed (check that no assertion was weakened): ${editedJourneys.join(', ')}`);

  const stats = tally(journeys);
  const coverage = coverageOf(journeys, uiConfig);
  if (journeys.length > 0) {
    if (coverage.missingViewports.length) unverified.push(`configured viewports never exercised: ${coverage.missingViewports.map((v) => `${v.width}x${v.height}`).join(', ')}`);
    if (coverage.missingBrowsers.length) unverified.push(`configured browsers never exercised: ${coverage.missingBrowsers.join(', ')}`);
    if (uiConfig.accessibility.enabled && !journeys.some((j) => j.a11y.length > 0)) unverified.push('accessibility is enabled but no journey ran an accessibility scan');
  }
  for (const j of journeys) {
    if (j.annotations.includes('test.fail')) unverified.push(`journey ${j.id} is annotated test.fail(): a "pass" there means the failure still happens`);
  }

  const failing = journeys.filter((j) => j.status === 'FAILED' || j.status === 'TIMED_OUT' || j.status === 'SKIPPED');
  for (const j of failing) reasons.push(j.status === 'SKIPPED' ? `journey ${j.id} was skipped, which proves nothing` : `journey ${j.id} ${j.status === 'TIMED_OUT' ? 'timed out' : 'failed'}${j.failedStep ? ` at step "${j.failedStep}"` : ''}`);
  const needsReview = uiConfig.visual.baseline_changes_require_review && (visualBaselineChanges.length > 0 || a11yBaselineChanges.length > 0);
  if (needsReview) {
    reasons.push(`stored baselines changed in the candidate and need human review: ${[...visualBaselineChanges, ...a11yBaselineChanges].join(', ')}`);
  }
  if (journeys.some((j) => j.status === 'INTERRUPTED')) terminal = 'CANCELLED';

  let verdict: UiRunVerdict;
  if (terminal !== null) verdict = terminal;
  else if (failing.length > 0) verdict = 'FAIL';
  else if (needsReview) verdict = 'BLOCKED';
  else verdict = 'PASS';

  const browsers = uniqueBy(journeys.flatMap((j) => (j.browser ? [j.browser] : [])), (b) => `${b.name}@${b.version}`);
  const viewports = coverage.observedViewports;
  const result: UiRunResult = {
    verdict,
    passed: verdict === 'PASS',
    reasons,
    binding: {
      candidateId: candidate.id,
      treeHash: candidate.treeHash,
      checkConfigHash: configHash,
      policyHash: snapshotHash(snapshot),
      commitSha: candidate.commitSha,
      playwrightVersion: checkRuns.find((c) => c.playwrightVersion)?.playwrightVersion ?? null,
      browsers,
      viewports,
      baseUrl,
    },
    journeys,
    checks: checkRuns,
    stats,
    flaky: journeys.some((j) => j.status === 'FLAKY'),
    visualBaselineChanges,
    a11yBaselineChanges,
    consoleErrorCount: journeys.reduce((n, j) => n + (j.diagnostics?.consoleErrors.length ?? 0) + (j.diagnostics?.pageErrors.length ?? 0), 0),
    coverage,
    unverified,
    limitations: [...UI_LIMITATIONS],
    outDir,
    startedAt,
    endedAt: clock.now(),
  };
  atomicWriteJson(join(outDir, 'ui-result.json'), redactValue(result));
  return result;
}

/** Entry that carries a run-level outcome no single journey shows (no journeys ran, or baselines need review). */
export const UI_RUN_ENTRY = 'orbit:ui-run';

/**
 * The slice of a run the evidence report carries. EvidenceReport.ui has only
 * per-journey rows, so a run that failed for a reason no journey shows (it
 * errored before any ran, or a baseline changed and needs a person) adds one
 * row of its own: an empty or all-green list must never mean "nothing wrong".
 */
export function toEvidenceUi(result: UiRunResult): UiEvidenceEntry[] {
  const runStatus = result.verdict === 'TIMEOUT' ? 'TIMEOUT' : result.verdict === 'CANCELLED' ? 'CANCELLED' : result.verdict === 'ERROR' ? 'ERROR' : null;
  const entries: UiEvidenceEntry[] = result.journeys.map((j) => ({
    journey: j.id,
    checkId: j.checkId,
    status: runStatus ?? (j.status === 'PASSED' || j.status === 'FLAKY' ? 'PASSED' : j.status === 'TIMED_OUT' ? 'TIMEOUT' : j.status === 'INTERRUPTED' ? 'CANCELLED' : 'FAILED'),
    artifacts: j.artifacts.map((a) => a.path),
  }));
  if (result.verdict !== 'PASS' && entries.every((e) => e.status === 'PASSED')) {
    entries.push({ journey: UI_RUN_ENTRY, ...(result.checks[0] ? { checkId: result.checks[0].checkId } : {}), status: runStatus ?? 'FAILED', artifacts: [...result.visualBaselineChanges, ...result.a11yBaselineChanges] });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Check command

function resolveChecks(snapshot: PolicySnapshot, ids: string[]): CheckDefinition[] {
  if (ids.length === 0) throw new OrbitError('CONFIG_INVALID', 'ui is configured but no journey checks are named (ui.journey_check_ids is empty)', { rule: 'ui.journey_check_ids' });
  return ids.map((id) => {
    const check = snapshot.config.checks[id];
    if (!check) throw new OrbitError('CONFIG_INVALID', `ui journey check ${JSON.stringify(id)} is not defined in checks`, { id });
    if (check.kind !== 'playwright') throw new OrbitError('CONFIG_INVALID', `ui journey check ${JSON.stringify(id)} must have kind: playwright`, { id, kind: check.kind });
    return check;
  });
}

/** Rejects configured arguments that would defeat the enforced ones (see FORBIDDEN_ARG). */
export function assertCheckCommandAllowed(check: CheckDefinition): void {
  const tokens = check.shell ? (check.command[0] ?? '').split(/[\s;&|()'"`]+/) : check.command;
  const bad = tokens.find((t) => FORBIDDEN_ARG.test(t) && !SAME_AS_ENFORCED.has(t));
  if (bad !== undefined) {
    throw new OrbitError('POLICY_DENIED', `journey check ${JSON.stringify(check.id)} carries ${JSON.stringify(bad)}, which Orbit sets itself or forbids (baseline updates, reporters, output, traces and retries are not configurable)`, {
      rule: 'ui.enforced_flags',
      check: check.id,
      arg: bad,
    });
  }
}

export function enforcedFlags(check: CheckDefinition, outputDir: string, projects?: string[]): string[] {
  return ['--reporter=json', '--update-snapshots=none', '--trace=retain-on-failure', `--output=${outputDir}`, `--retries=${check.flaky_reruns}`, ...(projects ?? []).map((p) => `--project=${p}`)];
}

/**
 * The argv to run. A `shell: true` check is one script; flags reach it as
 * positional parameters and the script is made to receive them with "$@".
 */
export function buildArgv(check: CheckDefinition, flags: string[]): string[] {
  if (check.shell) return ['/bin/sh', '-c', `${check.command[0] ?? ''} "$@"`, 'orbit-ui', ...flags];
  return [...check.command, ...flags];
}

export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// One check

interface CheckContext {
  input: UiRunInput;
  check: CheckDefinition;
  checkoutDir: string;
  outDir: string;
  tmpDir: string;
  baseEnv: Record<string, string>;
  baseUrl: string;
  clock: Clock;
}

interface CheckOutcome {
  run: UiCheckRun;
  journeys: UiJourneyResult[];
  reasons: string[];
  unverified: string[];
  terminal: UiRunVerdict | null;
}

async function runOneCheck(ctx: CheckContext): Promise<CheckOutcome> {
  const { input, check, checkoutDir, clock } = ctx;
  const checkDir = ensureDir(join(ctx.outDir, check.id));
  const outputDir = join(checkDir, 'test-results');
  const reportPath = join(checkDir, 'playwright-report.json');
  const logPath = join(checkDir, 'run.log');
  const cwd = resolve(checkoutDir, check.cwd);
  if (relative(checkoutDir, cwd).startsWith('..') || isAbsolute(relative(checkoutDir, cwd))) {
    throw new OrbitError('POLICY_DENIED', `check ${check.id} cwd leaves the checkout`, { rule: 'checks.cwd', check: check.id });
  }
  const flags = enforcedFlags(check, outputDir, input.projects);
  const argv = buildArgv(check, flags);
  const env: Record<string, string> = {
    ...ctx.baseEnv,
    ...check.env,
    TMPDIR: ctx.tmpDir,
    FORCE_COLOR: '0',
    ORBIT_UI_RUN: '1',
    ORBIT_UI_BASE_URL: ctx.baseUrl,
    ORBIT_UI_VIEWPORTS: JSON.stringify(input.uiConfig.viewports),
    ORBIT_UI_BROWSERS: JSON.stringify(input.uiConfig.browsers),
    PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
  };
  const profile: SandboxProfile = {
    ...profileForCheck({ worktree: checkoutDir, check, snapshot: input.snapshot, extraWritable: [checkDir, ctx.tmpDir], homeDir: input.homeDir, env: input.hostEnv }),
    allowLocalBinding: true,
  };
  // A report or results from an earlier run in this directory must never be read as this run's.
  rmSync(reportPath, { force: true });
  rmSync(outputDir, { recursive: true, force: true });
  const wrapped = input.isolation.wrap(argv, profile, { cwd, env });
  const started = clock.now();
  let exec;
  try {
    exec = await execCapture(wrapped.argv, { cwd, env: wrapped.env, timeoutMs: check.timeout_seconds * 1000, abortSignal: input.abortSignal, maxOutputBytes: MAX_LOG_BYTES });
  } finally {
    wrapped.cleanup();
  }
  writeFileSync(logPath, redact(`${exec.stdout}${exec.stderr ? `\n--- stderr ---\n${exec.stderr}` : ''}`), { mode: 0o600 });

  let parsed: ParsedReport | null = null;
  let parseProblem: string | null = null;
  const reportFound = existsSync(reportPath);
  if (reportFound) {
    try {
      parsed = parsePlaywrightReport(JSON.parse(readFileSync(reportPath, 'utf8')));
    } catch (err) {
      parseProblem = `the Playwright report could not be parsed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const run: UiCheckRun = {
    checkId: check.id,
    argv,
    exitCode: exec.exitCode,
    timedOut: exec.timedOut,
    cancelled: exec.cancelled,
    durationMs: clock.now() - started,
    logPath,
    reportPath,
    reportFound,
    isolation: input.isolation.kind,
    isolationLimitations: wrapped.limitations,
    playwrightVersion: parsed?.playwrightVersion ?? null,
  };
  const reasons: string[] = [];
  const unverified: string[] = [];
  const quiet = (terminal: UiRunVerdict | null): CheckOutcome => ({ run, journeys: [], reasons, unverified, terminal });

  if (exec.cancelled) {
    reasons.push(`check ${check.id} was cancelled`);
    return quiet('CANCELLED');
  }
  if (exec.timedOut) {
    reasons.push(`check ${check.id} exceeded its ${check.timeout_seconds} s limit`);
    return quiet('TIMEOUT');
  }
  if (parsed === null) {
    reasons.push(parseProblem ?? `check ${check.id} produced no Playwright report (exit ${exec.exitCode ?? 'signal'}): ${tail(exec.stderr || exec.stdout)}`);
    return quiet('ERROR');
  }
  if (parsed.errors.length > 0) {
    reasons.push(`Playwright reported global errors in ${check.id}: ${parsed.errors.join('; ')}`);
    return quiet('ERROR');
  }
  // Verified (playwright-and-github.md A5): --update-snapshots=none shows up as "none". Anything else means the flag did not apply.
  if (parsed.updateSnapshots !== 'none') {
    reasons.push(`Playwright ran with updateSnapshots=${String(parsed.updateSnapshots)} instead of none; the run cannot be trusted`);
    return quiet('ERROR');
  }
  if (parsed.tests.length === 0) {
    reasons.push(`check ${check.id} ran no journeys; an empty run is not a pass`);
    return quiet('ERROR');
  }
  if (parsed.selection.length > 0) unverified.push(`check ${check.id}: the run was narrowed (${parsed.selection.join('; ')}), so some journeys may not have run`);

  const journeys = parsed.tests.map((t) => buildJourney(t, ctx, checkDir, cwd));
  // The exit code and the report must agree. The report sits in a directory the journeys can write, and a crash can
  // leave a partial one, so a disagreement means neither can be believed.
  const counted = parsed.stats.expected + parsed.stats.unexpected + parsed.stats.flaky + parsed.stats.skipped;
  if (counted !== parsed.tests.length) {
    reasons.push(`check ${check.id}: the report's totals (${counted}) do not match the ${parsed.tests.length} journeys it lists`);
    return quiet('ERROR');
  }
  const anyFailed = journeys.some((j) => j.status === 'FAILED' || j.status === 'TIMED_OUT' || j.status === 'INTERRUPTED');
  if ((exec.exitCode !== 0 && !anyFailed) || (exec.exitCode === 0 && anyFailed)) {
    reasons.push(`check ${check.id} exited with ${exec.exitCode ?? 'a signal'} but its report ${anyFailed ? 'lists failures' : 'lists none'}; the report cannot be trusted`);
    return quiet('ERROR');
  }
  return { run, journeys, reasons, unverified, terminal: null };
}

function tail(text: string, max = 600): string {
  const t = redact(text).trim();
  return t.length > max ? `...${t.slice(-max)}` : t || '(no output)';
}

// ---------------------------------------------------------------------------
// Journeys

const FAILED_RESULT = new Set(['failed', 'timedOut', 'interrupted']);

function buildJourney(test: RawTest, ctx: CheckContext, checkDir: string, cwd: string): UiJourneyResult {
  const { checkoutDir } = ctx;
  const file = relativeTo(test.file, checkoutDir);
  const title = test.titlePath[test.titlePath.length - 1] ?? '';
  const id = `${test.projectName}/${file}#${test.titlePath.join(' > ')}`;
  const failing = test.results.filter((r) => FAILED_RESULT.has(r.status));
  const focus: RawResult | undefined = failing[failing.length - 1] ?? test.results[test.results.length - 1];
  const status = journeyStatus(test);

  const slug = `${sha256(id).slice(0, 8)}-${title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
  const artifactDir = join(checkDir, 'artifacts', slug);
  const collected = focus ? collectAttachments(focus.attachments, { checkoutDir, outputDir: join(checkDir, 'test-results'), artifactDir }) : { artifacts: [], diagnostics: null, browser: null, a11y: [], errorContext: null };

  const firstError = (failing[0] ?? focus)?.error ?? null;
  const rootDir = checkoutDir;
  const error = firstError && status !== 'PASSED' ? describeError(firstError, rootDir) : null;
  const projectFlag = `--project=${test.projectName}`;
  const grep = ['-g', escapeRegExp(title)];
  const reproFlags = ['--update-snapshots=none', '--trace=retain-on-failure', '--reporter=list', projectFlag, ...grep];
  const reproArgv = buildArgv(ctx.check, reproFlags);
  const reproduction: UiReproduction = {
    cwd,
    argv: reproArgv,
    env: { ORBIT_UI_RUN: '1', ORBIT_UI_BASE_URL: ctx.baseUrl },
    command: `cd ${shellQuote(cwd)} && ORBIT_UI_RUN=1 ORBIT_UI_BASE_URL=${shellQuote(ctx.baseUrl)} ${reproArgv.map(shellQuote).join(' ')}`,
  };

  const declared = collected.browser ?? null;
  const browser = declared ? { name: declared.name, version: declared.version } : fallbackBrowser(checkoutDir, ctx.input.uiConfig.browsers);
  return {
    id,
    title,
    titlePath: test.titlePath,
    file,
    line: test.line,
    project: test.projectName,
    checkId: ctx.check.id,
    status,
    attempts: test.results.length,
    durationMs: Math.round(test.results.reduce((n, r) => n + r.durationMs, 0)),
    browser,
    viewport: declared?.viewport ?? null,
    steps: focus ? summarizeSteps(focus.steps) : [],
    failedStep: focus ? failedStepPath((failing[0] ?? focus).steps) : null,
    error,
    artifacts: collected.artifacts,
    diagnostics: collected.diagnostics,
    a11y: collected.a11y,
    errorContext: collected.errorContext,
    reproduction,
    annotations: [...test.annotations, ...(test.expectedStatus === 'failed' ? ['test.fail'] : [])],
  };
}

function journeyStatus(test: RawTest): UiJourneyStatus {
  if (test.results.some((r) => r.status === 'interrupted')) return 'INTERRUPTED';
  switch (test.outcome) {
    case 'expected':
      return 'PASSED';
    case 'flaky':
      return 'FLAKY';
    case 'skipped':
      return 'SKIPPED';
    default:
      return test.results.some((r) => r.status === 'timedOut') ? 'TIMED_OUT' : 'FAILED';
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fallbackBrowser(checkoutDir: string, configured: string[]): { name: string; version: string } | null {
  // Used when a journey did not use the orbit fixtures: the version the installed Playwright declares, not one observed.
  const name = configured[0] ?? 'chromium';
  try {
    const req = createRequire(join(checkoutDir, 'package.json'));
    const dir = dirname(req.resolve('playwright-core/package.json'));
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'browsers.json'), 'utf8'));
    const list = (parsed as { browsers?: { name?: string; browserVersion?: string }[] }).browsers ?? [];
    const version = list.find((b) => b.name === name)?.browserVersion;
    return version ? { name, version: `${version} (declared by playwright-core, not observed)` } : null;
  } catch {
    return null;
  }
}

export interface Collected {
  artifacts: UiArtifact[];
  diagnostics: UiDiagnostics | null;
  browser: { name: string; version: string; viewport: Viewport | null } | null;
  a11y: UiA11yScan[];
  errorContext: { errorDetails: string | null; pageSnapshot: string | null } | null;
}

function kindOf(a: RawAttachment): UiArtifactKind {
  const n = a.name;
  if (n === 'screenshot' || n === 'orbit-failure-screenshot') return 'screenshot';
  if (n === 'trace') return 'trace';
  if (n === 'video' || a.contentType.startsWith('video/')) return 'video';
  if (n === 'error-context') return 'error-context';
  if (n === 'orbit-diagnostics') return 'diagnostics';
  if (n === 'orbit-a11y') return 'accessibility';
  if (/-expected\.png$/.test(n)) return 'visual-expected';
  if (/-actual\.png$/.test(n)) return 'visual-actual';
  if (/-diff\.png$/.test(n)) return 'visual-diff';
  return 'other';
}

const EXTENSIONS: Record<string, string> = { 'application/json': '.json', 'text/plain': '.txt', 'text/markdown': '.md', 'image/png': '.png', 'application/zip': '.zip', 'video/webm': '.webm' };
const TEXTUAL = /^(?:text\/|application\/json)/;

export function collectAttachments(attachments: RawAttachment[], dirs: { checkoutDir: string; outputDir: string; artifactDir: string }): Collected {
  const out: Collected = { artifacts: [], diagnostics: null, browser: null, a11y: [], errorContext: null };
  const outputReal = safeReal(dirs.outputDir);
  const checkoutReal = safeReal(dirs.checkoutDir);
  const seen = new Set<string>();
  for (const att of attachments) {
    const kind = kindOf(att);
    let bytes: Buffer | null = att.body;
    let stored: string | null = null;
    if (att.path !== null) {
      // The attachment path comes from repository test code. Anything outside the run's output directory or the
      // checkout is refused: it could be a credential file a malicious test attached to read it out of the sandbox.
      const real = safeReal(att.path);
      if (real === null || !(isInside(real, outputReal) || isInside(real, checkoutReal))) continue;
      let size: number;
      try {
        const st = statSync(real);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      if (size > MAX_ARTIFACT_BYTES) continue;
      bytes = readFileSync(real);
      stored = real;
      if (!isInside(real, outputReal)) {
        mkdirSync(dirs.artifactDir, { recursive: true });
        const copy = join(dirs.artifactDir, `${kind}-${basename(real)}`);
        copyFileSync(real, copy);
        stored = copy;
      }
    } else if (bytes !== null) {
      mkdirSync(dirs.artifactDir, { recursive: true });
      const ext = EXTENSIONS[att.contentType.split(';')[0]?.trim() ?? ''] ?? '.bin';
      stored = join(dirs.artifactDir, `${att.name.replace(/[^A-Za-z0-9._-]+/g, '_')}${ext}`);
      writeFileSync(stored, TEXTUAL.test(att.contentType) ? redact(bytes.toString('utf8')) : bytes, { mode: 0o600 });
      bytes = readFileSync(stored);
    }
    if (bytes === null || stored === null) continue;

    if (kind === 'diagnostics') {
      out.diagnostics ??= parseDiagnostics(bytes);
      out.browser ??= parseBrowserInfo(bytes);
    } else if (kind === 'accessibility') {
      const scan = parseA11y(bytes);
      if (scan) out.a11y.push(scan);
    } else if (kind === 'error-context') {
      out.errorContext ??= parseErrorContext(bytes.toString('utf8'));
    }
    if (seen.has(stored)) continue;
    seen.add(stored);
    out.artifacts.push({ name: att.name, kind, contentType: att.contentType, path: stored, sha256: sha256(bytes), bytes: bytes.length });
  }
  return out;
}

function safeReal(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isInside(child: string, parent: string | null): boolean {
  if (parent === null) return false;
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

// ---------------------------------------------------------------------------
// Tallies and coverage

function tally(journeys: UiJourneyResult[]): UiRunResult['stats'] {
  const s = { passed: 0, failed: 0, flaky: 0, skipped: 0, other: 0 };
  for (const j of journeys) {
    if (j.status === 'PASSED') s.passed += 1;
    else if (j.status === 'FLAKY') s.flaky += 1;
    else if (j.status === 'SKIPPED') s.skipped += 1;
    else if (j.status === 'FAILED' || j.status === 'TIMED_OUT') s.failed += 1;
    else s.other += 1;
  }
  return s;
}

function coverageOf(journeys: UiJourneyResult[], ui: UiConfig): UiRunResult['coverage'] {
  const observedViewports = uniqueBy(journeys.flatMap((j) => (j.viewport ? [j.viewport] : [])), (v) => `${v.width}x${v.height}`);
  const observedBrowsers = [...new Set(journeys.flatMap((j) => (j.browser ? [j.browser.name] : [])))];
  const hasViewport = (v: Viewport): boolean => observedViewports.some((o) => o.width === v.width && o.height === v.height);
  return {
    configuredViewports: ui.viewports,
    observedViewports,
    missingViewports: ui.viewports.filter((v) => !hasViewport(v)),
    configuredBrowsers: ui.browsers,
    observedBrowsers,
    missingBrowsers: ui.browsers.filter((b) => !observedBrowsers.includes(b)),
  };
}

function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const i of items) if (!seen.has(key(i))) seen.set(key(i), i);
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Git: binding the run to the candidate and finding baseline changes

async function git(cwd: string, args: string[]): Promise<string> {
  const env: Record<string, string> = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const k of GIT_ENV_KEYS) if (process.env[k]) env[k] = process.env[k] as string;
  const r = await execCapture(['git', ...args], { cwd, env, timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new OrbitError('GIT_FAILED', `git ${args[0]} failed: ${tail(r.stderr)}`, { args: args.slice(0, 3), exitCode: r.exitCode });
  return r.stdout;
}

async function assertCheckoutMatchesCandidate(checkoutDir: string, candidate: Candidate, outDir: string): Promise<void> {
  const tree = (await git(checkoutDir, ['rev-parse', `${candidate.commitSha}^{tree}`])).trim();
  if (tree !== candidate.treeHash) {
    throw new OrbitError('STALE_EVIDENCE', `candidate ${candidate.id} names tree ${candidate.treeHash} but its commit has tree ${tree}`, { candidate: candidate.id });
  }
  const drift = (await git(checkoutDir, ['diff', '--name-only', '-z', '--ignore-submodules=none', candidate.commitSha, '--'])).split('\0').filter(Boolean);
  if (drift.length > 0) {
    throw new OrbitError('STALE_EVIDENCE', `the checkout differs from candidate ${candidate.id}; UI evidence would not describe the candidate (${drift.slice(0, 5).join(', ')})`, { candidate: candidate.id, paths: drift.slice(0, 20) });
  }
  // `git diff` cannot see untracked files, and Playwright would pick up an extra spec or fixture lying in the tree.
  const stray = (await untrackedFiles(checkoutDir)).filter((p) => !isInside(resolve(checkoutDir, p), outDir));
  if (stray.length > 0) {
    throw new OrbitError('STALE_EVIDENCE', `the checkout holds untracked files that are not part of candidate ${candidate.id}; UI evidence would not describe the candidate (${stray.slice(0, 5).join(', ')})`, { candidate: candidate.id, paths: stray.slice(0, 20) });
  }
}

async function untrackedFiles(cwd: string): Promise<string[]> {
  return (await git(cwd, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
}

export async function changedBetween(cwd: string, base: string, head: string): Promise<BaselineChange[]> {
  const raw = await git(cwd, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', base, head, '--']);
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  const out: BaselineChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) out.push({ status: tokens[i] as string, path: tokens[i + 1] as string });
  return out;
}

/** Tracked files modified, and files added, since the candidate commit. */
async function driftSince(cwd: string, commit: string): Promise<{ modified: string[]; untracked: string[] }> {
  const modified = (await git(cwd, ['diff', '--name-only', '-z', '--ignore-submodules=none', commit, '--'])).split('\0').filter(Boolean);
  return { modified, untracked: await untrackedFiles(cwd) };
}

async function touchedSince(cwd: string, commit: string): Promise<string[]> {
  const d = await driftSince(cwd, commit);
  return [...d.modified, ...d.untracked];
}

async function baselineFilesWrittenDuringRun(cwd: string, commit: string, isBaseline: (p: string) => boolean): Promise<string[]> {
  return (await touchedSince(cwd, commit)).filter(isBaseline);
}

const JOURNEY_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

/**
 * Accessibility baselines are named by the journey that loads them, and that is repository code that could simply not
 * say. The file name is a second, independent signal.
 */
function looksLikeA11yBaseline(path: string): boolean {
  return /(?:a11y|axe|accessibility)[^/]*baseline[^/]*$|baseline[^/]*(?:a11y|axe|accessibility)[^/]*$/i.test(path);
}

function changedA11yBaselines(journeys: UiJourneyResult[], checkoutDir: string, changed: Set<string>): string[] {
  const out = new Set<string>();
  const root = safeReal(checkoutDir);
  for (const j of journeys) {
    for (const scan of j.a11y) {
      if (!scan.baselinePath) continue;
      const real = safeReal(scan.baselinePath) ?? resolve(scan.baselinePath);
      if (!isInside(real, root) || root === null) continue;
      const rel = relative(root, real).split(sep).join('/');
      if (changed.has(rel)) out.add(rel);
    }
  }
  return [...out].sort();
}
