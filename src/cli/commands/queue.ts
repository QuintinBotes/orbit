/**
 * `orbit queue list` and `orbit queue run`: work a backlog of GitHub issues in dependency order
 * (docs/decisions/0020-backlog-queue.md).
 *
 * The backlog is a parent issue's sub-issues in the parent's order, or the open issues carrying the queue's label,
 * oldest first; that order is the priority. Before every issue the backlog is read from GitHub again and planned
 * (intake/backlog.ts): the frontier is the open issues with the label, without the label that hands an issue to a
 * person, with no open blocking issue and not already Orbit's. `queue run` takes the first issue of the frontier, brings
 * the base branch up to the remote, and runs the issue in this process exactly as `orbit run --issue <n> --foreground`
 * would, one issue at a time. A delivered issue waits for its pull request to merge; once it has merged into the base
 * branch the issue is closed (GitHub closes it only for the default branch), which is what lets its dependants in. An
 * issue whose runs end without a delivered change is labelled for a person, with a comment that says why.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { capModelCost, RUN_MODES } from '../../policy/index.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import { startRun, stateDbPath } from '../../controller/index.ts';
import { orbitDir } from '../../controller/start.ts';
import { listRuns, type RunRecord } from '../../controller/run-store.ts';
import { isTerminal } from '../../controller/states.ts';
import { heldVerifiedCandidate } from '../../controller/verified-candidate.ts';
import { DELIVERY_FILE, githubClientForConfig } from '../../controller/steps/delivering.ts';
import { OrbitError, isOrbitError } from '../../core/errors.ts';
import { atomicWriteJson, readJsonIfExists } from '../../core/fsx.ts';
import { newRunId } from '../../core/ids.ts';
import { redact } from '../../core/redact.ts';
import { fastForwardBase, gitEnv } from '../../delivery/git.ts';
import type { GitHubClient } from '../../delivery/github.ts';
import { describeCycle, planBacklog, type BacklogPlan } from '../../intake/backlog.ts';
import { failureClass, type ReportForComment } from '../../intake/comment.ts';
import { hasLabel, issueTrackerFor, type BacklogQuery, type IssueTracker } from '../../intake/github.ts';
import { parseIssueRef, readIssueGoal } from '../../intake/issue.ts';
import { listQuestions } from '../../inquisition/store.ts';
import type { Args, OptionSpec } from '../args.ts';
import { openState, resolveRepo, type CliContext } from '../context.ts';
import { admitRun } from '../admission.ts';
import { EXIT, UsageError } from '../exit.ts';
import { flat, json, line, table } from '../io.ts';
import { loadCommandPolicy } from '../policy-file.ts';
import { driveForeground } from './drive.ts';
import { issueRunInput, refuseUnfinished } from './run.ts';

export const DEFAULT_LABEL = 'ready-for-agent';
export const DEFAULT_HUMAN_LABEL = 'ready-for-human';
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_WAIT_MINUTES = 60;
/** How often a waiting queue looks at the pull requests it waits on. */
const POLL_MS = 60_000;
/** Two runs in a row that end without a delivered change, on one issue or across issues, stop the queue (FR-004). */
const FAILED_RUNS_STOP = 2;
/** The queue's records, one JSON file per `queue run`. */
export const QUEUE_DIR = 'queue';

const SELECT_OPTIONS: OptionSpec = {
  parent: { type: 'string', description: 'work the sub-issues of this issue, in its order (default: every open issue carrying the label, oldest first)', valueName: 'issue' },
  label: { type: 'string', description: `the label an issue must carry to be taken (default: ${DEFAULT_LABEL})`, valueName: 'name' },
  'human-label': { type: 'string', description: `the label that hands an issue to a person: never taken, and added to an issue whose runs did not deliver (default: ${DEFAULT_HUMAN_LABEL})`, valueName: 'name' },
  base: { type: 'string', description: 'the branch every issue runs from and every pull request targets (default: repository.base_branch); validated as if the policy file said it', valueName: 'branch' },
  policy: { type: 'string', description: 'policy file (default: .orbit/config.yaml)', valueName: 'path' },
};

export const QUEUE_LIST_USAGE = 'orbit queue list [--parent <issue>] [--label <name>] [--human-label <name>] [--base <branch>] [--policy <path>] [--json]';
export const QUEUE_LIST_OPTIONS: OptionSpec = SELECT_OPTIONS;

