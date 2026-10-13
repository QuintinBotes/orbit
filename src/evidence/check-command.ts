import { basename } from 'node:path';

/**
 * The program a check's command runs itself (pure, no I/O; docs/decisions/0010-base-failure-classification.md).
 *
 * A tool's usage error is the check's own only when the check's command invokes that tool directly: `dotnet build
 * A.csproj B.csproj` is the check's command line, while `npm test` whose script runs a wrong `dotnet build`, a chain such
 * as `dotnet restore && npm test`, or `dotnet run --project build/Build.csproj` whose program runs one, put the error in
 * code of the repository, which a change may fix. So a check's command is read as one direct invocation: its program,
 * after a leading env assignment, `env` or an npx-style runner, and that program's arguments. A shell command that is
 * a chain, a pipeline, a background job, a subshell, a command substitution or more than one line is no direct
 * invocation at all.
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

/** The words of the one simple command `command` runs, or null when it runs no such command (module comment). */
function invocationWords(command: readonly string[], shell: boolean): string[] | null {
  if (shell) return command.length === 1 ? shellWords(command[0]!) : null;
  const script = shellScript(command);
  return script !== undefined ? shellWords(script) : [...command];
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

/**
 * The words of each simple command a shell script runs, quotes and escapes resolved and redirections dropped: the
 * commands of a chain, a pipeline, a list, a background job, a subshell, a command substitution outside quotes and each
 * line, in order. A here-document ends the reading, since its body is no command. Null when the script does not parse
 * (an unterminated quote).
 */
export function scriptCommands(script: string): string[][] | null {
  const commands: string[][] = [];
  let words: string[] = [];
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
  const end = (): void => {
    flush();
    dropNext = false;
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const s = script;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) return null;
      cur += s.slice(i + 1, close);
      inWord = true;
      i = close + 1;
    } else if (c === '"') {
      // A substitution inside double quotes stays part of the word: it is an argument's value, read no further.
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
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
    } else if (c === '#' && !inWord) {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
    } else if (c === '\n' || c === ';' || c === '|' || c === '(' || c === ')' || c === '`') {
      end();
      i++;
    } else if (c === '$' && s[i + 1] === '(') {
      end();
      i += 2;
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
      if (c === '<' && s[i + 1] === '<') {
        end();
        return commands;
      }
      if (inWord && /^\d+$/.test(cur)) {
        cur = '';
        inWord = false;
      } else flush();
      i++;
      if (s[i] === '>' || s[i] === '|') i++;
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
  return commands;
}

/** The program each command of a shell script starts (scriptCommands), reserved words skipped. */
function scriptPrograms(script: string): string[] {
  const out: string[] = [];
  for (const command of scriptCommands(script) ?? []) {
    let words = command;
    while (words.length > 0 && BEFORE_COMMAND.has(words[0]!)) words = words.slice(1);
    if (words.length === 0 || NO_COMMAND.has(words[0]!)) continue;
    const i = programIndex(words);
    if (i !== null) out.push(words[i]!);
  }
  return out;
}

/**
 * Every program a check's command starts, as the command writes it, each once in order (0.3.0 retest): an argv's
 * program, after leading assignments, `exec` and `env`; and when that is a shell given a script with -c, or the check
 * is a `shell` check, the program each command of the script starts (a chain's, a pipeline's, a subshell's, one `exec`
 * starts). Not the programs a runner, `python -m` or a script of the repository starts in turn. A shell or env that
 * cannot start one of them names it as written here (a quoted path with a space is one program), or, for a bare name,
 * by the path it found it at on PATH. `orbit doctor` and PREFLIGHT read a check's programs with this one function.
 */
export function startedPrograms(command: readonly string[], shell: boolean): string[] {
  if (shell) return [...new Set(scriptPrograms(command[0] ?? ''))];
  const i = programIndex(command);
  if (i === null) return [];
  const script = shellScript(command.slice(i));
  return [...new Set([command[i]!, ...(script !== undefined ? scriptPrograms(script) : [])])];
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
