/**
 * Import specifiers of one source file, read with fixed patterns per language (#175 FR-001): TypeScript and JavaScript,
 * Python, Rust and Go. What a file imports is read here; which tracked file that names is decided in map.ts against the
 * tree. A pattern can match inside a comment or a string: the map then holds an edge too many, never a guess beyond
 * the text, and an unresolvable specifier (a package, the standard library) adds nothing.
 */
import { posix } from 'node:path';

export type Lang = 'js' | 'py' | 'rs' | 'go';

/** .js .jsx .ts .tsx .mjs .cjs .mts .cts (and .d.ts). */
const JS = /\.[cm]?[jt]sx?$/;

export function languageOf(path: string): Lang | null {
  if (JS.test(path)) return 'js';
  if (path.endsWith('.py')) return 'py';
  if (path.endsWith('.rs')) return 'rs';
  if (path.endsWith('.go')) return 'go';
  return null;
}

/**
 * The specifiers as written: a module path for JavaScript and Go, a dotted module (leading dots for relative ones) for
 * Python, and for Rust `mod:<name>` for a `mod name;` declaration and `use:<path>` for a `use` path.
 */
export function importSpecifiers(lang: Lang, text: string): string[] {
  const out = new Set<string>();
  const all = (re: RegExp, add: (m: RegExpMatchArray) => void) => {
    for (const m of text.matchAll(re)) add(m);
  };
  if (lang === 'js') {
    // import x from 'a', export * from 'a', import 'a', import('a'), require('a'); not a.from('x').
    all(/(?<![\w$.])(?:from|import|require)\s*\(?\s*['"]([^'"\n]+)['"]/g, (m) => out.add(m[1]!));
  } else if (lang === 'py') {
    all(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#;]*)/gm, (m) => {
      const mod = m[1]!;
      if (mod) out.add(mod);
      // A name imported from a package may be a submodule: `from pkg import mod`.
      for (const part of m[2]!.replace(/[()\\]/g, ' ').split(',')) {
        const name = part.trim().split(/\s+/)[0];
        if (name && name !== '*') out.add(mod.endsWith('.') ? `${mod}${name}` : `${mod}.${name}`);
      }
    });
    all(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm, (m) => {
      for (const name of m[1]!.split(',')) out.add(name.trim());
    });
  } else if (lang === 'rs') {
    all(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm, (m) => out.add(`mod:${m[1]!}`));
    all(/\buse\s+((?:\w+::)*\w+)/g, (m) => out.add(`use:${m[1]!}`));
  } else {
    all(/\bimport\s*\(([^)]*)\)/g, (m) => {
      for (const s of m[1]!.matchAll(/"([^"\n]+)"/g)) out.add(s[1]!);
    });
    all(/\bimport\s+(?:[\w.]+\s+)?"([^"\n]+)"/g, (m) => out.add(m[1]!));
  }
  return [...out];
}

/** What resolution needs to know about the tree beyond the importing file. */
export interface TreeIndex {
  has(path: string): boolean;
  /** The non-test .go files directly in a directory. */
  goPackage(dir: string): readonly string[];
  /** go.mod module paths by the directory that holds them. */
  goModules: ReadonlyMap<string, string>;
  /** Cargo package names (with - as _) by the directory of their Cargo.toml. */
  crates: ReadonlyMap<string, string>;
}

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
/** TypeScript's ESM convention: `./a.js` names the source `a.ts`. */
const JS_SWAP: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/** The tracked files a specifier of `path` names; empty when it names none (a package, the standard library). */
export function resolveSpecifier(path: string, lang: Lang, spec: string, tree: TreeIndex): string[] {
  const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
  const first = (candidates: string[]): string[] => {
    const hit = candidates.find((c) => tree.has(c));
    return hit ? [hit] : [];
  };
  if (lang === 'js') {
    if (!spec.startsWith('./') && !spec.startsWith('../') && spec !== '.' && spec !== '..') return [];
    const base = inside(posix.join(dir, spec));
    if (base === null) return [];
    const ext = posix.extname(base);
    const swapped = (JS_SWAP[ext] ?? []).map((e) => base.slice(0, -ext.length) + e);
    return first([base, ...swapped, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => `${base ? `${base}/` : ''}index${e}`)]);
  }
  if (lang === 'py') {
    const dots = /^\.*/.exec(spec)![0].length;
    const parts = spec.slice(dots).split('.').filter(Boolean);
    let roots: string[];
    if (dots > 0) {
      let up = dir;
      for (let i = 1; i < dots; i++) up = up === '' ? '..' : posix.dirname(up) === '.' ? '' : posix.dirname(up);
      roots = up === '..' ? [] : [up];
    } else {
      // sys.path order: the repository root, src/, then each directory above the importing file.
      roots = ['', 'src', ...ancestors(dir).reverse()];
    }
    for (const root of new Set(roots)) {
      const p = posix.join(root, ...parts);
      const hit = first(parts.length === 0 ? [posix.join(root, '__init__.py')] : [`${p}.py`, `${p}/__init__.py`]);
      if (hit.length > 0) return hit;
    }
    return [];
  }
  if (lang === 'rs') {
    if (spec.startsWith('mod:')) {
      const name = spec.slice(4);
      const own = /^(lib|main|mod)\.rs$/.test(posix.basename(path)) ? dir : posix.join(dir, posix.basename(path, '.rs'));
      return first([posix.join(own, `${name}.rs`), posix.join(own, name, 'mod.rs')]);
    }
    const segs = spec.slice(4).split('::');
    const crateDir = segs[0] === 'crate' ? owningCrate(dir, tree) : [...tree.crates].find(([, name]) => name === segs[0])?.[0];
    if (crateDir === undefined) return [];
    const src = posix.join(crateDir, 'src');
    const rest = segs.slice(1);
    for (let k = rest.length; k > 0; k--) {
      const p = posix.join(src, ...rest.slice(0, k));
      const hit = first([`${p}.rs`, `${p}/mod.rs`]);
      if (hit.length > 0) return hit;
    }
    return first([posix.join(src, 'lib.rs')]);
  }
  let best: [string, string] | null = null;
  for (const [modDir, mod] of tree.goModules) {
    if ((spec === mod || spec.startsWith(`${mod}/`)) && (best === null || mod.length > best[1].length)) best = [modDir, mod];
  }
  if (best === null) return [];
  const pkg = posix.join(best[0], spec.slice(best[1].length + 1));
  return [...tree.goPackage(pkg === '.' ? '' : pkg)];
}

/** A normalized repository-relative path, or null when it leaves the repository. */
function inside(p: string): string | null {
  const n = posix.normalize(p);
  return n === '..' || n.startsWith('../') || n.startsWith('/') ? null : n === '.' ? '' : n;
}

/** '' and every directory from the root down to `dir`, excluding `dir` itself when it is ''. */
function ancestors(dir: string): string[] {
  if (dir === '') return [];
  const parts = dir.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

function owningCrate(dir: string, tree: TreeIndex): string | undefined {
  for (let d = dir; ; d = posix.dirname(d) === '.' ? '' : posix.dirname(d)) {
    if (tree.crates.has(d)) return d;
    if (d === '') return undefined;
  }
}
