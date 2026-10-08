/**
 * `orbit init`: write .orbit/config.yaml from the starter template when it is
 * absent, and keep Orbit's runtime files out of `git status` through
 * .git/info/exclude (a per-clone file, so nothing is committed). It never
 * overwrites anything and is safe to run repeatedly.
 *
 * That file is per clone, not per working tree: git reads only the common git
 * directory's info/exclude, so in a linked worktree (`git worktree add`) the
 * rules land in the main checkout's git directory, outside the worktree, and
 * one write covers every worktree of the clone (issue 3). Orbit keeps that on
 * purpose and says so: when the repository root is a linked worktree the text
 * output states that every worktree shares the file, whether the rules were
 * added or already there, and --json carries `exclude_file` (the path and
 * `shared_across_worktrees`) next to the unchanged `exclude`. A normal
 * checkout prints exactly what it always did.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { OrbitError } from '../../core/errors.ts';
import { execCapture } from '../../core/exec.ts';
import { defaultConfig, loadConfig } from '../../policy/index.ts';
import { openDb } from '../../storage/db.ts';
import { providerKind } from '../../adapters/index.ts';
import { ModelRegistry } from '../../routing/registry.ts';
import { sharedCatalogPath } from '../../routing/shared-catalog.ts';
import { stateDbPath } from '../../controller/start.ts';
import { readCodexCatalog } from './models.ts';
import { orbitInstallDir } from '../../controller/index.ts';
import type { Args } from '../args.ts';
import { gitEnv, resolveRepo, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { json, line } from '../io.ts';
import { proposeScope, trackedFiles } from '../layout.ts';
import { compileGlobs } from '../../policy/globs.ts';
import { orbitHint } from '../../core/invocation.ts';
import { detectChecks, renderChecksYaml, type CheckProposal } from '../check-detect.ts';

/**
 * What the starter's review policy does and how to choose otherwise (docs/decisions/0007-reviewer-availability.md):
 * the default is written, and the person is told how to pick ask or block.
 */
export const REVIEW_POLICY_PROPOSAL =
  'review: Codex would review independently (review.providers: [codex]), but the template sets providers.codex.data_policy_eligible: false, so Codex does not review until you set it to true in .orbit/config.yaml (only if sending sanitized code and diffs to Codex is permitted for this repository); until then Claude reviews in a separate session and every report says the review was not independent and why (review.when_unavailable: claude). Set review.when_unavailable to ask to be asked first, or to block to require an independent reviewer.';

/**
 * The review policy sentence for the config just written: where Codex is eligible in it, Codex reviews when it is usable;
 * where it is not (the template's value), saying so would be false without the one line that enables it (issue #33).
 */
export function reviewPolicyProposal(codexEligible: boolean): string {
  return codexEligible
    ? 'review: Codex reviews independently when it is usable (review.providers: [codex]); when it is not, Claude reviews in a separate session and every report says the review was not independent and why (review.when_unavailable: claude). Set review.when_unavailable to ask to be asked first, or to block to require an independent reviewer.'
    : REVIEW_POLICY_PROPOSAL;
}

/**
 * The check ids a configuration file declares, read without validating it: a file that fails validation for another
 * reason still defines its checks, and "define your checks" is not the next step for it (issue #33). Empty for a file that
 * is not YAML or has no `checks` mapping.
 */
function declaredCheckIds(path: string): string[] {
  try {
    const doc = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true, prettyErrors: false, strict: true });
    if (doc.errors.length > 0) return [];
    const checks = (doc.toJS({ maxAliasCount: 50 }) as { checks?: unknown } | null)?.checks;
    return checks !== null && typeof checks === 'object' && !Array.isArray(checks) ? Object.keys(checks) : [];
  } catch {
    return [];
  }
}

/** Runtime state only. config.yaml is deliberately not here: it is reviewed like code and normally committed. */
export const EXCLUDE_RULES: readonly string[] = ['/.orbit/state.sqlite*', '/.orbit/knowledge.sqlite*', '/.orbit/runs/'];
const EXCLUDE_HEADER = '# Orbit runtime state (added by "orbit init")';

/** The starter config the build inlines into the bundle (scripts/build.mjs); undefined when running from the sources. */
declare const __ORBIT_CONFIG_TEMPLATE__: string | undefined;

export function templatePath(): string {
  return join(orbitInstallDir(), 'templates', 'config.yaml');
}

