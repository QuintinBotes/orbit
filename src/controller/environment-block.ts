/**
 * An environment failure is not repaired (spec section 14: diagnose, do not blindly retry). When a mandatory check
 * fails on a candidate exactly as it failed on the base revision and its output shows the sandbox or the host
 * refusing an operation (evidence/environment-failure.ts), the verification step ends the run BLOCKED instead of
 * entering the repair loop: no change to the code can fix it, and each attempt would only rebuild the same tree.
 *
 * So does a mandatory check that could not execute at all: the UI application or a check's process was killed by a
 * crash signal before it printed anything, or the runner could not start the check. Nothing of the repository ran,
 * so there is no failure for a repair to address, and the run would only come back to the same tree. The same holds
 * for a check the sandbox or the operating system refused a filesystem operation outside its checkout before it
 * compiled or tested anything (issue #10, evidence/environment-failure.ts classifyCouldNotRun).
 *
 * PREFLIGHT applies the same judgement to the base revision (baselineEnvironmentFailures): a check that could not run
 * there is not a pre-existing failure, so the run blocks before any attempt and no baseline exception is offered. It
 * blocks the same way on a misconfigured check (baselineMisconfiguredChecks, issue #23): one whose tool rejected the
 * command line the policy gives it. A check whose command names something that does not exist yet (a missing target)
 * is left to CONTRACTING, which expects it to flip when the contract names it and blocks on it as misconfigured when the
 * contract does not (steps/baseline-questions.ts). Only a failure of the repository's code is a pre-existing failure
 * (docs/decisions/0010-base-failure-classification.md).
 *
 * Every reason here is a run of sentences, each starting with a capital letter, and names each check once: checks that
 * share a cause and its evidence lines are listed together before them.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readJsonIfExists } from '../core/fsx.ts';
import { BASELINE_FILE, type BaselineReport } from '../evidence/baseline.ts';
import { directInvocation } from '../evidence/check-command.ts';
import { classifyMisconfigured, classifyProgramNotFound, type MisconfiguredCheck } from '../evidence/check-misconfigured.ts';
import { dotnetFormatFix, FORMAT_OUTSIDE_REASON, formatLoadsProject, formatOutsideFix, nodeDenialFix, sdkFormatsInProcess } from '../evidence/dotnet-format.ts';
import { classifyCouldNotRun, classifyEnvironmentFailure, classifyNotExecuted, type EnvironmentFailure, type EnvironmentSignal } from '../evidence/environment-failure.ts';
import type { JudgedCheck } from '../evidence/msbuild.ts';
import { listCheckRuns, type CandidateRecord, type CheckRunRecord } from '../evidence/store.ts';
import type { EvidenceReport } from '../evidence/types.ts';
import { baselineQuestionId } from '../inquisition/baseline-exception.ts';
import { UI_RESULT_FILE } from '../ui/runner.ts';
import type { UiNotExecuted } from '../ui/types.ts';
import { folderFormRunsAt, runWorktreeRoot, type RunContext } from './context.ts';
import { uiEvidenceDir } from './verification.ts';

/** Output read from a check's log at most, so a runaway log stays cheap. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;

/** A check's command as the policy defines it: an argv, or one shell script when `shell` is set. */
export interface CheckCommand {
  argv: readonly string[];
  shell: boolean;
}

/** An environment failure, with the check's command when it is known, so that a fix can fit the tool it runs. */
export type FailureWithCommand = EnvironmentFailure & {
  command?: CheckCommand;
  /**
   * False where dotnet format whitespace --folder cannot list the folders above the check's checkout (macOS, a run's
   * checkout in the Orbit home, which the check profile read-denies; evidence/dotnet-format.ts): no form of dotnet format
   * that SDK 9 and later run works there, so its fix is to run it outside Orbit. Absent: it can.
   */
  folderForm?: boolean;
  /**
   * For a check the runner stopped for a refused MSBuild worker node: the fix for its command, as the runner named it at
   * the end of its log (stoppedNodeFix), so the reason carries it whole where the quoted note is cut.
   */
  nodeFix?: string;
};

export type BlockedCheck = FailureWithCommand & {
  /** The baseline-exception question PREFLIGHT raised for this check's pre-existing failure; null for a check that could not execute (there is no failure to except). */
  questionId: string | null;
  /** The log that shows the cause, when there is one. */
  logPath?: string;
};

/** A mandatory check whose tool rejected its command, or found nothing where it points, on the base revision (evidence/check-misconfigured.ts), with its log. */
export type MisconfiguredBlock = MisconfiguredCheck & {
  /** The log that shows it, when there is one. */
  logPath?: string;
};

function outputOf(row: CheckRunRecord): string {
  if (row.logPath) {
    try {
      return readFileSync(row.logPath, 'utf8').slice(0, MAX_LOG_BYTES);
    } catch {
      /* the log is gone: the excerpt is what is left of it */
    }
  }
  return row.excerpt ?? '';
}

/**
 * The failing checks of `report` that fail on the candidate as on the base revision and for an environment cause,
 * leaving out any the contract already accepts as a baseline exception (that failure is excused, not blocking).
 */
