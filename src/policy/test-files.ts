/**
 * Test-file recognition (docs/decisions/0011-test-file-recognition.md, issue #30). One set of rules decides what counts
 * as a test wherever Orbit asks: `isTestPath` for the new-evidence rule of the evidence report (a criterion whose
 * checks passed on the base revision is supported only when the candidate adds or changes a test), the
 * unexplained-architecture trigger's filter and the review packet's ranking; `isTestPathOnEitherRevision`, the same
 * rules on each revision alone, for the weakening signals (test-file-deleted and the rest).
 *
 * A file wrongly counted as a test lets a criterion pass on a green check that proves nothing about the change, so the
 * rules follow what each language's test runner runs, never loose name matching:
 *
 * - JavaScript/TypeScript, Python and Go: the conventions their runners discover (unchanged).
 * - Java, Kotlin, Scala, Groovy: the test source sets the build compiles tests from (src/test, src/it, src/<x>Test,
 *   src/testDebug, src/testRelease) and Bazel's javatests. A test-named class of the main source set is never run by
 *   the build, and helper source sets (testFixtures, testUtils) hold no tests.
 * - C#, F#, Visual Basic: a source is a test when the project that owns it (the nearest project file) is a test project
 *   by its project file (IsTestProject, or a reference to the test SDK or a package that makes a test project), on
 *   every revision that has the file, judged by every revision that has the project file. `dotnet test` runs test
 *   projects only, so a file name says nothing here.
 * - Rust: a crate's tests/ directory, and a source of a crate's src/ whose change adds a #[test] function that is not
 *   ignored, when the source is a crate root or a module the crate declares; the second needs the file's diff.
 * - Ruby: *_spec.rb under spec/ and *_test.rb under test/. PHP: *Test.php under tests/. Swift: sources under Tests/
 *   and <Name>Tests/, never under Sources/. Elixir: *_test.exs under test/. Dart: *_test.dart under test/ and
 *   integration_test/. C and C++: sources under test/ or tests/, and the GoogleTest _test and _unittest suffixes for
 *   C++ (not C: test_and_set.c; not a self test or an A/B test).
 *
 * Anything else is not a test: a missing rule can only leave a criterion unverified, never pass one.
 */

import { OrbitError } from '../core/errors.ts';

/** What the predicate needs to know about the trees beyond a path. */
export interface TestLayout {
  /** The directories holding a .NET project file ('' is the repository root), and whether its project is a test project. */
  readonly dotnetProjects: ReadonlyMap<string, boolean>;
  /** The directories holding a Cargo.toml, and whether it is a crate (a [package] table, not only a [workspace]). */
  readonly cargoManifests: ReadonlyMap<string, boolean>;
  /**
   * For each changed .NET or Rust file, what owns it on each revision that has the file, from loadTestLayout. Absent
   * (a layout built by hand), the nearest directory of the maps above owns it.
   */
  readonly owners?: ReadonlyMap<string, readonly Owner[]>;
  /**
   * The changed Rust sources of a crate's src/ that are modules the crate compiles: a chain of `mod` declarations in
   * the candidate reaches them from a crate root (loadTestLayout with `rustModules`). Crate roots are not listed; they
   * are always compiled. Absent, no module counts, only crate roots.
   */
  readonly compiledRust?: ReadonlySet<string>;
}

/** What owns a changed file on one revision that has it. */
export interface Owner {
  /** The nearest directory above the file holding a project file (a Cargo.toml) on that revision; null when none does. */
  readonly dir: string | null;
  /** Whether that directory's manifests on that revision alone declare a test project (a crate). */
  readonly here: boolean;
}

/** No project files known: path conventions alone decide, and no .NET source or Rust tests/ file is a test. */
export const NO_LAYOUT: TestLayout = Object.freeze({ dotnetProjects: new Map<string, boolean>(), cargoManifests: new Map<string, boolean>() });

const JS_PY_GO = /\.(m|c)?(j|t)sx?$|\.py$|\.go$|\.(vue|svelte)$/;
const JVM = /\.(java|kt|scala|groovy)$/;
const DOTNET_SOURCE = /\.(cs|fs|vb|razor)$/;
const DOTNET_PROJECT = /\.(cs|fs|vb)proj$/i;
const C_FAMILY = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/;

