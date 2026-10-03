/**
 * Test and oracle weakening signals (spec §1 non-goals, §13 "Never remove
 * assertions, repeatedly inflate timeouts ... auto-accept changed
 * screenshots"). Input is a unified diff per changed file; output is a list
 * of signals the reviewer and the gates must account for.
 *
 * These are signals, not verdicts. A refactor that moves an assertion to
 * another file shows up as "assertion-removed" here; the point is that such a
 * change is never silent. Coverage: JavaScript/TypeScript, Python and Go
 * idioms, plus snapshot files, lint suppressions and test/lint configuration.
 */

export type WeakeningSignalId =
  | 'test-file-deleted'
  | 'assertion-removed'
  | 'assertion-weakened'
  | 'test-skipped'
  | 'test-focused'
  | 'timeout-raised'
  | 'snapshot-edited'
  | 'snapshot-added'
  | 'tolerance-increased'
  | 'lint-disabled'
  | 'test-config-weakened'
  | 'secret-scan-suppressed'
  | 'diff-attributes-changed';

export interface WeakeningInput {
  /** Repository-relative POSIX path. */
  path: string;
  /** git name-status letter: Added, Modified, Deleted, Type change. */
  status: 'A' | 'M' | 'D' | 'T';
  /** Unified diff for this one file (any context size); may be empty for binary files. */
  diff: string;
}

export interface WeakeningSignal {
  path: string;
  signal: WeakeningSignalId;
  detail: string;
}

type Lang = 'js' | 'py' | 'go' | 'other';

function langOf(path: string): Lang {
  if (/\.(m|c)?(j|t)sx?$|\.(vue|svelte)$/.test(path)) return 'js';
  if (/\.py$/.test(path)) return 'py';
  if (/\.go$/.test(path)) return 'go';
  return 'other';
}

/** Test sources by the common conventions of the three covered ecosystems. */
export function isTestPath(path: string): boolean {
  const p = path.toLowerCase();
  if (/(^|\/)(__tests__|__test__|tests?|specs?|e2e|integration-tests?|testing)\//.test(p)) return /\.(m|c)?(j|t)sx?$|\.py$|\.go$|\.(vue|svelte)$/.test(p);
  if (/\.(test|spec|e2e|cy)\.(m|c)?(j|t)sx?$/.test(p)) return true;
  if (/(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/.test(p)) return true;
  if (/_test\.go$/.test(p)) return true;
  return false;
}

/** Stored expectations: Jest/Vitest snapshots, Playwright and image baselines, syrupy. */
export function isSnapshotPath(path: string): boolean {
  return /(^|\/)(__snapshots__|__screenshots__|__image_snapshots__|snapshots)\/|-snapshots\/|\.snap$|\.ambr$/.test(path);
}

const TEST_CONFIG = /(^|\/)(jest|vitest|vite|playwright|karma|cypress|ava|wdio)\.config\.[a-z.]+$|(^|\/)(\.mocharc[a-z.]*|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py|package\.json|\.nycrc[a-z.]*|\.c8rc[a-z.]*)$/;
const LINT_CONFIG = /(^|\/)(\.eslintrc[a-z.]*|eslint\.config\.[a-z.]+|\.golangci\.(ya?ml|toml|json)|\.flake8|\.pylintrc|pylintrc|ruff\.toml|\.ruff\.toml|biome\.jsonc?|\.stylelintrc[a-z.]*|tslint\.json|\.rubocop\.yml|tsconfig[a-z.-]*\.json|mypy\.ini|\.mypy\.ini|pyrightconfig\.json|setup\.cfg|pyproject\.toml|tox\.ini)$/;

interface Parsed {
  added: string[];
  removed: string[];
  context: string[];
}

function parseDiff(diff: string): Parsed {
  const out: Parsed = { added: [], removed: [], context: [] };
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) out.added.push(line.slice(1));
    else if (line.startsWith('-')) out.removed.push(line.slice(1));
    else if (line.startsWith(' ')) out.context.push(line.slice(1));
  }
  return out;
}