export function environmentFailuresFor(ctx: RunContext, cand: CandidateRecord, report: EvidenceReport): BlockedCheck[] {
  const baseline = readJsonIfExists<BaselineReport>(join(ctx.runDir, BASELINE_FILE));
  // A baseline of another revision (the base moved) says nothing about this candidate's base.
  if (!baseline || baseline.baseRevision !== ctx.run.baseRevision) return [];
  const accepted = new Map((ctx.contract?.baseline_exceptions ?? []).map((e) => [e.check_id, e.fingerprint]));
  const checkout = join(runWorktreeRoot(ctx), `check-${cand.seq}`);
  const out: BlockedCheck[] = [];
  for (const base of baseline.failures) {
    const result = report.checks.find((c) => c.id === base.checkId);
    if (!result || (result.status !== 'FAILED' && result.status !== 'TIMEOUT')) continue;
    const row = listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: cand.id, checkId: base.checkId, rootsOnly: true }).at(-1);
    if (!row || row.fingerprint === null || accepted.get(base.checkId) === row.fingerprint) continue;
    const found = classifyEnvironmentFailure({
      checkId: base.checkId,
      fingerprint: row.fingerprint,
      baselineFingerprint: base.fingerprint,
      output: outputOf(row),
      // The checkout (the check's cwd is resolved, the checkout path may not be) and the evidence directory holding its scratch HOME.
      insideRoots: [checkout, row.cwd, ...(row.logPath ? [dirname(row.logPath)] : [])],
    });
    if (found) out.push({ ...found, ...commandOf(ctx, base.checkId), folderForm: folderFormRunsAt(ctx, checkout), questionId: baselineQuestionId(ctx.run.id, base.checkId, row.fingerprint) });
  }
  return out;
}

/**
 * The outcome reason: which check, what environment cause, that no repair was spent, and the ways forward. The
 * policy (so the check definition) and the recorded check results of a run are frozen, so a repaired environment or a
 * corrected definition applies to a new run. For a check that failed like the base revision the baseline exception is
 * the existing PREFLIGHT question, and an approved one is honoured when this run resumes; a check that could not
 * execute has no failure to except, so only the first way forward applies to it.
 */
export function environmentBlockReason(input: { runId: string; candidateSeq: number; failures: readonly BlockedCheck[] }): string {
  const { runId, candidateSeq, failures } = input;
  const sameAsBase = failures.filter((f) => f.fingerprint !== null);
  const notExecuted = failures.filter((f) => f.fingerprint === null);
  const sentences: string[] = [];
  if (sameAsBase.length > 0) {
    // The first evidence line of each, without the log: the failure is the base revision's, which PREFLIGHT recorded.
    const causes = evidenceOf(sameAsBase.map((f) => ({ checkId: f.checkId, cause: f.cause, lines: f.lines.slice(0, 1) })));
    sentences.push(`${named(sameAsBase)} ${sameAsBase.length > 1 ? 'fail' : 'fails'} on candidate ${candidateSeq} exactly as on the base revision, and the output shows an environment cause, not a defect in the change: ${causes}`);
  }
  if (notExecuted.length > 0) {
    sentences.push(`${named(notExecuted)} could not execute on candidate ${candidateSeq}, and the output shows an environment cause, not a defect in the change: ${evidenceOf(notExecuted)}`);
  }
  sentences.push('No repair attempt was spent, because changing the code cannot fix it');
  const answers = failures.filter((f) => f.questionId !== null).map((f) => `orbit decide ${runId} ${f.questionId} Approve`);
  const frozen = "this run's policy and recorded check results are frozen";
  if (answers.length > 0) {
    sentences.push(`Two ways forward: fix the environment or the check definition and start a new run (${frozen}), or approve a baseline exception for the pre-existing failure with ${answers.join(' and ')}, then orbit resume ${runId}`);
  } else {
    sentences.push(`Way forward: fix the environment (orbit doctor checks the isolation provider and its limits) or the check definition and start a new run (${frozen}); there is no baseline exception to approve, because the check never ran`);
  }
  const fix = environmentFix(notExecuted);
  if (fix) sentences.push(`Fix: ${fix}`);
  return joinSentences(sentences);
}

/** "Check x" or "Checks x, y", to start a sentence. */
function named(items: readonly { checkId: string }[]): string {
  return `${items.length > 1 ? 'Checks' : 'Check'} ${items.map((f) => f.checkId).join(', ')}`;
}

/** Sentences joined into one reason, each ending with a period. */
function joinSentences(sentences: readonly string[]): string {
  return `${sentences.join('. ')}.`;
}

interface Evidence {
  checkId: string;
  cause: string;
  lines: readonly string[];
  logPath?: string;
  configKey?: string;
}

/**
 * The evidence of the checks a sentence has named: each distinct cause with its evidence lines once, after the checks
 * that share it when there is more than one such group, then their config keys and their logs.
 */
