import { basename } from 'node:path';

/**
 * The program a check's command runs itself (pure, no I/O; docs/decisions/0010-base-failure-classification.md).
 *
 * A tool's usage error is the check's own only when the check's command invokes that tool directly: `dotnet build
 * A.csproj B.csproj` is the check's command line, while `npm test` whose script runs a wrong `dotnet build`, a chain such
 * as `dotnet restore && npm test`, or `dotnet run --project build/Build.csproj` whose program runs one, put the error in
 * code of the repository, which a change may fix. So a check's command is read as one direct invocation: its program,
 * after a leading env assignment, `env` or an npx-style runner, and that program's arguments; a shell given a script with
 * -c (`sh -c "pytest -q"`) is read as the command of its script. A shell command that is a chain, a pipeline, a
 * background job, a subshell, a command substitution or more than one line is no direct invocation at all.
 *
 * The programs a command starts (checkPrograms) are read wherever it starts them: each command of a chain, a pipeline,
 * a subshell or a substitution, and of the script a shell it starts with -c runs, with how certain that reading is.
 */

export interface DirectInvocation {
  /** The program's file name, lower case, without a Windows extension: `dotnet`, `npm`, `pytest`, `check.sh`. */
  tool: string;
  /** The program as the command writes it: a bare name, an absolute path or a path relative to the check's cwd. */
  program: string;
  /** Its arguments. */
  args: string[];
}

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * Scripts read at most, each run by a shell of the one before (the check's own shell script, then `sh -c '...'` in it, and
 * so on). A shell nested deeper is not read, and makes the reading uncertain.
 */
const MAX_SCRIPT_DEPTH = 3;
/** Substitutions read at most one inside another; a script nested deeper is read as one that does not parse. */
const MAX_SUBSTITUTION_DEPTH = 32;

/** Runners that run the program named after them (and their options), by the words that start them. */
const RUNNERS: readonly { words: readonly string[]; valueOptions: readonly string[]; refuse?: readonly string[] }[] = [
  { words: ['npx'], valueOptions: ['-p', '--package'], refuse: ['-c', '--call'] },
  { words: ['pnpx'], valueOptions: [] },
  { words: ['bunx'], valueOptions: ['-p', '--package'] },
  { words: ['uvx'], valueOptions: ['--from', '--with', '--python', '-p'] },
  { words: ['pnpm', 'exec'], valueOptions: [] },
  { words: ['pnpm', 'dlx'], valueOptions: [] },
  { words: ['yarn', 'exec'], valueOptions: [] },
  { words: ['yarn', 'dlx'], valueOptions: ['-p', '--package'] },
  { words: ['bun', 'x'], valueOptions: [] },
  { words: ['uv', 'run'], valueOptions: ['--with', '--with-requirements', '--extra', '--group', '--python', '-p', '--project', '--directory', '--package', '--env-file', '--index'] },
  { words: ['poetry', 'run'], valueOptions: [] },
  { words: ['pipenv', 'run'], valueOptions: [] },
  { words: ['pdm', 'run'], valueOptions: [] },
];

function toolName(program: string): string {
  return basename(program.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/, '');
}

/**
 * The words of one simple shell command, quotes and escapes resolved and redirections dropped, or null when the
 * script is not one simple command (a chain, a pipeline, a background job, a subshell, a substitution, a here-document,
 * a second line) or does not parse (an unterminated quote).
 */
