/**
 * The `orbit` command table and dispatcher. `main` returns the exit code and
 * never calls process.exit, so tests run it in-process with a captured
 * output; main.ts (the process entry) turns the return value into the
 * process's exit code.
 */
import { OrbitError, isOrbitError } from '../core/errors.ts';
import { Args, GLOBAL_OPTIONS, parseCommand, type OptionSpec } from './args.ts';
import { createContext, type CliContext } from './context.ts';
import { EXIT, EXIT_CODE_DOCS, UsageError, exitCodeFor } from './exit.ts';
import { ORBIT_VERSION } from './version.ts';
import { setInvocationEnv } from '../core/invocation.ts';
import { closest } from '../core/near-miss.ts';
import { cancelCommand, CANCEL_OPTIONS, pauseCommand, resumeCommand, RESUME_OPTIONS } from './commands/control.ts';
import { DECIDE_OPTIONS, decideCommand, QUESTIONS_OPTIONS, QUESTIONS_USAGE, questionsCommand } from './commands/decide.ts';
import { DOCTOR_OPTIONS, doctorCommand } from './commands/doctor.ts';
import { GC_OPTIONS, GC_USAGE, gcCommand } from './commands/gc.ts';
import { initCommand } from './commands/init.ts';
import { checkRunnerCommand, shimCommand } from './commands/internal.ts';
import {
  LEARN_EVAL_OPTIONS,
  LEARN_EXPORT_OPTIONS,
  LEARN_INGEST_OPTIONS,
  LEARN_LIST_OPTIONS,
  LEARN_OVERLAYS_OPTIONS,
  LEARN_SCOPE_OPTIONS,
  learnEvalCommand,
  learnExportCommand,
  learnIngestCommand,
  learnListCommand,
  learnOverlaysCommand,
  learnShowCommand,
} from './commands/learn.ts';
import { LOGS_OPTIONS, logsCommand } from './commands/logs.ts';
import { MODELS_REFRESH_OPTIONS, modelsListCommand, modelsRefreshCommand } from './commands/models.ts';
import { NOTIFY_TEST_OPTIONS, NOTIFY_TEST_USAGE, notifyTestCommand } from './commands/notify.ts';
import { policyShowCommand } from './commands/policy.ts';
import { RELEASE_RESOLVE_OPTIONS, RELEASE_RESOLVE_USAGE, releaseResolveCommand } from './commands/release.ts';
import { REPORT_OPTIONS, reportCommand } from './commands/report.ts';
import { RUN_OPTIONS, runCommand } from './commands/run.ts';
import { SERVICE_INSTALL_OPTIONS, refreshServiceLauncher, serviceInstallCommand, serviceRunCommand, serviceStatusCommand, serviceUninstallCommand } from './commands/service.ts';
import { REPAIR_OPTIONS, repairCommand } from './commands/repair.ts';
import { STATS_OPTIONS, STATS_USAGE, statsCommand } from './commands/stats.ts';
import { STATUS_OPTIONS, statusCommand } from './commands/status.ts';
import { TIMELINE_OPTIONS, TIMELINE_USAGE, timelineCommand } from './commands/timeline.ts';
import { verifyCommand } from './commands/verify.ts';

export interface CommandDef {
  /** One word, or two for a subcommand ("models list"). */
  name: string;
  summary: string;
  usage: string;
  options?: OptionSpec;
  run(args: Args, ctx: CliContext): Promise<number>;
}

