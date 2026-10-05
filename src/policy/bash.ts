/**
 * Static classification of a Bash tool command, used by the guard hook to
 * deny the obviously unauthorized: commits, pushes, branch switches, history
 * rewrites, gh, piping downloads into a shell, sudo, recursive deletes
 * outside the worktree, package installs the policy does not allow, and
 * writes to protected paths through redirection when the target is visible.
 *
 * THIS IS ADVISORY. A shell can always hide what it does (a script file, an
 * interpreter one-liner, an alias defined elsewhere), so a command that
 * classifies as harmless is not thereby authorized to do harm. The real
 * gates are the OS sandbox around the worker (filesystem write allowlist,
 * egress allowlist, no delivery credentials) and the controller's own
 * inspection of the candidate diff (policy/scope.ts). Classification only
 * makes the common violations fail fast with a clear reason.
 *
 * Fail-closed choices: an unparseable command, a command name or `sh -c`
 * body computed at run time, a PATH/BASH_ENV/LD_PRELOAD-style override, a
 * pager or editor variable holding a command, a shopt that changes globbing,
 * or a wrapper that assembles command lines itself (parallel, tmux, expect)
 * is reported as opaque, and authorization denies opaque commands. A write
 * relative to a directory the classifier lost track of (`cd -`, `popd`,
 * `cd "$DIR"`) is reported with `unknownDir` and denied. Brace expansion and
 * ANSI-C quoting are decoded by the lexer, so neither can hide a name.
 */
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { posix } from 'node:path';
import { parseShell, type Redirect, type SimpleCommand, type Word } from './shell.ts';
import { normalizeHost } from './hosts.ts';

export type BashCategory =
  | 'read-only'
  | 'build-test'
  | 'vcs-read'
  | 'vcs-write'
  | 'publish'
  | 'network'
  | 'package-install'
  | 'destructive'
  | 'privilege'
  | 'unknown';

/** Most severe first. A compound command takes the most severe category of its parts. */
export const BASH_CATEGORIES_BY_SEVERITY: readonly BashCategory[] = Object.freeze([
  'privilege',
  'destructive',
  'publish',
  'vcs-write',
  'package-install',
  'network',
  'unknown',
  'build-test',
  'vcs-read',
  'read-only',
]);

export interface BashWrite {
  /** Target as written in the command. */
  path: string;
  /** Absolute target, joined but not normalized; null when it depends on run time or on an unknown directory. */
  abs: string | null;
  /**
   * 'link': the path becomes reachable under another name (the target of
   * `ln -s`, the source of a hard link), so writing that name writes it.
   */
  kind: 'write' | 'delete' | 'link';
  /** Relative target after a `cd` the classifier could not follow (`cd -`, `popd`, `cd "$DIR"`). */
  unknownDir?: boolean;
  /** Fills a directory with content the classifier cannot see (archive extraction, clone). */
  unpack?: boolean;
  recursive: boolean;
  /** Target contains unquoted glob characters. */
  glob: boolean;
  /** What writes it: '>', 'tee', 'rm', 'cp', ... */
  via: string;
}

export interface BashCommandInfo {
  argv: string[];
  category: BashCategory;
  reasons: string[];
  /** Network destinations seen in the arguments. */
  hosts: string[];
  /** False when some destination is not statically known (a remote name, a proxy, a config file). */
  hostsComplete: boolean;
  /** For package-install: installs exactly the existing lockfile, or adds/changes dependencies. */
  install: 'locked' | 'add' | null;
  /** For JavaScript package installs: whether lifecycle scripts were disabled. */
  ignoreScripts: boolean | null;
}

/** A file a command reads, as far as the command line shows it (ADR 0005: credential paths are denied). */
export interface BashRead {
  /** Path as written in the command. */
  path: string;
  /** Absolute path, joined but not normalized; null when it depends on run time or on an unknown directory. */
  abs: string | null;
  /** Contains unquoted glob characters. */
  glob: boolean;
  /** What reads it: '<', 'cat', 'grep', ... */
  via: string;
}

export interface BashClassification {
  category: BashCategory;
  reasons: string[];
  /** False when the command could not be tokenized; callers must deny. */
  parsed: boolean;
  /** Part of the behaviour is hidden from static analysis; callers must deny. */
  opaque: boolean;
  commands: BashCommandInfo[];
  writes: BashWrite[];
  /** Files named as inputs of commands known to read their arguments, and input redirections. */
  reads: BashRead[];
}

export interface BashContext {
  /** Absolute directory the command starts in. */
  cwd?: string;
  /** Absolute worktree root; deletes outside it are destructive. Defaults to cwd. */
  root?: string;
  home?: string;
}

// An impossible directory standing in for "the session's cwd" when the caller gave none.
const CWD_MARK = '/\u0000cwd';
const MAX_DEPTH = 8;

interface State {
  commands: BashCommandInfo[];
  writes: BashWrite[];
  reads: BashRead[];
  reasons: string[];
  opaque: boolean;
  parsed: boolean;
  home: string;
  root: string;
  knownCwd: boolean;
}

export function classifyBash(command: string, ctx: BashContext = {}): BashClassification {
  const cwd = ctx.cwd ?? CWD_MARK;
  const state: State = {
    commands: [],
    writes: [],
    reads: [],
    reasons: [],
    opaque: false,
    parsed: true,
    home: ctx.home ?? homedir(),
    root: ctx.root ?? cwd,
    knownCwd: ctx.cwd !== undefined,
  };
  if (typeof command !== 'string' || command.trim() === '') {
    state.parsed = typeof command === 'string';
    if (!state.parsed) state.reasons.push('command is not a string');
  } else {
    classifySource(command, state, 0, cwd);
  }
  const severities = [...state.commands.map((c) => c.category)];
  let category: BashCategory = 'read-only';
  if (!state.parsed || state.opaque) category = 'unknown';
  for (const c of BASH_CATEGORIES_BY_SEVERITY) {
    if (severities.includes(c) && BASH_CATEGORIES_BY_SEVERITY.indexOf(c) < BASH_CATEGORIES_BY_SEVERITY.indexOf(category)) category = c;
  }
  const reasons = [...state.reasons];
  for (const c of BASH_CATEGORIES_BY_SEVERITY) {
    for (const info of state.commands) if (info.category === c) for (const r of info.reasons) if (!reasons.includes(r)) reasons.push(r);
  }
  return { category, reasons, parsed: state.parsed, opaque: state.opaque, commands: state.commands, writes: state.writes, reads: state.reads };
}

// ---------------------------------------------------------------------------
// Walking the parsed command

function classifySource(src: string, state: State, depth: number, base: string | null): void {
  if (depth > MAX_DEPTH) {
    markOpaque(state, 'command nests substitutions too deeply to inspect');
    return;
  }
  const parsed = parseShell(src);
  if (!parsed.ok) {
    state.parsed = false;
    state.reasons.push(`cannot parse the command (${parsed.error})`);
  }
  const cwdByScope = new Map<string, string | null>([['', base]]);
  const pipelines = new Map<number, SimpleCommand[]>();
  for (const cmd of parsed.commands) {
    const list = pipelines.get(cmd.pipeline) ?? [];
    list.push(cmd);
    pipelines.set(cmd.pipeline, list);
  }
  for (const cmd of parsed.commands) {
    const here = lookupBase(cwdByScope, cmd.scope);
    for (const w of [...cmd.assigns, ...cmd.words]) for (const sub of w.subs) classifySource(sub, state, depth + 1, here);
    for (const r of cmd.redirects) {
      for (const sub of r.target?.subs ?? []) classifySource(sub, state, depth + 1, here);
      for (const sub of r.heredoc?.subs ?? []) classifySource(sub, state, depth + 1, here);
    }
    const previous = (pipelines.get(cmd.pipeline) ?? []).filter((c) => c.stage < cmd.stage);
    const cd = classifyCommand(cmd, here, state, depth, previous);
    if (cd !== undefined) cwdByScope.set(cmd.scope.join('/'), cd);
  }
}

/** The directory a command runs in: the latest `cd` in its own subshell or the nearest enclosing one. */
function lookupBase(map: Map<string, string | null>, scope: number[]): string | null {
  for (let n = scope.length; n >= 0; n--) {
    const key = scope.slice(0, n).join('/');
    if (map.has(key)) return map.get(key)!;
  }
  return null;
}

const RESERVED_PREFIX = new Set(['!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', '{', 'time']);
const RESERVED_END = new Set(['fi', 'done', 'esac', '}']);

/** Returns the new working directory when the command is a `cd`; undefined otherwise. */
function classifyCommand(cmd: SimpleCommand, base: string | null, state: State, depth: number, previous: SimpleCommand[]): string | null | undefined {
  for (const r of cmd.redirects) handleRedirect(r, base, state);
  checkAssignments(cmd.assigns, state, cmd.words.length === 0);
  let words = cmd.words.slice();
  while (words.length > 0 && !words[0]!.quoted && RESERVED_PREFIX.has(words[0]!.text)) {
    words = words.slice(1);
    if (words[0]?.text === '-p') words = words.slice(1);
  }
  if (words.length === 0) return undefined;
  const first = words[0]!;
  if (!first.quoted && RESERVED_END.has(first.text)) return undefined;
  if (!first.quoted && (first.text === 'for' || first.text === 'select')) return undefined;
  if (!first.quoted && (first.text === 'function' || first.text === 'case' || first.text === 'coproc')) {
    markOpaque(state, `"${first.text}" blocks are not inspected`);
    return undefined;
  }
  return classifyArgv(words, { state, depth, base, cmd, previous });
}

interface Env {
  state: State;
  depth: number;
  base: string | null;
  cmd: SimpleCommand;
  previous: SimpleCommand[];
}

class Info {
  category: BashCategory = 'unknown';
  reasons: string[] = [];
  hosts: string[] = [];
  hostsComplete = true;
  install: 'locked' | 'add' | null = null;
  ignoreScripts: boolean | null = null;
  private set = false;

  /** Raise the category to `cat` if it is more severe than what is recorded. */
  raise(cat: BashCategory, reason?: string): this {
    if (!this.set || BASH_CATEGORIES_BY_SEVERITY.indexOf(cat) < BASH_CATEGORIES_BY_SEVERITY.indexOf(this.category)) this.category = cat;
    this.set = true;
    if (reason && !this.reasons.includes(reason)) this.reasons.push(reason);
    return this;
  }
  setInstall(kind: 'locked' | 'add'): this {
    // 'add' is sticky: one adding step makes the whole command an add.
    if (this.install !== 'add') this.install = kind;
    return this;
  }
  host(h: string | null): this {
    const n = h === null ? null : normalizeHost(h);
    if (n === null) this.hostsComplete = false;
    else if (!this.hosts.includes(n)) this.hosts.push(n);
    return this;
  }
}

function emit(env: Env, words: Word[], info: Info): void {
  env.state.commands.push({
    argv: words.map((w) => w.text),
    category: info.category,
    reasons: info.reasons,
    hosts: info.hosts,
    hostsComplete: info.hostsComplete,
    install: info.install,
    ignoreScripts: info.ignoreScripts,
  });
}

function classifyArgv(words: Word[], env: Env): string | null | undefined {
  const head = words[0]!;
  const args = words.slice(1);
  const info = new Info();
  if (head.dynamic) {
    // A computed program name (`$TOOL args`) hides what will actually run.
    markOpaque(env.state, `the program name "${head.text}" is computed at run time`);
    emit(env, words, info.raise('unknown', 'program name computed at run time'));
    return undefined;
  }
  const name = programName(head.text);

  // Wrappers: classify the wrapped command as well, the wrapper itself adds nothing.
  const wrapped = unwrap(name, args, env);
  if (wrapped !== undefined) {
    if (wrapped === null) return undefined;
    if (wrapped.length === 0) {
      emit(env, words, info.raise('read-only'));
      return undefined;
    }
    return classifyArgv(wrapped, env);
  }

  collectReads(name, args, env);
  let cd: string | null | undefined;
  const handler = handlerFor(name);
  if (handler) {
    const r = handler(info, args, env, name);
    if (r && 'cd' in r) cd = r.cd;
  } else if (READ_ONLY.has(name)) {
    info.raise('read-only');
  } else if (BUILD_TEST.has(name)) {
    info.raise('build-test');
  } else if (PRIVILEGE.has(name)) {
    info.raise('privilege', `${name} changes system state or escalates privileges`);
  } else if (PUBLISH.has(name)) {
    info.raise('publish', `${name} deploys or changes remote services`);
  } else if (DESTRUCTIVE.has(name)) {
    info.raise('destructive', `${name} can destroy data outside the worktree`);
  } else if (head.text.includes('/')) {
    info.raise('build-test', `runs ${head.text} from a path`);
  } else {
    info.raise('unknown', `unrecognized command "${name}"`);
  }
  emit(env, words, info);
  return cd;
}

function programName(text: string): string {
  const base = text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text;
  return base;
}

// ---------------------------------------------------------------------------
// Wrappers

