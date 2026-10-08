/**
 * Protections Orbit adds to every policy, whatever the user's config says.
 * A user can protect more but can never unprotect these: the snapshot lists
 * the merged set (effective_protected_paths) so every gate and every reviewer
 * sees exactly what was enforced.
 *
 * Protected always wins over allowed. Matching is case-insensitive for these
 * and for user-protected globs, because on a case-insensitive filesystem
 * `.GIT/config` is `.git/config`, and over-protecting fails closed.
 */
import type { OrbitConfig } from './types.ts';

export interface BuiltinProtection {
  glob: string;
  /** Holds secrets: reads are denied too, not only writes. */
  credential: boolean;
  why: string;
}

export const BUILTIN_PROTECTIONS: readonly BuiltinProtection[] = Object.freeze([
  {
    glob: '.orbit/**',
    credential: false,
    why: 'Orbit state, run artifacts and policy snapshots. A worker that could write here could rewrite its own authority or its evidence.',
  },
  {
    glob: '.orbit/config.yaml',
    credential: false,
    why: 'The trusted configuration. Listed on its own so it stays protected even if the .orbit/** entry is ever narrowed.',
  },
  {
    glob: '.git',
    credential: false,
    why: 'In a linked worktree .git is a file naming the shared git dir; rewriting it would point git at another repository.',
  },
  {
    glob: '.git/**',
    credential: false,
    why: 'Git hooks and config run code on the host, and refs decide what gets delivered.',
  },
  {
    glob: '**/.git',
    credential: false,
    why: 'Nested repositories and submodules carry the same gitdir-pointer risk as the top-level .git file.',
  },
  {
    glob: '**/.git/**',
    credential: false,
    why: 'Nested git dirs carry the same hook and config risks as the top-level one.',
  },
  {
    glob: '.claude/settings*.json',
    credential: false,
    why: 'Project settings can declare hooks that run on the host the next time Claude Code starts in this tree, without a trust prompt in -p mode.',
  },
  {
    glob: '.mcp.json',
    credential: false,
    why: 'Project MCP servers are spawned without asking in -p mode, so writing one is code execution on the host.',
  },
  {
    glob: '**/.env*',
    credential: true,
    why: 'Environment files conventionally hold secrets (.env, .env.local, .envrc).',
  },
  {
    glob: '**/*.pem',
    credential: true,
    why: 'Private keys and certificates.',
  },
  {
    glob: '**/id_rsa*',
    credential: true,
    why: 'SSH private keys; the .pub sibling is covered too so a key pair cannot be swapped.',
  },
  {
    glob: '**/id_ed25519*',
    credential: true,
    why: 'SSH private keys of the default modern type, same reasoning as id_rsa.',
  },
  {
    glob: '**/id_ecdsa*',
    credential: true,
    why: 'SSH private keys, same reasoning as id_rsa.',
  },
  {
    glob: '**/id_dsa*',
    credential: true,
    why: 'SSH private keys, same reasoning as id_rsa.',
  },
  {
    glob: '**/.npmrc',
    credential: true,
    why: 'Registry auth tokens; writing one can also redirect package installs to another registry.',
  },
  {
    glob: '**/.netrc',
    credential: true,
    why: 'Plain-text credentials for HTTP and FTP hosts, read automatically by curl and git.',
  },
]);

export const BUILTIN_PROTECTED_PATHS: readonly string[] = Object.freeze(BUILTIN_PROTECTIONS.map((p) => p.glob));

/** Globs whose contents are secrets: the Read tool is denied on these, not just edits. */
export const BUILTIN_CREDENTIAL_PATHS: readonly string[] = Object.freeze(BUILTIN_PROTECTIONS.filter((p) => p.credential).map((p) => p.glob));