function evidenceOf(items: readonly Evidence[]): string {
  const groups: { ids: string[]; cause: string; lines: readonly string[]; keys: string[]; logs: string[] }[] = [];
  for (const it of items) {
    let g = groups.find((x) => x.cause === it.cause && x.lines.length === it.lines.length && x.lines.every((l, i) => l === it.lines[i]));
    if (g === undefined) {
      g = { ids: [], cause: it.cause, lines: it.lines, keys: [], logs: [] };
      groups.push(g);
    }
    g.ids.push(it.checkId);
    if (it.configKey !== undefined) g.keys.push(it.configKey);
    if (it.logPath !== undefined) g.logs.push(it.logPath);
  }
  return groups
    .map((g) => {
      const who = groups.length > 1 ? `${g.ids.join(', ')}: ` : '';
      const lines = g.lines.length > 0 ? ` (${quoted(g.lines)})` : '';
      const keys = g.keys.length > 0 ? `, ${g.keys.length > 1 ? 'commands' : 'command'} in ${g.keys.join(', ')}` : '';
      const logs = g.logs.length > 0 ? `, output in ${g.logs.join(', ')}` : '';
      return `${who}${g.cause}${lines}${keys}${logs}`;
    })
    .join('; ');
}

/** Whether the check's own command runs dotnet format (evidence/check-command.ts), which takes no MSBuild switches. */
function runsDotnetFormat(f: FailureWithCommand): boolean {
  const inv = f.command ? directInvocation(f.command.argv, f.command.shell) : null;
  if (inv === null) return false;
  return inv.tool === 'dotnet-format' || (inv.tool === 'dotnet' && inv.args.find((a) => !a.startsWith('-')) === 'format');
}

/** What a .NET runtime refused prints: its shared-memory directory, the runtime itself, or the NuGet step that asked. */
const DOTNET_DENIAL = /\/tmp\/\.dotnet\b|\.coreclr\.|NuGet-Migrations|System\.Threading\.(?:Mutex|Semaphore)/i;

/** NuGet's restore in a line of the check's output: its error code, or .NET's HttpClient's report of the proxy's 403. */
const NUGET_LINE = /\berror NU\d{4}\b|\bNuGet\b|proxy tunnel request to proxy '[^']*' failed with status code '403'/;

/** The fix for a NuGet restore that cannot download on macOS, named by doctor's checks.dotnet-packages. */
const NUGET_FILL =
  'since nuget.org\'s certificate cannot be verified inside the sandbox on macOS (srt keeps the system trust service out of reach), fill the repository\'s NuGet cache outside the sandbox with the command orbit doctor prints (checks.dotnet-packages), which the checks that restore read, and the dependency install too when dependencies.install_command restores packages (docs/troubleshooting.md, ".NET HTTP clients and NuGet restore on macOS")';

/** The runner's note on a check it stopped for an MSBuild worker node the sandbox refused (evidence/runner.ts). */
const MSBUILD_NODE_DENIAL = /^the check sandbox denied MSBuild node /;

/** The check's own definition as the .NET fixes read it (evidence/dotnet-format.ts), when the frozen policy shows it. */
function definitionOf(f: FailureWithCommand): (JudgedCheck & { id: string }) | null {
  return f.command ? { id: f.checkId, command: [...f.command.argv], shell: f.command.shell } : null;
}

/**
 * The fix for a dotnet format check whose build host the sandbox refused its named pipe: the form that loads no project,
 * as the check's command with it in place of the dotnet format that loads one when the definition shows it (the folder of
 * the solution or project it names, its --include and --exclude kept, as doctor names it: evidence/dotnet-format.ts), else
 * that form said in words. A format whose build host failed ran SDK 9 or later: SDK 8 loads the project in its own process.
 */
function formatFix(f: FailureWithCommand): string {
  const def = definitionOf(f);
  return def !== null && formatLoadsProject(def) !== null ? dotnetFormatFix(def) : `in checks.${f.checkId}.command, dotnet format whitespace --folder --verify-no-changes in place of its dotnet format, in the folder of the solution or project it formats and with its --include and --exclude`;
}

/**
 * How to fix a check the sandbox or the operating system refused (issue #10): the .NET cases by name, any other denial
 * through `orbit doctor`, which starts each check's executable in the sandbox, a refused connection through the check's
 * network_hosts or the dependency install, and a program that is not installed where the check runs. Null for a crash or
 * a check that could not be started, whose way forward is already said.
 *
 * A .NET named pipe the sandbox refused under /tmp (ADR 0009, addendum) has three fixes: an MSBuild worker node seen in
 * `dotnet test`'s own crash (MSB1025, socket-denied) is pinned with -m:1 on the check's command; one the runner stopped
 * the check for (pipe-denied) has the exact fix for the check's command at the end of its log, where the runner wrote it
 * knowing the SDK the checkout pins; dotnet format's build host (pipe-denied, or socket-denied in a dotnet format check)
 * takes the form that loads no project.
 */
