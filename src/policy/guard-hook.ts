/**
 * The PreToolUse guard hook (`orbit hook pre-tool-use`), implementing the
 * verified contract in docs/interfaces/claude-code-plugin.md §4:
 *
 *   stdin   one JSON object: hook_event_name "PreToolUse", tool_name,
 *           tool_input (Edit/Write: file_path; NotebookEdit: notebook_path;
 *           Read: file_path; Bash: command), cwd, ...
 *   deny    exit 0 with {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *           "permissionDecision":"deny","permissionDecisionReason":"..."}}
 *   allow   exit 0 with no output: the hook never grants anything, it only
 *           takes away, so the session's own permission rules still apply
 *   error   exit 2, the only blocking failure code (exit 1 and crashes are
 *           NON-blocking in Claude Code), with the reason on stderr and the
 *           same deny JSON on stdout
 *
 * Every failure path, including a snapshot that is missing or tampered with
 * and input that is not the expected JSON, ends in exit 2. The hook is one
 * layer of several: a timed-out or missing hook fails open in Claude Code,
 * which is why the OS sandbox and the controller's diff inspection exist.
 */
import { isAbsolute } from 'node:path';
import type { AuthorizationDecision, PolicySnapshot } from './types.ts';
import { verifySnapshot } from './snapshot.ts';
import { authorize } from './authorize.ts';

export interface GuardOptions {
  snapshotPath: string;
  expectedHash: string;
  /** Absolute root of the worker's worktree; every edit must resolve inside it. */
  worktreeRoot: string;
  home?: string;
}

export interface GuardResult {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

export const ENV_POLICY_PATH = 'ORBIT_POLICY_PATH';
export const ENV_POLICY_HASH = 'ORBIT_POLICY_HASH';
export const ENV_WORKTREE = 'ORBIT_WORKTREE';

const MAX_INPUT_BYTES = 5 * 1024 * 1024;

class GuardInputError extends Error {}

interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string | undefined;
}

/** Pure decision for one PreToolUse invocation. Never throws. */
export function handlePreToolUse(inputJson: string, opts: GuardOptions): GuardResult {
  try {
    if (!opts || typeof opts.worktreeRoot !== 'string' || !isAbsolute(opts.worktreeRoot)) {
      throw new GuardInputError('the worktree root is not configured');
    }
    const snapshot = verifySnapshot(opts.snapshotPath, opts.expectedHash);
    const input = parseInput(inputJson);
    const decision = decide(snapshot, input, opts);
    if (decision === null || decision.allowed) return { exitCode: 0, stdout: '', stderr: '' };
    return { exitCode: 0, stdout: denyJson(`Orbit policy (${decision.rule}): ${decision.reason}`), stderr: '' };
  } catch (err) {
    return failClosed(err);
  }
}

/** Thin wrapper: configuration from the environment the controller gives the worker. */
export function runGuardHook(stdin: string, env: Record<string, string | undefined>): GuardResult {
  try {
    const snapshotPath = env[ENV_POLICY_PATH];
    const expectedHash = env[ENV_POLICY_HASH];
    const worktreeRoot = env[ENV_WORKTREE];
    if (!snapshotPath) throw new GuardInputError(`${ENV_POLICY_PATH} is not set`);
    if (!expectedHash) throw new GuardInputError(`${ENV_POLICY_HASH} is not set`);
    if (!worktreeRoot) throw new GuardInputError(`${ENV_WORKTREE} is not set`);
    return handlePreToolUse(stdin, { snapshotPath, expectedHash, worktreeRoot, ...(env.HOME ? { home: env.HOME } : {}) });
  } catch (err) {
    return failClosed(err);
  }
}

/**
 * Process entry for `orbit hook pre-tool-use`: read stdin, decide, write,
 * set the exit code. Any failure, including an oversized input, exits 2.
 */
