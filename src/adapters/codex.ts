/**
 * Codex adapter, for independent review only (spec section 12;
 * codex-cli.md section 10). Codex never edits: the adapter refuses a task
 * that is not read-only, and runs
 *
 *   codex exec --sandbox read-only --ephemeral --ignore-user-config --json
 *     --output-schema <workerDir>/schema.json -o <workerDir>/last-message.json
 *     -m <model> [-c model_reasoning_effort="<e>"] -c web_search="disabled"
 *     --disable multi_agent -C <checkout> -          (prompt on stdin)
 *
 * Always -m: a user's configured default can be one the installed CLI cannot
 * use (it returned HTTP 400 in the verified probe). Never --full-auto or -a
 * (exec rejects both), never --yolo or any --dangerously-* flag. No
 * --skip-git-repo-check: the review checkout is a git worktree. The prompt is
 * the role prompt followed by the review packet, on stdin from a file, so
 * exec reads it to EOF and starts (an open stdin pipe would hang it).
 */
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { systemClock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { execCapture } from '../core/exec.ts';
import { atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { strictSchemaViolations } from '../contract/strict-schema.ts';
import type { IsolationProvider } from '../isolation/types.ts';
import { prepareWorkerTmpDir } from '../isolation/profiles.ts';
import { canonicalPath } from '../isolation/util.ts';
import { verifySnapshot } from '../policy/snapshot.ts';
import { parseCodexCatalog } from '../routing/registry.ts';
import { readOnlyProfile, snapshotFileHash } from './claude.ts';
import { CODEX_END_REASONS, classifyCodexTranscript, codexEvents, codexUsage, type CodexTaskResult } from './codex-events.ts';
import { defaultOrbitCommands } from './commands.ts';
import { buildWorkerEnv, passThrough } from './env.ts';
import { outputBudgetFor, outputBudgetInstruction } from './prompt.ts';
import { LAUNCH_FILE, cancelShim, handleFromWorkerDir, launchShim, reattachLaunch, readLogLines, readNewLines, taskState, withWorkerTelemetry, type LaunchRecord } from './supervise.ts';
import type { CredentialStatus, ProviderAdapter, ProviderCapabilities, ProviderEvent, TaskHandle, TaskSpec, UsageReport } from './types.ts';

export { CODEX_END_REASONS };

export const CODEX_PROMPT_FILE = 'prompt.md';
export const CODEX_SCHEMA_FILE = 'schema.json';
/** Codex itself writes -o; result.json is the controller's file, so a different name. */
export const CODEX_LAST_MESSAGE_FILE = 'last-message.json';
export const CODEX_RESULT_FILE = 'result.json';
/** `ultra` uses subagents, which an isolated reviewer must not (codex-cli.md section 6). */
export const CODEX_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Flags `codex exec --help` must list for this adapter to work. */
export const CODEX_REQUIRED_FLAGS: readonly string[] = ['--sandbox', '--ephemeral', '--ignore-user-config', '--json', '--output-schema', '--output-last-message', '--model', '--cd'];
export const CODEX_EXTRA_ARGS_ALLOWED: readonly string[] = [];

export type CodexTier = 'os-sandbox' | 'codex-sandbox';

/** policyHash comes from TaskSpec: used when given, derived from the snapshot file when absent (verified either way). */
export type CodexTaskSpec = TaskSpec;

export interface CodexTaskHandle extends TaskHandle {
  tier: CodexTier;
  limitations: string[];
}

export interface CodexAdapterOptions {
  command?: string[];
  /** Wraps the codex process like a Claude worker; null runs it with Codex's own read-only sandbox only. */
  isolation?: IsolationProvider | null;
  baseEnv?: Record<string, string | undefined>;
  shimCommand?: string[];
  graceMs?: number;
  extraArgs?: string[];
  clock?: Clock;
  id?: string;
  /**
   * Extra variable names copied from baseEnv into the worker and into probe
   * commands, for stand-ins configured through the environment (the fakes'
   * ORBIT_FAKE_SCENARIO). Credentials and delivery variables are still refused.
   */
  passEnv?: string[];
}

/** What the codex-sandbox tier (no outer isolation) and Codex itself do not enforce (codex-cli.md sections 8 and 9). */
export const CODEX_LIMITATIONS: readonly string[] = [
  "Codex's read-only sandbox blocks writes and network for the commands it runs, not reads: any file the user can read may reach the provider.",
  'Project configuration (<checkout>/.codex/config.toml) still loads under --ignore-user-config, and user hooks in CODEX_HOME may still fire (unverified).',
];
const NESTED_LIMITATION = "Codex's own command sandbox inside srt is unverified on this platform; if it cannot start nested, the reviewer's shell commands fail closed and it reviews from the packet alone.";

export class CodexAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly opts: CodexAdapterOptions;
  private readonly command: string[];
  private readonly clock: Clock;

  constructor(opts: CodexAdapterOptions = {}) {
    this.opts = opts;
    this.id = opts.id ?? 'codex';
    this.command = opts.command && opts.command.length > 0 ? [...opts.command] : ['codex'];
    this.clock = opts.clock ?? systemClock;
    for (const a of opts.extraArgs ?? []) {
      if (a.startsWith('-') && !CODEX_EXTRA_ARGS_ALLOWED.includes(a.split('=')[0]!)) {
        throw new OrbitError('CONFIG_INVALID', `providers.codex.extra_args: ${a} is not allowed; the review invocation is fixed`, { flag: a });
      }
    }
  }

  async discoverCapabilities(): Promise<ProviderCapabilities> {
    const version = await this.run(['--version'], 30_000);
    const v = version.ok ? (/(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1] ?? null) : null;
    const help = await this.run(['exec', '--help'], 30_000);
    const flags = help.ok ? parseHelpFlags(help.stdout) : new Set<string>();
    const missing = CODEX_REQUIRED_FLAGS.filter((f) => !flags.has(f));
    const models = await this.run(['debug', 'models'], 60_000);
    let slugs: string[] = [];
    let modelDetail = '';
    if (models.ok) {
      try {
        slugs = parseCodexCatalog(JSON.parse(models.stdout)).filter((m) => m.visibility === null || m.visibility === 'list').map((m) => m.slug);
      } catch (err) {
        modelDetail = `; codex debug models was not parseable (${err instanceof Error ? err.message : String(err)})`;
      }
    } else {
      modelDetail = `; codex debug models failed (${models.detail})`;
    }
    const notes: string[] = [];
    if (flags.has('--full-auto')) notes.push('exec lists --full-auto; Orbit never passes it');
    const available = version.ok && help.ok && missing.length === 0;
    return {
      provider: this.id,
      available,
      version: v,
      models: slugs,
      structuredOutput: flags.has('--output-schema'),
      readOnlySandbox: flags.has('--sandbox'),
      usageReporting: 'partial',
      costReporting: false,
      detail: !version.ok
        ? `codex --version failed: ${version.detail}`
        : missing.length > 0
          ? `codex exec lacks ${missing.join(', ')}`
          : `codex ${v ?? 'unknown version'}${modelDetail}${notes.length ? `; ${notes.join('; ')}` : ''}`,
    };
  }

  /**
   * `codex login status` is a 20 ms presence check that cannot see
   * CODEX_API_KEY, so it is skipped when that is set; `codex doctor --json`
   * then makes the real check (an authenticated handshake).
   */
  async validateCredentials(): Promise<CredentialStatus> {
    const env = this.baseEnv();
    const apiKey = typeof env.CODEX_API_KEY === 'string' && env.CODEX_API_KEY !== '';
    let method: string | null = apiKey ? 'api_key_env' : null;
    if (!apiKey) {
      const status = await this.run(['login', 'status'], 30_000);
      const text = `${status.stdout}\n${status.stderr}`;
      if (!status.ok) return { state: 'missing', method: null, detail: /Not logged in/.test(text) ? 'codex reports: Not logged in' : `codex login status failed: ${status.detail}` };
      method = /ChatGPT/.test(text) ? 'chatgpt' : /API key/.test(text) ? 'api_key' : 'unknown';
    }
    const doctor = await this.run(['doctor', '--json'], 60_000);
    const checks = parseDoctorChecks(doctor.stdout);
    if (!checks) return { state: 'unknown', method, detail: `codex doctor --json gave no readable report (${doctor.detail})` };
    const auth = checks['auth.credentials'];
    const reach = checks['network.websocket_reachability'];
    if (auth === 'fail') return { state: 'invalid', method, detail: 'codex doctor: auth.credentials failed' };
    if (auth === 'ok' && reach === 'ok') return { state: 'valid', method, detail: 'codex doctor: credentials ok and an authenticated handshake succeeded' };
    return { state: 'unknown', method, detail: `codex doctor: auth.credentials ${auth ?? 'missing'}, network.websocket_reachability ${reach ?? 'missing'}` };
  }

  async startTask(spec: CodexTaskSpec): Promise<CodexTaskHandle> {
    if (!spec.readOnly) throw new OrbitError('POLICY_DENIED', 'the Codex adapter runs read-only review tasks only', { workerId: spec.workerId, role: spec.role });
    if (!spec.model) throw new OrbitError('CONFIG_INVALID', 'Codex needs an explicit model (-m): the configured default may not work with the installed CLI');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(spec.model)) throw new OrbitError('CONFIG_INVALID', `invalid Codex model ${JSON.stringify(spec.model)}`);
    if (spec.effort !== null && !CODEX_EFFORTS.includes(spec.effort)) throw new OrbitError('CONFIG_INVALID', `unsupported Codex reasoning effort ${JSON.stringify(spec.effort)}`);
    for (const p of [spec.cwd, spec.workerDir, spec.policyPath]) if (!isAbsolute(p)) throw new OrbitError('CONFIG_INVALID', `paths must be absolute: ${p}`);
    if (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory()) throw new OrbitError('NOT_FOUND', `review checkout does not exist: ${spec.cwd}`);
    const violations = strictSchemaViolations(spec.outputSchema);
    if (violations.length > 0) throw new OrbitError('SCHEMA_INVALID', `output schema is outside the strict subset Codex sends with strict: true: ${violations.slice(0, 5).join('; ')}`, { violations });

    const prior = readJsonIfExists<LaunchRecord>(join(spec.workerDir, LAUNCH_FILE));
    if (prior) {
      const handle = await reattachLaunch(this.id, spec.workerDir, spec.workerId, this.clock);
      const meta = (prior.meta ?? {}) as { tier?: CodexTier; limitations?: string[] };
      return { ...handle, tier: meta.tier ?? 'codex-sandbox', limitations: meta.limitations ?? [] };
    }

    const policyHash = spec.policyHash ?? snapshotFileHash(spec.policyPath);
    const snapshot = verifySnapshot(spec.policyPath, policyHash);
    // Codex has no verified output cap (no documented flag or config key limits a turn's output tokens), so the budget is an instruction, and overruns are measured and recorded.
    const outputTokens = outputBudgetFor(spec.role, { explicit: spec.outputTokens, configured: snapshot.config.routing.output_budgets });
    const checkout = canonicalPath(spec.cwd);
    const workerDir = spec.workerDir;
    const tmpDir = prepareWorkerTmpDir(workerDir);
    const env = buildWorkerEnv({ provider: 'codex', base: this.baseEnv(), policyPath: spec.policyPath, policyHash, worktree: checkout, tmpDir, extra: { ...passThrough(this.baseEnv(), this.opts.passEnv), ...spec.env } });
    writeFileSync(join(workerDir, CODEX_PROMPT_FILE), `${spec.systemPrompt.trim()}\n\n${spec.prompt}${outputTokens === null ? '' : `\n${outputBudgetInstruction(outputTokens)}\n`}`, { mode: 0o600 });
    atomicWriteJson(join(workerDir, CODEX_SCHEMA_FILE), spec.outputSchema, 0o600);
    // -o is written only after turn.completed; a stale file from an earlier
    // attempt must not be mistaken for this one's answer.
    rmSync(join(workerDir, CODEX_LAST_MESSAGE_FILE), { force: true });

    const argv = buildCodexArgv({ command: this.command, model: spec.model, effort: spec.effort, cwd: checkout, schemaPath: join(workerDir, CODEX_SCHEMA_FILE), lastMessagePath: join(workerDir, CODEX_LAST_MESSAGE_FILE) });
    let launchArgv = argv;
    let launchEnv = env;
    let tier: CodexTier = 'codex-sandbox';
    const limitations = [...CODEX_LIMITATIONS];
    if (outputTokens !== null) limitations.push(`Output budget of ${outputTokens} tokens is an instruction only: Codex has no verified output cap, so overruns are measured and recorded.`);
    const cleanupPaths: string[] = [];
    const isolation = this.opts.isolation ?? null;
    if (isolation && isolation.kind !== 'none') {
      const wrapped = isolation.wrap(argv, readOnlyProfile(spec.sandbox, checkout, true), { cwd: checkout, env });
      launchArgv = wrapped.argv;
      launchEnv = wrapped.env;
      tier = 'os-sandbox';
      limitations.push(...wrapped.limitations, NESTED_LIMITATION);
      for (const a of wrapped.argv) if (isAbsolute(a) && basename(dirname(a)).startsWith('orbit-srt-')) cleanupPaths.push(dirname(a));
    } else {
      limitations.push('No OS isolation around the codex process itself; only its own read-only sandbox applies to the commands it runs.');
    }

    const handle = await launchShim({
      provider: this.id,
      workerId: spec.workerId,
      workerDir,
      cwd: checkout,
      shimCommand: this.opts.shimCommand ?? defaultOrbitCommands().shim,
      argv: launchArgv,
      env: launchEnv,
      timeoutMs: spec.timeoutMs,
      graceMs: this.opts.graceMs,
      stdinPath: join(workerDir, CODEX_PROMPT_FILE),
      cleanupPaths: [...new Set(cleanupPaths)],
      meta: { tier, limitations, model: spec.model, outputBudgetTokens: outputTokens },
      clock: this.clock,
    });
    return { ...handle, tier, limitations };
  }

  async streamEvents(handle: TaskHandle, fromOffset: number): Promise<{ events: ProviderEvent[]; nextOffset: number }> {
    const { lines, nextOffset } = readNewLines(handle.logPath, fromOffset);
    return { events: codexEvents(lines, this.clock.now(), launchModel(handle.workerDir)), nextOffset };
  }

  async cancelTask(handle: TaskHandle): Promise<void> {
    // Codex has a SIGINT handler (turn/interrupt) and none for SIGTERM.
    await cancelShim(handle, this.opts.graceMs ?? 5_000, this.clock);
  }

  async collectResult(handle: TaskHandle, spec: Pick<TaskSpec, 'outputSchema'>): Promise<CodexTaskResult | null> {
    const st = taskState(handle);
    if (st.state === 'running') return null;
    const log = readLogLines(handle.logPath);
    const model = launchModel(handle.workerDir);
    let result: CodexTaskResult;
    if (st.state === 'lost') {
      result = {
        status: st.cancelRequested ? 'cancelled' : 'lost',
        reason: st.cancelRequested ? 'interrupted' : 'crashed',
        structured: null,
        text: null,
        error: `the worker shim ended without writing exit.json${st.orphans ? '; its provider process is still running (call cancelTask)' : ''}`,
        exitCode: null,
        usage: codexUsage(log.events, model),
        durationMs: null,
        threadId: null,
        warnings: [],
      };
    } else {
      result = classifyCodexTranscript({ events: log.events, malformedTail: log.malformedTail, exit: st.exit, outputSchema: spec.outputSchema, model });
    }
    result = { ...result, usage: withWorkerTelemetry(result.usage, handle.workerDir) };
    atomicWriteJson(join(handle.workerDir, CODEX_RESULT_FILE), result, 0o600);
    return result;
  }

  async reportUsage(handle: TaskHandle): Promise<UsageReport> {
    return withWorkerTelemetry(codexUsage(existsSync(handle.logPath) ? readLogLines(handle.logPath).events : [], launchModel(handle.workerDir)), handle.workerDir);
  }

  reattach(workerDir: string): TaskHandle | null {
    return handleFromWorkerDir(this.id, workerDir);
  }

  private baseEnv(): Record<string, string | undefined> {
    return this.opts.baseEnv ?? process.env;
  }

  private async run(args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; detail: string }> {
    const base = this.baseEnv();
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'CODEX_HOME', 'CODEX_API_KEY']) {
      const v = base[k];
      if (typeof v === 'string' && v !== '') env[k] = v;
    }
    Object.assign(env, passThrough(base, this.opts.passEnv));
    try {
      const r = await execCapture([...this.command, ...args], { env, timeoutMs });
      return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, detail: r.timedOut ? 'timed out' : `exit ${r.exitCode ?? r.signal}` };
    } catch (err) {
      return { ok: false, stdout: '', stderr: '', detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

export interface CodexArgvInput {
  command: string[];
  model: string;
  effort: string | null;
  cwd: string;
  schemaPath: string;
  lastMessagePath: string;
}

export function buildCodexArgv(i: CodexArgvInput): string[] {
  return [
    ...i.command,
    'exec',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--json',
    '--output-schema',
    i.schemaPath,
    '-o',
    i.lastMessagePath,
    '-m',
    i.model,
    ...(i.effort ? ['-c', `model_reasoning_effort="${i.effort}"`] : []),
    '-c',
    'web_search="disabled"',
    '--disable',
    'multi_agent',
    '-C',
    i.cwd,
    '-',
  ];
}

/** Long flags listed by a clap `--help` page. */
export function parseHelpFlags(help: string): Set<string> {
  const out = new Set<string>();
  for (const m of help.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/gm)) out.add(m[1]!);
  return out;
}

/**
 * `codex doctor --json` check statuses by id. The notes give the shape as
 * checks["auth.credentials"].status; a list of {id, status} is accepted too,
 * since the wrapper is not otherwise documented.
 */
export function parseDoctorChecks(stdout: string): Record<string, string> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== 'object') return null;
  const checks = (doc as Record<string, unknown>).checks;
  const out: Record<string, string> = {};
  if (Array.isArray(checks)) {
    for (const c of checks) {
      if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).id === 'string' && typeof (c as Record<string, unknown>).status === 'string') {
        out[(c as Record<string, string>).id!] = (c as Record<string, string>).status!;
      }
    }
  } else if (checks && typeof checks === 'object') {
    for (const [id, c] of Object.entries(checks as Record<string, unknown>)) {
      if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).status === 'string') out[id] = (c as Record<string, string>).status!;
    }
  } else {
    return null;
  }
  return out;
}

function launchModel(workerDir: string): string | null {
  const meta = readJsonIfExists<LaunchRecord>(join(workerDir, LAUNCH_FILE))?.meta;
  return meta && typeof meta.model === 'string' ? meta.model : null;
}