export const COMMANDS: readonly CommandDef[] = [
  { name: 'doctor', summary: 'check every capability a run depends on, with the exact missing piece for each failure', usage: 'orbit doctor [--probe] [--json]', options: DOCTOR_OPTIONS, run: doctorCommand },
  { name: 'init', summary: 'write .orbit/config.yaml from the starter template and keep runtime state out of git status', usage: 'orbit init', run: initCommand },
  { name: 'run', summary: 'start a run: freeze the policy, then drive it here or hand it to the service', usage: 'orbit run --goal "<goal>" [--mode <mode>] [--environment <name>] [--policy <path>] [--foreground | --detach]', options: RUN_OPTIONS, run: runCommand },
  { name: 'status', summary: 'state, stage, attempts, budgets, workers, open questions and heartbeat of a run (or the recent runs)', usage: 'orbit status [run-id] [--all] [--json]', options: STATUS_OPTIONS, run: statusCommand },
  { name: 'timeline', summary: 'what happened in a run, one readable line per step: state changes, routing, attempts, checks, review, questions, delivery, cost', usage: TIMELINE_USAGE, options: TIMELINE_OPTIONS, run: timelineCommand },
  { name: 'logs', summary: 'raw controller and worker logs of a run, redacted (for a readable history use "orbit timeline")', usage: 'orbit logs <run-id> [--follow] [--lines n] [--controller | --workers | --worker id]', options: LOGS_OPTIONS, run: logsCommand },
  { name: 'pause', summary: 'pause a run durably; workers keep running and are collected on resume', usage: 'orbit pause <run-id>', run: pauseCommand },
  { name: 'resume', summary: 'unpause a run, or resume a BLOCKED one after a decision or an environment repair', usage: 'orbit resume <run-id> [--foreground | --detach] [--force]', options: RESUME_OPTIONS, run: resumeCommand },
  { name: 'cancel', summary: 'cancel a run durably (works for blocked or ownerless runs too)', usage: 'orbit cancel <run-id> [--wait seconds]', options: CANCEL_OPTIONS, run: cancelCommand },
  { name: 'report', summary: 'the final report of a run, or a live interim report while it runs (--learning: improvement over time)', usage: 'orbit report <run-id> [--interim] [--json]   |   orbit report --learning', options: REPORT_OPTIONS, run: reportCommand },
  { name: 'decide', summary: 'record your answer to a question the run persisted', usage: 'orbit decide <run-id> <question-id> <answer...> [--by name]', options: DECIDE_OPTIONS, run: decideCommand },
  { name: 'questions', summary: 'the questions a run is waiting on (--pending: those of every unfinished run)', usage: QUESTIONS_USAGE, options: QUESTIONS_OPTIONS, run: questionsCommand },
  { name: 'models list', summary: 'the model registry with availability and eligibility under the policy', usage: 'orbit models list [--json]', run: modelsListCommand },
  { name: 'models refresh', summary: 'reseed the registry, read the installed CLIs and the Codex catalog (--probe validates live)', usage: 'orbit models refresh [--probe] [--json]', options: MODELS_REFRESH_OPTIONS, run: modelsRefreshCommand },
  { name: 'learn list', summary: 'lessons in the knowledge graph', usage: 'orbit learn list [--status s] [--kind k] [--search text] [--global] [--json]', options: LEARN_LIST_OPTIONS, run: learnListCommand },
  { name: 'learn show', summary: 'one lesson with its evidence and history', usage: 'orbit learn show <lesson-id> [--global] [--json]', options: LEARN_SCOPE_OPTIONS, run: learnShowCommand },
  { name: 'learn ingest', summary: 'learn from a document, URL or pasted text (enters as low-confidence candidates)', usage: 'orbit learn ingest <file|url|-> [--label text] [--print-task] [--curator-output file]', options: LEARN_INGEST_OPTIONS, run: learnIngestCommand },
  { name: 'learn export', summary: 'export the knowledge graph as JSON-LD', usage: 'orbit learn export [--out file] [--global]', options: LEARN_EXPORT_OPTIONS, run: learnExportCommand },
  { name: 'learn overlays', summary: 'prompt overlays and their evaluations; "rollback <id>" reverts one', usage: 'orbit learn overlays [rollback <overlay-id>] [--role r] [--status s] [--global]', options: LEARN_OVERLAYS_OPTIONS, run: learnOverlaysCommand },
  { name: 'learn eval', summary: 'replay-evaluate a candidate overlay and adopt it only without regression', usage: 'orbit learn eval --role <role> | --overlay <id> [--limit n] [--metrics file]', options: LEARN_EVAL_OPTIONS, run: learnEvalCommand },
  { name: 'service install', summary: 'install the background service (launchd or systemd --user) for this repository', usage: 'orbit service install [--entry path]', options: SERVICE_INSTALL_OPTIONS, run: serviceInstallCommand },
  { name: 'service uninstall', summary: 'remove the background service; runs and state are untouched', usage: 'orbit service uninstall', run: serviceUninstallCommand },
  { name: 'service status', summary: 'is the service installed and loaded, and is its controller alive (exit 0 only when loaded)', usage: 'orbit service status [--json]', run: serviceStatusCommand },
  { name: 'service run', summary: 'run the persistent controller in this process (what the service definition starts)', usage: 'orbit service run', run: serviceRunCommand },
  { name: 'verify', summary: 'independent verification of a run\'s latest candidate: a verdict per criterion with its evidence (exit 14 FAIL, 15 INCOMPLETE)', usage: 'orbit verify [run-id] [--json]', run: verifyCommand },
  { name: 'repair', summary: 'repair a failed run (BLOCKED or paused with FAIL evidence) or start a run to repair a described failure', usage: 'orbit repair <run-id | failure description | -> [--foreground | --detach] [--mode <mode>] [--policy <path>]', options: REPAIR_OPTIONS, run: repairCommand },
  { name: 'stats', summary: 'the spec section 16 metrics for this repository\'s runs (success, cost, repair loops, time to green), optionally in a time window', usage: STATS_USAGE, options: STATS_OPTIONS, run: statsCommand },
  { name: 'release resolve', summary: 'settle a deploy whose outcome is unknown: run the environment\'s verify_command, or record --deployed / --not-deployed', usage: RELEASE_RESOLVE_USAGE, options: RELEASE_RESOLVE_OPTIONS, run: releaseResolveCommand },
  { name: 'gc', summary: 'apply artifact retention: delete the run directories and worktrees of finished runs older than retention.keep_runs_days', usage: GC_USAGE, options: GC_OPTIONS, run: gcCommand },
  { name: 'notify test', summary: 'send a test notification through the configured channels (desktop, webhook, GitHub comment) and print each outcome', usage: NOTIFY_TEST_USAGE, options: NOTIFY_TEST_OPTIONS, run: notifyTestCommand },
  { name: 'policy show', summary: 'the frozen policy a run acts under, verified against its hash', usage: 'orbit policy show <run-id> [--json]', run: policyShowCommand },
];

