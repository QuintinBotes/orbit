/**
 * A verified candidate is always offered, even when the run stops (issue #169). A run that would end EXHAUSTED while it
 * holds a candidate that passed verification, and that was not delivered, ends BLOCKED instead and names that candidate:
 * its commit and ref, the checks it passed, and every review finding still open with its status, with one command that
 * delivers it as a draft pull request and one that discards it. The work was done and paid for; one of the run's own
 * limits stopped it, and a person decides whether the open findings matter. Orbit never delivers such a candidate
 * itself: nothing after the block takes an external action, whatever the mode.
 *
 * The candidate is recorded in the run's outcome (`verified_candidate`, beside `decided: 'EXHAUSTED'`), so the report,
 * `orbit status`, the CLI and a notification read the same record, and the failure class stays the one the EXHAUSTED end
 * would have had (failure-class.ts).
 */
import { join } from 'node:path';
import { atomicWrite } from '../core/fsx.ts';
import { redact } from '../core/redact.ts';
import { clipAtWord } from '../core/text.ts';
import { candidateRef } from '../evidence/candidate.ts';
import { currentEvidenceReport, listCandidates } from '../evidence/store.ts';
import { listFindings, listReviews } from '../review/store.ts';
import type { GoalContract } from '../contract/types.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import type { OrbitDb } from '../storage/db.ts';
import type { RunRecord } from './run-store.ts';

/** The pull request body the delivery command sends, in the run directory. */
export const VERIFIED_CANDIDATE_BODY = 'verified-candidate.md';

/** Finding statuses a person still has to weigh: the unresolved ones, and advisory warnings nobody confirmed or refuted. */
const OPEN_STATUSES = ['open', 'claim_pending', 'accepted', 'advisory'] as const;

export interface OpenFinding {
  id: string;
  /** The round of the review that raised it; null for a finding whose review is gone. */
  review_round: number | null;
  severity: string;
  status: string;
  claim: string;
}

export interface VerifiedCandidate {
  candidate_id: string;
  seq: number;
  commit: string;
  tree: string;
  /** Where the commit is pinned in the repository: refs/orbit/<run>/candidates/<seq>. */
  ref: string;
  evidence_report: string;
  checks_passed: string[];
  open_findings: OpenFinding[];
  /** The branch the delivery command pushes the commit to. */
  branch: string;
  /** Run from the repository root: push the commit, then open a draft pull request whose body lists the open findings. */
  deliver_command: string;
  discard_command: string;
}

/**
 * The candidate a run that runs out now offers: the newest one whose standing evidence passed verification. Null when no
 * candidate passed, when its evidence was invalidated, or when the run delivered any candidate: it has its pull request,
 * and what stopped the run is the CI that judged it there. A later candidate (a CI repair) is not offered either: its
 * parent is the base, not the delivery commit at the tip of the run's branch, so the push would be rejected.
 */
export function findVerifiedCandidate(db: OrbitDb, run: Pick<RunRecord, 'id' | 'branch'>, snapshot: PolicySnapshot): VerifiedCandidate | null {
  const candidates = listCandidates(db, run.id);
  if (candidates.some((c) => c.status === 'DELIVERED')) return null;
  for (const cand of candidates.reverse()) {
    const ev = currentEvidenceReport(db, run.id, cand.id);
    if (ev?.verdict !== 'PASS') continue;
    const rounds = new Map(listReviews(db, run.id, { includeInvalidated: true }).map((r) => [r.id, r.round] as const));
    const open = listFindings(db, run.id, { statuses: OPEN_STATUSES }).map((f) => ({ id: f.externalId ?? f.id, review_round: rounds.get(f.reviewId) ?? null, severity: f.severity, status: f.status, claim: clipAtWord(f.claim, 300) }));
    const { remote, base_branch: base, branch_prefix: prefix } = snapshot.config.repository;
    const branch = run.branch ?? `${prefix}${run.id}`;
    const body = `.orbit/runs/${run.id}/${VERIFIED_CANDIDATE_BODY}`;
    return {
      candidate_id: cand.id,
      seq: cand.seq,
      commit: cand.commitSha,
      tree: cand.treeHash,
      ref: candidateRef(run.id, cand.seq),
      evidence_report: ev.id,
      checks_passed: ev.report.checks.filter((c) => c.status === 'PASSED').map((c) => c.id),
      open_findings: open,
      branch,
      deliver_command: `git push ${remote} ${cand.commitSha}:refs/heads/${branch} && gh pr create --draft --base ${base} --head ${branch} --title "Orbit run ${run.id}: verified candidate ${cand.seq}" --body-file ${body}`,
      discard_command: `orbit cancel ${run.id}`,
    };
  }
  return null;
}

