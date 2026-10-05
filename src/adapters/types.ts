/**
 * Provider adapters (spec §12). Claude and Codex implement this interface;
 * other providers can add their own. Methods map 1:1 to the spec:
 * discoverCapabilities, validateCredentials, startTask, streamEvents,
 * cancelTask, collectResult, reportUsage.
 *
 * Tasks run as detached processes whose output goes to files in the worker
 * directory, never to pipes held by the controller. A restarted controller
 * reattaches to a running task from its TaskHandle alone; that is what keeps a
 * controller crash from spawning a duplicate worker.
 */
import type { SandboxProfile } from '../isolation/types.ts';

export type WorkerRole = 'planner' | 'implementer' | 'verifier' | 'reviewer' | 'inquisitor' | 'curator' | 'explorer';

export interface ProviderCapabilities {
  provider: string;
  available: boolean;
  version: string | null;
  /** Exact model ids this surface accepts, when discoverable. */
  models: string[];
  structuredOutput: boolean;
  readOnlySandbox: boolean;
  usageReporting: 'exact' | 'partial' | 'none';
  costReporting: boolean;
  detail: string;
}

export type CredentialState = 'valid' | 'missing' | 'expired' | 'invalid' | 'unknown';

export interface CredentialStatus {
  state: CredentialState;
  method: string | null;
  detail: string;
}

export interface TaskSpec {
  runId: string;
  workerId: string;
  role: WorkerRole;
  /** Exact model id; null means the provider's configured default. */
  model: string | null;
  effort: string | null;
  /** Working directory: the worker's worktree, or a read-only review checkout. */
  cwd: string;
  /** Where the adapter writes prompt, settings, logs, pid and exit files. */
  workerDir: string;
  prompt: string;
  /** Role instructions (agents/<role>.md body), appended to the provider's system prompt. */
  systemPrompt: string;
  /** JSON Schema the final structured output must satisfy. */
  outputSchema: object;
  readOnly: boolean;
  maxTurns: number;
  timeoutMs: number;
  sandbox: SandboxProfile;
  /** Path to the frozen policy snapshot the worker's guard hook enforces. */
  policyPath: string;
  /** Hash of the policy snapshot, passed to the guard hook; adapters derive it from the file when absent. */
  policyHash?: string;
  /** Provider session id, persisted on the worker row before spawn so a crash can resume rather than duplicate. */
  sessionId?: string;
  /** Environment for the task. Adapters start from a scrubbed base and add only these. */
  env: Record<string, string>;
  /**
   * Output token budget for this task (routing.output_budgets for the role).
   * Absent: the policy snapshot's routing.output_budgets for the role, else
   * ROLE_OUTPUT_TOKENS. null: no budget. The Claude adapter enforces it as
   * CLAUDE_CODE_MAX_OUTPUT_TOKENS (a verified per-request max_tokens cap);
   * Codex has no verified output cap, so the budget is an instruction in the
   * prompt and overruns are measured and recorded.
   */
  outputTokens?: number | null;
}

export interface TaskHandle {
  provider: string;
  workerId: string;
  workerDir: string;
  /** Supervisor (shim) process; it owns the provider process and writes exit.json. */
  pid: number;
  pgid: number;
  /** Process start time, to tell a live task from a recycled pid. */
  procStart: string | null;
  logPath: string;
  exitPath: string;
}

export type ProviderEvent =
  | { type: 'started'; at: number }
  | { type: 'message'; at: number; text: string }
  | { type: 'tool'; at: number; tool: string; summary: string }
  | { type: 'usage'; at: number; usage: UsageReport }
  | { type: 'error'; at: number; message: string }
  | { type: 'finished'; at: number };

export type TaskStatus =
  | 'succeeded'
  | 'failed'
  | 'max_turns'
  | 'timeout'
  | 'cancelled'
  | 'auth_failed'
  | 'transient_error'
  | 'malformed_output'
  | 'lost';

export const TASK_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'max_turns', 'timeout', 'cancelled', 'auth_failed', 'transient_error', 'malformed_output', 'lost'];

export interface TaskResult {
  status: TaskStatus;
  /** Validated against TaskSpec.outputSchema when status is 'succeeded'. */
  structured: unknown;
  text: string | null;
  error: string | null;
  exitCode: number | null;
  usage: UsageReport;
  durationMs: number | null;
}

export interface UsageReport {
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  /** 'reported' by the provider, 'estimated' from tokens x pricing, or 'unavailable'. Never silently zero. */
  costSource: 'reported' | 'estimated' | 'unavailable';
  /** Milliseconds from spawn to the first line of provider output, from the worker log; absent when not measured. */
  timeToFirstEventMs?: number | null;
  /** The output token budget the task launched under; absent when it ran without one or the record predates budgets. */
  outputBudgetTokens?: number | null;
}

export interface ProviderAdapter {
  readonly id: string;
  discoverCapabilities(): Promise<ProviderCapabilities>;
  validateCredentials(): Promise<CredentialStatus>;
  /** Spawn detached. Must be safe to call once per workerId; the caller persists intent first. */
  startTask(spec: TaskSpec): Promise<TaskHandle>;
  /** Parse events from the task log starting at a byte offset; returns events and the next offset. */
  streamEvents(handle: TaskHandle, fromOffset: number): Promise<{ events: ProviderEvent[]; nextOffset: number }>;
  cancelTask(handle: TaskHandle): Promise<void>;
  /** null while the task is still running. */
  collectResult(handle: TaskHandle, spec: Pick<TaskSpec, 'outputSchema'>): Promise<TaskResult | null>;
  reportUsage(handle: TaskHandle): Promise<UsageReport>;
}
