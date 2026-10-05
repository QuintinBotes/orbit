/**
 * `authorize(snapshot, op)`: the single decision point for every operation a
 * worker or the controller wants to perform (spec §5 Implementation gate).
 * Decisions are pure functions of the frozen snapshot, the operation and the
 * filesystem as it is now; nothing a model says can widen them.
 *
 * Rules, in the order they are applied:
 *   edit        actions.edit; canonical path inside the worktree; protected
 *               paths always win; then scope.allowed_paths; default deny.
 *   read        denied only for credential files (built-in credential globs
 *               anywhere, well-known credential locations under $HOME).
 *   action      actions.<name> must be true AND the mode must permit it
 *               (delivery actions need autonomous-delivery or release; merge
 *               and deploy_production need release).
 *   dependency  dependencies.add_packages / change_lockfile / install_scripts.
 *   network     host must match network.allowed_hosts (see hosts.ts forms).
 *   bash        classifyBash, then the rules above for whatever it found;
 *               commands that change file modes, owners, ACLs or flags
 *               need actions.change_permissions;
 *               write targets are resolved like edits, globs are expanded
 *               against the disk and also judged as patterns, link targets
 *               count as writes, and files with other hard links are never
 *               written in place (an Edit included).
 *
 * Any internal error yields a deny: this function never fails open.
 */
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import picomatch from 'picomatch';
import type { AuthorizationDecision, Operation, OrbitConfig, PolicySnapshot } from './types.ts';
import { BUILTIN_PROTECTED_PATHS, HOME_CREDENTIAL_PATHS, credentialGlobsOf } from './builtin.ts';
import { compileGlobs, globBases, hasGlobChars, stripDotSlash, type PathMatcher } from './globs.ts';
import { canonicalize, isCaseInsensitiveFs, relativeInside, resolveDetailed, toPosix } from './paths.ts';
import { hostAllowed, normalizeHost } from './hosts.ts';
import { BASH_CATEGORIES_BY_SEVERITY, classifyBash, type BashCommandInfo, type BashRead, type BashWrite } from './bash.ts';
import { DELIVERY_ACTIONS, DELIVERY_MODES, RELEASE_ACTIONS } from './config.ts';

export interface AuthorizeContext {
  /** Absolute worktree root edits are confined to. Required for edit and bash; read uses it when given. */
  worktreeRoot?: string;
  /** Directory a bash command starts in (the hook input's cwd). Defaults to worktreeRoot. */
  cwd?: string;
  /** Home directory for credential locations and `~`. Defaults to os.homedir(). */
  home?: string;
}

export function authorize(snapshot: PolicySnapshot, op: Operation, ctx: AuthorizeContext = {}): AuthorizationDecision {
  try {
    if (!op || typeof op !== 'object') return deny('op.invalid', 'operation is missing');
    const c = compiled(snapshot);
    switch (op.kind) {
      case 'edit':
        return authorizeEdit(snapshot.config, c, op.path, ctx);
      case 'read':
        return authorizeRead(c, op.path, ctx);
      case 'action':
        return authorizeAction(snapshot.config, op.action, op.target);
      case 'dependency':
        return authorizeDependency(snapshot.config, op.change, op.detail);
      case 'network':
        return authorizeNetwork(snapshot.config, op.host);
      case 'bash':
        return authorizeBash(snapshot.config, c, op.command, ctx);
      default:
        return deny('op.invalid', `unknown operation kind ${JSON.stringify((op as { kind?: unknown }).kind)}`);
    }
  } catch (err) {
    return deny('internal.error', `authorization failed closed: ${(err as Error).message}`);
  }
}

function allow(rule: string, reason: string): AuthorizationDecision {
  return { allowed: true, rule, reason };
}

function deny(rule: string, reason: string): AuthorizationDecision {
  return { allowed: false, rule, reason };
}

// ---------------------------------------------------------------------------
// Compiled matchers, cached per snapshot object

