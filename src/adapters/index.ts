/**
 * Provider adapters (spec section 12) and the registry that builds them
 * from configuration. `providers.<id>.command` names the CLI; when it names
 * one of the fake scripts (tests/fakes/fake-claude.mjs, fake-codex.mjs) the
 * registry returns a FakeAdapter, which is how acceptance and
 * fault-injection tests run the whole controller without a model.
 */
import { basename } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import type { IsolationProvider } from '../isolation/types.ts';
import type { OrbitConfig, ProviderConfig } from '../policy/types.ts';
import { ClaudeAdapter, type ClaudeTier } from './claude.ts';
import { CodexAdapter } from './codex.ts';
import { FakeAdapter, fakeKind } from './fake.ts';
import type { ProviderAdapter } from './types.ts';

export * from './types.ts';
export { ClaudeAdapter, buildClaudeArgv, assertClaudeExtraArgs, knownEfforts, parseClaudeVersion, compareVersions, readOnlyProfile, snapshotFileHash, CLAUDE_ABORT_PATTERNS, CLAUDE_SANDBOX_LIMITATIONS, CLAUDE_EFFORTS, ALWAYS_DISALLOWED } from './claude.ts';
export type { ClaudeAdapterOptions, ClaudeTaskHandle, ClaudeTaskSpec, ClaudeTier, ClaudeArgvInput } from './claude.ts';
export { renderClaudeSettings, claudeSettingsProblems, assertClaudeSettings, absRule, CLAUDE_SETTINGS_SCHEMA, GUARD_MATCHER } from './claude-settings.ts';
export type { ClaudeSettings, ClaudeSettingsInput } from './claude-settings.ts';
export { classifyClaudeTranscript, claudeUsage, claudeEvents, subtractUsage, sessionProblems, CLAUDE_END_REASONS, CLAUDE_AUTH_ERRORS, CLAUDE_TRANSIENT_ERRORS } from './claude-transcript.ts';
export type { ClaudeTaskResult, ClaudeEndReason } from './claude-transcript.ts';
export { CodexAdapter, buildCodexArgv, parseHelpFlags, parseDoctorChecks, CODEX_EFFORTS, CODEX_LIMITATIONS, CODEX_REQUIRED_FLAGS } from './codex.ts';
export type { CodexAdapterOptions, CodexTaskHandle, CodexTaskSpec, CodexTier } from './codex.ts';
export { classifyCodexTranscript, codexUsage, codexEvents, CODEX_END_REASONS } from './codex-events.ts';
export type { CodexTaskResult, CodexEndReason } from './codex-events.ts';
export { FakeAdapter, FAKE_ENV_KEYS, FAKE_SCRIPTS, fakeKind } from './fake.ts';
export type { FakeAdapterOptions, FakeProvider } from './fake.ts';
export { runShim, shimMain, parseShimArgs, shimArgs, readPidRecord, readExitRecord, PID_FILE, EXIT_FILE, LOG_FILE, STDERR_FILE } from './shim.ts';
export type { ShimOptions, PidRecord, ExitRecord, AbortPattern } from './shim.ts';
export { launchShim, reattachLaunch, handleFromWorkerDir, taskState, cancelShim, archiveAttempt, archivedAttempts, ATTEMPT_FILES, nextSessionId, sessionIdFor, readLogLines, readNewLines, LAUNCH_FILE, CANCEL_FILE } from './supervise.ts';
export type { TaskState, LaunchRecord } from './supervise.ts';
export { buildWorkerEnv, claudeEnvCredential, passThrough, CLAUDE_WORKER_ENV, PROVIDER_ENV_KEYS, ENV_MAX_OUTPUT_TOKENS } from './env.ts';
export { renderWorkerPrompt, renderSystemPrompt, readRolePrompt, stripFrontmatter, fence, ROLE_OUTPUT_KIND, ROLE_OUTPUT_TOKENS, AGENT_ROLES, outputBudgetFor, outputBudgetInstruction } from './prompt.ts';
export type { AgentRole, WorkerPromptInput, EvidenceRef, PromptBrief } from './prompt.ts';
export { defaultOrbitCommands, orbitCommands, sourceCommands } from './commands.ts';

export type ProviderKind = 'claude' | 'codex';

export interface AdapterDeps {
  /** Isolation provider for os-sandbox tiers; null disables wrapping. */
  isolation?: IsolationProvider | null;
  baseEnv?: Record<string, string | undefined>;
  shimCommand?: string[];
  hookCommand?: string[];
  graceMs?: number;
  clock?: Clock;
  /** Policy choice of Claude worker tier; 'auto' picks os-sandbox when it can. */
  claudeTier?: ClaudeTier | 'auto';
  modelEfforts?: (model: string) => readonly string[] | null;
  models?: (provider: ProviderKind) => string[];
}

/** The provider family an id configures: `claude`, `codex`, or an id starting with one of them (`claude-review`). */
export function providerKind(id: string): ProviderKind {
  if (id === 'claude' || id.startsWith('claude-') || id.startsWith('claude_')) return 'claude';
  if (id === 'codex' || id.startsWith('codex-') || id.startsWith('codex_')) return 'codex';
  throw new OrbitError('CONFIG_INVALID', `providers.${id}: unknown provider; Orbit has adapters for claude and codex`, { provider: id });
}

/** argv for a configured command string: scripts run under this Node, binaries as they are. */
export function commandArgv(command: string): string[] {
  return /\.(mjs|cjs|js)$/.test(basename(command)) ? [process.execPath, command] : [command];
}

export function createAdapter(id: string, config: ProviderConfig, deps: AdapterDeps = {}): ProviderAdapter {
  const kind = providerKind(id);
  const common = { baseEnv: deps.baseEnv, shimCommand: deps.shimCommand, graceMs: deps.graceMs, clock: deps.clock, isolation: deps.isolation ?? null, extraArgs: config.extra_args, id };
  const fake = fakeKind(config.command);
  if (fake) {
    if (fake !== kind) throw new OrbitError('CONFIG_INVALID', `providers.${id}.command points at the ${fake} fake`, { provider: id });
    return fake === 'claude'
      ? new FakeAdapter({ provider: 'claude', script: config.command, ...common, hookCommand: deps.hookCommand, tier: deps.claudeTier, modelEfforts: deps.modelEfforts, models: deps.models ? () => deps.models!('claude') : undefined })
      : new FakeAdapter({ provider: 'codex', script: config.command, ...common });
  }
  if (kind === 'claude') {
    return new ClaudeAdapter({
      ...common,
      command: commandArgv(config.command),
      hookCommand: deps.hookCommand,
      tier: deps.claudeTier,
      modelEfforts: deps.modelEfforts,
      models: deps.models ? () => deps.models!('claude') : undefined,
    });
  }
  return new CodexAdapter({ ...common, command: commandArgv(config.command) });
}

/** One adapter per configured provider. */
export function createAdapters(config: Pick<OrbitConfig, 'providers'>, deps: AdapterDeps = {}): Record<string, ProviderAdapter> {
  const out: Record<string, ProviderAdapter> = {};
  for (const [id, pc] of Object.entries(config.providers)) out[id] = createAdapter(id, pc, deps);
  return out;
}
