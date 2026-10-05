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
import { loadConfig } from '../../policy/index.ts';
import { orbitInstallDir } from '../../controller/index.ts';
import type { Args } from '../args.ts';
import { gitEnv, resolveRepo, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { json, line } from '../io.ts';
import { suggestAllowedPaths, trackedFiles } from '../layout.ts';
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

async function excludeFile(ctx: CliContext, repo: string): Promise<string> {
  const r = await execCapture(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd: repo, env: gitEnv(ctx.env), timeoutMs: 15_000 });
  if (r.exitCode !== 0 || !r.stdout.trim()) throw new OrbitError('GIT_FAILED', `cannot locate .git/info/exclude: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout.trim();
}

export async function initCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const configPath = join(repo, '.orbit', 'config.yaml');
  let config: 'created' | 'exists';
  // The paths derived from the repository's layout, when the template's own do not fit it (P24).
  let derivedPaths: string[] = [];
  if (existsSync(configPath)) config = 'exists';
  else {
    let text = templateText();
    mkdirSync(dirname(configPath), { recursive: true });
    derivedPaths = suggestAllowedPaths(await trackedFiles(ctx, repo));
    if (derivedPaths.length > 0) text = text.replace(/^(\s*allowed_paths: )\[.*\]$/m, `$1[${derivedPaths.map((x) => JSON.stringify(x)).join(', ')}]`);
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

  if (args.bool('json')) {
    json(ctx.io, { repo, config: { path: configPath, status: config, ...(derivedPaths.length > 0 ? { allowed_paths: derivedPaths } : {}) }, exclude: { path: excludePath, added: missing }, config_problems: problems });
    return EXIT.OK;
  }
  line(ctx.io, config === 'created' ? `created ${configPath} from the starter template (review it: it is the authority every run works under)` : `${configPath} already exists; left unchanged`);
  if (config === 'created' && derivedPaths.length > 0) line(ctx.io, `scope.allowed_paths set to ${derivedPaths.join(', ')} from the repository layout (the template's apps/, packages/ and docs/ matched nothing here); review it`);
  line(ctx.io, missing.length > 0 ? `added ${missing.length} rule(s) to ${excludePath} so runtime state stays out of git status` : `${excludePath} already excludes Orbit runtime state`);
  if (problems.length > 0) {
    line(ctx.io, 'The configuration does not validate yet:');
    for (const p of problems.slice(0, 10)) line(ctx.io, `  - ${p}`);
  } else line(ctx.io, 'The configuration validates.');
  line(ctx.io, `Next: define your checks in .orbit/config.yaml, then run ${orbitHint('doctor')}.`);
  return EXIT.OK;
}
