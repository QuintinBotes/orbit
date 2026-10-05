/**
 * The `--settings` file a Claude worker starts with: permission rules
 * derived from the frozen policy, Orbit's PreToolUse guard hook, and the
 * sandbox block for the worker's isolation tier. Nothing else: no env block,
 * no other hooks, no MCP servers.
 *
 * Verified behaviour this relies on (claude-headless-and-sandbox.md 1.5, 1.6,
 * 3; claude-code-plugin.md section 4):
 *   - In dontAsk mode anything not allowed is denied, never prompted, and
 *     deny beats allow at every level.
 *   - `Edit(...)` rules cover every edit tool; `Write(...)` path rules are
 *     never consulted. `//abs/path` is absolute.
 *   - A hook in exec form (command + args) runs without a shell; exit 2 or a
 *     JSON deny blocks the call; a timeout or a missing script fails open,
 *     which is why the hook's files are checked before spawn.
 *   - `-p` silently ignores a settings file that fails validation, which
 *     would drop every rule here and the sandbox block with them. The file
 *     is therefore validated against a strict schema of exactly what Orbit
 *     emits before any worker starts.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { compileSchema, schemaErrors } from '../core/schema.ts';
import { HOME_CREDENTIAL_PATHS, credentialGlobsOf } from '../policy/builtin.ts';
import type { PolicySnapshot } from '../policy/types.ts';

export type ClaudeTier = 'os-sandbox' | 'claude-sandbox';

/** Tools the guard hook inspects (policy/guard-hook.ts decide()); MultiEdit does not exist in 2.1.288. */
export const GUARD_MATCHER = 'Bash|PowerShell|Edit|Write|NotebookEdit|Read';
/** Seconds. A PreToolUse hook that times out fails open, so the hook must stay fast; 10 s is the documented ceiling to aim under. */
export const GUARD_TIMEOUT_S = 10;
/** --settings must be a regular file of at most 2 MiB. */
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;

export interface ClaudeSettings {
  permissions: { allow: string[]; deny: string[] };
  hooks: {
    PreToolUse: { matcher: string; hooks: { type: 'command'; command: string; args: string[]; timeout: number }[] }[];
  };
  sandbox: ClaudeSandboxSettings | { enabled: false };
}

export interface ClaudeSandboxSettings {
  enabled: true;
  failIfUnavailable: true;
  autoAllowBashIfSandboxed: boolean;
  allowUnsandboxedCommands: false;
  filesystem: { allowWrite: string[]; denyRead: string[] };
  network: { allowedDomains: string[]; strictAllowlist: true };
}

export interface ClaudeSettingsInput {
  snapshot: PolicySnapshot;
  /** Absolute, canonical worktree root (the worker's cwd). */
  worktree: string;
  workerDir: string;
  policyPath: string;
  tier: ClaudeTier;
  readOnly: boolean;
  /** argv of the guard hook, e.g. [node, <orbit>/dist/orbit.mjs, 'hook', 'pre-tool-use']. */
  hookCommand: string[];
  /** Paths the Bash sandbox must not read (the worker's isolation profile deny list); claude-sandbox tier only. */
  denyReadPaths: string[];
  /** The worker's private temp directory; Bash may write it. */
  tmpDir: string;
}

/** `Edit(//abs/...)`: the permission-rule form of an absolute path (a leading `/` alone means settings-relative). */
export function absRule(tool: 'Edit' | 'Read', absPath: string, glob?: string): string {
  const base = absPath.endsWith('/') ? absPath.slice(0, -1) : absPath;
  return `${tool}(/${base}${glob ? `/${glob}` : ''})`;
}

export function renderClaudeSettings(input: ClaudeSettingsInput): ClaudeSettings {
  const { snapshot, worktree } = input;
  const cfg = snapshot.config;
  const allow: string[] = [];
  const deny: string[] = [];

  // Edits only inside allowed paths of this worktree, and only for writer roles.
  if (!input.readOnly && cfg.actions.edit) {
    for (const glob of cfg.scope.allowed_paths) allow.push(absRule('Edit', worktree, glob));
  }
  // In the os-sandbox tier the OS confines every command, so Bash is allowed
  // outright and the guard hook rejects the dangerous categories. In the
  // claude-sandbox tier Bash runs inside Claude's own sandbox
  // (autoAllowBashIfSandboxed); allowing it here as well would also allow it
  // unsandboxed.
  if (!input.readOnly && input.tier === 'os-sandbox') allow.push('Bash');

  for (const glob of snapshot.effective_protected_paths) deny.push(absRule('Edit', worktree, glob));
  for (const glob of credentialGlobs(snapshot)) deny.push(absRule('Read', worktree, glob));
  for (const rel of HOME_CREDENTIAL_PATHS) deny.push(`Read(~/${rel})`);
  // The worker directory and the snapshot are the controller's: prompt,
  // settings, logs, pid and exit files.
  deny.push(absRule('Edit', input.workerDir, '**'), absRule('Edit', input.policyPath));

  const settings: ClaudeSettings = {
    permissions: { allow: uniq(allow), deny: uniq(deny) },
    hooks: {
      PreToolUse: [
        {
          matcher: GUARD_MATCHER,
          hooks: [{ type: 'command', command: input.hookCommand[0]!, args: input.hookCommand.slice(1), timeout: GUARD_TIMEOUT_S }],
        },
      ],
    },
    // Claude Code's sandbox cannot run inside srt (nested Seatbelt fails,
    // gaps V5), so the os-sandbox tier turns it off explicitly.
    sandbox:
      input.tier === 'claude-sandbox'
        ? {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: !input.readOnly,
            allowUnsandboxedCommands: false,
            filesystem: {
              allowWrite: uniq(input.readOnly ? [input.tmpDir] : [worktree, input.tmpDir]),
              denyRead: uniq(input.denyReadPaths),
            },
            network: { allowedDomains: uniq(cfg.network.allowed_hosts), strictAllowlist: true },
          }
        : { enabled: false },
  };
  return settings;
}