/**
 * The test source sets of Maven, Gradle (with the Android build types and Kotlin Multiplatform targets) and sbt, and
 * Bazel's javatests. Helper source sets (testFixtures, testUtils, testSupport) hold builders and fakes, not tests.
 */
const JVM_TEST_SOURCES = /(^|\/)src\/(test|it|test(Debug|Release)|[a-z]\w*Test)\/|(^|\/)javatests\//;
/** A source set's resources, which the build copies and never compiles, whatever a file there is named. */
const JVM_RESOURCES = /(^|\/)src\/[A-Za-z]\w*\/resources\//;

/** #[test], #[tokio::test(...)] and other runtimes' path::test, rstest and test_case: what cargo test runs. */
const RUST_TEST_ATTRIBUTE = /^\s*#\[\s*(?:(?:[A-Za-z_]\w*::)*test|rstest|test_case)\s*[(\]]/;
/** #[ignore], #[ignore = "why"] and a conditional cfg_attr(..., ignore): cargo test does not run such a test. */
const RUST_IGNORE_ATTRIBUTE = /#\[\s*(?:ignore\b|cfg_attr\s*\(.*\bignore\b)/;
/** The crate roots cargo finds by default under src/: the library, the main binary and every binary of src/bin. */
const RUST_CRATE_ROOT = /^src\/(lib|main)\.rs$|^src\/bin\/[^/]+\.rs$|^src\/bin\/[^/]+\/main\.rs$/;

/**
 * Whether `path` is a test file, on every revision that has it: what a criterion's evidence and the
 * unexplained-architecture filter rest on, since a false "test" there lets a change through unproven. `layout` (from
 * `loadTestLayout`) is needed for .NET sources and Rust; without it they are not tests. `diff`, the file's unified
 * diff, makes a Rust source whose change adds a test function count: the new-evidence rule passes it, because it asks
 * whether the change adds a test; the trigger filter asks what the file is, and leaves it out.
 */
export function isTestPath(path: string, layout: TestLayout = NO_LAYOUT, diff?: string): boolean {
  const p = path.toLowerCase();
  if (JS_PY_GO.test(p)) return jsPyGoTest(p);
  if (JVM.test(p)) return JVM_TEST_SOURCES.test(path) && !JVM_RESOURCES.test(path);
  if (DOTNET_SOURCE.test(p)) return testOwners(path, layout.dotnetProjects, layout) !== null;
  if (p.endsWith('.rs')) return rustTest(path, layout, diff);
  if (p.endsWith('.rb')) return /(^|\/)spec\/(.+\/)?[^/]+_spec\.rb$/.test(p) || /(^|\/)test\/(.+\/)?[^/]+_test\.rb$/.test(p);
  if (p.endsWith('.php')) return /(^|\/)[Tt]ests?\/(.+\/)?[^/]+Test\.php$/.test(path);
  // Swift Package Manager compiles everything under Sources/ into the module, whatever a folder there is called.
  if (p.endsWith('.swift')) return !/(^|\/)Sources\//.test(path) && /(^|\/)(tests|\w*Tests)\//.test(path);
  if (p.endsWith('.exs')) return /(^|\/)test\/(.+\/)?[^/]+_test\.exs$/.test(p);
  if (p.endsWith('.dart')) return /(^|\/)(test|integration_test)\/(.+\/)?[^/]+_test\.dart$/.test(p);
  if (C_FAMILY.test(p)) return /(^|\/)tests?\//.test(p) || (/_(unit)?tests?\.(cc|cpp|cxx)$/.test(p) && !/(^|\/|_)(self|ab|a_b)_tests?\.(cc|cpp|cxx)$/.test(p));
  return false;
}