export function shellWords(script: string): string[] | null {
  const s = script.trim();
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let dropNext = false;
  const flush = (): void => {
    if (inWord) {
      if (dropNext) dropNext = false;
      else words.push(cur);
    }
    cur = '';
    inWord = false;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += s.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '`' || (s[j] === '$' && s[j + 1] === '(')) return null;
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1]!)) j++;
        cur += s[j];
      }
      if (j >= s.length) return null;
      inWord = true;
      i = j + 1;
    } else if (c === '\\') {
      if (i + 1 < s.length && s[i + 1] !== '\n') {
        cur += s[i + 1];
        inWord = true;
      }
      i += 2;
    } else if (c === '\n') {
      return null;
    } else if (/\s/.test(c)) {
      flush();
      i++;
    } else if (c === '#' && !inWord) {
      break;
    } else if (c === '`' || c === ';' || c === '|' || c === '(' || c === ')') {
      return null;
    } else if (c === '$' && s[i + 1] === '(') {
      return null;
    } else if (c === '&') {
      // `&>file` and `&>>file` redirect both streams; anything else is `&&` or a background job.
      if (s[i + 1] !== '>') return null;
      flush();
      i += s[i + 2] === '>' ? 3 : 2;
      dropNext = true;
    } else if (c === '>' || c === '<') {
      if (c === '<' && s[i + 1] === '<') return null;
      // A file descriptor written before the operator (2>) belongs to it, not to the command.
      if (inWord && /^\d+$/.test(cur)) {
        cur = '';
        inWord = false;
      } else flush();
      i++;
      if (s[i] === '>') i++;
      if (s[i] === '&') {
        // 2>&1, >&2, <&0: a descriptor, not a file name.
        i++;
        while (i < s.length && /[\d-]/.test(s[i]!)) i++;
      } else dropNext = true;
    } else {
      cur += c;
      inWord = true;
      i++;
    }
  }
  flush();
  return dropNext ? null : words;
}

/** The script an argv command hands to a shell with -c, or undefined when it is not one. */
function shellScript(command: readonly string[]): string | undefined {
  if (command.length < 3 || !SHELLS.has(toolName(command[0]!))) return undefined;
  for (let i = 1; i < command.length - 1; i++) {
    const a = command[i]!;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) return command[i + 1];
    if (a === '-o' || a === '+o') i++;
    else if (!/^[-+][a-zA-Z]+$/.test(a)) return undefined;
  }
  return undefined;
}

/** Skip a runner's options; null when one of them makes it run something other than one named program. */
function afterOptions(words: readonly string[], from: number, valueOptions: readonly string[], refuse: readonly string[] = []): number | null {
  let i = from;
  while (i < words.length && words[i]!.startsWith('-')) {
    const w = words[i]!;
    if (w === '--') return i + 1;
    const name = w.includes('=') ? w.slice(0, w.indexOf('=')) : w;
    if (refuse.includes(name)) return null;
    i += valueOptions.includes(name) && !w.includes('=') ? 2 : 1;
  }
  return i;
}

/**
 * The words of the one simple command `command` runs, or null when it runs no such command (module comment): a shell
 * given a script with -c runs the command of that script, up to MAX_SCRIPT_DEPTH scripts deep.
 */
function invocationWords(command: readonly string[], shell: boolean): string[] | null {
  let words = shell ? (command.length === 1 ? shellWords(command[0]!) : null) : [...command];
  for (let depth = shell ? 1 : 0; words !== null; depth++) {
    const script = shellScript(words);
    if (script === undefined) return words;
    if (depth >= MAX_SCRIPT_DEPTH) return null;
    words = shellWords(script);
  }
  return null;
}

/** The word after `env` at `i` and its options and assignments; null when an option makes env run something else. */
function afterEnv(words: readonly string[], i: number): number | null {
  let j = i + 1;
  for (; j < words.length; j++) {
    const w = words[j]!;
    if (w === '-S' || w.startsWith('--split-string') || w === '-C' || w.startsWith('--chdir')) return null;
    if (w === '-u') j++;
    else if (!(w.startsWith('-') || ASSIGNMENT.test(w))) break;
  }
  return j;
}

/** The word after the shell builtin `exec` at `i` and its options (`-a <name>`, `-c`, `-l`). */
function afterExec(words: readonly string[], i: number): number {
  let j = i + 1;
  while (j < words.length && /^-[acl]+$/.test(words[j]!)) j += words[j]!.includes('a') ? 2 : 1;
  return words[j] === '--' ? j + 1 : j;
}

/**
 * The index of the program the words of one simple command start: the first word after leading assignments, the
 * builtin `exec` with its options, and `env` with its options and assignments. Null when there is none, or when an env
 * option makes env run something other than one named program.
 */
function programIndex(words: readonly string[]): number | null {
  let i = 0;
  for (;;) {
    while (i < words.length && ASSIGNMENT.test(words[i]!)) i++;
    const w = words[i];
    if (w === undefined || w === '') return null;
    if (w === 'exec') i = afterExec(words, i);
    else if (toolName(w) === 'env') {
      const next = afterEnv(words, i);
      if (next === null) return null;
      i = next;
    } else return i;
  }
}