interface Compiled {
  protectedPaths: PathMatcher;
  /** The protected globs themselves, for judging shell glob patterns against them. */
  protectedGlobs: string[];
  protectedBases: string[];
  allowed: PathMatcher;
  credential: PathMatcher;
  homeCredential: PathMatcher;
}

const cache = new WeakMap<PolicySnapshot, Compiled>();

function compiled(snapshot: PolicySnapshot): Compiled {
  const hit = cache.get(snapshot);
  if (hit) return hit;
  // Union with the built-ins and the config's own list, so a snapshot assembled
  // without effective_protected_paths can never protect less than the policy says.
  const protectedGlobs = [...new Set([...BUILTIN_PROTECTED_PATHS, ...(snapshot.effective_protected_paths ?? []), ...snapshot.config.scope.protected_paths])];
  const c: Compiled = {
    protectedPaths: compileGlobs(protectedGlobs, { nocase: true }),
    protectedGlobs,
    protectedBases: globBases(protectedGlobs),
    allowed: compileGlobs(snapshot.config.scope.allowed_paths, { nocase: false }),
    // The built-in credential globs and the policy's own protected globs that name credentials (ADR 0005).
    credential: compileGlobs(credentialGlobsOf(snapshot), { nocase: true }),
    homeCredential: compileGlobs(HOME_CREDENTIAL_PATHS, { nocase: true }),
  };
  cache.set(snapshot, c);
  return c;
}

// ---------------------------------------------------------------------------
// edit / read

function authorizeEdit(config: OrbitConfig, c: Compiled, path: unknown, ctx: AuthorizeContext): AuthorizationDecision {
  if (config.actions.edit !== true) return deny('actions.edit', 'editing files is not authorized by this policy');
  if (typeof path !== 'string' || path.length === 0) return deny('path.invalid', 'the path is missing');
  if (!ctx.worktreeRoot) return deny('scope.no-root', 'no worktree root to confine the edit to');
  let res;
  try {
    res = resolveDetailed(ctx.worktreeRoot, path);
  } catch (err) {
    return deny('path.invalid', `cannot resolve ${path}: ${(err as Error).message}`);
  }
  if (res.rel === null) return deny('scope.outside-root', `${path} resolves outside the worktree`);
  const lexical = lexicalRel(ctx.worktreeRoot, res.root, path);
  if (c.protectedPaths(res.rel) || (lexical !== null && c.protectedPaths(lexical))) {
    return deny('scope.protected', `${lexical ?? res.rel} is a protected path`);
  }
  if (res.rel === '.') return deny('scope.not-allowed', 'the worktree root itself is not an editable file');
  if (hardLinked(res.abs)) return deny('scope.hardlink', `${res.rel} has other hard links, so writing it also changes a file under another name`);
  if (c.allowed(res.rel)) return allow('scope.allowed', `${res.rel} is inside scope.allowed_paths`);
  return deny('scope.not-allowed', `${res.rel} is not inside scope.allowed_paths`);
}

function authorizeRead(c: Compiled, path: unknown, ctx: AuthorizeContext): AuthorizationDecision {
  if (typeof path !== 'string' || path.length === 0) return deny('path.invalid', 'the path is missing');
  if (path.includes('\0')) return deny('path.invalid', 'the path contains a NUL byte');
  const home = ctx.home ?? homedir();
  let abs: string;
  if (isAbsolute(path)) abs = path;
  else if (ctx.worktreeRoot) abs = `${ctx.worktreeRoot}${sep}${path}`;
  else return c.credential(toPosix(posix.normalize(path))) ? deny('read.credential', `${path} holds credentials`) : allow('read.allowed', 'not a credential file');
  let canonical: string;
  try {
    canonical = canonicalize(abs);
  } catch (err) {
    return deny('path.invalid', `cannot resolve ${path}: ${(err as Error).message}`);
  }
  // Judge both the name used and the file reached: a symlink named README pointing at .env is still .env.
  for (const p of [canonical, abs]) {
    if (c.credential(stripRoot(toPosix(p)))) return deny('read.credential', `${path} holds credentials`);
    // Policy globs are worktree-relative (`secrets/**`), so they are judged against the path inside the worktree too.
    if (insideWorktree(ctx.worktreeRoot, p).some((rel) => c.credential(rel))) return deny('read.credential', `${path} holds credentials`);
    const underHome = homeRelative(home, p);
    if (underHome !== null && c.homeCredential(underHome)) return deny('read.credential', `${path} is a credential location`);
  }
  return allow('read.allowed', 'not a credential file');
}