/** JavaScript/TypeScript, Python and Go, as recognised before issue #30. */
function jsPyGoTest(p: string): boolean {
  if (/(^|\/)(__tests__|__test__|tests?|specs?|e2e|integration-tests?|testing)\//.test(p)) return true;
  if (/\.(test|spec|e2e|cy)\.(m|c)?(j|t)sx?$/.test(p)) return true;
  if (/(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/.test(p)) return true;
  return /_test\.go$/.test(p);
}

/**
 * Whether `path` was or is a test file: a test on either revision that has it, by that revision's own project files.
 * The weakening signals ask this, so a candidate cannot hide the tests it deletes or edits by also turning their
 * project into a library or deleting its project file. Without per-revision owners (a layout built by hand, or a
 * language whose rules are path conventions) it is isTestPath.
 */
export function isTestPathOnEitherRevision(path: string, layout: TestLayout = NO_LAYOUT): boolean {
  const p = path.toLowerCase();
  const owners = layout.owners?.get(path);
  if (owners === undefined) return isTestPath(path, layout);
  if (DOTNET_SOURCE.test(p)) return owners.some((o) => o.here);
  if (p.endsWith('.rs')) return owners.some((o) => o.here && o.dir !== null && relativeTo(o.dir, path).startsWith('tests/'));
  return isTestPath(path, layout);
}

/**
 * The directories that own `path` when every one is a test project or a crate (true in `dirs`, which judges every
 * revision that has the manifest), else null: the owners loadTestLayout found on each revision that has the file, or
 * the nearest directory of `dirs` for a layout built by hand.
 */
function testOwners(path: string, dirs: ReadonlyMap<string, boolean>, layout: TestLayout): string[] | null {
  const owners = layout.owners?.get(path)?.map((o) => o.dir) ?? [nearestDir(path, (d) => dirs.has(d))];
  if (owners.length === 0) return null;
  const out: string[] = [];
  for (const d of owners) {
    if (d === null || dirs.get(d) !== true) return null;
    out.push(d);
  }
  return out;
}

function rustTest(path: string, layout: TestLayout, diff: string | undefined): boolean {
  const crates = testOwners(path, layout.cargoManifests, layout);
  if (crates === null) return false;
  const rels = crates.map((dir) => relativeTo(dir, path));
  if (rels.every((r) => r.startsWith('tests/'))) return true;
  // A #[test] the change adds runs only where cargo test compiles it (measured): a crate root under src/, or a module
  // one declares. Not benches/, examples/ or build.rs, and not a file of src/ no `mod` reaches.
  if (diff === undefined || !rels.every((r) => r.startsWith('src/'))) return false;
  if (!rels.every((r) => RUST_CRATE_ROOT.test(r)) && layout.compiledRust?.has(path) !== true) return false;
  return addsRunnableRustTest(diff);
}

/** Files whose test changes `isTestPath` can see only in their diff. */
export function testedByContent(path: string): boolean {
  return path.toLowerCase().endsWith('.rs');
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function relativeTo(dir: string, path: string): string {
  return dir === '' ? path : path.slice(dir.length + 1);
}

/** The directories above `path`, its own first and the root ('') last. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  let dir = path;
  do {
    dir = dirOf(dir);
    out.push(dir);
  } while (dir !== '');
  return out;
}

/** The nearest directory above `path` (its own first, the root last) for which `has` holds, or null. */
function nearestDir(path: string, has: (dir: string) => boolean): string | null {
  return ancestors(path).find(has) ?? null;
}

/**
 * Whether the diff adds a test function cargo test runs: a test attribute on an added line, in an attribute group (the
 * attributes before an item, across comments and blank lines) that has no ignore attribute and no cfg other than
 * cfg(test), on an item of a module cargo compiles (scanRust). The group is read in the candidate, unchanged lines
 * included, so the diff must show the whole candidate file (git diff with full context, one hunk from line 1): a diff
 * that does not (no context, or cut short by an output limit) adds no test, since an unchanged #[ignore] may sit
 * outside it. Removed lines are not part of the new file, so they neither add a test nor ignore one.
 */
function addsRunnableRustTest(diff: string): boolean {
  const lines = wholeCandidate(diff);
  if (lines === null) return false;
  return scanRust(lines, (attrs, _code, compiled) => compiled && attrs.some((a) => a.added && RUST_TEST_ATTRIBUTE.test(a.text)) && !attrs.some((a) => RUST_IGNORE_ATTRIBUTE.test(a.text) || offCfg(a.text)));
}

/** The lines of the candidate file a diff shows, each marked added or not; null unless the diff shows every one of them. */
function wholeCandidate(diff: string): { text: string; added: boolean }[] | null {
  const raw = diff.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  const at = raw.findIndex((l) => l.startsWith('@@'));
  if (at < 0) return null;
  const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw[at]!);
  if (header === null) return null;
  const start = Number(header[1]);
  const count = header[2] === undefined ? 1 : Number(header[2]);
  if (count > 0 && start !== 1) return null;
  const out: { text: string; added: boolean }[] = [];
  for (const line of raw.slice(at + 1)) {
    if (line.startsWith('+') || line.startsWith(' ')) out.push({ text: line.slice(1), added: line.startsWith('+') });
    else if (!line.startsWith('-') && !line.startsWith('\\')) return null;
  }
  return out.length === count ? out : null;
}

/** An attribute of an item, with whether any line of it is an added line of the diff. */
interface RustAttribute {
  readonly text: string;
  readonly added: boolean;
}

/** A cfg attribute other than cfg(test): cargo test without features or other targets does not compile what it marks. */
function offCfg(attribute: string): boolean {
  return /^#!?\[\s*cfg\s*\(/.test(attribute) && !/^#!?\[\s*cfg\s*\(\s*test\s*\)\s*\]$/.test(attribute);
}

/** The start of an inline module or of a module declaration: `mod name`, with any visibility. */
const RUST_MOD_ITEM = /^(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(?:r#)?([A-Za-z_]\w*)\s*([;{]|$)/;

/**
 * Walks Rust source line by line as the compiler reads it (RustLexer: comments removed, literals emptied) and calls
 * `item` with the start of each item's code (the rest of its line), the attributes before it (outer attributes, also
 * those on the item's own line and those spanning lines), whether it sits in a block, and whether cargo test compiles
 * it: every block around it is a module, none marked by a cfg other than cfg(test) (an outer attribute on the module or
 * an inner one in it), and the file is not (an inner cfg at the top). A test function in a function or another block is
 * not run (rustc does not test inner items). Returns true as soon as `item` does. Every line that is not an attribute or
 * blank starts an item here, which for a line inside an expression only ends the group before it.
 */
function scanRust(lines: Iterable<{ text: string; added: boolean }>, item: (attrs: readonly RustAttribute[], code: string, compiled: boolean, nested: boolean) => boolean): boolean {
  const lexer = new RustLexer();
  // One entry per open brace: whether it opened a module cargo compiles, one a cfg leaves out, or any other block.
  const blocks: ('module' | 'off' | 'other')[] = [];
  let fileOff = false;
  let group: RustAttribute[] = [];
  let attr: { text: string; depth: number; added: boolean } | null = null;
  // The block the next '{' opens, when an item before it was a module whose brace has not come yet.
  let opens: 'module' | 'off' | null = null;
  for (const line of lines) {
    const code = lexer.line(line.text);
    let i = 0;
    while (i < code.length) {
      if (attr !== null) {
        const c = code[i++]!;
        attr.text += c;
        attr.added ||= line.added;
        if (c === '[') attr.depth++;
        else if (c === ']' && --attr.depth === 0) {
          const text = attr.text.trim();
          const added = attr.added;
          attr = null;
          if (!text.startsWith('#!')) group.push({ text, added });
          else if (offCfg(text)) {
            if (blocks.length === 0) fileOff = true;
            else blocks[blocks.length - 1] = 'off';
          }
        }
        continue;
      }
      if (/\s/.test(code[i]!)) {
        i++;
        continue;
      }
      if (code.startsWith('#[', i) || code.startsWith('#![', i)) {
        attr = { text: '', depth: 0, added: line.added };
        continue;
      }
      const rest = code.slice(i);
      if (opens === null || !rest.startsWith('{')) {
        if (item(group, rest, !fileOff && blocks.every((b) => b === 'module'), blocks.length > 0)) return true;
        const mod = RUST_MOD_ITEM.exec(rest);
        opens = mod !== null && mod[2] !== ';' ? (group.some((a) => offCfg(a.text)) ? 'off' : 'module') : null;
        group = [];
      }
      for (const c of rest) {
        if (c === '{') {
          blocks.push(opens ?? 'other');
          opens = null;
        } else if (c === '}') blocks.pop();
      }
      break;
    }
  }
  return false;
}

/**
 * Reads Rust source a line at a time and returns each line's code: comments removed (line comments, and block comments,
 * which nest and may span lines), and string, raw string, byte string and character literals emptied to their quotes.
 * What spans a line break carries over to the next call. Without it, a #[test] in a block comment or a raw string counts
 * as a test, and a brace there misleads the block structure. A misread can only hide code (read a lifetime as the start
 * of a literal, say), which leaves a test uncounted, the safe direction.
 */
class RustLexer {
  /** Nesting of the block comment the next line starts in; 0 outside one. */
  private comment = 0;
  /** The literal the next line starts in: the number of '#' that close a raw string, -1 for a plain string. */
  private literal: number | null = null;

  line(text: string): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (this.comment > 0) {
        if (text.startsWith('/*', i)) {
          this.comment++;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          this.comment--;
          i += 2;
          if (this.comment === 0) out += ' ';
        } else i++;
        continue;
      }
      if (this.literal !== null) {
        if (this.literal < 0 && text[i] === '\\') i += 2;
        else if (text[i] === '"' && (this.literal < 0 || text.startsWith('#'.repeat(this.literal), i + 1))) {
          i += 1 + Math.max(this.literal, 0);
          this.literal = null;
          out += '"';
        } else i++;
        continue;
      }
      if (text.startsWith('//', i)) break;
      if (text.startsWith('/*', i)) {
        this.comment = 1;
        i += 2;
        continue;
      }
      RAW_STRING.lastIndex = i;
      const raw = 'rbc'.includes(text[i]!) ? RAW_STRING.exec(text) : null;
      if (raw !== null) {
        out += '"';
        this.literal = raw[1]!.length;
        i = RAW_STRING.lastIndex;
        continue;
      }
      if (text[i] === '"') {
        out += '"';
        this.literal = -1;
        i++;
        continue;
      }
      CHAR_LITERAL.lastIndex = i;
      if (text[i] === "'" && CHAR_LITERAL.test(text)) {
        out += "''";
        i = CHAR_LITERAL.lastIndex;
        continue;
      }
      out += text[i];
      i++;
    }
    return out;
  }
}

/** The opening of a raw string (r"", r#""#, and the byte and C string forms br and cr), not the end of a longer name. */
const RAW_STRING = /(?<![A-Za-z0-9_])[bc]?r(#*)"/y;
/** A character or byte literal: one character or one escape between quotes; any other quote starts a lifetime or a label. */
const CHAR_LITERAL = /'(?:\\(?:x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f_]{1,8}\}|.)|[^\\'\n])'/uy;

// ---------------------------------------------------------------------------
// Project files

/**
 * Package ids whose reference makes a project one `dotnet test` runs (NuGet ids are case-insensitive): the test SDK,
 * and packages that bring it or set IsTestProject themselves (xunit's xunit.core, TUnit's engine, the MSTest
 * metapackage; xunit.v3 refuses a library). A framework alone (NUnit, MSTest.TestFramework) is what a shared library
 * of base classes references, and dotnet test does not run that (measured, ADR 0011).
 */
const TEST_PACKAGES = new Set(['microsoft.net.test.sdk', 'xunit', 'xunit.v3', 'mstest', 'tunit']);
/** Assemblies whose Reference makes a legacy (non-SDK) .NET Framework project a test project: the test frameworks. */
const TEST_ASSEMBLIES = new Set(['nunit.framework', 'xunit.core', 'microsoft.visualstudio.qualitytools.unittestframework', 'microsoft.visualstudio.testplatform.testframework']);

/**
 * Whether a .NET project file declares a test project: `<IsTestProject>true</IsTestProject>`, a PackageReference to
 * the test SDK or a package that makes a test project (TEST_PACKAGES), the MSTest project SDK, or in a legacy .NET
 * Framework project a Reference to a test framework assembly or the test project type GUID.
 * `<IsTestProject>false</IsTestProject>` wins, even under a
 * condition. Comments are ignored, and so is everything under a condition (an element with a Condition attribute and
 * what it holds, and Choose), since which branch applies is MSBuild's to evaluate. What a Directory.Build.props adds is
 * not read: such a project is not counted until its project file says so (ADR 0011).
 */
export function isDotnetTestProject(text: string): boolean {
  const xml = text.replace(/<!--[\s\S]*?-->/g, '');
  if (/<IsTestProject\b[^>]*>\s*false\s*<\/IsTestProject>/i.test(xml)) return false;
  const plain = unconditional(xml);
  if (/<IsTestProject\b[^>]*>\s*true\s*<\/IsTestProject>/i.test(plain)) return true;
  if (/<Project\b[^>]*\bSdk\s*=\s*["']\s*MSTest\.Sdk\b/i.test(plain) || /<Sdk\b[^>]*\bName\s*=\s*["']\s*MSTest\.Sdk\b/i.test(plain)) return true;
  for (const m of plain.matchAll(/<PackageReference\b[^>]*\bInclude\s*=\s*["']([^"']+)["']/gi)) {
    if (TEST_PACKAGES.has(m[1]!.trim().toLowerCase())) return true;
  }
  for (const m of plain.matchAll(/<Reference\b[^>]*\bInclude\s*=\s*["']([^"']+)["']/gi)) {
    if (TEST_ASSEMBLIES.has(m[1]!.split(',')[0]!.trim().toLowerCase())) return true;
  }
  return /<ProjectTypeGuids\b[^>]*>[^<]*3AC096D0-A1C2-E12C-1390-A8335801FDAB/i.test(plain);
}

/** A start, end or empty-element tag; attribute values are quoted, so a '>' inside one does not end the tag. */
const XML_TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

/** The project file without its conditional parts: every element with a Condition attribute and Choose, with all they hold. */
function unconditional(xml: string): string {
  let out = '';
  let kept = 0;
  let skip: { name: string; depth: number } | null = null;
  for (const m of xml.matchAll(XML_TAG)) {
    const [tag, close, name, attrs, empty] = m;
    if (skip !== null) {
      if (name !== skip.name || empty) continue;
      skip.depth += close ? -1 : 1;
      if (skip.depth === 0) {
        skip = null;
        kept = m.index + tag.length;
      }
      continue;
    }
    if (close || !(/\bCondition\s*=/i.test(attrs!) || /^Choose$/i.test(name!))) continue;
    out += xml.slice(kept, m.index);
    kept = m.index + tag.length;
    if (!empty) skip = { name: name!, depth: 1 };
  }
  // An element left open drops the rest: in doubt, nothing there counts.
  return skip === null ? out + xml.slice(kept) : out;
}

/** Whether a Cargo.toml is a crate: it has a [package] table (a virtual workspace manifest has none, and no tests). */
export function declaresCargoPackage(text: string): boolean {
  return /^\s*\[package\]\s*(#.*)?$/m.test(text);
}

/** Read access to the trees of a repository. */
export interface TreeReader {
  /** The paths of the entries directly in each of `dirs` ('' is the root) in the tree of `rev`; a directory that is not there lists nothing. */
  list(rev: string, dirs: readonly string[]): Promise<readonly string[]>;
  /** The content of `path` in `rev`, or null when it is not there or cannot be read. */
  text(rev: string, path: string): Promise<string | null>;
}

/** Directories listed by one git invocation, so a long list stays well inside the command-line limit. */
const LIST_BATCH = 200;

/**
 * A TreeReader over a git runner that returns stdout and throws on failure (the caller's own hardened git). A listing
 * is one non-recursive ls-tree of the asked directories, never the whole tree: a git that keeps only the first
 * megabytes of its output would otherwise drop project files without a word. A listing that does not end in its
 * record terminator was cut short, and is refused.
 */
export function gitTreeReader(run: (args: readonly string[]) => Promise<string>): TreeReader {
  return {
    async list(rev, dirs) {
      const out: string[] = [];
      for (let i = 0; i < dirs.length; i += LIST_BATCH) {
        // './' keeps a directory whose name starts with ':' from being read as pathspec magic.
        const specs = dirs.slice(i, i + LIST_BATCH).map((d) => (d === '' ? '.' : `./${d}/`));
        const listing = await run(['ls-tree', '-z', '--name-only', '--full-tree', rev, '--', ...specs]);
        if (listing.length > 0 && !listing.endsWith('\0')) {
          throw new OrbitError('GIT_FAILED', `the listing of ${rev} was cut short, so its test files cannot be told apart`, { rev });
        }
        out.push(...listing.split('\0').filter((p) => p.length > 0));
      }
      return out;
    },
    async text(rev, path) {
      try {
        return await run(['cat-file', 'blob', `${rev}:${path}`]);
      } catch {
        return null;
      }
    },
  };
}

/** A project file larger than this is read only this far: declarations sit at the top. */
const MAX_MANIFEST_CHARS = 1024 * 1024;

export interface LayoutOptions {
  /** Also find which changed Rust sources are modules their crate compiles (compiledRust); only a #[test] added to one needs it. */
  readonly rustModules?: boolean;
}

/**
 * The layout of the base revision and the candidate for the `changed` paths. Only the directories above a changed
 * .NET or Rust file are listed, since only they can own one. Each such file is owned, on each revision that has it, by
 * the nearest directory holding a project file (or Cargo.toml) there. For isTestPath a directory is a test project (a
 * crate) only when every manifest it holds says so on every revision that has one, and a file only when every owner
 * is: a candidate cannot make a production file a test by editing its project file or by adding a test project around
 * it, a file whose test project it deletes is no longer a test, a test project it adds is judged by its own project
 * file, and the files of one it deletes by the base's. isTestPathOnEitherRevision asks each revision alone. Reads
 * nothing when no .NET or Rust file changed.
 */
export async function loadTestLayout(reader: TreeReader, base: string, candidate: string, changed: readonly string[], options: LayoutOptions = {}): Promise<TestLayout> {
  const dotnet = changed.filter((p) => DOTNET_SOURCE.test(p.toLowerCase()));
  const rust = changed.filter((p) => p.toLowerCase().endsWith('.rs'));
  if (dotnet.length === 0 && rust.length === 0) return NO_LAYOUT;
  const dirs = [...new Set([...dotnet, ...rust].flatMap(ancestors))].sort();
  const revs = base === candidate ? [base] : [base, candidate];
  const trees: Tree[] = await Promise.all(revs.map(async (rev) => ({ rev, entries: new Set(await reader.list(rev, dirs)) })));
  const owners = new Map<string, Owner[]>();
  const isCargo = (p: string) => p === 'Cargo.toml' || p.endsWith('/Cargo.toml');
  const dotnetProjects = await judgeOwners(reader, trees, dotnet, (p) => DOTNET_PROJECT.test(p), isDotnetTestProject, owners);
  const cargoManifests = await judgeOwners(reader, trees, rust, isCargo, declaresCargoPackage, owners);
  if (!options.rustModules) return { dotnetProjects, cargoManifests, owners };
  const cand = trees[trees.length - 1]!;
  const crateDirs = new Set([...cand.entries].filter(isCargo).map(dirOf));
  const compiledRust = new Set<string>();
  const modules = new RustModules(reader, candidate);
  for (const p of rust) {
    if (!cand.entries.has(p)) continue;
    const crate = nearestDir(p, (d) => crateDirs.has(d));
    if (crate === null || cargoManifests.get(crate) !== true) continue;
    const rel = relativeTo(crate, p);
    if (rel.startsWith('src/') && !RUST_CRATE_ROOT.test(rel) && (await modules.compiled(crate, rel))) compiledRust.add(p);
  }
  return { dotnetProjects, cargoManifests, owners, compiledRust };
}

interface Tree {
  rev: string;
  entries: ReadonlySet<string>;
}

/**
 * Every manifest directory of the listed directories, true when it owns a changed file on some revision and every
 * manifest it holds says so on every revision that has one; records what owns each changed file in `owners`.
 */
async function judgeOwners(reader: TreeReader, trees: readonly Tree[], changed: readonly string[], isManifest: (p: string) => boolean, judge: (text: string) => boolean, owners: Map<string, Owner[]>): Promise<Map<string, boolean>> {
  // directory -> revision -> the manifests it holds there
  const byDir = new Map<string, Map<string, string[]>>();
  for (const t of trees) {
    for (const path of t.entries) {
      if (!isManifest(path)) continue;
      const revs = byDir.get(dirOf(path)) ?? new Map<string, string[]>();
      revs.set(t.rev, [...(revs.get(t.rev) ?? []), path]);
      byDir.set(dirOf(path), revs);
    }
  }
  const verdicts = new Map<string, Promise<boolean>>();
  /** Whether every manifest of `dir` on `rev` says so; a manifest that cannot be read does not. */
  const on = (rev: string, dir: string): Promise<boolean> => {
    const key = `${rev}\0${dir}`;
    let known = verdicts.get(key);
    if (known === undefined) {
      known = (async () => {
        for (const path of byDir.get(dir)?.get(rev) ?? []) {
          const text = await reader.text(rev, path);
          if (text === null || !judge(text.slice(0, MAX_MANIFEST_CHARS))) return false;
        }
        return true;
      })();
      verdicts.set(key, known);
    }
    return known;
  };
  const out = new Map<string, boolean>([...byDir.keys()].sort().map((d) => [d, false]));
  for (const p of changed) {
    const own: Owner[] = [];
    for (const t of trees) {
      if (!t.entries.has(p)) continue;
      const dir = nearestDir(p, (d) => byDir.get(d)?.has(t.rev) === true);
      own.push({ dir, here: dir !== null && (await on(t.rev, dir)) });
      if (dir === null) continue;
      let all = true;
      for (const rev of byDir.get(dir)!.keys()) if (!(await on(rev, dir))) all = false;
      out.set(dir, all);
    }
    owners.set(p, own);
  }
  return out;
}

/**
 * Which sources of a crate's src/ the crate compiles, in the candidate: a crate root, or a module whose `mod`
 * declaration sits in a source the crate compiles (src/a/b.rs and src/a/b/mod.rs are declared as `mod b;` in
 * src/a.rs or src/a/mod.rs, src/b.rs in src/lib.rs or src/main.rs). A declaration git cannot show this way (a #[path]
 * attribute, a module declared inside an inline module, a macro) leaves the file uncounted, the safe direction.
 */
class RustModules {
  private readonly reader: TreeReader;
  private readonly rev: string;
  private readonly memo = new Map<string, Promise<boolean>>();
  private readonly texts = new Map<string, Promise<string | null>>();

  constructor(reader: TreeReader, rev: string) {
    this.reader = reader;
    this.rev = rev;
  }

  compiled(crate: string, rel: string): Promise<boolean> {
    const key = `${crate}\0${rel}`;
    let known = this.memo.get(key);
    if (known === undefined) {
      known = this.find(crate, rel);
      this.memo.set(key, known);
    }
    return known;
  }

  private async find(crate: string, rel: string): Promise<boolean> {
    if (RUST_CRATE_ROOT.test(rel)) return true;
    const parts = rel.split('/');
    const file = parts.pop()!;
    const name = file === 'mod.rs' ? parts.pop() : file.replace(/\.rs$/, '');
    const dir = parts.join('/');
    if (name === undefined || !/^[A-Za-z_]\w*$/.test(name) || !(dir === 'src' || dir.startsWith('src/'))) return false;
    for (const declarer of declarersOf(dir)) {
      const text = await this.text(crate, declarer);
      if (text !== null && declaresModule(text, name) && (await this.compiled(crate, declarer))) return true;
    }
    return false;
  }

  private text(crate: string, rel: string): Promise<string | null> {
    const path = crate === '' ? rel : `${crate}/${rel}`;
    let known = this.texts.get(path);
    if (known === undefined) {
      known = this.reader.text(this.rev, path);
      this.texts.set(path, known);
    }
    return known;
  }
}

/**
 * Whether a source declares the module `name` from a file of its own (`mod name;`) as cargo test compiles it: at the
 * top of the file, not in a comment or string, not under a cfg other than cfg(test) (on the declaration or on the whole
 * file), and not moved elsewhere by a #[path] attribute.
 */
function declaresModule(text: string, name: string): boolean {
  return scanRust(
    text.split('\n').map((t) => ({ text: t, added: false })),
    (attrs, code, compiled, nested) => {
      const mod = RUST_MOD_ITEM.exec(code);
      return compiled && !nested && mod !== null && mod[1] === name && mod[2] === ';' && !attrs.some((a) => offCfg(a.text) || /^#\[\s*(?:path\b|cfg_attr\b.*\bpath\s*=)/.test(a.text));
    },
  );
}

/** The sources whose `mod name;` declares a module file of `dir` (a directory of src/). */
function declarersOf(dir: string): string[] {
  if (dir === 'src') return ['src/lib.rs', 'src/main.rs'];
  // Every .rs file directly in src/bin is a binary's crate root already; a binary in its own folder declares its modules in main.rs.
  if (dir === 'src/bin') return [];
  if (/^src\/bin\/[^/]+$/.test(dir)) return [`${dir}/main.rs`, `${dir}/mod.rs`];
  return [`${dir}.rs`, `${dir}/mod.rs`];
}
