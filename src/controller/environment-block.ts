/**
 * An environment failure is not repaired (spec section 14: diagnose, do not blindly retry). When a mandatory check
 * fails on a candidate exactly as it failed on the base revision and its output shows the sandbox or the host
 * refusing an operation (evidence/environment-failure.ts), the verification step ends the run BLOCKED instead of
 * entering the repair loop: no change to the code can fix it, and each attempt would only rebuild the same tree.
 *
 * So does a mandatory check that could not execute at all: the UI application or a check's process was killed by a
 * crash signal before it printed anything, or the runner could not start the check. Nothing of the repository ran,
 * so there is no failure for a repair to address, and the run would only come back to the same tree.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { readJsonIfExists } from '../core/fsx.ts';
import { BASELINE_FILE, type BaselineReport } from '../evidence/baseline.ts';
import { classifyEnvironmentFailure, classifyNotExecuted, type EnvironmentFailure } from '../evidence/environment-failure.ts';
import { listCheckRuns, type CandidateRecord, type CheckRunRecord } from '../evidence/store.ts';
import type { EvidenceReport } from '../evidence/types.ts';
import { baselineQuestionId } from '../inquisition/baseline-exception.ts';
import { UI_RESULT_FILE } from '../ui/runner.ts';
import type { UiNotExecuted } from '../ui/types.ts';
import { runWorktreeRoot, type RunContext } from './context.ts';
import { uiEvidenceDir } from './verification.ts';

/** Output read from a check's log at most, so a runaway log stays cheap. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;

export type BlockedCheck = EnvironmentFailure & {
  /** The baseline-exception question PREFLIGHT raised for this check's pre-existing failure; null for a check that could not execute (there is no failure to except). */
  questionId: string | null;
  /** The log that shows the cause, when there is one. */
  logPath?: string;
};

function outputOf(row: CheckRunRecord): string {
  if (row.logPath) {
    try {
      return readFileSync(row.logPath, 'utf8').slice(0, MAX_LOG_BYTES);
    } catch {
      /* the log is gone: the excerpt is what is left of it */
    }
  }
  return row.excerpt ?? '';
}

/**
 * The failing checks of `report` that fail on the candidate as on the base revision and for an environment cause,
 * leaving out any the contract already accepts as a baseline exception (that failure is excused, not blocking).
 */
export function environmentFailuresFor(ctx: RunContext, cand: CandidateRecord, report: EvidenceReport): BlockedCheck[] {
  const baseline = readJsonIfExists<BaselineReport>(join(ctx.runDir, BASELINE_FILE));
  // A baseline of another revision (the base moved) says nothing about this candidate's base.
  if (!baseline || baseline.baseRevision !== ctx.run.baseRevision) return [];
  const accepted = new Map((ctx.contract?.baseline_exceptions ?? []).map((e) => [e.check_id, e.fingerprint]));
  const checkout = join(runWorktreeRoot(ctx), `check-${cand.seq}`);
  const out: BlockedCheck[] = [];
  for (const base of baseline.failures) {
    const result = report.checks.find((c) => c.id === base.checkId);
    if (!result || (result.status !== 'FAILED' && result.status !== 'TIMEOUT')) continue;
    const row = listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: cand.id, checkId: base.checkId, rootsOnly: true }).at(-1);
    if (!row || row.fingerprint === null || accepted.get(base.checkId) === row.fingerprint) continue;
    const found = classifyEnvironmentFailure({
      checkId: base.checkId,
      fingerprint: row.fingerprint,
      baselineFingerprint: base.fingerprint,
      output: outputOf(row),
      // The checkout (the check's cwd is resolved, the checkout path may not be) and the evidence directory holding its scratch HOME.
      insideRoots: [checkout, row.cwd, ...(row.logPath ? [dirname(row.logPath)] : [])],
    });
    if (found) out.push({ ...found, questionId: baselineQuestionId(ctx.run.id, base.checkId, row.fingerprint) });
  }
  return out;
}

/**
 * The outcome reason: which check, what environment cause, that no repair was spent, and the ways forward. The
 * policy (so the check definition) and the recorded check results of a run are frozen, so a repaired environment or a
 * corrected definition applies to a new run. For a check that failed like the base revision the baseline exception is
 * the existing PREFLIGHT question, and an approved one is honoured when this run resumes; a check that could not
 * execute has no failure to except, so only the first way forward applies to it.
 */