/**
 * The program the command starts, as the command writes it: its first word after leading assignments, `exec` and `env`
 * with its options and assignments, before any runner or `python -m` (`python3` in `python3 -m pytest`, `npx` in `npx
 * jest`, an interpreter's absolute path in `/opt/acme/venv/bin/python -m pytest`). It is the file a shell or env names
 * when it cannot start the command. Null when the command is no direct invocation of one program.
 */
export function startedProgram(command: readonly string[], shell: boolean): string | null {
  const words = invocationWords(command, shell);
  if (words === null) return null;
  const i = programIndex(words);
  return i === null ? null : words[i]!;
}

/** Reserved words that come before the command they introduce (`then pytest`, `! grep`), not a program. */
const BEFORE_COMMAND: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', 'time']);
/** Reserved words that start a compound command whose words up to the next separator are no command (`for x in a b`). */
const NO_COMMAND: ReadonlySet<string> = new Set(['for', 'case', 'select', 'function', 'fi', 'done', 'esac', '}']);

/** How a shell script reads (readScript). */
export interface ScriptReading {
  /**
   * The words of each simple command, quotes and escapes resolved and redirections dropped, in the order the commands
   * start: a command that holds a substitution comes before the commands of the substitution.
   */
  commands: string[][];
  /**
   * Whether the script holds what a reading of its text cannot follow for certain: a command substitution (whose output
   * becomes words of the command around it) or a process substitution, or a here-document (whose body is not read).
   */
  uncertain: boolean;
}

/**
 * The simple commands a shell script runs (ScriptReading): the commands of a chain, a pipeline, a list, a background job,
 * a subshell, each line, and those of a command substitution (`$(...)`, backquotes, in double quotes too) or a process
 * substitution (`<(...)`), which is read as a part of the word it stands in, so the command around it keeps its words
 * (`echo $(git rev-parse HEAD) /x` runs echo with /x as its argument, and git). An arithmetic expansion (`$((1 + 1))`)
 * is a part of a word too, and runs nothing. A here-document ends the reading, since its body is no command. Null when
 * the script does not parse (an unterminated quote or substitution).
 */
