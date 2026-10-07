import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { sha256 } from '../core/hash.ts';
import { credentialGlobsOf } from '../policy/builtin.ts';
import type { CheckDefinition, PolicySnapshot } from '../policy/types.ts';
import type { SandboxProfile } from './types.ts';
import { canonicalPath, credentialFilesIn, gitCommonDir, isWithin, readablePathsOf, uniq } from './util.ts';

/**
 * Profiles say what an untrusted process may touch; providers decide how to
 * enforce it. Two kinds of untrusted process exist: model workers, which need
 * their provider's API and their own config directory, and the repository's
 * checks, which need neither.
 */

/**
 * Hosts a provider CLI must reach to work at all, from the verified notes:
 * Claude Code talks to api.anthropic.com and refreshes OAuth through claude.ai
 * and platform.claude.com (claude-headless-and-sandbox.md section 7.5); Codex
 * uses api.openai.com with an API key and chatgpt.com with a ChatGPT login
 * (codex-cli.md section 6).
 */
export const PROVIDER_HOSTS: Readonly<Record<'claude' | 'codex', readonly string[]>> = {
  claude: ['api.anthropic.com', 'claude.ai', 'platform.claude.com'],
  codex: ['api.openai.com', 'chatgpt.com'],
};

/**
 * Credential and trusted-state locations under the home directory that no
 * untrusted process may read. `.orbit` holds every run's worktrees, global
 * knowledge and service state; a worker gets its own worktree back through
 * the allow rules. publish-guard holds the private term list. The container
 * engines' directories hold both their control socket and an SSH key into
 * the engine's VM (OrbStack: ~/.orbstack/ssh/id_ed25519, ~/.orbstack/run/docker.sock),
 * which is root on the machine that runs every container. Library/Keychains
 * holds the macOS login keychain files; denying them did not affect a
 * `claude -p` worker using env credentials (verified under srt).
 */
export const HOME_DENY_READ: readonly string[] = [
  '.ssh',
  '.aws',
  '.config/gh',
  '.gnupg',
  '.netrc',
  '.npmrc',
  '.docker',
  '.git-credentials',
  '.config/git/credentials',
  '.kube',
  '.config/gcloud',
  '.azure',
  '.pypirc',
  '.orbit',
  '.config/publish-guard',
  '.orbstack',
  '.colima',
  '.lima',
  '.rd',
  '.config/op',
  '.config/anthropic',
  '.config/github-copilot',
  '.config/hub',
  '.config/glab-cli',
  '.gemini',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.terraform.d/credentials.tfrc.json',
  '.vault-token',
  '.pgpass',
  '.password-store',
  '.local/share/keyrings',
  'Library/Keychains',
];

/** Container-engine control sockets outside the home directory; each is root-equivalent. */
export const SYSTEM_DENY_READ: readonly string[] = ['/var/run/docker.sock', '/run/docker.sock', '/run/podman', '/run/containerd'];

/**
 * Inside a provider config directory a worker may write (transcripts,
 * sessions, caches), these run code or inject instructions in the user's
 * later sessions on the host, or hold Orbit itself when it is installed as a
 * plugin: settings and global config carry hooks, MCP server commands,
 * apiKeyHelper and awsAuthRefresh commands; plugins/ holds installed plugin
 * code; local/ holds the `claude` binary of a local npm install. They are
 * read-only for workers. Verified with `claude -p` under srt against a mock
 * API: the run succeeds with every entry write-denied, including
 * .claude.json, whether it exists or not. A name list cannot cover scripts
 * the user's own settings point at inside the directory (a status line
 * script, say), nor auto-memory under projects/; a private per-worker config
 * directory avoids the question entirely.
 */
export const CLAUDE_CONFIG_READ_ONLY: readonly string[] = [
  'settings.json',
  'settings.local.json',
  '.claude.json',
  'CLAUDE.md',
  'hooks',
  'plugins',
  'skills',
  'agents',
  'commands',
  'output-styles',
  'rules',
  'local',
];

/** The Codex equivalents: config.toml carries MCP server and notify commands, hooks.json hooks, AGENTS.md instructions. */
export const CODEX_HOME_READ_ONLY: readonly string[] = ['config.toml', 'hooks.json', 'AGENTS.md', 'AGENTS.override.md', 'prompts', 'rules', 'skills'];

