/**
 * Fail-before evidence (docs/decisions/0014-fail-before.md, issue #65). A new test that passes on the base revision as
 * well shows nothing about the change. The probe runs each affected trusted check on a tree that differs from the
 * passing base only by the candidate's test-owned paths (policy/test-files.ts isTestOwnedPath), and judges it by exit
 * status alone, in any language: failed-before, passed-before or not established. It is a weak signal (a test that only
 * fails to load counts as failing), and it is worded as one.
 *
 * The probe's attempts are recorded in fail_before_probes, never in check_runs or failures: an expected failure on the
 * probe tree is not the run's, and diagnosis, the repeated-failure counts, the baseline readers, reconcile and the
 * learning layer read those tables. A completed probe is one `verification.fail-before` decision; a later candidate
 * reuses its decisive results when the probe tree, the check configuration and the policy all match (a repair that
 * changed production code only). A probe interrupted by a crash is closed as interrupted and runs again, once its
 * attempts are confirmed stopped: one that may still run keeps its record open and its checkout.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { OrbitError, isOrbitError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { TERMINAL_STATES, type RunState } from '../core/run-states.ts';
import type { GoalContract } from '../contract/types.ts';
import { checkCategory } from '../policy/config.ts';
import { isTestPath } from '../policy/test-files.ts';
import type { CheckDefinition, FailBeforeMode, PolicySnapshot } from '../policy/types.ts';
import type { OrbitDb } from '../storage/db.ts';
import { listDecisions } from '../storage/decisions.ts';
import { cleanupCandidateCheckout, materializeCandidate, ORBIT_GIT_IDENTITY } from './candidate.ts';
import { classifyProgramNotFound } from './check-misconfigured.ts';
import { readJsonFile, shimPath, type ShimIntent } from './check-shim.ts';
import { settleCheckAttempt } from '../recovery/check-attempt.ts';
import { classifyCouldNotRun, classifyNotExecuted, type EnvironmentSignal } from './environment-failure.ts';
import { git } from './git.ts';
import { planInstall } from './baseline.ts';
import { candidateEvidenceDir, configHashFor, runAttempt, type AttemptRecords, type CheckSubject, type RunnerContext } from './runner.ts';
import type { CheckRunRecord, FinishedCheck, NewCheckRun } from './store.ts';
import type { BaseComparison } from './report.ts';
import type { Candidate, CheckResult, CheckStatus, CriterionFailBefore } from './types.ts';

export type FailBeforeOutcome = 'failed-before' | 'passed-before' | 'not-established';

/**
 * Why an outcome is not established. An environment cause, an ERROR or a failed install is the environment's, never
 * offered to a person for acceptance (ADR 0010): it is fixed, and `orbit resume` runs the probe again.
 */
export type NotEstablishedCause =
  | 'environment'
  | 'error'
  | 'install'
  | 'timeout'
  | 'cancelled'
  | 'mixed'
  | 'once'
  | 'interrupted'
  | 'refused-tree'
  | 'manifest'
  | 'budget'
  | 'content-only'
  | 'not-acceptable'
  | 'unscanned'
  | 'not-probed';

const NEVER_ACCEPTED: ReadonlySet<NotEstablishedCause> = new Set<NotEstablishedCause>(['environment', 'error', 'install']);

/** Whether a person may accept a criterion without fail-before when the probe is not established for this cause. */
export function acceptableCause(cause: NotEstablishedCause): boolean {
  return !NEVER_ACCEPTED.has(cause);
}

export const FAIL_BEFORE_DECISION_KIND = 'verification.fail-before';

export interface ProbeAttempt {
  attempt: number;
  status: CheckStatus;
  exitCode: number | null;
  /** ADR 0010 environment signals the attempt's log shows, BASE_GATED_SIGNALS ungated (probeSignals). */
  signals: EnvironmentSignal[];
  /** Why the attempt's log cannot support failed-before (not one whole classifier pass, or output dropped; scanProbeLog). */
  unscanned?: string;
  /** The attempt's log, relative to the run directory when it lies inside it. */
  log: string | null;
}

/** One probed check's outcome over every attempt. */
export interface CheckProbe {
  checkId: string;
  outcome: FailBeforeOutcome;
  /** Present exactly when the outcome is not established. */
  cause?: NotEstablishedCause;
  reason: string;
  attempts: ProbeAttempt[];
}

/**
 * The outcome of one probed check over every attempt (ADR 0014 section 3): failed-before when every attempt FAILED, at
 * least two, with no environment signal; passed-before when every attempt PASSED; anything else is not established.
 */
export function judgeProbeAttempts(checkId: string, attempts: readonly ProbeAttempt[]): CheckProbe {
  const done = (outcome: FailBeforeOutcome, reason: string, cause?: NotEstablishedCause): CheckProbe => ({ checkId, outcome, ...(cause ? { cause } : {}), reason, attempts: [...attempts] });
  if (attempts.length === 0) return done('not-established', `${checkId} did not run on the probe tree`, 'interrupted');
  // The causes no person may accept come first, whatever else the attempts show: an ERROR, then an environment signal.
  const statuses = attempts.map((a) => a.status);
  if (statuses.includes('ERROR')) return done('not-established', `${checkId} could not be run on the probe tree (ERROR)`, 'error');
  const signals = [...new Set(attempts.flatMap((a) => a.signals))];
  if (signals.length > 0) return done('not-established', `${checkId} could not run on the probe tree: its output shows an environment cause (${signals.join(', ')}), not a test result`, 'environment');
  if (statuses.every((s) => s === 'PASSED')) return done('passed-before', `${checkId} passed on the base revision with the new tests`);
  if (statuses.every((s) => s === 'FAILED')) {
    if (attempts.length < 2) return done('not-established', `${checkId} failed once on the base revision with the new tests, and a failure counts only when it repeats`, 'once');
    // A failure counts only from a log read whole in one pass with nothing dropped: a cause outside it cannot be ruled out.
    const unscanned = attempts.find((a) => a.unscanned !== undefined);
    if (unscanned) return done('not-established', `${checkId} could not be judged on the probe tree: ${unscanned.unscanned}`, 'unscanned');
    const exits = [...new Set(attempts.map((a) => (a.exitCode === null ? 'none' : String(a.exitCode))))];
    return done('failed-before', `${checkId} failed on the base revision with the new tests (exit ${exits.join(', ')}, ${attempts.length} attempts)`);
  }
  if (statuses.includes('TIMEOUT')) return done('not-established', `${checkId} timed out on the probe tree`, 'timeout');
  if (statuses.includes('CANCELLED')) return done('not-established', `${checkId} was cancelled on the probe tree`, 'cancelled');
  return done('not-established', `${checkId} gave mixed results on the probe tree (${statuses.join(', then ')})`, 'mixed');
}

export interface SignalInput {
  /** The attempt's log, as written (already redacted). */
  output: string;
  exitCode: number | null;
  command: readonly string[];
  shell: boolean;
  /** Directories the check may write: its checkout and its own scratch. A denial inside them is the code's. */
  insideRoots: readonly string[];
  /** The runner's note that it could not start the check, when it recorded one. */
  startFailure?: string | null;
}

