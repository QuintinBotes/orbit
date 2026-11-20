/**
 * The repository map (#175): a deterministic description of one tree, so gates need no model call to know which files
 * are generated or which tests cover a source file, and a worker can ask a structural question instead of searching.
 * It holds every tracked file with its size, a generated flag (the linguist-generated attribute, or an `@generated` or
 * `DO NOT EDIT` header), the test-to-source links (a test imports the source, shares its name, or is in its Go
 * package), the import edges of TypeScript, JavaScript, Python, Rust and Go (imports.ts), and which paths each
 * configured check's command names. Any other language gets the file list and the test links only.
 *
 * A map is built from git objects only (ls-tree, check-attr --source, cat-file), never from a working tree, and is
 * cached under the clone's common git directory by tree hash: a cached map is served only for the tree it names. A
 * new tree reuses what the newest cached map read from every unchanged blob, so a rebuild reads only changed files.
 * The cache is a convenience: a cache that cannot be read or written makes a full build, never a failed one.
 */
import { execFile } from 'node:child_process';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, posix } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { atomicWrite, readJsonIfExists } from '../core/fsx.ts';
import { gitEnv } from '../evidence/git.ts';
import { estimateTokens } from '../knowledge/text.ts';
import { repoMapPolicy } from '../policy/config.ts';
import { declaresCargoPackage, isDotnetTestProject, isTestPath, type TestLayout } from '../policy/test-files.ts';
import type { CheckDefinition, OrbitConfig } from '../policy/types.ts';
import { importSpecifiers, languageOf, resolveSpecifier, type TreeIndex } from './imports.ts';

export interface RepoMapFile {
  path: string;
  /** Bytes. */
  size: number;
  generated: boolean;
  test: boolean;
  /** Tracked files this file imports. */
  imports: string[];
  /** The test files linked to this source file. */
  tests: string[];
}

export interface RepoMap {
  tree: string;
  files: RepoMapFile[];
  /** Check id to the tracked files or directories its command or cwd names. */
  checks: Record<string, string[]>;
  /** How this build went: served from the cache, or how many blobs it read and how many it reused. */
  build: { cached: boolean; parsed: number; reused: number };
}

export type MapChecks = Readonly<Record<string, Pick<CheckDefinition, 'command' | 'cwd'>>>;

const SCHEMA = 'orbit.repomap/1';
/** Larger files are listed, not read: a source that size is generated or vendored, and its imports are not worth the time. */
const MAX_PARSE_BYTES = 1024 * 1024;
const KEEP_CACHED = 32;
/**
 * A generated header: a comment line that opens with `@generated`, or one line that names both the generator's work and
 * DO NOT EDIT. A comment that only mentions a marker (as the top of this file does) is authored code.
 */
