#!/usr/bin/env node
// Checks the plugin payload, plugin/ (docs/decisions/0006-plugin-packaging.md):
//   1. `claude plugin validate --strict plugin/`;
//   2. frontmatter keys, which the validator does not flag when ignored, against the verified lists in
//      docs/interfaces/claude-code-plugin.md;
//   3. the payload holds exactly the allowed files, and its package.json and lockfile carry one registry dependency,
//      @anthropic-ai/sandbox-runtime at the version the srt preload is verified against, and nothing a development
//      install would add (Claude Code runs `npm ci` on a marketplace install of the plugin).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = join(root, 'plugin');

export const SKILL_KEYS = new Set([
  'name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation',
  'user-invocable', 'allowed-tools', 'disallowed-tools', 'model', 'effort', 'context', 'agent',
  'background', 'hooks', 'paths', 'shell', 'metadata', 'license', 'compatibility',
]);
// Plugin agents silently ignore permissionMode, hooks, mcpServers and initialPrompt, so they are errors here.
export const AGENT_KEYS = new Set([
  'name', 'description', 'model', 'effort', 'maxTurns', 'tools', 'disallowedTools', 'skills',
  'memory', 'background', 'omitClaudeMd', 'isolation', 'color', 'experimental',
]);

const SRT_PACKAGE = '@anthropic-ai/sandbox-runtime';

/** Every file the payload may hold, as paths relative to plugin/. */
const ALLOWED = [
  /^\.claude-plugin\/plugin\.json$/,
  /^dist\/(orbit|srt-chromium-preload)\.mjs$/,
  /^hooks\/hooks\.json$/,
  /^hooks\/[a-z-]+\.mjs$/,
  /^skills\/[a-z-]+\/SKILL\.md$/,
  /^agents\/[a-z-]+\.md$/,
  /^bin\/orbit$/,
  /^package\.json$/,
  /^package-lock\.json$/,
];
const REQUIRED = ['.claude-plugin/plugin.json', 'dist/orbit.mjs', 'dist/srt-chromium-preload.mjs', 'hooks/hooks.json', 'bin/orbit', 'package.json', 'package-lock.json'];
/** package.json keys the payload may use; anything else (devDependencies, scripts, overrides, ...) is a development concern. */
const PACKAGE_KEYS = new Set(['name', 'version', 'private', 'description', 'license', 'type', 'engines', 'dependencies']);
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/** The srt version the preload is verified against: SRT_VERIFIED_VERSION in the sources. */
function verifiedSrtVersion() {
  const src = readFileSync(join(root, 'src', 'isolation', 'sandbox-runtime.ts'), 'utf8');
  const m = /export const SRT_VERIFIED_VERSION = '([^']+)'/.exec(src);
  if (!m) throw new Error('SRT_VERIFIED_VERSION not found in src/isolation/sandbox-runtime.ts');
  return m[1];
}

export function frontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  return end < 0 ? null : parse(text.slice(4, end));
}

function walk(dir, keep, skip = () => false) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (skip(p)) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p, keep, skip));
    else if (keep(e)) out.push(p);
  }
  return out;
}

export function lint(pluginDir = PLUGIN_DIR) {
  const problems = [];
  const files = [
    ...walk(join(pluginDir, 'skills'), (f) => f === 'SKILL.md').map((p) => [p, SKILL_KEYS, 'skill']),
    ...walk(join(pluginDir, 'agents'), (f) => f.endsWith('.md')).map((p) => [p, AGENT_KEYS, 'agent']),
  ];
  for (const [path, allowed, kind] of files) {
    const rel = relative(pluginDir, path).split(sep).join('/');
    let fm;
    try { fm = frontmatter(readFileSync(path, 'utf8')); } catch (e) { problems.push(`${rel}: frontmatter does not parse: ${e.message}`); continue; }
    if (!fm || typeof fm !== 'object') { problems.push(`${rel}: missing frontmatter`); continue; }
    for (const k of Object.keys(fm)) if (!allowed.has(k)) problems.push(`${rel}: ${kind} key "${k}" is ignored or unsupported`);
    if (kind === 'skill' && fm['disable-model-invocation'] !== true) problems.push(`${rel}: Orbit skills must set disable-model-invocation: true`);
    if (!fm.description) problems.push(`${rel}: missing description`);
  }
  return problems;
}

/**
 * The files a marketplace install of `pluginDir` would receive, relative to it. Inside a git checkout these are the
 * tracked and untracked-but-not-ignored files (an ignored node_modules from a local `npm ci` is not shipped);
 * elsewhere every file except a top-level node_modules.
 */