export const QUEUE_RUN_USAGE = 'orbit queue run [--parent <issue>] [--label <name>] [--base <branch>] [--mode <mode>] [--max-issues <n>] [--budget-usd <usd>] [--attempts <n>] [--wait-minutes <n>] [--policy <path>] [--json]';
export const QUEUE_RUN_OPTIONS: OptionSpec = {
  ...SELECT_OPTIONS,
  mode: { type: 'string', description: 'supervised, autonomous, autonomous-delivery or release, for every run; validated as if the policy file said it', valueName: 'mode' },
  'max-issues': { type: 'string', description: 'stop after this many issues (default: no limit)', valueName: 'n' },
  'budget-usd': { type: 'string', description: 'stop once the runs have spent this much; each run is capped at what is left (default: no limit beyond each run\'s own)', valueName: 'usd' },
  attempts: { type: 'string', description: `runs per issue before it is handed to a person (default: ${DEFAULT_ATTEMPTS}); a run waiting on an answer is not retried`, valueName: 'n' },
  'wait-minutes': { type: 'string', description: `how long to wait for delivered pull requests to merge when only their dependants are left (default: ${DEFAULT_WAIT_MINUTES}; 0 stops at once)`, valueName: 'n' },
};

// ---------------------------------------------------------------------------
// setup

interface Queue {
  repo: string;
  config: OrbitConfig;
  tracker: IssueTracker;
  query: BacklogQuery;
  humanLabel: string;
  base: string;
}

const LABEL = /^[^\s,\x00-\x1f\x7f][^,\x00-\x1f\x7f]{0,49}$/;

function labelOption(args: Args, name: string, fallback: string, usage: string): string {
  const v = (args.str(name) ?? fallback).trim();
  if (!LABEL.test(v)) throw new UsageError(`--${name} must be a label name of 1 to 50 characters without commas, got ${JSON.stringify(v.slice(0, 60))}`, usage);
  return v;
}

async function openQueue(args: Args, ctx: CliContext, usage: string, mode?: (typeof RUN_MODES)[number]): Promise<Queue> {
  const label = labelOption(args, 'label', DEFAULT_LABEL, usage);
  const humanLabel = labelOption(args, 'human-label', DEFAULT_HUMAN_LABEL, usage);
  if (label.toLowerCase() === humanLabel.toLowerCase()) throw new UsageError('--label and --human-label must differ', usage);
  let parent: { repo: string | null; number: number } | null = null;
  const p = args.str('parent');
  if (p !== undefined) {
    try {
      parent = parseIssueRef(p);
    } catch (err) {
      throw new UsageError(`--parent: ${isOrbitError(err) ? err.message : String(err)}`, usage);
    }
  }
  const repo = await resolveRepo(ctx, args.str('repo'));
  const base = args.str('base');
  const config = loadCommandPolicy(repo, ctx.cwd, args.str('policy'), { ...(mode ? { mode } : {}), ...(base !== undefined ? { baseBranch: base } : {}) });
  const tracker = await issueTrackerFor(repo, config, ctx.env);
  if (parent?.repo && parent.repo.toLowerCase() !== tracker.repo.toLowerCase()) {
    throw new OrbitError('POLICY_DENIED', `issue ${parent.repo}#${parent.number} is not in this checkout's repository (${tracker.repo}); the queue works only issues of the repository it works in`, { definitive: true });
  }
  return { repo, config, tracker, query: { parent: parent?.number ?? null, label }, humanLabel, base: config.repository.base_branch };
}

// ---------------------------------------------------------------------------
// what Orbit's own runs say about each issue

interface Delivered {
  run: RunRecord;
  branch: string | null;
  pr: { number: number; url: string | null } | null;
}

interface IssueHistory {
  unfinished: RunRecord | null;
  delivered: Delivered | null;
}

function runDirOf(repo: string, id: string): string {
  return join(orbitDir(repo), 'runs', id);
}