export function environmentBlockReason(input: { runId: string; candidateSeq: number; failures: readonly BlockedCheck[] }): string {
  const { runId, candidateSeq, failures } = input;
  const named = (fs: readonly BlockedCheck[]): string => `${fs.length > 1 ? 'checks' : 'check'} ${fs.map((f) => f.checkId).join(', ')}`;
  const sameAsBase = failures.filter((f) => f.fingerprint !== null);
  const notExecuted = failures.filter((f) => f.fingerprint === null);
  const sentences: string[] = [];
  if (sameAsBase.length > 0) {
    const causes = sameAsBase.map((f) => `${f.checkId}: ${f.cause}${f.lines[0] ? ` (${JSON.stringify(f.lines[0])})` : ''}`).join('; ');
    sentences.push(`${named(sameAsBase)} ${sameAsBase.length > 1 ? 'fail' : 'fails'} on candidate ${candidateSeq} exactly as on the base revision, and the output shows an environment cause, not a defect in the change: ${causes}`);
  }
  if (notExecuted.length > 0) {
    const causes = notExecuted.map((f) => `${f.checkId}: ${f.cause}${f.lines.length > 0 ? ` (${f.lines.map((l) => JSON.stringify(l)).join(', ')})` : ''}${f.logPath ? `, output in ${f.logPath}` : ''}`).join('; ');
    sentences.push(`${named(notExecuted)} could not execute on candidate ${candidateSeq}, and the output shows an environment cause, not a defect in the change: ${causes}`);
  }
  sentences.push('no repair attempt was spent, because changing the code cannot fix it');
  const answers = failures.filter((f) => f.questionId !== null).map((f) => `orbit decide ${runId} ${f.questionId} Approve`);
  const frozen = "this run's policy and recorded check results are frozen";
  if (answers.length > 0) {
    sentences.push(`two ways forward: fix the environment or the check definition and start a new run (${frozen}), or approve a baseline exception for the pre-existing failure with ${answers.join(' and ')}, then orbit resume ${runId}`);
  } else {
    sentences.push(`way forward: fix the environment (orbit doctor checks the isolation provider and its limits) or the check definition and start a new run (${frozen}); there is no baseline exception to approve, because the check never ran`);
  }
  return sentences.join('. ');
}

/** Check ids that must pass for this candidate: the contract's list plus every command check the policy marks mandatory. */
function mandatoryCommandChecks(ctx: RunContext): Set<string> {
  const ids = new Set(ctx.contract?.required_check_ids ?? []);
  for (const [id, def] of Object.entries(ctx.snapshot.config.checks)) if (def.mandatory && def.kind === 'command') ids.add(id);
  return ids;
}

function readCapped(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').slice(0, MAX_LOG_BYTES);
  } catch {
    return null;
  }
}

/** Whether `path` is below `dir`, spelled either as given or as the real path the UI runner records (macOS temp directories sit behind a symlink). */
function isInside(path: string, dir: string): boolean {
  const roots = [dir];
  try {
    roots.push(realpathSync(dir));
  } catch {
    /* the directory is gone: only the given spelling can match */
  }
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
}

/**
 * The mandatory checks of `report` that could not execute at all, for an environment cause: a command check whose
 * process was killed by a crash signal before it printed anything, or that the runner could not start, and the UI
 * run when the application (or a journey check's Playwright process) never got as far as running the repository's
 * code. A check that ran and failed, or an application that threw while loading, is not listed: its output is the
 * repository's own and a repair can address it. Needs no baseline: nothing of the repository ran.
 */
export function checksNotExecutedFor(ctx: RunContext, cand: CandidateRecord, report: EvidenceReport): BlockedCheck[] {
  const out: BlockedCheck[] = [];
  const accepted = new Map((ctx.contract?.baseline_exceptions ?? []).map((e) => [e.check_id, e.fingerprint]));
  const mandatory = mandatoryCommandChecks(ctx);
  for (const result of report.checks) {
    if (!mandatory.has(result.id) || (result.status !== 'FAILED' && result.status !== 'ERROR')) continue;
    const row = listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: cand.id, checkId: result.id, rootsOnly: true }).at(-1);
    if (!row || (row.fingerprint !== null && accepted.get(result.id) === row.fingerprint)) continue;
    const output = outputOf(row);
    const startFailure = row.status === 'ERROR' ? /could not start the check:[^\n]*/.exec(output)?.[0] ?? null : null;
    const found = classifyNotExecuted({ checkId: result.id, output, startFailure });
    if (found) out.push({ ...found, questionId: null, ...(row.logPath ? { logPath: row.logPath } : {}) });
  }

  if (report.ui.some((u) => u.status === 'ERROR')) {
    const dir = uiEvidenceDir(ctx.runDir, cand.seq);
    const uiIds = ctx.snapshot.config.ui?.journey_check_ids ?? [];
    for (const entry of uiNotExecuted(join(dir, UI_RESULT_FILE))) {
      const logPath = isAbsolute(entry.logPath) && isInside(entry.logPath, dir) ? entry.logPath : null;
      const checkId = entry.stage === 'journeys' && entry.checkId ? entry.checkId : uiIds.length > 0 ? uiIds.join(', ') : 'ui';
      const output = logPath === null ? null : readCapped(logPath);
      const browserIsolation = typeof entry.environment === 'string' ? entry.environment : null;
      const found = output === null ? null : classifyNotExecuted({ checkId, output, signal: entry.signal, browserIsolation });
      if (found && !out.some((o) => o.checkId === found.checkId)) out.push({ ...found, questionId: null, ...(logPath ? { logPath } : {}) });
    }
  }
  return out;
}

/** What the UI run recorded as never having got as far as running; empty for a result that is missing or unreadable. */
function uiNotExecuted(resultPath: string): UiNotExecuted[] {
  const text = readCapped(resultPath);
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text) as { notExecuted?: unknown };
    if (!Array.isArray(parsed.notExecuted)) return [];
    return parsed.notExecuted.filter(
      (e): e is UiNotExecuted =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as UiNotExecuted).logPath === 'string' &&
        ((e as UiNotExecuted).stage === 'application' || (e as UiNotExecuted).stage === 'journeys') &&
        ((e as UiNotExecuted).environment === undefined || typeof (e as UiNotExecuted).environment === 'string'),
    );
  } catch {
    return [];
  }
}
