/**
 * Muse adapter, for independent review only (spec section 12; docs/interfaces/muse.md; ADR 0017). Muse never edits:
 * the adapter refuses a task that is not read-only, and runs
 *
 *   muse exec --model <m> --reasoning-effort <e> --workspace <checkout> --permission-profile :read-only
 *     --disable-request-user-input --disable-write --no-foreign-personal-context --disable-web-tools
 *     --no-session-log --json --output-schema <workerDir>/schema.json --max-model-steps <N>
 *     --prompt-file <workerDir>/prompt.md
 *
 * Read-only never rests on Muse's own settings alone. In one of two tiers:
 *
 *   os-sandbox    srt wraps the whole muse process (museReviewerProfile): writes to the worker directory only, egress
 *                 to the Muse host only, Muse's login directory denied. It runs on META_API_KEY with a private config
 *                 directory, since the user's login file is denied there.
 *   muse-sandbox  no srt: Muse's own `:read-only` profile and shell Seatbelt, against a review checkout Orbit has
 *                 already write-protected on disk (evidence/candidate.ts makeReadOnly). The adapter refuses to launch
 *                 when the checkout is writable.
 *
 * `--approval-mode never` is not passed: Muse 1.4.11 refuses it together with --permission-profile (exit 2). A run
 * can still never wait on a person: --disable-request-user-input withholds the question tool, and the reviewer's
 * wall-clock cap kills the whole process group (shim.ts).
 */
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { systemClock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { execCapture } from '../core/exec.ts';
import { atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import type { IsolationProvider } from '../isolation/types.ts';
import { MUSE_PRIVATE_CONFIG_DIR, museReviewerProfile, prepareWorkerTmpDir } from '../isolation/profiles.ts';
import { canonicalPath } from '../isolation/util.ts';
import { MUSE_DEFAULT_MODEL, MUSE_DEFAULT_REASONING_EFFORT, MUSE_REASONING_EFFORTS } from '../policy/config.ts';
import type { MuseTierSetting } from '../policy/types.ts';
import { verifySnapshot } from '../policy/snapshot.ts';
import { compareVersions, snapshotFileHash } from './claude.ts';
import { parseHelpFlags } from './codex.ts';
import { defaultOrbitCommands } from './commands.ts';
import { buildWorkerEnv, museEnvCredential, passThrough } from './env.ts';
import { MUSE_AUTH_PATTERNS, MUSE_END_REASONS, classifyMuseTranscript, museEvents, museRawFinalAnswer, museUsage, type MuseTaskResult } from './muse-events.ts';
import { outputBudgetFor, outputBudgetInstruction } from './prompt.ts';
import { LAUNCH_FILE, cancelShim, handleFromWorkerDir, launchShim, reattachLaunch, readLogLines, readNewLines, taskState, withWorkerTelemetry, type LaunchRecord } from './supervise.ts';
import { STDERR_FILE } from './shim.ts';
import type { CredentialStatus, ProviderAdapter, ProviderCapabilities, ProviderEvent, TaskHandle, TaskSpec, UsageReport } from './types.ts';

export { MUSE_END_REASONS };

export const MUSE_PROMPT_FILE = 'prompt.md';
export const MUSE_SCHEMA_FILE = 'schema.json';
export const MUSE_RESULT_FILE = 'result.json';
/** The step cap of a review session (issue #108, open question 3). */
export const MUSE_REVIEW_MAX_STEPS = 200;
/** The oldest Muse whose flags and events the adapter was verified against. */
export const MUSE_MIN_VERSION = '1.4.11';
/** Flags `muse exec --help` must list for this adapter to work. */
export const MUSE_REQUIRED_FLAGS: readonly string[] = [
  '--model',
  '--reasoning-effort',
  '--workspace',
  '--permission-profile',
  '--disable-request-user-input',
  '--disable-write',
  '--no-foreign-personal-context',
  '--disable-web-tools',
  '--no-session-log',
  '--json',
  '--output-schema',
  '--max-model-steps',
  '--prompt-file',
];
/** Arguments that would undo the read-only review; refused in any argv the adapter launches. */
export const MUSE_FORBIDDEN_ARGS: readonly string[] = ['--yolo', '--disable-sandbox', '--disable-approval', '--trust-workspace'];
export const MUSE_EXTRA_ARGS_ALLOWED: readonly string[] = [];

export type MuseTier = Exclude<MuseTierSetting, 'auto'>;
export type { MuseTierSetting };

export interface MuseTaskHandle extends TaskHandle {
  tier: MuseTier;
  limitations: string[];
}

export interface MuseAdapterOptions {
  command?: string[];
  /** Only sandbox-runtime wraps the muse process (the os-sandbox tier). */
  isolation?: IsolationProvider | null;
  /** providers.<id>.tier: `auto` (default) chooses by credential; the other two override the choice. */
  tier?: MuseTierSetting;
  baseEnv?: Record<string, string | undefined>;
  shimCommand?: string[];
  graceMs?: number;
  extraArgs?: string[];
  clock?: Clock;
  id?: string;
  /** providers.<id>.model, which the credential check asks for too; defaults to MUSE_DEFAULT_MODEL. */
  model?: string | null;
  /** Extra variable names copied from baseEnv, for stand-ins configured through the environment (the fakes). */
  passEnv?: string[];
}

/** What the muse-sandbox tier (no srt) does not enforce. */
export const MUSE_LIMITATIONS: readonly string[] = [
  "No OS isolation around the muse process itself: Muse's :read-only profile and shell sandbox apply to its tools, and the review checkout is write-protected on disk.",
  'Reads are unrestricted: any file the user can read may reach the provider.',
];

/** What the os-sandbox tier adds to srt's own limitations. */
export const MUSE_OS_SANDBOX_LIMITATIONS: readonly string[] = [
  "srt confines the whole muse process: writes to the worker directory only, egress to api.meta.ai only, and Muse's login directory denied. Muse's own shell sandbox may not start inside srt (unverified); its file tools still read the checkout.",
];

export interface MuseSrtStatus {
  ok: boolean;
  why: string;
}

export interface MuseTierInput {
  setting: MuseTierSetting;
  providerId?: string;
  /** Name of the API key variable present in the worker environment, or null (a login file under XDG_CONFIG_HOME). */
  apiKeyVar: string | null;
  srt: MuseSrtStatus;
}

export interface MuseTierDecision {
  tier: MuseTier;
  /** Why, as one clause that reads after "the Muse reviewer runs in the <tier> tier: ". */
  reason: string;
  /** True when no tier was configured (`auto`). */
  automatic: boolean;
}

const NO_KEY_REASON = "no META_API_KEY in the environment, and Muse's login file is denied under srt";

/**
 * The tier of the Muse reviewer (ADR 0017). Pure: the caller supplies what it saw, so `orbit doctor` and the adapter
 * cannot disagree.
 *
 *   auto          os-sandbox only with META_API_KEY in the worker environment and an srt that starts; else muse-sandbox
 *   os-sandbox    srt and META_API_KEY or nothing: throws ISOLATION_UNAVAILABLE (fail closed)
 *   muse-sandbox  never wrapped, whatever else is available
 */
export function decideMuseTier(i: MuseTierInput): MuseTierDecision {
  const key = `providers.${i.providerId ?? 'muse'}.tier`;
  if (i.setting === 'muse-sandbox') return { tier: 'muse-sandbox', reason: `${key} is muse-sandbox, so Muse is never wrapped in srt`, automatic: false };
  if (i.setting === 'os-sandbox') {
    if (!i.srt.ok) {
      throw new OrbitError('ISOLATION_UNAVAILABLE', `${key} is os-sandbox but ${i.srt.why}; refusing to run Muse without srt (set the tier to auto or muse-sandbox to run it under its own read-only profile instead)`, { tier: 'os-sandbox', providerId: i.providerId ?? 'muse' });
    }
    if (i.apiKeyVar === null) {
      throw new OrbitError('ISOLATION_UNAVAILABLE', `${key} is os-sandbox but ${NO_KEY_REASON}; set META_API_KEY, or set the tier to auto or muse-sandbox`, { tier: 'os-sandbox', providerId: i.providerId ?? 'muse' });
    }
    return { tier: 'os-sandbox', reason: `${key} is os-sandbox, META_API_KEY is set and sandbox-runtime is in use`, automatic: false };
  }
  if (i.apiKeyVar === null) return { tier: 'muse-sandbox', reason: NO_KEY_REASON, automatic: true };
  if (!i.srt.ok) return { tier: 'muse-sandbox', reason: i.srt.why, automatic: true };
  return { tier: 'os-sandbox', reason: `${i.apiKeyVar} is set and sandbox-runtime is in use, so the whole muse process is confined`, automatic: true };
}

export class MuseAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly opts: MuseAdapterOptions;
  private readonly command: string[];
  private readonly clock: Clock;
  private srtProbe: { ok: boolean; detail: string } | null = null;

  constructor(opts: MuseAdapterOptions = {}) {
    this.opts = opts;
    this.id = opts.id ?? 'muse';
    this.command = opts.command && opts.command.length > 0 ? [...opts.command] : ['muse'];
    this.clock = opts.clock ?? systemClock;
    for (const a of opts.extraArgs ?? []) {
      if (a.startsWith('-') && !MUSE_EXTRA_ARGS_ALLOWED.includes(a.split('=')[0]!)) {
        throw new OrbitError('CONFIG_INVALID', `providers.${this.id}.extra_args: ${a} is not allowed; the review invocation is fixed`, { flag: a });
      }
    }
  }

  async discoverCapabilities(): Promise<ProviderCapabilities> {
    const version = await this.run(['--version'], 30_000);
    const v = version.ok ? (/(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1] ?? null) : null;
    const help = await this.run(['exec', '--help'], 30_000);
    const flags = help.ok ? parseHelpFlags(help.stdout) : new Set<string>();
    const missing = MUSE_REQUIRED_FLAGS.filter((f) => !flags.has(f));
    const old = v !== null && compareVersions(v, MUSE_MIN_VERSION) < 0;
    return {
      provider: this.id,
      available: version.ok && help.ok && missing.length === 0 && !old,
      version: v,
      // Muse has no model catalog command; the configured model is passed through unchanged.
      models: [],
      structuredOutput: flags.has('--output-schema'),
      readOnlySandbox: flags.has('--permission-profile'),
      usageReporting: 'partial',
      costReporting: false,
      detail: !version.ok
        ? `muse --version failed: ${version.detail}`
        : missing.length > 0
          ? `muse exec lacks ${missing.join(', ')}`
          : old
            ? `muse ${v} is older than ${MUSE_MIN_VERSION}, the version this adapter was verified against`
            : `muse ${v ?? 'unknown version'}`,
    };
  }

  /**
   * Muse has no login status command, so the check is the smallest real request: one model step, no tools, in an
   * empty private directory, with nothing of the repository in it. A missing login fails before any request.
   */
  async validateCredentials(): Promise<CredentialStatus> {
    const env = this.baseEnv();
    const method = museEnvCredential(env) !== null ? 'api_key_env' : 'login_file';
    const scratch = mkdtempSync(join(tmpdir(), 'orbit-muse-cred-'));
    try {
      const r = await this.run(
        ['exec', '--model', this.opts.model ?? MUSE_DEFAULT_MODEL, '--reasoning-effort', 'minimal', '--max-model-steps', '1', '--no-session-log', '--permission-profile', ':read-only', '--disable-write', '--disable-shell', '--disable-web-tools', '--disable-request-user-input', '--no-foreign-personal-context', '--workspace', scratch, '--json', 'Reply with the single word ok.'],
        90_000,
      );
      const text = `${r.stdout}\n${r.stderr}`;
      if (r.ok && /run\.terminal\.completed/.test(r.stdout)) return { state: 'valid', method, detail: 'muse exec answered a one-step request' };
      if (/missing meta credentials/i.test(text)) return { state: 'missing', method: null, detail: 'muse reports missing meta credentials (run `muse login` or set META_API_KEY)' };
      if (MUSE_AUTH_PATTERNS.some((p) => p.test(text))) return { state: 'invalid', method, detail: 'muse rejected the credentials' };
      return { state: 'unknown', method, detail: `muse exec credential check failed: ${r.detail}` };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async startTask(spec: TaskSpec): Promise<MuseTaskHandle> {
    if (!spec.readOnly) throw new OrbitError('POLICY_DENIED', 'the Muse adapter runs read-only review tasks only', { workerId: spec.workerId, role: spec.role });
    if (!spec.model) throw new OrbitError('CONFIG_INVALID', 'Muse needs an explicit model (--model)');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(spec.model)) throw new OrbitError('CONFIG_INVALID', `invalid Muse model ${JSON.stringify(spec.model)}`);
    const effort = spec.effort ?? MUSE_DEFAULT_REASONING_EFFORT;
    if (!MUSE_REASONING_EFFORTS.includes(effort)) throw new OrbitError('CONFIG_INVALID', `unsupported Muse reasoning effort ${JSON.stringify(effort)}`);
    for (const p of [spec.cwd, spec.workerDir, spec.policyPath]) if (!isAbsolute(p)) throw new OrbitError('CONFIG_INVALID', `paths must be absolute: ${p}`);
    if (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory()) throw new OrbitError('NOT_FOUND', `review checkout does not exist: ${spec.cwd}`);

    const prior = readJsonIfExists<LaunchRecord>(join(spec.workerDir, LAUNCH_FILE));
    if (prior) {
      const handle = await reattachLaunch(this.id, spec.workerDir, spec.workerId, this.clock);
      const meta = (prior.meta ?? {}) as { tier?: MuseTier; limitations?: string[] };
      return { ...handle, tier: meta.tier ?? 'muse-sandbox', limitations: meta.limitations ?? [] };
    }

    const policyHash = spec.policyHash ?? snapshotFileHash(spec.policyPath);
    const snapshot = verifySnapshot(spec.policyPath, policyHash);
    const outputTokens = outputBudgetFor(spec.role, { explicit: spec.outputTokens, configured: snapshot.config.routing.output_budgets });
    const checkout = canonicalPath(spec.cwd);
    const workerDir = spec.workerDir;
    const choice = await this.chooseTier(museEnvCredential({ ...this.baseEnv(), ...spec.env }));
    const tier = choice.decision.tier;
    // muse-sandbox has no OS boundary of its own, so the write-protected checkout is that boundary: refuse without it.
    if (tier === 'muse-sandbox') assertWriteProtected(checkout);
    const tmpDir = prepareWorkerTmpDir(workerDir);
    const extra: Record<string, string> = { ...passThrough(this.baseEnv(), this.opts.passEnv), ...spec.env };
    if (tier === 'os-sandbox') {
      // A private config directory: the user's login file is denied under srt, and Muse writes its settings here.
      const own = join(workerDir, MUSE_PRIVATE_CONFIG_DIR);
      mkdirSync(own, { recursive: true, mode: 0o700 });
      extra.XDG_CONFIG_HOME = own;
    }
    const env = buildWorkerEnv({ provider: 'muse', base: this.baseEnv(), policyPath: spec.policyPath, policyHash, worktree: checkout, tmpDir, extra });
    const srt = choice.srt ? { provider: choice.srt, profile: museReviewerProfile(spec.sandbox, { checkout, workerDir }) } : null;
    writeFileSync(join(workerDir, MUSE_PROMPT_FILE), `${spec.systemPrompt.trim()}\n\n${spec.prompt}${outputTokens === null ? '' : `\n${outputBudgetInstruction(outputTokens)}\n`}`, { mode: 0o600 });
    atomicWriteJson(join(workerDir, MUSE_SCHEMA_FILE), spec.outputSchema, 0o600);

    const argv = buildMuseArgv({ command: this.command, model: spec.model, effort, workspace: checkout, schemaPath: join(workerDir, MUSE_SCHEMA_FILE), promptPath: join(workerDir, MUSE_PROMPT_FILE), maxSteps: MUSE_REVIEW_MAX_STEPS });
    let launchArgv = argv;
    let launchEnv = env;
    const limitations = [...(srt ? MUSE_OS_SANDBOX_LIMITATIONS : MUSE_LIMITATIONS)];
    if (outputTokens !== null) limitations.push(`Output budget of ${outputTokens} tokens is an instruction only: Muse has no verified output cap, so overruns are measured and recorded.`);
    const cleanupPaths: string[] = [];
    if (srt) {
      const wrapped = srt.provider.wrap(argv, srt.profile, { cwd: checkout, env });
      launchArgv = wrapped.argv;
      launchEnv = wrapped.env;
      limitations.push(...wrapped.limitations);
      for (const a of wrapped.argv) if (isAbsolute(a) && basename(dirname(a)).startsWith('orbit-srt-')) cleanupPaths.push(dirname(a));
    } else {
      limitations.push(`Muse runs in the muse-sandbox tier, under its own :read-only profile and without srt: ${choice.decision.reason}.`);
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
      stdinPath: null,
      cleanupPaths: [...new Set(cleanupPaths)],
      meta: { tier, tierReason: choice.decision.reason, tierAutomatic: choice.decision.automatic, limitations, model: spec.model, outputBudgetTokens: outputTokens },
      clock: this.clock,
    });
    return { ...handle, tier, limitations };
  }

  async streamEvents(handle: TaskHandle, fromOffset: number): Promise<{ events: ProviderEvent[]; nextOffset: number }> {
    const { lines, nextOffset } = readNewLines(handle.logPath, fromOffset);
    return { events: museEvents(lines, this.clock.now(), launchModel(handle.workerDir)), nextOffset };
  }

  async cancelTask(handle: TaskHandle): Promise<void> {
    await cancelShim(handle, this.opts.graceMs ?? 5_000, this.clock);
  }

  async collectResult(handle: TaskHandle, spec: Pick<TaskSpec, 'outputSchema'>): Promise<MuseTaskResult | null> {
    const st = taskState(handle);
    if (st.state === 'running') return null;
    const log = readLogLines(handle.logPath);
    const model = launchModel(handle.workerDir);
    let result: MuseTaskResult;
    if (st.state === 'lost') {
      result = {
        status: st.cancelRequested ? 'cancelled' : 'lost',
        reason: st.cancelRequested ? 'interrupted' : 'crashed',
        structured: null,
        text: null,
        error: `the worker shim ended without writing exit.json${st.orphans ? '; its provider process is still running (call cancelTask)' : ''}`,
        exitCode: null,
        usage: museUsage(log.events, model),
        durationMs: null,
      };
    } else {
      result = classifyMuseTranscript({ events: log.events, malformedTail: log.malformedTail, exit: st.exit, outputSchema: spec.outputSchema, model, stderr: stderrText(handle.workerDir) });
    }
    const raw = museRawFinalAnswer(log.events);
    result = { ...result, usage: withWorkerTelemetry(result.usage, handle.workerDir, raw !== undefined ? raw : (result.structured ?? null)) };
    atomicWriteJson(join(handle.workerDir, MUSE_RESULT_FILE), result, 0o600);
    return result;
  }

  async reportUsage(handle: TaskHandle): Promise<UsageReport> {
    const events = existsSync(handle.logPath) ? readLogLines(handle.logPath).events : [];
    return withWorkerTelemetry(museUsage(events, launchModel(handle.workerDir)), handle.workerDir, museRawFinalAnswer(events));
  }

  reattach(workerDir: string): TaskHandle | null {
    return handleFromWorkerDir(this.id, workerDir);
  }

  private baseEnv(): Record<string, string | undefined> {
    return this.opts.baseEnv ?? process.env;
  }

  private async chooseTier(apiKeyVar: string | null): Promise<{ srt: IsolationProvider | null; decision: MuseTierDecision }> {
    const setting = this.opts.tier ?? 'auto';
    const consult = setting === 'os-sandbox' || (setting === 'auto' && apiKeyVar !== null);
    const status = consult ? await this.srtStatus() : { provider: null, ok: false, why: 'sandbox-runtime was not consulted' };
    const decision = decideMuseTier({ setting, providerId: this.id, apiKeyVar, srt: { ok: status.ok, why: status.why } });
    return { srt: decision.tier === 'os-sandbox' ? status.provider : null, decision };
  }

  private async srtStatus(): Promise<MuseSrtStatus & { provider: IsolationProvider | null }> {
    const isolation = this.opts.isolation ?? null;
    if (isolation === null || isolation.kind === 'none') return { provider: null, ok: false, why: 'sandbox-runtime isolation is not in use' };
    if (isolation.kind !== 'sandbox-runtime') return { provider: null, ok: false, why: `the ${isolation.kind} isolation provider is not used around Muse (only sandbox-runtime is)` };
    this.srtProbe ??= await isolation.available();
    if (!this.srtProbe.ok) return { provider: null, ok: false, why: `sandbox-runtime is unavailable (${this.srtProbe.detail})` };
    return { provider: isolation, ok: true, why: '' };
  }

  private async run(args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; detail: string }> {
    const base = this.baseEnv();
    const env: Record<string, string> = { MUSE_NO_AUTO_UPDATE: '1' };
    for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'XDG_CONFIG_HOME', 'META_API_KEY']) {
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

export interface MuseArgvInput {
  command: string[];
  model: string;
  effort: string;
  workspace: string;
  schemaPath: string;
  promptPath: string;
  maxSteps: number;
}

export function buildMuseArgv(i: MuseArgvInput): string[] {
  const argv = [
    ...i.command,
    'exec',
    '--model',
    i.model,
    '--reasoning-effort',
    i.effort,
    '--workspace',
    i.workspace,
    '--permission-profile',
    ':read-only',
    '--disable-request-user-input',
    '--disable-write',
    '--no-foreign-personal-context',
    '--disable-web-tools',
    '--no-session-log',
    '--json',
    '--output-schema',
    i.schemaPath,
    '--max-model-steps',
    String(i.maxSteps),
    '--prompt-file',
    i.promptPath,
  ];
  assertSafeMuseArgv(argv);
  return argv;
}

/** The last guard before launch: nothing in the argv may widen what the review can do. */
export function assertSafeMuseArgv(argv: readonly string[]): void {
  for (const a of argv) {
    const flag = a.split('=')[0]!;
    if (MUSE_FORBIDDEN_ARGS.includes(flag) || a.includes(':unrestricted')) {
      throw new OrbitError('POLICY_DENIED', `refusing to launch Muse with ${a}: the review invocation is read-only`, { arg: a });
    }
  }
}

/** The muse-sandbox tier's boundary: the checkout must not be writable by this user. */
function assertWriteProtected(checkout: string): void {
  let writable = true;
  try {
    accessSync(checkout, constants.W_OK);
  } catch {
    writable = false;
  }
  if (writable) {
    throw new OrbitError('POLICY_DENIED', `refusing to run Muse in the muse-sandbox tier against a writable checkout (${checkout}); the review checkout must be write-protected on disk`, { path: checkout });
  }
}

function launchModel(workerDir: string): string | null {
  const meta = readJsonIfExists<LaunchRecord>(join(workerDir, LAUNCH_FILE))?.meta;
  return meta && typeof meta.model === 'string' ? meta.model : null;
}

function stderrText(workerDir: string): string {
  try {
    return readFileSync(join(workerDir, STDERR_FILE), 'utf8').slice(-16_384);
  } catch {
    return '';
  }
}