function deliveryOf(runDir: string): { branch: string | null; pr: { number: number; url: string | null } | null } {
  const d = readJsonIfExists<{ branch?: unknown; pr?: { number?: unknown; url?: unknown } | null }>(join(runDir, DELIVERY_FILE));
  const n = d?.pr?.number;
  return {
    branch: typeof d?.branch === 'string' ? d.branch : null,
    pr: typeof n === 'number' && Number.isInteger(n) && n > 0 ? { number: n, url: typeof d?.pr?.url === 'string' && d.pr.url !== '' ? d.pr.url : null } : null,
  };
}

/** The newest unfinished and the newest succeeded run started from each issue of this repository. */
function histories(repo: string, issueRepo: string): Map<number, IssueHistory> {
  const out = new Map<number, IssueHistory>();
  if (!existsSync(stateDbPath(repo))) return out;
  const db = openState(repo);
  try {
    for (const r of listRuns(db, { limit: -1 })) {
      const goal = readIssueGoal(runDirOf(repo, r.id));
      if (!goal || goal.repo.toLowerCase() !== issueRepo.toLowerCase()) continue;
      const h = out.get(goal.number) ?? { unfinished: null, delivered: null };
      if (!isTerminal(r.state)) h.unfinished ??= r;
      else if (r.state === 'SUCCEEDED' && !h.delivered) {
        const d = deliveryOf(runDirOf(repo, r.id));
        h.delivered = { run: r, branch: d.branch ?? r.branch, pr: d.pr };
      }
      out.set(goal.number, h);
    }
  } finally {
    db.close();
  }
  return out;
}

// ---------------------------------------------------------------------------
// one look at the backlog

interface Look {
  plan: BacklogPlan;
  /** Delivered issues that wait for a person to merge (and so for their issue to close). */
  waiting: Set<number>;
  /** Issues closed by this look because their pull request merged into the base branch. */
  closed: { number: number; pr: number }[];
}

function closingComment(pr: number, base: string): string {
  return [
    `Pull request #${pr} was merged into \`${base}\`, so Orbit's queue closes this issue. GitHub closes an issue from a pull request's "Closes #n" only when it merges into the default branch.`,
    '',
    'Issues this one blocked can now be taken.',
  ].join('\n');
}

/**
 * Read the backlog and plan it. With `settle`, an open issue whose delivered pull request has merged into the base
 * branch is closed first (a comment, then the close), so its dependants enter the frontier in the same look.
 */