export function environmentFix(failures: readonly FailureWithCommand[], platform: NodeJS.Platform = process.platform): string | null {
  const fixes: string[] = [];
  const has = (signal: EnvironmentSignal): FailureWithCommand[] => failures.filter((f) => f.signals.includes(signal));
  // A refused pipe can also leave a Seatbelt line for its fixed path under /tmp, which the tool's TMPDIR does not move.
  const refusedFs = failures.filter((f) => !f.signals.includes('pipe-denied') && (f.signals.includes('filesystem-denied') || f.signals.includes('permission-denied') || f.signals.includes('sandbox-violation')));
  // dotnet format whitespace --folder refused a listing of a folder above the checkout (macOS, a run's checkout in the
  // Orbit home): no form of dotnet format runs there, whatever doctor's probe of the dotnet executable says.
  const outsideFs = refusedFs.filter((f) => f.folderForm === false && runsDotnetFormat(f));
  const denied = refusedFs.filter((f) => !outsideFs.includes(f));
  if (denied.some((f) => f.lines.some((l) => DOTNET_DENIAL.test(l)))) {
    fixes.push('this is the .NET runtime asking for /tmp/.dotnet, a directory it shares between processes for named mutexes and which no check sandbox may write. Orbit prepares every check for the .NET SDK\'s first run so the SDK itself needs none (docs/troubleshooting.md, ".NET checks under the sandbox"); upgrade Orbit if this run predates that, and if the repository\'s own code creates a named Mutex or Semaphore, make it use an unnamed one or a file lock in TMPDIR');
  } else if (denied.length > 0) {
    fixes.push('run orbit doctor, which starts each check\'s executable in the sandbox and shows what it is refused, then let the tool keep its files in the check\'s HOME or TMPDIR (through the check\'s env) or change the check definition (docs/troubleshooting.md, "A check cannot run in the sandbox")');
  }
  const sockets = has('socket-denied');
  const pipes = has('pipe-denied');
  const msbuild = sockets.filter((f) => !runsDotnetFormat(f));
  const stopped = pipes.filter((f) => f.lines.some((l) => MSBUILD_NODE_DENIAL.test(l)));
  const format = [...sockets.filter(runsDotnetFormat), ...pipes.filter((f) => f.lines.some((l) => !MSBUILD_NODE_DENIAL.test(l))), ...outsideFs];
  // With more than one kind, each fix names the checks it is for; the dotnet format fix always does.
  const kinds = [msbuild, stopped, format].filter((g) => g.length > 0).length;
  const forChecks = (group: readonly EnvironmentFailure[]): string => (kinds > 1 ? `for ${group.length > 1 ? 'checks' : 'check'} ${group.map((f) => f.checkId).join(', ')}: ` : '');
  // MSBuild's worker nodes each bind a named pipe, a Unix socket under /tmp the check sandbox refuses; on one node it
  // starts none. Verified under Orbit's runner and srt on macOS: the dotnet test that failed with MSB1025 after five
  // minutes passes with -m:1 (ADR 0010; ADR 0009, addendum).
  if (msbuild.length > 0) fixes.push(`${forChecks(msbuild)}this is MSBuild starting a worker node, whose named pipe .NET makes a Unix socket under /tmp, and the check sandbox does not let a check create one: build on one MSBuild node, with -m:1 on the check's dotnet command (for example [dotnet, test, -m:1]), which orbit doctor prints for the check's own command (docs/troubleshooting.md, ".NET builds and MSBuild worker nodes")`);
  // The runner's exact fix for each, when the policy shows the command: the quoted note is cut before it (review of #10).
  if (stopped.length > 0) {
    const exact = stopped.every((f) => f.nodeFix !== undefined) ? [...new Set(stopped.map((f) => f.nodeFix!))] : null;
    fixes.push(`${forChecks(stopped)}the sandbox refuses MSBuild worker nodes their named pipe under /tmp: ${exact ? exact.join('; ') : 'the check\'s log ends with the fix for its command (docs/troubleshooting.md, ".NET builds and MSBuild worker nodes")'}`);
  }
  // dotnet format reads -m:1 as the project to format and fails, and every form of it but whitespace --folder loads the
  // project through a build host whose pipe the sandbox refuses (measured under Orbit's runner and srt: SDK 9 on macOS,
  // SDK 10 on Linux).
  // Where the folder form cannot list the folders above the checkout either (macOS, a run's checkout in the Orbit home),
  // no form runs in the check sandbox (review of #10: the folder form died on an UnauthorizedAccessException there).
  const outside = format.filter((f) => f.folderForm === false);
  const folder = format.filter((f) => f.folderForm !== false);
  if (folder.length > 0) {
    const ids = folder.map((f) => f.checkId);
    fixes.push(`dotnet format (${ids.length > 1 ? 'checks' : 'check'} ${ids.join(', ')}) takes no -m:1, which it reads as the project to format, and it loads the project through a build host whose named pipe .NET binds under /tmp, which no check sandbox may use: check whitespace with the form that loads no project, ${folder.map(formatFix).join('; ')}, and run the style and analyzer checks outside Orbit, in CI (docs/troubleshooting.md, "dotnet format under the sandbox")`);
  }
  if (outside.length > 0) {
    const ids = outside.map((f) => f.checkId);
    fixes.push(`dotnet format (${ids.length > 1 ? 'checks' : 'check'} ${ids.join(', ')}) cannot run in this check sandbox: ${outside.map((f) => formatOutsideFix({ id: f.checkId })).join('; ')} ${FORMAT_OUTSIDE_REASON}`);
  }
  // On macOS a NuGet restore refused its host reaches nothing better with the host allowed: .NET cannot verify a
  // certificate in the sandbox there, so its fix is the cache filled outside it (review of #10).
  const network = has('network-denied');
  const nugetOnMac = platform === 'darwin' ? network.filter((f) => f.lines.some((l) => NUGET_LINE.test(l))) : [];
  if (network.length > nugetOnMac.length) {
    fixes.push('the check reached for a host its policy does not let it reach, and the sandbox\'s network proxy refused it: add the host to the check\'s network_hosts (it must also be covered by network.allowed_hosts), or let the check work offline, with its dependencies restored by the dependency install (dependencies.install_command)');
  }
  if (has('nuget-http-denied').length > 0) {
    fixes.push(`NuGet's HTTP client could not start because it may not read the machine's NIS domain name: Orbit adds the one rule that allows it only with the srt it ships, and the check's record says when it was not added, so run with that srt; and ${NUGET_FILL}`);
  } else if (nugetOnMac.length > 0 || has('nuget-tls-denied').length > 0) {
    fixes.push(`NuGet's restore could not download its packages in the sandbox: ${NUGET_FILL}`);
  }
  const missing = has('program-not-found');
  if (missing.length > 0) {
    const keys = missing.map((f) => `checks.${f.checkId}.command`).join(', ');
    fixes.push(`install the program where the check runs, or give the check a PATH that holds it (through its env); if the name is misspelled, correct ${keys} in .orbit/config.yaml, which needs a new run because this run's policy is frozen (orbit doctor names a check whose executable is missing)`);
  }
  return fixes.length > 0 ? fixes.join('; and ') : null;
}

