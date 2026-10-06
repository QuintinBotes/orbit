/**
 * `orbit init`: write .orbit/config.yaml from the starter template when it is
 * absent, and keep Orbit's runtime files out of `git status` through
 * .git/info/exclude (a per-clone file, so nothing is committed or shared).
 * It never overwrites anything and is safe to run repeatedly.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

  if (args.bool('json')) {
    json(ctx.io, { repo, config: { path: configPath, status: config, ...(derivedPaths.length > 0 ? { allowed_paths: derivedPaths } : {}), ...(protectedAdded.length > 0 ? { protected_paths_added: protectedAdded } : {}), ...(excludedDirs.length > 0 ? { excluded_dirs: excludedDirs } : {}), ...(baseBranch !== null ? { base_branch: baseBranch } : {}) }, exclude: { path: excludePath, added: missing }, config_problems: problems, warnings, models });
    return EXIT.OK;
  }
  line(ctx.io, config === 'created' ? `created ${configPath} from the starter template (review it: it is the authority every run works under)` : `${configPath} already exists; left unchanged`);
  if (config === 'created' && baseBranch !== null) line(ctx.io, `repository.base_branch set to ${baseBranch} from the checked-out branch (the template says main); review it`);
  if (config === 'created' && derivedPaths.length > 0) line(ctx.io, `scope.allowed_paths set to ${derivedPaths.join(', ')} from the repository layout (the template's paths matched nothing here); review it`);
  if (config === 'created' && excludedDirs.length > 0) line(ctx.io, `left out of scope.allowed_paths because they hold CI or build definitions: ${excludedDirs.join(', ')}`);
  if (config === 'created' && protectedAdded.length > 0) line(ctx.io, `scope.protected_paths gained ${protectedAdded.join(', ')} (CI pipeline and build-system definitions found in the repository)`);
  if (config === 'created' && derivedPaths.length > 0) line(ctx.io, 'Narrow scope.allowed_paths to the folders your goal needs: the proposal covers every source folder, and a smaller scope is safer and cheaper to review.');
  line(ctx.io, missing.length > 0 ? `added ${missing.length} rule(s) to ${excludePath} so runtime state stays out of git status` : `${excludePath} already excludes Orbit runtime state`);
  if (problems.length > 0) {
    line(ctx.io, 'The configuration does not validate yet:');
    for (const p of problems.slice(0, 10)) line(ctx.io, `  - ${p}`);
  } else line(ctx.io, 'The configuration validates.');
  for (const m of models) line(ctx.io, m);
  for (const w of warnings) line(ctx.io, `WARN: ${w}`);
  line(ctx.io, `Next: define your checks in .orbit/config.yaml, then run ${orbitHint('doctor')}.`);
  return EXIT.OK;
}