async function look(q: Queue, client: () => Promise<GitHubClient>, settle: boolean): Promise<Look> {
  const backlog = await q.tracker.listIssues(q.query);
  const history = histories(q.repo, q.tracker.repo);
  const owned = new Map<number, string>();
  const waiting = new Set<number>();
  const closed: Look['closed'] = [];
  for (const i of backlog) {
    if (!i.open || i.isPullRequest || !hasLabel(i, q.query.label) || hasLabel(i, q.humanLabel)) continue;
    const h = history.get(i.number);
    if (h?.unfinished) {
      owned.set(i.number, `run ${h.unfinished.id} (${h.unfinished.state}) was started from it and is unfinished: continue it with orbit resume ${h.unfinished.id}, or cancel it with orbit cancel ${h.unfinished.id}`);
      continue;
    }
    const d = h?.delivered;
    if (!d) continue;
    if (!d.pr) {
      owned.set(i.number, `delivered by run ${d.run.id} as ${d.branch ? `branch ${d.branch}` : 'a local branch'}; waits for a person to merge it and close the issue`);
      waiting.add(i.number);
      continue;
    }
    let state: { state: string; base: string } | null = null;
    let unread = '';
    try {
      const m = await (await client()).getMergeState(d.pr.number);
      state = { state: m.state, base: m.baseRefName };
    } catch (err) {
      unread = redact(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
    }
    if (state?.state === 'MERGED' && state.base === q.base) {
      if (settle) {
        await q.tracker.comment(i.number, closingComment(d.pr.number, q.base));
        await q.tracker.close(i.number);
        closed.push({ number: i.number, pr: d.pr.number });
      } else owned.set(i.number, `pull request #${d.pr.number} has merged into ${q.base}; "orbit queue run" closes the issue`);
    } else if (state?.state === 'MERGED') owned.set(i.number, `delivered: pull request #${d.pr.number} was merged into ${state.base}, not ${q.base}; a person closes the issue`);
    // A pull request closed without merging gives the issue back: while it carries the label, the queue takes it again.
    else if (state?.state === 'CLOSED') continue;
    else {
      owned.set(i.number, state ? `delivered: pull request #${d.pr.number} waits to be merged into ${q.base}` : `delivered: pull request #${d.pr.number}, whose state could not be read (${unread})`);
      waiting.add(i.number);
    }
  }
  // A closed blocker no longer blocks: the backlog was read before the issues above were closed.
  const done = new Set(closed.map((c) => c.number));
  const view = backlog.map((i) => (done.has(i.number) ? { ...i, open: false } : { ...i, blockedBy: i.blockedBy.map((b) => (b.repo.toLowerCase() === i.repo.toLowerCase() && done.has(b.number) ? { ...b, open: false } : b)) }));
  return { plan: planBacklog(view, { label: q.query.label, humanLabel: q.humanLabel, owned }), waiting, closed };
}

/** Delivered issues an issue of the backlog waits on: the merges that would let more work in. */
function awaitedMerges(l: Look): number[] {
  const wanted = new Set<number>();
  for (const h of l.plan.held) for (const b of h.blockedBy) if (l.waiting.has(b)) wanted.add(b);
  return [...wanted].sort((a, b) => a - b);
}

function describePlan(l: Look, q: Queue): string[] {
  const lines: string[] = [];
  const name = (n: number, title: string): string => `#${n} ${flat(title).slice(0, 80)}`;
  lines.push(l.plan.frontier.length === 0 ? 'frontier: none' : `frontier (${l.plan.frontier.length}, in priority order):`);
  for (const f of l.plan.frontier) lines.push(`  ${name(f.number, f.title)}`);
  if (l.plan.held.length > 0) {
    lines.push('held:');
    for (const h of l.plan.held) lines.push(`  ${name(h.number, h.title)}: ${h.reason}`);
  }
  for (const c of l.plan.cycles) lines.push(`cycle: ${describeCycle(c)}; none of them runs`);
  if (l.plan.ignored.length > 0) {
    lines.push('not taken:');
    for (const i of l.plan.ignored) lines.push(`  ${name(i.number, i.title)}: ${i.reason}`);
  }
  if (l.plan.frontier.length === 0 && l.plan.held.length === 0 && l.plan.ignored.length === 0) lines.push(`no open issue ${q.query.parent !== null ? `under #${q.query.parent} ` : ''}carries the label ${q.query.label}`);
  return lines;
}

function planJson(l: Look): object {
  return { frontier: l.plan.frontier, held: l.plan.held, cycles: l.plan.cycles, ignored: l.plan.ignored, waiting_for_merge: [...l.waiting].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// orbit queue list

export async function queueListCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const q = await openQueue(args, ctx, QUEUE_LIST_USAGE);
  const l = await look(q, lazyClient(q, ctx), false);
  if (args.bool('json')) json(ctx.io, { repo: q.tracker.repo, base: q.base, parent: q.query.parent, label: q.query.label, human_label: q.humanLabel, ...planJson(l) });
  else for (const s of describePlan(l, q)) line(ctx.io, s);
  return EXIT.OK;
}

function lazyClient(q: Queue, ctx: CliContext): () => Promise<GitHubClient> {
  let c: Promise<GitHubClient> | null = null;
  return () => (c ??= githubClientForConfig(q.repo, q.config, ctx.env, { requireScopedToken: false }));
}

// ---------------------------------------------------------------------------
// orbit queue run

export interface QueueAttempt {
  run_id: string;
  state: string;
  /** The class the run recorded for why it ended (ADR 0018), or none. */
  failure_class: string;
  /** Questions the run left open for a person: such a run is not tried again. */
  open_questions: number;
  /** The run stopped holding a candidate that passed verification (#169): a person delivers or discards it, so it is not tried again. */
  verified_candidate: boolean;
  cost_usd: number | null;
}

export interface QueueIssueRecord {
  number: number;
  title: string;
  /**
   * delivered: a run succeeded; person: handed to a person; skipped: refused for its state; budget: the queue's budget
   * ended it (the issue is not handed to a person); interrupted: Ctrl-C.
   */
  outcome: 'delivered' | 'person' | 'skipped' | 'budget' | 'interrupted';
  reason: string;
  pull_request: { number: number; url: string | null } | null;
  branch: string | null;
  attempts: QueueAttempt[];
  /** Something the queue could not do for this issue (a label or comment that failed). */
  warnings: string[];
}

export interface QueueRecord {
  schema: 'orbit.queue/1';
  id: string;
  repo: string;
  base: string;
  parent: number | null;
  label: string;
  human_label: string;
  mode: string;
  started_at: number;
  ended_at: number | null;
  stop: { kind: 'empty' | 'max-issues' | 'budget' | 'waited' | 'failed-runs' | 'interrupted' | 'error'; reason: string } | null;
  spent_usd: number;
  issues: QueueIssueRecord[];
  /** Issues the queue closed because their pull request merged into the base branch. */
  closed: { number: number; pr: number }[];
  /** The backlog as it was left: what can run next, and why the rest waits. */
  remaining: object | null;
}

/** The runs since the last delivered one: those that ended without a delivered change, in a row. */
function failedRunsInARow(attempts: readonly QueueAttempt[]): QueueAttempt[] {
  return attempts.slice(attempts.findLastIndex((a) => a.state === 'SUCCEEDED') + 1);
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function personComment(entry: QueueIssueRecord, q: Queue, problems: string[]): string {
  const lines = [`Orbit's queue hands this issue to a person and labelled it \`${q.humanLabel}\`; it will not take it again while that label is on.`, ''];
  if (entry.attempts.length === 0) {
    lines.push('The body is not a spec a run can start from:', '', ...problems.slice(0, 10).map((p) => `- ${flat(p).slice(0, 300)}`));
    if (problems.length > 10) lines.push(`- and ${problems.length - 10} more`);
    lines.push('', `Fix the body (\`orbit spec check ${entry.number}\` says what is missing), then remove the label.`);
    return lines.join('\n');
  }
  lines.push(`${count(entry.attempts.length, 'run')} ended without a delivered change:`, '');
  for (const a of entry.attempts) lines.push(`- Run \`${a.run_id}\`: ${a.state}, failure class ${a.failure_class}${a.cost_usd !== null ? `, spend $${a.cost_usd.toFixed(4)}` : ''}`);
  const last = entry.attempts[entry.attempts.length - 1]!;
  if (last.open_questions > 0) lines.push('', `The last run waits on an answer from a person: \`orbit questions ${last.run_id}\`.`);
  if (last.verified_candidate) lines.push('', `The last run holds a candidate that passed verification: \`orbit report ${last.run_id}\` gives the commands that deliver it as a draft pull request or discard it.`);
  lines.push('', `The reports are on the machine that ran them: \`orbit report ${last.run_id}\`.`);
  return lines.join('\n');
}

export async function queueRunCommand(args: Args, ctx: CliContext): Promise<number> {
  const usage = QUEUE_RUN_USAGE;
  args.expect(0);
  const mode = args.oneOf('mode', RUN_MODES);
  const maxIssues = args.int('max-issues');
  if (maxIssues === 0) throw new UsageError('--max-issues must be at least 1', usage);
  const budget = args.num('budget-usd');
  if (budget === 0) throw new UsageError('--budget-usd must be more than 0', usage);
  const attempts = args.int('attempts') ?? DEFAULT_ATTEMPTS;
  if (attempts < 1 || attempts > 5) throw new UsageError('--attempts must be from 1 to 5', usage);
  const waitMs = (args.num('wait-minutes') ?? DEFAULT_WAIT_MINUTES) * 60_000;
  const asJson = args.bool('json');
  const q = await openQueue(args, ctx, usage, mode);
  const client = lazyClient(q, ctx);
  const wait = ctx.seams.queueWait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const record: QueueRecord = {
    schema: 'orbit.queue/1',
    id: newRunId(ctx.clock.now()).replace(/^orb-/, 'queue-'),
    repo: q.tracker.repo,
    base: q.base,
    parent: q.query.parent,
    label: q.query.label,
    human_label: q.humanLabel,
    mode: q.config.mode,
    started_at: ctx.clock.now(),
    ended_at: null,
    stop: null,
    spent_usd: 0,
    issues: [],
    closed: [],
    remaining: null,
  };
  const recordPath = join(orbitDir(q.repo), QUEUE_DIR, `${record.id}.json`);
  const save = (): void => atomicWriteJson(recordPath, record);
  const say = (event: string, text: string, data: object = {}): void => {
    if (asJson) ctx.io.out(`${JSON.stringify({ type: 'queue', event, ...data })}\n`);
    else line(ctx.io, text);
  };

  say('started', `queue ${record.id}: ${q.query.parent !== null ? `sub-issues of #${q.query.parent}` : `open issues`} labelled ${q.query.label} in ${q.tracker.repo}, one at a time from ${q.base} (${q.config.mode})`, { id: record.id, repo: q.tracker.repo, base: q.base, mode: q.config.mode });
  let waited = 0;
  const tried = new Set<number>();
  try {
    for (;;) {
      if (maxIssues !== undefined && record.issues.length >= maxIssues) {
        record.stop = { kind: 'max-issues', reason: `--max-issues ${maxIssues} reached` };
        break;
      }
      if (budget !== undefined && record.spent_usd >= budget) {
        record.stop = { kind: 'budget', reason: `the budget of $${budget} is spent ($${record.spent_usd.toFixed(4)})` };
        break;
      }
      const l = await look(q, client, true);
      for (const c of l.closed) {
        record.closed.push(c);
        say('closed', `#${c.number}: pull request #${c.pr} merged into ${q.base}; closed the issue`, c);
      }
      if (l.closed.length > 0) save();
      const next = l.plan.frontier.find((f) => !tried.has(f.number));
      if (!next) {
        const awaited = awaitedMerges(l);
        if (awaited.length > 0 && waited < waitMs) {
          if (waited === 0) say('waiting', `waiting for ${awaited.map((n) => `#${n}`).join(', ')} to merge into ${q.base}: issues blocked by ${awaited.length === 1 ? 'it' : 'them'} come next (up to ${Math.round(waitMs / 60_000)} min)`, { waiting_for: awaited });
          await wait(POLL_MS);
          waited += POLL_MS;
          continue;
        }
        record.stop = awaited.length > 0 ? { kind: 'waited', reason: `waited ${Math.round(waitMs / 60_000)} min for ${awaited.map((n) => `#${n}`).join(', ')} to merge into ${q.base}` } : { kind: 'empty', reason: 'the frontier is empty' };
        break;
      }
      waited = 0;
      tried.add(next.number);
      // Each issue starts from the base as it stands now, with every merged delivery in it.
      await fastForwardBase({ repoRoot: q.repo, remote: q.config.repository.remote, branch: q.base, env: gitEnv({}, ctx.env) });
      say('issue', `#${next.number} ${flat(next.title).slice(0, 80)}: taken from the frontier`, { number: next.number });
      const entry = await workIssue(ctx, q, record, next, { attempts, budget, asJson, say });
      record.issues.push(entry);
      record.spent_usd += entry.attempts.reduce((s, a) => s + (a.cost_usd ?? 0), 0);
      save();
      say('issue.end', `#${entry.number}: ${outcomeWord(entry)}${entry.reason ? ` (${entry.reason})` : ''}`, { number: entry.number, outcome: entry.outcome, pull_request: entry.pull_request, attempts: entry.attempts.length });
      if (entry.outcome === 'budget') {
        record.stop = { kind: 'budget', reason: entry.reason };
        break;
      }
      if (entry.outcome === 'interrupted') {
        record.stop = { kind: 'interrupted', reason: `interrupted during #${entry.number}: ${entry.reason}` };
        break;
      }
      const failed = failedRunsInARow(record.issues.flatMap((i) => i.attempts));
      if (failed.length >= FAILED_RUNS_STOP) {
        record.stop = { kind: 'failed-runs', reason: `${failed.length} runs in a row ended without a delivered change (${failed.map((a) => `${a.run_id} ${a.state}`).join(', ')}); look at them before the queue goes on` };
        break;
      }
    }
  } catch (err) {
    record.stop = { kind: 'error', reason: redact(isOrbitError(err) ? err.message : err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 500) };
    record.ended_at = ctx.clock.now();
    save();
    throw err;
  }
  record.ended_at = ctx.clock.now();
  let left: Look | null = null;
  try {
    left = await look(q, client, false);
    record.remaining = planJson(left);
  } catch {
    record.remaining = null;
  }
  save();
  if (asJson) ctx.io.out(`${JSON.stringify({ type: 'queue', event: 'stopped', record_path: recordPath, ...record })}\n`);
  else {
    line(ctx.io, `queue stopped: ${record.stop!.reason}`);
    if (record.issues.length > 0) {
      ctx.io.out(
        table(
          record.issues.map((i) => [`#${i.number}`, outcomeWord(i), i.pull_request ? `#${i.pull_request.number}` : '-', String(i.attempts.length), i.attempts.map((a) => `${a.run_id} ${a.state}`).join(', ') || '-']),
          ['issue', 'outcome', 'pull request', 'attempts', 'runs'],
        ),
      );
    }
    if (left) for (const s of describePlan(left, q)) line(ctx.io, s);
    line(ctx.io, `spent: $${record.spent_usd.toFixed(4)}; record: ${recordPath}`);
  }
  if (record.stop?.kind === 'interrupted') return EXIT.PAUSED;
  return record.issues.some((i) => i.outcome === 'person') ? EXIT.BLOCKED : EXIT.OK;
}

function outcomeWord(i: QueueIssueRecord): string {
  switch (i.outcome) {
    case 'delivered':
      return i.pull_request ? `delivered, pull request #${i.pull_request.number}` : `delivered${i.branch ? ` as branch ${i.branch}` : ''}`;
    case 'person':
      return 'handed to a person';
    case 'skipped':
      return 'skipped';
    case 'budget':
      return 'stopped by the budget';
    case 'interrupted':
      return 'interrupted';
  }
}

interface WorkOptions {
  attempts: number;
  budget: number | undefined;
  asJson: boolean;
  say: (event: string, text: string, data?: object) => void;
}

/** Run one issue up to `attempts` times, exactly as `orbit run --issue <n> --foreground` would. */
async function workIssue(ctx: CliContext, q: Queue, record: QueueRecord, issue: { number: number; title: string }, o: WorkOptions): Promise<QueueIssueRecord> {
  const entry: QueueIssueRecord = { number: issue.number, title: flat(issue.title).slice(0, 150), outcome: 'person', reason: '', pull_request: null, branch: null, attempts: [], warnings: [] };
  let problems: string[] = [];
  for (let n = 1; n <= o.attempts; n++) {
    // No further run once FAILED_RUNS_STOP runs in a row have failed: the queue stops after this issue.
    if (failedRunsInARow([...record.issues.flatMap((i) => i.attempts), ...entry.attempts]).length >= FAILED_RUNS_STOP) break;
    // The issue is read and judged again, as `orbit run --issue` does; a refusal is about the issue, not the queue.
    let input: Awaited<ReturnType<typeof issueRunInput>>;
    try {
      input = await issueRunInput(ctx, q.repo, q.config, { repo: null, number: issue.number });
    } catch (err) {
      if (!isOrbitError(err, 'POLICY_DENIED')) throw err;
      if (err.details?.edit_issue === true) {
        problems = Array.isArray(err.details.problems) ? err.details.problems.map(String) : [err.message];
        entry.reason = err.message;
        break;
      }
      return { ...entry, outcome: 'skipped', reason: err.message };
    }
    const spent = record.spent_usd + entry.attempts.reduce((s, a) => s + (a.cost_usd ?? 0), 0);
    if (o.budget !== undefined && spent >= o.budget) return { ...entry, outcome: 'budget', reason: `the budget of $${o.budget} is spent ($${spent.toFixed(4)}) before attempt ${n} of #${issue.number}` };
    const config = o.budget !== undefined ? capModelCost(input.config, o.budget - spent) : input.config;
    // A run the queue's budget capped below the policy's own cap, and that then ran out, was stopped by the queue, not by the issue.
    const capped = config.scheduler.hard_limits.model_cost_usd < input.config.scheduler.hard_limits.model_cost_usd;
    // A problem admission finds (a dirty tree, a missing credential) is the queue's, not the issue's: it stops the queue.
    await admitRun(ctx, { repo: q.repo, config, foreground: true });
    const db = openState(q.repo, { create: true });
    try {
      try {
        refuseUnfinished(db, q.repo, input.goal, input.issue);
      } catch (err) {
        if (!isOrbitError(err, 'POLICY_DENIED')) throw err;
        return { ...entry, outcome: 'skipped', reason: err.message };
      }
      const run = startRun({ db, repoRoot: q.repo, goal: input.goal, config, clock: ctx.clock, actor: `cli:${ctx.user}`, issue: input.issue });
      o.say('run', `#${issue.number}: attempt ${n} of ${o.attempts}, run ${run.id}`, { number: issue.number, attempt: n, run_id: run.id });
      const result = await driveForeground(ctx, { repoRoot: q.repo, config, db, runId: run.id, fromStart: true, json: o.asJson });
      const runDir = runDirOf(q.repo, run.id);
      const report = readJsonIfExists<ReportForComment>(join(runDir, 'final.json'));
      const cost = report?.budget?.cost_usd;
      const open = listQuestions(db, run.id, { status: 'open' }).length;
      // A run that would have ended EXHAUSTED while holding a verified candidate ends BLOCKED with an offer instead (#169).
      const held = heldVerifiedCandidate(result.run) !== null;
      entry.attempts.push({ run_id: run.id, state: result.run.state, failure_class: failureClass(result.run), open_questions: open, verified_candidate: held, cost_usd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null });
      if (result.interrupted) return { ...entry, outcome: 'interrupted', reason: `run ${run.id} is paused; continue it with orbit resume ${run.id}` };
      // SIGTERM (timeout, systemd or docker stop) stops the queue as Ctrl-C does: no further run, and the issue keeps its labels.
      if (result.terminated) return { ...entry, outcome: 'interrupted', reason: `run ${run.id} was stopped by SIGTERM; continue it with orbit resume ${run.id} --foreground` };
      // Only a run that ran out of money under the queue's lowered cap is the queue's; review rounds or attempt caps are the issue's.
      // The class alone cannot say: every EXHAUSTED run gets `budget` as its last cause. The ending's counter can: a cost
      // refusal or the cost cap names cost_usd, whatever came first; an ending that names no counter is money when budget is its only cause.
      // shortcut: an unfunded-session ending names no counter, so in a run with an earlier cause (a turn cap) it reads as the issue's; record the counter there if that matters.
      const ended = db.get<{ counter: string | null }>("SELECT json_extract(data_json, '$.data.counter') AS counter FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id DESC LIMIT 1", run.id)?.counter ?? null;
      const outOfMoney = ended === 'cost_usd' || (ended === null && result.run.failureClass === 'budget');
      // Only a run that ran out holds its candidate for that reason; any other block offers its verified candidate too.
      const ranOut = heldVerifiedCandidate(result.run, { exhausted: true }) !== null;
      if ((result.run.state === 'EXHAUSTED' || ranOut) && capped && outOfMoney) {
        return { ...entry, outcome: 'budget', reason: `run ${run.id} of #${issue.number} ran out of the $${config.scheduler.hard_limits.model_cost_usd.toFixed(2)} left of the budget of $${o.budget}; the issue is not handed to a person${held ? `; the run holds a verified candidate: orbit report ${run.id} gives the commands that deliver or discard it` : ''}` };
      }
      if (result.run.state === 'SUCCEEDED') {
        const d = deliveryOf(runDir);
        return { ...entry, outcome: 'delivered', reason: '', pull_request: d.pr, branch: d.branch ?? result.run.branch };
      }
      // A run that waits on a person's answer, or holds a verified candidate a person delivers or discards, is not tried
      // again: a new run would only guess, or pay again for work that passed verification.
      if (open > 0 || held) break;
    } finally {
      db.close();
    }
  }
  if (entry.attempts.length > 0) entry.reason = `${count(entry.attempts.length, 'run')} ended without a delivered change: ${entry.attempts.map((a) => `${a.run_id} ${a.state} (${a.failure_class})`).join(', ')}`;
  // Handed to a person: the label keeps every later queue off the issue, and the comment says why.
  for (const [what, act] of [
    ['label', () => q.tracker.addLabel(issue.number, q.humanLabel)],
    ['comment', () => q.tracker.comment(issue.number, personComment(entry, q, problems))],
  ] as const) {
    try {
      await act();
    } catch (err) {
      entry.warnings.push(`could not ${what === 'label' ? `label the issue ${q.humanLabel}` : 'comment on the issue'}: ${redact(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }
  return entry;
}
