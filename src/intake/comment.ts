/**
 * What Orbit says on the issue a run was started from when the run ends (docs/decisions/0019-run-from-issue.md): the
 * outcome, a failure class, the evidence and the spend. The comment leaves the machine for a page other people read,
 * so it is built from the controller's own records only: states, ids, hashes, numbers and the notification's fixed
 * next-action sentence. It carries no text of the issue, no model prose (not even the outcome reason, which can quote
 * a question a model wrote), no path and no log.
 */
import type { RunRecord } from '../controller/run-store.ts';
import { commentBody, type NotificationPayload } from '../notify/payload.ts';
import type { IssueGoal } from './issue.ts';

export const ISSUE_COMMENT_FILE = 'issue-comment.md';

/** The part of final.json the comment reads; every field may be absent in a report written by another version. */
export interface ReportForComment {
  criteria?: { id: string; status: string }[];
  checks?: { id: string; status: string; flaky?: boolean }[];
  evidence?: { report_id: string; verdict: string; tree_hash: string } | null;
  revision?: { delivered_commit?: string | null; pull_request?: { number: number } | null } | null;
  budget?: { cost_usd?: number; cost_complete?: boolean } | null;
}

/**
 * Why the run ended, as the controller recorded it when the run reached its terminal state
 * (docs/decisions/0018-run-end-record.md): `none` for a run without a class (a success), else the class, with the
 * secondary cause after it when there was one.
 */
export function failureClass(run: Pick<RunRecord, 'failureClass' | 'failureSecondary'>): string {
  if (!run.failureClass) return 'none';
  return run.failureSecondary ? `${run.failureClass} (then ${run.failureSecondary})` : run.failureClass;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
const HEX = /^[0-9a-f]{7,64}$/;
const TIME = /^[0-9T:.Z+-]{1,40}$/;

/** A value from a record, shown only when it has the plain shape such a value has. */
function plainId(v: unknown, shape: RegExp = ID): string | null {
  return typeof v === 'string' && shape.test(v) ? v : null;
}

export interface IssueCommentInput {
  payload: NotificationPayload;
  goal: Pick<IssueGoal, 'kind' | 'number' | 'body_sha256' | 'updated_at' | 'scenarios'>;
  run: Pick<RunRecord, 'state' | 'failureClass' | 'failureSecondary'>;
  report: ReportForComment | null;
  /** The issue as it is now, when it was read again: null when it was not, or could not be. */
  now: { body_sha256: string; updated_at: string } | null;
}

export function renderIssueComment(input: IssueCommentInput): string {
  const { payload, goal, run, report } = input;
  const short = goal.body_sha256.slice(0, 16);
  const at = TIME.test(goal.updated_at) ? goal.updated_at : 'an unknown time';
  const lines = [commentBody({ ...payload, reason: null }), '', `- Outcome: ${run.state}`, `- Failure class: ${failureClass(run)}`, `- Started from: this issue as it was at ${at} (body sha256 \`${short}\`)`];
  if (input.now && input.now.body_sha256 !== goal.body_sha256) {
    const nowAt = TIME.test(input.now.updated_at) ? ` (last update now ${input.now.updated_at})` : '';
    lines.push(`- The issue was edited after this run started${nowAt}. The run kept the version it started with (body sha256 \`${short}\`).`);
  }
  const pr = report?.revision?.pull_request?.number;
  lines.push(`- Pull request: ${typeof pr === 'number' && Number.isInteger(pr) && pr > 0 ? `#${pr}` : 'none'}`);
  const commit = plainId(report?.revision?.delivered_commit, HEX);
  if (commit) lines.push(`- Delivered commit: \`${commit}\``);
  const ev = report?.evidence;
  const evId = plainId(ev?.report_id);
  if (ev && evId) lines.push(`- Evidence: report \`${evId}\`, verdict ${plainId(ev.verdict) ?? 'unknown'}, for tree \`${plainId(ev.tree_hash, HEX) ?? 'unknown'}\``);
  else lines.push('- Evidence: none recorded');
  const cost = report?.budget?.cost_usd;
  lines.push(typeof cost === 'number' && Number.isFinite(cost) ? `- Spend: $${cost.toFixed(4)} (${report?.budget?.cost_complete ? 'measured' : 'incomplete: some usage has no cost'})` : '- Spend: not recorded');

  const criteria = (report?.criteria ?? []).filter((c) => plainId(c.id) && plainId(c.status));
  if (criteria.length > 0) {
    lines.push('', 'Acceptance criteria:');
    // The draft numbers the issue's criteria AC-1, AC-2, ... in the issue's order, and an amendment never renumbers or
    // reuses an id, so AC-n is the nth scenario even after a criterion was removed.
    criteria.slice(0, 50).forEach((c) => {
      const n = Number(/^AC-(\d+)$/.exec(c.id)?.[1] ?? 0);
      const key = goal.kind === 'bug' ? (n === 1 ? 'reproduction' : null) : (goal.scenarios[n - 1]?.key ?? null);
      lines.push(`- ${c.id}${key ? ` (${key})` : ''}: ${c.status}`);
    });
  }
  const checks = (report?.checks ?? []).filter((c) => plainId(c.id) && plainId(c.status));
  if (checks.length > 0) lines.push('', 'Checks:', ...checks.slice(0, 50).map((c) => `- ${c.id}: ${c.status}${c.flaky ? ' (flaky)' : ''}`));
  if (payload.run_id) lines.push('', `The full report is on the machine that ran it: \`orbit report ${payload.run_id}\`.`);
  return lines.join('\n');
}
