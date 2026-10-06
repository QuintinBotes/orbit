/**
 * Claude Code adapter: `claude -p` as a detached, supervised, policy-bound
 * worker (spec section 12; ADR 0001; claude-headless-and-sandbox.md section
 * 7; gaps-and-contradictions.md section 6).
 *
 * Invocation choices, each from the verified notes:
 *   -p --output-format stream-json --verbose    a transcript in a file any controller can read
 *   --session-id <uuid>                         known (and persisted) before spawn
 *   --permission-mode dontAsk                   anything not allowed is denied, never prompted;
 *                                               always explicit, because the -p default moves
 *   --permission-prompts none                   (>= 2.1.259) no AskUserQuestion, no retry of denials
 *   --tools / --allowedTools / --disallowedTools  per role; read-only roles get no edit tool
 *   --setting-sources "" --strict-mcp-config    no user, project or local settings, hooks,
 *                                               plugins or MCP servers: the repository's own
 *                                               .claude/settings.json and .mcp.json are
 *                                               untrusted and run on the host when loaded
 *                                               (V4); "user" was verified to load the user's
 *                                               plugins and their hooks, so it is not used
 *   --settings <workerDir>/settings.json        Orbit's rules, guard hook and sandbox block
 *   --append-system-prompt-file system.md       the role prompt
 *   --json-schema                               the role's output schema
 * The prompt goes in on stdin from prompt.md: no argv length limit, no
 * chance of a prompt being read as a flag, and nothing in `ps`.
 *
 * Isolation tiers (ADR 0001): "os-sandbox" runs the whole CLI inside the
 * isolation provider (srt) and needs a credential in the environment,
 * because a keychain login is invisible there; "claude-sandbox" runs it
 * unwrapped with Claude Code's own sandbox on (failIfUnavailable), which is
 * the only option with a keychain login. Both load the same permission rules
 * and guard hook, and the controller's diff inspection gates either.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { systemClock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { execCapture } from '../core/exec.ts';
import { redact } from '../core/redact.ts';
import { atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { strictSchemaViolations } from '../contract/strict-schema.ts';
import type { IsolationProvider, SandboxProfile } from '../isolation/types.ts';
import { prepareWorkerTmpDir } from '../isolation/profiles.ts';
import { canonicalPath, isWithin, readablePathsOf } from '../isolation/util.ts';
import { bashGrant } from '../policy/role-grants.ts';
import { snapshotHash, verifySnapshot } from '../policy/snapshot.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import { assertClaudeSettings, renderClaudeSettings, type ClaudeTier } from './claude-settings.ts';
import { CLAUDE_AUTH_ERRORS, classifyClaudeTranscript, claudeEvents, claudeUsage, emptyUsage, type ClaudeTaskResult } from './claude-transcript.ts';
import { STRICT_PLUGIN_POLICY, needsPluginList, parsePluginList, pluginPolicyOf, type InstalledPlugin, type PluginPolicy } from './claude-plugins.ts';
import { defaultOrbitCommands } from './commands.ts';
import { buildWorkerEnv, passThrough, claudeEnvCredential } from './env.ts';
import { outputBudgetFor, outputBudgetInstruction } from './prompt.ts';
import { STDERR_FILE, type AbortPattern } from './shim.ts';
import {
  LAUNCH_FILE,
  cancelShim,
  handleFromWorkerDir,
  launchShim,
  parseJsonLines,
  reattachLaunch,
  readLogLines,
  readNewLines,
  nextSessionId,
  taskState,
  withWorkerTelemetry,
  type LaunchRecord,
} from './supervise.ts';
import type { CredentialStatus, ProviderAdapter, ProviderCapabilities, ProviderEvent, TaskHandle, TaskSpec, UsageReport } from './types.ts';

export type { ClaudeTier } from './claude-settings.ts';

export const PROMPT_FILE = 'prompt.md';
export const SYSTEM_FILE = 'system.md';
export const SETTINGS_FILE = 'settings.json';
export const RESULT_FILE = 'result.json';

/** Effort values `claude --help` lists; anything else is ignored by the CLI with only a warning, so Orbit refuses it. */
export const CLAUDE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** --permission-prompts exists from this version on (claude-headless-and-sandbox.md 1.1). */
export const PERMISSION_PROMPTS_MIN_VERSION = '2.1.259';
/** Tools no worker gets: web access without a host allowlist, MCP, subagents and session-scheduling tools. */
export const ALWAYS_DISALLOWED: readonly string[] = ['WebSearch', 'mcp__*', 'Agent', 'Task'];
const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
/** Flags a user may add through providers.<id>.extra_args; every other flag could undo a control above. */
export const CLAUDE_EXTRA_ARGS_ALLOWED: readonly string[] = ['--fallback-model', '--exclude-dynamic-system-prompt-sections'];