export function readScript(script: string): ScriptReading | null {
  const s = script;
  const commands: string[][] = [];
  let uncertain = false;
  let broken = false;
  let stopped = false;
  /** The index after the `)` that closes the `(` at `open`, counting the parentheses between; -1 when none does. */
  const closing = (open: number): number => {
    let depth = 0;
    for (let k = open; k < s.length; k++) {
      if (s[k] === '(') depth++;
      else if (s[k] === ')' && --depth === 0) return k + 1;
    }
    return -1;
  };
  /**
   * Reads the commands from `start` to the `close` that ends a substitution (the `)` of `$(`, or a backquote), or to the
   * end of the script, and returns the index after it. `nested` counts the substitutions it is in.
   */
  const list = (start: number, close: ')' | '`' | null, nested = 0): number => {
    if (nested > MAX_SUBSTITUTION_DEPTH) {
      broken = true;
      return s.length;
    }
    let words: string[] = [];
    let at = commands.length;
    let cur = '';
    let inWord = false;
    let dropNext = false;
    // Subshells opened in this list: their `)` is not the one that closes it.
    let open = 0;
    const flush = (): void => {
      if (inWord) {
        if (dropNext) dropNext = false;
        else words.push(cur);
      }
      cur = '';
      inWord = false;
    };
    const end = (): void => {
      flush();
      dropNext = false;
      if (words.length > 0) commands.splice(at, 0, words);
      words = [];
      at = commands.length;
    };
    /** Reads the substitution whose text starts at `from` and whose commands start at `body`; it becomes part of the word. */
    const substitution = (from: number, body: number, until: ')' | '`'): number => {
      uncertain = true;
      const after = list(body, until, nested + 1);
      cur += s.slice(from, after);
      inWord = true;
      return after;
    };
    let i = start;
    while (i < s.length && !broken && !stopped) {
      const c = s[i]!;
      if (close === '`' && c === '`') {
        end();
        return i + 1;
      }
      if (c === "'") {
        const q = s.indexOf("'", i + 1);
        if (q < 0) {
          broken = true;
          break;
        }
        cur += s.slice(i + 1, q);
        inWord = true;
        i = q + 1;
      } else if (c === '"') {
        let j = i + 1;
        while (j < s.length && s[j] !== '"' && !broken && !stopped) {
          if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1]!)) {
            cur += s[j + 1];
            j += 2;
          } else if (s[j] === '$' && s[j + 1] === '(' && s[j + 2] === '(') {
            const after = closing(j + 1);
            if (after < 0) broken = true;
            else {
              cur += s.slice(j, after);
              j = after;
            }
          } else if (s[j] === '$' && s[j + 1] === '(') j = substitution(j, j + 2, ')');
          else if (s[j] === '`') j = substitution(j, j + 1, '`');
          else cur += s[j++];
        }
        if (j >= s.length) {
          broken = true;
          break;
        }
        inWord = true;
        i = j + 1;
      } else if (c === '\\') {
        if (i + 1 < s.length && s[i + 1] !== '\n') {
          cur += s[i + 1];
          inWord = true;
        }
        i += 2;
      } else if (c === '#' && !inWord) {
        const nl = s.indexOf('\n', i);
        i = nl < 0 ? s.length : nl;
      } else if (c === '$' && s[i + 1] === '(' && s[i + 2] === '(') {
        const after = closing(i + 1);
        if (after < 0) {
          broken = true;
          break;
        }
        cur += s.slice(i, after);
        inWord = true;
        i = after;
      } else if (c === '$' && s[i + 1] === '(') {
        i = substitution(i, i + 2, ')');
      } else if (c === '`') {
        i = substitution(i, i + 1, '`');
      } else if ((c === '<' || c === '>') && s[i + 1] === '(') {
        // A process substitution is a file name the command reads or writes.
        flush();
        i = substitution(i, i + 2, ')');
      } else if (c === ')') {
        end();
        if (open === 0 && close === ')') return i + 1;
        if (open > 0) open--;
        i++;
      } else if (c === '(') {
        end();
        open++;
        i++;
      } else if (c === '\n' || c === ';' || c === '|') {
        end();
        i++;
      } else if (c === '&') {
        if (s[i + 1] === '>') {
          // `&>file` and `&>>file` redirect both streams.
          flush();
          i += s[i + 2] === '>' ? 3 : 2;
          dropNext = true;
        } else {
          end();
          i++;
        }
      } else if (c === '>' || c === '<') {
        if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
          // A here-document: its body is no command, and where it ends is not read.
          uncertain = true;
          end();
          stopped = true;
          break;
        }
        if (inWord && /^\d+$/.test(cur)) {
          cur = '';
          inWord = false;
        } else flush();
        i++;
        // `>>`, `>|`, and a here-string's `<<<`.
        if (s[i] === '>' || s[i] === '|') i++;
        else if (c === '<' && s[i] === '<' && s[i + 1] === '<') i += 2;
        if (s[i] === '&') {
          i++;
          while (i < s.length && /[\d-]/.test(s[i]!)) i++;
        } else dropNext = true;
      } else if (/\s/.test(c)) {
        flush();
        i++;
      } else {
        cur += c;
        inWord = true;
        i++;
      }
    }
    end();
    if (close !== null && !stopped) broken = true;
    return s.length;
  };
  list(0, null);
  return broken ? null : { commands, uncertain };
}

/** The programs a shell script starts (scriptPrograms), each as the command writes it, and whether the reading is uncertain. */
export interface CheckPrograms {
  programs: string[];
  /**
   * Whether the command holds what a reading of its text cannot follow for certain (ScriptReading.uncertain), runs eval,
   * nests shells deeper than MAX_SCRIPT_DEPTH, or does not parse: a program read from it may not be one it starts, and
   * one it starts may not be read. `orbit doctor`, which judges a check from its command alone, warns at most then.
   */
  uncertain: boolean;
}

/**
 * The program each command of a shell script starts (readScript), reserved words skipped, into `out`, and the programs
 * of the script a shell it starts with -c, or eval, runs (nestedPrograms). `depth` is the script's own (1 for a check's
 * shell script). Whether the reading is uncertain.
 */
function scriptPrograms(script: string, depth: number, out: string[]): boolean {
  const reading = readScript(script);
  if (reading === null) return true;
  let uncertain = reading.uncertain;
  for (const command of reading.commands) {
    let words = command;
    while (words.length > 0 && BEFORE_COMMAND.has(words[0]!)) words = words.slice(1);
    if (words.length === 0 || NO_COMMAND.has(words[0]!)) continue;
    const i = programIndex(words);
    if (i === null) continue;
    out.push(words[i]!);
    if (nestedPrograms(words.slice(i), depth, out)) uncertain = true;
  }
  return uncertain;
}