/** The wrapped argv, [] when the wrapper runs nothing, null when handled here, undefined when `name` is not a wrapper. */
function unwrap(name: string, args: Word[], env: Env): Word[] | null | undefined {
  switch (name) {
    case 'sudo':
    case 'doas':
    case 'su':
    case 'pkexec':
    case 'runuser':
    case 'run0': {
      const info = new Info().raise('privilege', `${name} runs a command with elevated privileges`);
      emit(env, [{ ...literal(name) }, ...args], info);
      const rest = skipOptions(args, new Set(['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '-D', '-c']));
      if (name === 'su') {
        const c = valueOf(args, '-c');
        if (c) nestedShell(c, env, 'su -c');
        return null;
      }
      return rest.length > 0 ? rest : null;
    }
    case 'env': {
      const out: Word[] = [];
      let i = 0;
      for (; i < args.length; i++) {
        const t = args[i]!.text;
        if (t === '--') {
          i++;
          break;
        }
        if (t === '-i' || t === '-0' || t === '--ignore-environment' || t === '-v') continue;
        if (t === '-u' || t === '--unset') {
          i++;
          continue;
        }
        if (t.startsWith('--unset=')) continue;
        if (t === '-S' || t.startsWith('--split-string')) {
          const v = t.includes('=') ? t.slice(t.indexOf('=') + 1) : args[i + 1]?.text;
          if (v === undefined || args[i + 1]?.dynamic) markOpaque(env.state, 'env -S with a computed string');
          else nestedShell(literal(v), env, 'env -S');
          return null;
        }
        if (t === '-C' || t === '--chdir' || t.startsWith('--chdir=')) {
          markOpaque(env.state, 'env changes directory before running the command');
          if (t === '-C' || t === '--chdir') i++;
          continue;
        }
        if (t.startsWith('-')) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]!.raw)) {
          checkAssignments([args[i]!], env.state, false);
          continue;
        }
        break;
      }
      out.push(...args.slice(i));
      return out;
    }
    case 'command': {
      if (args[0]?.text === '-v' || args[0]?.text === '-V') return [];
      return args[0]?.text === '-p' ? args.slice(1) : args;
    }
    case 'builtin':
    case 'nohup':
    case 'chronic':
    case 'unbuffer':
    case 'setsid':
      return args;
    case 'exec': {
      return skipOptions(args, new Set(['-a']));
    }
    case 'nice':
    case 'ionice':
      return skipOptions(args, new Set(['-n', '-c', '-p', '--adjustment', '--class', '--classdata']));
    case 'stdbuf':
      return skipOptions(args, new Set(['-i', '-o', '-e']));
    case 'caffeinate':
      return skipOptions(args, new Set(['-t', '-w']));
    case 'arch':
      return skipOptions(args, new Set(['-e']));
    case 'flock': {
      const rest = skipOptions(args, new Set(['-w', '-E', '--timeout', '--conflict-exit-code']));
      const c = valueOf(args, '-c');
      if (c) {
        nestedShell(c, env, 'flock -c');
        return null;
      }
      return rest.slice(1);
    }
    case 'timeout':
    case 'gtimeout': {
      const rest = skipOptions(args, new Set(['-s', '--signal', '-k', '--kill-after']));
      return rest.slice(1);
    }
    case 'xargs': {
      const rest = skipOptions(args, new Set(['-n', '-I', '-P', '-L', '-d', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--max-lines']));
      if (rest.length === 0) return [];
      // -I R (and -i / --replace, which default R to {}) put each input line wherever R appears.
      const replace = valueOf(args, '-I')?.text ?? valueOfLong(args, '--replace')?.text ?? (args.some((a) => a.text === '-i' || a.text === '--replace') ? '{}' : undefined);
      if (replace !== undefined && replace.length > 0) {
        return rest.map((w) => (w.text.includes(replace) ? dynamicWord(w.text) : w));
      }
      // Arguments arrive on stdin, so every target of the wrapped command is computed at run time.
      return [...rest, dynamicWord('{xargs input}')];
    }
    case 'script': {
      // util-linux `script -c CMD`; the BSD form is `script [-q] file CMD...`.
      const c = valueOf(args, '-c') ?? valueOfLong(args, '--command');
      if (c) {
        nestedShell(c, env, 'script -c');
        return null;
      }
      const rest = skipOptions(args, new Set(['-t', '-T', '-F']));
      return rest.slice(1);
    }
    case 'direnv': {
      if (args[0]?.text !== 'exec') return [];
      return args.slice(2);
    }
    case 'watch': {
      const rest = skipOptions(args, new Set(['-n', '--interval', '-d', '--differences', '-q', '--equexit', '--chgexit']));
      if (rest.some((w) => w.dynamic)) markOpaque(env.state, 'watch runs a computed command');
      else if (rest.length > 0) nestedShell(literal(rest.map((w) => w.text).join(' ')), env, 'watch');
      return null;
    }
    // Programs that run the rest of their argv. Unrecognised programs are
    // allowed, so every wrapper missing here was a way to hide a command.
    case 'time':
    case 'gtime':
      return skipOptions(args, new Set(['-f', '--format', '-o', '--output']));
    case 'busybox':
    case 'toybox':
      return args;
    case 'strace':
    case 'ltrace':
      return skipOptions(args, new Set(['-o', '-e', '-p', '-s', '-E', '-u', '-a', '-b', '-I', '-O', '-P', '-S', '-X', '-U', '-n']));
    case 'valgrind':
    case 'entr':
    case 'catchsegv':
    case 'nocache':
      return skipOptions(args, new Set());
    case 'cpulimit':
      return skipOptions(args, new Set(['-l', '--limit', '-p', '--pid', '-e', '--exe', '-P', '--path']));
    case 'numactl':
      return skipOptions(args, new Set(['-N', '-m', '-C', '-p', '-i', '-l']));
    case 'fakeroot':
      return skipOptions(args, new Set(['-l', '--lib', '--faked', '-s', '-i', '-b']));
    case 'dotenv':
      return skipOptions(args, new Set(['-e', '-v', '-c', '-p']));
    case 'taskset': {
      const rest = skipOptions(args, new Set());
      // `taskset -c LIST cmd` puts the list behind the flag; `taskset MASK cmd` in front of the command.
      return args.some((a) => a.text === '-c' || a.text === '--cpu-list') ? rest : rest.slice(1);
    }
    case 'chrt':
    case 'faketime':
      return skipOptions(args, new Set(['-f', '-m'])).slice(1);
    case 'hyperfine':
    case 'concurrently': {
      // Each positional argument is a shell command line.
      const valueOpts = name === 'hyperfine'
        ? new Set(['-w', '--warmup', '-m', '--min-runs', '-M', '--max-runs', '-r', '--runs', '-s', '--setup', '-p', '--prepare', '-c', '--cleanup', '-P', '--parameter-scan', '-D', '--parameter-step-size', '-L', '--parameter-list', '-S', '--shell', '--export-json', '--export-csv', '--export-markdown', '-n', '--command-name', '--style', '-u', '--time-unit', '--output', '--sort'])
        : new Set(['-n', '--names', '-c', '--prefix-colors', '-p', '--prefix', '--name-separator', '--restart-tries', '--restart-after', '-k', '--kill-others-on-fail', '--timings', '--default-input-target', '-l', '--prefix-length', '-t', '--timestamp-format', '--max-processes', '--success']);
      const setup = name === 'hyperfine' ? ['-s', '--setup', '-p', '--prepare', '-c', '--cleanup'].map((o) => valueOf(args, o) ?? valueOfLong(args, o)).filter((w): w is Word => w !== undefined) : [];
      for (const w of [...setup, ...positional(args, valueOpts)]) {
        if (w.dynamic) markOpaque(env.state, `${name} runs a command computed at run time`);
        else nestedShell(w, env, name);
      }
      return null;
    }
    case 'parallel':
    case 'sem':
    case 'rush':
    case 'tmux':
    case 'screen':
    case 'dtach':
    case 'abduco':
    case 'expect':
    case 'watchexec':
    case 'pueue':
    case 'tsp':
    case 'proxychains':
    case 'proxychains4':
    case 'torsocks':
    case 'tsocks':
      // They assemble or hand off command lines (or the route they take) in ways the classifier cannot follow.
      markOpaque(env.state, `${name} runs commands the classifier cannot see`);
      return null;
    case 'nodemon':
      if (args.some((a) => a.text === '--exec' || a.text === '-x' || a.text.startsWith('--exec='))) {
        markOpaque(env.state, 'nodemon --exec runs a command the classifier cannot see');
        return null;
      }
      return undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tables

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'fd', 'wc', 'which', 'whereis',
  'type', 'pwd', 'echo', 'printf', 'diff', 'cmp', 'comm', 'stat', 'du', 'df', 'file', 'tree', 'cut', 'paste', 'join',
  'tr', 'column', 'fold', 'fmt', 'nl', 'rev', 'tac', 'expand', 'unexpand', 'jq', 'basename', 'dirname', 'realpath',
  'readlink', 'printenv', 'cal', 'whoami', 'id', 'groups', 'uname', 'true', 'false', 'test', '[', '[[', ':', 'sleep',
  'seq', 'hexdump', 'od', 'strings', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'b2sum',
  'ps', 'pgrep', 'lsof', 'uptime', 'free', 'vm_stat', 'nproc', 'locale', 'tput', 'clear', 'help', 'man', 'info',
  'apropos', 'whatis', 'wait', 'jobs', 'exit', 'return', 'break', 'continue', 'unset', 'shift', 'getconf', 'tty',
  'nm', 'otool', 'objdump', 'ldd', 'pushd', 'popd', 'dirs', 'read', 'set', 'shopt', 'umask', 'ulimit', 'local',
  'let', 'getopts', 'hash', 'dig', 'awk', 'gawk', 'mawk', 'nawk', 'sort', 'uniq', 'xxd', 'base64', 'yq', 'date',
  'hostname', 'sysctl', 'defaults', 'top', 'htop', 'cloc', 'tokei', 'gzcat', 'zcat', 'bzcat', 'xzcat', 'zless',
]);

const BUILD_TEST = new Set([
  'make', 'gmake', 'cmake', 'ninja', 'meson', 'bazel', 'bazelisk', 'buck', 'buck2', 'node', 'nodejs', 'tsc', 'tsx',
  'ts-node', 'esbuild', 'vite', 'webpack', 'rollup', 'parcel', 'next', 'nuxt', 'vitest', 'jest', 'mocha', 'ava', 'tap',
  'cypress', 'eslint', 'prettier', 'biome', 'oxlint', 'stylelint', 'standard', 'xo', 'pytest', 'py.test', 'tox', 'nox',
  'mypy', 'pyright', 'ruff', 'black', 'isort', 'flake8', 'pylint', 'bandit', 'coverage', 'ruby', 'rake', 'rspec',
  'rubocop', 'gofmt', 'goimports', 'golangci-lint', 'staticcheck', 'rustc', 'rustfmt', 'javac', 'java', 'mvn', 'mvnw',
  'gradle', 'gradlew', 'sbt', 'kotlinc', 'swiftc', 'xcodebuild', 'xcrun', 'clang', 'clang++', 'gcc', 'g++', 'cc',
  'c++', 'ld', 'ar', 'php', 'phpunit', 'lua', 'R', 'Rscript', 'julia', 'elixir', 'erl', 'ghc', 'mkdir', 'touch',
  'rmdir', 'patch', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz', 'zstd', 'split',
  'csplit', 'envsubst', 'jsonnet', 'protoc', 'buf', 'sqlite3', 'lefthook', 'turbo', 'nx', 'lerna', 'tsup', 'swc',
  'babel', 'storybook', 'gitleaks', 'semgrep', 'shellcheck', 'shfmt', 'hadolint', 'actionlint', 'markdownlint',
  'cspell', 'typos', 'codespell', 'license-checker', 'knip', 'madge', 'depcheck', 'playwright-test',
]);

const PRIVILEGE = new Set([
  'chroot', 'setcap', 'chown', 'chgrp', 'launchctl', 'systemctl', 'service', 'crontab', 'at', 'batch', 'osascript',
  'security', 'dscl', 'scutil', 'networksetup', 'pfctl', 'iptables', 'ip6tables', 'nft', 'ufw', 'mount', 'umount',
  'nvram', 'csrutil', 'spctl', 'xattr', 'docker', 'podman', 'nerdctl', 'colima', 'orb', 'orbctl', 'limactl', 'lima',
  'kubeadm', 'insmod', 'modprobe', 'rmmod', 'passwd', 'useradd', 'usermod', 'userdel', 'visudo', 'tccutil', 'sysadminctl',
  'kextload', 'ssh-add', 'ssh-agent', 'ssh-keygen', 'gpg', 'gpg2', 'keychain', 'git-credential-osxkeychain', 'sandbox-exec', 'srt',
  // Secret injectors: they exist to put credentials into a command's environment.
  'op', 'aws-vault', 'doppler', 'infisical', 'chamber', 'envchain', 'sops', 'vault', 'systemd-run',
  // Namespace, identity and sandbox tools: they change what the wrapped command may touch.
  'unshare', 'nsenter', 'bwrap', 'firejail', 'proot', 'chpst', 'sg', 'newgrp', 'setpriv', 'capsh', 'systemd-nspawn', 'machinectl',
]);

const PUBLISH = new Set([
  'gh', 'hub', 'glab', 'twine', 'vsce', 'ovsx', 'firebase', 'vercel', 'netlify', 'flyctl', 'fly', 'heroku', 'aws',
  'gcloud', 'gsutil', 'az', 'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'serverless', 'sls', 'wrangler', 'cdk',
  'sam', 'eb', 'doctl', 'railway', 'ansible', 'ansible-playbook', 'kamal', 'oc', 'eksctl', 'skaffold', 'tilt', 'gem-push',
]);

const DESTRUCTIVE = new Set(['mkfs', 'mke2fs', 'fdisk', 'sfdisk', 'parted', 'wipefs', 'shutdown', 'reboot', 'halt', 'poweroff', 'srm', 'diskutil']);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'mksh', 'busybox']);
const INTERPRETERS = new Set([...SHELLS, 'python', 'python3', 'python2', 'node', 'nodejs', 'perl', 'ruby', 'php', 'pwsh', 'osascript', 'deno', 'bun', 'lua']);
const FETCHERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'xh', 'aria2c', 'nc', 'ncat', 'netcat', 'socat']);

/** Environment names that change what later commands are, or inject code into them. */
const SENSITIVE_ENV = /^(PATH|BASH_ENV|ENV|IFS|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|PS4|CDPATH|GLOBIGNORE|LD_[A-Z_]+|DYLD_[A-Z_]+|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GIT_[A-Z_]+|GH_[A-Z_]+|GITHUB_TOKEN|SSH_AUTH_SOCK|HOME|ZDOTDIR|PAGER|MANPAGER|EDITOR|VISUAL|FCEDIT|LESSOPEN|LESSCLOSE|BROWSER|SUDO_ASKPASS|npm_config_[a-z_]+|NPM_CONFIG_[A-Z_]+)$/;
/** Of those, the ones that harmlessly appear with test runners and are not a way to swap programs. */
const BENIGN_ENV = new Set(['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'npm_config_ignore_scripts', 'NPM_CONFIG_IGNORE_SCRIPTS', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE']);
/**
 * Pager and editor variables hold a command line the program later runs
 * (`GIT_PAGER='sh -c ...' git -p log`), so only well-known plain values are benign.
 */
const COMMAND_ENV = new Set(['GIT_PAGER', 'PAGER', 'MANPAGER', 'GIT_EDITOR', 'EDITOR', 'VISUAL', 'GIT_SEQUENCE_EDITOR']);
const BENIGN_COMMAND_VALUE = /^(|cat|less|more|true|false|:|vi|vim|nvim|nano|less -[A-Za-z]+)$/;