function payloadFiles(pluginDir) {
  const git = spawnSync('git', ['-C', pluginDir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { encoding: 'utf8' });
  const inGit = git.status === 0 && spawnSync('git', ['-C', pluginDir, 'rev-parse', '--show-prefix'], { encoding: 'utf8' }).status === 0;
  if (inGit) return git.stdout.split('\0').filter((f) => f !== '' && existsSync(join(pluginDir, f)));
  const modules = join(pluginDir, 'node_modules');
  return walk(pluginDir, () => true, (p) => p === modules).map((p) => relative(pluginDir, p).split(sep).join('/'));
}

/** Where `name`, required by the lockfile entry at `from`, resolves in the lockfile (node's lookup, innermost first). */
function resolveInLock(packages, from, name) {
  let base = from;
  for (;;) {
    const key = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (packages[key]) return key;
    if (base === '') return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut < 0 ? '' : base.slice(0, cut);
  }
}

function sameDeps(actual, expected) {
  const a = actual && typeof actual === 'object' ? actual : {};
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(expected).sort());
}

/** Everything wrong with the payload in `pluginDir`; empty when it is exactly what ADR 0006 allows. */
export function payloadProblems(pluginDir = PLUGIN_DIR, opts = {}) {
  const srtVersion = opts.srtVersion ?? verifiedSrtVersion();
  const expected = { [SRT_PACKAGE]: srtVersion };
  const problems = [];

  const files = payloadFiles(pluginDir);
  for (const f of files) if (!ALLOWED.some((re) => re.test(f))) problems.push(`${f}: not part of the plugin payload (allowed: .claude-plugin/plugin.json, dist/, hooks/, skills/, agents/, bin/orbit, package.json, package-lock.json)`);
  for (const f of REQUIRED) if (!files.includes(f)) problems.push(`${f}: missing from the plugin payload`);
  const bin = join(pluginDir, 'bin', 'orbit');
  if (existsSync(bin) && (statSync(bin).mode & 0o111) === 0) problems.push('bin/orbit: not executable');

  let pkg = null;
  try { pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')); } catch (e) { problems.push(`package.json: cannot be read: ${e.message}`); }
  if (pkg) {
    for (const k of Object.keys(pkg)) if (!PACKAGE_KEYS.has(k)) problems.push(`package.json: "${k}" does not belong in the plugin package (only ${[...PACKAGE_KEYS].join(', ')})`);
    if (!sameDeps(pkg.dependencies, expected)) problems.push(`package.json: dependencies must be exactly ${JSON.stringify(expected)} (the srt version the preload is verified against), found ${JSON.stringify(pkg.dependencies ?? {})}`);
  }

  let lock = null;
  try { lock = JSON.parse(readFileSync(join(pluginDir, 'package-lock.json'), 'utf8')); } catch (e) { problems.push(`package-lock.json: cannot be read: ${e.message}`); }
  if (lock) {
    if (lock.lockfileVersion !== 3) problems.push(`package-lock.json: lockfileVersion must be 3, found ${lock.lockfileVersion}`);
    const packages = lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
    const top = packages[''] ?? {};
    if (!sameDeps(top.dependencies, expected)) problems.push(`package-lock.json: the root package must depend on exactly ${JSON.stringify(expected)}, found ${JSON.stringify(top.dependencies ?? {})}`);
    for (const k of ['devDependencies', 'optionalDependencies', 'peerDependencies']) if (top[k] && Object.keys(top[k]).length) problems.push(`package-lock.json: the root package has ${k}`);
    const srt = packages[`node_modules/${SRT_PACKAGE}`];
    if (!srt) problems.push(`package-lock.json: has no node_modules/${SRT_PACKAGE}`);
    else if (srt.version !== srtVersion) problems.push(`package-lock.json: locks ${SRT_PACKAGE} ${srt.version}, not ${srtVersion}`);

    // Every locked package must be reachable from srt: anything else is something a development install added.
    const reachable = new Set(['']);
    const queue = [''];
    while (queue.length) {
      const at = queue.shift();
      const entry = packages[at] ?? {};
      for (const field of DEP_FIELDS) {
        if (at === '' && field !== 'dependencies') continue;
        for (const name of Object.keys(entry[field] ?? {})) {
          const key = resolveInLock(packages, at, name);
          if (key && !reachable.has(key)) { reachable.add(key); queue.push(key); }
        }
      }
    }
    for (const [key, entry] of Object.entries(packages)) {
      if (key === '') continue;
      if (entry.dev || entry.devOptional) problems.push(`package-lock.json: ${key} is a development dependency`);
      else if (!reachable.has(key)) problems.push(`package-lock.json: ${key} is not a dependency of ${SRT_PACKAGE}`);
      if (entry.link) problems.push(`package-lock.json: ${key} is a link, not a registry package`);
      else if (typeof entry.resolved === 'string' && !entry.resolved.startsWith('https://registry.npmjs.org/')) problems.push(`package-lock.json: ${key} resolves outside the npm registry (${entry.resolved})`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const v = spawnSync('claude', ['plugin', 'validate', '--strict', PLUGIN_DIR], { encoding: 'utf8', timeout: 120_000 });
  process.stdout.write(v.stdout ?? '');
  process.stderr.write(v.stderr ?? '');
  if (v.error) console.error(`claude plugin validate could not run: ${v.error.message}`);
  const problems = [...lint(), ...payloadProblems()];
  for (const p of problems) console.error(p);
  if (v.status !== 0 || problems.length > 0) process.exit(1);
  console.log('plugin ok');
}