/** Commands Orbit runs on itself; they take their arguments verbatim and are not in the help text. */
const HIDDEN = ['shim', 'hook', 'check-runner'] as const;

export function helpText(): string {
  const pad = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
  return [
    `orbit ${ORBIT_VERSION}: an autonomous, evidence-driven engineering loop for Claude Code`,
    '',
    'Usage: orbit <command> [options]',
    '',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(pad)}${c.summary}`),
    '',
    'Every command accepts --repo <dir>, --json and --help. Run "orbit <command> --help" for a command\'s options.',
    'Exit codes: "orbit help exit-codes".',
    '',
  ].join('\n');
}

/** What "orbit help help" prints: help is not in COMMANDS, so it describes itself here. */
function helpOfHelp(): string {
  return [
    'Usage: orbit help [<command> | <group> | exit-codes]',
    '',
    '  orbit help              the commands',
    '  orbit help <command>    one command\'s usage and options (the same as "orbit <command> --help")',
    '  orbit help <group>      the subcommands of a group, such as "orbit help models"',
    '  orbit help exit-codes   what each exit status means',
    '',
  ].join('\n');
}

export function commandHelp(def: CommandDef): string {
  const opts = { ...GLOBAL_OPTIONS, ...(def.options ?? {}) };
  const rows = Object.entries(opts).map(([name, d]) => {
    const flag = `${d.short ? `-${d.short}, ` : '    '}--${name}${d.type === 'string' ? ` <${d.valueName ?? 'value'}>` : ''}`;
    return `  ${flag.padEnd(30)}${d.description}`;
  });
  return [`${def.summary}`, '', `Usage: ${def.usage}`, '', 'Options:', ...rows, ''].join('\n');
}

export function exitCodesText(): string {
  return ['Exit codes:', ...EXIT_CODE_DOCS.map((e) => `  ${String(e.code).padStart(2)}  ${e.name.padEnd(19)}${e.meaning}`), '', '"orbit hook pre-tool-use" is the exception: it follows Claude Code\'s hook protocol and exits 0 (allow, or a deny decision on stdout) or 2 (block).', ''].join('\n');
}

/** The subcommand groups ("models", "learn", ...) and their commands. */
function groupOf(word: string): CommandDef[] {
  return COMMANDS.filter((c) => c.name.startsWith(`${word} `));
}

export function groupHelp(group: string): string {
  const members = groupOf(group);
  const pad = Math.max(...members.map((c) => c.name.length)) + 8;
  return [
    `orbit ${group}: ${members.length} subcommands`,
    '',
    `Usage: orbit ${group} <subcommand> [options]`,
    '',
    'Subcommands:',
    ...members.map((c) => `  ${`orbit ${c.name}`.padEnd(pad)}${c.summary}`),
    '',
    `Run "orbit ${group} <subcommand> --help" for a subcommand's options.`,
    '',
  ].join('\n');
}

