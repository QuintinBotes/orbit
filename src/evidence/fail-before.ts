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
 * changed production code only). A probe interrupted by a crash is closed as interrupted and runs again.
 */
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { OrbitError, isOrbitError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { isAlive, killGroup } from '../core/proc.ts';
import { TERMINAL_STATES, type RunState } from '../core/run-states.ts';
import type { GoalContract } from '../contract/types.ts';
import { checkCategory } from '../policy/config.ts';
import { isTestPath } from '../policy/test-files.ts';
import type { CheckDefinition, FailBeforeMode, PolicySnapshot } from '../policy/types.ts';
import type { OrbitDb } from '../storage/db.ts';
import { listDecisions } from '../storage/decisions.ts';
import { cleanupCandidateCheckout, materializeCandidate, ORBIT_GIT_IDENTITY } from './candidate.ts';
import { classifyProgramNotFound } from './check-misconfigured.ts';
import { readJsonFile, shimPath, type ShimIntent, type ShimLaunch, type ShimPid } from './check-shim.ts';
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
  const signals = [...new Set(attempts.flatMap((a) => a.signals))];
  if (signals.length > 0) return done('not-established', `${checkId} could not run on the probe tree: its output shows an environment cause (${signals.join(', ')}), not a test result`, 'environment');
  const statuses = attempts.map((a) => a.status);
  if (statuses.every((s) => s === 'PASSED')) return done('passed-before', `${checkId} passed on the base revision with the new tests`);
  if (statuses.every((s) => s === 'FAILED')) {
    if (attempts.length < 2) return done('not-established', `${checkId} failed once on the base revision with the new tests, and a failure counts only when it repeats`, 'once');
    const exits = [...new Set(attempts.map((a) => (a.exitCode === null ? 'none' : String(a.exitCode))))];
    return done('failed-before', `${checkId} failed on the base revision with the new tests (exit ${exits.join(', ')}, ${attempts.length} attempts)`);
  }
  if (statuses.includes('ERROR')) return done('not-established', `${checkId} could not be run on the probe tree (ERROR)`, 'error');
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
 * The ADR 0010 environment signals an attempt on the probe tree shows, read as on the base revision: the signals of
 * BASE_GATED_SIGNALS count without a base comparison, since the probe tree is the base's but for its tests.
 */
export function probeSignals(input: SignalInput): EnvironmentSignal[] {
  const found =
    classifyNotExecuted({ checkId: 'probe', output: input.output, startFailure: input.startFailure ?? null }) ??
    classifyProgramNotFound({ checkId: 'probe', command: input.command, shell: input.shell, exitCode: input.exitCode, output: input.output }) ??
    classifyCouldNotRun({ checkId: 'probe', output: input.output, insideRoots: input.insideRoots });
  return found?.signals ?? [];
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

/**
 * Close the probe attempts a stopped controller left open: a probe is never reattached (its outcome is not established
 * and it runs again), so a check still running for it is stopped, when its shim is still the process that was started,
 * and its row is CANCELLED as interrupted. Returns the attempts closed. Called by reconcile and before a probe starts.
 */
export function closeInterruptedProbes(db: OrbitDb, runDir: string, runId: string, clock: Clock): string[] {
  const open = db.all<ProbeRow>("SELECT * FROM fail_before_probes WHERE run_id = ? AND status IN ('PLANNED', 'RUNNING') ORDER BY rowid", runId);
  if (open.length === 0) return [];
  const dirs = probeDirs(runDir);
  for (const row of open) {
    const found = dirs.get(row.id);
    if (found) stopProbeAttempt(found.dir, found.intent.token);
    db.run("UPDATE fail_before_probes SET status = 'CANCELLED', excerpt = ?, ended_at = ? WHERE id = ? AND status IN ('PLANNED', 'RUNNING')", 'interrupted: a probe whose controller stopped is not established and runs again', clock.now(), row.id);
  }
  return open.map((r) => r.id);
}

/** Stop an attempt's check group and shim, only while the shim is the process its launch record names. */
function stopProbeAttempt(dir: string, token: string): void {
  const launch = readJsonFile<ShimLaunch>(shimPath(dir, 'launch'));
  const pid = readJsonFile<ShimPid>(shimPath(dir, 'pid'));
  if (!launch || launch.token !== token) return;
  let ours = false;
  try {
    ours = isAlive(launch.pid, launch.procStart);
  } catch {
    ours = false;
  }
  if (!ours) return;
  if (pid && pid.token === token && pid.childPgid !== null) {
    try {
      killGroup(pid.childPgid, 'SIGKILL');
    } catch {
      /* refused (an unsafe group) or already gone */
    }
  }
  try {
    process.kill(launch.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
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
  attempts: { attempt: number; status: CheckStatus; exit_code: number | null; signals: EnvironmentSignal[]; log: string | null }[];
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

const MAX_LOG_READ = 4 * 1024 * 1024;

function readLog(path: string | null): string {
  if (path === null || !existsSync(path)) return '';
  const size = statSync(path).size;
  const len = Math.min(size, MAX_LOG_READ);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, 0);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
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
  closeInterruptedProbes(db, runDir, runner.run.id, clock);

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
    const signals =
      row.status === 'PASSED'
        ? []
        : probeSignals({
            output: readLog(row.logPath),
            exitCode: row.exitCode,
            command: def.command,
            shell: def.shell,
            insideRoots: [checkout, req.checkoutDir, row.cwd, ...(row.logPath ? [dirname(row.logPath)] : [])],
            startFailure: row.status === 'ERROR' && row.excerpt?.startsWith('could not start the check') ? row.excerpt : null,
          });
    if (signals.length > 0) db.run('UPDATE fail_before_probes SET signals_json = ? WHERE id = ?', JSON.stringify(signals), row.id);
    return { attempt: attemptNumber(db, row.id), status: row.status as CheckStatus, exitCode: row.exitCode, signals, log: runRelative(runDir, row.logPath) };
  };
  /**
   * One attempt, or why the runner refused to start it (a cwd missing from the probe tree, a tracked file an earlier
   * attempt rewrote): that check is not established. A cancellation or a stop of supervision is not caught here.
   */
  const attempt = async (def: CheckDefinition, configHash: string): Promise<CheckRunRecord | string> => {
    try {
      return await runAttempt(ctx, subject, def, configHash);
    } catch (err) {
      if (!isOrbitError(err) || err.code === 'CANCELLED') throw err;
      return err.message;
    }
  };
  const ran: CheckProbe[] = [];
  let stopped: { cause: NotEstablishedCause; reason: (id: string) => string } | null = null;
  try {
    // The locked install, as the candidate's checkout had it: the probe tree's manifests are the base's.
    const install = planInstall(snapshot, checkout);
    if (!install.skip) {
      for (const def of install.definitions) {
        const attempts: ProbeAttempt[] = [];
        let refused: string | null = null;
        for (let n = 0; n < 2; n++) {
          const row = await attempt(def, configHashFor(snapshot, def));
          if (typeof row === 'string') {
            refused = row;
            break;
          }
          attempts.push(attemptOf(row, def));
          if (row.status !== 'FAILED') break;
        }
        const last = attempts.at(-1);
        if (refused !== null || last?.status !== 'PASSED') {
          const how = refused !== null ? `could not be started (${refused})` : `ended ${last?.status ?? 'without a result'}`;
          stopped = { cause: 'install', reason: (id) => `${id} was not probed: the locked install (${def.id}) ${how} on the probe tree${last?.log ? ` (${last.log})` : ''}` };
          break;
        }
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
    if (runner.detachSignal?.aborted !== true) await cleanupCandidateCheckout(req.repoRoot, req.checkoutDir).catch(() => {});
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
      checks: fresh.map((c) => ({ check_id: c.checkId, check_config_hash: configHashes.get(c.checkId)!, outcome: c.outcome, ...(c.cause ? { cause: c.cause } : {}), reason: c.reason, criteria: criteria.get(c.checkId) ?? [], attempts: c.attempts.map((a) => ({ attempt: a.attempt, status: a.status, exit_code: a.exitCode, signals: a.signals, log: a.log })) })),
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
  const probed = support.probeable.map((id) => fb.probe?.checks.find((c) => c.checkId === id) ?? null);
  const checks = probed.flatMap((c) => (c === null ? [] : [{ id: c.checkId, outcome: c.outcome, ...(c.cause ? { cause: c.cause } : {}), attempts: c.attempts.map((a) => ({ status: a.status, exit_code: a.exitCode, log: a.log })) }]));
  if (support.probeable.length === 0) {
    return { ...base, outcome: 'not-established', cause: 'not-probed', checks, reason: `${support.withTests.join(', ')} ${support.withTests.length === 1 ? 'is' : 'are'} not probed: only a command check of category test that passed on the base revision is`, ...acceptance };
  }
  const failed = probed.find((c) => c?.outcome === 'failed-before');
  if (failed) return { ...base, outcome: 'failed-before', checks, reason: failed.reason, ...acceptance };
  if (probed.every((c) => c?.outcome === 'passed-before')) return { ...base, outcome: 'passed-before', checks, reason: probed.map((c) => c!.reason).join('; '), ...acceptance };
  const open = probed.find((c) => c === null || c.outcome === 'not-established') ?? null;
  const cause: NotEstablishedCause = open?.cause ?? fb.skipped?.cause ?? 'not-probed';
  const reason = open?.reason ?? fb.skipped?.reason ?? `${support.probeable.join(', ')} ${support.probeable.length === 1 ? 'was' : 'were'} not probed`;
  return { ...base, outcome: 'not-established', cause, checks, reason, ...acceptance };
}

/** The candidate's checks that a probe needs: every required check passed (not an unaccepted flaky pass). */
export function otherwiseAcceptable(results: readonly CheckResult[], required: readonly string[], allowFlaky: boolean): boolean {
  return required.every((id) => {
    const r = results.filter((x) => x.checkId === id).at(-1);
    return r !== undefined && r.status === 'PASSED' && (!r.flaky || allowFlaky);
  });
}

/** The log file of an attempt named in a report, as an absolute path. */
export function probeLogPath(runDir: string, log: string): string {
  return isAbsolute(log) ? log : join(runDir, log);
}

/** The last `max` characters of a probe log, for a review packet. */
export function probeLogTail(path: string, max = 2_000): string {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length <= max ? text : `...${text.slice(text.length - max)}`;
  } catch {
    return '';
  }
}