/**
 * The fix for a check the runner stopped for a refused MSBuild worker node, as the runner named it in the note that
 * ends its log (evidence/runner.ts denialNote): from the frozen policy's command, the global.json of the check's
 * checkout and whether dotnet format's folder form can run there. Recomputed, not read from the log, whose last line a
 * check that prints past the 4 MB the reader takes could write. Nothing for a check the policy does not define, or for
 * a failure that is not such a stop.
 */
function stoppedNodeFix(ctx: RunContext, found: EnvironmentFailure, checkout: string, folderForm: boolean): { nodeFix?: string } {
  const def = ctx.snapshot.config.checks[found.checkId];
  if (!def || def.kind !== 'command' || !found.signals.includes('pipe-denied') || !found.lines.some((l) => MSBUILD_NODE_DENIAL.test(l))) return {};
  const check = { id: found.checkId, command: def.command, shell: def.shell === true, ...(def.env ? { env: def.env } : {}) };
  return { nodeFix: nodeDenialFix(check, null, sdkFormatsInProcess(resolve(checkout, def.cwd), checkout), folderForm) };
}

/** The command the run's frozen policy gives a command check, so that a fix can fit the tool it runs. */
function commandOf(ctx: RunContext, checkId: string): { command?: CheckCommand } {
  const def = ctx.snapshot.config.checks[checkId];
  return def && def.kind === 'command' ? { command: { argv: def.command, shell: def.shell === true } } : {};
}

/** What a baseline check printed: the log of its recorded run, else the report's log, else the failure's excerpt. */
function baselineOutput(ctx: RunContext, report: BaselineReport, failure: BaselineReport['failures'][number]): { output: string; logPath: string | null; row: CheckRunRecord | undefined } {
  const row = listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: null, checkId: failure.checkId, rootsOnly: true }).at(-1);
  const logPath = row?.logPath ?? report.checks.find((c) => c.checkId === failure.checkId)?.log ?? null;
  return { output: (logPath ? readCapped(logPath) : null) ?? failure.excerpt ?? '', logPath, row };
}

/**
 * The mandatory checks that failed on the base revision because they could not run there (issue #10): the process was
 * killed by a crash signal before it printed anything, the sandbox or the operating system refused it a filesystem
 * operation outside its checkout, a socket in the tool's own startup or a network connection, with no compile error or
 * failing test in its output (evidence/environment-failure.ts), or the program its command runs is not installed where
 * it runs (exit 127, evidence/check-misconfigured.ts classifyProgramNotFound). Such a check never got as far as the
 * repository's code, so it is not a pre-existing failure: no baseline exception may be offered for it, since approving
 * one would let a run pass with a check that never ran.
 */
export function baselineEnvironmentFailures(ctx: RunContext, report: BaselineReport, checkoutDir: string): BlockedCheck[] {
  const out: BlockedCheck[] = [];
  for (const failure of report.failures) {
    const { output, logPath, row } = baselineOutput(ctx, report, failure);
    const insideRoots = [checkoutDir, ...(row ? [row.cwd] : []), ...(logPath ? [dirname(logPath)] : [])];
    const def = ctx.snapshot.config.checks[failure.checkId];
    const exitCode = row ? row.exitCode : (report.checks.find((c) => c.checkId === failure.checkId)?.exitCode ?? null);
    const found =
      classifyNotExecuted({ checkId: failure.checkId, output }) ??
      classifyCouldNotRun({ checkId: failure.checkId, output, insideRoots }) ??
      (def && def.kind === 'command' ? classifyProgramNotFound({ checkId: failure.checkId, command: def.command, shell: def.shell, exitCode, output }) : null);
    if (!found) continue;
    const folderForm = folderFormRunsAt(ctx, checkoutDir);
    out.push({ ...found, ...commandOf(ctx, failure.checkId), folderForm, ...stoppedNodeFix(ctx, found, checkoutDir, folderForm), questionId: null, ...(logPath ? { logPath } : {}) });
  }
  return out;
}