function checkAssignments(assigns: Word[], state: State, persistent: boolean): void {
  for (const a of assigns) {
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(a.raw)?.[0] ?? '';
    if (BENIGN_ENV.has(name)) continue;
    if (COMMAND_ENV.has(name) && !a.dynamic && BENIGN_COMMAND_VALUE.test(a.text.slice(a.text.indexOf('=') + 1))) continue;
    if (/^(LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH)$/.test(name)) {
      state.commands.push({
        argv: [a.text],
        category: 'privilege',
        reasons: [`${name} injects a shared library into the command`],
        hosts: [],
        hostsComplete: true,
        install: null,
        ignoreScripts: null,
      });
      continue;
    }
    if (SENSITIVE_ENV.test(name)) {
      markOpaque(state, `setting ${name} ${persistent ? 'changes how every later command runs' : 'changes what the command runs'}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Redirections and writes

const DEV_SINKS = /^\/dev\/(null|stdout|stderr|stdin|tty|fd\/\d+|zero|random|urandom)$/;

function handleRedirect(r: Redirect, base: string | null, state: State): void {
  const target = r.target;
  if (!target) return;
  const isWrite = ['>', '>>', '>|', '&>', '&>>', '<>'].includes(r.op) || (r.op === '>&' && !/^(\d+|-)$/.test(target.text));
  const isRead = r.op === '<' || r.op === '<&' || r.op === '<>';
  const net = /^\/dev\/(tcp|udp)\/([^/]+)\/(\d+)$/.exec(target.text);
  if (net && (isWrite || isRead)) {
    const info = new Info().raise('network', `opens a ${net[1]} connection through /dev/${net[1]}`).host(target.dynamic ? null : net[2]!);
    state.commands.push({ argv: [r.op, target.text], category: info.category, reasons: info.reasons, hosts: info.hosts, hostsComplete: info.hostsComplete, install: null, ignoreScripts: null });
    return;
  }
  if (isRead && r.op !== '<&') addRead(state, target, base, r.op);
  if (!isWrite) return;
  if (!target.dynamic && DEV_SINKS.test(target.text)) return;
  addWrite(state, target, base, 'write', r.op, false);
}

function addRead(state: State, word: Word, base: string | null, via: string): void {
  if (!word.text || DEV_SINKS.test(word.text)) return;
  const abs = targetPath(word, base, state);
  state.reads.push({ path: word.text, abs: abs !== null && abs.startsWith(CWD_MARK) ? null : abs, glob: word.glob, via });
}

/** Commands whose arguments are files they read (or copy, or upload), for the static credential-read check. */
const FILE_READERS: ReadonlySet<string> = new Set([
  'cat', 'tac', 'head', 'tail', 'less', 'more', 'most', 'nl', 'od', 'xxd', 'hexdump', 'strings', 'base64', 'base32', 'basenc',
  'cp', 'install', 'grep', 'egrep', 'fgrep', 'zgrep', 'zcat', 'gzcat', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk', 'mawk',
  'sort', 'uniq', 'cut', 'paste', 'join', 'comm', 'diff', 'cmp', 'sdiff', 'jq', 'yq', 'bat', 'batcat', 'fold', 'fmt', 'column',
  'rev', 'shuf', 'split', 'source', '.', 'curl', 'wget', 'scp', 'rsync', 'openssl', 'gpg', 'zip', 'tar', '7z', 'gzip', 'bzip2', 'xz',
  'sha256sum', 'sha1sum', 'shasum', 'md5sum', 'md5', 'cksum', 'b2sum',
]);

/** The files a known reader names: its non-option arguments, `--opt=value` values and `@file` upload sources; for git, `rev:path` and paths after `--`. */
function collectReads(name: string, args: Word[], env: Env): void {
  const git = name === 'git';
  if (!git && !FILE_READERS.has(name)) return;
  let afterDashDash = false;
  for (const w of args) {
    let text = w.text;
    if (!afterDashDash && text === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && text.startsWith('-')) {
      const eq = text.indexOf('=');
      if (!text.startsWith('--') || eq === -1) continue;
      text = text.slice(eq + 1);
    }
    if (git) {
      const rev = /^[^-/][^:\s]*:(?!\/\/)(.+)$/.exec(text);
      if (rev) text = rev[1]!;
      else if (!afterDashDash) continue;
    }
    if (text.startsWith('@')) text = text.slice(1);
    if (text === '' || text.includes('://') || /^\d+$/.test(text)) continue;
    addRead(env.state, { ...w, text }, env.base, name);
  }
}

function addWrite(state: State, word: Word, base: string | null, kind: BashWrite['kind'], via: string, recursive: boolean, unpack = false): void {
  const abs = targetPath(word, base, state);
  const write: BashWrite = {
    path: word.text,
    abs: abs !== null && abs.startsWith(CWD_MARK) ? null : abs,
    kind,
    recursive,
    glob: word.glob,
    via,
  };
  if (unpack) write.unpack = true;
  if (abs === null && base === null && !word.dynamic && !isAbsoluteText(word)) write.unknownDir = true;
  state.writes.push(write);
}

function isAbsoluteText(word: Word): boolean {
  return word.text.startsWith('/') || (!word.quoted && word.text.startsWith('~'));
}

/**
 * Variables whose value the classifier knows as well as the shell does. A
 * target such as `$HOME/.zshrc` is otherwise "computed at run time" and would
 * escape every check, although it plainly names a file outside the worktree.
 */
function knownVariable(name: string, base: string | null, state: State): string | null {
  switch (name) {
    case 'HOME':
      return state.home;
    case 'PWD':
      return base === CWD_MARK ? null : base;
    case 'TMPDIR':
      return tmpdir();
    default:
      return null;
  }
}

/** Absolute path a word names, joined but not normalized, or null when it depends on run time. */
function targetPath(word: Word, base: string | null, state: State): string | null {
  const t = word.text;
  if (word.dynamic) {
    const m = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})(?=\/|$)/.exec(t);
    const rest = m ? t.slice(m[0].length) : '';
    if (!m || /[$`]/.test(rest)) return null;
    const value = knownVariable(m[1] ?? m[2]!, base, state);
    return value === null ? null : value + rest;
  }
  if (!word.quoted && (t === '~' || t.startsWith('~/'))) return state.home + t.slice(1);
  if (!word.quoted && t.startsWith('~')) return null;
  if (t.startsWith('/')) return t;
  if (base === null) return null;
  return `${base}/${t}`;
}

/** Lexical "is this outside the root" for deletes; symlinks are judged later by authorization. */
function outsideRoot(word: Word, base: string | null, state: State): boolean | null {
  const p = targetPath(word, base, state);
  if (p === null) return null;
  const norm = posix.resolve(p);
  const root = posix.resolve(state.root);
  return !(norm === root || norm.startsWith(`${root}/`));
}

// ---------------------------------------------------------------------------
// Handlers

type Handler = (info: Info, args: Word[], env: Env, name: string) => void | { cd: string | null };

const HANDLERS: Record<string, Handler> = {
  cd: cdHandler,
  pushd: cdHandler,
  // The directory stack is not modelled, so after popd the working directory is unknown.
  popd: (info) => {
    info.raise('read-only');
    return { cd: null };
  },
  shopt: shoptHandler,
  link: (info, args, env) => {
    info.raise('build-test');
    const pos = positional(args, new Set());
    if (pos[0]) addWrite(env.state, pos[0], env.base, 'link', 'link', false);
    if (pos[1]) addWrite(env.state, pos[1], env.base, 'write', 'link', false);
  },
  tar: tarHandler,
  bsdtar: tarHandler,
  gtar: tarHandler,
  unzip: (info, args, env) => {
    info.raise('build-test');
    const d = valueOf(args, '-d');
    addWrite(env.state, d ?? literal('.'), env.base, 'write', 'unzip', true, true);
  },
  git: gitHandler,
  npm: npmHandler,
  yarn: yarnHandler,
  pnpm: pnpmHandler,
  bun: bunHandler,
  npx: npxHandler,
  bunx: npxHandler,
  pip: pipHandler,
  pip3: pipHandler,
  uv: uvHandler,
  uvx: (info) => void info.raise('package-install', 'uvx downloads and runs a tool').setInstall('add'),
  pipx: (info, args) => void (args[0]?.text === 'run' ? info.raise('package-install', 'pipx run downloads a tool').setInstall('add') : info.raise('package-install', 'pipx installs tools').setInstall('add')),
  poetry: poetryHandler,
  pipenv: pipenvHandler,
  conda: condaHandler,
  mamba: condaHandler,
  micromamba: condaHandler,
  python: pythonHandler,
  python3: pythonHandler,
  python2: pythonHandler,
  pypy: pythonHandler,
  pypy3: pythonHandler,
  go: goHandler,
  cargo: cargoHandler,
  gem: gemHandler,
  bundle: bundleHandler,
  bundler: bundleHandler,
  composer: composerHandler,
  brew: (info, args) => void (['install', 'reinstall', 'upgrade', 'tap', 'link', 'uninstall', 'remove', 'update'].includes(args[0]?.text ?? '') ? info.raise('package-install', `brew ${args[0]!.text} changes system packages`).setInstall('add') : info.raise('read-only')),
  apt: systemPkg,
  'apt-get': systemPkg,
  yum: systemPkg,
  dnf: systemPkg,
  apk: systemPkg,
  pacman: systemPkg,
  zypper: systemPkg,
  port: systemPkg,
  'nix-env': systemPkg,
  dotnet: dotnetHandler,
  swift: swiftHandler,
  deno: denoHandler,
  mix: mixHandler,
  pod: (info, args) => void (args[0]?.text === 'install' ? info.raise('package-install', 'pod install uses Podfile.lock').setInstall('locked') : args[0]?.text === 'update' ? info.raise('package-install', 'pod update changes dependencies').setInstall('add') : info.raise('build-test')),
  playwright: (info, args) => void (args[0]?.text === 'install' || args[0]?.text === 'install-deps' ? info.raise('package-install', 'playwright install downloads browsers').setInstall('add') : info.raise('build-test')),
  curl: curlHandler,
  wget: wgetHandler,
  http: httpieHandler,
  https: httpieHandler,
  xh: httpieHandler,
  aria2c: (info, args) => void urlArgs(info.raise('network', 'aria2c downloads files'), args),
  ssh: sshHandler,
  scp: scpHandler,
  sftp: scpHandler,
  rsync: rsyncHandler,
  nc: hostPortHandler,
  ncat: hostPortHandler,
  netcat: hostPortHandler,
  telnet: hostPortHandler,
  ftp: hostPortHandler,
  socat: socatHandler,
  nslookup: hostPortHandler,
  host: hostPortHandler,
  whois: hostPortHandler,
  ping: hostPortHandler,
  traceroute: hostPortHandler,
  dig: digHandler,
  openssl: (info, args) => {
    if (args[0]?.text === 's_client') {
      info.raise('network', 'openssl s_client opens a TLS connection');
      const c = valueOf(args, '-connect');
      info.host(c && !c.dynamic ? c.text : null);
    } else info.raise('build-test');
  },
  rm: rmHandler,
  unlink: rmHandler,
  shred: rmHandler,
  rmdir: (info, args, env) => {
    info.raise('build-test');
    for (const w of positional(args, new Set())) deleteTarget(info, w, env, 'rmdir', false);
  },
  cp: copyHandler,
  mv: copyHandler,
  install: copyHandler,
  ln: copyHandler,
  touch: (info, args, env) => {
    info.raise('build-test');
    for (const w of positional(args, new Set(['-r', '-t', '-d', '-A']))) addWrite(env.state, w, env.base, 'write', 'touch', false);
  },
  mkdir: (info, args, env) => {
    info.raise('build-test');
    for (const w of positional(args, new Set(['-m']))) addWrite(env.state, w, env.base, 'write', 'mkdir', false);
  },
  truncate: (info, args, env) => {
    info.raise('build-test');
    for (const w of positional(args, new Set(['-s', '-r', '--size', '--reference']))) addWrite(env.state, w, env.base, 'write', 'truncate', false);
  },
  chmod: chmodHandler,
  tee: (info, args, env) => {
    info.raise('read-only');
    for (const w of positional(args, new Set())) if (!DEV_SINKS.test(w.text)) addWrite(env.state, w, env.base, 'write', 'tee', false);
  },
  sed: inPlaceHandler,
  perl: inPlaceHandler,
  dd: ddHandler,
  find: findHandler,
  kill: killHandler,
  pkill: (info) => void info.raise('destructive', 'pkill signals processes by pattern and could stop the controller'),
  killall: (info) => void info.raise('destructive', 'killall signals processes by name and could stop the controller'),
  sh: shellHandler,
  bash: shellHandler,
  zsh: shellHandler,
  dash: shellHandler,
  ksh: shellHandler,
  fish: shellHandler,
  mksh: shellHandler,
  eval: evalHandler,
  source: sourceHandler,
  '.': sourceHandler,
  trap: (info, args, env) => {
    info.raise('read-only');
    const body = args[0];
    if (body && body.text !== '-' && body.text !== '') {
      if (body.dynamic) markOpaque(env.state, 'trap runs a computed command');
      else nestedShell(body, env, 'trap');
    }
  },
  alias: (info, args, env) => {
    info.raise('read-only');
    if (args.some((a) => a.text.includes('='))) markOpaque(env.state, 'alias definitions can change what later commands run');
  },
  export: declareHandler,
  declare: declareHandler,
  typeset: declareHandler,
  readonly: declareHandler,
  enable: (info, _args, env) => {
    info.raise('unknown', 'enable can load builtins');
    markOpaque(env.state, 'enable can replace builtins');
  },
  date: (info, args) => void (args.some((a) => a.text === '-s' || a.text.startsWith('--set')) ? info.raise('privilege', 'date -s changes the system clock') : info.raise('read-only')),
  hostname: (info, args) => void (positional(args, new Set()).length > 0 ? info.raise('privilege', 'hostname with an argument renames the host') : info.raise('read-only')),
  sysctl: (info, args) => void (args.some((a) => a.text === '-w' || /^[a-z0-9_.]+=/.test(a.text)) ? info.raise('privilege', 'sysctl writes kernel settings') : info.raise('read-only')),
  defaults: (info, args) => void (['write', 'delete', 'import', 'rename'].includes(args[0]?.text ?? '') ? info.raise('privilege', 'defaults writes system preferences') : info.raise('read-only')),
  sort: (info, args, env) => {
    info.raise('read-only');
    const o = valueOf(args, '-o') ?? valueOfLong(args, '--output');
    if (o) addWrite(env.state, o, env.base, 'write', 'sort -o', false);
  },
  uniq: (info, args, env) => {
    info.raise('read-only');
    const pos = positional(args, new Set(['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars']));
    if (pos[1]) addWrite(env.state, pos[1], env.base, 'write', 'uniq', false);
  },
  xxd: (info, args, env) => {
    info.raise('read-only');
    const pos = positional(args, new Set(['-c', '-g', '-l', '-s', '-o', '-n', '-cols', '-len', '-seek']));
    if (pos[1]) addWrite(env.state, pos[1], env.base, 'write', 'xxd', false);
  },
  base64: (info, args, env) => {
    info.raise('read-only');
    const o = valueOf(args, '-o') ?? valueOfLong(args, '--output');
    if (o) addWrite(env.state, o, env.base, 'write', 'base64 -o', false);
  },
  awk: awkHandler,
  gawk: awkHandler,
  yq: (info, args, env) => {
    info.raise('read-only');
    if (args.some((a) => a.text === '-i' || a.text === '--inplace')) {
      const pos = positional(args, new Set(['-o', '-p', '--output-format', '--input-format']));
      for (const w of pos.slice(1)) addWrite(env.state, w, env.base, 'write', 'yq -i', false);
    }
  },
  hash: (info, args, env) => {
    info.raise('read-only');
    if (args.some((a) => a.text === '-p')) markOpaque(env.state, 'hash -p remaps a command name to another program');
  },
};

