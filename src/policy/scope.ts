/**
 * Independent inspection of a candidate (spec §5 "Inspect final diffs
 * independently of tool hooks"). Whatever the worker did, through tools the
 * hook saw or shell commands it did not, ends up in the candidate tree; this
 * compares that tree with the base and reports every way it leaves the
 * authorized scope. It is the gate the hooks only assist.
 *
 * git runs through execFile with a fixed argv (no shell), a scrubbed
 * environment (no system or global config, no replace refs, literal
 * pathspecs) and flags that keep repository configuration from running
 * programs or hiding text (no external diff, no textconv, --text where
 * attributes could mark text as binary).
 */
import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { canonicalJson } from '../core/hash.ts';
import type { ScopeReport } from '../evidence/types.ts';
import type { PolicySnapshot } from './types.ts';
import { BUILTIN_PROTECTED_PATHS } from './builtin.ts';
import { compileGlobs } from './globs.ts';
import { gitTreeReader, loadTestLayout } from './test-files.ts';
import { detectWeakening, type WeakeningInput } from './weakening.ts';

export interface ScopeInput {
  repoRoot: string;
  baseRev: string;
  candidateRev: string;
  snapshot: PolicySnapshot;
  /** Visual baseline globs; defaults to the snapshot's ui.visual.baseline_globs. */
  uiBaselineGlobs?: readonly string[];
  /**
   * A narrower scope from the goal contract. When given, a path must match
   * both the policy's allowed_paths and these to be in scope.
   */
  contractAllowedPaths?: readonly string[];
}

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'deno.lock',
  'Cargo.lock', 'go.sum', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'pdm.lock', 'Gemfile.lock', 'composer.lock',
  'packages.lock.json', 'Package.resolved', 'gradle.lockfile', 'flake.lock', 'mix.lock', 'pubspec.lock', 'Podfile.lock',
]);

// trustedDependencies (bun) and patchedDependencies decide which packages run install scripts or get patched.
const JS_DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies', 'overrides', 'resolutions', 'peerDependenciesMeta', 'packageManager', 'engines', 'trustedDependencies', 'patchedDependencies', 'workspaces'];
const COMPOSER_DEP_SECTIONS = ['require', 'require-dev', 'conflict', 'replace', 'provide', 'repositories'];

const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

/**
 * Formats that are binary by nature. Anything else git calls binary is
 * inspected as text: one NUL byte in a test file is enough for git to call it
 * binary, which would otherwise hide both its removed assertions and its
 * added lines.
 */
const BINARY_ASSET = /\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|psd|heic|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|ear|class|so|dylib|dll|exe|o|a|lib|wasm|woff2?|ttf|otf|eot|mp3|mp4|m4a|aac|wav|ogg|oga|webm|mov|avi|mkv|flac|sqlite3?|db|pyc|pyo|node|bin|lockb)$/i;