/**
 * The mandatory checks that failed on the base revision with a usage error from their own direct invocation of a tool
 * (issue #23, evidence/check-misconfigured.ts): an argument error (kind `argument`, a misconfigured check) or a missing
 * target (kind `missing-target`, something the command names that does not exist on the base revision). Judged against
 * the command in the run's frozen policy. Neither is a pre-existing failure, and no baseline exception is ever applied to
 * either.
 */
export function baselineMisconfiguredChecks(ctx: RunContext, report: BaselineReport): MisconfiguredBlock[] {
  const out: MisconfiguredBlock[] = [];
  for (const failure of report.failures) {
    const def = ctx.snapshot.config.checks[failure.checkId];
    if (!def || def.kind !== 'command') continue;
    const { output, logPath, row } = baselineOutput(ctx, report, failure);
    const exitCode = row ? row.exitCode : (report.checks.find((c) => c.checkId === failure.checkId)?.exitCode ?? null);
    const found = classifyMisconfigured({ checkId: failure.checkId, command: def.command, shell: def.shell, exitCode, output });
    if (found) out.push({ ...found, ...(logPath ? { logPath } : {}) });
  }
  return out;
}

/**
 * A check whose command is wrong, as decisions and outcomes record it: an argument error is a misconfigured check, a
 * missing target is one only once the contract does not expect it to flip (CONTRACTING records it so).
 */
export function misconfiguredRecord(m: MisconfiguredBlock, classification: 'misconfigured' | 'missing-target' = m.kind === 'argument' ? 'misconfigured' : 'missing-target'): Record<string, unknown> {
  return { check_id: m.checkId, classification, kind: m.kind, signature: m.signature, tool: m.tool, cause: m.cause, evidence_lines: m.lines, config_key: m.configKey, ...(m.logPath ? { log_path: m.logPath } : {}) };
}

/** A check's evidence lines, quoted, for an outcome reason. */
function quoted(lines: readonly string[]): string {
  return lines.map((l) => JSON.stringify(l)).join(', ');
}

const ENVIRONMENT_FALLBACK_FIX = 'let the check run in this environment (orbit doctor checks the isolation provider and starts each check\'s executable in the sandbox), or change the check definition';

/**
 * A check a baseline amendment ran (docs/decisions/0012-contract-checks-and-judged-trees.md): the contract requires it, and
 * PREFLIGHT, which runs the checks the policy marks mandatory, had not run it.
 */
export interface AmendedCheck {
  checkId: string;
  /** The criteria that cite it as evidence; empty when the contract only lists it among its required checks. */
  citedBy: readonly string[];
  /** Whether the policy marks it mandatory. */
  mandatory: boolean;
}

/** The sentence that says why a check that blocks was run on the base revision after PREFLIGHT: the contract requires it. */
export function amendmentSentence(checks: readonly AmendedCheck[]): string {
  const why = (c: AmendedCheck): string =>
    c.citedBy.length === 0 ? 'the contract lists it among its required checks' : `${c.citedBy.length > 1 ? 'criteria' : 'criterion'} ${c.citedBy.join(', ')} ${c.citedBy.length > 1 ? 'cite' : 'cites'} it as evidence`;
  const many = checks.length > 1;
  const optional = checks.every((c) => !c.mandatory) ? `, which the policy does not mark mandatory` : '';
  return `The contract requires ${many ? 'checks' : 'check'} ${checks.map((c) => `${c.checkId} (${why(c)})`).join(', ')}${optional}, so ${many ? 'they were' : 'it was'} run on the base revision before any change was judged (a baseline amendment)`;
}

/**
 * The outcome reason of a run blocked at PREFLIGHT because a check could not run on the base revision: which check, the
 * first error line, why no exception is offered, and the fix. A check a baseline amendment ran says why it ran there.
 */
export function baselineEnvironmentBlockReason(input: { runId: string; baseRevision: string; failures: readonly BlockedCheck[]; amended?: readonly AmendedCheck[] }): string {
  const { runId, failures } = input;
  const amended = (input.amended ?? []).filter((a) => failures.some((f) => f.checkId === a.checkId));
  return joinSentences([
    `${named(failures)} could not run on the base revision ${input.baseRevision.slice(0, 12)}, and the output shows an environment cause, not a pre-existing failure: ${evidenceOf(failures)}`,
    ...(amended.length > 0 ? [amendmentSentence(amended)] : []),
    `${failures.length > 1 ? 'They are' : 'It is'} not recorded as a pre-existing failure and no baseline exception is offered: the check never got as far as the repository's code, so accepting its failure would let a run pass with a check that never ran`,
    `Fix: ${environmentFix(failures) ?? ENVIRONMENT_FALLBACK_FIX}`,
    `Then orbit resume ${runId} runs the baseline again; a changed check definition needs a new run, because this run's policy is frozen`,
  ]);
}

/** The fix for a check whose command is wrong, the same at PREFLIGHT and at CONTRACTING: the command lives in the run's frozen policy. */
function commandFix(checks: readonly MisconfiguredBlock[]): string {
  const keys = checks.map((m) => m.configKey).join(', ');
  return `Fix: correct ${keys} in .orbit/config.yaml so that ${checks.length > 1 ? 'each runs' : 'it runs'} as written from the check's cwd in a clean checkout of the base revision, and start a new run`;
}

