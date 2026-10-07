// Loaded with `node --import` in front of the unmodified srt CLI (dist/cli.js) on macOS, for a UI check's browser and for
// a process that runs .NET, and nowhere else. It adds constant Seatbelt rules, in named sets, to the profile srt hands to
// sandbox-exec; the query of its own URL names the sets (`?rules=chromium,nis-domainname`), Chromium's alone without one.
//
// chromium (docs/decisions/0001-runtime-choices.md, "Browsers under sandbox-runtime on macOS"): Chromium registers a
// Mach service at start (bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.<pid>) and its child
// processes look it up. srt's Seatbelt profile has no mach-register option and allows only listed mach-lookup names, so
// Chromium aborts. Two rules, for that name pattern only.
//
// nis-domainname (docs/decisions/0009-toolchain-profiles.md, addendum): .NET's CookieContainer reads the NIS domain name
// (getdomainname, which libc answers from the sysctl kern.nisdomainname) in its type initializer, and srt allows only
// listed sysctl reads, so every .NET HTTP client failed ("GetDomainName: -1"), NuGet's restore included. One read-only
// rule, for that one name.
//
// Plain JavaScript with no dependencies, so it runs before srt and is shipped next to plugin/dist/orbit.mjs as it is.
// The rules are constants; nothing is read from the environment, from its URL only which sets of constants to add, and
// from the arguments only the path of srt's settings file, to record a refusal beside it (Orbit's own directory, which
// the sandbox can neither read nor write). Every shape of command it was not verified against (srt 0.0.78), and every
// set it does not know, is refused with exit 97, before a sandbox starts, so a changed srt fails closed instead of
// running unpatched or patched in the wrong place.
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';

export const REFUSAL_EXIT_CODE = 97;
/**
 * Written beside srt's settings file when the preload refuses. srt passes a command's exit code through, so exit 97 alone
 * could be the repository's; this record is what tells Orbit that the preload refused (sandbox-runtime.ts reads it).
 */
export const REFUSAL_FILE = 'chromium-preload-refused';

const NAME_REGEX = '^org[.]chromium[.]Chromium[.]MachPortRendezvousServer[.][0-9]+$';

/** Chromium's rules: its Mach rendezvous service, registered and looked up, for that name pattern only. */
export const CHROMIUM_RULES = Object.freeze([`(allow mach-register (global-name-regex #"${NAME_REGEX}"))`, `(allow mach-lookup (global-name-regex #"${NAME_REGEX}"))`]);

/** .NET's rule: reading the NIS domain name, which CookieContainer's type initializer asks libc for. Nothing else. */
export const NIS_DOMAINNAME_RULES = Object.freeze(['(allow sysctl-read (sysctl-name "kern.nisdomainname"))']);

/** The only rules this preload ever adds, by the set name Orbit asks for. */
export const RULE_SETS = Object.freeze({ chromium: CHROMIUM_RULES, 'nis-domainname': NIS_DOMAINNAME_RULES });

/**
 * The rules the query of this module's URL asks for (`?rules=chromium,nis-domainname`), in that order; Chromium's when
 * there is no query, as before rule sets. Throws for anything else: an empty, unknown, repeated or second `rules`, or
 * another parameter.
 */
export function rulesFor(url) {
  const params = new URL(url).searchParams;
  const keys = [...params.keys()];
  if (keys.length === 0) return [...CHROMIUM_RULES];
  if (keys.length !== 1 || keys[0] !== 'rules') throw new Error(`the preload's URL names no rule set the preload knows (${[...new Set(keys)].join(', ')})`);
  const names = params.get('rules').split(',');
  const rules = [];
  for (const [i, name] of names.entries()) {
    if (!Object.hasOwn(RULE_SETS, name)) throw new Error(`unknown rule set ${JSON.stringify(name)}`);
    if (names.indexOf(name) !== i) throw new Error(`rule set ${JSON.stringify(name)} named twice`);
    rules.push(...RULE_SETS[name]);
  }
  return rules;
}