/**
 * The ADR 0010 environment signals one pass of the classifiers finds in `output`, read as on the base revision: the
 * signals of BASE_GATED_SIGNALS count without a base comparison, since the probe tree is the base's but for its tests.
 * A pass reads at most CLASSIFIER_LINES lines; scanProbeLog reads a longer log.
 */
export function probeSignals(input: SignalInput): EnvironmentSignal[] {
  const found =
    classifyNotExecuted({ checkId: 'probe', output: input.output, startFailure: input.startFailure ?? null }) ??
    classifyProgramNotFound({ checkId: 'probe', command: input.command, shell: input.shell, exitCode: input.exitCode, output: input.output }) ??
    classifyCouldNotRun({ checkId: 'probe', output: input.output, insideRoots: input.insideRoots });
  return found?.signals ?? [];
}

/** The lines one pass of the environment classifiers reads of a text (environment-failure.ts, check-misconfigured.ts). */
export const CLASSIFIER_LINES = 200_000;
/** A longer log is read in windows of one pass each, overlapping by half, so lines that belong together share one. */
const WINDOW_STRIDE = CLASSIFIER_LINES / 2;
/** The note the check shim or the runner writes when it kept only part of a check's output. */
const OUTPUT_DROPPED = /^\[orbit: output truncated: \d+ bytes dropped/m;

export interface LogScan {
  /** Every environment signal found anywhere in the retained output. */
  signals: EnvironmentSignal[];
  /** Why the log cannot show a failure on the base revision: not one whole pass, or output dropped. Absent when it can. */
  unscanned?: string;
}

/**
 * How an attempt's log is judged (ADR 0014 section 3). Every retained line is read for an environment signal, however
 * long or cut short the log: one pass when the log fits in it, otherwise overlapping windows of one pass each, whose
 * signals are all kept. Only a log read in one whole pass, with nothing dropped, can support failed-before: anything else
 * is `unscanned`, since a cause outside what was read together cannot be ruled out. A missing log is unscanned too.
 */
export function scanProbeLog(text: string | null, input: Omit<SignalInput, 'output'>): LogScan {
  if (text === null) return { signals: [], unscanned: 'its log was not written, so an environment cause cannot be ruled out' };
  const lines = text.split('\n');
  const found = new Set<EnvironmentSignal>();
  if (lines.length <= CLASSIFIER_LINES) {
    for (const s of probeSignals({ ...input, output: text })) found.add(s);
  } else {
    for (let start = 0; ; start += WINDOW_STRIDE) {
      for (const s of probeSignals({ ...input, output: lines.slice(start, start + CLASSIFIER_LINES).join('\n') })) found.add(s);
      if (start + CLASSIFIER_LINES >= lines.length) break;
    }
  }
  const unscanned =
    lines.length > CLASSIFIER_LINES
      ? `its log has ${lines.length} lines, more than one pass of the environment classifier reads (${CLASSIFIER_LINES}), so an environment cause across its parts cannot be ruled out`
      : OUTPUT_DROPPED.test(text)
        ? 'its output was cut short (the runner kept only part of it), so an environment cause in the dropped part cannot be ruled out'
        : null;
  return { signals: [...found], ...(unscanned === null ? {} : { unscanned }) };
}

/** An attempt's log as written, or null when there is none. */
function readProbeLog(path: string | null): string | null {
  return path !== null && existsSync(path) ? readFileSync(path, 'utf8') : null;
}

// ---------------------------------------------------------------------------
// Which criteria rest on new tests

/** A check's directory as a repository path prefix: '' for the root. */
function checkDir(def: Pick<CheckDefinition, 'cwd'> | undefined): string {
  const cwd = (def?.cwd ?? '.').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return cwd === '.' ? '' : cwd;
}

/** Whether `path` lies under a check's directory: what its run can include. */
export function underCheck(path: string, def: Pick<CheckDefinition, 'cwd'> | undefined): boolean {
  const dir = checkDir(def);
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

/**
 * The candidate's test changes (ADR 0011: isTestPath, with the diff that shows a Rust #[test] the change adds) that lie
 * under the check's directory: the new tests whose run the check includes (ADR 0014 section 4).
 */
export function testChangesUnder(base: Pick<BaseComparison, 'changedPaths' | 'testLayout' | 'diffs'>, def: Pick<CheckDefinition, 'cwd'> | undefined): string[] {
  return base.changedPaths.filter((p) => underCheck(p, def) && isTestPath(p, base.testLayout, base.diffs?.get(p)));
}

export interface CriterionTestSupport {
  criterionId: string;
  /** A cited check failed or timed out on the base revision: its pass is evidence of the change without new tests. */
  flips: string[];
  /** Cited checks whose run includes a test change. */
  withTests: string[];
  /** Of those, the checks the probe runs: command checks of category test that passed on the base revision. */
  probeable: string[];
  /** The new tests under the cited checks. */
  testPaths: string[];
}

/** For each criterion, what its support through new tests rests on (ADR 0014 section 4). */
export function newTestSupport(contract: Pick<GoalContract, 'acceptance_criteria'>, snapshot: Pick<PolicySnapshot, 'config'>, base: BaseComparison): CriterionTestSupport[] {
  const baseStatus = new Map((base.checks ?? []).map((c) => [c.checkId, c.status] as const));
  const testsOf = new Map<string, string[]>();
  const tests = (id: string): string[] => {
    let t = testsOf.get(id);
    if (t === undefined) {
      t = testChangesUnder(base, snapshot.config.checks[id]);
      testsOf.set(id, t);
    }
    return t;
  };
  return contract.acceptance_criteria.map((c) => {
    const ids = c.check_ids ?? [];
    const withTests = ids.filter((id) => tests(id).length > 0);
    const probeable = withTests.filter((id) => {
      const def = snapshot.config.checks[id];
      return def !== undefined && def.kind === 'command' && checkCategory(def) === 'test' && baseStatus.get(id) === 'PASSED';
    });
    return {
      criterionId: c.id,
      flips: ids.filter((id) => baseStatus.get(id) === 'FAILED' || baseStatus.get(id) === 'TIMEOUT'),
      withTests,
      probeable,
      testPaths: [...new Set(withTests.flatMap(tests))].sort(),
    };
  });
}

// ---------------------------------------------------------------------------
// The probe tree

/** One path the candidate changes against the base revision, as `git diff --raw` reports it (renames as both). */
export interface ProbeChange {
  path: string;
  status: 'A' | 'M' | 'T' | 'D';
  srcMode: string;
  dstMode: string;
  srcSha: string;
  dstSha: string;
}

/** Every path `commit` changes against `base`, deletions included, a rename as a deletion and an addition. */
export async function changesBetween(repoRoot: string, base: string, commit: string): Promise<ProbeChange[]> {
  const out = await git(repoRoot, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', base, commit, '--']);
  if (out.length > 0 && !out.endsWith('\0')) throw new OrbitError('GIT_FAILED', `the change list of ${commit} against ${base} was cut short, so its test-owned paths cannot be told apart`, { base, commit });
  const parts = out.split('\0');
  const changes: ProbeChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMTD])$/.exec(parts[i]!);
    if (!m) throw new OrbitError('GIT_FAILED', `unexpected change record ${JSON.stringify(parts[i]!.slice(0, 120))} between ${base} and ${commit}`, { base, commit });
    changes.push({ path: parts[i + 1]!, status: m[5] as ProbeChange['status'], srcMode: m[1]!, dstMode: m[2]!, srcSha: m[3]!, dstSha: m[4]! });
  }
  return changes;
}