/**
 * The outcome reason of a run blocked at PREFLIGHT on its baseline: the misconfigured checks first (each with the tool's
 * error line and the config key that holds its command), then any that could not run, and why no exception is offered.
 * With nothing misconfigured it is the environment reason. A misconfigured check's command lives in the run's frozen
 * policy, so the reason starts with "Check X is misconfigured" and finishRun adds the frozen-policy advice
 * (steps/common.ts frozenPolicyCause).
 */
export function baselineBlockReason(input: { runId: string; baseRevision: string; environment: readonly BlockedCheck[]; misconfigured: readonly MisconfiguredBlock[]; amended?: readonly AmendedCheck[] }): string {
  const { environment, misconfigured } = input;
  if (misconfigured.length === 0) return baselineEnvironmentBlockReason({ runId: input.runId, baseRevision: input.baseRevision, failures: environment, ...(input.amended ? { amended: input.amended } : {}) });
  const amended = (input.amended ?? []).filter((a) => misconfigured.some((m) => m.checkId === a.checkId) || environment.some((f) => f.checkId === a.checkId));
  const sentences = [
    `${named(misconfigured)} ${misconfigured.length > 1 ? 'are' : 'is'} misconfigured, not a pre-existing failure: on the base revision ${input.baseRevision.slice(0, 12)} the tool rejected the command line the check runs before it ran anything of the repository: ${evidenceOf(misconfigured)}`,
    ...(amended.length > 0 ? [amendmentSentence(amended)] : []),
    `${misconfigured.length > 1 ? 'They are' : 'It is'} not recorded as a pre-existing failure and no baseline exception is offered: a check whose command is wrong never tested anything, so accepting its failure would let a run pass with a check that never ran`,
  ];
  if (environment.length > 0) {
    sentences.push(`${named(environment)} could not run on the base revision either, and the output shows an environment cause: ${evidenceOf(environment)}`);
    sentences.push(`Fix for ${environment.length > 1 ? 'them' : 'it'}: ${environmentFix(environment) ?? ENVIRONMENT_FALLBACK_FIX}`);
  }
  sentences.push(commandFix(misconfigured));
  return joinSentences(sentences);
}

/**
 * The outcome reason of a run blocked at CONTRACTING on a missing target (ADR 0010): a check whose command names
 * something the base revision does not have, which the contract does not name as the proof of any criterion, so the goal
 * is not expected to create it. It is a misconfigured check, so the reason starts as one (steps/common.ts frozenPolicyCause
 * reads the policy setting from it); what to do about it is `missingTargetAdvice`, which finishRun adds in place of the
 * generic frozen-policy advice.
 */
export function missingTargetBlockReason(input: { baseRevision: string; checks: readonly MisconfiguredBlock[] }): string {
  const { checks } = input;
  const many = checks.length > 1;
  return joinSentences([
    `${named(checks)} ${many ? 'are' : 'is'} misconfigured, not a pre-existing failure: on the base revision ${input.baseRevision.slice(0, 12)} ${many ? 'their commands name' : "the check's command names"} something that does not exist, and the contract does not name ${many ? 'them' : 'it'} as the proof of any criterion, so the goal is not expected to create it: ${evidenceOf(checks)}`,
    `${many ? 'They are' : 'It is'} not recorded as a pre-existing failure and no baseline exception is offered: a check whose target does not exist tests nothing, so accepting its failure would make a meaningless check green`,
  ]);
}

/**
 * What to do about a missing target the contract does not name, by cause, and why only a new run helps: CONTRACTING
 * reads the baseline PREFLIGHT recorded, so the same check blocks again however the target was supplied since, and a
 * forced resume reads the same baseline (it is not offered here). The generic frozen-policy advice tells a person to fix
 * the config, which is only one of the three causes, so this block gives its own.
 */
export function missingTargetAdvice(input: { runId: string; checks: readonly Pick<MisconfiguredBlock, 'configKey'>[] }): string {
  const { checks } = input;
  const many = checks.length > 1;
  const keys = checks.map((m) => m.configKey).join(', ');
  return joinSentences([
    `Fix, by cause: when the goal is meant to create what ${many ? 'a command' : 'the command'} names, say so in the goal of a new run, so that the contract names ${many ? 'each check' : 'the check'} as the proof of a criterion and expects it to flip; when a tool that is not installed or restored yet provides it (a cargo plugin, a dotnet local tool, a pytest plugin), install or restore it and then start a new run, because this run reads the baseline it recorded and does not look again; when ${many ? 'the commands are' : 'the command is'} wrong, correct ${keys} in .orbit/config.yaml and start a new run`,
    `Resuming this run would only block again, so cancel it (orbit cancel ${input.runId}) and start the new run with orbit run`,
  ]);
}

/** Check ids that must pass for this candidate: the contract's list plus every command check the policy marks mandatory. */
function mandatoryCommandChecks(ctx: RunContext): Set<string> {
  const ids = new Set(ctx.contract?.required_check_ids ?? []);
  for (const [id, def] of Object.entries(ctx.snapshot.config.checks)) if (def.mandatory && def.kind === 'command') ids.add(id);
  return ids;
}