/** Built-in credential globs and the policy's protected credential globs (their contents are secrets, so reading is denied too, not only editing). */
function credentialGlobs(snapshot: PolicySnapshot): string[] {
  return credentialGlobsOf(snapshot);
}

const RULE = { type: 'string', minLength: 3, maxLength: 4096, pattern: '^[A-Za-z][A-Za-z0-9_]*(\\(.+\\))?$' };
const ABS = { type: 'string', minLength: 1, maxLength: 4096, pattern: '^/' };

/** Exactly the shape renderClaudeSettings emits, keys and types as in the verified settings reference. */
export const CLAUDE_SETTINGS_SCHEMA = {
  $id: 'orbit:claude-worker-settings',
  type: 'object',
  additionalProperties: false,
  required: ['permissions', 'hooks', 'sandbox'],
  properties: {
    permissions: {
      type: 'object',
      additionalProperties: false,
      required: ['allow', 'deny'],
      properties: { allow: { type: 'array', items: RULE }, deny: { type: 'array', items: RULE, minItems: 1 } },
    },
    hooks: {
      type: 'object',
      additionalProperties: false,
      required: ['PreToolUse'],
      properties: {
        PreToolUse: {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['matcher', 'hooks'],
            properties: {
              matcher: { type: 'string', minLength: 1 },
              hooks: {
                type: 'array',
                minItems: 1,
                maxItems: 1,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'command', 'args', 'timeout'],
                  properties: {
                    type: { const: 'command' },
                    command: ABS,
                    args: { type: 'array', items: { type: 'string', minLength: 1 } },
                    timeout: { type: 'integer', minimum: 1, maximum: GUARD_TIMEOUT_S },
                  },
                },
              },
            },
          },
        },
      },
    },
    sandbox: {
      anyOf: [
        { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { const: false } } },
        {
          type: 'object',
          additionalProperties: false,
          required: ['enabled', 'failIfUnavailable', 'autoAllowBashIfSandboxed', 'allowUnsandboxedCommands', 'filesystem', 'network'],
          properties: {
            enabled: { const: true },
            failIfUnavailable: { const: true },
            autoAllowBashIfSandboxed: { type: 'boolean' },
            allowUnsandboxedCommands: { const: false },
            filesystem: {
              type: 'object',
              additionalProperties: false,
              required: ['allowWrite', 'denyRead'],
              properties: { allowWrite: { type: 'array', minItems: 1, items: ABS }, denyRead: { type: 'array', items: ABS } },
            },
            network: {
              type: 'object',
              additionalProperties: false,
              required: ['allowedDomains', 'strictAllowlist'],
              properties: { allowedDomains: { type: 'array', items: { type: 'string', minLength: 1 } }, strictAllowlist: { const: true } },
            },
          },
        },
      ],
    },
  },
} as const;

/**
 * Every reason the settings would not do what Orbit needs, empty when they
 * would. Beyond the schema: the hook must be runnable (a missing script
 * exits 127, which Claude Code treats as "allow"), and the rendered text must
 * fit the 2 MiB limit.
 */
export function claudeSettingsProblems(settings: unknown): string[] {
  const problems = schemaErrors(compileSchema(CLAUDE_SETTINGS_SCHEMA), settings);
  if (problems.length > 0) return problems;
  const s = settings as ClaudeSettings;
  if (Buffer.byteLength(JSON.stringify(s)) > MAX_SETTINGS_BYTES) problems.push('settings exceed 2 MiB');
  for (const matcher of s.hooks.PreToolUse) {
    for (const hook of matcher.hooks) {
      if (!isExecutable(hook.command)) problems.push(`hook command ${hook.command} is not an executable file`);
      // Every absolute argument, not only the first: the source-run form puts
      // node options before the script ([node, --no-warnings, hook-main.ts]),
      // and a missing script there fails open just the same.
      for (const arg of hook.args) {
        if (isAbsolute(arg) && !existsSync(arg)) problems.push(`hook script ${arg} does not exist`);
      }
    }
  }
  return problems;
}

export function assertClaudeSettings(settings: unknown): asserts settings is ClaudeSettings {
  const problems = claudeSettingsProblems(settings);
  if (problems.length > 0) {
    throw new OrbitError('CONFIG_INVALID', `refusing to start a worker with settings Claude Code would ignore or that disable the guard: ${problems.slice(0, 5).join('; ')}`, { problems });
  }
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function uniq(items: string[]): string[] {
  return [...new Set(items)];
}