const ASSERTION: Record<Lang, RegExp[]> = {
  js: [
    /\bexpect\s*\(/,
    /\bexpect\.(assertions|hasAssertions|soft)\s*\(/,
    /\bassert(\.[A-Za-z]+)?\s*\(/,
    /\.should\b/,
    /\bt\.(is|not|deepEqual|notDeepEqual|truthy|falsy|true|false|throws|throwsAsync|notThrows|regex|snapshot|equal|same|ok|notOk|match|strictEqual)\s*\(/,
    /\bsinon\.assert\./,
  ],
  py: [/^\s*assert\b/, /\bself\.assert\w*\s*\(/, /\bpytest\.(raises|warns|approx)\s*\(/, /\b(assert_\w+|assert_that)\s*\(/, /\.assert_(called|any_call|has_calls|not_called)\w*\s*\(/],
  go: [/\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/, /\b(assert|require)\.\w+\s*\(/, /\bExpect\s*\(/, /\bΩ\s*\(/],
  other: [],
};
ASSERTION.other = [...ASSERTION.js, ...ASSERTION.py, ...ASSERTION.go];

const COMMENT = /^\s*(\/\/|#|\*|\/\*|<!--)/;

const SKIP: RegExp[] = [
  /\b(describe|it|test|context|suite|specify)\.skip\b/,
  /\b(xit|xdescribe|xtest|xcontext|xspecify|xsuite)\s*\(/,
  /\btest\.(fixme|fail)\b/,
  /\btest\.describe\.(skip|fixme)\b/,
  /\b(it|test|describe)\.todo\b/,
  /\b(it|test|describe)\.(skipIf|runIf)\s*\(/,
  /\bthis\.skip\s*\(\s*\)/,
  /\bpending\s*\(\s*\)/,
  /@pytest\.mark\.(skip|skipif|xfail)\b/,
  /@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b/,
  /\bpytest\.(skip|xfail|importorskip)\s*\(/,
  /\bself\.skipTest\s*\(/,
  /raise\s+(unittest\.)?SkipTest\b/,
  /\bt\.(Skip|Skipf|SkipNow)\s*\(/,
];

const FOCUS: RegExp[] = [/\b(describe|it|test|context|suite)\.only\b/, /\b(fit|fdescribe|fcontext)\s*\(/, /\btest\.describe\.only\b/];

const GO_IGNORE = /^\s*\/\/\s*(\+build|go:build)\s+.*\bignore\b/;

const WEAK_MATCHER = /\.(toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined|toBeInstanceOf)\s*\(|\.not\.(toBeNull|toBeUndefined|toThrow)\s*\(|expect\.any(thing)?\s*\(/;
const TAUTOLOGY = /expect\((true|false|1|0|null)\)\.(toBe|toEqual)\(\1\)|^\s*assert\s+(True|1)\s*(#.*)?$|assert\.ok\(true\)|\bt\.pass\(\)|self\.assertTrue\(True\)/;

const LINT_SUPPRESS = /eslint-disable|@ts-(ignore|nocheck|expect-error)|tslint:disable|biome-ignore|oxlint-disable|#\s*noqa\b|#\s*type:\s*ignore|#\s*pylint:\s*disable|#\s*pyright:\s*ignore|\/\/\s*nolint\b|#\[allow\(|@SuppressWarnings|(istanbul|c8|v8)\s+ignore|#\s*pragma:?\s*no\s*cover|\bnosec\b|NOLINT|rubocop:disable|stylelint-disable/;

/** Keys whose number going UP loosens the check. */
const LOOSER_WHEN_HIGHER = ['maxDiffPixelRatio', 'maxDiffPixels', 'threshold', 'rtol', 'atol', 'rel', 'abs', 'delta', 'epsilon', 'tolerance', 'tol', 'retries'];
/** Keys whose number going DOWN loosens the check. */
const LOOSER_WHEN_LOWER = ['places', 'lines', 'branches', 'functions', 'statements'];

export function detectWeakening(files: readonly WeakeningInput[]): WeakeningSignal[] {
  const out: WeakeningSignal[] = [];
  for (const f of files) out.push(...detectWeakeningInFile(f));
  return out;
}

export function detectWeakeningInFile(file: WeakeningInput): WeakeningSignal[] {
  const { path, status } = file;
  const signals: WeakeningSignal[] = [];
  const add = (signal: WeakeningSignalId, detail: string) => {
    if (!signals.some((s) => s.signal === signal && s.detail === detail)) signals.push({ path, signal, detail });
  };
  const base = path.split('/').pop() ?? path;

  if (base === '.gitleaks.toml' || base === '.gitleaksignore' || base === 'gitleaks.toml') {
    add('secret-scan-suppressed', `secret-scanner configuration ${status === 'D' ? 'deleted' : 'changed'}`);
  }
  if (base === '.gitattributes') add('diff-attributes-changed', '.gitattributes can mark text as binary and hide changes from diffs');

  if (isSnapshotPath(path)) {
    if (status === 'A') add('snapshot-added', 'new stored expectation');
    else add('snapshot-edited', status === 'D' ? 'stored expectation deleted' : 'stored expectation changed');
    return signals;
  }

  const test = isTestPath(path);
  if (status === 'D') {
    if (test) add('test-file-deleted', 'test file deleted');
    return signals;
  }

  const lang = langOf(path);
  const d = parseDiff(file.diff);
  const addedCode = d.added.filter((l) => !COMMENT.test(l));
  const removedCode = d.removed.filter((l) => !COMMENT.test(l));

  // Suppressions are comments by nature, so they are looked for in every added line of every file.
  for (const line of d.added) {
    if (/\bgitleaks:allow\b/.test(line)) add('secret-scan-suppressed', 'gitleaks:allow added');
    else if (LINT_SUPPRESS.test(line)) add('lint-disabled', `suppression added: ${trimDetail(line)}`);
  }

  if (test || lang === 'other' && /\btest/i.test(path)) {
    const patterns = ASSERTION[lang];
    const isAssert = (l: string) => patterns.some((r) => r.test(l));
    const removedAsserts = removedCode.filter(isAssert).length;
    const addedAsserts = addedCode.filter(isAssert).length;
    if (removedAsserts > addedAsserts) add('assertion-removed', `${removedAsserts} assertion line(s) removed, ${addedAsserts} added`);
    if (d.added.some((l) => COMMENT.test(l) && isAssert(l))) add('assertion-removed', 'assertion commented out');
    if (removedAsserts > 0 && addedCode.some((l) => WEAK_MATCHER.test(l))) add('assertion-weakened', 'a specific matcher was replaced with a looser one');
    if (addedCode.some((l) => TAUTOLOGY.test(l))) add('assertion-weakened', 'assertion that cannot fail added');

    for (const line of addedCode) {
      if (SKIP.some((r) => r.test(line))) add('test-skipped', trimDetail(line));
      if (FOCUS.some((r) => r.test(line))) add('test-focused', `focused test hides the rest of the suite: ${trimDetail(line)}`);
      if (/\btest\.slow\s*\(/.test(line)) add('timeout-raised', 'test.slow() triples the timeout');
    }
    for (const line of d.added) if (GO_IGNORE.test(line)) add('test-skipped', 'build constraint excludes the file');

    if ([...d.added, ...d.removed, ...d.context].some((l) => /MatchInlineSnapshot\s*\(/.test(l)) && (d.added.length > 0 || d.removed.length > 0)) {
      if (d.removed.length > 0) add('snapshot-edited', 'inline snapshot changed');
    }
    closeToPrecision(d, add);
  }

  if (test || TEST_CONFIG.test(path) || LINT_CONFIG.test(path)) {
    // In a file that already existed, a timeout or tolerance that appears for
    // the first time loosens the framework default it replaces.
    const introduced = status !== 'A';
    compareTimeouts(d, add, introduced);
    compareNumbers(d, add, introduced);
  }

  if (TEST_CONFIG.test(path)) {
    for (const line of d.added) {
      if (/passWithNoTests|pass-with-no-tests/.test(line)) add('test-config-weakened', 'runs pass with no tests');
      if (/ignoreSnapshots\s*:\s*true/.test(line)) add('test-config-weakened', 'snapshot assertions ignored');
      if (/updateSnapshots\s*:\s*['"](?!none)/.test(line) || /--update-snapshots|(^|\s)-u(\s|$)/.test(line)) add('test-config-weakened', 'snapshots updated instead of compared');
      if (/\b(testPathIgnorePatterns|testIgnore|modulePathIgnorePatterns|collect_ignore|norecursedirs|--deselect|--ignore)\b/.test(line)) add('test-config-weakened', `tests excluded: ${trimDetail(line)}`);
      if (/\|\|\s*(true|exit 0|:)\b/.test(line)) add('test-config-weakened', `failure ignored: ${trimDetail(line)}`);
      if (/addopts\s*=.*\s-k\s/.test(line)) add('test-config-weakened', 'test selection narrowed with -k');
    }
  }
  if (LINT_CONFIG.test(path)) {
    for (const line of addedCode) {
      if (/["']off["']|:\s*0\s*[,}]?\s*$|"strict"\s*:\s*false|"noImplicitAny"\s*:\s*false|"skipLibCheck"\s*:\s*true|\b(ignore|extend-ignore|per-file-ignores|disable|exclude|ignore_errors|ignore_missing_imports)\b/.test(line)) {
        add('lint-disabled', `lint or type checking relaxed: ${trimDetail(line)}`);
      }
    }
  }
  return signals;
}

function trimDetail(line: string): string {
  const t = line.trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

type Add = (signal: WeakeningSignalId, detail: string) => void;

const TIMEOUT_RE = /([A-Za-z_$.]*timeout[A-Za-z_]*)['"]?\s*[:=(,]\s*\(?\s*([0-9][0-9_]*(?:\.[0-9]+)?)/gi;

function numbersByKey(lines: string[], re: RegExp, normalizeKey: (k: string) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    for (const m of line.matchAll(re)) {
      const key = normalizeKey(m[1]!);
      const value = Number(m[2]!.replace(/_/g, ''));
      if (!Number.isFinite(value)) continue;
      out.set(key, Math.max(out.get(key) ?? -Infinity, value));
    }
  }
  return out;
}

const code = (lines: string[]) => lines.filter((l) => !COMMENT.test(l));

function compareTimeouts(d: Parsed, add: Add, introduced: boolean): void {
  const norm = (k: string) => k.toLowerCase().replace(/^.*\./, '');
  const before = numbersByKey(code(d.removed), TIMEOUT_RE, norm);
  const after = numbersByKey(code(d.added), TIMEOUT_RE, norm);
  const unchanged = numbersByKey(code(d.context), TIMEOUT_RE, norm);
  for (const [key, value] of after) {
    const old = before.get(key);
    if (old !== undefined && value > old) add('timeout-raised', `${key} ${old} -> ${value}`);
    if (old === undefined && introduced && !unchanged.has(key)) add('timeout-raised', `${key} set to ${value} where the default applied`);
  }
}

function compareNumbers(d: Parsed, add: Add, introduced: boolean): void {
  const keys = [...LOOSER_WHEN_HIGHER, ...LOOSER_WHEN_LOWER];
  const re = new RegExp(`\\b(${keys.join('|')})['"]?\\s*[:=]\\s*([0-9][0-9_]*(?:\\.[0-9]+)?(?:e-?[0-9]+)?)`, 'gi');
  const before = numbersByKey(code(d.removed), re, (k) => k);
  const after = numbersByKey(code(d.added), re, (k) => k);
  const unchanged = numbersByKey(code(d.context), re, (k) => k);
  for (const [key, value] of after) {
    const old = before.get(key);
    if (old === undefined) {
      // A new tolerance or retry count loosens an exact, single-run default; a new coverage floor only tightens.
      const loosens = LOOSER_WHEN_HIGHER.some((k) => k.toLowerCase() === key.toLowerCase());
      if (introduced && loosens && value > 0 && !unchanged.has(key)) add(key.toLowerCase() === 'retries' ? 'test-config-weakened' : 'tolerance-increased', `${key} set to ${value} where the default applied`);
      continue;
    }
    const higherLooser = LOOSER_WHEN_HIGHER.some((k) => k.toLowerCase() === key.toLowerCase());
    if (higherLooser && value > old) add(key.toLowerCase() === 'retries' ? 'test-config-weakened' : 'tolerance-increased', `${key} ${old} -> ${value}`);
    if (!higherLooser && value < old) add(['places'].includes(key.toLowerCase()) ? 'tolerance-increased' : 'test-config-weakened', `${key} ${old} -> ${value}`);
  }
  // Go testify: assert.InDelta(t, a, b, delta) / InEpsilon(...): the last argument is the tolerance.
  const lastArg = (lines: string[]) => {
    let max = -Infinity;
    for (const l of lines) for (const m of l.matchAll(/\b(InDelta|InEpsilon|InDeltaSlice|InEpsilonSlice)\s*\([^)]*,\s*([0-9.eE-]+)\s*\)/g)) max = Math.max(max, Number(m[2]));
    return max;
  };
  const oldTol = lastArg(d.removed);
  const newTol = lastArg(d.added);
  if (Number.isFinite(oldTol) && Number.isFinite(newTol) && newTol > oldTol) add('tolerance-increased', `InDelta/InEpsilon ${oldTol} -> ${newTol}`);
}

/** toBeCloseTo(x, digits): fewer digits is a looser comparison; the default is 2. */
function closeToPrecision(d: Parsed, add: Add): void {
  const digits = (lines: string[]) => {
    const found: number[] = [];
    for (const l of lines) {
      for (const m of l.matchAll(/toBeCloseTo\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
        const parts = m[1]!.split(',');
        const p = parts.length >= 2 ? Number(parts[parts.length - 1]!.trim()) : 2;
        if (Number.isFinite(p)) found.push(p);
      }
    }
    return found;
  };
  const before = digits(d.removed);
  const after = digits(d.added);
  if (before.length > 0 && after.length > 0 && Math.min(...after) < Math.min(...before)) {
    add('tolerance-increased', `toBeCloseTo precision ${Math.min(...before)} -> ${Math.min(...after)} digits`);
  }
}