function handlerFor(name: string): Handler | undefined {
  return Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
}


function cdHandler(info: Info, args: Word[], env: Env, name: string): { cd: string | null } {
  info.raise('read-only');
  const target = args.find((a) => a.text !== '--' && !(a.text.startsWith('-') && a.text.length > 1 && a.text !== '-'));
  // `pushd` alone swaps the top of the directory stack and `pushd +N` rotates it; neither is modelled.
  if (name === 'pushd' && (!target || /^[+-]\d+$/.test(target.text))) return { cd: null };
  if (!target) return { cd: env.state.home };
  if (target.text === '-') return { cd: null };
  const p = targetPath(target, env.base, env.state);
  return { cd: p === null ? null : posix.resolve(p) };
}

// --- git -------------------------------------------------------------------

const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'annotate', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file',
  'grep', 'describe', 'shortlog', 'whatchanged', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref', 'check-ignore',
  'check-attr', 'check-ref-format', 'count-objects', 'var', 'help', 'version', 'cherry', 'range-diff', 'verify-commit',
  'verify-tag', 'fsck', 'diff-tree', 'diff-files', 'diff-index', 'show-branch', 'request-pull', 'get-tar-commit-id',
  'difftool', 'instaweb',
]);
const GIT_HISTORY_WRITE = new Set([
  'commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'bisect', 'commit-tree', 'update-ref', 'replace',
  'filter-branch', 'filter-repo', 'gc', 'prune', 'repack', 'maintenance', 'init', 'switch', 'clean', 'sparse-checkout',
  'fast-import', 'read-tree', 'mktag', 'mktree', 'pack-refs', 'merge-tree', 'restore-mtime', 'subtree', 'mergetool',
]);
const GIT_DANGEROUS_CONFIG = /^(alias\.|core\.(sshcommand|fsmonitor|hookspath|pager|editor|askpass|gitproxy|attributesfile|excludesfile|worktree)|diff\.external|diff\..*\.(command|textconv)|filter\.|merge\..*\.driver|credential|protocol\.|uploadpack\.|url\..*\.insteadof|include|https?\.|sequence\.editor|gpg\.|ssh\.variant|pager\.|interactive\.difffilter|trailer\.|difftool\.|mergetool\.|browser\.|man\.|web\.browser|remote\..*\.(uploadpack|receivepack|proxy)|submodule\.|sendemail\.)/i;

function gitHandler(info: Info, args: Word[], outer: Env): void {
  let env = outer;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    const t = a.text;
    if (t === '-C') {
      // git runs in that directory, so the paths it writes are relative to it.
      const dir = args[i + 1];
      const p = dir ? targetPath(dir, env.base, env.state) : null;
      env = { ...env, base: p === null ? null : posix.resolve(p) };
      i++;
      continue;
    }
    if (t === '-c' || t === '--config-env') {
      const kv = args[i + 1];
      if (!kv || kv.dynamic || GIT_DANGEROUS_CONFIG.test(kv.text)) markOpaque(env.state, `git ${t} ${kv?.text ?? ''} can make git run other programs`);
      i++;
      continue;
    }
    if (t.startsWith('--config-env=') && GIT_DANGEROUS_CONFIG.test(t.slice(13))) markOpaque(env.state, 'git --config-env can make git run other programs');
    if (t.startsWith('--exec-path=') || t.startsWith('--git-dir') || t.startsWith('--work-tree') || t === '--namespace') {
      if (t === '--namespace' || t === '--git-dir' || t === '--work-tree') i++;
      if (t.startsWith('--exec-path=')) markOpaque(env.state, 'git --exec-path replaces the git programs');
      // Another repository or work tree: every path git touches is somewhere the classifier is not looking.
      else if (t !== '--namespace') markOpaque(env.state, 'git --git-dir/--work-tree operates on another repository or work tree');
      continue;
    }
    if (t.startsWith('-')) continue;
    break;
  }
  const sub = args[i]?.text;
  const rest = args.slice(i + 1);
  const restText = rest.map((w) => w.text);
  if (sub === undefined) {
    info.raise('vcs-read');
    return;
  }
  if (args[i]!.dynamic) {
    markOpaque(env.state, 'git subcommand is computed at run time');
    info.raise('unknown');
    return;
  }
  const has = (...flags: string[]) => restText.some((t) => flags.includes(t) || flags.some((f) => f.startsWith('--') && t.startsWith(`${f}=`)));
  const nonFlag = rest.filter((w) => !w.text.startsWith('-'));

  if (sub === 'push' || sub === 'send-email') {
    info.raise('publish', `git ${sub} sends work to a remote; delivery is the controller's job`);
    return;
  }
  if (sub === 'credential' || sub.startsWith('credential-')) {
    info.raise('privilege', 'git credential reads stored credentials');
    return;
  }
  if ((sub === 'difftool' && has('-x', '--extcmd', '-t', '--tool', '-g', '--gui')) || (sub === 'grep' && restText.some((t) => t.startsWith('-O') || t.startsWith('--open-files-in-pager')))) {
    markOpaque(env.state, `git ${sub} runs a program named on its command line`);
    info.raise('unknown');
    return;
  }
  if (GIT_READ.has(sub)) {
    info.raise('vcs-read');
    const out = rest.find((w) => w.text.startsWith('--output='));
    if (out) addWrite(env.state, literal(out.text.slice('--output='.length)), env.base, 'write', `git ${sub} --output`, false);
    return;
  }
  if (GIT_HISTORY_WRITE.has(sub)) {
    info.raise('vcs-write', `git ${sub} changes history, branches or the work tree outside the task's edits`);
    return;
  }
  switch (sub) {
    case 'branch': {
      const listing = rest.every((w) => /^(-a|-r|-l|--list|-v|-vv|--all|--remotes|--show-current|--no-column|--column.*|--sort=.*|--format=.*|--contains|--no-contains|--merged|--no-merged|--points-at|--color.*|--no-color|-i|--ignore-case)$/.test(w.text) || isListingValue(rest, w));
      info.raise(listing ? 'vcs-read' : 'vcs-write', listing ? undefined : 'git branch creates, deletes or renames branches');
      return;
    }
    case 'tag': {
      const listing = rest.length === 0 || rest.some((w) => ['-l', '--list', '-v', '--verify'].includes(w.text)) || rest.every((w) => /^(-n\d*|--contains|--points-at|--sort=.*|--format=.*|--merged|--no-merged)$/.test(w.text) || isListingValue(rest, w));
      info.raise(listing ? 'vcs-read' : 'vcs-write', listing ? undefined : 'git tag creates or deletes tags');
      return;
    }
    case 'remote': {
      const action = nonFlag[0]?.text;
      if (action === undefined || action === 'show' || action === 'get-url') info.raise('vcs-read');
      else info.raise('vcs-write', `git remote ${action} changes remotes`);
      return;
    }
    case 'config': {
      const reading = has('--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch', '--get-color', '--get-colorbool') || ['get', 'list'].includes(nonFlag[0]?.text ?? '') || (nonFlag.length === 1 && !has('--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit'));
      info.raise(reading ? 'vcs-read' : 'vcs-write', reading ? undefined : 'git config changes repository or user configuration');
      return;
    }
    case 'stash': {
      const action = nonFlag[0]?.text ?? 'push';
      info.raise(action === 'list' || action === 'show' ? 'vcs-read' : 'vcs-write', action === 'list' || action === 'show' ? undefined : `git stash ${action} moves work out of the tree`);
      return;
    }
    case 'worktree':
      writeIf(info, nonFlag[0]?.text !== 'list', 'git worktree changes worktrees');
      return;
    case 'reflog':
      writeIf(info, ['expire', 'delete'].includes(nonFlag[0]?.text ?? ''), 'git reflog expire/delete drops history');
      return;
    case 'notes':
      writeIf(info, !['list', 'show'].includes(nonFlag[0]?.text ?? 'list'), 'git notes changes notes refs');
      return;
    case 'symbolic-ref':
      writeIf(info, nonFlag.length >= 2 || has('-d', '--delete'), 'git symbolic-ref moves a ref');
      return;
    case 'hash-object':
      writeIf(info, has('-w'), 'git hash-object -w writes objects');
      return;
    case 'add':
    case 'stage':
    case 'update-index':
      // The controller snapshots the tree through a temporary index, so the worker's index is irrelevant.
      info.raise('build-test');
      return;
    case 'restore':
      info.raise('build-test');
      for (const w of positional(rest, new Set(['-s', '--source', '--pathspec-from-file']))) addWrite(env.state, w, env.base, 'write', 'git restore', false);
      return;
    case 'rm':
    case 'mv': {
      info.raise('build-test');
      for (const w of positional(rest, new Set(['--pathspec-from-file']))) deleteTarget(info, w, env, `git ${sub}`, has('-r'));
      return;
    }
    case 'apply': {
      const checkOnly = has('--check', '--stat', '--numstat', '--summary');
      if (has('--index', '--cached') && !checkOnly) info.raise('build-test');
      info.raise(checkOnly ? 'vcs-read' : 'build-test');
      return;
    }
    case 'checkout': {
      const dd = restText.indexOf('--');
      if (dd >= 0) {
        // `git checkout [<rev>] -- <paths>` only rewrites those files in the work tree.
        info.raise('build-test');
        for (const w of rest.slice(dd + 1)) addWrite(env.state, w, env.base, 'write', 'git checkout --', false);
        return;
      }
      if (has('-b', '-B', '--orphan', '--detach')) {
        info.raise('vcs-write', 'git checkout creates or switches branches');
        return;
      }
      if (nonFlag.length === 1 && nonFlag[0]!.text === '.') {
        info.raise('build-test');
        return;
      }
      info.raise('vcs-write', 'git checkout of another branch or commit; use "git restore <path>" or "git checkout -- <path>" for files');
      return;
    }
    case 'reset': {
      if (has('--hard', '--merge', '--keep', '--soft')) {
        info.raise('vcs-write', 'git reset --hard/--soft/--merge/--keep discards work or moves the branch');
        return;
      }
      const dd = restText.indexOf('--');
      const commitish = (dd >= 0 ? rest.slice(0, dd) : rest).filter((w) => !w.text.startsWith('-'));
      if (commitish.length === 0 || (dd >= 0 && commitish.length === 1 && commitish[0]!.text === 'HEAD')) {
        info.raise('build-test');
        return;
      }
      info.raise('vcs-write', 'git reset <commit> moves the branch');
      return;
    }
    case 'clone':
    case 'fetch':
    case 'pull':
    case 'ls-remote':
    case 'archive': {
      if (sub === 'archive' && !has('--remote')) {
        info.raise('build-test');
        const o = valueOf(rest, '-o') ?? valueOfLong(rest, '--output');
        if (o) addWrite(env.state, o, env.base, 'write', 'git archive', false);
        return;
      }
      if (sub === 'pull') info.raise('vcs-write', 'git pull merges remote history into the task branch');
      info.raise('network', `git ${sub} contacts a remote`);
      const urls = rest.filter((w) => !w.text.startsWith('-'));
      if (sub === 'clone' && urls.length >= 2) addWrite(env.state, urls[urls.length - 1]!, env.base, 'write', 'git clone', true, true);
      let sawUrl = false;
      for (const w of urls) {
        const h = remoteHost(w);
        if (h !== undefined) {
          sawUrl = true;
          info.host(h);
        }
      }
      if (!sawUrl) {
        info.hostsComplete = false;
        info.reasons.push(`git ${sub} names a remote, so its host is not statically known`);
      }
      return;
    }
    case 'submodule': {
      const action = nonFlag[0]?.text ?? 'status';
      if (action === 'status' || action === 'summary') info.raise('vcs-read');
      else if (action === 'foreach') {
        const body = nonFlag[1];
        if (!body || body.dynamic) markOpaque(env.state, 'git submodule foreach runs a computed command');
        else nestedShell(body, env, 'git submodule foreach');
        info.raise('vcs-read');
      } else {
        info.raise('network', `git submodule ${action} fetches other repositories`);
        info.hostsComplete = false;
      }
      return;
    }
    case 'lfs': {
      const action = nonFlag[0]?.text;
      if (action === 'push') info.raise('publish', 'git lfs push uploads to a remote');
      else if (action === 'pull' || action === 'fetch' || action === 'clone') {
        info.raise('network', `git lfs ${action} downloads from a remote`);
        info.hostsComplete = false;
      } else info.raise('unknown', `git lfs ${action ?? ''}`.trim());
      return;
    }
    case 'format-patch':
    case 'bundle':
      info.raise('build-test');
      return;
    default:
      info.raise('unknown', `unrecognized git subcommand "${sub}" (it may be an alias)`);
  }
}

function writeIf(info: Info, writes: boolean, reason: string): void {
  if (writes) info.raise('vcs-write', reason);
  else info.raise('vcs-read');
}

function isListingValue(rest: Word[], w: Word): boolean {
  const idx = rest.indexOf(w);
  const prev = rest[idx - 1]?.text;
  return prev === '--contains' || prev === '--no-contains' || prev === '--merged' || prev === '--no-merged' || prev === '--points-at';
}

/** Host of a git remote URL or scp-style address; null when malformed; undefined when it is not a URL at all (a remote name). */
function remoteHost(w: Word): string | null | undefined {
  if (w.dynamic) return null;
  const t = w.text;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    if (/^file:/i.test(t)) return undefined;
    return urlHost(t);
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/.exec(t);
  if (scp && !t.startsWith('/') && !t.startsWith('.')) return scp[1]!;
  return undefined;
}

