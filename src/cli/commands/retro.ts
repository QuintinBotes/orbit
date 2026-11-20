/**
 * `orbit retro [--since <when>]`: look back over the runs that ended and propose what would have prevented the
 * failures that repeat (issue #174). Deterministic over run records; no model is asked. It proposes and never
 * applies or sends anything without a person's yes.
 *
 * Each proposal is a draft file (paths redacted) and one question at a terminal. Only an explicit yes acts, and what
 * it does depends on the kind: an Orbit issue draft is filed with `gh issue create`; a check is added to the
 * repository's Orbit configuration in a commit on a new branch, never on the base branch, and the checkout is not
 * touched; a reviewer standard or a policy change is marked accepted, for the person to make. Without a terminal, or
 * with --json, nobody is asked and the proposal stays a draft, made again by the next retro. Every answer is recorded
 * in the state database, so a declined proposal is not made again.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { isMap, parseDocument } from 'yaml';
import { execCapture } from '../../core/exec.ts';
import { OrbitError } from '../../core/errors.ts';
import { gitEnv } from '../../delivery/git.ts';
import { CONFIG_RELATIVE_PATH, loadConfig, parseConfig } from '../../policy/config.ts';
import { findDecision, draftFileName, recordAnswer, recordProposal, redactPaths, retroProposals, type DeclaredCheck, type ProposalKind, type RetroDecision, type RetroProposal } from '../../observability/retro.ts';
import { orbitDir } from '../../controller/start.ts';
import { detectChecks } from '../check-detect.ts';
import { trackedFiles } from '../layout.ts';
import type { Args, OptionSpec } from '../args.ts';
import { resolveRepo, withState, type CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { flat, json, line } from '../io.ts';
import { parseWhen } from './stats.ts';

export const RETRO_USAGE = 'orbit retro [--since <when>] [--issue-repo <owner/repo>] [--json]';

/** Where Orbit's own issues are filed; `--issue-repo` names another (a fork, a test repository). */
export const DEFAULT_ISSUE_REPO = 'QuintinBotes/orbit';

export const RETRO_OPTIONS: OptionSpec = {
  since: { type: 'string', valueName: 'when', description: 'only runs created at or after this time: an ISO date or time, or a span back from now such as 90m, 24h, 7d, 2w' },
  'issue-repo': { type: 'string', valueName: 'owner/repo', description: `where an approved issue draft is filed with gh (default ${DEFAULT_ISSUE_REPO}); nothing is sent without your yes` },
};

/** Subdirectory of .orbit/runs (which init keeps out of git status) that holds the drafts. */
const DRAFT_DIR = ['runs', 'retro-drafts'] as const;

export interface RetroDeps {
  /** Ask the person; true only for an explicit yes, false for no, null when nobody can be asked (no terminal). */
  ask(question: string): Promise<boolean | null>;
  /** File the issue; returns its URL. Called only after a yes. */
  send(input: { repo: string; title: string; body: string; cwd: string }): Promise<string>;
}

/** Asks on the terminal the command runs in; null when stdin or stdout is not one. The question goes to stderr so --json stays clean. */
export function terminalAsk(ctx: CliContext, input: Readable = process.stdin, output: Writable = process.stderr): RetroDeps['ask'] {
  let ended = false;
  return async (question) => {
    if (ended || !ctx.io.stdoutIsTty || (input as { isTTY?: boolean }).isTTY !== true) return null;
    const rl = createInterface({ input, output });
    try {
      // Ctrl-D closes the interface and leaves the question unsettled: nobody answered, and nobody is asked again.
      const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
      const answer = await Promise.race([rl.question(`${question} [y/N] `).catch(() => null), closed]);
      if (answer === null) {
        ended = true;
        return null;
      }
      return /^\s*y(es)?\s*$/i.test(answer);
    } finally {
      rl.close();
    }
  };
}