/**
 * policyHash (runs.policy_hash; the snapshot file's own hash when absent, verified either way) and sessionId
 * (nextSessionId(workerId, workerDir), a new id per archived attempt, when absent) come from TaskSpec.
 */
export interface ClaudeTaskSpec extends TaskSpec {
  maxBudgetUsd?: number | null;
}

export interface ClaudeTaskHandle extends TaskHandle {
  tier: ClaudeTier;
  /** What the chosen tier does not enforce, for the evidence record. */
  limitations: string[];
  sessionId: string;
}

export interface ClaudeAdapterOptions {
  /** The claude CLI, e.g. ['claude'] (default) or [node, tests/fakes/fake-claude.mjs]. */
  command?: string[];
  /** Used for the os-sandbox tier; sandbox-runtime is the only provider verified around `claude`. */
  isolation?: IsolationProvider | null;
  /** 'auto' (default): os-sandbox when an env credential and srt are available, else claude-sandbox. */
  tier?: ClaudeTier | 'auto';
  /** Where allowlisted environment values come from. Default process.env. */
  baseEnv?: Record<string, string | undefined>;
  shimCommand?: string[];
  hookCommand?: string[];
  /** Grace period between cancellation signals. Default 5 s. */
  graceMs?: number;
  /** Effort levels a model supports (from the model registry); null when unknown. */
  modelEfforts?: (model: string) => readonly string[] | null;
  /** Exact model ids for discoverCapabilities (from the model registry). */
  models?: () => string[];
  extraArgs?: string[];
  /** Installed CLI version, if already known; discoverCapabilities records it. */
  cliVersion?: string | null;
  clock?: Clock;
  id?: string;
  /**
   * Extra variable names copied from baseEnv into the worker and into probe
   * commands, for stand-ins configured through the environment (the fakes'
   * ORBIT_FAKE_SCENARIO). Credentials and delivery variables are still refused.
   */
  passEnv?: string[];
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly opts: ClaudeAdapterOptions;
  private readonly command: string[];
  private readonly clock: Clock;
  private cliVersion: string | null;
  private isolationOk: boolean | null = null;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.opts = opts;
    this.id = opts.id ?? 'claude';
    this.command = opts.command && opts.command.length > 0 ? [...opts.command] : ['claude'];
    this.clock = opts.clock ?? systemClock;
    this.cliVersion = opts.cliVersion ?? null;
    assertClaudeExtraArgs(opts.extraArgs ?? []);
  }

  async discoverCapabilities(): Promise<ProviderCapabilities> {
    const r = await this.run(['--version'], { timeoutMs: 30_000 });
    const version = r.ok ? parseClaudeVersion(r.stdout) : null;
    if (version) this.cliVersion = version;
    return {
      provider: this.id,
      available: r.ok && version !== null,
      version,
      models: this.opts.models?.() ?? [],
      structuredOutput: true,
      readOnlySandbox: true,
      usageReporting: 'exact',
      costReporting: true,
      detail: r.ok ? `claude ${version ?? 'unknown version'}` : `claude --version failed: ${r.detail}`,
    };
  }

  /**
   * `claude auth status --json` with the environment a worker would get.
   * It reports which credential is present, not whether it works: a fake
   * API key reports logged in, and an expired login is only discovered by
   * a request. A present credential is therefore 'unknown' until
   * probeCredentials (a real, tiny model call) says otherwise.
   */
  async validateCredentials(): Promise<CredentialStatus> {
    const r = await this.run(['auth', 'status', '--json'], { timeoutMs: 30_000 });
    let status: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(r.stdout) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) status = parsed as Record<string, unknown>;
    } catch {
      status = null;
    }
    if (!status) return { state: 'unknown', method: null, detail: `claude auth status gave no JSON (${r.detail})` };
    const method = typeof status.authMethod === 'string' ? status.authMethod : null;
    if (status.loggedIn !== true || r.exitCode !== 0) return { state: 'missing', method, detail: 'claude reports no credential; run `claude auth login` or set ANTHROPIC_API_KEY' };
    const envCred = claudeEnvCredential(this.baseEnv());
    const tierNote = envCred
      ? `${envCred} is set, so workers can run in the os-sandbox tier`
      : 'no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the environment, so workers run in the claude-sandbox tier (a keychain login is invisible inside srt)';
    return {
      state: 'unknown',
      method,
      detail: `credential present (${method ?? 'unknown method'}); claude auth status does not verify it and cannot detect an expired or revoked credential (probeCredentials makes a live check); ${tierNote}`,
    };
  }

  /**
   * Opt-in live check: one minimal `-p` request with one retry and no
   * tools. Costs a tiny model call. Blocks within seconds on a bad key
   * instead of the CLI's default ~3 minutes of retries.
   */
  async probeCredentials(opts: { model?: string; timeoutMs?: number } = {}): Promise<CredentialStatus> {
    // An empty directory as cwd, and no CLAUDE.md loading: the probe must not
    // send the controller's repository instructions (its cwd) to the API.
    const env = { ...this.workerEnvForProbe(), CLAUDE_CODE_MAX_RETRIES: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--tools', '', '--permission-mode', 'dontAsk', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--model', opts.model ?? 'haiku'];
    const cwd = mkdtempSync(join(tmpdir(), 'orbit-probe-'));
    let r: Awaited<ReturnType<typeof execCapture>>;
    try {
      r = await execCapture([...this.command, ...args], { env, cwd, input: 'Reply with OK.', timeoutMs: opts.timeoutMs ?? 60_000 });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    const lines = parseJsonLines(r.stdout);
    const res = classifyClaudeTranscript({
      events: lines.events,
      malformedTail: lines.malformedTail,
      exit: { version: 1, code: r.exitCode, signal: r.signal, timedOut: r.timedOut, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 0, endedAt: r.durationMs },
      outputSchema: {},
    });
    const init = lines.events.find((e) => e.type === 'system' && e.subtype === 'init');
    const method = typeof init?.apiKeySource === 'string' ? init.apiKeySource : null;
    if (res.status === 'auth_failed') {
      const missing = (res.text ?? '').startsWith('Not logged in');
      return { state: missing ? 'missing' : 'invalid', method, detail: res.error ?? 'authentication failed' };
    }
    if (res.reason === 'structured_output_missing' || res.status === 'succeeded') return { state: 'valid', method, detail: 'a live request succeeded' };
    return { state: 'unknown', method, detail: `live check inconclusive: ${res.error ?? res.status}` };
  }

  async startTask(spec: ClaudeTaskSpec): Promise<ClaudeTaskHandle> {
    validateSpec(spec);
    const sessionId = spec.sessionId ?? nextSessionId(spec.workerId, spec.workerDir);
    // A launch already exists for this worker directory: reattach, never respawn.
    const prior = readJsonIfExists<LaunchRecord>(join(spec.workerDir, LAUNCH_FILE));
    if (prior) {
      const handle = await reattachLaunch(this.id, spec.workerDir, spec.workerId, this.clock);
      const meta = (prior.meta ?? {}) as { tier?: ClaudeTier; limitations?: string[] };
      return { ...handle, tier: meta.tier ?? 'claude-sandbox', limitations: meta.limitations ?? [], sessionId: prior.sessionId ?? sessionId };
    }

    const policyHash = spec.policyHash ?? snapshotFileHash(spec.policyPath);
    const snapshot = verifySnapshot(spec.policyPath, policyHash);
    const worktree = canonicalPath(spec.cwd);
    const workerDir = spec.workerDir;
    const commands = defaultOrbitCommands();
    const hookCommand = this.opts.hookCommand ?? commands.hook;
    const shimCommand = this.opts.shimCommand ?? commands.shim;
    const tmpDir = prepareWorkerTmpDir(workerDir);
    const baseEnv = this.baseEnv();
    const tier = await this.chooseTier(baseEnv);
    // The verified mechanism is CLAUDE_CODE_MAX_OUTPUT_TOKENS (the request's max_tokens); the instruction keeps the model inside it rather than cut off.
    const outputTokens = outputBudgetFor(spec.role, { explicit: spec.outputTokens, configured: snapshot.config.routing.output_budgets });
    const env = buildWorkerEnv({ provider: 'claude', base: baseEnv, policyPath: spec.policyPath, policyHash, worktree, tmpDir, maxOutputTokens: outputTokens, extra: { ...passThrough(this.baseEnv(), this.opts.passEnv), ...spec.env } });

    const settings = renderClaudeSettings({
      snapshot,
      worktree,
      workerDir: canonicalPath(workerDir),
      policyPath: canonicalPath(spec.policyPath),
      tier,
      readOnly: spec.readOnly,
      experiments: spec.experiments ?? false,
      hookCommand,
      denyReadPaths: spec.sandbox.denyReadPaths,
      readablePaths: readablePathsOf(spec.sandbox),
      tmpDir,
    });
    assertClaudeSettings(settings);
    writePrivate(join(workerDir, PROMPT_FILE), outputTokens === null ? spec.prompt : `${spec.prompt.trimEnd()}\n\n${outputBudgetInstruction(outputTokens)}\n`);
    writePrivate(join(workerDir, SYSTEM_FILE), spec.systemPrompt);
    atomicWriteJson(join(workerDir, SETTINGS_FILE), settings, 0o600);

    const effort = this.effortFor(spec.model, spec.effort);
    const argv = buildClaudeArgv({
      command: this.command,
      sessionId,
      model: spec.model,
      effort: effort.value,
      maxTurns: spec.maxTurns,
      maxBudgetUsd: spec.maxBudgetUsd ?? null,
      readOnly: spec.readOnly,
      experiments: spec.experiments ?? false,
      tier,
      allowedHosts: snapshot.config.network.allowed_hosts,
      settingsPath: join(workerDir, SETTINGS_FILE),
      systemPromptPath: join(workerDir, SYSTEM_FILE),
      outputSchema: spec.outputSchema,
      permissionPrompts: this.supportsPermissionPrompts(),
      extraArgs: this.opts.extraArgs ?? [],
    });

    const limitations = [...effort.notes];
    let launchArgv = argv;
    let launchEnv = env;
    const cleanupPaths: string[] = [];
    if (tier === 'os-sandbox') {
      const isolation = this.opts.isolation!;
      const wrapped = isolation.wrap(argv, readOnlyProfile(spec.sandbox, worktree, spec.readOnly), { cwd: worktree, env });
      launchArgv = wrapped.argv;
      launchEnv = wrapped.env;
      cleanupPaths.push(...wrapperTempDirs(wrapped.argv));
      limitations.push(...wrapped.limitations, "Claude Code's own Bash sandbox is off in this tier: it cannot start inside srt (nested Seatbelt fails).");
    } else {
      limitations.push(...CLAUDE_SANDBOX_LIMITATIONS);
    }

    const handle = await launchShim({
      provider: this.id,
      workerId: spec.workerId,
      workerDir,
      cwd: worktree,
      shimCommand,
      argv: launchArgv,
      env: launchEnv,
      timeoutMs: spec.timeoutMs,
      graceMs: this.opts.graceMs,
      sessionId,
      stdinPath: join(workerDir, PROMPT_FILE),
      abortOn: CLAUDE_ABORT_PATTERNS,
      cleanupPaths,
      // The plugin policy the session is judged by at collection, from the verified snapshot. launch.json is
      // read-only to the worker (WORKER_DIR_READ_ONLY), so a worker cannot widen it.
      meta: { tier, limitations, outputBudgetTokens: outputTokens, pluginPolicy: pluginPolicyOf(snapshot.config) },
      clock: this.clock,
    });
    return { ...handle, tier, limitations, sessionId };
  }

  async streamEvents(handle: TaskHandle, fromOffset: number): Promise<{ events: ProviderEvent[]; nextOffset: number }> {
    const { lines, nextOffset } = readNewLines(handle.logPath, fromOffset);
    return { events: claudeEvents(lines, this.clock.now()), nextOffset };
  }

  async cancelTask(handle: TaskHandle): Promise<void> {
    await cancelShim(handle, this.opts.graceMs ?? 5_000, this.clock);
  }

  async collectResult(handle: TaskHandle, spec: Pick<TaskSpec, 'outputSchema'>): Promise<ClaudeTaskResult | null> {
    const st = taskState(handle);
    if (st.state === 'running') return null;
    const log = readLogLines(handle.logPath);
    let result: ClaudeTaskResult;
    if (st.state === 'lost') {
      const usage = claudeUsage(log.events);
      result = {
        status: st.cancelRequested ? 'cancelled' : 'lost',
        reason: st.cancelRequested ? 'interrupted' : 'crashed',
        structured: null,
        text: null,
        error: `the worker shim ended without writing exit.json${st.orphans ? '; its provider process is still running (call cancelTask)' : ''}`,
        exitCode: null,
        usage,
        durationMs: null,
        sessionId: st.pid?.sessionId ?? null,
        models: [],
        permissionDenials: [],
        numTurns: null,
        terminalReason: null,
      };
    } else {
      const init = log.events.find((e) => e.type === 'system' && e.subtype === 'init');
      // system/init carries no plugin scope (2.1.288-2.1.291), so a non-built-in plugin's scope comes from the plugin list.
      const listed = needsPluginList(init?.plugins) ? await this.listPlugins() : null;
      const plugins = { policy: launchPluginPolicy(handle.workerDir), installed: listed?.ok ? listed.plugins : null };
      result = classifyClaudeTranscript({ events: log.events, malformedTail: log.malformedTail, exit: st.exit, outputSchema: spec.outputSchema, expectedSessionId: st.pid?.sessionId ?? null, plugins });
      // A CLI that died before its transcript says why only on stderr; without it the block reads "exited 1 without a result line".
      const stderr = result.reason === 'crashed' ? stderrTail(handle.workerDir) : null;
      if (stderr) result = { ...result, error: `${result.error ?? 'crashed'}; stderr: ${stderr}` };
    }
    result = { ...result, usage: withWorkerTelemetry(result.usage, handle.workerDir) };
    atomicWriteJson(join(handle.workerDir, RESULT_FILE), result, 0o600);
    return result;
  }

  async reportUsage(handle: TaskHandle): Promise<UsageReport> {
    if (!existsSync(handle.logPath)) return emptyUsage(this.id);
    return withWorkerTelemetry(claudeUsage(readLogLines(handle.logPath).events), handle.workerDir);
  }

  /**
   * `claude plugin list --json` with the environment a probe gets: the installed plugins with their scope, which
   * system/init does not report. Used to judge a session's plugins and by doctor before any run.
   */
  async listPlugins(): Promise<{ ok: true; plugins: InstalledPlugin[] } | { ok: false; detail: string }> {
    const r = await this.run(['plugin', 'list', '--json'], { timeoutMs: 30_000 });
    if (!r.ok) return { ok: false, detail: `claude plugin list --json: ${r.detail}` };
    const plugins = parsePluginList(r.stdout);
    return plugins ? { ok: true, plugins } : { ok: false, detail: 'claude plugin list --json gave no plugin list' };
  }

  /** Reattach to a worker from its directory alone (pid.json), as a restarted controller does. */
  reattach(workerDir: string): TaskHandle | null {
    return handleFromWorkerDir(this.id, workerDir);
  }

  // -------------------------------------------------------------------------

  private baseEnv(): Record<string, string | undefined> {
    return this.opts.baseEnv ?? process.env;
  }

  private workerEnvForProbe(): Record<string, string> {
    const base = this.baseEnv();
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
      const v = base[k];
      if (typeof v === 'string' && v !== '') env[k] = v;
    }
    return { ...env, ...passThrough(base, this.opts.passEnv), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  }

  private async run(args: string[], o: { timeoutMs: number }): Promise<{ ok: boolean; exitCode: number | null; stdout: string; detail: string }> {
    try {
      const r = await execCapture([...this.command, ...args], { env: this.workerEnvForProbe(), timeoutMs: o.timeoutMs });
      const detail = r.timedOut ? 'timed out' : `exit ${r.exitCode ?? r.signal}${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : ''}`;
      return { ok: r.exitCode === 0, exitCode: r.exitCode, stdout: r.stdout, detail };
    } catch (err) {
      return { ok: false, exitCode: null, stdout: '', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chooseTier(env: Record<string, string | undefined>): Promise<ClaudeTier> {
    const wanted = this.opts.tier ?? 'auto';
    const cred = claudeEnvCredential(env);
    const isolation = this.opts.isolation ?? null;
    const srt = isolation !== null && isolation.kind === 'sandbox-runtime';
    if (wanted === 'claude-sandbox') return 'claude-sandbox';
    if (wanted === 'os-sandbox') {
      if (!cred) throw new OrbitError('AUTH_MISSING', 'the os-sandbox worker tier needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the environment: a keychain login is invisible inside the sandbox');
      if (!srt) throw new OrbitError('ISOLATION_UNAVAILABLE', 'the os-sandbox worker tier needs the sandbox-runtime isolation provider');
      return 'os-sandbox';
    }
    if (cred && srt) {
      // The availability probe starts a sandboxed process; once per adapter is enough.
      this.isolationOk ??= (await isolation.available()).ok;
      if (this.isolationOk) return 'os-sandbox';
    }
    return 'claude-sandbox';
  }

  private effortFor(model: string | null, effort: string | null): { value: string | null; notes: string[] } {
    if (effort === null) return { value: null, notes: [] };
    if (!CLAUDE_EFFORTS.includes(effort)) throw new OrbitError('CONFIG_INVALID', `unknown Claude effort level ${JSON.stringify(effort)}; expected one of ${CLAUDE_EFFORTS.join(', ')}`);
    const supported = model ? (this.opts.modelEfforts?.(model) ?? knownEfforts(model)) : null;
    if (supported === null) return { value: effort, notes: [] };
    if (supported.includes(effort)) return { value: effort, notes: [] };
    return { value: null, notes: [`effort ${effort} is not supported by ${model}; the model's default effort applies`] };
  }

  private supportsPermissionPrompts(): boolean {
    return this.cliVersion === null || compareVersions(this.cliVersion, PERMISSION_PROMPTS_MIN_VERSION) >= 0;
  }
}

/** Stop on the first authentication failure instead of waiting out the CLI's retries (gaps V2). */
export const CLAUDE_ABORT_PATTERNS: AbortPattern[] = CLAUDE_AUTH_ERRORS.map((error) => ({ type: 'system', subtype: 'api_retry', error }));

/** What the claude-sandbox tier does not enforce (ADR 0001). */
export const CLAUDE_SANDBOX_LIMITATIONS: readonly string[] = [
  "Edit and Write are confined by Claude Code's permission rules and Orbit's PreToolUse guard, not by the operating system.",
  "Only Bash commands run inside Claude Code's sandbox; Read, Edit, Write, hooks and the CLI itself run outside it.",
  'The Claude Code process itself can read anything the user can; only the permission deny rules keep its file tools away from credentials.',
  'An invalid settings file would silently disable the sandbox in -p mode; Orbit validates the file before every spawn.',
];

export interface ClaudeArgvInput {
  command: string[];
  sessionId: string;
  model: string | null;
  effort: string | null;
  maxTurns: number;
  maxBudgetUsd: number | null;
  readOnly: boolean;
  /** A read-only experiment worker (diagnosis): Bash is granted (see bashGrant), edits never. */
  experiments?: boolean;
  tier: ClaudeTier;
  allowedHosts: readonly string[];
  settingsPath: string;
  systemPromptPath: string;
  outputSchema: object;
  permissionPrompts: boolean;
  extraArgs: string[];
}

/** The worker argv. List flags are single comma-joined values so no variadic flag can swallow the next argument. */
export function buildClaudeArgv(i: ClaudeArgvInput): string[] {
  const tools = [...READ_TOOLS, ...(i.readOnly ? [] : EDIT_TOOLS), 'Bash'];
  const web = i.allowedHosts.length > 0;
  if (web) tools.push('WebFetch');
  // Auto-approved: reading, and for writers and experiment workers Bash only where an OS sandbox
  // confines it. Edits are allowed per path by the settings file, never by
  // a bare `Edit` here (which would allow every path).
  const allowed = [...READ_TOOLS, ...(bashGrant({ readOnly: i.readOnly, experiments: i.experiments ?? false, tier: i.tier }).allowRule ? ['Bash'] : []), ...i.allowedHosts.map((h) => `WebFetch(domain:${h})`)];
  const disallowed = [...ALWAYS_DISALLOWED, ...(web ? [] : ['WebFetch']), ...(i.readOnly ? EDIT_TOOLS : [])];
  const argv = [
    ...i.command,
    '-p',
    '--session-id',
    i.sessionId,
    '--output-format',
    'stream-json',
    '--verbose',
    ...(i.model ? ['--model', i.model] : []),
    ...(i.effort ? ['--effort', i.effort] : []),
    '--max-turns',
    String(i.maxTurns),
    ...(i.maxBudgetUsd !== null ? ['--max-budget-usd', String(i.maxBudgetUsd)] : []),
    '--permission-mode',
    'dontAsk',
    ...(i.permissionPrompts ? ['--permission-prompts', 'none'] : []),
    '--tools',
    tools.join(','),
    '--allowedTools',
    allowed.join(','),
    '--disallowedTools',
    disallowed.join(','),
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--settings',
    i.settingsPath,
    '--append-system-prompt-file',
    i.systemPromptPath,
    '--json-schema',
    JSON.stringify(i.outputSchema),
    ...i.extraArgs,
  ];
  return argv;
}

/** Allowed extra flags that take a value (as the next argument or after `=`). */
const CLAUDE_EXTRA_ARGS_WITH_VALUE: readonly string[] = ['--fallback-model'];

export function assertClaudeExtraArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // A bare word is not inert: after a boolean flag, claude reads it as the
    // prompt (or part of it). Values are accepted only where a flag takes one.
    if (!a.startsWith('-')) {
      throw new OrbitError('CONFIG_INVALID', `providers.claude.extra_args: ${JSON.stringify(a)} is not a flag or the value of one`, { arg: a });
    }
    const [flag, inline] = [a.split('=')[0]!, a.includes('=')];
    if (!CLAUDE_EXTRA_ARGS_ALLOWED.includes(flag)) {
      throw new OrbitError('CONFIG_INVALID', `providers.claude.extra_args: ${flag} is not allowed; Orbit sets permission, settings, tool and session flags itself (allowed: ${CLAUDE_EXTRA_ARGS_ALLOWED.join(', ')})`, { flag });
    }
    if (CLAUDE_EXTRA_ARGS_WITH_VALUE.includes(flag) && !inline) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) throw new OrbitError('CONFIG_INVALID', `providers.claude.extra_args: ${flag} needs a value`, { flag });
      i++;
    }
  }
}