/**
 * Files in a worker directory that the controller, the shim or the provider
 * CLI trust (docs/architecture.md): the settings and prompt the CLI starts
 * with, the policy snapshot a guard hook reads, and the log, pid, exit and
 * result files the controller judges the worker by. A worker writing any of
 * them could forge its own outcome or loosen its own rules. The log is
 * written through the descriptor the shim opened, which a write deny does
 * not affect (verified under srt). Any new file the controller trusts
 * belongs in this list.
 */
export const WORKER_DIR_READ_ONLY: readonly string[] = ['prompt.md', 'system.md', 'settings.json', 'schema.json', 'policy.json', 'launch.json', 'log.jsonl', 'stderr.log', 'shim.log', 'pid.json', 'exit.json', 'result.json'];

export type WorkerProvider = 'claude' | 'codex';

/** What profile builders return: a SandboxProfile plus its read-only paths (see util.ts IsolationProfile). */
export type BuiltProfile = SandboxProfile & { readablePaths: string[] };

export interface ProviderDirs {
  claudeConfigDir: string;
  codexHome: string;
}

export interface WorkerProfileInput {
  worktree: string;
  workerDir: string;
  snapshot: PolicySnapshot;
  provider: WorkerProvider;
  /**
   * The Claude Code config directory the worker runs with (its
   * CLAUDE_CONFIG_DIR). A private per-worker directory is safest: an srt
   * worker needs env credentials anyway (keychain logins are invisible
   * there), and the user's own directory then stays unreadable to it.
   */
  claudeConfigDir: string;
  homeDir: string;
  /** Codex state directory; defaults to CODEX_HOME from `env`, else ~/.codex. */
  codexHome?: string;
  /** Private temp directory; defaults to workerTmpDir(workerDir) (create it with prepareWorkerTmpDir). */
  tmpDir?: string;
  /** The frozen policy snapshot the worker's guard hook reads (TaskSpec.policyPath); readable, never writable. */
  policyPath?: string;
  /** Paths the worker may read and never write, such as Orbit's install directory for its guard hook. */
  readablePaths?: string[];
  /** The worker's worktree uses .NET (ToolchainLayout.nisDomainName): see SandboxProfile.nisDomainName. */
  nisDomainName?: boolean;
  /** Defaults to the run's wall-clock hard limit. */
  timeoutMs?: number;
  /** The environment Orbit runs with, for CLAUDE_CONFIG_DIR and CODEX_HOME; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Entries the credential enumeration may visit before the build refuses; defaults to CREDENTIAL_WALK_LIMIT (a test seam). */
  credentialWalkLimit?: number;
}

export interface CheckProfileInput {
  worktree: string;
  check: CheckDefinition;
  snapshot: PolicySnapshot;
  /** For example an evidence output directory or a private temp directory. */
  extraWritable?: string[];
  readablePaths?: string[];
  /** The check runs .NET (ToolchainLayout.nisDomainName): see SandboxProfile.nisDomainName. */
  nisDomainName?: boolean;
  homeDir?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  env?: Record<string, string | undefined>;
  /** Entries the credential enumeration may visit before the build refuses; defaults to CREDENTIAL_WALK_LIMIT (a test seam). */
  credentialWalkLimit?: number;
}

function walkLimit(input: { credentialWalkLimit?: number }): { credentialWalkLimit?: number } {
  return input.credentialWalkLimit === undefined ? {} : { credentialWalkLimit: input.credentialWalkLimit };
}

/**
 * A worker may write only its worktree, its worker directory (minus the
 * files the controller trusts), a private temp directory and the state its
 * own provider CLI must write: for Claude Code the config directory, for
 * Codex its CODEX_HOME, minus the entries that run code or carry
 * instructions on the host. Claude Code's global config (.claude.json) is
 * read-only too. It may reach only its provider's hosts plus the policy's
 * allowed hosts. Every other login's state, the other provider's included,
 * is denied like any other credential.
 *
 * A Codex reviewer gets the narrower codexReviewerProfile instead.
 *
 * The adapter must create the temp directory with prepareWorkerTmpDir and
 * set TMPDIR to it. Verified with `claude -p` under srt against a mock API:
 * with that TMPDIR the Bash tool works and needs no write access to the
 * shared /tmp/claude-<uid>; without it every Bash call fails with EPERM on
 * /private/tmp/claude-<uid> (as gaps-and-contradictions.md V5 also found).
 */