function readCapped(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').slice(0, MAX_LOG_BYTES);
  } catch {
    return null;
  }
}

/** Whether `path` is below `dir`, spelled either as given or as the real path the UI runner records (macOS temp directories sit behind a symlink). */
function isInside(path: string, dir: string): boolean {
  const roots = [dir];
  try {
    roots.push(realpathSync(dir));
  } catch {
    /* the directory is gone: only the given spelling can match */
  }
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
}

/**
 * The mandatory checks of `report` that could not execute at all, for an environment cause: a command check whose
 * process was killed by a crash signal before it printed anything, or that the runner could not start, and the UI
 * run when the application (or a journey check's Playwright process) never got as far as running the repository's
 * code. A check that ran and failed, or an application that threw while loading, is not listed: its output is the
 * repository's own and a repair can address it. Needs no baseline: nothing of the repository ran.
 *
 * A command check the sandbox refused something before it compiled or tested anything is listed too (issue #10), but
 * the denials ADR 0010 added (EACCES, a socket, the network proxy, NuGet's HTTP client) and a .NET named pipe (ADR 0009,
 * addendum) only when the same check showed the same one on the base revision: otherwise the change brought it (a test
 * that opens a file it may not read, a package from a host the check may not reach, a second project under a check
 * without -m:1), and it goes to repair.
 */
export function checksNotExecutedFor(ctx: RunContext, cand: CandidateRecord, report: EvidenceReport): BlockedCheck[] {
  const out: BlockedCheck[] = [];
  const accepted = new Map((ctx.contract?.baseline_exceptions ?? []).map((e) => [e.check_id, e.fingerprint]));
  const mandatory = mandatoryCommandChecks(ctx);
  const baseline = readJsonIfExists<BaselineReport>(join(ctx.runDir, BASELINE_FILE));
  const baseFailures = baseline && baseline.baseRevision === ctx.run.baseRevision && Array.isArray(baseline.failures) ? baseline.failures : [];
  const baseSignals = (checkId: string): EnvironmentSignal[] => {
    const f = baseFailures.find((b) => b.checkId === checkId);
    return f?.classification === 'environment' ? (f.signals ?? []) : [];
  };
  const checkout = join(runWorktreeRoot(ctx), `check-${cand.seq}`);
  for (const result of report.checks) {
    if (!mandatory.has(result.id) || (result.status !== 'FAILED' && result.status !== 'ERROR')) continue;
    const row = listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: cand.id, checkId: result.id, rootsOnly: true }).at(-1);
    if (!row || (row.fingerprint !== null && accepted.get(result.id) === row.fingerprint)) continue;
    const output = outputOf(row);
    const startFailure = row.status === 'ERROR' ? /could not start the check:[^\n]*/.exec(output)?.[0] ?? null : null;
    const found =
      classifyNotExecuted({ checkId: result.id, output, startFailure }) ??
      // Refused a filesystem operation outside its checkout before it compiled or tested anything (issue #10).
      (row.status === 'FAILED' ? classifyCouldNotRun({ checkId: result.id, output, insideRoots: [checkout, row.cwd, ...(row.logPath ? [dirname(row.logPath)] : [])], baseSignals: baseSignals(result.id) }) : null);
    if (!found) continue;
    const folderForm = folderFormRunsAt(ctx, checkout);
    out.push({ ...found, ...commandOf(ctx, result.id), folderForm, ...stoppedNodeFix(ctx, found, checkout, folderForm), questionId: null, ...(row.logPath ? { logPath: row.logPath } : {}) });
  }

  if (report.ui.some((u) => u.status === 'ERROR')) {
    const dir = uiEvidenceDir(ctx.runDir, cand.seq);
    const uiIds = ctx.snapshot.config.ui?.journey_check_ids ?? [];
    for (const entry of uiNotExecuted(join(dir, UI_RESULT_FILE))) {
      const logPath = isAbsolute(entry.logPath) && isInside(entry.logPath, dir) ? entry.logPath : null;
      const checkId = entry.stage === 'journeys' && entry.checkId ? entry.checkId : uiIds.length > 0 ? uiIds.join(', ') : 'ui';
      const output = logPath === null ? null : readCapped(logPath);
      const browserIsolation = typeof entry.environment === 'string' ? entry.environment : null;
      const found = output === null ? null : classifyNotExecuted({ checkId, output, signal: entry.signal, browserIsolation });
      if (found && !out.some((o) => o.checkId === found.checkId)) out.push({ ...found, questionId: null, ...(logPath ? { logPath } : {}) });
    }
  }
  return out;
}

/** What the UI run recorded as never having got as far as running; empty for a result that is missing or unreadable. */
function uiNotExecuted(resultPath: string): UiNotExecuted[] {
  const text = readCapped(resultPath);
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text) as { notExecuted?: unknown };
    if (!Array.isArray(parsed.notExecuted)) return [];
    return parsed.notExecuted.filter(
      (e): e is UiNotExecuted =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as UiNotExecuted).logPath === 'string' &&
        ((e as UiNotExecuted).stage === 'application' || (e as UiNotExecuted).stage === 'journeys') &&
        ((e as UiNotExecuted).environment === undefined || typeof (e as UiNotExecuted).environment === 'string'),
    );
  } catch {
    return [];
  }
}