function urlHost(u: string): string | null {
  try {
    const url = new URL(u);
    return url.hostname || null;
  } catch {
    return null;
  }
}

// --- JavaScript package managers -------------------------------------------

const NPM_INSTALL = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add']);
const NPM_CHANGE = new Set(['uninstall', 'un', 'unlink', 'remove', 'rm', 'r', 'update', 'up', 'upgrade', 'udpate', 'dedupe', 'ddp', 'prune', 'link', 'ln', 'rebuild', 'rb']);
const NPM_READ = new Set(['view', 'v', 'info', 'show', 'search', 's', 'se', 'find', 'outdated', 'ls', 'list', 'la', 'll', 'explain', 'why', 'help', 'doctor', 'root', 'bin', 'prefix', 'fund', 'query', 'sbom', 'ping', 'whoami', 'config-get', 'get']);
const NPM_RUN = new Set(['test', 't', 'tst', 'run', 'run-script', 'rum', 'urn', 'start', 'stop', 'restart', 'pack', 'cache', 'init', 'create-test']);
const NPM_PUBLISH = new Set(['publish', 'unpublish', 'deprecate', 'dist-tag', 'dist-tags', 'owner', 'author', 'access', 'team', 'hook', 'star', 'unstar', 'undeprecate', 'trust']);
const NPM_CREDENTIALS = new Set(['adduser', 'add-user', 'login', 'logout', 'token']);

function scriptsFlag(args: Word[], env: Env): boolean {
  if (args.some((a) => a.text === '--ignore-scripts' || a.text === '--ignore-scripts=true' || a.text === '--mode=skip-build')) return true;
  const mode = valueOfLong(args, '--mode');
  if (mode?.text === 'skip-build') return true;
  return env.cmd.assigns.some((a) => /^(npm_config_ignore_scripts|NPM_CONFIG_IGNORE_SCRIPTS)=(true|1)$/.test(a.text));
}

function npmHandler(info: Info, args: Word[], env: Env): void {
  const pos = positional(args, new Set(['--prefix', '-w', '--workspace', '--registry', '--cache', '--userconfig', '--globalconfig', '--loglevel', '-C']));
  const sub = pos[0]?.text;
  const rest = pos.slice(1);
  if (args.some((a) => a.text === '--registry' || a.text.startsWith('--registry=') || a.text === '--userconfig' || a.text.startsWith('--userconfig='))) {
    info.raise('package-install', 'npm with another registry or user config').setInstall('add');
  }
  if (sub === undefined) return void info.raise('read-only');
  if (sub === 'ci' || sub === 'clean-install' || sub === 'install-clean' || sub === 'isntall-clean' || sub === 'cit' || sub === 'install-ci-test' || sub === 'clean-install-test') {
    info.raise('package-install', `npm ${sub} installs exactly the lockfile`).setInstall('locked');
    info.ignoreScripts = scriptsFlag(args, env);
    return;
  }
  if (NPM_INSTALL.has(sub) || sub === 'install-test' || sub === 'it') {
    const global = args.some((a) => a.text === '-g' || a.text === '--global' || a.text === '--location=global');
    info.raise('package-install', rest.length > 0 ? `npm ${sub} adds packages` : `npm ${sub} without a package can rewrite the lockfile; use "npm ci"`).setInstall('add');
    if (global) info.raise('package-install', 'installs globally, outside the worktree');
    info.ignoreScripts = scriptsFlag(args, env);
    return;
  }
  if (NPM_CHANGE.has(sub)) return void info.raise('package-install', `npm ${sub} changes installed dependencies`).setInstall('add');
  if (sub === 'audit') return void (rest[0]?.text === 'fix' ? info.raise('package-install', 'npm audit fix changes dependencies').setInstall('add') : info.raise('read-only'));
  if (sub === 'pkg') {
    const action = rest[0]?.text;
    if (action === 'set' || action === 'delete') {
      const touchesDeps = rest.slice(1).some((w) => /^(dependencies|devDependencies|peerDependencies|optionalDependencies|overrides|bundleDependencies|bundledDependencies)\b/.test(w.text));
      if (touchesDeps) return void info.raise('package-install', 'npm pkg edits dependency sections').setInstall('add');
      info.raise('build-test');
      addWrite(env.state, literal('package.json'), env.base, 'write', 'npm pkg', false);
      return;
    }
    return void info.raise('read-only');
  }
  if (sub === 'version') return void (rest.length > 0 ? info.raise('vcs-write', 'npm version bumps, commits and tags') : info.raise('read-only'));
  if (sub === 'config' || sub === 'c' || sub === 'set') {
    const action = sub === 'set' ? 'set' : rest[0]?.text;
    return void (action === 'get' || action === 'list' || action === 'ls' ? info.raise('read-only') : info.raise('privilege', 'npm config changes registry and credential settings'));
  }
  if (sub === 'exec' || sub === 'x') {
    const rest = args.slice(args.findIndex((a) => a.text === sub) + 1);
    if (rest.some((a) => ['-y', '--yes', '-p', '--package'].includes(a.text) || a.text.startsWith('--package='))) info.raise('package-install', `npm ${sub} --yes/--package downloads a package`).setInstall('add');
    else downloadsUnlessLocal(info, rest, env, `npm ${sub}`);
    return execRunner(info, rest, env, `npm ${sub}`);
  }
  if (sub === 'create' || sub === 'innit') return void info.raise('package-install', 'npm create downloads a starter package').setInstall('add');
  if (NPM_PUBLISH.has(sub)) return void info.raise('publish', `npm ${sub} changes the public registry`);
  if (NPM_CREDENTIALS.has(sub)) return void info.raise('privilege', `npm ${sub} handles registry credentials`);
  if (NPM_READ.has(sub)) return void info.raise('read-only');
  if (NPM_RUN.has(sub)) return void info.raise('build-test');
  info.raise('unknown', `unrecognized npm command "${sub}"`);
}

function yarnHandler(info: Info, args: Word[], env: Env): void {
  const pos = positional(args, new Set(['--cwd', '--modules-folder', '--cache-folder', '--registry']));
  const sub = pos[0]?.text;
  const frozen = args.some((a) => ['--frozen-lockfile', '--immutable', '--immutable-cache', '--pure-lockfile'].includes(a.text));
  if (sub === undefined || sub === 'install') {
    info.raise('package-install', frozen ? 'yarn install with a frozen lockfile' : 'yarn install without --frozen-lockfile/--immutable can rewrite the lockfile').setInstall(frozen ? 'locked' : 'add');
    info.ignoreScripts = scriptsFlag(args, env);
    return;
  }
  if (['add', 'remove', 'upgrade', 'up', 'upgrade-interactive', 'dedupe', 'link', 'unlink', 'global', 'set', 'patch-commit', 'rebuild'].includes(sub)) {
    if (sub === 'set') return void info.raise('privilege', 'yarn set changes the yarn version or configuration');
    return void info.raise('package-install', `yarn ${sub} changes dependencies`).setInstall('add');
  }
  if (sub === 'dlx' || sub === 'create') return void info.raise('package-install', `yarn ${sub} downloads and runs a package`).setInstall('add');
  if (sub === 'publish' || (sub === 'npm' && pos[1]?.text === 'publish') || sub === 'owner' || sub === 'tag') return void info.raise('publish', `yarn ${sub} changes the public registry`);
  if (sub === 'npm' || sub === 'login' || sub === 'logout') return void info.raise('privilege', 'yarn npm/login handles registry credentials');
  if (sub === 'config') return void (['get', 'list', undefined].includes(pos[1]?.text) ? info.raise('read-only') : info.raise('privilege', 'yarn config changes registry and credential settings'));
  if (sub === 'version') return void info.raise('vcs-write', 'yarn version bumps, commits and tags');
  if (['info', 'why', 'list', 'outdated', 'licenses', 'audit', 'cache', 'bin', 'help', 'workspaces'].includes(sub)) return void info.raise('read-only');
  if (sub === 'exec' || sub === 'run' || sub === 'node') return execRunner(info, pos.slice(1), env, `yarn ${sub}`, sub === 'run');
  info.raise('build-test');
}