function validateSpec(spec: ClaudeTaskSpec): void {
  for (const [name, p] of [['cwd', spec.cwd], ['workerDir', spec.workerDir], ['policyPath', spec.policyPath]] as const) {
    if (!isAbsolute(p)) throw new OrbitError('CONFIG_INVALID', `TaskSpec.${name} must be absolute: ${p}`);
  }
  if (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory()) throw new OrbitError('NOT_FOUND', `worker cwd does not exist: ${spec.cwd}`);
  if (!Number.isSafeInteger(spec.maxTurns) || spec.maxTurns < 1) throw new OrbitError('CONFIG_INVALID', `maxTurns must be a positive integer, got ${spec.maxTurns}`);
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1) throw new OrbitError('CONFIG_INVALID', `timeoutMs must be a positive integer, got ${spec.timeoutMs}`);
  if (spec.model !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/.test(spec.model)) throw new OrbitError('CONFIG_INVALID', `invalid model id ${JSON.stringify(spec.model)}`);
  if (spec.maxBudgetUsd != null && !(spec.maxBudgetUsd > 0)) throw new OrbitError('CONFIG_INVALID', 'maxBudgetUsd must be positive');
  // --json-schema fails fast on an invalid schema, but a schema outside the
  // strict subset would be rejected by Codex and is out of contract here too.
  const violations = strictSchemaViolations(spec.outputSchema);
  if (violations.length > 0) {
    throw new OrbitError('SCHEMA_INVALID', `output schema is outside the strict structured-output subset: ${violations.slice(0, 5).join('; ')}`, { violations });
  }
}

