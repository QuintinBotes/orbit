/**
 * A verified candidate is always offered, even when the run stops (issue #169). A run that would end EXHAUSTED while it
 * holds a candidate that passed verification, and that was not delivered, ends BLOCKED instead and names that candidate:
 * its commit and ref, the checks it passed, and every review finding still open with its status, with one command that
 * delivers it as a draft pull request and one that discards it. The work was done and paid for; one of the run's own
 * limits stopped it, and a person decides whether the open findings matter. A run that stops BLOCKED for any other reason
 * while it holds one offers it the same way, beside the block's own way forward (`decided: 'BLOCKED'`). Orbit never
 * delivers such a candidate itself: nothing after the block takes an external action, whatever the mode.
 *
 * The candidate is recorded in the run's outcome (`verified_candidate`, beside `decided: 'EXHAUSTED'`), so the report,
 * `orbit status`, the CLI and a notification read the same record, and the failure class stays the one the EXHAUSTED end
 * would have had (failure-class.ts).
 */
import { join } from 'node:path';
import { OrbitError, isOrbitError } from '../core/errors.ts';
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
  /** The APPROVE review of its tree, when one approved it before the run stopped; absent in older records. */
  approved_by?: string | null;
  /** Run from the repository root: push the commit, then open a draft pull request whose body lists the open findings. */
  deliver_command: string;
  discard_command: string;
}

/**
 * A value as one shell word: as it is when it holds only characters a shell leaves alone, else single-quoted. A value
 * with a leading '-' is refused: quoted or not, a command reads it as an option.
 */
export function shellWord(v: string): string {
  if (v.startsWith('-')) throw new OrbitError('CONFIG_INVALID', `"${v}" starts with '-', so a command would read it as an option`);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** The pull request title as one shell word: double-quoted for a run id of plain characters, else single-quoted. */
function title(runId: string, seq: number): string {
  const t = `Orbit run ${runId}: verified candidate ${seq}`;
  return /^[A-Za-z0-9_.-]+$/.test(runId) ? `"${t}"` : shellWord(t);
}

/**
 * The candidate a run that runs out now offers: the newest one whose standing evidence passed verification. Null when no
 * candidate passed, when its evidence was invalidated, or when the run delivered any candidate: it has its pull request,
 * and what stopped the run is the CI that judged it there. A later candidate (a CI repair) is not offered either: its
 * parent is the base, not the delivery commit at the tip of the run's branch, so the push would be rejected. Nor is one
 * once the run pushed its delivery commit, whatever failed after the push: the branch holds that commit, which the
 * candidate commit does not fast-forward.
 */
export function findVerifiedCandidate(db: OrbitDb, run: Pick<RunRecord, 'id' | 'branch'>, snapshot: PolicySnapshot): VerifiedCandidate | null {
  const candidates = listCandidates(db, run.id);
  if (candidates.some((c) => c.status === 'DELIVERED')) return null;
  if (db.get("SELECT 1 AS x FROM actions WHERE run_id = ? AND kind = 'push' AND state = 'SUCCEEDED'", run.id)) return null;
  for (const cand of candidates.reverse()) {
    const ev = currentEvidenceReport(db, run.id, cand.id);
    if (ev?.verdict !== 'PASS') continue;
    const reviews = listReviews(db, run.id, { includeInvalidated: true });
    const rounds = new Map(reviews.map((r) => [r.id, r.round] as const));
    const open = listFindings(db, run.id, { statuses: OPEN_STATUSES }).map((f) => ({ id: f.externalId ?? f.id, review_round: rounds.get(f.reviewId) ?? null, severity: f.severity, status: f.status, claim: clipAtWord(f.claim, 300) }));
    const approved = reviews.find((r) => r.treeHash === cand.treeHash && r.verdict === 'APPROVE' && r.invalidatedAt === null) ?? null;
    // Every value from the policy is one shell word in the commands a person runs, so none can start a second command,
    // and none is an option: git push reads its arguments after `--`, and a value with a leading '-' offers nothing.
    const { remote, base_branch: base, branch_prefix: prefix } = snapshot.config.repository;
    const branch = run.branch ?? `${prefix}${run.id}`;
    const body = `.orbit/runs/${run.id}/${VERIFIED_CANDIDATE_BODY}`;
    let deliver: string;
    try {
      deliver = `git push -- ${shellWord(remote)} ${shellWord(`${cand.commitSha}:refs/heads/${branch}`)} && gh pr create --draft --base ${shellWord(base)} --head ${shellWord(branch)} --title ${title(run.id, cand.seq)} --body-file ${shellWord(body)}`;
    } catch (err) {
      if (isOrbitError(err, 'CONFIG_INVALID')) return null;
      throw err;
    }
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
      approved_by: approved?.id ?? null,
      deliver_command: deliver,
      discard_command: `orbit cancel ${shellWord(run.id)}`,
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

/**
 * The way forward, which ends the outcome reason: deliver it or discard it. A run that ran out (`exhausted`) would only
 * continue under the limits that stopped it; a block keeps its own way forward, and the offer stands beside it.
 */
export function offerAdvice(vc: VerifiedCandidate, exhausted = true): string {
  const commands = `to open a draft pull request that lists its open findings, run from the repository root ${vc.deliver_command}; to discard it, run ${vc.discard_command}.`;
  return exhausted ? `Deliver it or discard it: ${commands} Resuming would continue the run under the limits that stopped it.` : `Instead of clearing the block, you can deliver it or discard it: ${commands}`;
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
    vc.approved_by ? `Review ${vc.approved_by} approved its tree; Orbit did not deliver it, and a person chose to deliver it with any open findings below.` : 'No review approved it: a person chose to deliver it with its open findings.',
    '',
    `Checks passed: ${vc.checks_passed.join(', ') || 'none'}`,
    '',
    'Open review findings:',
    ...(vc.open_findings.length === 0 ? ['- none'] : vc.open_findings.map((f) => `- ${findingLine(f)}: ${f.claim}`)),
  ];
  atomicWrite(join(runDir, VERIFIED_CANDIDATE_BODY), `${redact(lines.join('\n'))}\n`);
}

/** The verified candidate a BLOCKED run holds, as finishRun recorded it; null for every other run and an unreadable record. */
export function heldVerifiedCandidate(run: Pick<RunRecord, 'state' | 'outcomeJson'>, opts: { exhausted?: boolean } = {}): VerifiedCandidate | null {
  if (run.state !== 'BLOCKED' || !run.outcomeJson) return null;
  try {
    const o = JSON.parse(run.outcomeJson) as { verified_candidate?: unknown; decided?: unknown };
    const vc = o.verified_candidate;
    // `exhausted`: only a run that ran out holding it, which a resume would continue under the limits that stopped it;
    // a block that offers it (decided BLOCKED) keeps the block's own way forward.
    if (opts.exhausted === true && o.decided !== 'EXHAUSTED') return null;
    return vc !== null && typeof vc === 'object' && typeof (vc as { seq?: unknown }).seq === 'number' ? (vc as VerifiedCandidate) : null;
  } catch {
    return null;
  }
}