function pnpmHandler(info: Info, args: Word[], env: Env): void {
  const pos = positional(args, new Set(['-C', '--dir', '--filter', '-F', '--registry', '--store-dir']));
  const sub = pos[0]?.text;
  const frozen = args.some((a) => a.text === '--frozen-lockfile');
  if (sub === undefined || sub === 'install' || sub === 'i') {
    info.raise('package-install', frozen ? 'pnpm install with a frozen lockfile' : 'pnpm install without --frozen-lockfile can rewrite the lockfile').setInstall(frozen ? 'locked' : 'add');
    info.ignoreScripts = scriptsFlag(args, env);
    return;
  }
  if (['add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'link', 'ln', 'unlink', 'prune', 'dedupe', 'patch-commit', 'rebuild', 'rb', 'fetch', 'import'].includes(sub)) {
    if (sub === 'fetch') return void info.raise('package-install', 'pnpm fetch downloads the lockfile packages').setInstall('locked');
    return void info.raise('package-install', `pnpm ${sub} changes dependencies`).setInstall('add');
  }
  if (sub === 'dlx' || sub === 'create') return void info.raise('package-install', `pnpm ${sub} downloads and runs a package`).setInstall('add');
  if (sub === 'publish') return void info.raise('publish', 'pnpm publish changes the public registry');
  if (sub === 'config') return void (['get', 'list'].includes(pos[1]?.text ?? '') ? info.raise('read-only') : info.raise('privilege', 'pnpm config changes registry and credential settings'));
  if (['list', 'ls', 'why', 'outdated', 'audit', 'licenses', 'root', 'bin', 'store', 'help'].includes(sub)) return void info.raise('read-only');
  if (sub === 'exec' || sub === 'run' || sub === 'x') return execRunner(info, pos.slice(1), env, `pnpm ${sub}`, sub === 'run');
  info.raise('build-test');
}

function bunHandler(info: Info, args: Word[], env: Env): void {
  const pos = positional(args, new Set(['--cwd', '--registry']));
  const sub = pos[0]?.text;
  if (sub === 'install' || sub === 'i') {
    const frozen = args.some((a) => a.text === '--frozen-lockfile');
    info.raise('package-install', frozen ? 'bun install with a frozen lockfile' : 'bun install without --frozen-lockfile can rewrite the lockfile').setInstall(frozen ? 'locked' : 'add');
    info.ignoreScripts = scriptsFlag(args, env);
    return;
  }
  if (['add', 'a', 'remove', 'rm', 'update', 'link', 'unlink', 'patch-commit'].includes(sub ?? '')) return void info.raise('package-install', `bun ${sub} changes dependencies`).setInstall('add');
  if (sub === 'create' || sub === 'c') return void info.raise('package-install', 'bun create downloads a template').setInstall('add');
  if (sub === 'publish') return void info.raise('publish', 'bun publish changes the public registry');
  if (sub === 'pm') return void info.raise('read-only');
  if (sub === 'x') {
    downloadsUnlessLocal(info, pos.slice(1), env, 'bun x');
    return execRunner(info, pos.slice(1), env, 'bun x');
  }
  if (pos[0] && /^https?:\/\//.test(pos[0].text)) return void info.raise('privilege', 'bun runs code fetched from a URL').host(urlHost(pos[0].text));
  info.raise('build-test');
}

function npxHandler(info: Info, args: Word[], env: Env, name: string): void {
  const c = valueOf(args, '-c') ?? valueOfLong(args, '--call');
  if (c) {
    info.raise('build-test');
    return void nestedShell(c, env, `${name} -c`);
  }
  if (args.some((a) => ['-y', '--yes', '-p', '--package'].includes(a.text) || a.text.startsWith('--package='))) {
    return void info.raise('package-install', `${name} --yes/--package downloads a package`).setInstall('add');
  }
  downloadsUnlessLocal(info, args, env, name);
  execRunner(info, args, env, name);
}

/**
 * npx and bunx fetch and run a package when it is not installed, without
 * asking when stdin is not a terminal, which is every worker session. A tool
 * missing from node_modules/.bin between the working directory and the root
 * is therefore a package install.
 */
function downloadsUnlessLocal(info: Info, args: Word[], env: Env, label: string): void {
  const tool = skipOptions(args, new Set(['-p', '--package', '-w', '--workspace', '-c', '--call', '--prefix']))[0];
  if (!tool || tool.dynamic) return;
  // URLs, git specs and versioned specs (`pkg@1`) are judged by execRunner; paths are local programs.
  if (/^(https?:|git\+|github:|gitlab:|bitbucket:|file:)/.test(tool.text) || tool.text.lastIndexOf('@') > 0) return;
  const scoped = /^@[^/]+\/[^/]+$/.test(tool.text);
  if (!scoped && programName(tool.text) !== tool.text) return;
  // A scoped package names a directory under node_modules; a plain name is a bin.
  const local = scoped ? ['node_modules', tool.text] : ['node_modules', '.bin', tool.text];
  if (env.base !== null && env.base !== CWD_MARK) {
    const root = posix.resolve(env.state.root);
    let dir = posix.resolve(env.base);
    while (true) {
      if (existsSync(posix.join(dir, ...local))) return;
      if (dir === root || dir === '/' || !dir.startsWith(`${root}/`)) break;
      dir = posix.dirname(dir);
    }
  }
  info.raise('package-install', `${label} ${tool.text} is not installed in node_modules, so it downloads and runs the package`).setInstall('add');
}

/** `npx tool args`, `pnpm exec tool`, `yarn run tool`: the tool runs with the remaining arguments. */
function execRunner(info: Info, args: Word[], env: Env, label: string, scriptOrBin = false): void {
  const rest = skipOptions(args, new Set(['-p', '--package', '-w', '--workspace', '-c', '--call', '--filter', '-F', '--prefix']));
  const tool = rest[0];
  info.raise('build-test');
  if (!tool) return;
  if (tool.dynamic) return void markOpaque(env.state, `${label} runs a computed program`);
  if (/^(https?:|git\+|github:|gitlab:|bitbucket:|file:)/.test(tool.text) || (tool.text.includes('@') && /@\d|@latest|@next|@\^|@~/.test(tool.text))) {
    info.raise('package-install', `${label} ${tool.text} downloads a package`).setInstall('add');
    return;
  }
  // A package.json script name is not a program; anything else is classified as the program it names.
  if (scriptOrBin && !handlerFor(programName(tool.text)) && !BUILD_TEST.has(tool.text) && !READ_ONLY.has(tool.text)) return;
  classifyArgv(rest, env);
}

// --- other ecosystems ------------------------------------------------------

function pipHandler(info: Info, args: Word[], env: Env, name: string): void {
  const pos = positional(args, new Set(['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '-t', '--target', '--prefix', '--root', '-f', '--find-links', '--python']));
  const sub = pos[0]?.text;
  if (sub === 'install' || sub === 'download' || sub === 'wheel') {
    const reqOnly = pos.length === 1 && args.some((a) => a.text === '-r' || a.text === '--requirement' || a.text.startsWith('--requirement='));
    const hashed = args.some((a) => a.text === '--require-hashes');
    if (reqOnly && hashed) return void info.raise('package-install', `${name} install from a hash-pinned requirements file`).setInstall('locked');
    return void info.raise('package-install', `${name} ${sub} resolves and installs packages`).setInstall('add');
  }
  if (sub === 'uninstall') return void info.raise('package-install', `${name} uninstall changes installed packages`).setInstall('add');
  if (sub === 'config') return void info.raise('privilege', `${name} config changes index and credential settings`);
  void env;
  info.raise('read-only');
}

function uvHandler(info: Info, args: Word[], env: Env): void {
  const pos = positional(args, new Set(['--directory', '--project', '-p', '--python', '--index-url', '--extra-index-url', '--with']));
  const sub = pos[0]?.text;
  const locked = args.some((a) => a.text === '--locked' || a.text === '--frozen');
  if (sub === 'sync') return void info.raise('package-install', locked ? 'uv sync from the existing lockfile' : 'uv sync without --locked/--frozen can rewrite uv.lock').setInstall(locked ? 'locked' : 'add');
  if (sub === 'add' || sub === 'remove' || sub === 'lock') return void info.raise('package-install', `uv ${sub} changes dependencies`).setInstall('add');
  if (sub === 'pip') return pipHandler(info, args.slice(args.findIndex((a) => a.text === 'pip') + 1), env, 'uv pip');
  if (sub === 'tool') return void info.raise('package-install', 'uv tool installs or runs downloaded tools').setInstall('add');
  if (sub === 'publish') return void info.raise('publish', 'uv publish uploads to a package index');
  if (sub === 'run') {
    info.raise('build-test');
    const rest = skipOptions(args.slice(args.findIndex((a) => a.text === 'run') + 1), new Set(['--with', '-p', '--python', '--directory', '--project', '--group', '--extra', '--env-file']));
    if (args.some((a) => a.text === '--with' || a.text.startsWith('--with='))) info.raise('package-install', 'uv run --with installs extra packages').setInstall('add');
    if (rest.length > 0) classifyArgv(rest, env);
    return;
  }
  if (sub === 'venv' || sub === 'python' || sub === 'tree' || sub === 'version' || sub === 'help' || sub === 'cache') return void info.raise('build-test');
  info.raise('unknown', `unrecognized uv command "${sub ?? ''}"`);
}

function poetryHandler(info: Info, args: Word[], env: Env): void {
  const pos = positional(args, new Set(['-C', '--directory', '-P', '--project']));
  const sub = pos[0]?.text;
  if (sub === 'install' || sub === 'sync') return void info.raise('package-install', `poetry ${sub} installs from poetry.lock`).setInstall('locked');
  if (['add', 'remove', 'update', 'lock'].includes(sub ?? '')) return void info.raise('package-install', `poetry ${sub} changes dependencies`).setInstall('add');
  if (sub === 'publish') return void info.raise('publish', 'poetry publish uploads to a package index');
  if (sub === 'config' || sub === 'source') return void info.raise('privilege', `poetry ${sub} changes index and credential settings`);
  if (sub === 'run') {
    info.raise('build-test');
    const rest = pos.slice(1);
    if (rest.length > 0) classifyArgv(rest, env);
    return;
  }
  info.raise('build-test');
}

function pipenvHandler(info: Info, args: Word[], env: Env): void {
  const pos = positional(args, new Set(['--python']));
  const sub = pos[0]?.text;
  if (sub === 'sync') return void info.raise('package-install', 'pipenv sync installs from Pipfile.lock').setInstall('locked');
  if (sub === 'install') {
    const locked = pos.length === 1 && args.some((a) => a.text === '--deploy' || a.text === '--ignore-pipfile');
    return void info.raise('package-install', locked ? 'pipenv install --deploy installs from Pipfile.lock' : 'pipenv install can change Pipfile.lock').setInstall(locked ? 'locked' : 'add');
  }
  if (['uninstall', 'update', 'lock', 'upgrade'].includes(sub ?? '')) return void info.raise('package-install', `pipenv ${sub} changes dependencies`).setInstall('add');
  if (sub === 'run') {
    info.raise('build-test');
    if (pos.length > 1) classifyArgv(pos.slice(1), env);
    return;
  }
  info.raise('build-test');
}

function condaHandler(info: Info, args: Word[], _env: Env, name: string): void {
  const sub = positional(args, new Set(['-n', '--name', '-p', '--prefix', '-c', '--channel']))[0]?.text;
  if (['install', 'update', 'upgrade', 'remove', 'uninstall', 'create'].includes(sub ?? '')) return void info.raise('package-install', `${name} ${sub} changes packages`).setInstall('add');
  if (sub === 'env' || sub === 'config') return void info.raise('package-install', `${name} ${sub} changes environments or channels`).setInstall('add');
  if (sub === 'run') return void info.raise('build-test');
  info.raise('read-only');
}

function pythonHandler(info: Info, args: Word[], env: Env, name: string): void {
  const m = args.findIndex((a) => a.text === '-m');
  if (m >= 0) {
    const mod = args[m + 1]?.text;
    const rest = args.slice(m + 2);
    if (mod === 'pip') return pipHandler(info, rest, env, `${name} -m pip`);
    if (mod === 'venv' || mod === 'pytest' || mod === 'unittest' || mod === 'mypy' || mod === 'black' || mod === 'ruff' || mod === 'coverage' || mod === 'compileall' || mod === 'py_compile' || mod === 'doctest') return void info.raise('build-test');
    if (mod === 'http.server') return void info.raise('build-test', 'starts a local web server');
    if (mod === 'twine') return void info.raise('publish', 'twine uploads to a package index');
    return void info.raise('build-test');
  }
  interpreterStdin(info, args, env, name);
}

function goHandler(info: Info, args: Word[]): void {
  const sub = args[0]?.text;
  const rest = args.slice(1).map((w) => w.text);
  if (sub === 'get') return void info.raise('package-install', 'go get changes go.mod and go.sum').setInstall('add');
  if (sub === 'install') return void info.raise('package-install', 'go install downloads and installs a program').setInstall('add');
  if (sub === 'mod') {
    const action = rest[0];
    if (action === 'download') return void info.raise('package-install', 'go mod download fetches the modules go.sum already pins').setInstall('locked');
    if (action === 'verify' || action === 'graph' || action === 'why') return void info.raise('read-only');
    if (action === 'vendor') return void info.raise('build-test');
    return void info.raise('package-install', `go mod ${action ?? ''} changes go.mod or go.sum`.trim()).setInstall('add');
  }
  if (sub === 'work' && rest[0] !== 'sync') return void info.raise('build-test');
  if (sub === 'env' && (rest.includes('-w') || rest.includes('-u'))) return void info.raise('privilege', 'go env -w changes the Go configuration');
  if (['env', 'version', 'list', 'doc', 'help'].includes(sub ?? '')) return void info.raise('read-only');
  info.raise('build-test');
}

function cargoHandler(info: Info, args: Word[]): void {
  const sub = positional(args, new Set(['--manifest-path', '-p', '--package', '-Z', '--config']))[0]?.text;
  if (['add', 'remove', 'rm', 'update', 'upgrade', 'generate-lockfile'].includes(sub ?? '')) return void info.raise('package-install', `cargo ${sub} changes Cargo.toml or Cargo.lock`).setInstall('add');
  if (sub === 'install') return void info.raise('package-install', 'cargo install downloads and installs a program').setInstall('add');
  if (sub === 'fetch') return void info.raise('package-install', 'cargo fetch downloads the locked dependencies').setInstall('locked');
  if (['publish', 'yank', 'owner'].includes(sub ?? '')) return void info.raise('publish', `cargo ${sub} changes the public registry`);
  if (sub === 'login' || sub === 'logout') return void info.raise('privilege', `cargo ${sub} handles registry credentials`);
  if (args.some((a) => a.text === '--config' || a.text.startsWith('--config='))) info.raise('unknown', 'cargo --config overrides configuration');
  info.raise('build-test');
}

function gemHandler(info: Info, args: Word[]): void {
  const sub = args[0]?.text;
  if (['install', 'update', 'uninstall', 'i'].includes(sub ?? '')) return void info.raise('package-install', `gem ${sub} changes installed gems`).setInstall('add');
  if (['push', 'yank', 'owner'].includes(sub ?? '')) return void info.raise('publish', `gem ${sub} changes the public registry`);
  if (sub === 'signin' || sub === 'signout') return void info.raise('privilege', 'gem signin handles registry credentials');
  if (sub === 'build') return void info.raise('build-test');
  info.raise('read-only');
}

function bundleHandler(info: Info, args: Word[], env: Env): void {
  const sub = args[0]?.text ?? 'install';
  if (sub === 'install') {
    const locked = args.some((a) => a.text === '--frozen' || a.text === '--deployment');
    return void info.raise('package-install', locked ? 'bundle install --frozen uses Gemfile.lock' : 'bundle install can change Gemfile.lock').setInstall(locked ? 'locked' : 'add');
  }
  if (['add', 'update', 'remove', 'lock'].includes(sub)) return void info.raise('package-install', `bundle ${sub} changes dependencies`).setInstall('add');
  if (sub === 'exec') {
    info.raise('build-test');
    if (args.length > 1) classifyArgv(args.slice(1), env);
    return;
  }
  if (sub === 'config') return void info.raise('privilege', 'bundle config changes sources and credentials');
  info.raise('build-test');
}

function composerHandler(info: Info, args: Word[]): void {
  const sub = positional(args, new Set(['-d', '--working-dir']))[0]?.text ?? 'install';
  if (sub === 'install' || sub === 'i') return void info.raise('package-install', 'composer install uses composer.lock').setInstall('locked');
  if (['require', 'remove', 'update', 'upgrade', 'u', 'req'].includes(sub)) return void info.raise('package-install', `composer ${sub} changes dependencies`).setInstall('add');
  if (sub === 'global' || sub === 'create-project') return void info.raise('package-install', `composer ${sub} installs outside the lockfile`).setInstall('add');
  if (sub === 'config') return void info.raise('privilege', 'composer config changes repositories and credentials');
  info.raise('build-test');
}

function systemPkg(info: Info, args: Word[], _env: Env, name: string): void {
  const sub = positional(args, new Set(['-o', '-c', '-t']))[0]?.text;
  if (['search', 'show', 'list', 'info', 'policy', 'madison', 'query', '-Q', '-Ss', '-Si', 'depends', 'rdepends'].includes(sub ?? '')) return void info.raise('read-only');
  info.raise('package-install', `${name} changes system packages`).setInstall('add');
}

function dotnetHandler(info: Info, args: Word[]): void {
  const sub = args[0]?.text;
  if (sub === 'add' && args[1]?.text !== 'reference') return void info.raise('package-install', 'dotnet add package changes dependencies').setInstall('add');
  if (sub === 'remove' && args[1]?.text === 'package') return void info.raise('package-install', 'dotnet remove package changes dependencies').setInstall('add');
  if (sub === 'restore') return void info.raise('package-install', 'dotnet restore downloads dependencies').setInstall(args.some((a) => a.text === '--locked-mode') ? 'locked' : 'add');
  if (sub === 'tool') return void info.raise('package-install', 'dotnet tool installs tools').setInstall('add');
  if (sub === 'nuget') return void info.raise(args[1]?.text === 'push' || args[1]?.text === 'delete' ? 'publish' : 'privilege', 'dotnet nuget changes feeds or packages');
  info.raise('build-test');
}

function swiftHandler(info: Info, args: Word[]): void {
  if (args[0]?.text === 'package') {
    const action = args[1]?.text;
    if (action === 'update' || action === 'add-dependency') return void info.raise('package-install', `swift package ${action} changes Package.resolved`).setInstall('add');
    if (action === 'resolve') return void info.raise('package-install', 'swift package resolve uses Package.resolved').setInstall('locked');
  }
  info.raise('build-test');
}

function denoHandler(info: Info, args: Word[]): void {
  const sub = args[0]?.text;
  if (sub === 'add' || sub === 'install' || sub === 'remove' || sub === 'outdated' && args.some((a) => a.text === '--update')) return void info.raise('package-install', `deno ${sub} changes dependencies`).setInstall('add');
  if (sub === 'publish') return void info.raise('publish', 'deno publish uploads to a registry');
  const remote = args.find((a) => /^https?:\/\//.test(a.text));
  if (remote && (sub === 'run' || sub === 'eval' || sub === undefined)) {
    info.raise('privilege', 'deno runs code fetched from a URL').host(urlHost(remote.text));
    return;
  }
  info.raise('build-test');
}

function mixHandler(info: Info, args: Word[]): void {
  const sub = args[0]?.text;
  if (sub === 'deps.get') return void info.raise('package-install', 'mix deps.get installs mix.lock dependencies').setInstall(args.some((a) => a.text === '--check-locked') ? 'locked' : 'add');
  if (sub === 'deps.update' || sub === 'deps.unlock') return void info.raise('package-install', `mix ${sub} changes mix.lock`).setInstall('add');
  if (sub === 'hex.publish') return void info.raise('publish', 'mix hex.publish uploads to a registry');
  info.raise('build-test');
}

// --- network ---------------------------------------------------------------

const CURL_VALUE_SHORT = new Set(['o', 'd', 'u', 'H', 'X', 'A', 'e', 'b', 'c', 'F', 'T', 'x', 'U', 'm', 'w', 'r', 'K', 'E', 'C', 'z', 'y', 'Y', 'D', 'Q', 't', 'P']);
const CURL_VALUE_LONG = new Set([
  '--output', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '--header', '--request', '--user',
  '--user-agent', '--referer', '--cookie', '--cookie-jar', '--form', '--form-string', '--upload-file', '--proxy', '--proxy-user', '--max-time',
  '--connect-timeout', '--write-out', '--range', '--config', '--cert', '--key', '--cacert', '--capath', '--resolve', '--connect-to',
  '--retry', '--retry-delay', '--retry-max-time', '--time-cond', '--limit-rate', '--interface', '--dns-servers', '--doh-url', '--url',
  '--output-dir', '--trace', '--trace-ascii', '--stderr', '--dump-header', '--continue-at', '--ciphers', '--proto', '--proto-redir',
  '--max-redirs', '--preproxy', '--socks4', '--socks4a', '--socks5', '--socks5-hostname', '--unix-socket', '--abstract-unix-socket',
  '--oauth2-bearer', '--aws-sigv4', '--variable', '--expand-url', '--url-query', '--etag-save', '--etag-compare', '--hsts', '--alt-svc',
  '--netrc-file', '--create-file-mode', '--quote', '--keepalive-time', '--speed-limit', '--speed-time', '--max-filesize',
]);
const CURL_REROUTE = new Set(['x', '--proxy', '--resolve', '--connect-to', '--doh-url', '--preproxy', '--socks4', '--socks4a', '--socks5', '--socks5-hostname', '--unix-socket', '--abstract-unix-socket', 'K', '--config', '--expand-url', '--variable']);
const CURL_WRITE = new Set(['o', '--output', 'c', '--cookie-jar', 'D', '--dump-header', '--trace', '--trace-ascii', '--stderr', '--etag-save', '--hsts', '--alt-svc']);

function curlHandler(info: Info, args: Word[], env: Env, name: string): void {
  info.raise('network', `${name} makes network requests`);
  const positionals: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const t = a.text;
    if (t === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const opt = eq >= 0 ? t.slice(0, eq) : t;
      if (!CURL_VALUE_LONG.has(opt)) continue;
      const value = eq >= 0 ? literal(t.slice(eq + 1)) : args[++i];
      curlOption(info, opt, value, env);
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const letter = t[k]!;
        if (!CURL_VALUE_SHORT.has(letter)) continue;
        const attached = t.slice(k + 1);
        const value = attached.length > 0 ? literal(attached) : args[++i];
        curlOption(info, letter, value, env);
        break;
      }
      continue;
    }
    positionals.push(a);
  }
  urlArgs(info, positionals, true);
}

function curlOption(info: Info, opt: string, value: Word | undefined, env: Env): void {
  if (CURL_REROUTE.has(opt)) {
    info.hostsComplete = false;
    info.reasons.push(`curl ${opt.length === 1 ? `-${opt}` : opt} reroutes or hides the destination`);
  }
  if (opt === '--url' && value) urlArgs(info, [value], true);
  if (CURL_WRITE.has(opt) && value && value.text !== '-' && !DEV_SINKS.test(value.text)) addWrite(env.state, value, env.base, 'write', 'curl', false);
  if ((opt === 'T' || opt === '--upload-file') && value) info.reasons.push('uploads a local file');
}

function wgetHandler(info: Info, args: Word[], env: Env): void {
  info.raise('network', 'wget downloads files');
  const valueOpts = new Set(['-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix', '-e', '--execute', '-i', '--input-file', '-U', '--user-agent', '--header', '--post-data', '--post-file', '-t', '--tries', '-T', '--timeout', '-w', '--wait', '--user', '--password', '-B', '--base', '--body-data', '--method', '-Q', '--quota', '--config', '-l', '--level']);
  const pos = positional(args, valueOpts);
  for (const opt of ['-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix']) {
    const v = valueOf(args, opt) ?? valueOfLong(args, opt);
    if (v && v.text !== '-') addWrite(env.state, v, env.base, 'write', 'wget', opt === '-P' || opt === '--directory-prefix');
  }
  if (args.some((a) => ['-e', '--execute', '-i', '--input-file', '--config'].includes(a.text) || /^--(execute|input-file|config)=/.test(a.text))) {
    info.hostsComplete = false;
    info.reasons.push('wget -e/-i/--config hides the destination');
  }
  urlArgs(info, pos, true);
}

function httpieHandler(info: Info, args: Word[]): void {
  info.raise('network', 'httpie makes network requests');
  const pos = positional(args, new Set(['-a', '--auth', '-A', '--auth-type', '-o', '--output', '--session', '--proxy', '--verify', '--cert', '--cert-key']));
  const target = pos.find((w) => !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(w.text));
  if (args.some((a) => a.text === '--proxy' || a.text.startsWith('--proxy='))) info.hostsComplete = false;
  if (!target) info.hostsComplete = false;
  else urlArgs(info, [target], true);
}

/** Collect hosts from URL-like arguments. With `bareHosts`, an argument without a scheme is a host (curl and wget accept `example.com/path`). */
function urlArgs(info: Info, words: Word[], bareHosts = false): void {
  let seen = false;
  for (const w of words) {
    if (w.dynamic) {
      info.host(null);
      seen = true;
      continue;
    }
    const t = w.text;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
      seen = true;
      if (/^file:/i.test(t)) continue;
      info.host(urlHost(t));
      continue;
    }
    if (bareHosts) {
      seen = true;
      const host = t.split(/[/?#]/)[0]!;
      info.host(host.includes('@') ? host.slice(host.lastIndexOf('@') + 1) : host);
    }
  }
  if (!seen) {
    info.hostsComplete = false;
    info.reasons.push('no destination is statically visible');
  }
}

function sshHandler(info: Info, args: Word[], env: Env): void {
  info.raise('network', 'ssh connects to another machine');
  const valueOpts = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B', '-P']);
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    if (t === '-o' || t.startsWith('-o')) {
      const v = t === '-o' ? args[i + 1]?.text ?? '' : t.slice(2);
      if (/^(ProxyCommand|LocalCommand|PermitLocalCommand|KnownHostsCommand|Match)/i.test(v)) markOpaque(env.state, 'ssh -o runs a local command');
      if (/^ProxyJump/i.test(v)) info.hostsComplete = false;
    }
    if (t === '-J') info.host(args[i + 1]?.dynamic ? null : (args[i + 1]?.text.split('@').pop() ?? null));
  }
  const pos = positional(args, valueOpts);
  const dest = pos[0];
  if (!dest) info.hostsComplete = false;
  else info.host(dest.dynamic ? null : sshDestHost(dest.text));
}

function sshDestHost(t: string): string {
  if (t.startsWith('ssh://')) return urlHost(t) ?? '';
  return t.slice(t.lastIndexOf('@') + 1).split(':')[0]!;
}

function scpHandler(info: Info, args: Word[], env: Env, name: string): void {
  info.raise('network', `${name} copies files to or from another machine`);
  if (args.some((a) => a.text === '-S' || (a.text === '-o' && /ProxyCommand/i.test(args[args.indexOf(a) + 1]?.text ?? '')))) markOpaque(env.state, `${name} runs a local program for the connection`);
  const pos = positional(args, new Set(['-P', '-i', '-o', '-F', '-J', '-S', '-l', '-c', '-D', '-X']));
  let remote = false;
  for (const w of pos) {
    if (w.dynamic) {
      info.host(null);
      continue;
    }
    const m = /^(?:[^@/]+@)?([^:/]+):/.exec(w.text);
    if (m || w.text.startsWith('scp://') || w.text.startsWith('sftp://')) {
      remote = true;
      info.host(m ? m[1]! : urlHost(w.text));
    }
  }
  if (!remote && name === 'sftp' && pos[0]) info.host(sshDestHost(pos[0].text));
  else if (!remote) info.hostsComplete = false;
}

function rsyncHandler(info: Info, args: Word[], env: Env): void {
  if (args.some((a) => a.text === '-e' || a.text.startsWith('--rsh') || a.text.startsWith('-e'))) markOpaque(env.state, 'rsync -e runs a local program for the connection');
  const pos = positional(args, new Set(['--exclude', '--include', '--filter', '-f', '--exclude-from', '--include-from', '--files-from', '--port', '--password-file', '--chmod', '--chown', '--log-file', '--partial-dir', '--temp-dir', '-T', '--backup-dir', '--suffix', '--compare-dest', '--copy-dest', '--link-dest', '-B', '--block-size', '--timeout', '--contimeout', '--bwlimit', '--max-size', '--min-size', '--max-delete', '--modify-window', '--rsync-path', '--out-format', '--info', '--debug']));
  let remote = false;
  for (const w of pos) {
    if (w.dynamic) continue;
    const m = /^(?:[^@/]+@)?([^:/]+):/.exec(w.text);
    if (w.text.startsWith('rsync://')) {
      remote = true;
      info.host(urlHost(w.text));
    } else if (m) {
      remote = true;
      info.host(m[1]!);
    }
  }
  if (remote) info.raise('network', 'rsync copies to or from another machine');
  else info.raise('build-test');
  const dest = pos[pos.length - 1];
  if (dest && pos.length >= 2 && !/^(?:[^@/]+@)?[^:/]+:/.test(dest.text)) {
    const deleting = args.some((a) => a.text.startsWith('--delete') || a.text === '--remove-source-files');
    addWrite(env.state, dest, env.base, deleting ? 'delete' : 'write', 'rsync', deleting);
    if (deleting && outsideRoot(dest, env.base, env.state) !== false) info.raise('destructive', 'rsync --delete outside the worktree');
  }
}

function hostPortHandler(info: Info, args: Word[], _env: Env, name: string): void {
  info.raise('network', `${name} contacts another machine`);
  const pos = positional(args, new Set(['-p', '-s', '-w', '-i', '-q', '-c', '-W', '-t', '-l', '-n', '-I', '-x', '-X', '-P', '-e']));
  if (args.some((a) => a.text === '-l' || a.text === '-L')) info.reasons.push('listens for connections');
  const dest = pos[0];
  if (!dest) info.hostsComplete = false;
  else info.host(dest.dynamic ? null : dest.text.slice(dest.text.lastIndexOf('@') + 1));
}

function digHandler(info: Info, args: Word[]): void {
  info.raise('network', 'dig sends DNS queries');
  for (const a of args) {
    if (a.text.startsWith('@')) info.host(a.dynamic ? null : a.text.slice(1));
  }
  const name = args.find((a) => !a.text.startsWith('-') && !a.text.startsWith('@') && !a.text.startsWith('+') && !/^(A|AAAA|MX|TXT|NS|CNAME|SOA|ANY|PTR|SRV|CAA|IN)$/i.test(a.text));
  if (!name) info.hostsComplete = false;
  else info.host(name.dynamic ? null : name.text);
}

function socatHandler(info: Info, args: Word[]): void {
  info.raise('network', 'socat relays connections');
  let found = false;
  for (const a of args) {
    const m = /^(?:tcp|tcp4|tcp6|udp|udp4|udp6|openssl|ssl|tcp-connect|udp-connect|proxy)[^:]*:([^:,]+)/i.exec(a.text);
    if (m) {
      found = true;
      info.host(a.dynamic ? null : m[1]!);
    }
    if (/^(exec|system):/i.test(a.text)) info.raise('privilege', 'socat EXEC/SYSTEM runs a program on a connection');
  }
  if (!found) info.hostsComplete = false;
}

// --- files -----------------------------------------------------------------

function rmHandler(info: Info, args: Word[], env: Env, name: string): void {
  let recursive = false;
  let force = false;
  const targets: Word[] = [];
  let opts = true;
  for (const a of args) {
    const t = a.text;
    if (opts && t === '--') {
      opts = false;
      continue;
    }
    if (opts && t.startsWith('--')) {
      if (t === '--recursive') recursive = true;
      if (t === '--force') force = true;
      if (t === '--no-preserve-root') info.raise('destructive', `${name} --no-preserve-root`);
      continue;
    }
    if (opts && t.startsWith('-') && t.length > 1 && !a.dynamic) {
      if (/[rR]/.test(t)) recursive = true;
      if (/f/.test(t)) force = true;
      continue;
    }
    targets.push(a);
  }
  info.raise('build-test');
  if (name === 'shred') force = true;
  for (const w of targets) deleteTarget(info, w, env, name, recursive, force);
}

function deleteTarget(info: Info, w: Word, env: Env, via: string, recursive: boolean, force = false): void {
  const outside = outsideRoot(w, env.base, env.state);
  if (outside === null) {
    if (recursive || force) info.raise('destructive', `${via} ${recursive ? '-r ' : ''}on a target computed at run time ("${w.text}")`);
  } else if (outside) {
    info.raise('destructive', `${via} deletes "${w.text}", which is outside the worktree`);
  }
  addWrite(env.state, w, env.base, 'delete', via, recursive);
}

function copyHandler(info: Info, args: Word[], env: Env, name: string): void {
  info.raise('build-test');
  const valueOpts = name === 'install' ? new Set(['-m', '-o', '-g', '-t', '-S', '-T', '--mode', '--owner', '--group', '--target-directory', '--suffix']) : new Set(['-t', '-S', '--target-directory', '--suffix', '--backup', '-T']);
  const pos = positional(args, valueOpts);
  const targetDir = valueOf(args, '-t') ?? valueOfLong(args, '--target-directory');
  linkSources(args, pos, targetDir, env, name);
  if (name === 'mv') for (const w of targetDir ? pos : pos.slice(0, -1)) addWrite(env.state, w, env.base, 'delete', 'mv', true);
  if (targetDir) {
    addWrite(env.state, targetDir, env.base, 'write', name, true);
    return;
  }
  if (name === 'ln' && pos.length === 1) {
    const src = pos[0]!;
    addWrite(env.state, literal(posix.basename(src.text)), env.base, 'write', 'ln', false);
    return;
  }
  const dest = pos[pos.length - 1];
  if (dest && pos.length >= 2) addWrite(env.state, dest, env.base, 'write', name, args.some((a) => /^-[a-zA-Z]*[rRa]/.test(a.text) || a.text === '--recursive' || a.text === '--archive'));
  if (name === 'install' && args.some((a) => a.text === '-o' || a.text === '-g' || a.text.startsWith('--owner') || a.text.startsWith('--group'))) info.raise('privilege', 'install sets file ownership');
}

/**
 * A link makes its target writable under the link's name, so the target is
 * judged like a write: `ln -s ../.claude/settings.json apps/s.json` followed
 * by `echo ... > apps/s.json` would otherwise edit a protected file, and a
 * hard link to a file outside the worktree turns the next Edit into a write
 * outside the sandbox's view.
 */
function linkSources(args: Word[], pos: Word[], targetDir: Word | undefined, env: Env, name: string): void {
  const flags = args.filter((a) => /^-[A-Za-z]+$/.test(a.text) && !a.dynamic).map((a) => a.text.slice(1)).join('');
  const symbolic = name === 'ln' ? flags.includes('s') || args.some((a) => a.text === '--symbolic') : name === 'cp' && (flags.includes('s') || args.some((a) => a.text === '--symbolic-link'));
  const hard = name === 'ln' ? !symbolic : name === 'cp' && (flags.includes('l') || args.some((a) => a.text === '--link'));
  if (!symbolic && !hard) return;
  const sources = targetDir ? pos : pos.length === 1 ? pos : pos.slice(0, -1);
  const dest = targetDir ?? (pos.length >= 2 ? pos[pos.length - 1] : undefined);
  // `ln -sr` takes the target relative to the current directory and rewrites it for the link.
  const relativeToCwd = name === 'ln' && (flags.includes('r') || args.some((a) => a.text === '--relative'));
  for (const src of sources) {
    if (hard || relativeToCwd || isAbsoluteText(src) || src.dynamic) {
      addWrite(env.state, src, env.base, 'link', name, false);
      continue;
    }
    // A relative symlink target is resolved from the directory holding the link,
    // which is the destination itself when it is a directory; judge both readings.
    const destPath = dest ? targetPath(dest, env.base, env.state) : env.base;
    if (destPath === null) {
      addWrite(env.state, src, null, 'link', name, false);
      continue;
    }
    const linkDirs = dest && !targetDir ? [posix.dirname(destPath), destPath] : [destPath];
    for (const dir of linkDirs) addWrite(env.state, src, dir, 'link', name, false);
  }
}

function tarHandler(info: Info, args: Word[], env: Env, name: string): void {
  info.raise('build-test');
  // Old-style bundled flags (`tar xzf a.tgz`) put the mode in the first word.
  const first = args[0]?.text ?? '';
  const extracting = args.some((a) => /^-[A-Za-z]*x/.test(a.text) || a.text === '--extract' || a.text === '--get') || (/^[A-Za-z]+$/.test(first) && first.includes('x'));
  if (!extracting) return;
  const dir = valueOf(args, '-C') ?? valueOfLong(args, '--directory') ?? valueOfLong(args, '--cd');
  addWrite(env.state, dir ?? literal('.'), env.base, 'write', `${name} -x`, true, true);
}

const GLOB_SHOPTS = /^(dotglob|nocaseglob|globstar|extglob|expand_aliases|nocasematch|globasciiranges|failglob|nullglob)$/;

function shoptHandler(info: Info, args: Word[], env: Env): void {
  info.raise('read-only');
  if (!args.some((a) => a.text === '-s' || a.text === '-u')) return;
  // dotglob lets `*` reach .git and .claude, nocaseglob lets `.GI?` match .git, expand_aliases revives aliases.
  if (args.some((a) => a.dynamic || (GLOB_SHOPTS.test(a.text) && !/^(failglob|nullglob)$/.test(a.text)))) {
    markOpaque(env.state, 'shopt changes how later words are expanded');
  }
}

function chmodHandler(info: Info, args: Word[], env: Env): void {
  info.raise('build-test');
  const pos = positional(args, new Set(['--reference']));
  const mode = pos[0];
  if (mode && (/[ugoa]*[+=][rwxXt]*s/.test(mode.text) || /^[0-7]?[2-7][0-7]{3}$/.test(mode.text) && mode.text.length === 4 && /^[2-7]/.test(mode.text))) {
    info.raise('privilege', 'chmod sets setuid or setgid bits');
  }
  for (const w of pos.slice(1)) {
    addWrite(env.state, w, env.base, 'write', 'chmod', args.some((a) => a.text === '-R'));
    if (outsideRoot(w, env.base, env.state) === true) info.raise('destructive', `chmod changes "${w.text}", outside the worktree`);
  }
}

function inPlaceHandler(info: Info, args: Word[], env: Env, name: string): void {
  const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a.text) || a.text.startsWith('--in-place'));
  info.raise(name === 'perl' ? 'build-test' : 'read-only');
  if (!inPlace) {
    if (name === 'perl') interpreterStdin(info, args, env, name);
    return;
  }
  const valueOpts = new Set(['-e', '-f', '--expression', '--file', '-E', '-M', '-I', '-l']);
  const pos = positional(args, valueOpts);
  const scriptGiven = args.some((a) => ['-e', '-f', '--expression', '--file', '-E'].includes(a.text) || /^--(expression|file)=/.test(a.text));
  const files = scriptGiven ? pos : pos.slice(1);
  for (const w of files) addWrite(env.state, w, env.base, 'write', `${name} -i`, false);
}

function awkHandler(info: Info, args: Word[], env: Env, name: string): void {
  info.raise('read-only');
  const inplace = args.findIndex((a, i) => a.text === '-i' && args[i + 1]?.text === 'inplace');
  if (inplace < 0) return;
  const pos = positional(args, new Set(['-f', '-v', '-F', '-i', '-e']));
  const scriptGiven = args.some((a) => a.text === '-f' || a.text === '-e');
  for (const w of scriptGiven ? pos : pos.slice(1)) addWrite(env.state, w, env.base, 'write', `${name} -i inplace`, false);
}

function ddHandler(info: Info, args: Word[], env: Env): void {
  info.raise('build-test');
  for (const a of args) {
    if (!a.text.startsWith('of=')) continue;
    const target = { ...a, text: a.text.slice(3), glob: false };
    if (/^\/dev\/(disk|rdisk|sd|nvme|hd|mmcblk|xvd|vd)/.test(target.text)) info.raise('destructive', 'dd writes to a block device');
    else if (outsideRoot(target, env.base, env.state) !== false && !DEV_SINKS.test(target.text)) info.raise('destructive', 'dd writes outside the worktree');
    if (!DEV_SINKS.test(target.text)) addWrite(env.state, target, env.base, 'write', 'dd', false);
  }
}

function findHandler(info: Info, args: Word[], env: Env): void {
  info.raise('read-only');
  const roots: Word[] = [];
  let i = 0;
  while (i < args.length && !args[i]!.text.startsWith('-') && args[i]!.text !== '(' && args[i]!.text !== '!') roots.push(args[i++]!);
  if (roots.length === 0) roots.push(literal('.'));
  for (; i < args.length; i++) {
    const t = args[i]!.text;
    if (t === '-delete') for (const r of roots) deleteTarget(info, r, env, 'find -delete', true, true);
    if (t === '-fprint' || t === '-fprint0' || t === '-fprintf' || t === '-fls') {
      const target = args[i + 1];
      if (target) addWrite(env.state, target, env.base, 'write', `find ${t}`, false);
    }
    if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
      const cmd: Word[] = [];
      let j = i + 1;
      for (; j < args.length; j++) {
        const x = args[j]!.text;
        if (x === ';' || x === '+') break;
        cmd.push(args[j]!);
      }
      i = j;
      if (cmd.length === 0) continue;
      // `{}` stands for each match, so judge it as each search root; that keeps `find . -exec rm {} +` inside the tree.
      const placeholder = roots.length === 1 ? roots[0]! : dynamicWord('{}');
      const substituted = cmd.map((w) => (w.text === '{}' ? { ...placeholder } : w));
      classifyArgv(substituted, env);
    }
  }
}

function killHandler(info: Info, args: Word[]): void {
  if (args.some((a) => a.text === '-l' || a.text === '-L')) return void info.raise('read-only');
  const targets = positional(args, new Set(['-s', '-n']));
  // Job ids and `$!` (the job this command line just started) are the worker's own processes.
  if (targets.length > 0 && targets.every((a) => /^%\d*$/.test(a.text) || a.text === '$!')) return void info.raise('build-test');
  info.raise('destructive', 'kill signals arbitrary processes and could stop the controller');
}

// --- shells and evaluation ---------------------------------------------------

function shellHandler(info: Info, args: Word[], env: Env, name: string): void {
  const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text) && !a.quoted);
  if (c >= 0) {
    info.raise('build-test');
    const body = args[c + 1];
    if (!body) return void markOpaque(env.state, `${name} -c without a command`);
    if (body.dynamic) {
      if (body.subs.some((s) => fetches(s))) info.raise('privilege', `${name} -c runs downloaded content`);
      return void markOpaque(env.state, `${name} -c runs a command computed at run time`);
    }
    return void nestedShell(body, env, `${name} -c`);
  }
  interpreterStdin(info, args, env, name);
}