/**
 * The programs of the script that `words` (a program and its arguments, in a script of depth `depth`) runs, into `out`,
 * when the program is a shell given a script with -c (`sh -c "..."`, `bash -lc '...'`) or the builtin eval, whose
 * arguments are a script, read as their words stand (eval expands them first, so its reading is uncertain). Whether the
 * reading is uncertain: past MAX_SCRIPT_DEPTH a script is not read.
 */
function nestedPrograms(words: readonly string[], depth: number, out: string[]): boolean {
  const evaluated = words[0] === 'eval';
  const script = evaluated ? words.slice(1).join(' ') : shellScript(words);
  if (script === undefined) return false;
  if (depth >= MAX_SCRIPT_DEPTH) return true;
  return scriptPrograms(script, depth + 1, out) || evaluated;
}

/**
 * Every program a check's command starts, as the command writes it, each once (0.3.0 retest), and whether the reading is
 * uncertain (CheckPrograms): an argv's program, after leading assignments, `exec` and `env`; and when that is a shell
 * given a script with -c, or the check is a `shell` check, the program each command of the script starts (a chain's, a
 * pipeline's, a subshell's, a substitution's, one `exec` starts), and so on for a shell such a script starts with -c
 * (`sh -c "/x/python -m pytest"`), up to MAX_SCRIPT_DEPTH scripts deep. Not the programs a runner, `python -m` or a
 * script of the repository starts in turn. A shell or env that cannot start one of them names it as written here (a
 * quoted path with a space is one program), or, for a bare name, by the path it found it at on PATH. `orbit doctor` and
 * PREFLIGHT read a check's programs with this one function.
 */
export function checkPrograms(command: readonly string[], shell: boolean): CheckPrograms {
  const out: string[] = [];
  let uncertain: boolean;
  if (shell) uncertain = scriptPrograms(command[0] ?? '', 1, out);
  else {
    const i = programIndex(command);
    if (i === null) return { programs: [], uncertain: false };
    out.push(command[i]!);
    uncertain = nestedPrograms(command.slice(i), 0, out);
  }
  return { programs: [...new Set(out)], uncertain };
}

/** The programs of checkPrograms. */
export function startedPrograms(command: readonly string[], shell: boolean): string[] {
  return checkPrograms(command, shell).programs;
}

/**
 * The program the command runs itself and its arguments (module comment), or null when the command is no direct
 * invocation of one program. `shell` is the check's `shell` setting: its command is then one script.
 */
export function directInvocation(command: readonly string[], shell: boolean): DirectInvocation | null {
  const words = invocationWords(command, shell);
  if (words === null) return null;
  let i = 0;
  // A shell's leading assignments (CI=1 npm test), then env and its options and assignments.
  while (i < words.length && ASSIGNMENT.test(words[i]!)) i++;
  for (let changed = true; changed && i < words.length; ) {
    changed = false;
    const tool = toolName(words[i]!);
    if (tool === 'env') {
      const next = afterEnv(words, i);
      if (next === null) return null;
      i = next;
      changed = true;
      continue;
    }
    for (const r of RUNNERS) {
      if (!r.words.every((w, k) => (k === 0 ? toolName(words[i + k] ?? '') : words[i + k]) === w)) continue;
      const next = afterOptions(words, i + r.words.length, r.valueOptions, r.refuse);
      if (next === null) return null;
      i = next;
      changed = true;
      break;
    }
    // python -m <module> runs that module as the program (python3 -m pytest).
    if (!changed && /^(?:python(?:\d+(?:\.\d+)?)?|py)$/.test(tool)) {
      let j = i + 1;
      while (j < words.length && words[j]!.startsWith('-') && words[j] !== '-m') j += words[j] === '-X' || words[j] === '-W' ? 2 : 1;
      if (words[j] === '-m' && j + 1 < words.length) {
        return { tool: toolName(words[j + 1]!), program: words[j + 1]!, args: words.slice(j + 2) };
      }
    }
  }
  if (i >= words.length || words[i] === '') return null;
  return { tool: toolName(words[i]!), program: words[i]!, args: words.slice(i + 1) };
}