/** sha256 of the snapshot as stored; verifySnapshot then checks the file's mode and owner too. */
export function snapshotFileHash(path: string): string {
  const snap = readJsonIfExists<PolicySnapshot>(path);
  if (!snap) throw new OrbitError('POLICY_TAMPERED', `policy snapshot not found: ${path}`, { path });
  return snapshotHash(snap);
}

/**
 * A read-only role's sandbox drops the worktree from the writable set and
 * keeps it readable. Worktrees live under ~/.orbit (or beside a denied
 * checkout), which the profile read-denies; only the writable set re-opened
 * them. Without the read grant the CLI cannot resolve its own working
 * directory and dies before its first request ("An unknown error occurred
 * (Unexpected)", exit 1, no transcript), so every read-only role failed in
 * this tier and a bad key was reported as a crash, not a credential failure.
 */
export function readOnlyProfile(profile: SandboxProfile, worktree: string, readOnly: boolean): SandboxProfile {
  if (!readOnly) return profile;
  const narrowed: SandboxProfile & { readablePaths: string[] } = {
    ...profile,
    writablePaths: profile.writablePaths.filter((p) => !isWithin(canonicalPath(p), worktree)),
    readablePaths: [...new Set([...readablePathsOf(profile), worktree])],
  };
  return narrowed;
}