export function profileForWorker(input: WorkerProfileInput): BuiltProfile {
  const home = canonicalPath(input.homeDir);
  const worktree = canonicalPath(input.worktree);
  const workerDir = canonicalPath(input.workerDir);
  const tmp = canonicalPath(input.tmpDir ?? workerTmpDir(input.workerDir));
  const env = input.env ?? process.env;
  const dirs = providerDirs({ homeDir: home, claudeConfigDir: input.claudeConfigDir, codexHome: input.codexHome, env });
  const claudeDirs = claudeLogins(home, env, dirs.claudeConfigDir);
  const codexDirs = codexHomes(home, env, dirs.codexHome);

  let own: string;
  let ownReadOnly: string[];
  let others: string[];
  if (input.provider === 'claude') {
    own = dirs.claudeConfigDir;
    ownReadOnly = [...CLAUDE_CONFIG_READ_ONLY.map((rel) => join(own, rel)), claudeGlobalConfig(home, own)];
    others = [...claudeDirs.filter((d) => d !== own).flatMap((d) => claudeState(home, d)), ...codexDirs];
  } else {
    own = dirs.codexHome;
    ownReadOnly = CODEX_HOME_READ_ONLY.map((rel) => join(own, rel));
    others = [...claudeDirs.flatMap((d) => claudeState(home, d)), ...codexDirs.filter((d) => d !== own)];
  }
  assertProviderDirConfinable(own, home, env);

  return {
    writablePaths: uniq([worktree, workerDir, tmp, own]),
    denyReadPaths: denyList({ home, repoRoot: input.snapshot.repo_root, worktree, extra: others, snapshot: input.snapshot, ...walkLimit(input) }),
    readablePaths: uniq([
      ...readableFor(worktree, input.readablePaths),
      ...(input.policyPath ? [canonicalPath(input.policyPath)] : []),
      ...WORKER_DIR_READ_ONLY.map((rel) => join(workerDir, rel)),
      ...ownReadOnly,
    ]),
    allowedHosts: uniq([...PROVIDER_HOSTS[input.provider], ...input.snapshot.config.network.allowed_hosts]),
    ...(input.nisDomainName ? { nisDomainName: true } : {}),
    limits: {
      timeoutMs: input.timeoutMs ?? input.snapshot.config.scheduler.hard_limits.wall_minutes * 60_000,
      ...resourceLimits(input.snapshot),
    },
  };
}