/** The worktree-relative spellings of an absolute path (through the root as written and as resolved); empty when it is outside. */
function insideWorktree(root: string | undefined, p: string): string[] {
  if (!root) return [];
  let rootReal = root;
  try {
    rootReal = realpathSync.native(root);
  } catch {
    // A root that does not exist holds nothing to match.
  }
  const ci = isCaseInsensitiveFs(rootReal);
  const out: string[] = [];
  for (const r of new Set([root, rootReal])) {
    const rel = relativeInside(r, p, ci);
    if (rel !== null && rel !== '.') out.push(rel);
  }
  return out;
}

function homeRelative(home: string, p: string): string | null {
  let homeReal = home;
  try {
    homeReal = realpathSync.native(home);
  } catch {
    // A home that does not exist cannot hold credentials to protect.
  }
  for (const h of new Set([home, homeReal])) {
    const rel = relativeInside(h, p, isCaseInsensitiveFs(homeReal));
    if (rel !== null && rel !== '.') return rel;
  }
  return null;
}

/** The candidate as written, made root-relative without resolving anything; null when it climbs out. */
function lexicalRel(root: string, rootReal: string, candidate: string): string | null {
  const tries = isAbsolute(candidate) ? [relative(root, candidate), relative(rootReal, candidate)] : [posix.normalize(toPosix(candidate))];
  for (const t of tries) {
    const p = toPosix(t);
    if (p === '' ) return '.';
    if (p === '..' || p.startsWith('../') || isAbsolute(p)) continue;
    return stripDotSlash(posix.normalize(p));
  }
  return null;
}

function stripRoot(p: string): string {
  return p.replace(/^\/+/, '');
}

// ---------------------------------------------------------------------------
// actions, dependencies, network