/** The starter config: inlined in the bundle (the plugin ships no templates/ directory), else read from the installation. */
function templateText(): string {
  if (typeof __ORBIT_CONFIG_TEMPLATE__ === 'string') return __ORBIT_CONFIG_TEMPLATE__;
  const tpl = templatePath();
  if (!existsSync(tpl)) throw new OrbitError('NOT_FOUND', `the starter template ${tpl} is missing from this installation`);
  return readFileSync(tpl, 'utf8');
}

/** The checked-out branch, or null when HEAD is detached or the repository has no commits to name one. */
async function currentBranch(ctx: CliContext, repo: string): Promise<string | null> {
  try {
    const r = await execCapture(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], { cwd: repo, env: gitEnv(ctx.env), timeoutMs: 15_000 });
    const name = r.stdout.trim();
    return r.exitCode === 0 && name !== '' ? name : null;
  } catch {
    return null;
  }
}

async function excludeFile(ctx: CliContext, repo: string): Promise<string> {
  const r = await execCapture(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd: repo, env: gitEnv(ctx.env), timeoutMs: 15_000 });
  if (r.exitCode !== 0 || !r.stdout.trim()) throw new OrbitError('GIT_FAILED', `cannot locate .git/info/exclude: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout.trim();
}

function realOrSame(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Whether the repository root is a linked worktree: its own git directory (<common>/worktrees/<name>) is not the common
 * one it shares with the clone's other worktrees. A normal checkout, a bare clone's main tree and a submodule (whose git
 * directory is its own common one) are not. Only the note depends on this, so a git that cannot answer means "no".
 */
async function inLinkedWorktree(ctx: CliContext, repo: string): Promise<boolean> {
  try {
    const r = await execCapture(['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: repo, env: gitEnv(ctx.env), timeoutMs: 15_000 });
    const [gitDir, commonDir] = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    return r.exitCode === 0 && gitDir !== undefined && commonDir !== undefined && realOrSame(gitDir) !== realOrSame(commonDir);
  } catch {
    return false;
  }
}

/** What init tells a person in a linked worktree about the file it names: where it is, and that it is not the worktree's own. */
const SHARED_EXCLUDE_NOTE = "that file is in the clone's common git directory, outside this worktree, and every worktree of this clone shares it";

/**
 * Seed the model registry and read the Codex catalog, so the first doctor or run does not fail on "no model qualified
 * for review" and send the user to "orbit models refresh" (issue 7). Read-only and with no model call: `codex debug
 * models` takes a few seconds. It uses the repository's registry when it has one and otherwise an in-memory one, so
 * init still creates no state database; the catalog is kept for the user (routing/shared-catalog.ts) and every
 * registry without Codex models adopts it. Best effort: nothing here can make init fail.
 */
async function seedModels(ctx: CliContext, repo: string): Promise<string[]> {
  const notes: string[] = [];
  let config;
  try {
    config = loadConfig(repo);
  } catch {
    config = defaultConfig();
  }
  const persisted = existsSync(stateDbPath(repo));
  let db;
  try {
    db = openDb(persisted ? stateDbPath(repo) : ':memory:');
  } catch (err) {
    return [`model registry not seeded (${err instanceof Error ? err.message.replace(/\s+/g, ' ').slice(0, 160) : 'unreadable state database'}); run ${orbitHint('models refresh')}`];
  }
  try {
    const registry = new ModelRegistry(db, ctx.clock).useSharedCatalog(sharedCatalogPath(ctx.orbitHome));
    const seeded = registry.seed();
    notes.push(`model registry seeded with ${seeded.inserted.length + seeded.updated.length} shipped model(s)`);
    for (const [id, pc] of Object.entries(config.providers)) {
      let kind: string;
      try {
        kind = providerKind(id);
      } catch {
        continue;
      }
      if (kind !== 'codex') continue;
      const outcome = await readCodexCatalog(registry, id, pc.command, repo, ctx, 30_000);
      notes.push(outcome.change !== undefined ? outcome.note : `${outcome.note}; run ${orbitHint('models refresh')} once it works`);
    }
  } catch (err) {
    notes.push(`model registry not seeded (${err instanceof Error ? err.message.replace(/\s+/g, ' ').slice(0, 160) : 'unknown error'}); run ${orbitHint('models refresh')}`);
  } finally {
    db.close();
  }
  return notes;
}

export async function initCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const configPath = join(repo, '.orbit', 'config.yaml');
  let config: 'created' | 'exists';
  // The paths derived from the repository's layout, when the template's own do not fit it (P24).
  let derivedPaths: string[] = [];
  // CI pipeline and build-system definitions found in the repository, protected in the proposal; and the folders left out of scope for holding them.
  let protectedAdded: string[] = [];
  let excludedDirs: string[] = [];
  let baseBranch: string | null = null;
  // Checks proposed from what the repository declares; only for a config init writes, never for an existing one.
  let checkProposal: CheckProposal = { proposed: [], notProposed: [] };
  if (existsSync(configPath)) config = 'exists';
  else {
    let text = templateText();
    mkdirSync(dirname(configPath), { recursive: true });
    const proposal = await proposeScope(ctx, repo);
    derivedPaths = proposal.allowed;
    excludedDirs = proposal.excluded;
    // The template's own protections (.github/**, infra/**, env files) are not repeated.
    const have = text.match(/^\s*protected_paths: \[(.*)\]$/m)?.[1] ?? '';
    protectedAdded = proposal.protectedExtra.filter((g) => !have.includes(JSON.stringify(g)));
    // The branch the repository is on, not the template's "main": a master repository would otherwise start with a
    // base branch that does not exist, which only doctor noticed.
    baseBranch = await currentBranch(ctx, repo);
    if (baseBranch !== null && baseBranch !== 'main') text = text.replace(/^(\s*base_branch: ).*$/m, `$1${JSON.stringify(baseBranch)}`);
    else baseBranch = null;
    if (derivedPaths.length > 0) text = text.replace(/^(\s*allowed_paths: )\[.*\]$/m, `$1[${derivedPaths.map((x) => JSON.stringify(x)).join(', ')}]`);
    if (protectedAdded.length > 0) {
      // Appended to the template's own list, so its defaults (.github/**, infra/**, env files) stay.
      text = text.replace(/^(\s*protected_paths: \[.*?)\]$/m, (_m, head: string) => `${head}, ${protectedAdded.map((x) => JSON.stringify(x)).join(', ')}]`);
    }
    checkProposal = await detectChecks({ repo, files: await trackedFiles(ctx, repo), pathEnv: ctx.env.PATH });
    if (checkProposal.proposed.length > 0) {
      const block = renderChecksYaml(checkProposal.proposed);
      text = text.replace(/^checks:\n/m, () => `checks:\n${block}`);
    }
    try {
      // wx: never replace a file that appeared since the check above.
      writeFileSync(configPath, text, { flag: 'wx', mode: 0o644 });
      config = 'created';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      config = 'exists';
    }
  }

  const excludePath = await excludeFile(ctx, repo);
  const sharedAcrossWorktrees = await inLinkedWorktree(ctx, repo);
  mkdirSync(dirname(excludePath), { recursive: true });
  const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const missing = EXCLUDE_RULES.filter((r) => !have.has(r));
  if (missing.length > 0) {
    const block = `${current === '' || current.endsWith('\n') ? '' : '\n'}${have.has(EXCLUDE_HEADER) ? '' : `${EXCLUDE_HEADER}\n`}${missing.join('\n')}\n`;
    appendFileSync(excludePath, block);
  }

  // The starter is a template, not a working policy; say what still needs attention rather than pretending it is ready.
  let problems: string[] = [];
  try {
    loadConfig(repo);
  } catch (err) {
    problems = err instanceof OrbitError && Array.isArray(err.details?.problems) ? (err.details.problems as string[]) : [err instanceof Error ? err.message : String(err)];
  }

  // Nothing to scope to is not a valid starting point either: the policy would let a worker change nothing.
  const warnings: string[] = [];
  if (problems.length === 0) {
    const files = await trackedFiles(ctx, repo);
    const globs = loadConfig(repo).scope.allowed_paths;
    const matches = compileGlobs(globs, { nocase: false });
    if (files.length > 0 && !files.some((f) => matches(f))) {
      warnings.push(`scope.allowed_paths (${globs.join(', ')}) matches no tracked file, so a worker could change nothing; set scope.allowed_paths in .orbit/config.yaml to globs that match the files a worker may change`);
    }
  }

  const models = await seedModels(ctx, repo);

  // What the configuration on disk says, for the review sentence and the next step (issue #33): whether Codex is
  // eligible, and which checks it already defines. A configuration that does not validate says nothing of Codex, but its
  // checks are still read from the file.
  let codexEligible = false;
  let defined: string[];
  if (problems.length === 0) {
    const loaded = loadConfig(repo);
    codexEligible = loaded.providers.codex?.data_policy_eligible === true;
    defined = Object.keys(loaded.checks);
  } else defined = declaredCheckIds(configPath);
  const reviewPolicy = reviewPolicyProposal(codexEligible);

  if (args.bool('json')) {
    json(ctx.io, { repo, review_policy: config === 'created' ? reviewPolicy : null, config: { path: configPath, status: config, ...(derivedPaths.length > 0 ? { allowed_paths: derivedPaths } : {}), ...(protectedAdded.length > 0 ? { protected_paths_added: protectedAdded } : {}), ...(excludedDirs.length > 0 ? { excluded_dirs: excludedDirs } : {}), ...(baseBranch !== null ? { base_branch: baseBranch } : {}) }, exclude: { path: excludePath, added: missing }, exclude_file: { path: excludePath, shared_across_worktrees: sharedAcrossWorktrees }, checks: { proposed: checkProposal.proposed, not_proposed: checkProposal.notProposed }, checks_defined: defined, config_problems: problems, warnings, models });
    return EXIT.OK;
  }
  line(ctx.io, config === 'created' ? `created ${configPath} from the starter template (review it: it is the authority every run works under)` : `${configPath} already exists; left unchanged`);
  if (config === 'created' && baseBranch !== null) line(ctx.io, `repository.base_branch set to ${baseBranch} from the checked-out branch (the template says main); review it`);
  if (config === 'created' && derivedPaths.length > 0) line(ctx.io, `scope.allowed_paths set to ${derivedPaths.join(', ')} from the repository layout (the template's paths matched nothing here); review it`);
  if (config === 'created' && excludedDirs.length > 0) line(ctx.io, `left out of scope.allowed_paths because they hold CI or build definitions: ${excludedDirs.join(', ')}`);
  if (config === 'created' && protectedAdded.length > 0) line(ctx.io, `scope.protected_paths gained ${protectedAdded.join(', ')} (CI pipeline and build-system definitions found in the repository)`);
  if (config === 'created' && derivedPaths.length > 0) line(ctx.io, 'Narrow scope.allowed_paths to the folders your goal needs: the proposal covers every source folder, and a smaller scope is safer and cheaper to review.');
  if (config === 'created') {
    if (checkProposal.proposed.length > 0) {
      line(ctx.io, `checks proposed from what the repository declares (each is commented in the config; review them, they are the evidence every run is judged by):`);
      for (const c of checkProposal.proposed) line(ctx.io, `  ${c.id}: ${c.command.join(' ')} (${c.category}, ${c.timeout_seconds}s): ${c.reason}`);
    }
    for (const n of checkProposal.notProposed) line(ctx.io, `no check proposed for ${n.ecosystem}: ${n.reason}`);
  }
  if (missing.length > 0) line(ctx.io, `added ${missing.length} rule(s) to ${excludePath} so runtime state stays out of git status${sharedAcrossWorktrees ? `; ${SHARED_EXCLUDE_NOTE}, so one write covers them all` : ''}`);
  else line(ctx.io, `${excludePath} already excludes Orbit runtime state${sharedAcrossWorktrees ? `; ${SHARED_EXCLUDE_NOTE}` : ''}`);
  if (problems.length > 0) {
    line(ctx.io, 'The configuration does not validate yet:');
    for (const p of problems.slice(0, 10)) line(ctx.io, `  - ${p}`);
  } else line(ctx.io, 'The configuration validates.');
  for (const m of models) line(ctx.io, m);
  for (const w of warnings) line(ctx.io, `WARN: ${w}`);
  if (config === 'created') line(ctx.io, reviewPolicy);
  if (checkProposal.proposed.length > 0) line(ctx.io, `Next: review the proposed checks in .orbit/config.yaml and add any that are missing, then run ${orbitHint('doctor')}.`);
  // An existing configuration that already defines checks has nothing to define (issue #33); one that does not validate
  // has its problems to fix first.
  else if (defined.length > 0 && problems.length > 0) line(ctx.io, `Next: the configuration defines checks (${defined.join(', ')}) but does not validate: fix the problems above, then run ${orbitHint('doctor')}.`);
  else if (defined.length > 0) line(ctx.io, `Next: the configuration already defines checks (${defined.join(', ')}); run ${orbitHint('doctor')} to see whether they can run here.`);
  else line(ctx.io, `Next: define your checks in .orbit/config.yaml, then run ${orbitHint('doctor')}.`);
  return EXIT.OK;
}