/** An interpreter given no program file reads its program from stdin: judge where stdin comes from. */
function interpreterStdin(info: Info, args: Word[], env: Env, name: string): void {
  info.raise('build-test');
  const valueOpts = new Set(['-o', '-O', '+O', '-W', '-X', '-I', '-M', '-r', '--require', '--import', '--loader', '-x']);
  const pos = positional(args, valueOpts);
  const programFromArgs = pos.length > 0 && pos[0]!.text !== '-' || args.some((a) => ['-e', '-E', '-p', '--eval', '--print', '-c'].includes(a.text));
  for (const w of pos) {
    if (w.procSub && w.subs.some((s) => fetches(s))) {
      info.raise('privilege', `${name} runs a script downloaded through process substitution`);
      return;
    }
  }
  if (programFromArgs) {
    if (pos[0] && SHELLS.has(name)) info.reasons.push(`runs the script ${pos[0].text}`);
    return;
  }
  const isShell = SHELLS.has(name);
  const stdin = env.cmd.redirects.find((r) => r.op === '<<' || r.op === '<<-' || r.op === '<<<' || r.op === '<');
  if (stdin) {
    if (stdin.op === '<') return;
    if (!isShell) return;
    if (stdin.op === '<<<') {
      if (stdin.target?.dynamic) markOpaque(env.state, `${name} runs a here-string computed at run time`);
      else if (stdin.target) nestedShell(stdin.target, env, `${name} <<<`);
      return;
    }
    if (stdin.heredoc) nestedShell(literal(stdin.heredoc.body), env, `${name} <<`);
    return;
  }
  if (env.cmd.stage > 0) {
    const prev = env.previous;
    if (prev.some((p) => commandFetches(p))) {
      info.raise('privilege', `pipes downloaded content into ${name}, which runs it`);
      return;
    }
    if (!isShell) return;
    const last = prev[prev.length - 1];
    const lastName = last?.words[0] ? programName(last.words[0].text) : '';
    if (last && (lastName === 'echo' || lastName === 'printf') && last.words.slice(1).every((w) => !w.dynamic)) {
      nestedShell(literal(last.words.slice(1).filter((w) => !w.text.startsWith('-')).map((w) => w.text).join(' ')), env, `${lastName} | ${name}`);
      return;
    }
    if (last && lastName === 'cat' && last.words.length === 2 && !last.words[1]!.dynamic) return;
    markOpaque(env.state, `${name} runs a script read from a pipe`);
    return;
  }
  if (INTERPRETERS.has(name) && pos.length === 0) info.reasons.push(`${name} with no script reads from stdin`);
}