const MARKER = '(allow process-exec)';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// srt 0.0.78 quote(): inside a single-quoted word an apostrophe is written as '"'"' (close, quoted ', reopen).
const QUOTED_APOSTROPHE = `"'"'`;

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** srt 0.0.78 quote() of a word that needs quoting. */
function quoteWord(text) {
  return `'${text.replace(/'/g, `'${QUOTED_APOSTROPHE}`)}'`;
}

/**
 * The words of a command srt 0.0.78 quote() wrote: separated by one space, each bare (no quote in it) or single-quoted
 * with apostrophes spelled '"'"'. Each word has its offsets in the command, its value, and whether it was quoted.
 */
function wordsOf(command) {
  const words = [];
  let i = 0;
  while (i < command.length) {
    const start = i;
    if (command[i] === "'") {
      let value = '';
      for (;;) {
        const close = command.indexOf("'", i + 1);
        if (close < 0) throw new Error('a quoted word is unterminated');
        value += command.slice(i + 1, close);
        if (command.startsWith(QUOTED_APOSTROPHE, close + 1)) {
          value += "'";
          i = close + QUOTED_APOSTROPHE.length;
          continue;
        }
        i = close + 1;
        break;
      }
      if (i < command.length && command[i] !== ' ') throw new Error('a quoted word is unterminated or followed by more of the same word');
      words.push({ start, end: i, value, quoted: true });
    } else {
      const space = command.indexOf(' ', i);
      i = space < 0 ? command.length : space;
      words.push({ start, end: i, value: command.slice(start, i), quoted: false });
    }
    if (i < command.length) i += 1;
  }
  return words;
}

/**
 * srt's command with the rules (Chromium's two unless others are given) inserted after the one `(allow process-exec)`
 * line of the profile it passes to sandbox-exec with -p. Pure. Throws, naming why, for any other shape: a command that does not start with `env`,
 * sandbox-exec not followed by a single-quoted -p profile, sandbox-exec named anywhere outside that profile again, a
 * profile that is not `(version 1)`, or not exactly one line that is the marker. srt writes every path in the profile with
 * JSON.stringify, so a path can hold the marker's text (or sandbox-exec's) but never a line of its own; such paths are
 * kept as they are.
 */
export function patchSandboxExecCommand(command, rules = CHROMIUM_RULES) {
  if (typeof command !== 'string') throw new Error('the command is not a string');
  if (!command.startsWith('env ')) throw new Error('the command does not start with env');
  const words = wordsOf(command);
  const at = words.findIndex((w) => w.value === SANDBOX_EXEC);
  const flag = at < 0 ? undefined : words[at + 1];
  const word = at < 0 ? undefined : words[at + 2];
  if (!flag || flag.value !== '-p' || flag.quoted || !word || !word.quoted) throw new Error('the sandbox-exec profile is not a single-quoted -p argument');
  if (count(command.slice(0, word.start) + command.slice(word.end), SANDBOX_EXEC) !== 1) throw new Error('the command does not name exactly one sandbox-exec');
  const profile = word.value;
  if (!profile.startsWith('(version 1)\n')) throw new Error('the profile does not start with (version 1)');
  const lines = profile.split('\n');
  if (lines.filter((l) => l === MARKER).length !== 1) throw new Error(`the profile does not hold ${MARKER} exactly once, on a line of its own`);
  const marker = lines.indexOf(MARKER);
  const patched = [...lines.slice(0, marker + 1), ...rules, ...lines.slice(marker + 1)].join('\n');
  return `${command.slice(0, word.start)}${quoteWord(patched)}${command.slice(word.end)}`;
}

/**
 * Where a refusal is recorded: beside the absolute settings.json srt was given with --settings (the first one, which
 * Orbit puts before the command), or nowhere.
 */
export function refusalRecorder(argv) {
  const at = Array.isArray(argv) ? argv.indexOf('--settings') : -1;
  const file = at < 0 ? undefined : argv[at + 1];
  if (typeof file !== 'string' || !isAbsolute(file) || basename(file) !== 'settings.json') return () => {};
  const target = join(dirname(file), REFUSAL_FILE);
  return (why) => {
    try {
      writeFileSync(target, `${why}\n`, { flag: 'wx', mode: 0o600 });
    } catch {
      // Already recorded, or the directory is gone: the exit code and stderr still say it.
    }
  };
}

function carriesSandboxExec(value) {
  if (typeof value === 'string') return value.includes('sandbox-exec');
  return Array.isArray(value) && value.some(carriesSandboxExec);
}

/**
 * Replaces `spawn` on `cp` with one that patches srt's sandbox-exec command (once) with `rules`, makes the other
 * spawners refuse any sandbox-exec, and refuses an exit without a patched sandbox; every refusal is passed to `record`
 * first. `sync` updates the named ESM exports, since srt imports `{ spawn }` from child_process.
 */
export function installSandboxExecHook(cp, proc, sync, record = () => {}, rules = CHROMIUM_RULES) {
  let patched = 0;
  const refuse = (why) => {
    record(why);
    proc.stderr.write(`orbit srt-chromium-preload: ${why}; refusing to start the sandbox (exit ${REFUSAL_EXIT_CODE})\n`);
    proc.exit(REFUSAL_EXIT_CODE);
  };
  const spawn = cp.spawn;
  cp.spawn = function orbitSpawn(command, ...rest) {
    if (!carriesSandboxExec(command) && !carriesSandboxExec(rest[0])) return spawn.call(this, command, ...rest);
    if (patched > 0) return refuse('srt started a second sandbox');
    const options = rest[0];
    if (rest.length !== 1 || options === null || typeof options !== 'object' || Array.isArray(options) || options.shell !== true) {
      return refuse('srt did not spawn sandbox-exec as one shell command');
    }
    let next;
    try {
      next = patchSandboxExecCommand(command, rules);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
    patched += 1;
    return spawn.call(this, next, options);
  };
  for (const name of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    const original = cp[name];
    cp[name] = function orbitGuarded(...args) {
      if (carriesSandboxExec(args[0]) || carriesSandboxExec(args[1])) return refuse(`srt called ${name} with sandbox-exec`);
      return original.apply(this, args);
    };
  }
  sync();
  proc.on('exit', () => {
    if (patched > 0) return;
    record('srt exited without starting a patched sandbox');
    proc.stderr.write(`orbit srt-chromium-preload: srt exited without starting a patched sandbox (exit ${REFUSAL_EXIT_CODE})\n`);
    proc.exitCode = REFUSAL_EXIT_CODE;
  });
}

const record = refusalRecorder(process.argv);
let requested;
try {
  requested = rulesFor(import.meta.url);
} catch (err) {
  const why = err instanceof Error ? err.message : String(err);
  record(why);
  process.stderr.write(`orbit srt-chromium-preload: ${why}; refusing to start the sandbox (exit ${REFUSAL_EXIT_CODE})\n`);
  process.exit(REFUSAL_EXIT_CODE);
}
installSandboxExecHook(childProcess, process, syncBuiltinESMExports, record, requested);