/** Per-invocation settings directories an isolation wrapper created in the temp directory. */
function wrapperTempDirs(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (!isAbsolute(a)) continue;
    const dir = dirname(a);
    if (basename(dir).startsWith('orbit-srt-')) out.push(dir);
  }
  return [...new Set(out)];
}

/** The last lines of the worker's stderr.log (already redacted by the shim; redacted again here), at most 300 characters, or null. */
export function stderrTail(workerDir: string, maxChars = 300): string | null {
  let text: string;
  try {
    text = readFileSync(join(workerDir, STDERR_FILE), 'utf8');
  } catch {
    return null;
  }
  const lines = redact(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  let tail = lines.slice(-3).join(' | ');
  if (tail.length > maxChars) tail = `...${tail.slice(-(maxChars - 3))}`;
  return tail;
}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
}

/**
 * Effort support from the verified notes (claude-headless-and-sandbox.md
 * section 5): Haiku 4.5 has none; Opus 4.6 and Sonnet 4.6 have no xhigh; the
 * 5.x families and Opus 4.7/4.8 support low through max. Null when the model
 * is not recognized; then the effort is passed and the CLI decides.
 */
export function knownEfforts(model: string): readonly string[] | null {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return [];
  if (/(opus|sonnet)-4-6/.test(m)) return ['low', 'medium', 'high', 'max'];
  if (/^(fable|opus|sonnet|best|default)$/.test(m) || /claude-(fable|opus|sonnet)-5/.test(m) || /claude-opus-4-[78]/.test(m)) return CLAUDE_EFFORTS;
  return null;
}

export function parseClaudeVersion(text: string): string | null {
  const m = /(\d+\.\d+\.\d+)/.exec(text);
  return m ? m[1]! : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The plugin policy recorded at launch; a launch without one (older, or unreadable) is judged by the strict default. */
function launchPluginPolicy(workerDir: string): PluginPolicy {
  const meta = readJsonIfExists<LaunchRecord>(join(workerDir, LAUNCH_FILE))?.meta as { pluginPolicy?: { allowed?: unknown; allowManaged?: unknown } } | undefined;
  const p = meta?.pluginPolicy;
  if (!p || !Array.isArray(p.allowed)) return STRICT_PLUGIN_POLICY;
  return { allowed: p.allowed.filter((id): id is string => typeof id === 'string'), allowManaged: p.allowManaged === true };
}