const GITLINK = '160000';

/** The directories above `path`, nearest first, the root excluded. */
function parentsOf(path: string): string[] {
  const out: string[] = [];
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) out.push(path.slice(0, i));
  return out;
}

/** The object type of each `rev:path`, or null when it is not there; one cat-file for all of them. */
async function objectTypes(repoRoot: string, rev: string, paths: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (paths.length === 0) return out;
  const text = await git(repoRoot, ['cat-file', '--batch-check=%(objecttype)'], { input: paths.map((p) => `${rev}:${p}\n`).join('') });
  const lines = text.split('\n');
  paths.forEach((p, i) => {
    const line = (lines[i] ?? '').trim();
    out.set(p, line.endsWith(' missing') || line === '' ? null : line);
  });
  return out;
}

/**
 * The probe tree (ADR 0014 section 2): the base tree with every given test-owned change applied, written in a private
 * index (read-tree, update-index --index-info, write-tree). git applies an entry by replacing whatever is in its way, so
 * a change that would drop a base entry the probe keeps (a file where the base has a directory, a test file below a
 * base file) and a gitlink refuse the whole probe instead: it is never partial. The order of `changes` does not matter.
 */
export async function buildProbeTree(repoRoot: string, base: string, changes: readonly ProbeChange[]): Promise<{ tree: string } | { refused: string }> {
  const sorted = [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const c of sorted) {
    if (c.srcMode === GITLINK || c.dstMode === GITLINK) return { refused: `${c.path} is a gitlink (a submodule), which the probe tree cannot take` };
    if (c.path.includes('\n')) return { refused: `${JSON.stringify(c.path)} has a line break in its name, which the probe tree cannot check` };
  }
  const deleted = new Set(sorted.filter((c) => c.status === 'D').map((c) => c.path));
  const added = sorted.filter((c) => c.status !== 'D');
  const parents = [...new Set(added.flatMap((c) => parentsOf(c.path)))];
  const types = await objectTypes(repoRoot, base, [...parents, ...added.map((c) => c.path)]);
  for (const c of added) {
    for (const d of parentsOf(c.path)) {
      const t = types.get(d);
      if (t !== null && t !== undefined && t !== 'tree' && !deleted.has(d)) return { refused: `${c.path} needs the directory ${d}, but ${d} is a file on the base revision that the probe keeps (it is not test-owned)` };
    }
    if (types.get(c.path) === 'tree') {
      const inside = (await git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', base, '--', `:(literal)${c.path}`])).split('\0').filter((p) => p.length > 0);
      const kept = inside.filter((p) => !deleted.has(p));
      if (kept.length > 0) return { refused: `${c.path} is a directory on the base revision whose files the probe keeps (${kept[0]}${kept.length > 1 ? ` and ${kept.length - 1} more` : ''}), so a test-owned file cannot replace it` };
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'orbit-probe-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    await git(repoRoot, ['read-tree', base], { env });
    const info = sorted.map((c) => (c.status === 'D' ? `0 ${'0'.repeat(c.srcSha.length)}\t${c.path}\0` : `${c.dstMode} ${c.dstSha}\t${c.path}\0`)).join('');
    if (info.length > 0) await git(repoRoot, ['update-index', '-z', '--index-info'], { env, input: info });
    return { tree: (await git(repoRoot, ['write-tree'], { env })).trim() };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Commit the probe tree on the base revision with Orbit's identity, dated by the base commit so the same base, tree and
 * message always give the same commit, and pin it under `ref` (refs/orbit/<run>/fail-before/<seq>).
 */
export async function commitProbeTree(repoRoot: string, o: { base: string; tree: string; ref: string; message: string }): Promise<string> {
  const when = `${(await git(repoRoot, ['show', '-s', '--format=%ct', o.base])).trim()} +0000`;
  const commit = (
    await git(repoRoot, ['commit-tree', o.tree, '-p', o.base, '-m', o.message], {
      env: { GIT_AUTHOR_NAME: ORBIT_GIT_IDENTITY.name, GIT_AUTHOR_EMAIL: ORBIT_GIT_IDENTITY.email, GIT_COMMITTER_NAME: ORBIT_GIT_IDENTITY.name, GIT_COMMITTER_EMAIL: ORBIT_GIT_IDENTITY.email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    })
  ).trim();
  await git(repoRoot, ['update-ref', o.ref, commit]);
  return commit;
}

export function probeRef(runId: string, seq: number): string {
  return `refs/orbit/${runId}/fail-before/${seq}`;
}

/** Where a candidate's probe attempts keep their logs: evidence/<seq>/fail-before/. */
export function probeEvidenceDir(runDir: string, seq: number): string {
  return join(candidateEvidenceDir(runDir, seq), 'fail-before');
}

// ---------------------------------------------------------------------------
// Records

interface ProbeRow {
  id: string;
  run_id: string;
  candidate_id: string;
  probe_id: string;
  probe_tree: string;
  check_id: string;
  check_config_hash: string;
  policy_hash: string;
  attempt: number;
  command_json: string;
  cwd: string;
  isolation: string;
  status: string;
  exit_code: number | null;
  signals_json: string | null;
  log_path: string | null;
  log_sha256: string | null;
  excerpt: string | null;
  pid: number | null;
  started_at: number;
  ended_at: number | null;
}

/** A probe attempt as the runner supervises it. It carries no fingerprint: nothing may read it as the run's failure. */
function toCheckRun(r: ProbeRow): CheckRunRecord {
  const status = r.status as CheckRunRecord['status'];
  return {
    id: r.id,
    runId: r.run_id,
    candidateId: r.candidate_id,
    checkId: r.check_id,
    kind: 'command',
    treeHash: r.probe_tree,
    checkConfigHash: r.check_config_hash,
    policyHash: r.policy_hash,
    command: JSON.parse(r.command_json) as string[],
    cwd: r.cwd,
    isolation: r.isolation,
    status,
    exitCode: r.exit_code,
    timedOut: status === 'TIMEOUT',
    cancelled: status === 'CANCELLED',
    flaky: false,
    rerunOf: null,
    pid: r.pid,
    logPath: r.log_path,
    logSha256: r.log_sha256,
    fingerprint: null,
    excerpt: r.excerpt,
    artifacts: [],
    limitations: [],
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

const FINAL = new Set(['PASSED', 'FAILED', 'ERROR', 'TIMEOUT', 'CANCELLED']);

function probeRow(db: OrbitDb, id: string): ProbeRow {
  const row = db.get<ProbeRow>('SELECT * FROM fail_before_probes WHERE id = ?', id);
  if (!row) throw new OrbitError('NOT_FOUND', `no fail-before probe attempt ${id}`);
  return row;
}

/** The runner's attempt records for one probe: rows of fail_before_probes, numbered per check within the probe. */
export function probeRecords(probeId: string): AttemptRecords {
  return {
    list: (db, q) => db.all<ProbeRow>('SELECT * FROM fail_before_probes WHERE run_id = ? AND candidate_id = ? AND check_id = ? ORDER BY rowid', q.runId, q.candidateId ?? '', q.checkId).map(toCheckRun),
    plan: (db: OrbitDb, input: NewCheckRun, clock: Clock) => {
      const now = clock.now();
      return db.tx(() => {
        const run = db.get<{ cancel_requested: number; state: string }>('SELECT cancel_requested, state FROM runs WHERE id = ?', input.runId);
        if (!run) throw new OrbitError('NOT_FOUND', `no run ${input.runId}`);
        if (run.cancel_requested === 1 || TERMINAL_STATES.has(run.state as RunState)) {
          throw new OrbitError('CANCELLED', `run ${input.runId} is ${run.cancel_requested === 1 ? 'cancelled' : run.state}; no fail-before probe starts`, { runId: input.runId, checkId: input.checkId });
        }
        const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM fail_before_probes WHERE probe_id = ? AND check_id = ?', probeId, input.checkId)?.n ?? 0;
        const id = newId('fbp');
        db.run(
          `INSERT INTO fail_before_probes (id, run_id, candidate_id, probe_id, probe_tree, check_id, check_config_hash, policy_hash, attempt, command_json, cwd, isolation, status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?)`,
          id,
          input.runId,
          input.candidateId ?? '',
          probeId,
          input.treeHash,
          input.checkId,
          input.checkConfigHash,
          input.policyHash,
          n + 1,
          JSON.stringify(input.command),
          input.cwd,
          input.isolation,
          now,
        );
        return toCheckRun(probeRow(db, id));
      });
    },
    running: (db, id, pid, clock) => {
      db.run("UPDATE fail_before_probes SET status = 'RUNNING', pid = ?, started_at = ? WHERE id = ? AND status = 'PLANNED'", pid, clock.now(), id);
      return toCheckRun(probeRow(db, id));
    },
    finish: (db, id, f: FinishedCheck) => {
      db.run('UPDATE fail_before_probes SET status = ?, exit_code = ?, log_path = ?, log_sha256 = ?, excerpt = ?, ended_at = ? WHERE id = ? AND status IN (\'PLANNED\', \'RUNNING\')', f.status, f.exitCode, f.logPath, f.logSha256, f.excerpt, f.endedAt, id);
      return toCheckRun(probeRow(db, id));
    },
  };
}

/** Every recorded probe attempt of a run, oldest first: for tests and `orbit` readers. */
export function listProbeAttempts(db: OrbitDb, runId: string, opts: { probeId?: string; candidateId?: string } = {}): { id: string; probeId: string; candidateId: string; probeTree: string; checkId: string; attempt: number; status: string; exitCode: number | null; signals: EnvironmentSignal[]; logPath: string | null }[] {
  const where = ['run_id = ?'];
  const params: string[] = [runId];
  if (opts.probeId !== undefined) {
    where.push('probe_id = ?');
    params.push(opts.probeId);
  }
  if (opts.candidateId !== undefined) {
    where.push('candidate_id = ?');
    params.push(opts.candidateId);
  }
  return db.all<ProbeRow>(`SELECT * FROM fail_before_probes WHERE ${where.join(' AND ')} ORDER BY rowid`, ...params).map((r) => ({
    id: r.id,
    probeId: r.probe_id,
    candidateId: r.candidate_id,
    probeTree: r.probe_tree,
    checkId: r.check_id,
    attempt: r.attempt,
    status: r.status,
    exitCode: r.exit_code,
    signals: r.signals_json ? (JSON.parse(r.signals_json) as EnvironmentSignal[]) : [],
    logPath: r.log_path,
  }));
}

/** Probe attempt directories by row id, from each attempt's intent.json (evidence/<seq>/fail-before/<check>[~n]). */
function probeDirs(runDir: string): Map<string, { dir: string; intent: ShimIntent }> {
  const found = new Map<string, { dir: string; intent: ShimIntent }>();
  const subdirs = (d: string): string[] => {
    try {
      return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const seq of subdirs(join(runDir, 'evidence'))) {
    const root = join(runDir, 'evidence', seq, 'fail-before');
    for (const name of subdirs(root)) {
      const dir = join(root, name);
      const intent = readJsonFile<ShimIntent>(shimPath(dir, 'intent'));
      if (intent && typeof intent.checkRunId === 'string') found.set(intent.checkRunId, { dir, intent });
    }
  }
  return found;
}

/** What closeInterruptedProbes did: the attempts it closed, and those it kept open because they may still run. */
export interface InterruptedProbes {
  closed: string[];
  kept: { id: string; checkId: string; why: string }[];
}

/**
 * Close the probe attempts a stopped controller left open: a probe is never reattached (its outcome is not established
 * and it runs again), so a check still running for it is stopped, and its row is CANCELLED as interrupted once the
 * attempt is confirmed absent (recovery/check-attempt: never started, ended, or stopped and confirmed gone). An attempt
 * that may still run (its shim or its check cannot be identified or confirmed stopped, a process carries its token) is
 * kept open, with why: its open row keeps the run's release, and the probe, from removing its checkout beneath it.
 * Called by reconcile and before a probe starts.
 */
export async function closeInterruptedProbes(db: OrbitDb, runDir: string, runId: string, clock: Clock, opts: { graceMs?: number } = {}): Promise<InterruptedProbes> {
  const out: InterruptedProbes = { closed: [], kept: [] };
  const open = db.all<ProbeRow>("SELECT * FROM fail_before_probes WHERE run_id = ? AND status IN ('PLANNED', 'RUNNING') ORDER BY rowid", runId);
  if (open.length === 0) return out;
  const dirs = probeDirs(runDir);
  for (const row of open) {
    // No intent.json: the runner writes it before the spawn, so no shim was started for this attempt.
    const found = dirs.get(row.id);
    if (found) {
      const settled = await settleCheckAttempt(found.dir, found.intent, { stop: true, graceMs: opts.graceMs ?? DEFAULT_PROBE_STOP_GRACE_MS });
      if (settled.mayRun) {
        out.kept.push({ id: row.id, checkId: row.check_id, why: settled.detail ?? 'its shim may still run' });
        continue;
      }
    }
    db.run("UPDATE fail_before_probes SET status = 'CANCELLED', excerpt = ?, ended_at = ? WHERE id = ? AND status IN ('PLANNED', 'RUNNING')", 'interrupted: a probe whose controller stopped is not established and runs again', clock.now(), row.id);
    out.closed.push(row.id);
  }
  return out;
}

const DEFAULT_PROBE_STOP_GRACE_MS = 2_000;

/** Whether an attempt of the probe is still open: its check could not be confirmed stopped, and may still run in the checkout. */
function probeAttemptOpen(db: OrbitDb, probeId: string): boolean {
  return db.get("SELECT 1 AS x FROM fail_before_probes WHERE probe_id = ? AND status IN ('PLANNED', 'RUNNING') LIMIT 1", probeId) !== undefined;
}

// ---------------------------------------------------------------------------
// Running the probe

export interface ProbeRequest {
  /** The candidate's runner context; checkoutDir and records are the probe's own. */
  runner: Omit<RunnerContext, 'checkoutDir' | 'records' | 'definitions' | 'setAside' | 'parallelism'>;
  repoRoot: string;
  baseRev: string;
  candidate: Pick<Candidate, 'id' | 'seq' | 'runId' | 'commitSha'>;
  /** The checks to probe, each with the criteria whose support rests on it. */
  checks: readonly { checkId: string; criteria: readonly string[] }[];
  /** The candidate's test-owned changes: what the probe tree takes from it. */
  changes: readonly ProbeChange[];
  /** An empty directory beside the candidate's check checkout; removed afterwards. */
  checkoutDir: string;
  /** The one wall-clock bound of the whole probe (verification.fail_before_timeout_seconds). */
  timeoutMs: number;
  /** What is left of the run's wall-time budget; the probe is skipped when it is less than its bound. Null: no budget yet. */
  wallRemainingMs: number | null;
  /** Records the probe's `verification.fail-before` decision. */
  decide: (d: { id: string; kind: string; summary: string; data: unknown }) => void;
}

export interface ProbeResult {
  /** The probe that ran or whose results were reused; null when none ran (a refused tree, the budget). */
  probeId: string | null;
  /** The probe tree; null when it was refused. */
  probeTree: string | null;
  baseRevision: string;
  /** The test-owned paths the probe tree takes from the candidate. */
  testPaths: string[];
  checks: CheckProbe[];
  /** Whether every result was taken from an earlier probe of the same tree. */
  reused: boolean;
}

interface DecisionCheck {
  check_id: string;
  check_config_hash: string;
  outcome: FailBeforeOutcome;
  cause?: NotEstablishedCause;
  reason: string;
  criteria: string[];
  attempts: { attempt: number; status: CheckStatus; exit_code: number | null; signals: EnvironmentSignal[]; unscanned?: string; log: string | null }[];
}

interface DecisionData {
  probe_id: string;
  candidate_id: string;
  candidate_seq: number;
  base_revision: string;
  probe_tree: string;
  policy_hash: string;
  test_paths: { paths: string[]; count: number };
  checks: DecisionCheck[];
}

const MAX_LISTED_PATHS = 20;

export function listedPaths(paths: readonly string[]): { paths: string[]; count: number } {
  return { paths: paths.slice(0, MAX_LISTED_PATHS), count: paths.length };
}

/** A decisive result of an earlier probe of the same tree, check configuration and policy, for each check that has one. */
function reusable(db: OrbitDb, runId: string, probeTree: string, policyHash: string, configHashes: ReadonlyMap<string, string>): Map<string, { probeId: string; check: CheckProbe }> {
  const out = new Map<string, { probeId: string; check: CheckProbe }>();
  for (const d of listDecisions(db, runId, { kind: FAIL_BEFORE_DECISION_KIND })) {
    const data = d.data as DecisionData | null;
    if (!data || data.probe_tree !== probeTree || data.policy_hash !== policyHash || !Array.isArray(data.checks)) continue;
    for (const c of data.checks) {
      if (c.outcome === 'not-established' || configHashes.get(c.check_id) !== c.check_config_hash) continue;
      out.set(c.check_id, { probeId: data.probe_id, check: { checkId: c.check_id, outcome: c.outcome, reason: c.reason, attempts: c.attempts.map((a) => ({ attempt: a.attempt, status: a.status, exitCode: a.exit_code, signals: a.signals, log: a.log })) } });
    }
  }
  return out;
}

function notEstablished(checkIds: readonly string[], cause: NotEstablishedCause, reason: (id: string) => string): CheckProbe[] {
  return checkIds.map((id) => ({ checkId: id, outcome: 'not-established' as const, cause, reason: reason(id), attempts: [] }));
}

/** A path relative to the run directory when it lies inside it, as the evidence report names logs. */
function runRelative(runDir: string, p: string | null): string | null {
  if (p === null) return null;
  const r = relative(runDir, p);
  return r === '' || r.startsWith('..') || isAbsolute(r) ? p : r.split(sep).join('/');
}

/**
 * Run the fail-before probe for a candidate (ADR 0014 section 2): build the probe tree, reuse the decisive results of an
 * earlier probe of the same tree, configuration and policy, and run each remaining check on a checkout of the tree after
 * the locked install, a failing attempt once more. The whole probe has one wall-clock bound, and is skipped as not
 * established when the run's remaining wall time is smaller. Records one `verification.fail-before` decision when it ran.
 */
export async function runFailBeforeProbe(req: ProbeRequest): Promise<ProbeResult> {
  const { runner, candidate } = req;
  const { db, snapshot, clock, runDir } = runner;
  const checkIds = req.checks.map((c) => c.checkId);
  const testPaths = req.changes.map((c) => c.path).sort();
  const result = (probeTree: string | null, checks: CheckProbe[], probeId: string | null = null, reused = false): ProbeResult => ({ probeId, probeTree, baseRevision: req.baseRev, testPaths, checks, reused });
  const interrupted = await closeInterruptedProbes(db, runDir, runner.run.id, clock, { graceMs: runner.killGraceMs });
  if (interrupted.kept.length > 0) {
    // An earlier probe's check may still run in the checkout this probe would clean and use: the probe waits for it.
    const why = interrupted.kept.map((k) => `${k.checkId} (${k.why})`).join('; ');
    return result(null, notEstablished(checkIds, 'interrupted', (id) => `${id} was not probed: an earlier fail-before probe attempt may still be running: ${why}; the probe runs again once it has ended`));
  }

  const built = await buildProbeTree(req.repoRoot, req.baseRev, req.changes);
  if ('refused' in built) return result(null, notEstablished(checkIds, 'refused-tree', (id) => `${id} was not probed: git refused the probe tree (${built.refused})`));
  const probeTree = built.tree;

  const defs = new Map(checkIds.map((id) => [id, snapshot.config.checks[id]!] as const));
  const configHashes = new Map(checkIds.map((id) => [id, configHashFor(snapshot, defs.get(id)!)] as const));
  const earlier = reusable(db, runner.run.id, probeTree, runner.run.policyHash, configHashes);
  const toRun = checkIds.filter((id) => !earlier.has(id));
  const reusedChecks = checkIds.filter((id) => earlier.has(id)).map((id) => earlier.get(id)!.check);
  if (toRun.length === 0) return result(probeTree, reusedChecks, earlier.get(checkIds[0]!)!.probeId, true);
  if (req.wallRemainingMs !== null && req.wallRemainingMs < req.timeoutMs) {
    const left = Math.max(0, Math.floor(req.wallRemainingMs / 1000));
    return result(probeTree, [...reusedChecks, ...notEstablished(toRun, 'budget', (id) => `${id} was not probed: the run has ${left} s of wall time left, less than the probe's bound of ${Math.floor(req.timeoutMs / 1000)} s (verification.fail_before_timeout_seconds)`)]);
  }

  const probeId = newId('probe');
  const commit = await commitProbeTree(req.repoRoot, { base: req.baseRev, tree: probeTree, ref: probeRef(runner.run.id, candidate.seq), message: `orbit fail-before probe ${runner.run.id}/${candidate.seq}\n\nbase: ${req.baseRev}\ncandidate: ${candidate.commitSha}\ntree: ${probeTree}\n` });
  await cleanupCandidateCheckout(req.repoRoot, req.checkoutDir).catch(() => {});
  await materializeCandidate(req.repoRoot, commit, req.checkoutDir, { readOnly: false });
  const checkout = realpathSync(req.checkoutDir);
  const deadline = clock.now() + req.timeoutMs;
  const ctx: RunnerContext = { ...runner, checkoutDir: checkout, records: probeRecords(probeId) };
  const subject: CheckSubject = { candidateId: candidate.id, bindingId: `fail-before:${probeTree}`, treeHash: probeTree, evidenceDir: probeEvidenceDir(runDir, candidate.seq), source: 'check' };
  const attemptOf = (row: CheckRunRecord, def: CheckDefinition): ProbeAttempt => {
    const base = { attempt: attemptNumber(db, row.id), status: row.status as CheckStatus, exitCode: row.exitCode, log: runRelative(runDir, row.logPath) };
    // Every attempt's log is read for an environment signal, a passing one too (a shell pipeline can hide a failing
    // command's exit status), however long or cut short it is (scanProbeLog).
    const scan = scanProbeLog(readProbeLog(row.logPath), {
      exitCode: row.exitCode,
      command: def.command,
      shell: def.shell,
      insideRoots: [checkout, req.checkoutDir, row.cwd, ...(row.logPath ? [dirname(row.logPath)] : [])],
      startFailure: row.status === 'ERROR' && row.excerpt?.startsWith('could not start the check') ? row.excerpt : null,
    });
    if (scan.signals.length > 0) db.run('UPDATE fail_before_probes SET signals_json = ? WHERE id = ?', JSON.stringify(scan.signals), row.id);
    return { ...base, signals: scan.signals, ...(scan.unscanned === undefined ? {} : { unscanned: scan.unscanned }) };
  };
  /**
   * One attempt, or why the runner refused to start it (a cwd missing from the probe tree, a tracked file an earlier
   * attempt rewrote): that check is not established. A cancellation or a stop of supervision is not caught here.
   */
  const attempt = async (def: CheckDefinition, configHash: string): Promise<CheckRunRecord | string> => {
    try {
      return await runAttempt(ctx, subject, def, configHash);
    } catch (err) {
      // An attempt whose check could not be confirmed stopped stays open and ends the probe: nothing else may start beside it.
      if (!isOrbitError(err) || err.code === 'CANCELLED' || err.details?.mayRun === true) throw err;
      return err.message;
    }
  };
  const ran: CheckProbe[] = [];
  let stopped: { cause: NotEstablishedCause; reason: (id: string) => string } | null = null;
  try {
    // The locked install, as the candidate's checkout had it: the probe tree's manifests are the base's.
    // It keeps to the probe's one bound like every check: each attempt gets at most what is left of it, and none starts
    // once it has run out. A bound that ran out is the budget's, not the install's: only an install that failed within
    // it is an install failure, which is never accepted.
    const outOfBudget = (id: string): string => `${id} was not probed to the end: the probe's bound of ${Math.floor(req.timeoutMs / 1000)} s (verification.fail_before_timeout_seconds) ran out during the locked install`;
    const install = planInstall(snapshot, checkout);
    if (!install.skip) {
      for (const def of install.definitions) {
        const attempts: ProbeAttempt[] = [];
        let refused: string | null = null;
        let bounded = false;
        let outOfTime = false;
        for (let n = 0; n < 2; n++) {
          const left = deadline - clock.now();
          if (left <= 0) {
            outOfTime = true;
            break;
          }
          const timeout = Math.min(def.timeout_seconds, Math.max(1, Math.ceil(left / 1000)));
          bounded = timeout < def.timeout_seconds;
          const row = await attempt({ ...def, timeout_seconds: timeout }, configHashFor(snapshot, def));
          if (typeof row === 'string') {
            refused = row;
            break;
          }
          attempts.push(attemptOf(row, def));
          if (row.status !== 'FAILED') break;
        }
        const last = attempts.at(-1);
        // An environment signal in any install attempt stops the probe, whatever the exit status: on the candidate a
        // broken install only fails its tests, but on the probe tree a failing test is the evidence (ADR 0014).
        const installSignals = [...new Set(attempts.flatMap((a) => a.signals))];
        if (refused === null && installSignals.length > 0) {
          stopped = { cause: 'environment', reason: (id) => `${id} was not probed: the locked install (${def.id}) on the probe tree shows an environment cause (${installSignals.join(', ')})${last?.log ? ` (${last.log})` : ''}` };
          break;
        }
        // A passing install with any attempt's log cut short may have dropped the line that shows such a cause: the tree it
        // built cannot be trusted to produce evidence, so the probe stops as unscanned (never failed-before).
        const cut = attempts.find((a) => a.unscanned !== undefined);
        if (refused === null && last?.status === 'PASSED' && cut !== undefined) {
          stopped = { cause: 'unscanned', reason: (id) => `${id} was not probed: the log of the locked install (${def.id}, attempt ${cut.attempt}) on the probe tree could not be read whole (${cut.unscanned}), so an environment cause cannot be ruled out${cut.log ? ` (${cut.log})` : ''}` };
          break;
        }
        // Otherwise the install is judged by its exit status: a retry that passes after a flaky failure built the tree.
        if (refused === null && last?.status === 'PASSED') continue;
        // Only an attempt the bound cut short, or none at all, is the budget's. An install that FAILED once still failed,
        // even when its retry had no time left or was cut short: that is the install's, never accepted.
        if (refused === null && !attempts.some((a) => a.status === 'FAILED') && (outOfTime || (last?.status === 'TIMEOUT' && bounded))) {
          stopped = { cause: 'budget', reason: outOfBudget };
          break;
        }
        const how = refused !== null ? `could not be started (${refused})` : `ended ${last?.status ?? 'without a result'}`;
        stopped = { cause: 'install', reason: (id) => `${id} was not probed: the locked install (${def.id}) ${how} on the probe tree${last?.log ? ` (${last.log})` : ''}` };
        break;
      }
    }
    for (const id of toRun) {
      if (stopped) break;
      const def = defs.get(id)!;
      const attempts: ProbeAttempt[] = [];
      let bounded = false;
      let refused: string | null = null;
      for (let n = 0; n < 2; n++) {
        const left = deadline - clock.now();
        if (left <= 0) break;
        const timeout = Math.min(def.timeout_seconds, Math.max(1, Math.ceil(left / 1000)));
        bounded = timeout < def.timeout_seconds;
        // A shorter timeout keeps the probe inside its bound; the attempt stays bound to the check's own configuration.
        const row = await attempt({ ...def, timeout_seconds: timeout }, configHashes.get(id)!);
        if (typeof row === 'string') {
          refused = row;
          break;
        }
        attempts.push(attemptOf(row, def));
        if (row.status !== 'FAILED') break;
      }
      if (refused !== null) {
        ran.push({ checkId: id, outcome: 'not-established', cause: 'error', reason: `${id} could not be run on the probe tree: ${refused}`, attempts });
        continue;
      }
      let judged = judgeProbeAttempts(id, attempts);
      // Not run at all, cut short by the probe's bound, or not repeated for want of time: the bound ran out, not the check.
      const outOfTime = attempts.length === 0 || judged.cause === 'once' || (judged.cause === 'timeout' && bounded);
      if (judged.outcome === 'not-established' && outOfTime && clock.now() >= deadline - 1000) {
        judged = { ...judged, cause: 'budget', reason: `${id} was not probed to the end: the probe's bound of ${Math.floor(req.timeoutMs / 1000)} s (verification.fail_before_timeout_seconds) ran out` };
      }
      ran.push(judged);
    }
  } catch (err) {
    // A cancelled run starts nothing new; what was not probed is not established. Supervision that stopped (a lost
    // lease, a shutdown) leaves the attempts open for the next owner, which closes them and probes again.
    if (!isOrbitError(err, 'CANCELLED') || err.details?.detached === true) throw err;
    stopped = { cause: 'cancelled', reason: (id) => `${id} was not probed: the run was cancelled` };
  } finally {
    // Not beneath an attempt that may still run (supervision stopped, or its check could not be confirmed stopped).
    if (runner.detachSignal?.aborted !== true && !probeAttemptOpen(db, probeId)) await cleanupCandidateCheckout(req.repoRoot, req.checkoutDir).catch(() => {});
  }
  const done = new Set(ran.map((c) => c.checkId));
  const rest = stopped ? notEstablished(toRun.filter((id) => !done.has(id)), stopped.cause, stopped.reason) : [];
  const checks = checkIds.map((id) => earlier.get(id)?.check ?? ran.find((c) => c.checkId === id) ?? rest.find((c) => c.checkId === id)!);
  if (stopped?.cause !== 'cancelled') {
    const criteria = new Map<string, string[]>(req.checks.map((c) => [c.checkId, [...c.criteria]]));
    const fresh = checks.filter((c) => toRun.includes(c.checkId));
    const data: DecisionData = {
      probe_id: probeId,
      candidate_id: candidate.id,
      candidate_seq: candidate.seq,
      base_revision: req.baseRev,
      probe_tree: probeTree,
      policy_hash: runner.run.policyHash,
      test_paths: listedPaths(testPaths),
      checks: fresh.map((c) => ({ check_id: c.checkId, check_config_hash: configHashes.get(c.checkId)!, outcome: c.outcome, ...(c.cause ? { cause: c.cause } : {}), reason: c.reason, criteria: criteria.get(c.checkId) ?? [], attempts: c.attempts.map((a) => ({ attempt: a.attempt, status: a.status, exit_code: a.exitCode, signals: a.signals, ...(a.unscanned === undefined ? {} : { unscanned: a.unscanned }), log: a.log })) })),
    };
    req.decide({ id: `dec-${runner.run.id}-fail-before-${probeId}`, kind: FAIL_BEFORE_DECISION_KIND, summary: probeSummary(data.checks), data });
  }
  return result(probeTree, checks, probeId, false);
}

function attemptNumber(db: OrbitDb, id: string): number {
  return db.get<{ attempt: number }>('SELECT attempt FROM fail_before_probes WHERE id = ?', id)?.attempt ?? 1;
}

/** The decision's line, one clause per check: "unit failed on the base revision with the new tests (exit 1, 2 attempts): AC-1, AC-2". */
export function probeSummary(checks: readonly Pick<DecisionCheck, 'reason' | 'criteria'>[]): string {
  return checks.map((c) => `${c.reason}${c.criteria.length > 0 ? `: ${c.criteria.join(', ')}` : ''}`).join('; ');
}

// ---------------------------------------------------------------------------
// What the report says

export interface FailBeforeEvidence {
  mode: FailBeforeMode;
  /** The probe's results for this candidate (run now or reused), or null when none ran. */
  probe: ProbeResult | null;
  /** Why no probe ran, when that is why a criterion's outcome is not established. */
  skipped: { cause: NotEstablishedCause; reason: string } | null;
  /** Criteria a person accepted without fail-before for this candidate's tree. */
  accepted: readonly { criterionId: string; questionId: string; by: string }[];
}

/**
 * A criterion's `fail_before` entry, from its test support and the probe. `outcome` is the criterion's: failed-before
 * when a probed check it cites failed before, passed-before when every one passed before, otherwise not established.
 */
export function criterionFailBefore(support: CriterionTestSupport, fb: FailBeforeEvidence): CriterionFailBefore {
  const base = { mode: fb.mode, probe_tree: fb.probe?.probeTree ?? null, test_paths: listedPaths(support.testPaths) };
  const accepted = fb.accepted.find((a) => a.criterionId === support.criterionId);
  const acceptance = accepted ? { accepted: { question_id: accepted.questionId, by: accepted.by } } : {};
  if (support.flips.length > 0 || support.withTests.length === 0) {
    const reason = support.flips.length > 0 ? `its support does not rest on new tests: ${support.flips.join(', ')} failed on the base revision` : 'no check it cites runs a new test';
    return { ...base, outcome: 'not-applicable', checks: [], reason };
  }
  if (fb.mode === 'off') return { ...base, outcome: 'not-run', checks: [], reason: 'the fail-before probe was not run (verification.fail_before: off)' };
  // In check id order, so the order a criterion cites its checks in changes nothing.
  const ids = [...support.probeable].sort();
  const probed = ids.map((id) => ({ id, c: fb.probe?.checks.find((x) => x.checkId === id) ?? null }));
  const checks = probed.flatMap(({ c }) => (c === null ? [] : [{ id: c.checkId, outcome: c.outcome, ...(c.cause ? { cause: c.cause } : {}), attempts: c.attempts.map((a) => ({ status: a.status, exit_code: a.exitCode, log: a.log })) }]));
  if (ids.length === 0) {
    return { ...base, outcome: 'not-established', cause: 'not-probed', checks, reason: `${support.withTests.join(', ')} ${support.withTests.length === 1 ? 'is' : 'are'} not probed: only a command check of category test that passed on the base revision is`, ...acceptance };
  }
  const failed = probed.find(({ c }) => c?.outcome === 'failed-before');
  if (failed) return { ...base, outcome: 'failed-before', checks, reason: failed.c!.reason, ...acceptance };
  if (probed.every(({ c }) => c?.outcome === 'passed-before')) return { ...base, outcome: 'passed-before', checks, reason: probed.map(({ c }) => c!.reason).join('; '), ...acceptance };
  // Every check left open counts: a cause no person may accept on any of them decides, whatever the others show.
  const open = probed.filter(({ c }) => c === null || c.outcome === 'not-established');
  const causes = open.map(({ c }) => c?.cause ?? fb.skipped?.cause ?? 'not-probed');
  // A cause no person may accept first, then the other open causes, and unscanned only when nothing else is open.
  const cause = causes.find((c) => !acceptableCause(c)) ?? causes.find((c) => c !== 'unscanned') ?? causes[0]!;
  const reason = [...new Set(open.map(({ id, c }) => c?.reason ?? fb.skipped?.reason ?? `${id} was not probed`))].join('; ');
  return { ...base, outcome: 'not-established', cause, checks, reason, ...(causes.every(acceptableCause) ? acceptance : {}) };
}

/**
 * Whether the candidate is otherwise acceptable, as the evidence report judges its required checks: each passed (a pass
 * that needed a rerun only where the policy accepts one), or failed exactly as the contract's baseline exception for it
 * records (`exceptions`, check id to fingerprint), which the report accepts too.
 */
export function otherwiseAcceptable(results: readonly CheckResult[], required: readonly string[], allowFlaky: boolean, exceptions: ReadonlyMap<string, string>): boolean {
  return required.every((id) => {
    const r = results.filter((x) => x.checkId === id).at(-1);
    if (r === undefined) return false;
    if (r.status === 'PASSED') return !r.flaky || allowFlaky;
    const recorded = exceptions.get(id);
    return (r.status === 'FAILED' || r.status === 'TIMEOUT') && recorded !== undefined && r.fingerprint !== null && r.fingerprint === recorded;
  });
}

/** The log file of an attempt named in a report, as an absolute path. */
export function probeLogPath(runDir: string, log: string): string {
  return isAbsolute(log) ? log : join(runDir, log);
}

/** The characters of one probe log a review packet shows: enough for the tests that failed, and bounded. */
export const PROBE_EXCERPT_CHARS = 4_000;
/** One line of an excerpt is cut here, so a long path or stack frame cannot spend the whole bound. */
const EXCERPT_LINE_CHARS = 240;
/** Lines kept before and after a failure line, widest first; the widest that still fits the bound is used. */
const EXCERPT_CONTEXT: readonly (readonly [number, number])[] = [
  [2, 4],
  [1, 2],
];

/**
 * A line that reports a failure, in the words test runners and compilers use ("not ok", "FAILED", "--- FAIL",
 * "error CS1061", "ImportError", "panicked"), read without knowing which runner wrote it. Paths are not read (the probe's
 * own checkout is named fail-before-<n>), and a count of none ("# fail 0", "Failed: 0", "0 errors") is not a failure.
 */
const FAILURE_WORDS = /\bnot ok\b|\bfail(?:s|ed|ure|ures|ing)?\b|\b\w*(?:error|exception)s?\b|\bpanick?(?:ed|s)?\b/i;
const NONE_COUNTED = /\b(?:fail(?:s|ed|ures?)?|errors?)\b\s*[:=]?\s*0\b(?!\.\d)|\b0\s+(?:fail(?:s|ed|ures?)?|errors?)\b/gi;
const PATH_LIKE = /\S*[/\\]\S*/g;

function reportsFailure(line: string): boolean {
  return FAILURE_WORDS.test(line.replace(PATH_LIKE, ' ').replace(NONE_COUNTED, ''));
}

const notShown = (n: number): string => `[orbit: ${n} ${n === 1 ? 'line' : 'lines'} not shown]`;

/** The lines at `keep` (ascending indices), with a marker for each run of lines left out. */
function renderKept(lines: readonly string[], keep: readonly number[]): string {
  const out: string[] = [];
  let next = 0;
  for (const i of keep) {
    if (i > next) out.push(notShown(i - next));
    out.push(lines[i]!);
    next = i + 1;
  }
  if (next < lines.length) out.push(notShown(lines.length - next));
  return `${out.join('\n')}\n`;
}

/**
 * What a review packet shows of a probe log (ADR 0014): the lines that report a failure, wherever they are, with a little
 * context, within `max` characters. The end of a test runner's log is its passing suites and a summary, so a tail hides
 * the tests that failed. The failure lines come first, in at most half the bound (any beyond are counted, not shown),
 * then as much context around each, in order, as the rest of the bound holds. A log with no failure line is shown by its
 * head and its tail; a log that fits is returned unchanged.
 */
export function failureExcerpt(text: string, max = PROBE_EXCERPT_CHARS): string {
  if (text.length <= max) return text;
  const lines = text.replace(/\n$/, '').split('\n').map((l) => (l.length > EXCERPT_LINE_CHARS ? `${l.slice(0, EXCERPT_LINE_CHARS)}...` : l));
  const hits = lines.flatMap((l, i) => (reportsFailure(l) ? [i] : []));
  const render = (keep: ReadonlySet<number>): string => renderKept(lines, [...keep].sort((a, b) => a - b));
  // Room for the count of failure lines left out.
  const room = max - 60;
  if (hits.length === 0) {
    // Head and tail, each about half the bound.
    const keep = new Set<number>();
    for (let i = 0; i < lines.length && render(new Set([...keep, i])).length <= room / 2; i++) keep.add(i);
    for (let i = lines.length - 1; i >= 0 && !keep.has(i) && render(new Set([...keep, i])).length <= room; i--) keep.add(i);
    return render(keep);
  }
  const keep = new Set<number>();
  let shown = 0;
  while (shown < hits.length && render(new Set([...keep, hits[shown]!])).length <= room / 2) keep.add(hits[shown++]!);
  for (const h of hits.slice(0, shown)) {
    for (const [before, after] of EXCERPT_CONTEXT) {
      const wider = new Set(keep);
      for (let i = Math.max(0, h - before); i <= Math.min(lines.length - 1, h + after); i++) wider.add(i);
      if (render(wider).length > room) continue;
      for (const i of wider) keep.add(i);
      break;
    }
  }
  const left = hits.length - shown;
  return left === 0 ? render(keep) : `${render(keep)}[orbit: ${left} more failing ${left === 1 ? 'line' : 'lines'} not shown]\n`;
}

/** A probe log's excerpt for a review packet (`failureExcerpt`); empty when the log cannot be read. */
export function probeLogExcerpt(path: string, max = PROBE_EXCERPT_CHARS): string {
  try {
    return failureExcerpt(readFileSync(path, 'utf8'), max);
  } catch {
    return '';
  }
}
