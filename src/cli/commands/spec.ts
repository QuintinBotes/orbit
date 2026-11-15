/**
 * `orbit spec check <file|issue>`: the deterministic spec check (docs/decisions/0019-run-from-issue.md). It reads a
 * Markdown file, or the body of an issue of this repository, and says whether `orbit run --issue` would take it as a
 * spec. No model is called and nothing is written.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { OrbitError } from '../../core/errors.ts';
import { issueReaderFor, type IssueReader } from '../../intake/github.ts';
import { looksLikeIssueRef, parseIssueRef, readIssue } from '../../intake/issue.ts';
import { checkSpec, scenariosOf } from '../../intake/spec.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import type { Args, OptionSpec } from '../args.ts';
import { resolveRepo, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { json, line } from '../io.ts';
import { loadCommandPolicy } from '../policy-file.ts';

export const SPEC_CHECK_USAGE = 'orbit spec check <file | issue> [--policy <path>] [--json]';
export const SPEC_CHECK_OPTIONS: OptionSpec = {
  policy: { type: 'string', description: 'policy file (default: .orbit/config.yaml); read only to find the repository of an issue', valueName: 'path' },
};

/** A larger file is not a spec: refuse it instead of reading it. */
const FILE_MAX_BYTES = 1024 * 1024;

/** The reader for the checkout's repository: the test seam, else the one the policy selects. */
export async function issueReader(ctx: CliContext, repo: string, config: OrbitConfig): Promise<IssueReader> {
  return ctx.seams.issues ? ctx.seams.issues(repo, config) : issueReaderFor(repo, config, ctx.env);
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export async function specCheckCommand(args: Args, ctx: CliContext): Promise<number> {
  const [target] = args.expect(1);
  let body: string;
  let prefix = '';
  let source: Record<string, unknown>;
  // A word that reads as an issue reference is one; a file with such a name is named with a path (./42).
  if (looksLikeIssueRef(target!)) {
    const repo = await resolveRepo(ctx, args.str('repo'));
    const config = loadCommandPolicy(repo, ctx.cwd, args.str('policy'), {});
    const issue = await readIssue({ ref: parseIssueRef(target!), reader: await issueReader(ctx, repo, config) });
    body = issue.body;
    prefix = `issue ${issue.repo}#${issue.number}: `;
    source = { issue: { repo: issue.repo, number: issue.number, updated_at: issue.updatedAt } };
  } else {
    const path = resolve(ctx.cwd, target!);
    if (!existsSync(path) || !statSync(path).isFile()) throw new OrbitError('NOT_FOUND', `no such file: ${target} (an issue is named by its number, #number, owner/repo#number or URL)`);
    if (statSync(path).size > FILE_MAX_BYTES) throw new OrbitError('SCHEMA_INVALID', `${target} is larger than ${FILE_MAX_BYTES} bytes; that is not a spec`);
    body = readFileSync(path, 'utf8');
    source = { file: target };
  }
  const check = checkSpec(body);
  const scenarios = scenariosOf(check.parsed);
  if (args.bool('json')) {
    json(ctx.io, { ok: check.ok, ...source, problems: check.problems, stories: check.parsed.stories.length, scenarios: scenarios.map((s) => s.key), requirements: check.parsed.requirements.map((r) => r.id), success_criteria: check.parsed.successCriteria.map((c) => c.id), implementation_notes: check.parsed.hints !== null });
  } else if (check.ok) {
    line(ctx.io, `${prefix}spec check passed: ${count(check.parsed.stories.length, 'story', 'stories')}, ${count(scenarios.length, 'acceptance scenario')}, ${count(check.parsed.requirements.length, 'requirement')}, ${count(check.parsed.successCriteria.length, 'success criterion', 'success criteria')}`);
  } else {
    ctx.io.err(`${prefix}spec check failed: ${count(check.problems.length, 'problem')}\n`);
    for (const p of check.problems) ctx.io.err(`  - ${p}\n`);
  }
  return check.ok ? EXIT.OK : EXIT.CONFIG;
}
