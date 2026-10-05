/**
 * An environment failure is not repaired (spec section 14: diagnose, do not blindly retry). When a mandatory check
 * fails on a candidate exactly as it failed on the base revision and its output shows the sandbox or the host
 * refusing an operation (evidence/environment-failure.ts), the verification step ends the run BLOCKED instead of
 * entering the repair loop: no change to the code can fix it, and each attempt would only rebuild the same tree.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonIfExists } from '../core/fsx.ts';
import { BASELINE_FILE, type BaselineReport } from '../evidence/baseline.ts';
import { classifyEnvironmentFailure, type EnvironmentFailure } from '../evidence/environment-failure.ts';
import { listCheckRuns, type CandidateRecord, type CheckRunRecord } from '../evidence/store.ts';
import type { EvidenceReport } from '../evidence/types.ts';
import { baselineQuestionId } from '../inquisition/baseline-exception.ts';
import { runWorktreeRoot, type RunContext } from './context.ts';

/** Output read from a check's log at most, so a runaway log stays cheap. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;

export type BlockedCheck = EnvironmentFailure & {
  /** The baseline-exception question PREFLIGHT raised for this check's pre-existing failure. */
  questionId: string;
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
 * The outcome reason: which check, what environment cause, that no repair was spent, and the two ways forward. The
 * policy (so the check definition) and the recorded check results of a run are frozen, so a repaired environment or a
 * corrected definition applies to a new run; the baseline exception is the existing PREFLIGHT question, and an
 * approved one is honoured when this run resumes.
 */
export function environmentBlockReason(input: { runId: string; candidateSeq: number; failures: readonly BlockedCheck[] }): string {
  const { runId, candidateSeq, failures } = input;
  const many = failures.length > 1;
  const names = failures.map((f) => f.checkId).join(', ');
  const causes = failures.map((f) => `${f.checkId}: ${f.cause}${f.lines[0] ? ` (${JSON.stringify(f.lines[0])})` : ''}`).join('; ');
  const answers = failures.map((f) => `orbit decide ${runId} ${f.questionId} Approve`).join(' and ');
  return [
    `${many ? 'checks' : 'check'} ${names} ${many ? 'fail' : 'fails'} on candidate ${candidateSeq} exactly as on the base revision, and the output shows an environment cause, not a defect in the change: ${causes}`,
    'no repair attempt was spent, because changing the code cannot fix it',
    `two ways forward: fix the environment or the check definition and start a new run (this run's policy and recorded check results are frozen), or approve a baseline exception for the pre-existing failure with ${answers}, then orbit resume ${runId}`,
  ].join('. ');
}
