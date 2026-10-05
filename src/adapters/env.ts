/**
 * Worker environments. A worker starts from an allowlist, never from
 * process.env minus a denylist: the controller's environment holds delivery
 * credentials (GH_TOKEN, an SSH agent), cloud and registry tokens, and
 * variables that change how a provider CLI behaves (CLAUDE_CODE_EFFORT_LEVEL
 * overrides --effort, CLAUDE_CODE_RETRY_WATCHDOG retries forever), none of
 * which a worker may inherit by accident (docs/architecture.md, "Environment"
 * enforcement layer).
 */
import { OrbitError } from '../core/errors.ts';
import { ENV_POLICY_HASH, ENV_POLICY_PATH, ENV_WORKTREE } from '../policy/guard-hook.ts';

export type EnvProvider = 'claude' | 'codex';

/** Process basics every CLI needs. Locale and terminal only; no tool configuration. */
export const BASE_ENV_KEYS: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TZ'];

/** Locale variables (LC_ALL, LC_CTYPE, ...), kept so tools decode text the way the user's shell does. */
const LOCALE_PREFIX = 'LC_';

/**
 * Network plumbing a provider may need to reach its API at all: a corporate
 * proxy and its certificate authority. Under srt these proxy variables are
 * replaced by srt's own.
 */
export const NETWORK_ENV_KEYS: readonly string[] = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

/**
 * Configuration directory and the credentials the user set for each
 * provider (ADR 0003: passed through, never stored or logged). Claude's list
 * follows the documented precedence (claude-headless-and-sandbox.md section
 * 2.1) minus the cloud-provider routes, whose AWS/GCP credentials are exactly
 * what workers must not hold. ANTHROPIC_BASE_URL is a gateway or a local
 * fake API, not a secret.
 */
export const PROVIDER_ENV_KEYS: Readonly<Record<EnvProvider, readonly string[]>> = {
  claude: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  codex: ['CODEX_HOME', 'CODEX_API_KEY'],
};

/** The credentials that let a Claude worker run inside srt, where a keychain login is invisible (ADR 0001, 0003). */
export const CLAUDE_ENV_CREDENTIALS: readonly string[] = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Fixed settings for Claude workers (claude-headless-and-sandbox.md sections
 * 2.4 and 7, gaps-and-contradictions.md section 6.1): bounded retries so an
 * outage or a bad key blocks in seconds, no auto memory (a worker must not
 * write the user's memory), no nonessential traffic, and the repository's
 * CLAUDE.md not loaded as instructions (repository text is untrusted data).
 *
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 is deliberately absent: with Claude Code
 * 2.1.288 it switched the session from --permission-mode dontAsk to
 * "default" (observed in system/init against a fake API), and Orbit's policy
 * depends on dontAsk. Keeping credentials away from the Bash tool rests on
 * the OS sandbox and the scrubbed environment instead.
 */
export const CLAUDE_WORKER_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_MAX_RETRIES: '4',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
};

/** Claude Code's per-request max_tokens cap. */
export const ENV_MAX_OUTPUT_TOKENS = 'CLAUDE_CODE_MAX_OUTPUT_TOKENS';

/** Git must not take optional locks in a worktree the controller snapshots concurrently. */
export const COMMON_WORKER_ENV: Readonly<Record<string, string>> = { GIT_OPTIONAL_LOCKS: '0' };

/**
 * Names a caller may never set through TaskSpec.env: delivery and cloud
 * credentials, and the variables that would undo the fixed settings above.
 */
const FORBIDDEN_EXTRA = /^(GH_|GITHUB_|SSH_|AWS_|AZURE_|GOOGLE_|GCLOUD_|NPM_|NODE_OPTIONS$|NODE_AUTH_TOKEN$|LD_|DYLD_|CLAUDE_CODE_RETRY_WATCHDOG$|CLAUDE_CODE_MAX_OUTPUT_TOKENS$|CLAUDE_CODE_EFFORT_LEVEL$|CLAUDE_CODE_SUBPROCESS_ENV_SCRUB$|CLAUDE_CODE_USE_)/;

export interface WorkerEnvInput {
  provider: EnvProvider;
  /** Where to take the allowlisted values from; normally process.env. */
  base: Readonly<Record<string, string | undefined>>;
  policyPath: string;
  policyHash: string;
  worktree: string;
  /** The worker's private temp directory (isolation prepareWorkerTmpDir). */
  tmpDir: string;
  /** TaskSpec.env: added after the base, before Orbit's fixed values. */
  extra?: Readonly<Record<string, string>>;
  /**
   * Output token budget. For Claude it becomes CLAUDE_CODE_MAX_OUTPUT_TOKENS,
   * which sets the per-request max_tokens (verified against a local fake API:
   * the request body carries the value; unset it carried the model default).
   * Ignored for Codex, which has no verified output cap.
   */
  maxOutputTokens?: number | null;
}

export function buildWorkerEnv(input: WorkerEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  const keep = [...BASE_ENV_KEYS, ...NETWORK_ENV_KEYS, ...PROVIDER_ENV_KEYS[input.provider]];
  for (const key of keep) {
    const v = input.base[key];
    if (typeof v === 'string' && v !== '') env[key] = v;
  }
  for (const [key, v] of Object.entries(input.base)) {
    if (key.startsWith(LOCALE_PREFIX) && typeof v === 'string') env[key] = v;
  }
  for (const [key, v] of Object.entries(input.extra ?? {})) {
    if (FORBIDDEN_EXTRA.test(key) || key === ENV_POLICY_PATH || key === ENV_POLICY_HASH || key === ENV_WORKTREE || key === 'ORBIT_WORKER') {
      throw new OrbitError('POLICY_DENIED', `worker environment may not set ${key}`, { variable: key });
    }
    env[key] = v;
  }
  Object.assign(env, COMMON_WORKER_ENV);
  if (input.provider === 'claude') {
    Object.assign(env, CLAUDE_WORKER_ENV);
    const cap = input.maxOutputTokens;
    if (cap !== undefined && cap !== null) {
      if (!Number.isSafeInteger(cap) || cap < 1) throw new OrbitError('CONFIG_INVALID', `maxOutputTokens must be a positive integer, got ${String(cap)}`);
      env[ENV_MAX_OUTPUT_TOKENS] = String(cap);
    }
  }
  env.TMPDIR = input.tmpDir;
  env[ENV_POLICY_PATH] = input.policyPath;
  env[ENV_POLICY_HASH] = input.policyHash;
  env[ENV_WORKTREE] = input.worktree;
  // The plugin's hooks key on this to tell a worker session from the user's own.
  env.ORBIT_WORKER = '1';
  return env;
}

/** Which Claude env credential is present, by name only. */
export function claudeEnvCredential(env: Readonly<Record<string, string | undefined>>): string | null {
  for (const key of CLAUDE_ENV_CREDENTIALS) {
    const v = env[key];
    if (typeof v === 'string' && v.trim() !== '') return key;
  }
  return null;
}

/** The named variables present in `base`, for WorkerEnvInput.extra. Delivery, cloud and loader variables are refused. */
export function passThrough(base: Readonly<Record<string, string | undefined>>, names: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names ?? []) {
    if (FORBIDDEN_EXTRA.test(n)) throw new OrbitError('POLICY_DENIED', `worker environment may not pass through ${n}`, { variable: n });
    const v = base[n];
    if (typeof v === 'string') out[n] = v;
  }
  return out;
}