/** Files the issue through the gh CLI, the way Orbit reaches GitHub everywhere else. */
export function ghSend(ctx: CliContext): RetroDeps['send'] {
  return async ({ repo, title, body, cwd }) => {
    const env: Record<string, string | undefined> = {};
    for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) if (ctx.env[k] !== undefined) env[k] = ctx.env[k];
    let res;
    try {
      res = await execCapture(['gh', 'issue', 'create', '--repo', repo, '--title', title, '--body', body], { cwd, env, timeoutMs: 60_000 });
    } catch (err) {
      throw new OrbitError('PROVIDER_UNAVAILABLE', `could not run gh: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.exitCode !== 0) throw new OrbitError('PROVIDER_UNAVAILABLE', `gh issue create failed: ${flat(res.stderr).slice(0, 300)}`);
    return res.stdout.trim().split('\n').pop() ?? '';
  };
}

/** The branch an approved check is committed on. */
export const checkBranch = (check: DeclaredCheck): string => `orbit/retro/check-${check.id}`;

/** The configuration text with `check` added under `checks`; it must still be a configuration Orbit accepts. */
export function withCheck(text: string, check: DeclaredCheck): string {
  const doc = parseDocument(text);
  const def = doc.createNode({ command: check.command, category: check.category, timeout_seconds: check.timeout_seconds });
  const command = def.get('command', true);
  if (command && typeof command === 'object' && 'flow' in command) command.flow = true;
  const checks = doc.get('checks');
  if (isMap(checks)) {
    if (checks.has(check.id)) throw new OrbitError('CONFIG_INVALID', `the configuration already has a check named ${check.id}`);
    checks.set(check.id, def);
  } else if (checks === null || checks === undefined) {
    doc.set('checks', doc.createNode({ [check.id]: def }));
  } else {
    throw new OrbitError('CONFIG_INVALID', 'checks in the configuration is not a map');
  }
  const out = doc.toString();
  parseConfig(out, { source: CONFIG_RELATIVE_PATH });
  return out;
}

/**
 * AC-2: commit the configuration with `check` added on a new branch from the tip of the base branch. Plumbing only: no
 * commit hook runs (a reference-transaction hook still does), the checkout, its index and the base branch are not
 * touched, and an existing branch is never replaced:
 * one that already holds the check is where it was applied, any other fails the apply.
 */
export async function applyCheckOnBranch(ctx: CliContext, repo: string, baseBranch: string, check: DeclaredCheck): Promise<{ branch: string; commit: string }> {
  const branch = checkBranch(check);
  const scratch = mkdtempSync(join(tmpdir(), 'orbit-retro-'));
  const git = async (args: string[], input?: string): Promise<string> => {
    const res = await execCapture(['git', ...args], { cwd: repo, env: gitEnv({ ...ctx.env, GIT_INDEX_FILE: join(scratch, 'index') }), timeoutMs: 30_000, ...(input === undefined ? {} : { input }) });
    if (res.exitCode !== 0) throw new OrbitError('GIT_FAILED', `git ${args[0]} failed: ${flat(res.stderr).slice(0, 300)}`);
    return res.stdout.trim();
  };
  try {
    const base = await git(['rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`]);
    // A yes to another proposal of the same check already made the branch (each review-dispute signature proposes it).
    const made = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).catch(() => null);
    if (made !== null) {
      const onBranch = await git(['show', `${made}:${CONFIG_RELATIVE_PATH}`]).catch(() => '');
      if (parseDocument(onBranch).hasIn(['checks', check.id])) return { branch, commit: made };
    }
    // The configuration as the base branch holds it; one never committed is taken from the checkout.
    const text = await git(['show', `${base}:${CONFIG_RELATIVE_PATH}`]).catch(() => readFileSync(join(repo, CONFIG_RELATIVE_PATH), 'utf8'));
    const blob = await git(['hash-object', '-w', '--stdin'], withCheck(text, check));
    await git(['read-tree', base]);
    await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${CONFIG_RELATIVE_PATH}`]);
    const tree = await git(['write-tree']);
    const commit = await git(['commit-tree', tree, '-p', base, '-m', `Add the check ${check.id}, proposed by orbit retro`]);
    // The empty old value makes git refuse a branch that already exists.
    await git(['update-ref', `refs/heads/${branch}`, commit, '']);
    return { branch, commit };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A check the repository declares that its Orbit configuration does not run (no check of its category), with the base branch; null when there is none or no valid configuration. */
async function missingCheck(ctx: CliContext, repo: string): Promise<{ check: DeclaredCheck; baseBranch: string } | null> {
  let config;
  try {
    config = loadConfig(repo);
  } catch {
    return null;
  }
  const configured = new Set(Object.values(config.checks).map((c) => c.category ?? 'test'));
  const { proposed } = await detectChecks({ repo, files: await trackedFiles(ctx, repo), pathEnv: ctx.env.PATH });
  const c = proposed.find((p) => !configured.has(p.category) && !(p.id in config.checks));
  return c ? { check: { id: c.id, command: c.command, category: c.category, timeout_seconds: c.timeout_seconds }, baseBranch: config.repository.base_branch } : null;
}

export interface RetroProposalReport {
  kind: ProposalKind;
  failure_class: string;
  signature: string;
  title: string;
  runs: string[];
  /** Repository-relative path of the draft file. */
  draft: string;
  /** What became of it: left as a draft (nobody was asked), the person's answer, or the action after a yes failed. */
  outcome: RetroDecision | 'failed';
  issue_url?: string;
  /** The branch an applied check was committed on. */
  branch?: string;
  error?: string;
}

export interface RetroReport {
  window: { since: string | null };
  proposals: RetroProposalReport[];
  /** Proposals the runs support that were answered before and are not made again. */
  already_decided: number;
}

const ISSUE_REPO_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;

function question(p: RetroProposal, draft: string, issueRepo: string): string {
  if (p.kind === 'issue-draft') return `File the draft ${draft} as an issue in ${issueRepo} with gh? Nothing is sent without your yes.`;
  if (p.kind === 'check' && p.check) return `Add the check ${p.check.id} to ${CONFIG_RELATIVE_PATH} in a commit on the new branch ${checkBranch(p.check)}? The base branch and your checkout are not touched.`;
  return `Accept the ${p.kind === 'standard' ? 'reviewer standard' : 'policy change'} in ${draft}? Orbit changes nothing; you make the change.`;
}

export async function retroCommand(args: Args, ctx: CliContext): Promise<number> {
  return runRetro(args, ctx, { ask: terminalAsk(ctx), send: ghSend(ctx) });
}

export async function runRetro(args: Args, ctx: CliContext, deps: RetroDeps): Promise<number> {
  args.expect(0);
  const sinceText = args.str('since');
  let since: number | null = null;
  if (sinceText !== undefined) {
    try {
      since = parseWhen(sinceText, ctx.clock.now(), 'since');
    } catch (err) {
      if (err instanceof UsageError) throw new UsageError(err.message, RETRO_USAGE);
      throw err;
    }
  }
  const issueRepo = args.str('issue-repo')?.trim() ?? DEFAULT_ISSUE_REPO;
  if (!ISSUE_REPO_SHAPE.test(issueRepo)) throw new UsageError(`--issue-repo must look like owner/repo, got ${JSON.stringify(issueRepo)}`, RETRO_USAGE);
  const wantJson = args.bool('json');
  const repo = await resolveRepo(ctx, args.str('repo'));
  const roots = [repo, ctx.homeDir];
  const draftDir = join(orbitDir(repo), ...DRAFT_DIR);
  const declared = await missingCheck(ctx, repo);

  const report = await withState(repo, async (db) => {
    const out: RetroReport = { window: { since: since === null ? null : new Date(since).toISOString() }, proposals: [], already_decided: 0 };
    for (const p of retroProposals(db, { since, roots, missingCheck: declared?.check ?? null })) {
      const before = findDecision(db, p.key);
      if (before && before.decision !== 'drafted') {
        out.already_decided++;
        continue;
      }
      const draft = relative(repo, join(draftDir, draftFileName(p.key)));
      try {
        mkdirSync(draftDir, { recursive: true });
        writeFileSync(join(repo, draft), p.body, { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        throw new OrbitError('INTERNAL', `cannot write the draft ${draft}: ${redactPaths(err instanceof Error ? err.message : String(err), roots)}`);
      }
      // Recorded before anyone is asked, so the draft and its runs are on record whatever the answer.
      recordProposal(db, p, draft, ctx.clock.now());
      const item: RetroProposalReport = { kind: p.kind, failure_class: p.failureClass, signature: p.signature, title: p.title, runs: p.runs.map((r) => r.runId), draft, outcome: 'drafted' };
      out.proposals.push(item);
      // --json owns stdout and a pipe has no person: ask only a person at a terminal.
      const yes = wantJson ? null : await deps.ask(question(p, draft, issueRepo));
      if (yes === null) continue;
      try {
        let decision: Exclude<RetroDecision, 'drafted'> = 'declined';
        if (yes && p.kind === 'issue-draft') {
          item.issue_url = await deps.send({ repo: issueRepo, title: p.title, body: bodyWithoutTitle(p), cwd: repo });
          decision = 'sent';
        } else if (yes && p.kind === 'check' && p.check && declared) {
          item.branch = (await applyCheckOnBranch(ctx, repo, declared.baseBranch, p.check)).branch;
          decision = 'applied';
        } else if (yes) {
          decision = 'accepted';
        }
        recordAnswer(db, p.key, decision, ctx.user, ctx.clock.now());
        item.outcome = decision;
      } catch (err) {
        item.outcome = 'failed';
        item.error = redactPaths(err instanceof Error ? err.message : String(err), roots);
      }
    }
    return out;
  });

  if (wantJson) json(ctx.io, report);
  else renderRetro(ctx, report, issueRepo);
  return report.proposals.some((p) => p.outcome === 'failed') ? EXIT.FAILURE : EXIT.OK;
}

/** The issue body: the draft without its title line, which is the issue title. */
function bodyWithoutTitle(p: RetroProposal): string {
  return p.body.replace(/^# [^\n]*\n+/, '');
}

const KIND_LABEL: Record<ProposalKind, string> = { 'issue-draft': 'issue draft', check: 'check', standard: 'reviewer standard', policy: 'policy change' };

function renderRetro(ctx: CliContext, report: RetroReport, issueRepo: string): void {
  const window = report.window.since === null ? 'all runs' : `runs created since ${report.window.since}`;
  if (report.proposals.length === 0) {
    line(ctx.io, `No proposals from ${window}: no repeated or Orbit-fault failure that is not already decided.${report.already_decided > 0 ? ` (${report.already_decided} proposal(s) were answered before and are not repeated.)` : ''}`);
    return;
  }
  line(ctx.io, `${report.proposals.length} proposal(s) from ${window}:`);
  for (const p of report.proposals) {
    line(ctx.io);
    line(ctx.io, `${KIND_LABEL[p.kind]}: ${p.title}`);
    line(ctx.io, `  cites ${p.runs.length} run(s): ${p.runs.join(', ')}`);
    line(ctx.io, `  draft file: ${p.draft} (paths redacted; review it before it goes anywhere)`);
    if (p.outcome === 'sent') line(ctx.io, `  sent to ${issueRepo}: ${p.issue_url ?? '(no url returned)'}`);
    else if (p.outcome === 'applied') line(ctx.io, `  added on branch ${p.branch}: review it and merge it as any change; the base branch is unchanged`);
    else if (p.outcome === 'accepted') line(ctx.io, '  accepted: Orbit changed nothing; make the change the draft names');
    else if (p.outcome === 'declined') line(ctx.io, `  declined: nothing was ${p.kind === 'issue-draft' ? 'sent' : 'applied'}, and it will not be proposed again`);
    else if (p.outcome === 'failed') line(ctx.io, `  not ${p.kind === 'issue-draft' ? 'sent' : 'applied'}: ${p.error ?? 'failed'}; the draft is kept`);
    else {
      const how = p.kind === 'issue-draft' ? `To file it yourself: gh issue create --repo ${issueRepo} --title "<title above>" --body-file ${p.draft}. ` : '';
      line(ctx.io, `  nothing was ${p.kind === 'issue-draft' ? 'sent' : 'applied'} (no one was asked: this is not an interactive terminal). ${how}Run orbit retro at a terminal to answer it.`);
    }
  }
  if (report.already_decided > 0) {
    line(ctx.io);
    line(ctx.io, `${report.already_decided} proposal(s) were answered before and are not repeated.`);
  }
}