// Whole-word patterns, so `src/tokenizer/**` and `packages/keyboard/**` are not credentials.
const CREDENTIAL_GLOB_WORDS = [
  String.raw`(?:^|[^a-z0-9])(?:secrets?|credentials?|passwords?|passwd|htpasswd|keystores?|truststores?)(?![a-z0-9])`,
  String.raw`(?:^|[^a-z0-9])(?:private|api|access|auth|signing|service[_-]?account)[_-]?(?:keys?|tokens?)(?![a-z0-9])`,
  String.raw`\.(?:env|pem|key|keystore|p12|pfx|jks|kdbx|gpg|tfvars|netrc|npmrc|pypirc)(?![a-z0-9])`,
];
const CREDENTIAL_GLOB = new RegExp(CREDENTIAL_GLOB_WORDS.join('|'), 'i');

/**
 * Whether a protected glob names credential material, by what the glob itself says. Protected means "never
 * edit"; it does not mean "never read" (a worker repairing CI must read `.github/**`, and `infra/**` is code),
 * so only a glob that names secrets also denies reads: a segment such as `secrets`, `credentials`, `passwords`,
 * `api_key`, `private-key`, or an extension such as `.key`, `.pem`, `.p12`, `.env`, `.tfvars`. Matching is on whole words.
 */
export function isCredentialGlob(glob: string): boolean {
  return CREDENTIAL_GLOB.test(glob);
}

/**
 * Every glob whose files must be unreadable to a worker: the built-in credential globs plus the policy's own
 * protected globs that name credential material. Built from the snapshot's effective list and the config's list,
 * so a snapshot assembled without one of them can never deny less than the policy says. Used by the Read and
 * Bash judgements, the OS read-deny enumeration and the Claude settings, so the layers cannot disagree.
 */
export function credentialGlobsOf(snapshot: { effective_protected_paths?: readonly string[]; config?: { scope?: { protected_paths?: readonly string[]; credential_paths?: readonly string[] } } }): string[] {
  const out = new Set<string>(BUILTIN_CREDENTIAL_PATHS);
  // Explicit credential locations are authoritative; the name-based reading below is only a fallback.
  for (const glob of snapshot.config?.scope?.credential_paths ?? []) if (typeof glob === 'string') out.add(glob);
  const policy = [...(snapshot.effective_protected_paths ?? []), ...(snapshot.config?.scope?.protected_paths ?? [])];
  for (const glob of policy) if (typeof glob === 'string' && isCredentialGlob(glob)) out.add(glob);
  return [...out];
}

/**
 * Credential locations outside any worktree, relative to the home directory.
 * The OS sandbox is the real control for these; the guard hook denies them
 * too so the denial is immediate and explained.
 */
export const HOME_CREDENTIAL_PATHS: readonly string[] = Object.freeze([
  '.ssh/**',
  '.aws/**',
  '.gnupg/**',
  '.config/gh/**',
  '.config/gcloud/**',
  '.azure/**',
  '.kube/**',
  '.docker/config.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.config/git/credentials',
  // Agent and tool logins: a worker reading these could act as the user elsewhere.
  '.claude/.credentials.json',
  // An IDE extension's lock files (<port>.lock), each with the token of its MCP server on loopback, whose tools act
  // outside every sandbox. Claude Code looks here whatever CLAUDE_CONFIG_DIR says (isolation/profiles.ts CLAUDE_CONFIG_DENIED).
  '.claude/ide/**',
  '.codex/auth.json',
  '.config/hub',
  '.config/glab-cli/**',
  '.config/op/**',
  '.vault-token',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.gem/credentials',
  '.pgpass',
  '.my.cnf',
  '.terraform.d/credentials.tfrc.json',
  '.yarnrc.yml',
  '.m2/settings.xml',
  '.gradle/gradle.properties',
  '.password-store/**',
  '.local/share/keyrings/**',
  'Library/Keychains/**',
]);

/** Built-ins first, then the user's globs, without duplicates. */
export function effectiveProtectedPaths(config: Pick<OrbitConfig, 'scope'>): string[] {
  const out: string[] = [];
  for (const glob of [...BUILTIN_PROTECTED_PATHS, ...config.scope.protected_paths]) {
    if (!out.includes(glob)) out.push(glob);
  }
  return out;
}