/** The error for words that name no command, with a suggestion when one is close and the choices when it is not. */
function unknownCommand(words: readonly string[]): UsageError {
  const [first = '', second] = words;
  const known = [...new Set(COMMANDS.map((c) => c.name.split(' ')[0]!))];
  const members = groupOf(first);
  if (members.length > 0) {
    const subs = members.map((c) => c.name.slice(first.length + 1));
    if (second === undefined || second.startsWith('-')) return new UsageError(`"orbit ${first}" needs a subcommand: ${subs.join(', ')}`);
    const near = closest(second, subs);
    return new UsageError(`unknown subcommand "${second}" for "orbit ${first}"; ${near ? `did you mean "${first} ${near}"? ` : ''}subcommands: ${subs.join(', ')}`);
  }
  const near = closest(first, [...known, 'help', 'version']);
  return new UsageError(`unknown command "${first}"; ${near ? `did you mean "${near}"? ` : ''}commands: ${known.join(', ')}`);
}

/**
 * Commands that only read. A worker process (its environment carries the
 * policy variables set by adapters/env.ts, and the plugin's ORBIT_WORKER
 * marker) may run these; everything else is refused, because a model that
 * could run `orbit decide`, `resume --force` or `learn eval` from its shell
 * would be authorizing its own decisions.
 */
const WORKER_SAFE = new Set(['status', 'timeline', 'logs', 'report', 'questions', 'policy show', 'models list', 'learn list', 'learn show', 'stats']);

function inWorker(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.ORBIT_WORKER === '1' || Boolean(env.ORBIT_POLICY_HASH) || Boolean(env.ORBIT_POLICY_PATH);
}

function findCommand(argv: readonly string[]): { def: CommandDef; rest: string[] } | null {
  const [a, b] = argv;
  if (a === undefined) return null;
  const two = b !== undefined && !b.startsWith('-') ? COMMANDS.find((c) => c.name === `${a} ${b}`) : undefined;
  if (two) return { def: two, rest: argv.slice(2) as string[] };
  const one = COMMANDS.find((c) => c.name === a);
  return one ? { def: one, rest: argv.slice(1) as string[] } : null;
}