const GENERATED_HEADER = /^\s*(?:\/\/|#|\/?\*+)\s*@generated\b|(?:[Gg]enerated|GENERATED)\b[^\n]*\bDO NOT EDIT\b|\bDO NOT EDIT\b[^\n]*(?:[Gg]enerated|GENERATED)\b/m;

/** One tracked file as stored: what the tree and the blob say, before anything is resolved against the tree. */
interface Entry {
  path: string;
  blob: string;
  size: number;
  /** linguist-generated is set on the path in this tree. */
  attr: boolean;
  /** The blob's first kilobyte carries a generated header. */
  marker: boolean;
  /** Import specifiers of a source; `module:`, `package:` or `test-project` facts of go.mod, Cargo.toml and .NET project files. */
  facts: string[];
}

interface Stored {
  schema: typeof SCHEMA;
  tree: string;
  files: Entry[];
}

export async function buildRepoMap(repoRoot: string, rev: string, opts: { checks?: MapChecks } = {}): Promise<RepoMap> {
  if (rev.startsWith('-')) throw new OrbitError('GIT_FAILED', `refusing revision ${JSON.stringify(rev)}: it would be read as an option`);
  const tree = (await gitBuf(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`])).toString('utf8').trim();
  const dir = await cacheDir(repoRoot);
  const hit = dir === null ? null : readStored(join(dir, `${tree}.json`), tree);
  if (hit) return derive(hit, opts.checks ?? {}, { cached: true, parsed: 0, reused: 0 });

  const listed = parseLsTree(await gitBuf(repoRoot, ['ls-tree', '-r', '-l', '-z', '--full-tree', tree]));
  const attrs = parseCheckAttr(await gitBuf(repoRoot, ['check-attr', '--source', tree, '-z', '--stdin', 'linguist-generated'], listed.map((e) => e.path).join('\0')));
  const previous = dir === null ? new Map<string, Pick<Entry, 'marker' | 'facts'>>() : newestBlobs(dir);
  const wanted = [...new Set(listed.filter((e) => readable(e.path, e.size) && !previous.has(blobKey(e))).map((e) => e.blob))];
  const texts = wanted.length === 0 ? new Map<string, string>() : parseBatch(await gitBuf(repoRoot, ['cat-file', '--batch'], `${wanted.join('\n')}\n`));
  let reused = 0;
  const files: Entry[] = listed.map((e) => {
    const attr = attrs.has(e.path);
    const known = previous.get(blobKey(e));
    if (known) {
      if (readable(e.path, e.size)) reused++;
      return { ...e, attr, marker: known.marker, facts: known.facts };
    }
    const text = texts.get(e.blob);
    return { ...e, attr, marker: text !== undefined && GENERATED_HEADER.test(text.slice(0, 1024)), facts: text === undefined ? [] : factsOf(e.path, text) };
  });
  const stored: Stored = { schema: SCHEMA, tree, files };
  if (dir !== null) save(dir, stored);
  return derive(stored, opts.checks ?? {}, { cached: false, parsed: wanted.length, reused });
}

/** The test files the map links to `path` (a source file); empty when it links none or does not have the file. */
export function testsCovering(map: RepoMap, path: string): string[] {
  const p = normalizePath(path);
  return map.files.find((f) => f.path === p)?.tests ?? [];
}

export interface MapQueryResult {
  path: string;
  kind: 'file' | 'directory' | 'missing';
  files: (RepoMapFile & { imported_by: string[]; checks: string[] })[];
}

/** A file, or every file under a directory, with what imports it and which checks name it. */
export function queryRepoMap(map: RepoMap, path: string): MapQueryResult {
  const p = normalizePath(path);
  const exact = map.files.filter((f) => f.path === p);
  const under = exact.length > 0 ? exact : map.files.filter((f) => p === '' || f.path.startsWith(`${p}/`));
  const importedBy = new Map<string, string[]>();
  for (const f of map.files) for (const t of f.imports) importedBy.set(t, [...(importedBy.get(t) ?? []), f.path]);
  const checks = (q: string) => Object.entries(map.checks).filter(([, ps]) => ps.some((c) => q === c || q.startsWith(`${c}/`))).map(([id]) => id);
  return {
    path: p,
    kind: exact.length > 0 ? 'file' : under.length > 0 ? 'directory' : 'missing',
    files: under.map((f) => ({ ...f, imported_by: importedBy.get(f.path) ?? [], checks: checks(f.path) })),
  };
}

/** The tracked files and directories a text names by their repository path (`src/a.ts`, `src/review`, `src/policy/scope.ts:93`). */
export function namedPaths(map: RepoMap, text: string): string[] {
  const files = new Set(map.files.map((f) => f.path));
  const out = new Set<string>();
  for (const raw of text.split(/[\s`'"(),;<>[\]{}|*]+/)) {
    const t = normalizePath(raw.replace(/:[\d-]*$/, '').replace(/[.:]+$/, ''));
    if (t === '') continue;
    if (files.has(t)) out.add(t);
    // A directory is named only with a slash in it, so a word such as "docs" in a sentence names nothing.
    else if ((t.includes('/') || raw.endsWith('/')) && map.files.some((f) => f.path.startsWith(`${t}/`))) out.add(t);
  }
  return [...out];
}

const LIST_MAX = 12;

/**
 * The map's slice for a worker prompt (#175 FR-004): each named file, or each non-test file of a named directory, with
 * its imports and tests, cut to `tokens` (estimated as the knowledge block's are). Null when the repository has fewer
 * than `minFiles` files, where a map does not pay, or when the text names no tracked path.
 */
export function promptSlice(map: RepoMap, text: string, opts: { tokens: number; minFiles: number }): string | null {
  if (map.files.length < opts.minFiles) return null;
  const named = namedPaths(map, text);
  if (named.length === 0) return null;
  const byPath = new Map(map.files.map((f) => [f.path, f]));
  const shown = new Set<RepoMapFile>();
  for (const n of named) {
    const f = byPath.get(n);
    if (f) shown.add(f);
    else for (const g of map.files) if (!g.test && g.path.startsWith(`${n}/`)) shown.add(g);
  }
  const list = (xs: string[]) => (xs.length > LIST_MAX ? `${xs.slice(0, LIST_MAX).join(', ')} and ${xs.length - LIST_MAX} more` : xs.join(', '));
  let out = `Repository map of tree ${map.tree.slice(0, 12)}: the files the goal names, with their imports and the tests linked to them. Search the checkout for anything else.\n`;
  let left = shown.size;
  for (const f of shown) {
    const block = `${f.path} (${f.size} bytes${f.generated ? ', generated' : ''}${f.test ? ', test' : ''})\n${f.imports.length ? `  imports: ${list(f.imports)}\n` : ''}${f.test ? '' : `  tests: ${f.tests.length ? list(f.tests) : 'none linked'}\n`}`;
    const more = `[${left - 1} more files not shown]\n`;
    if (estimateTokens(out + block + (left > 1 ? more : '')) > opts.tokens) break;
    out += block;
    left--;
  }
  if (left > 0) out += `[${left} more files not shown]\n`;
  return out;
}

/**
 * The slice for the planner's or reviewer's prompt, or null. It is off unless `repo_map.prompt_slice` is on (it stays
 * off until a full benchmark shows it helps), and a map that cannot be built gives no slice rather than stopping the
 * step: the slice is a shortcut for the worker, which can always search the checkout.
 */
export async function goalSlice(repoRoot: string, rev: string, text: string, config: Pick<OrbitConfig, 'repo_map'>): Promise<string | null> {
  const p = repoMapPolicy(config);
  if (!p.prompt_slice) return null;
  try {
    return promptSlice(await buildRepoMap(repoRoot, rev), text, { tokens: p.prompt_slice_tokens, minFiles: p.prompt_slice_min_files });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deriving the map from what is stored

function derive(s: Stored, checks: MapChecks, build: RepoMap['build']): RepoMap {
  const paths = new Set(s.files.map((f) => f.path));
  const dirs = new Set<string>();
  const byDir = new Map<string, string[]>();
  const goModules = new Map<string, string>();
  const crates = new Map<string, string>();
  const dotnetProjects = new Map<string, boolean>();
  const cargoManifests = new Map<string, boolean>();
  for (const f of s.files) {
    const d = dirOf(f.path);
    byDir.set(d, [...(byDir.get(d) ?? []), f.path]);
    for (let a = d; a !== ''; a = dirOf(a)) dirs.add(a);
    const base = posix.basename(f.path);
    for (const fact of f.facts) {
      if (base === 'go.mod' && fact.startsWith('module:')) goModules.set(d, fact.slice(7));
      if (base === 'Cargo.toml' && fact.startsWith('package:')) crates.set(d, fact.slice(8));
    }
    if (base === 'Cargo.toml') cargoManifests.set(d, f.facts.some((x) => x.startsWith('package:')));
    if (/\.(cs|fs|vb)proj$/i.test(base)) dotnetProjects.set(d, (dotnetProjects.get(d) ?? false) || f.facts.includes('test-project'));
  }
  const layout: TestLayout = { dotnetProjects, cargoManifests };
  const isTest = new Map(s.files.map((f) => [f.path, isTestPath(f.path, layout)] as const));
  const goPackage = (d: string) => (byDir.get(d) ?? []).filter((p) => p.endsWith('.go') && !p.endsWith('_test.go'));
  const index: TreeIndex = { has: (p) => paths.has(p), goPackage, goModules, crates };

  const imports = new Map<string, string[]>();
  for (const f of s.files) {
    const lang = languageOf(f.path);
    if (lang === null) continue;
    const out = new Set<string>();
    for (const spec of f.facts) for (const t of resolveSpecifier(f.path, lang, spec, index)) if (t !== f.path) out.add(t);
    imports.set(f.path, [...out].sort());
  }

  // A test covers a source it imports, a source of the same name and extension (in its own directory, else the only
  // one in the repository), and, in Go, every source of its package.
  const byStem = new Map<string, string[]>();
  for (const f of s.files) if (!isTest.get(f.path)) byStem.set(stemKey(f.path, false), [...(byStem.get(stemKey(f.path, false)) ?? []), f.path]);
  const tests = new Map<string, Set<string>>();
  const link = (source: string, test: string) => {
    if (!paths.has(source) || isTest.get(source)) return;
    const set = tests.get(source) ?? new Set<string>();
    tests.set(source, set.add(test));
  };
  for (const f of s.files) {
    if (!isTest.get(f.path)) continue;
    for (const t of imports.get(f.path) ?? []) link(t, f.path);
    if (f.path.endsWith('_test.go')) for (const src of goPackage(dirOf(f.path))) link(src, f.path);
    const same = byStem.get(stemKey(f.path, true)) ?? [];
    const near = same.filter((p) => dirOf(p) === dirOf(f.path));
    for (const src of near.length > 0 ? near : same.length === 1 ? same : []) link(src, f.path);
  }

  return {
    tree: s.tree,
    files: s.files.map((f) => ({
      path: f.path,
      size: f.size,
      generated: f.attr || f.marker,
      test: isTest.get(f.path) ?? false,
      imports: imports.get(f.path) ?? [],
      tests: [...(tests.get(f.path) ?? [])].sort(),
    })),
    checks: checkLinks(checks, paths, dirs),
    build,
  };
}

/** A file's name without its extension, and for a test without the marks that make it one (foo.test, test_foo, FooTest). */
function stemKey(path: string, test: boolean): string {
  const ext = posix.extname(path);
  let name = posix.basename(path, ext);
  if (test) name = name.replace(/^test_/, '').replace(/[._-](test|tests|spec|unittest)$/i, '').replace(/(?<=[a-z0-9])(Tests?|Spec|IT)$/, '');
  return `${name}\0${ext}`;
}

/** The tracked files and directories each check's argv words or cwd name. A check that names none links nothing. */
function checkLinks(checks: MapChecks, paths: ReadonlySet<string>, dirs: ReadonlySet<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, c] of Object.entries(checks)) {
    const cwd = normalizePath(c.cwd ?? '.');
    const found = new Set<string>();
    if (cwd !== '' && (paths.has(cwd) || dirs.has(cwd))) found.add(cwd);
    for (const word of c.command.flatMap((a) => a.split(/[\s=]+/))) {
      const w = word.replace(/^['"]+|['"]+$/g, '');
      if (w === '' || w.startsWith('-') || w.startsWith('/')) continue;
      const p = normalizePath(posix.join(cwd, w));
      if (p !== '' && !p.startsWith('..') && (paths.has(p) || dirs.has(p))) found.add(p);
    }
    out[id] = [...found].sort();
  }
  return out;
}

function dirOf(path: string): string {
  const d = posix.dirname(path);
  return d === '.' ? '' : d;
}

function normalizePath(p: string): string {
  const n = posix.normalize(p.trim()).replace(/\/+$/, '');
  return n === '.' ? '' : n.replace(/^\.\//, '');
}

// ---------------------------------------------------------------------------
// Reading git objects

function readable(path: string, size: number): boolean {
  return size <= MAX_PARSE_BYTES && (languageOf(path) !== null || /(^|\/)(go\.mod|Cargo\.toml)$|\.(cs|fs|vb)proj$/i.test(path));
}

/** A blob and the reader its path gives it: what is read from a blob depends on both, so the cache reuses it by both. */
function blobKey(e: Pick<Entry, 'path' | 'blob' | 'size'>): string {
  const reader = readable(e.path, e.size) ? (languageOf(e.path) ?? posix.basename(e.path).replace(/^.*\.(cs|fs|vb)proj$/i, 'proj')) : '';
  return `${e.blob} ${reader}`;
}

function factsOf(path: string, text: string): string[] {
  const lang = languageOf(path);
  if (lang !== null) return importSpecifiers(lang, text);
  const base = posix.basename(path);
  if (base === 'go.mod') {
    const m = /^\s*module\s+(\S+)/m.exec(text);
    return m ? [`module:${m[1]!.replace(/^"|"$/g, '')}`] : [];
  }
  if (base === 'Cargo.toml') {
    if (!declaresCargoPackage(text)) return [];
    const section = text.slice(text.search(/^\s*\[package\]/m)).split(/\n\s*\[/)[0]!;
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(section)?.[1];
    return [`package:${(name ?? '').replace(/-/g, '_')}`];
  }
  return isDotnetTestProject(text) ? ['test-project'] : [];
}

function parseLsTree(out: Buffer): Pick<Entry, 'path' | 'blob' | 'size'>[] {
  const entries: Pick<Entry, 'path' | 'blob' | 'size'>[] = [];
  for (const rec of out.toString('utf8').split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, blob, size] = rec.slice(0, tab).split(/\s+/);
    // Regular files only: a symlink's blob is its target, and a submodule is another repository.
    if (type !== 'blob' || mode === '120000' || !blob) continue;
    entries.push({ path: rec.slice(tab + 1), blob, size: Number(size) });
  }
  return entries;
}

/** The paths whose linguist-generated attribute is set (or true) in the tree. */
function parseCheckAttr(out: Buffer): Set<string> {
  const parts = out.toString('utf8').split('\0');
  const set = new Set<string>();
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === 'set' || parts[i + 2] === 'true') set.add(parts[i]!);
  return set;
}

function parseBatch(out: Buffer): Map<string, string> {
  const texts = new Map<string, string>();
  let i = 0;
  while (i < out.length) {
    const nl = out.indexOf(10, i);
    if (nl < 0) break;
    const [sha, type, size] = out.toString('utf8', i, nl).split(' ');
    if (type !== 'blob' || size === undefined) {
      i = nl + 1;
      continue;
    }
    const n = Number(size);
    texts.set(sha!, out.toString('utf8', nl + 1, nl + 1 + n));
    i = nl + 1 + n + 1;
  }
  return texts;
}

function gitBuf(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
      // No system attributes: what a tree marks generated comes from the tree (and the clone's own info/attributes).
      { cwd, env: gitEnv({ GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' }), encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new OrbitError('GIT_FAILED', `git ${args[0]} failed: ${stderr.toString('utf8').trim().slice(0, 300) || err.message}`, { args: args.slice(0, 3) }));
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

// ---------------------------------------------------------------------------
// The cache

async function cacheDir(repoRoot: string): Promise<string | null> {
  try {
    return join((await gitBuf(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString('utf8').trim(), 'orbit', 'repomap');
  } catch {
    return null;
  }
}

function readStored(path: string, tree: string): Stored | null {
  try {
    const s = readJsonIfExists<Stored>(path);
    // Served only for the tree it was built for, whatever its file is called.
    return s && s.schema === SCHEMA && s.tree === tree && Array.isArray(s.files) ? s : null;
  } catch {
    return null;
  }
}

/** What the newest cached map read from each blob, by blobKey, for an incremental build. */
function newestBlobs(dir: string): Map<string, Pick<Entry, 'marker' | 'facts'>> {
  const out = new Map<string, Pick<Entry, 'marker' | 'facts'>>();
  try {
    const newest = cachedFiles(dir)[0];
    const s = newest ? readJsonIfExists<Stored>(join(dir, newest)) : null;
    if (s?.schema === SCHEMA && Array.isArray(s.files)) for (const f of s.files) out.set(blobKey(f), { marker: f.marker, facts: f.facts });
  } catch {
    /* a full build */
  }
  return out;
}

/** Cached maps, newest first. */
function cachedFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => /^[0-9a-f]{40,64}\.json$/.test(n))
    .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map((x) => x.n);
}

function save(dir: string, stored: Stored): void {
  try {
    atomicWrite(join(dir, `${stored.tree}.json`), JSON.stringify(stored));
    for (const old of cachedFiles(dir).slice(KEEP_CACHED)) unlinkSync(join(dir, old));
  } catch {
    // A read-only git directory (a worker's sandbox) still gets its map, only not cached.
  }
}