const findingLine = (f: OpenFinding): string => `${f.id} (${f.review_round === null ? '' : `review ${f.review_round}, `}${f.severity}, ${f.status})`;

/** What the run holds, as the sentence the outcome reason gains. */
export function heldSentence(vc: VerifiedCandidate): string {
  // At most five by name, so the sentence and the advice after it stay whole on the run row (common.ts cappedReason).
  const named = vc.open_findings.slice(0, 5).map(findingLine).join(', ');
  const more = vc.open_findings.length > 5 ? ` and ${vc.open_findings.length - 5} more (orbit report lists every one)` : '';
  const findings = vc.open_findings.length === 0 ? 'no open review finding' : `${vc.open_findings.length} open review finding(s): ${named}${more}`;
  return `The run holds a verified candidate: candidate ${vc.seq} (commit ${vc.commit.slice(0, 12)}, ref ${vc.ref}) passed verification (checks ${vc.checks_passed.join(', ') || 'none'}), with ${findings}.`;
}

/** The report's section on it (final.md). */
export function offerSection(vc: VerifiedCandidate): string[] {
  return [
    `Candidate ${vc.seq} (commit ${vc.commit}, ref ${vc.ref}) passed verification (evidence report ${vc.evidence_report}) and was not delivered.`,
    '',
    `- checks passed: ${vc.checks_passed.join(', ') || 'none'}`,
    ...(vc.open_findings.length === 0 ? ['- open findings: none'] : vc.open_findings.map((f) => `- open finding ${findingLine(f)}: ${f.claim}`)),
    `- deliver it as a draft pull request (from the repository root): ${vc.deliver_command}`,
    `- discard it: ${vc.discard_command}`,
  ];
}

/** The way forward, which ends the outcome reason: deliver it or discard it. */
export function offerAdvice(vc: VerifiedCandidate): string {
  return `Deliver it or discard it: to open a draft pull request that lists its open findings, run from the repository root ${vc.deliver_command}; to discard it, run ${vc.discard_command}. Resuming would continue the run under the limits that stopped it.`;
}

/**
 * The pull request body the delivery command names: the objective, why the run stopped, the checks the candidate passed,
 * and every open finding with its status. Redacted as Orbit's own pull request body is.
 */
export function writeOfferBody(runDir: string, runId: string, vc: VerifiedCandidate, contract: Pick<GoalContract, 'objective'> | null, stopped: string): void {
  const lines = [
    contract ? `Orbit run ${runId}: ${contract.objective}` : `Orbit run ${runId}`,
    '',
    `Candidate ${vc.seq} (commit ${vc.commit}) passed verification, then the run stopped before delivery: ${clipAtWord(stopped, 300)}`,
    'No review approved it: a person chose to deliver it with its open findings.',
    '',
    `Checks passed: ${vc.checks_passed.join(', ') || 'none'}`,
    '',
    'Open review findings:',
    ...(vc.open_findings.length === 0 ? ['- none'] : vc.open_findings.map((f) => `- ${findingLine(f)}: ${f.claim}`)),
  ];
  atomicWrite(join(runDir, VERIFIED_CANDIDATE_BODY), `${redact(lines.join('\n'))}\n`);
}

/** The verified candidate a BLOCKED run holds, as finishRun recorded it; null for every other run and an unreadable record. */
export function heldVerifiedCandidate(run: Pick<RunRecord, 'state' | 'outcomeJson'>): VerifiedCandidate | null {
  if (run.state !== 'BLOCKED' || !run.outcomeJson) return null;
  try {
    const o = JSON.parse(run.outcomeJson) as { verified_candidate?: unknown };
    const vc = o.verified_candidate;
    return vc !== null && typeof vc === 'object' && typeof (vc as { seq?: unknown }).seq === 'number' ? (vc as VerifiedCandidate) : null;
  } catch {
    return null;
  }
}