export async function main(argv: readonly string[], overrides: Partial<CliContext> = {}): Promise<number> {
  const ctx = createContext(overrides);
  // Messages name commands in the form that works for how this process was started (bin/orbit marks the plugin).
  setInvocationEnv(ctx.env);
  // An installed service starts a stable launcher; keep it pointing at this bundle, which changes on every plugin update.
  if (!inWorker(ctx.env)) refreshServiceLauncher(ctx);
  const [first] = argv;
  try {
    if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
      if (first === 'help' && argv[1] === 'exit-codes') ctx.io.out(exitCodesText());
      else if (first === 'help' && argv[1] === 'help' && argv[2] === undefined) ctx.io.out(helpOfHelp());
      else if (first === 'help' && argv[1]) {
        const found = findCommand(argv.slice(1));
        if (found) ctx.io.out(commandHelp(found.def));
        else if (argv[2] === undefined && groupOf(argv[1]).length > 0) ctx.io.out(groupHelp(argv[1]));
        else throw unknownCommand(argv.slice(1));
      } else ctx.io.out(helpText());
      return first === undefined ? EXIT.USAGE : EXIT.OK;
    }
    if (first === '--version' || first === '-V' || first === '-v' || first === 'version') {
      ctx.io.out(`${ORBIT_VERSION}\n`);
      return EXIT.OK;
    }
    // Hidden internals take their arguments verbatim (they carry "--" and provider argv that parseArgs must not see).
    if (first === 'shim') return await shimCommand(argv.slice(1));
    if (first === 'check-runner') return await checkRunnerCommand(argv.slice(1), ctx);
    if (first === 'hook') {
      // main.ts handles this before anything else loads; this path serves in-process callers.
      const { hookMain } = await import('./hook.ts');
      await hookMain(argv.slice(1));
      return Number(process.exitCode ?? EXIT.USAGE);
    }

    const found = findCommand(argv);
    if (!found) {
      // "orbit models --help" and "orbit models -h" describe the group.
      if (groupOf(first).length > 0 && argv.slice(1).some((a) => a === '--help' || a === '-h')) {
        ctx.io.out(groupHelp(first));
        return EXIT.OK;
      }
      throw unknownCommand(argv);
    }
    if (inWorker(ctx.env) && !WORKER_SAFE.has(found.def.name)) {
      throw new OrbitError('POLICY_DENIED', `"orbit ${found.def.name}" is refused inside a worker: workers cannot decide, resume, cancel or otherwise change runs`);
    }
    const args = parseCommand(found.rest, found.def.options, found.def.usage);
    if (args.bool('help')) {
      ctx.io.out(commandHelp(found.def));
      return EXIT.OK;
    }
    return await found.def.run(args, ctx);
  } catch (err) {
    return report(ctx, argv, err);
  }
}

function report(ctx: CliContext, argv: readonly string[], err: unknown): number {
  const code = exitCodeFor(err);
  const wantJson = argv.includes('--json');
  if (err instanceof UsageError) {
    if (wantJson) ctx.io.err(`${JSON.stringify({ error: { code: 'USAGE', message: err.message } })}\n`);
    else {
      ctx.io.err(`orbit: ${err.message}\n`);
      if (err.usage) ctx.io.err(`usage: ${err.usage}\n`);
      ctx.io.err('run "orbit help" for the commands\n');
    }
    return code;
  }
  const message = err instanceof Error ? err.message : String(err);
  const orbitCode = isOrbitError(err) ? err.code : 'INTERNAL';
  if (wantJson) ctx.io.err(`${JSON.stringify({ error: { code: orbitCode, message } })}\n`);
  else {
    ctx.io.err(`orbit: ${message}\n`);
    const problems = isOrbitError(err) && Array.isArray(err.details?.problems) ? (err.details.problems as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    // Most errors already list their problems in the message; print only the ones it does not.
    for (const p of problems.filter((x) => !message.includes(x)).slice(0, 20)) ctx.io.err(`  - ${p}\n`);
    if (orbitCode === 'INTERNAL' && !isOrbitError(err) && err instanceof Error && ctx.env.ORBIT_DEBUG) ctx.io.err(`${err.stack ?? ''}\n`);
  }
  return code;
}

export { HIDDEN as HIDDEN_COMMANDS };