export async function inspectScope(input: ScopeInput): Promise<ScopeReport> {
  const { repoRoot, snapshot } = input;
  const base = await verifyRev(repoRoot, input.baseRev);
  const cand = await verifyRev(repoRoot, input.candidateRev);
  const config = snapshot.config;

  // --ignore-submodules=none: diff.ignoreSubmodules or a .gitmodules "ignore" setting would otherwise hide submodule pointer changes.
  const changes = parseNameStatus(await git(repoRoot, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', base, cand, '--']));
  const numstat = parseNumstat(await git(repoRoot, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', base, cand, '--']));

  const protectedGlobs = [...new Set([...BUILTIN_PROTECTED_PATHS, ...(snapshot.effective_protected_paths ?? []), ...config.scope.protected_paths])];
  const isProtected = compileGlobs(protectedGlobs, { nocase: true });
  const policyAllowed = compileGlobs(config.scope.allowed_paths, { nocase: false });
  const contractAllowed = input.contractAllowedPaths ? compileGlobs(input.contractAllowedPaths, { nocase: false }) : null;
  const baselineGlobs = input.uiBaselineGlobs ?? config.ui?.visual.baseline_globs ?? [];
  const isBaseline = compileGlobs(baselineGlobs, { nocase: false });

  const forbidden: string[] = [];
  const outOfScope: string[] = [];
  const visual: string[] = [];
  for (const { path } of changes) {
    if (isProtected(path)) forbidden.push(path);
    else if (!policyAllowed(path) || (contractAllowed !== null && !contractAllowed(path))) outOfScope.push(path);
    if (isBaseline(path)) visual.push(path);
  }

  // Lines: binary entries count as zero unless git only calls them binary
  // because of an attribute (`*.ts -diff` hides text from numstat even with
  // --text); those are counted from the --text patch instead.
  let changedLines = 0;
  const binary = new Set<string>();
  for (const entry of numstat) {
    if (entry.binary) binary.add(entry.path);
    else changedLines += entry.added + entry.deleted;
  }
  const forcedText = await textLooking(repoRoot, base, cand, changes, binary);
  for (const p of forcedText) binary.delete(p);

  const lockfileChanged = changes.some((c) => LOCKFILES.has(posix.basename(c.path)));
  const manifests = await dependencyManifestChanges(repoRoot, base, cand, changes);
  const symlinks = await escapingSymlinks(repoRoot, cand, changes, isProtected);

  const textChanges = changes.filter((c) => !binary.has(c.path));
  const diffs = await perFileDiffs(repoRoot, base, cand, textChanges.map((c) => c.path));
  for (const p of forcedText) changedLines += countPatchLines(diffs.get(p) ?? '');
  const weakeningInputs: WeakeningInput[] = changes.map((c) => ({ path: c.path, status: c.status, diff: diffs.get(c.path) ?? '' }));
  // Which changed files are tests depends on project files of both trees (.NET test projects, Rust crates; ADR 0011).
  const testLayout = await loadTestLayout(gitTreeReader(async (args) => (await git(repoRoot, [...args])).toString('utf8')), base, cand, changes.map((c) => c.path));
  const weakening = detectWeakening(weakeningInputs, testLayout);

  const limits = config.scheduler.hard_limits;
  return {
    allowed_paths_pass: forbidden.length === 0 && outOfScope.length === 0,
    forbidden_paths_changed: forbidden,
    out_of_scope_paths_changed: outOfScope,
    changed_files: changes.length,
    changed_lines: changedLines,
    within_size_limits: changes.length <= limits.changed_files && changedLines <= limits.changed_lines,
    lockfile_changed: lockfileChanged,
    dependency_manifest_changed: manifests,
    symlinks_escaping: symlinks,
    weakening_signals: weakening,
    visual_baseline_changes: visual,
  };
}

// ---------------------------------------------------------------------------
// git

interface Change {
  status: 'A' | 'M' | 'D' | 'T';
  path: string;
}

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ATTR_NOSYSTEM: '1',
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

function git(repoRoot: string, args: string[]): Promise<Buffer> {
  // Config overrides that stop repository settings from running programs during inspection.
  const argv = ['-C', repoRoot, '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'core.hooksPath=/dev/null', ...args];
  return new Promise((resolvePromise, reject) => {
    execFile('git', argv, { env: gitEnv(), encoding: 'buffer', maxBuffer: MAX_GIT_OUTPUT, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : String(stderr ?? '');
        reject(new OrbitError('GIT_FAILED', `git ${args[0]} failed: ${msg || (err as Error).message}`, { args }, { cause: err }));
        return;
      }
      resolvePromise(stdout as Buffer);
    });
  });
}

async function verifyRev(repoRoot: string, rev: string): Promise<string> {
  if (typeof rev !== 'string' || rev.length === 0 || rev.startsWith('-') || /[\s\0]/.test(rev) || rev.length > 256) {
    throw new OrbitError('GIT_FAILED', `invalid revision ${JSON.stringify(rev)}`);
  }
  const out = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const sha = out.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new OrbitError('GIT_FAILED', `revision ${rev} does not name a commit`);
  return sha;
}

function parseNameStatus(buf: Buffer): Change[] {
  const parts = buf.toString('utf8').split('\0');
  const out: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!.charAt(0);
    const path = parts[i + 1]!;
    if (!path) continue;
    // With --no-renames only A, M, D, T (and U for unmerged, which a commit-to-commit diff never has) appear.
    const s = status === 'A' || status === 'D' || status === 'T' ? status : 'M';
    out.push({ status: s, path });
  }
  return out;
}

interface NumstatEntry {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}

function parseNumstat(buf: Buffer): NumstatEntry[] {
  const out: NumstatEntry[] = [];
  for (const rec of buf.toString('utf8').split('\0')) {
    if (!rec) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    out.push({ path: m[3]!, added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary });
  }
  return out;
}

async function blob(repoRoot: string, rev: string, path: string): Promise<Buffer | null> {
  try {
    return await git(repoRoot, ['cat-file', 'blob', `${rev}:${path}`]);
  } catch {
    return null;
  }
}

/**
 * Paths git called binary that are inspected as text anyway: those whose
 * content has no NUL in the first 8000 bytes (git's own heuristic, so an
 * attribute did that) and those that are not a binary format by name.
 */
async function textLooking(repoRoot: string, base: string, cand: string, changes: Change[], binary: Set<string>): Promise<string[]> {
  const out: string[] = [];
  for (const c of changes) {
    if (!binary.has(c.path)) continue;
    if (!BINARY_ASSET.test(c.path)) {
      out.push(c.path);
      continue;
    }
    const content = (await blob(repoRoot, c.status === 'D' ? base : cand, c.path)) ?? Buffer.alloc(0);
    if (!content.subarray(0, 8000).includes(0)) out.push(c.path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependencies

async function dependencyManifestChanges(repoRoot: string, base: string, cand: string, changes: Change[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of changes) {
    const name = posix.basename(c.path);
    const kind = manifestKind(name);
    if (!kind) continue;
    const before = c.status === 'A' ? null : await blob(repoRoot, base, c.path);
    const after = c.status === 'D' ? null : await blob(repoRoot, cand, c.path);
    if (dependencySignature(kind, before) !== dependencySignature(kind, after)) out.push(c.path);
  }
  return out;
}

type ManifestKind = 'package.json' | 'composer.json' | 'deno.json' | 'toml' | 'whole';

function manifestKind(name: string): ManifestKind | null {
  if (name === 'package.json') return 'package.json';
  if (name === 'composer.json') return 'composer.json';
  if (name === 'deno.json' || name === 'deno.jsonc') return 'deno.json';
  if (name === 'Cargo.toml' || name === 'pyproject.toml' || name === 'Pipfile') return 'toml';
  // Package-manager configuration that chooses registries, overrides or which packages may run build scripts counts too.
  if (/^requirements.*\.(txt|in)$/.test(name) || ['go.mod', 'Gemfile', 'setup.py', 'setup.cfg', 'build.gradle', 'build.gradle.kts', 'pom.xml', 'Package.swift', 'mix.exs', 'pubspec.yaml', 'Podfile', 'environment.yml', 'environment.yaml', 'constraints.txt', 'pnpm-workspace.yaml', '.pnpmfile.cjs', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', 'pip.conf', '.pip.conf', 'uv.toml'].includes(name) || /\.(csproj|fsproj|vbproj)$/.test(name)) return 'whole';
  return null;
}

/**
 * The dependency-relevant part of a manifest as a comparable string. JSON
 * manifests are compared structurally (key order and formatting do not
 * matter); TOML manifests by their dependency sections; the rest as a whole,
 * ignoring blank lines and comment lines. Unparseable content compares by
 * its raw text, so a broken manifest is never mistaken for an unchanged one.
 */
function dependencySignature(kind: ManifestKind, content: Buffer | null): string {
  if (content === null) return '<absent>';
  const text = content.toString('utf8');
  if (kind === 'package.json' || kind === 'composer.json' || kind === 'deno.json') {
    const sections = kind === 'package.json' ? JS_DEP_SECTIONS : kind === 'composer.json' ? COMPOSER_DEP_SECTIONS : ['imports', 'scopes'];
    let parsed: unknown;
    try {
      parsed = JSON.parse(kind === 'deno.json' ? stripJsonComments(text) : text);
    } catch {
      return `<unparseable>${text}`;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return `<unparseable>${text}`;
    const obj = parsed as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const s of sections) if (s in obj) picked[s] = obj[s];
    // pnpm keeps overrides under "pnpm".
    if (kind === 'package.json' && obj.pnpm && typeof obj.pnpm === 'object') {
      const pnpm = obj.pnpm as Record<string, unknown>;
      for (const s of ['overrides', 'patchedDependencies', 'onlyBuiltDependencies', 'neverBuiltDependencies']) if (s in pnpm) picked[`pnpm.${s}`] = pnpm[s];
    }
    return canonicalJson(picked);
  }
  if (kind === 'toml') return tomlDependencySections(text);
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'))
    .join('\n');
}

/** Section bodies whose header names dependencies, plus PEP 621 `dependencies = [...]` inside [project]. */
function tomlDependencySections(text: string): string {
  const out: string[] = [];
  let section = '';
  let capture = false;
  let inArray = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      capture = /(^|\.)(dependencies|dev-dependencies|build-dependencies|optional-dependencies|dependency-groups|packages|dev-packages|requires|patch|replace|source)(\.|$)/.test(section) || /^tool\.poetry\.group\..*\.dependencies$/.test(section) || /^tool\.uv(\.|$)/.test(section);
      inArray = false;
      if (capture) out.push(`[${section}]`);
      continue;
    }
    if (capture) {
      out.push(line);
      continue;
    }
    if (section === 'project' && (inArray || /^(dependencies|requires-python)\s*=/.test(line))) {
      out.push(`project:${line}`);
      if (/^dependencies\s*=\s*\[/.test(line) && !line.includes(']')) inArray = true;
      else if (inArray && line.includes(']')) inArray = false;
    }
  }
  return out.join('\n');
}

function stripJsonComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------------
// Symlinks

/**
 * Changed symlinks whose target, resolved inside the candidate tree (links to
 * links included), leaves the repository or lands on a protected path.
 */
async function escapingSymlinks(repoRoot: string, cand: string, changes: Change[], isProtected: (p: string) => boolean): Promise<string[]> {
  const tree = (await git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', cand])).toString('utf8');
  const links = new Map<string, string>();
  for (const rec of tree.split('\0')) {
    const m = /^120000 blob ([0-9a-f]+)\t(.*)$/s.exec(rec);
    if (m) links.set(m[2]!, m[1]!);
  }
  const targets = new Map<string, string>();
  const targetOf = async (link: string): Promise<string> => {
    const cached = targets.get(link);
    if (cached !== undefined) return cached;
    const oid = links.get(link)!;
    const t = (await git(repoRoot, ['cat-file', 'blob', oid])).toString('utf8');
    targets.set(link, t);
    return t;
  };
  const out: string[] = [];
  for (const c of changes) {
    if (c.status === 'D' || !links.has(c.path)) continue;
    const verdict = await resolveInTree(c.path, links, targetOf);
    if (verdict.escapes || isProtected(verdict.path)) out.push(c.path);
  }
  return out;
}

async function resolveInTree(link: string, links: Map<string, string>, targetOf: (l: string) => Promise<string>): Promise<{ escapes: boolean; path: string }> {
  let cur: string[] = link.split('/').slice(0, -1);
  let pending: string[];
  const first = await targetOf(link);
  if (first.startsWith('/') || /^[A-Za-z]:[\\/]/.test(first) || first.startsWith('~')) return { escapes: true, path: first };
  pending = first.split(/[\\/]+/);
  let hops = 1;
  while (pending.length > 0) {
    const seg = pending.shift()!;
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (cur.length === 0) return { escapes: true, path: '..' };
      cur.pop();
      continue;
    }
    const next = [...cur, seg].join('/');
    if (links.has(next)) {
      hops += 1;
      if (hops > 40) return { escapes: true, path: next };
      const t = await targetOf(next);
      if (t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t) || t.startsWith('~')) return { escapes: true, path: t };
      pending = [...t.split(/[\\/]+/), ...pending];
      continue;
    }
    cur = [...cur, seg];
  }
  return { escapes: false, path: cur.join('/') };
}

// ---------------------------------------------------------------------------
// Per-file patches for weakening detection

/**
 * One `git diff` for all text paths, split by file header. Headers are
 * matched against the exact paths from name-status, so a path with spaces or
 * quotes cannot be mis-split.
 */
async function perFileDiffs(repoRoot: string, base: string, cand: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const headers = new Map<string, string>();
  for (const p of paths) {
    headers.set(`diff --git a/${p} b/${p}`, p);
    headers.set(`diff --git "a/${cquote(p)}" "b/${cquote(p)}"`, p);
  }
  const CHUNK = 400;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const text = (await git(repoRoot, ['diff', '-U3', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none', '--text', '--src-prefix=a/', '--dst-prefix=b/', base, cand, '--', ...chunk])).toString('utf8');
    let current: string | null = null;
    let lines: string[] = [];
    const flush = () => {
      if (current !== null) out.set(current, lines.join('\n'));
    };
    for (const line of text.split('\n')) {
      const hit = line.startsWith('diff --git ') ? headers.get(line) : undefined;
      if (hit !== undefined) {
        flush();
        current = hit;
        lines = [line];
        continue;
      }
      if (current !== null) lines.push(line);
    }
    flush();
  }
  return out;
}

/** Added plus deleted lines in one file's patch, counting only lines inside hunks. */
function countPatchLines(patch: string): number {
  let n = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && (line.startsWith('+') || line.startsWith('-'))) n++;
  }
  return n;
}

/** git's C-style path quoting (quote_c_style) with core.quotepath=false. */
function cquote(p: string): string {
  let out = '';
  for (const ch of p) {
    const code = ch.charCodeAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\x07') out += '\\a';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\v') out += '\\v';
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return out;
}