const REF_FORBIDDEN = /(\.\.|@\{|[\s~^:?*[\\\x00-\x1f\x7f]|\/\/|\/\.|\.lock$|\.lock\/|\/$|\.$)/;

function authorizeAction(config: OrbitConfig, action: unknown, target: unknown): AuthorizationDecision {
  if (typeof action !== 'string' || !Object.hasOwn(config.actions, action)) return deny('op.invalid', `unknown action ${JSON.stringify(action)}`);
  const name = action as keyof OrbitConfig['actions'];
  if (config.actions[name] !== true) return deny(`actions.${name}`, `${name} is not authorized by this policy`);
  if ((DELIVERY_ACTIONS as readonly string[]).includes(name) && !DELIVERY_MODES.has(config.mode)) {
    return deny('mode.delivery-required', `${name} needs mode autonomous-delivery or release; this run is ${config.mode}`);
  }
  if ((RELEASE_ACTIONS as readonly string[]).includes(name) && config.mode !== 'release') {
    return deny('mode.release-required', `${name} needs mode release; this run is ${config.mode}`);
  }
  if (name === 'push_task_branch') {
    if (typeof target !== 'string' || target.length === 0) return deny('actions.push_task_branch.target', 'a push must name its task branch');
    const branch = target.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : target;
    const { branch_prefix, base_branch } = config.repository;
    if (target.startsWith('refs/') && !target.startsWith('refs/heads/')) return deny('actions.push_task_branch.target', `${target} is not a branch`);
    if (!branch.startsWith(branch_prefix) || branch.length === branch_prefix.length) {
      return deny('actions.push_task_branch.target', `${branch} is not a task branch (task branches start with ${branch_prefix})`);
    }
    if (branch === base_branch) return deny('actions.push_task_branch.target', 'the base branch is never a push target');
    if (REF_FORBIDDEN.test(branch) || branch.startsWith('-')) return deny('actions.push_task_branch.target', `${branch} is not a valid branch name`);
  }
  if (name === 'open_pull_request' && config.delivery.pull_request === 'none') {
    return deny('delivery.pull_request', 'delivery.pull_request is "none"');
  }
  return allow(`actions.${name}`, `${name} is authorized in mode ${config.mode}`);
}

function authorizeDependency(config: OrbitConfig, change: unknown, detail: unknown): AuthorizationDecision {
  const deps = config.dependencies;
  switch (change) {
    case 'add_package':
      return deps.add_packages ? allow('dependencies.add_packages', 'adding packages is authorized') : deny('dependencies.add_packages', `adding packages is not authorized (${String(detail ?? '')})`.replace(' ()', ''));
    case 'change_lockfile':
      return deps.change_lockfile ? allow('dependencies.change_lockfile', 'lockfile changes are authorized') : deny('dependencies.change_lockfile', 'lockfile changes are not authorized');
    case 'install_script': {
      if (deps.install_scripts === 'allow') return allow('dependencies.install_scripts', 'install scripts are allowed');
      if (deps.install_scripts === 'deny') return deny('dependencies.install_scripts', 'install scripts are denied');
      const pkg = typeof detail === 'string' ? detail : '';
      return deps.install_script_allowlist.includes(pkg)
        ? allow('dependencies.install_scripts', `${pkg} is on install_script_allowlist`)
        : deny('dependencies.install_scripts', `${pkg || 'this package'} is not on install_script_allowlist`);
    }
    default:
      return deny('op.invalid', `unknown dependency change ${JSON.stringify(change)}`);
  }
}

function authorizeNetwork(config: OrbitConfig, host: unknown): AuthorizationDecision {
  if (typeof host !== 'string') return deny('network.invalid-host', 'the host is missing');
  const h = normalizeHost(host);
  if (h === null) return deny('network.invalid-host', `${JSON.stringify(host)} is not a host name`);
  return hostAllowed(h, config.network.allowed_hosts) ? allow('network.allowed', `${h} is in network.allowed_hosts`) : deny('network.not-allowed', `${h} is not in network.allowed_hosts`);
}

// ---------------------------------------------------------------------------
// bash

function authorizeBash(config: OrbitConfig, c: Compiled, command: unknown, ctx: AuthorizeContext): AuthorizationDecision {
  if (typeof command !== 'string') return deny('bash.unparseable', 'the command is missing');
  if (!ctx.worktreeRoot) return deny('scope.no-root', 'no worktree root to judge the command against');
  let root: string;
  try {
    root = realpathSync.native(ctx.worktreeRoot);
  } catch {
    return deny('scope.no-root', 'the worktree root does not exist');
  }
  const cwd = ctx.cwd && isAbsolute(ctx.cwd) ? ctx.cwd : root;
  const cls = classifyBash(command, { cwd, root, home: ctx.home ?? homedir() });
  if (!cls.parsed) return deny('bash.unparseable', `the command cannot be inspected: ${cls.reasons[0] ?? 'parse error'}`);
  if (cls.opaque) return deny('bash.opaque', `part of the command is hidden from inspection: ${cls.reasons[0] ?? 'opaque'}`);

  for (const category of BASH_CATEGORIES_BY_SEVERITY) {
    for (const cmd of cls.commands.filter((x) => x.category === category)) {
      const d = judgeCommand(config, cmd);
      if (d) return d;
    }
  }
  if (config.actions.change_permissions !== true) {
    const perm = cls.commands.find((x) => PERMISSION_COMMANDS.has(commandName(x.argv[0]))) ?? cls.writes.find((w) => PERMISSION_COMMANDS.has(commandName(w.via)));
    if (perm) {
      const what = 'argv' in perm ? perm.argv.slice(0, 3).join(' ') : `${perm.via} ${perm.path}`;
      return deny('actions.change_permissions', `${what} changes file permissions, which this policy does not authorize (actions.change_permissions is false)`);
    }
  }
  for (const w of cls.writes) {
    const d = judgeWrite(config, c, w, root);
    if (d) return d;
  }
  // Advisory layer: the OS read-deny list is the real control (ADR 0005), this makes the denial immediate and explained.
  for (const r of cls.reads) {
    const d = judgeRead(c, r, root, ctx.home ?? homedir());
    if (d) return d;
  }
  return allow('bash.allowed', `${cls.category}: nothing statically denied (advisory; the OS sandbox and diff inspection still apply)`);
}

/** Commands that change file modes, owners, ACLs or flags: actions.change_permissions. */
export const PERMISSION_COMMANDS: ReadonlySet<string> = new Set(['chmod', 'chown', 'chgrp', 'chflags', 'chattr', 'setfacl', 'lchmod', 'lchown']);

function commandName(word: string | undefined): string {
  return (word ?? '').split('/').pop() ?? '';
}

function judgeCommand(config: OrbitConfig, cmd: BashCommandInfo): AuthorizationDecision | null {
  const why = cmd.reasons[0] ?? cmd.argv.slice(0, 3).join(' ');
  switch (cmd.category) {
    case 'privilege':
      return deny('bash.privilege', why);
    case 'destructive':
      return deny('bash.destructive', why);
    case 'publish':
      return deny('bash.publish', why);
    case 'vcs-write':
      return deny('bash.vcs-write', `${why}; the controller creates candidates and delivers them`);
    case 'package-install': {
      const deps = config.dependencies;
      if (cmd.install === 'locked') {
        if (!deps.install_existing_lockfile) return deny('dependencies.install_existing_lockfile', `${why}; installing from the lockfile is not authorized`);
      } else if (!deps.add_packages) {
        return deny('dependencies.add_packages', `${why}; dependencies.add_packages is false`);
      }
      if (cmd.ignoreScripts === false && deps.install_scripts !== 'allow') {
        return deny('dependencies.install_scripts', `${why}; lifecycle scripts are not allowed by policy (install_scripts: ${deps.install_scripts}), so pass --ignore-scripts`);
      }
      return null;
    }
    case 'network': {
      if (!cmd.hostsComplete || cmd.hosts.length === 0) return deny('network.unknown-destination', `${why}; the destination is not statically known`);
      for (const h of cmd.hosts) {
        if (!hostAllowed(h, config.network.allowed_hosts)) return deny('network.not-allowed', `${h} is not in network.allowed_hosts`);
      }
      return null;
    }
    default:
      return null;
  }
}

let tempRootsCache: string[] | null = null;

/** Scratch locations writes may go to outside the worktree; the sandbox decides what is really writable there. */
function tempRoots(): string[] {
  if (tempRootsCache) return tempRootsCache;
  const out = new Set<string>();
  for (const p of ['/tmp', '/private/tmp', '/var/tmp', tmpdir()]) {
    try {
      out.add(canonicalize(p));
    } catch {
      // Missing on this platform.
    }
  }
  tempRootsCache = [...out];
  return tempRootsCache;
}

/** A static read of a credential path (built-in credential globs, well-known credential locations under home). */
function judgeRead(c: Compiled, r: BashRead, root: string, home: string): AuthorizationDecision | null {
  const denied = (shown: string): AuthorizationDecision => deny('bash.credential-read', `${r.via} reads ${shown}, which holds credentials`);
  if (r.abs === null) {
    // Only known at run time: the literal text (a variable in front of `.env`) is all there is to check.
    return c.credential(stripDotSlash(toPosix(posix.normalize(r.path.replace(/^\/+/, ''))))) ? denied(r.path) : null;
  }
  const targets = r.glob ? expandOnDisk(r.abs) : [r.abs];
  if (targets === null) return deny('bash.glob-too-broad', `${r.via} ${r.path} matches too many files to inspect`);
  if (r.glob && (c.credential(stripRoot(toPosix(r.abs))) || insideWorktree(root, r.abs).some((rel) => c.credential(rel)))) return denied(r.path);
  for (const t of targets) {
    const d = authorizeRead(c, t, { worktreeRoot: root, home });
    if (!d.allowed) return denied(r.glob ? t : r.path);
  }
  return null;
}

function judgeWrite(config: OrbitConfig, c: Compiled, w: BashWrite, root: string): AuthorizationDecision | null {
  const via = w.via;
  if (w.unknownDir) {
    return deny('bash.unknown-directory', `${via} ${verb(w)} ${w.path} relative to a directory the command moved to in a way that cannot be followed (cd -, popd, cd "$VAR"); name it from the worktree root instead`);
  }
  if (w.abs === null) {
    // Target only known at run time; the literal text is all there is to check.
    const text = stripDotSlash(w.path);
    if (!text.startsWith('/') && c.protectedPaths(text)) return deny('bash.protected-write', `${via} ${verb(w)} ${w.path}, a protected path`);
    return null;
  }
  if (w.glob) {
    // The shell expands the pattern against the files that exist when it runs, which is now.
    const matches = expandOnDisk(w.abs);
    if (matches === null) return deny('bash.glob-too-broad', `${via} ${w.path} matches too many files to inspect`);
    for (const m of matches) {
      const d = judgeTarget(config, c, w, m, root);
      if (d) return d;
    }
    // A directory made earlier in the same command line is not on disk yet; judge what the pattern could match.
    let res;
    try {
      res = resolveDetailed(root, w.abs);
    } catch (err) {
      return deny('path.invalid', `cannot resolve ${w.path}: ${(err as Error).message}`);
    }
    if (res.rel !== null && patternMayHitProtected(res.rel, c, prefixMatters(w))) return deny('bash.protected-write', `${via} ${w.path} can match a protected path`);
  }
  return judgeTarget(config, c, w, w.abs, root);
}

function verb(w: BashWrite): string {
  return w.kind === 'delete' ? 'deletes' : w.kind === 'link' ? 'links to' : 'writes';
}

/** Whether paths below the target count: a recursive delete, a link to a directory, an archive extracted into it. */
function prefixMatters(w: BashWrite): boolean {
  return (w.kind === 'delete' && w.recursive) || w.kind === 'link' || w.unpack === true;
}

function judgeTarget(config: OrbitConfig, c: Compiled, w: BashWrite, abs: string, root: string): AuthorizationDecision | null {
  const via = w.via;
  let res;
  try {
    res = resolveDetailed(root, abs);
  } catch (err) {
    return deny('path.invalid', `cannot resolve ${w.path}: ${(err as Error).message}`);
  }
  if (res.rel === null) {
    const ci = isCaseInsensitiveFs(root);
    if (tempRoots().some((t) => relativeInside(t, res.abs, ci) !== null)) return null;
    return deny('bash.write-outside-root', `${via} ${verb(w)} ${w.path}, outside the worktree`);
  }
  const rel = res.rel;
  if (c.protectedPaths(rel)) return deny('bash.protected-write', `${via} ${verb(w)} ${rel}, a protected path`);
  if ((prefixMatters(w) || (w.kind === 'delete' && rel === '.')) && rel !== null) {
    const hit = c.protectedBases.find((b) => rel === '.' || b === rel || b.startsWith(`${rel}/`));
    if (hit) return deny('bash.protected-write', `${via} ${w.path} would ${w.kind === 'delete' ? 'delete' : 'expose'} the protected path ${hit}`);
  }
  if (w.kind === 'write' && hardLinked(res.abs)) return deny('scope.hardlink', `${via} writes ${rel}, which has other hard links, so the write also changes a file under another name`);
  if (w.kind !== 'link' && config.actions.edit !== true) return deny('actions.edit', `${via} writes ${rel}, but editing files is not authorized by this policy`);
  return null;
}

/** An existing regular file with more than one name: writing it in place changes every name. */
function hardLinked(abs: string): boolean {
  try {
    const st = lstatSync(abs);
    return st.isFile() && st.nlink > 1;
  } catch {
    return false;
  }
}

const MAX_GLOB_ENTRIES = 20_000;

/**
 * Existing paths an absolute shell glob expands to, the way bash does it:
 * segment by segment, `*` and `?` not matching a leading dot unless the
 * segment starts with one. Matching ignores case, which can only add
 * candidates. Null when the expansion is too large to judge in a hook.
 */
function expandOnDisk(pattern: string): string[] | null {
  let paths = ['/'];
  let visited = 0;
  for (const seg of pattern.split('/').filter((x) => x.length > 0)) {
    const next: string[] = [];
    if (!/[*?[]/.test(seg)) {
      for (const p of paths) next.push(join(p, seg));
    } else {
      const match = picomatch(seg, { dot: seg.startsWith('.'), nocase: true, windows: false });
      for (const p of paths) {
        let entries: string[];
        try {
          entries = readdirSync(p);
        } catch {
          continue;
        }
        for (const e of entries) {
          if ((visited += 1) > MAX_GLOB_ENTRIES) return null;
          if (e !== '.' && e !== '..' && match(e)) next.push(join(p, e));
        }
      }
    }
    paths = next;
    if (paths.length === 0) return [];
  }
  return paths.filter((p) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Whether a root-relative shell glob could name a protected path, judged
 * segment by segment against every protected glob. Only patterns that can
 * reach a protected name count: a bare `*` never matches `.claude` (no
 * dotglob), and a pure wildcard is left to the on-disk expansion, since a
 * protected file it could reach would have to be created first, which is a
 * protected write itself. With `prefix`, matching a directory above a
 * root-anchored protected path counts too.
 */
function patternMayHitProtected(rel: string, c: Compiled, prefix: boolean): boolean {
  const target = rel.split('/');
  return c.protectedGlobs.some((g) => {
    const prot = g.split('/');
    return segmentsMayMeet(target, prot, prefix && prot[0] !== '**');
  });
}

function segmentsMayMeet(t: string[], p: string[], prefix: boolean): boolean {
  const memo = new Map<string, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (j === p.length) r = i === t.length;
    else if (p[j] === '**') r = go(i, j + 1) || (i < t.length && go(i + 1, j));
    else if (i === t.length) r = prefix;
    else r = segmentMayMatch(t[i]!, p[j]!) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

function segmentMayMatch(shellSeg: string, protSeg: string): boolean {
  const tg = /[*?[]/.test(shellSeg);
  const pg = hasGlobChars(protSeg) || protSeg.includes('{');
  const shell = (x: string) => picomatch(shellSeg, { dot: shellSeg.startsWith('.'), nocase: true, windows: false })(x);
  const prot = (x: string) => picomatch(protSeg, { dot: true, nocase: true, windows: false })(x);
  try {
    if (!tg && !pg) return shellSeg.toLowerCase() === protSeg.toLowerCase();
    if (!tg) return prot(shellSeg);
    if (!pg) return shell(protSeg);
    if (shellSeg.replace(/[*?]/g, '') === '') return false;
    return globSamples(protSeg).some(shell) || globSamples(shellSeg).some(prot);
  } catch {
    // An unparseable pattern cannot be judged; treat it as able to match.
    return true;
  }
}

/** Concrete names a glob segment matches: wildcards empty or filled, the first choice of each class or brace list. */
function globSamples(seg: string): string[] {
  const fixed = seg
    .replace(/\{([^,}]*)[^}]*\}/g, '$1')
    .replace(/\[!?\^?([^\]])[^\]]*\]/g, '$1')
    .replace(/\?/g, 'a');
  return [fixed.replace(/\*+/g, ''), fixed.replace(/\*+/g, 'x')];
}