function fetches(src: string): boolean {
  const parsed = parseShell(src);
  return parsed.commands.some((c) => commandFetches(c));
}

function commandFetches(c: SimpleCommand): boolean {
  let words = c.words;
  while (words[0] && ['sudo', 'env', 'command', 'nohup', 'timeout'].includes(programName(words[0].text))) words = words.slice(1);
  const name = words[0] ? programName(words[0].text) : '';
  if (FETCHERS.has(name)) return true;
  if (name === 'base64' && words.some((w) => w.text === '-d' || w.text === '--decode' || w.text === '-D')) return true;
  if (name === 'xxd' && words.some((w) => w.text === '-r')) return true;
  if (name === 'git' && words.some((w) => w.text === 'show' || w.text === 'cat-file')) return false;
  return words.some((w) => w.subs.some((s) => fetches(s)));
}

function evalHandler(info: Info, args: Word[], env: Env): void {
  info.raise('build-test');
  if (args.length === 0) return;
  if (args.some((a) => a.dynamic)) {
    if (args.some((a) => a.subs.some((s) => fetches(s)))) info.raise('privilege', 'eval runs downloaded content');
    return void markOpaque(env.state, 'eval runs a command computed at run time');
  }
  nestedShell(literal(args.map((a) => a.text).join(' ')), env, 'eval');
}

function sourceHandler(info: Info, args: Word[], env: Env, name: string): void {
  info.raise('build-test');
  const file = args[0];
  if (!file) return;
  if (file.procSub && file.subs.some((s) => fetches(s))) return void info.raise('privilege', `${name} runs a script downloaded through process substitution`);
  if (file.dynamic) return void markOpaque(env.state, `${name} runs a script whose path is computed at run time`);
  info.reasons.push(`sources ${file.text}`);
}

function declareHandler(info: Info, args: Word[], env: Env): void {
  info.raise('read-only');
  if (args.some((a) => a.text === '-f' || a.text === '-fx')) markOpaque(env.state, 'exports a shell function that can shadow programs');
  checkAssignments(args.filter((a) => !a.text.startsWith('-') && a.text.includes('=')), env.state, true);
}

function nestedShell(body: Word, env: Env, via: string): void {
  if (body.dynamic) {
    markOpaque(env.state, `${via} runs a command computed at run time`);
    return;
  }
  classifySource(body.text, env.state, env.depth + 1, env.base);
}

// ---------------------------------------------------------------------------
// Small helpers

function markOpaque(state: State, reason: string): void {
  state.opaque = true;
  if (!state.reasons.includes(reason)) state.reasons.push(reason);
}

function literal(text: string): Word {
  return { text, raw: text, dynamic: false, quoted: true, glob: false, subs: [], procSub: false };
}

function dynamicWord(text: string): Word {
  return { text, raw: text, dynamic: true, quoted: false, glob: false, subs: [], procSub: false };
}

/** Non-option arguments, skipping the values of options in `valueOpts`, honouring `--`. */
function positional(args: Word[], valueOpts: ReadonlySet<string>): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const t = a.text;
    if (t === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (t.startsWith('-') && t.length > 1 && !a.dynamic) {
      if (valueOpts.has(t)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Drop leading options (and the values of `valueOpts`) and return the rest, starting at the wrapped program. */
function skipOptions(args: Word[], valueOpts: ReadonlySet<string>): Word[] {
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i]!.text;
    if (t === '--') return args.slice(i + 1);
    if (!t.startsWith('-') || t === '-') break;
    if (valueOpts.has(t)) i++;
  }
  return args.slice(i);
}

function valueOf(args: Word[], opt: string): Word | undefined {
  const i = args.findIndex((a) => a.text === opt);
  if (i >= 0) return args[i + 1];
  if (opt.length === 2) {
    const attached = args.find((a) => a.text.startsWith(opt) && a.text.length > 2 && !a.text.startsWith('--'));
    if (attached) return { ...attached, text: attached.text.slice(2) };
  }
  return undefined;
}

function valueOfLong(args: Word[], opt: string): Word | undefined {
  const eq = args.find((a) => a.text.startsWith(`${opt}=`));
  if (eq) return { ...eq, text: eq.text.slice(opt.length + 1) };
  const i = args.findIndex((a) => a.text === opt);
  return i >= 0 ? args[i + 1] : undefined;
}
