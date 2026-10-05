import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { TERMINAL_STATES, type RunState } from '../core/run-states.ts';
import type { OrbitDb } from '../storage/db.ts';
import { appendEvent } from '../storage/events.ts';
import type { Candidate, CheckResult, CheckStatus, EvidenceBinding, EvidenceReport, ScopeReport } from './types.ts';

/**
 * Typed repositories over candidates, check_runs, evidence_reports and
 * failures. Status vocabularies are runtime arrays so other modules (the
 * knowledge extractor, the controller gates) import them instead of copying
 * strings. Every change that matters to a reader appends an event in the
 * same transaction. Functions nest inside a caller's `db.tx`.
 */

// ---------------------------------------------------------------------------
// vocabularies

/** CREATING: seq reserved and tree known, commit not yet written (crash-resumable). */
export const CANDIDATE_STATUSES = ['CREATING', 'READY', 'SUPERSEDED', 'INVALIDATED', 'DELIVERED'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** PLANNED: intent persisted, process not yet started. RUNNING: process exists. The rest are final. */
export const CHECK_RUN_STATUSES = ['PLANNED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR', 'TIMEOUT', 'CANCELLED'] as const;
export type CheckRunStatus = (typeof CHECK_RUN_STATUSES)[number];
export const FINAL_CHECK_STATUSES: readonly CheckStatus[] = ['PASSED', 'FAILED', 'ERROR', 'TIMEOUT', 'CANCELLED'];

export const EVIDENCE_VERDICTS = ['PASS', 'FAIL', 'INCOMPLETE'] as const;

export const FAILURE_SOURCES = ['check', 'flaky_check', 'baseline', 'install', 'ui', 'ci', 'review', 'worker'] as const;
export type FailureSource = (typeof FAILURE_SOURCES)[number];

export function isFinalCheckStatus(s: string): s is CheckStatus {
  return (FINAL_CHECK_STATUSES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// candidates

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  binaryFiles: number;
  /** Changed paths, capped so a huge change does not bloat the row. */
  paths: string[];
  truncated: boolean;
}

export interface CandidateRecord extends Candidate {
  workerId: string | null;
  status: CandidateStatus;
  diffStat: DiffStat | null;
  scope: ScopeReport | null;
  createdAt: number;
}

interface CandidateRow {
  id: string;
  run_id: string;
  seq: number;
  attempt: number;
  worker_id: string | null;
  commit_sha: string;
  tree_hash: string;
  parent_sha: string;
  status: string;
  diff_stat_json: string | null;
  scope_json: string | null;
  created_at: number;
}

function toCandidate(r: CandidateRow): CandidateRecord {
  return {
    id: r.id,
    runId: r.run_id,
    seq: r.seq,
    attempt: r.attempt,
    workerId: r.worker_id,
    commitSha: r.commit_sha,
    treeHash: r.tree_hash,
    parentSha: r.parent_sha,
    status: r.status as CandidateStatus,
    diffStat: r.diff_stat_json === null ? null : (JSON.parse(r.diff_stat_json) as DiffStat),
    scope: r.scope_json === null ? null : (JSON.parse(r.scope_json) as ScopeReport),
    createdAt: r.created_at,
  };
}

export interface NewCandidate {
  runId: string;
  attempt: number;
  workerId: string | null;
  treeHash: string;
  parentSha: string;
}

/**
 * Take the next seq for the run and persist the intent; the commit is filled
 * in by finalizeCandidate. The same tree in the same run is one candidate, so
 * the lookup and the insert share a transaction: two snapshots of identical
 * content cannot both reserve a seq.
 */
export function reserveCandidate(db: OrbitDb, input: NewCandidate, clock: Clock): CandidateRecord {
  const now = clock.now();
  return db.tx(() => {
    const existing = findCandidateByTree(db, input.runId, input.treeHash);
    if (existing) return existing;
    const next = db.get<{ n: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM candidates WHERE run_id = ?', input.runId)!.n;
    const id = newId('cand');
    db.run(
      `INSERT INTO candidates (id, run_id, seq, attempt, worker_id, commit_sha, tree_hash, parent_sha, status, created_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, 'CREATING', ?)`,
      id,
      input.runId,
      next,
      input.attempt,
      input.workerId,
      input.treeHash,
      input.parentSha,
      now,
    );
    return getCandidate(db, id);
  });
}

export function finalizeCandidate(db: OrbitDb, id: string, commitSha: string, diffStat: DiffStat, clock: Clock): CandidateRecord {
  const now = clock.now();
  return db.tx(() => {
    const cur = getCandidate(db, id);
    if (cur.status !== 'CREATING') return cur;
    db.run("UPDATE candidates SET commit_sha = ?, diff_stat_json = ?, status = 'READY' WHERE id = ?", commitSha, JSON.stringify(diffStat), id);
    appendEvent(db, cur.runId, 'candidate.created', 'controller', { candidate_id: id, seq: cur.seq, tree_hash: cur.treeHash, commit: commitSha, attempt: cur.attempt, worker_id: cur.workerId }, now);
    return getCandidate(db, id);
  });
}

export function getCandidate(db: OrbitDb, id: string): CandidateRecord {
  const row = db.get<CandidateRow>('SELECT * FROM candidates WHERE id = ?', id);
  if (!row) throw new OrbitError('NOT_FOUND', `no candidate ${id}`);
  return toCandidate(row);
}

export function findCandidateByTree(db: OrbitDb, runId: string, treeHash: string): CandidateRecord | null {
  const row = db.get<CandidateRow>('SELECT * FROM candidates WHERE run_id = ? AND tree_hash = ? ORDER BY seq LIMIT 1', runId, treeHash);
  return row ? toCandidate(row) : null;
}

export function findCandidateBySeq(db: OrbitDb, runId: string, seq: number): CandidateRecord | null {
  const row = db.get<CandidateRow>('SELECT * FROM candidates WHERE run_id = ? AND seq = ?', runId, seq);
  return row ? toCandidate(row) : null;
}

export function latestCandidate(db: OrbitDb, runId: string): CandidateRecord | null {
  const row = db.get<CandidateRow>("SELECT * FROM candidates WHERE run_id = ? AND status != 'CREATING' ORDER BY seq DESC LIMIT 1", runId);
  return row ? toCandidate(row) : null;
}

export function listCandidates(db: OrbitDb, runId: string): CandidateRecord[] {
  return db.all<CandidateRow>('SELECT * FROM candidates WHERE run_id = ? ORDER BY seq', runId).map(toCandidate);
}

export function setCandidateStatus(db: OrbitDb, id: string, status: CandidateStatus): void {
  db.run('UPDATE candidates SET status = ? WHERE id = ?', status, id);
}

export function setCandidateScope(db: OrbitDb, id: string, scope: ScopeReport): void {
  db.run('UPDATE candidates SET scope_json = ? WHERE id = ?', JSON.stringify(scope), id);
}

// ---------------------------------------------------------------------------
// check_runs

export interface CheckRunRecord {
  id: string;
  runId: string;
  /** null for baseline runs on the base revision. */
  candidateId: string | null;
  checkId: string;
  kind: 'command' | 'playwright';
  treeHash: string;
  checkConfigHash: string;
  policyHash: string;
  command: string[];
  cwd: string;
  isolation: string;
  status: CheckRunStatus;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  flaky: boolean;
  /** Id of the first attempt when this row is a flakiness rerun. */
  rerunOf: string | null;
  pid: number | null;
  logPath: string | null;
  logSha256: string | null;
  fingerprint: string | null;
  excerpt: string | null;
  artifacts: CheckResult['artifacts'];
  /** Limits the isolation provider reported for this run, kept in the artifacts column's sibling meta. */
  limitations: string[];
  startedAt: number;
  endedAt: number | null;
}

interface CheckRunRow {
  id: string;
  run_id: string;
  candidate_id: string | null;
  check_id: string;
  kind: string;
  tree_hash: string;
  check_config_hash: string;
  policy_hash: string;
  command_json: string;
  cwd: string;
  isolation: string;
  status: string;
  exit_code: number | null;
  timed_out: number;
  cancelled: number;
  flaky: number;
  rerun_of: string | null;
  pid: number | null;
  log_path: string | null;
  log_sha256: string | null;
  fingerprint: string | null;
  excerpt: string | null;
  artifacts_json: string | null;
  started_at: number;
  ended_at: number | null;
}

// artifacts_json holds {artifacts, limitations}: the table has no column for the isolation limitations, and they belong with the result.
interface ArtifactsBlob {
  artifacts: CheckResult['artifacts'];
  limitations: string[];
}

function toCheckRun(r: CheckRunRow): CheckRunRecord {
  const blob = r.artifacts_json === null ? { artifacts: [], limitations: [] } : (JSON.parse(r.artifacts_json) as ArtifactsBlob);
  return {
    id: r.id,
    runId: r.run_id,
    candidateId: r.candidate_id,
    checkId: r.check_id,
    kind: r.kind as 'command' | 'playwright',
    treeHash: r.tree_hash,
    checkConfigHash: r.check_config_hash,
    policyHash: r.policy_hash,
    command: JSON.parse(r.command_json) as string[],
    cwd: r.cwd,
    isolation: r.isolation,
    status: r.status as CheckRunStatus,
    exitCode: r.exit_code,
    timedOut: r.timed_out === 1,
    cancelled: r.cancelled === 1,
    flaky: r.flaky === 1,
    rerunOf: r.rerun_of,
    pid: r.pid,
    logPath: r.log_path,
    logSha256: r.log_sha256,
    fingerprint: r.fingerprint,
    excerpt: r.excerpt,
    artifacts: blob.artifacts ?? [],
    limitations: blob.limitations ?? [],
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export interface NewCheckRun {
  runId: string;
  candidateId: string | null;
  checkId: string;
  kind: 'command' | 'playwright';
  treeHash: string;
  checkConfigHash: string;
  policyHash: string;
  command: readonly string[];
  cwd: string;
  isolation: string;
  limitations: readonly string[];
  rerunOf?: string | null;
}

/** Persist the intent to run a check. Must commit before the process is started. */
export function planCheckRun(db: OrbitDb, input: NewCheckRun, clock: Clock): CheckRunRecord {
  const now = clock.now();
  return db.tx(() => {
    // New work for a cancelled or ended run is refused in the same transaction as the insert, like planWorker.
    const run = db.get<{ cancel_requested: number; state: string }>('SELECT cancel_requested, state FROM runs WHERE id = ?', input.runId);
    if (!run) throw new OrbitError('NOT_FOUND', `no run ${input.runId}`);
    if (run.cancel_requested === 1 || TERMINAL_STATES.has(run.state as RunState)) {
      throw new OrbitError('CANCELLED', `run ${input.runId} is ${run.cancel_requested === 1 ? 'cancelled' : run.state}; no new check starts`, { runId: input.runId, checkId: input.checkId });
    }
    const id = newId('chk');
    db.run(
      `INSERT INTO check_runs (id, run_id, candidate_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, rerun_of, artifacts_json, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?, ?)`,
      id,
      input.runId,
      input.candidateId,
      input.checkId,
      input.kind,
      input.treeHash,
      input.checkConfigHash,
      input.policyHash,
      JSON.stringify(input.command),
      input.cwd,
      input.isolation,
      input.rerunOf ?? null,
      JSON.stringify({ artifacts: [], limitations: [...input.limitations] } satisfies ArtifactsBlob),
      now,
    );
    appendEvent(db, input.runId, 'check.planned', 'controller', { check_run_id: id, check_id: input.checkId, candidate_id: input.candidateId, rerun_of: input.rerunOf ?? null }, now);
    return getCheckRun(db, id);
  });
}

export function markCheckRunning(db: OrbitDb, id: string, pid: number, clock: Clock): CheckRunRecord {
  const now = clock.now();
  return db.tx(() => {
    const cur = getCheckRun(db, id);
    if (cur.status !== 'PLANNED' && cur.status !== 'RUNNING') return cur;
    db.run("UPDATE check_runs SET status = 'RUNNING', pid = ?, started_at = ? WHERE id = ?", pid, cur.status === 'PLANNED' ? now : cur.startedAt, id);
    appendEvent(db, cur.runId, 'check.started', 'controller', { check_run_id: id, check_id: cur.checkId, pid }, now);
    return getCheckRun(db, id);
  });
}

export interface FinishedCheck {
  status: CheckStatus;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  logPath: string | null;
  logSha256: string | null;
  fingerprint: string | null;
  excerpt: string | null;
  artifacts: CheckResult['artifacts'];
  endedAt: number;
}

/** Record the final outcome. A row that is already final is left alone: finishing is idempotent across a reattach race. */
export function finishCheckRun(db: OrbitDb, id: string, f: FinishedCheck): CheckRunRecord {
  return db.tx(() => {
    const cur = getCheckRun(db, id);
    if (isFinalCheckStatus(cur.status)) return cur;
    db.run(
      `UPDATE check_runs SET status = ?, exit_code = ?, timed_out = ?, cancelled = ?, log_path = ?, log_sha256 = ?, fingerprint = ?, excerpt = ?, artifacts_json = ?, ended_at = ? WHERE id = ?`,
      f.status,
      f.exitCode,
      f.timedOut ? 1 : 0,
      f.cancelled ? 1 : 0,
      f.logPath,
      f.logSha256,
      f.fingerprint,
      f.excerpt,
      JSON.stringify({ artifacts: f.artifacts, limitations: cur.limitations } satisfies ArtifactsBlob),
      f.endedAt,
      id,
    );
    appendEvent(db, cur.runId, 'check.finished', 'controller', { check_run_id: id, check_id: cur.checkId, status: f.status, exit_code: f.exitCode, fingerprint: f.fingerprint }, f.endedAt);
    return getCheckRun(db, id);
  });
}

export function setCheckFlaky(db: OrbitDb, id: string, flaky: boolean): void {
  db.run('UPDATE check_runs SET flaky = ? WHERE id = ?', flaky ? 1 : 0, id);
}

export function getCheckRun(db: OrbitDb, id: string): CheckRunRecord {
  const row = db.get<CheckRunRow>('SELECT * FROM check_runs WHERE id = ?', id);
  if (!row) throw new OrbitError('NOT_FOUND', `no check run ${id}`);
  return toCheckRun(row);
}

export interface CheckRunQuery {
  runId: string;
  /** undefined: any; null: baseline rows only. */
  candidateId?: string | null;
  checkId?: string;
  /** Only first attempts (not flakiness reruns). */
  rootsOnly?: boolean;
}

export function listCheckRuns(db: OrbitDb, q: CheckRunQuery): CheckRunRecord[] {
  const where = ['run_id = ?'];
  const params: (string | number)[] = [q.runId];
  if (q.candidateId === null) where.push('candidate_id IS NULL');
  else if (q.candidateId !== undefined) {
    where.push('candidate_id = ?');
    params.push(q.candidateId);
  }
  if (q.checkId !== undefined) {
    where.push('check_id = ?');
    params.push(q.checkId);
  }
  if (q.rootsOnly) where.push('rerun_of IS NULL');
  return db.all<CheckRunRow>(`SELECT * FROM check_runs WHERE ${where.join(' AND ')} ORDER BY rowid`, ...params).map(toCheckRun);
}

export function checkRunToResult(r: CheckRunRecord, binding: EvidenceBinding): CheckResult {
  if (!isFinalCheckStatus(r.status)) throw new OrbitError('INTERNAL', `check run ${r.id} is ${r.status}, not final`);
  return {
    id: r.id,
    checkId: r.checkId,
    kind: r.kind,
    binding,
    command: r.command,
    cwd: r.cwd,
    isolation: r.isolation,
    isolationLimitations: r.limitations,
    startedAt: r.startedAt,
    endedAt: r.endedAt ?? r.startedAt,
    exitCode: r.exitCode,
    status: r.status,
    timedOut: r.timedOut,
    cancelled: r.cancelled,
    flaky: r.flaky,
    logPath: r.logPath ?? '',
    logSha256: r.logSha256 ?? '',
    fingerprint: r.fingerprint,
    excerpt: r.excerpt,
    artifacts: r.artifacts,
  };
}

// ---------------------------------------------------------------------------
// evidence_reports

export interface EvidenceReportRecord {
  id: string;
  runId: string;
  candidateId: string;
  treeHash: string;
  checkConfigHash: string;
  policyHash: string;
  verdict: EvidenceReport['verdict'];
  report: EvidenceReport;
  reportPath: string | null;
  createdAt: number;
  invalidatedAt: number | null;
  invalidatedReason: string | null;
}

interface ReportRow {
  id: string;
  run_id: string;
  candidate_id: string;
  tree_hash: string;
  check_config_hash: string;
  policy_hash: string;
  verdict: string;
  report_json: string;
  report_path: string | null;
  created_at: number;
  invalidated_at: number | null;
  invalidated_reason: string | null;
}

function toReport(r: ReportRow): EvidenceReportRecord {
  return {
    id: r.id,
    runId: r.run_id,
    candidateId: r.candidate_id,
    treeHash: r.tree_hash,
    checkConfigHash: r.check_config_hash,
    policyHash: r.policy_hash,
    verdict: r.verdict as EvidenceReport['verdict'],
    report: JSON.parse(r.report_json) as EvidenceReport,
    reportPath: r.report_path,
    createdAt: r.created_at,
    invalidatedAt: r.invalidated_at,
    invalidatedReason: r.invalidated_reason,
  };
}

export function insertEvidenceReport(db: OrbitDb, input: { candidateId: string; report: EvidenceReport; reportPath: string | null }, clock: Clock): EvidenceReportRecord {
  const now = clock.now();
  const { report } = input;
  return db.tx(() => {
    const id = newId('evr');
    db.run(
      `INSERT INTO evidence_reports (id, run_id, candidate_id, tree_hash, check_config_hash, policy_hash, verdict, report_json, report_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      report.run_id,
      input.candidateId,
      report.tree_hash,
      report.check_config_hash,
      report.policy_hash,
      report.verdict,
      JSON.stringify(report),
      input.reportPath,
      now,
    );
    appendEvent(db, report.run_id, 'evidence.report', 'controller', { report_id: id, candidate_id: input.candidateId, tree_hash: report.tree_hash, verdict: report.verdict, unverified: report.unverified.length }, now);
    return getEvidenceReport(db, id);
  });
}

export function getEvidenceReport(db: OrbitDb, id: string): EvidenceReportRecord {
  const row = db.get<ReportRow>('SELECT * FROM evidence_reports WHERE id = ?', id);
  if (!row) throw new OrbitError('NOT_FOUND', `no evidence report ${id}`);
  return toReport(row);
}

/** Newest report for the candidate that has not been invalidated, or null. */
export function currentEvidenceReport(db: OrbitDb, runId: string, candidateId: string): EvidenceReportRecord | null {
  const row = db.get<ReportRow>(
    'SELECT * FROM evidence_reports WHERE run_id = ? AND candidate_id = ? AND invalidated_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1',
    runId,
    candidateId,
  );
  return row ? toReport(row) : null;
}

export function listEvidenceReports(db: OrbitDb, runId: string): EvidenceReportRecord[] {
  return db.all<ReportRow>('SELECT * FROM evidence_reports WHERE run_id = ? ORDER BY created_at, rowid', runId).map(toReport);
}

// ---------------------------------------------------------------------------
// failures

export interface FailureRecord {
  id: number;
  runId: string;
  candidateId: string | null;
  source: FailureSource;
  sourceId: string | null;
  fingerprint: string;
  excerpt: string | null;
  createdAt: number;
}

interface FailureRow {
  id: number;
  run_id: string;
  candidate_id: string | null;
  source: string;
  source_id: string | null;
  fingerprint: string;
  excerpt: string | null;
  created_at: number;
}

function toFailure(r: FailureRow): FailureRecord {
  return {
    id: r.id,
    runId: r.run_id,
    candidateId: r.candidate_id,
    source: r.source as FailureSource,
    sourceId: r.source_id,
    fingerprint: r.fingerprint,
    excerpt: r.excerpt,
    createdAt: r.created_at,
  };
}

/** Idempotent per (source, source_id): recording the same failing check run twice keeps one row. */
export function recordFailure(
  db: OrbitDb,
  input: { runId: string; candidateId: string | null; source: FailureSource; sourceId: string | null; fingerprint: string; excerpt: string | null },
  clock: Clock,
): FailureRecord {
  return db.tx(() => {
    if (input.sourceId !== null) {
      const existing = db.get<FailureRow>('SELECT * FROM failures WHERE run_id = ? AND source = ? AND source_id = ?', input.runId, input.source, input.sourceId);
      if (existing) return toFailure(existing);
    }
    const r = db.run(
      'INSERT INTO failures (run_id, candidate_id, source, source_id, fingerprint, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.runId,
      input.candidateId,
      input.source,
      input.sourceId,
      input.fingerprint,
      input.excerpt,
      clock.now(),
    );
    return toFailure(db.get<FailureRow>('SELECT * FROM failures WHERE id = ?', r.lastInsertRowid)!);
  });
}

export function listFailures(db: OrbitDb, runId: string, fingerprint?: string): FailureRecord[] {
  return fingerprint === undefined
    ? db.all<FailureRow>('SELECT * FROM failures WHERE run_id = ? ORDER BY id', runId).map(toFailure)
    : db.all<FailureRow>('SELECT * FROM failures WHERE run_id = ? AND fingerprint = ? ORDER BY id', runId, fingerprint).map(toFailure);
}