export interface CodexReviewerProfileInput {
  /** The review checkout: readable, never writable. */
  checkout: string;
  workerDir: string;
  /** Codex's state directory (see codexHomeFor): the one place besides the worker directory the reviewer may write. */
  codexHome: string;
  homeDir: string;
  /** For ORBIT_HOME; defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The srt profile of a Codex reviewer in the os-sandbox tier (ADR 0001,
 * "Codex reviewer tiers"). Codex's own sandbox cannot start inside srt on
 * macOS (a Seatbelt profile cannot be applied from inside another:
 * `sandbox_apply: Operation not permitted`), so Codex runs with
 * `--sandbox danger-full-access` and this profile is the only thing that
 * confines it. It narrows the generic Codex worker profile:
 *
 * - writes: the worker directory and Codex's state directory, nothing else.
 *   Never the review checkout, and the build refuses a layout in which either
 *   directory contains or sits inside it. The state directory holds the auth
 *   file, which Codex refreshes in place, so it stays writable; the entries
 *   there that run code on the host (CODEX_HOME_READ_ONLY) do not.
 * - egress: the Codex provider hosts only, not the hosts the policy allows
 *   implementers (a reviewer has no use for a package registry).
 * - reads: every credential path the generic profile denies stays denied,
 *   including another Codex login (the default ~/.codex when CODEX_HOME names
 *   a different directory). The exception is Codex's own state directory,
 *   which holds the auth file it must read to log in. The checkout is
 *   re-allowed for reading, since it usually sits under the denied ~/.orbit.
 */
export function codexReviewerProfile(profile: SandboxProfile, input: CodexReviewerProfileInput): BuiltProfile {
  const home = canonicalPath(input.homeDir);
  const checkout = canonicalPath(input.checkout);
  const workerDir = canonicalPath(input.workerDir);
  const codexHome = canonicalPath(input.codexHome);
  assertProviderDirConfinable(codexHome, home, input.env ?? process.env);
  for (const [what, dir] of [['worker directory', workerDir], ['Codex state directory', codexHome]] as const) {
    if (isWithin(checkout, dir) || isWithin(dir, checkout)) {
      throw new OrbitError('ISOLATION_UNAVAILABLE', `refusing to let the reviewer write ${dir}: the ${what} overlaps the review checkout ${checkout}, which must stay read-only`, { path: dir });
    }
  }
  const defaultCodexHome = join(home, '.codex');
  return {
    writablePaths: [workerDir, codexHome],
    denyReadPaths: uniq([...profile.denyReadPaths.map(canonicalPath).filter((p) => p !== codexHome), ...(defaultCodexHome === codexHome ? [] : [defaultCodexHome])]),
    readablePaths: uniq([...readablePathsOf(profile).map(canonicalPath), checkout, ...CODEX_HOME_READ_ONLY.map((rel) => join(codexHome, rel))]),
    allowedHosts: [...PROVIDER_HOSTS.codex],
    limits: { ...profile.limits },
  };
}

/**
 * A check is the repository's own code, so it gets the worktree (and any
 * extra output directory), the hosts its definition names and nothing else.
 * Model-provider credentials are denied along with every other credential.
 * Listening on loopback is a separate permission, `local_binding` (default
 * true: a test suite that starts an HTTP server is ordinary); it opens no
 * outbound route, so `allowedHosts` is the definition's `network_hosts` either way.
 */
export function profileForCheck(input: CheckProfileInput): BuiltProfile {
  const home = canonicalPath(input.homeDir ?? homedir());
  const worktree = canonicalPath(input.worktree);
  const env = input.env ?? process.env;
  const dirs = providerDirs({ homeDir: home, claudeConfigDir: input.claudeConfigDir, codexHome: input.codexHome, env });
  const providerState = [...claudeLogins(home, env, dirs.claudeConfigDir).flatMap((d) => claudeState(home, d)), ...codexHomes(home, env, dirs.codexHome)];
  return {
    writablePaths: uniq([worktree, ...(input.extraWritable ?? []).map(canonicalPath)]),
    denyReadPaths: denyList({ home, repoRoot: input.snapshot.repo_root, worktree, extra: providerState, snapshot: input.snapshot, ...walkLimit(input) }),
    readablePaths: readableFor(worktree, input.readablePaths),
    allowedHosts: uniq(input.check.network_hosts),
    // `!== false`: a definition frozen into an older snapshot has no key and reads as the default.
    allowLocalBinding: input.check.local_binding !== false,
    ...(input.nisDomainName ? { nisDomainName: true } : {}),
    limits: { timeoutMs: input.check.timeout_seconds * 1000, ...resourceLimits(input.snapshot) },
  };
}

/**
 * What every profile read-denies whatever runs under it: the credential paths in the home directory, the
 * container-engine sockets, Orbit's temp root and every provider login Orbit can know of. For a process that needs no
 * repository at all (`orbit doctor`'s browser launch); profiles for checks and workers add the repository's own.
 */
export function credentialDenyPaths(opts: { homeDir?: string; env?: Record<string, string | undefined> } = {}): string[] {
  const home = canonicalPath(opts.homeDir ?? homedir());
  const env = opts.env ?? process.env;
  const dirs = providerDirs({ homeDir: home, env });
  return uniq([
    ...HOME_DENY_READ.map((rel) => join(home, rel)),
    ...SYSTEM_DENY_READ.map(canonicalPath),
    orbitTmpRoot(),
    ...claudeLogins(home, env, dirs.claudeConfigDir).flatMap((d) => claudeState(home, d)),
    ...codexHomes(home, env, dirs.codexHome),
  ]);
}

/**
 * Root of every worker's private temp directory: /tmp/orbit-<uid>, the same
 * shape Claude Code uses for its own /tmp/claude-<uid>. It is short on
 * purpose: Claude Code and srt create Unix sockets in temp directories, and a
 * socket path over 104 bytes (macOS) fails, which a directory deep inside the
 * repository would cause. Every profile denies reading it, and each worker's
 * own subdirectory is re-allowed through its writable set, so concurrent
 * workers cannot read each other's temp files.
 */
export function orbitTmpRoot(uid: number | undefined = process.getuid?.()): string {
  return canonicalPath(join('/tmp', uid === undefined ? 'orbit' : `orbit-${uid}`));
}

/** A worker's private temp directory, derived from its worker directory so a restarted controller finds the same one. */
export function workerTmpDir(workerDir: string, root: string = orbitTmpRoot()): string {
  return join(root, sha256(canonicalPath(workerDir)).slice(0, 12));
}

/**
 * Create the worker's temp directory, owner-only. /tmp is shared, so the
 * root is checked after creation: it must be a real directory (not a
 * symlink planted by someone else) owned by this user with no group or other
 * access. Claude Code itself asks for a private (0700) directory when
 * CLAUDE_CODE_TMPDIR points somewhere else. The adapter sets TMPDIR to the
 * returned path and the srt provider passes it through.
 */
export function prepareWorkerTmpDir(workerDir: string, root: string = orbitTmpRoot()): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  const uid = process.getuid?.();
  if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
    throw new OrbitError('ISOLATION_UNAVAILABLE', `${root} is not a private directory owned by this user; refusing to put worker temp files there`, { path: root });
  }
  const dir = workerTmpDir(workerDir, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function providerDirs(opts: { homeDir: string; claudeConfigDir?: string; codexHome?: string; env?: Record<string, string | undefined> }): ProviderDirs {
  const env = opts.env ?? process.env;
  const home = canonicalPath(opts.homeDir);
  const claude = opts.claudeConfigDir ?? nonEmpty(env.CLAUDE_CONFIG_DIR) ?? join(home, '.claude');
  const codex = opts.codexHome ?? nonEmpty(env.CODEX_HOME) ?? join(home, '.codex');
  return { claudeConfigDir: canonicalPath(claude), codexHome: canonicalPath(codex) };
}

/**
 * Where Codex keeps its state for this environment: CODEX_HOME, else
 * ~/.codex (codex-cli.md section 8). A relative CODEX_HOME is refused, since
 * a sandbox rule needs the one real directory.
 */
export function codexHomeFor(homeDir: string, env: Record<string, string | undefined>): string {
  const configured = nonEmpty(env.CODEX_HOME);
  if (configured !== undefined && !isAbsolute(configured)) {
    throw new OrbitError('CONFIG_INVALID', `CODEX_HOME must be an absolute path, got ${JSON.stringify(configured)}`, { variable: 'CODEX_HOME' });
  }
  return canonicalPath(configured ?? join(canonicalPath(homeDir), '.codex'));
}

/**
 * The directory holding the repository and its sibling projects, when
 * denying it is feasible. It is not when that directory is the filesystem
 * root, the home directory or one of its ancestors (everything the provider
 * CLIs need lives under home), or a shared temp root: srt's own TMPDIR
 * (/tmp/claude) and the OS temp directory must stay readable. In those cases
 * only the explicit deny list applies, and other projects stay readable.
 */
export function repoParentDenial(repoRoot: string, homeDir: string): { path: string | null; reason: string } {
  const repo = canonicalPath(repoRoot);
  const parent = dirname(repo);
  const home = canonicalPath(homeDir);
  if (parent === repo || parent === '/') return { path: null, reason: 'the repository sits at the filesystem root' };
  if (isWithin(home, parent)) return { path: null, reason: `${parent} contains the home directory` };
  const shared = uniq(['/tmp', '/private/tmp', '/var/tmp', '/var/folders', tmpdir()].map(canonicalPath));
  if (shared.some((root) => isWithin(root, parent))) return { path: null, reason: `${parent} contains a shared temp directory` };
  return { path: parent, reason: 'sibling projects are denied; the worktree and git directory are re-allowed' };
}

/**
 * Whether a check profile read-denies a directory above `checkout`: the profile re-allows the checkout itself, so a
 * process in it can read everything below it and list nothing between it and that directory. A run's checkouts sit
 * in <orbit home>/worktrees/<repo key>/<run>/, and the default Orbit home, ~/.orbit, is denied (HOME_DENY_READ), so for a
 * run this is true unless ORBIT_HOME is somewhere no rule denies. On macOS Seatbelt then refuses a listing of
 * <orbit home>/worktrees/<repo key>/<run> with EPERM, which a tool that walks up from its folder meets (dotnet format
 * whitespace --folder looking for .editorconfig files, evidence/dotnet-format.ts); on Linux srt lays an empty tmpfs over
 * a denied directory, which lists.
 */
export function checkoutBelowDenied(opts: { checkout: string; repoRoot: string; homeDir: string; env?: Record<string, string | undefined> }): boolean {
  const checkout = canonicalPath(opts.checkout);
  const repo = canonicalPath(opts.repoRoot);
  const parent = repoParentDenial(repo, opts.homeDir).path;
  const denied = [...credentialDenyPaths({ homeDir: opts.homeDir, ...(opts.env ? { env: opts.env } : {}) }), join(repo, '.orbit'), ...(isWithin(repo, checkout) ? [] : [repo]), ...(parent ? [parent] : [])];
  return denied.some((d) => d !== checkout && isWithin(checkout, d));
}

/**
 * The repository's main checkout is denied as a whole (its git directory is
 * re-allowed through the read-only paths): it holds the user's uncommitted
 * work and untracked files such as .env, none of which is in the worktree.
 * Only when the worktree is the checkout itself can it not be denied.
 */
function denyList(opts: { home: string; repoRoot: string; worktree: string; extra: string[]; snapshot: PolicySnapshot; credentialWalkLimit?: number }): string[] {
  if (!opts.repoRoot) throw new OrbitError('INTERNAL', 'policy snapshot has no repo_root');
  const repo = canonicalPath(opts.repoRoot);
  const parent = repoParentDenial(repo, opts.home).path;
  return uniq([
    ...HOME_DENY_READ.map((rel) => join(opts.home, rel)),
    ...SYSTEM_DENY_READ.map(canonicalPath),
    join(repo, '.orbit'),
    ...(isWithin(repo, opts.worktree) ? [] : [repo]),
    // Credential files in the worktree (.env, keys, and what the policy protects as credentials): a deny nested in the
    // re-allowed worktree stays the more specific rule. An enumeration that cannot finish throws rather than guess.
    ...credentialFilesIn(opts.worktree, credentialGlobsOf(opts.snapshot), opts.credentialWalkLimit === undefined ? {} : { limit: opts.credentialWalkLimit }),
    orbitTmpRoot(),
    ...(parent ? [parent] : []),
    ...opts.extra,
  ]);
}

/** Every Claude Code config directory Orbit can know of: the one in use, CLAUDE_CONFIG_DIR, and the default. */
function claudeLogins(home: string, env: Record<string, string | undefined>, configured: string): string[] {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return uniq([configured, ...(fromEnv && isAbsolute(fromEnv) ? [canonicalPath(fromEnv)] : []), join(home, '.claude')]);
}

function codexHomes(home: string, env: Record<string, string | undefined>, configured: string): string[] {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return uniq([configured, ...(fromEnv && isAbsolute(fromEnv) ? [canonicalPath(fromEnv)] : []), join(home, '.codex')]);
}

/**
 * Claude Code keeps its global config (MCP servers, auth helper commands,
 * account metadata) in ~/.claude.json for the default directory and in
 * $CLAUDE_CONFIG_DIR/.claude.json otherwise (both observed on this machine).
 */
function claudeGlobalConfig(home: string, configDir: string): string {
  return configDir === join(home, '.claude') ? join(home, '.claude.json') : join(configDir, '.claude.json');
}

function claudeState(home: string, configDir: string): string[] {
  return uniq([configDir, claudeGlobalConfig(home, configDir)]);
}

/**
 * The provider directory is made writable, so it must be a directory of its
 * own: a CODEX_HOME or CLAUDE_CONFIG_DIR set to the home directory (or above
 * it) would hand the worker every dotfile and tool directory in it. Nor may it
 * be, contain or sit inside the Orbit home (~/.orbit, or ORBIT_HOME): that
 * holds every run's state and the service launcher (bin/orbit) that the
 * service manager executes outside any sandbox.
 */
function assertProviderDirConfinable(dir: string, home: string, env: Readonly<Record<string, string | undefined>>): void {
  if (dir === '/' || isWithin(home, dir)) {
    throw new OrbitError('ISOLATION_UNAVAILABLE', `refusing to let a worker write ${dir}: a provider config directory must not be the home directory or contain it`, { path: dir });
  }
  const fromEnv = nonEmpty(env.ORBIT_HOME);
  for (const orbitHome of uniq([join(home, '.orbit'), ...(fromEnv && isAbsolute(fromEnv) ? [canonicalPath(fromEnv)] : [])])) {
    if (isWithin(dir, orbitHome) || isWithin(orbitHome, dir)) {
      throw new OrbitError('ISOLATION_UNAVAILABLE', `refusing to let a worker write ${dir}: a provider config directory must not be, contain or sit inside the Orbit home ${orbitHome}`, { path: dir });
    }
  }
}

function readableFor(worktree: string, extra: string[] | undefined): string[] {
  const common = gitCommonDir(worktree);
  return uniq([...(common ? [common] : []), ...(extra ?? []).map(canonicalPath)]);
}

function resourceLimits(snapshot: PolicySnapshot): { memoryMb: number | null; cpus: number | null; pids: number | null } {
  const c = snapshot.config.isolation.container;
  return { memoryMb: c?.memory_mb ?? null, cpus: c?.cpus ?? null, pids: c?.pids ?? null };
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() ? v : undefined;
}