export async function runGuardHookProcess(): Promise<void> {
  // Until a decision is written the process must not end with any other code:
  // exit 1 (an uncaught error) would let the tool call through.
  process.exitCode = 2;
  process.once('uncaughtException', (err) => {
    const r = failClosed(err);
    try {
      process.stdout.write(r.stdout);
      process.stderr.write(`${r.stderr}\n`);
    } finally {
      process.exit(2);
    }
  });
  let result: GuardResult;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      size += buf.length;
      if (size > MAX_INPUT_BYTES) throw new GuardInputError('hook input is too large');
      chunks.push(buf);
    }
    result = runGuardHook(Buffer.concat(chunks).toString('utf8'), process.env);
  } catch (err) {
    result = failClosed(err);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

function parseInput(text: string): HookInput {
  if (typeof text !== 'string' || text.trim() === '') throw new GuardInputError('hook input is empty');
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) throw new GuardInputError('hook input is too large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GuardInputError('hook input is not valid JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new GuardInputError('hook input is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (o.hook_event_name !== 'PreToolUse') throw new GuardInputError(`expected a PreToolUse event, got ${JSON.stringify(o.hook_event_name)}`);
  if (typeof o.tool_name !== 'string' || o.tool_name.length === 0) throw new GuardInputError('tool_name is missing');
  if (o.tool_input === null || typeof o.tool_input !== 'object' || Array.isArray(o.tool_input)) throw new GuardInputError('tool_input is missing');
  if (o.cwd !== undefined && (typeof o.cwd !== 'string' || !isAbsolute(o.cwd))) throw new GuardInputError('cwd is not an absolute path');
  return { tool_name: o.tool_name, tool_input: o.tool_input as Record<string, unknown>, cwd: o.cwd as string | undefined };
}

/** null: a tool this hook has no rule for, so it stays out of the decision. */
function decide(snapshot: PolicySnapshot, input: HookInput, opts: GuardOptions): AuthorizationDecision | null {
  const ti = input.tool_input;
  const ctx = { worktreeRoot: opts.worktreeRoot, ...(input.cwd ? { cwd: input.cwd } : {}), ...(opts.home ? { home: opts.home } : {}) };
  switch (input.tool_name) {
    case 'Edit':
    case 'Write': {
      const path = requireString(ti.file_path, 'file_path');
      return requireAbsolute(path) ?? authorize(snapshot, { kind: 'edit', path }, ctx);
    }
    case 'NotebookEdit': {
      // notebook_path is the documented field; file_path is only a fallback when it is absent, never when it is malformed.
      const path = requireString(ti.notebook_path !== undefined ? ti.notebook_path : ti.file_path, 'notebook_path');
      return requireAbsolute(path) ?? authorize(snapshot, { kind: 'edit', path }, ctx);
    }
    case 'Read': {
      const path = requireString(ti.file_path, 'file_path');
      return requireAbsolute(path) ?? authorize(snapshot, { kind: 'read', path }, ctx);
    }
    case 'Bash':
      return authorize(snapshot, { kind: 'bash', command: requireString(ti.command, 'command') }, ctx);
    case 'PowerShell':
      return { allowed: false, rule: 'bash.unsupported-shell', reason: 'PowerShell commands are not inspected by Orbit; use Bash' };
    default:
      return null;
  }
}

/**
 * The verified contract says file tools always send absolute paths. A
 * relative one would be resolved by the tool against the session's cwd, which
 * need not be the worktree root this hook resolves against, so the two could
 * name different files; refusing it keeps them the same.
 */
function requireAbsolute(path: string): AuthorizationDecision | null {
  return isAbsolute(path) ? null : { allowed: false, rule: 'path.relative', reason: `${path} is not an absolute path` };
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new GuardInputError(`tool_input.${field} is missing`);
  return v;
}

function denyJson(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function failClosed(err: unknown): GuardResult {
  const message = err instanceof Error ? err.message : String(err);
  const reason = `Orbit guard failed closed: ${message}`;
  return { exitCode: 2, stdout: denyJson(reason), stderr: reason };
}
