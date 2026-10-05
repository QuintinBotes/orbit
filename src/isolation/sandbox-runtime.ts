import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import type { IsolationLimits } from '../policy/types.ts';
import { describeLimits, hasLimits, withResourceLimits } from './limits.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from './types.ts';
import {
  assertArgv,
  assertRepresentablePath,
  canonicalPath,
  isExecutableFile,
  isWithin,
  probeFailure,
  readablePathsOf,
  runBounded,
  uniq,
  which,
  withoutNested,
} from './util.ts';

/**
 * Anthropic's sandbox runtime (`srt`, docs/interfaces/claude-headless-and-sandbox.md
 * section 4): Seatbelt on macOS, bubblewrap on Linux. Every wrap writes its
 * own settings file and passes it with `--settings`, because srt refuses to
 * start when a named settings file is missing, empty or invalid, while with
 * no `--settings` at all it would quietly fall back to ~/.srt-settings.json or
 * its built-in defaults. Naming the file is what makes it fail closed.
 */

/** The subset of srt's settings schema (0.0.78, `dist/sandbox/sandbox-config.js`) Orbit writes. */
export interface SrtSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    /** Deny anything off the list outright instead of consulting an ask callback. */
    strictAllowlist: true;
    /** A permitted name must not resolve into the local network (DNS rebinding to LAN services). */
    deniedResolvedAddresses: string[];
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    /** srt semantics: allowRead re-opens a region inside denyRead; a more specific denyRead inside it stays denied. */
    allowRead: string[];
    allowWrite: string[];
    /** Beats allowWrite. */
    denyWrite: string[];
  };
}

/**
 * Ranges an allowed hostname may not resolve to (DNS rebinding into local
 * services); srt already refuses loopback, link-local and metadata
 * addresses. Besides RFC 1918 and IPv6 ULA: carrier-grade NAT, which VPN
 * overlays such as Tailscale use, and the benchmarking range, where OrbStack
 * puts its VM and container network.
 */
export const DENIED_RESOLVED_ADDRESSES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '198.18.0.0/15', 'fc00::/7'];

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_PATTERN = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*(?::(\\d{1,5}))?$`);
const IPV6_PATTERN = /^\[[0-9a-f:.]+\](?::(\d{1,5}))?$/;

/**
 * Accepts what srt's allowedDomains accepts and Orbit's config uses: a host,
 * `*.suffix`, an optional `:port`, or a bracketed IPv6 literal. Anything else
 * (a URL, a bare `*`, whitespace) is a configuration mistake, and passing it on
 * would make srt refuse to start with a less useful message.
 */
export function normalizeHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  const match = HOST_PATTERN.exec(host) ?? IPV6_PATTERN.exec(host);
  const port = match?.[1] === undefined ? null : Number(match[1]);
  if (!match || (port !== null && (port < 1 || port > 65535))) {
    throw new OrbitError('CONFIG_INVALID', `network host ${JSON.stringify(raw)} is not a host name, *.suffix or [ipv6], with an optional :port`, { host: raw });
  }
  return host;
}

/**
 * Translate a profile into srt settings. Pure apart from resolving symlinks,
 * so tests can assert the exact rules a sandbox would get.
 *
 * - Writes are denied by default; allowWrite is exactly the writable paths.
 * - A writable or read-only path inside a denied region (the worktree under
 *   ~/.orbit, the git directory under a denied projects directory) is added
 *   to allowRead, since a process that cannot read what it may write cannot
 *   work.
 * - A denied path inside a writable path is also write-denied: whatever the
 *   profile says must not be read is trusted or secret, and overwriting it is
 *   worse than reading it.
 * - A read-only path inside a writable path is write-denied: that is how a
 *   worker keeps its worktree and config directory but cannot touch the
 *   settings, hooks or result files the controller trusts. srt's denyWrite
 *   beats allowWrite whatever their nesting.
 * - No hosts means no network.
 */
export function buildSrtSettings(profile: SandboxProfile, opts: { extraDenyRead?: string[] } = {}): SrtSettings {
  const prepare = (paths: string[], what: string) =>
    uniq(
      paths.map((p) => {
        assertRepresentablePath(p, what);
        return canonicalPath(p);
      }),
    );
  const writable = prepare(profile.writablePaths, 'writable path');
  const denied = prepare([...profile.denyReadPaths, ...(opts.extraDenyRead ?? [])], 'read-denied path');
  const readOnly = prepare(readablePathsOf(profile), 'read-only path');
  const hosts = uniq(profile.allowedHosts.map(normalizeHost));

  const contradiction = writable.find((w) => denied.includes(w));
  if (contradiction) throw new OrbitError('INTERNAL', `${contradiction} is both writable and read-denied in one profile`);

  const insideDenied = (p: string) => denied.some((d) => isWithin(p, d));
  const insideWritable = (p: string) => writable.some((w) => isWithin(p, w));
  // A writable path at or below a write-denied read-only path would silently
  // lose its write access; that is a profile bug, not a policy.
  const shadowed = writable.find((w) => readOnly.some((r) => isWithin(w, r) && insideWritable(r)));
  if (shadowed) throw new OrbitError('INTERNAL', `${shadowed} is both writable and read-only in one profile`);
  return {
    network: {
      allowedDomains: hosts,
      deniedDomains: [],
      strictAllowlist: true,
      deniedResolvedAddresses: [...DENIED_RESOLVED_ADDRESSES],
      allowLocalBinding: profile.allowLocalBinding === true,
    },
    filesystem: {
      // Nested denies are kept on purpose: a deny inside a re-allowed path
      // only stays denied if srt sees it as the more specific rule.
      denyRead: denied,
      allowRead: uniq([...writable, ...readOnly].filter(insideDenied)),
      allowWrite: withoutNested(writable),
      denyWrite: uniq([...denied.filter((d) => !writable.includes(d)), ...readOnly].filter(insideWritable)),
    },
  };
}

export interface SandboxRuntimeOptions {
  /** Explicit srt binary (absolute). When set it is the only candidate: a missing configured binary means unavailable, never a fallback to another srt. */
  srtPath?: string;
  /** Orbit's install directory; `node_modules/.bin/srt` beneath it is the last candidate. */
  orbitInstallDir?: string;
  /** Where per-invocation settings directories go. Defaults to the OS temp directory. */
  settingsDir?: string;
  /** Overrides for tests. */
  platform?: NodeJS.Platform;
  arch?: string;
  pathEnv?: string;
  probeTimeoutMs?: number;
  /** `isolation.limits`: CPU time, process count and file size, applied with ulimit inside the sandbox (isolation/limits.ts). */
  limits?: IsolationLimits | null;
  /** bash used to apply the limits; undefined searches the usual locations, null means there is none (tests). */
  limitShell?: string | null;
}

export type SrtSource = 'configured' | 'PATH' | 'install';

/**
 * Stated on every wrap so evidence records and `orbit doctor` never imply
 * protection srt does not give (docs/decisions/0001-runtime-choices.md).
 */
export const SRT_LIMITATIONS: readonly string[] = [
  'sandbox-runtime enforces no CPU, memory or process-count limits; it confines filesystem access and network egress only.',
  "The wall-clock limit is not enforced by the sandbox; the caller enforces it by killing the wrapped command's process group.",
  "When the process group is killed with SIGTERM or SIGINT, srt exits 0, so the caller must record its own kill and never read that exit status as success.",
  'Reads are allowed everywhere except the denied paths; files not on the deny list (for example the rest of the home directory) stay readable.',
  'srt always allows writes to /tmp/claude (shared by every srt sandbox on this machine) and, unless read-denied, ~/.npm/_logs and ~/.claude/debug.',
  'Egress is filtered by host name through a local proxy: programs that ignore HTTP_PROXY/HTTPS_PROXY get no network at all, and traffic to an allowed host is not inspected.',
  "srt, node and the shell tools that start the sandbox run outside it; they get a PATH without relative entries or directories the sandbox can write, and without loader variables (NODE_OPTIONS, LD_*, DYLD_*...). The command's own values are restored inside the sandbox through /usr/bin/env.",
];

const LINUX_LIMITATION = 'On Linux the mandatory write denies inside writable paths (.git/hooks, shell rc files...) are found by a scan at launch, so such files created later are not covered.';

/** srt's seccomp helper is prebuilt for these architectures only (srt 0.0.78 `getVendorArchitecture`). */
const SECCOMP_ARCHES: Record<string, string> = { x64: 'x64', arm64: 'arm64' };

export class SandboxRuntimeIsolation implements IsolationProvider {
  readonly kind = 'sandbox-runtime' as const;
  private readonly opts: SandboxRuntimeOptions;
  private readonly platform: NodeJS.Platform;
  private readonly pathEnv: string | undefined;

  constructor(opts: SandboxRuntimeOptions = {}) {
    this.opts = opts;
    this.platform = opts.platform ?? process.platform;
    this.pathEnv = opts.pathEnv ?? process.env.PATH;
  }

  resolveSrt(): { path: string; source: SrtSource } | null {
    if (this.opts.srtPath !== undefined) {
      return isAbsolute(this.opts.srtPath) && isExecutableFile(this.opts.srtPath) ? { path: this.opts.srtPath, source: 'configured' } : null;
    }
    const onPath = which('srt', this.pathEnv);
    if (onPath) return { path: onPath, source: 'PATH' };
    if (this.opts.orbitInstallDir && isAbsolute(this.opts.orbitInstallDir)) {
      const bundled = join(this.opts.orbitInstallDir, 'node_modules', '.bin', 'srt');
      if (isExecutableFile(bundled)) return { path: bundled, source: 'install' };
    }
    return null;
  }

  /**
   * The OS mechanism srt drives, or why this host cannot run it. Synchronous
   * so wrap() can fail closed too. Given the srt binary, it also checks on
   * Linux that srt can block Unix sockets: without its seccomp helper srt
   * only logs a debug warning and runs the command with every Unix socket
   * reachable (the Docker socket, the D-Bus session bus, SSH and GPG agents),
   * any of which undoes the sandbox.
   */
  platformCheck(srtPath?: string): { ok: boolean; detail: string } {
    if (this.platform === 'darwin') {
      return isExecutableFile('/usr/bin/sandbox-exec') ? { ok: true, detail: 'macOS Seatbelt (/usr/bin/sandbox-exec)' } : { ok: false, detail: '/usr/bin/sandbox-exec is missing' };
    }
    if (this.platform === 'linux') {
      if (isWsl1()) return { ok: false, detail: 'WSL1 cannot run bubblewrap; use WSL2' };
      const missing = ['bwrap', 'socat', 'rg'].filter((tool) => !which(tool, this.pathEnv));
      if (missing.length) return { ok: false, detail: `missing on PATH: ${missing.join(', ')} (srt needs bubblewrap, socat and ripgrep on Linux)` };
      if (srtPath !== undefined && !seccompHelperFor(srtPath, this.opts.arch ?? process.arch)) {
        return { ok: false, detail: `srt at ${srtPath} has no apply-seccomp helper for ${this.opts.arch ?? process.arch}, so it could not block Unix sockets (Docker, D-Bus, SSH agent) inside the sandbox` };
      }
      return { ok: true, detail: 'Linux bubblewrap with seccomp Unix-socket blocking' };
    }
    return { ok: false, detail: `sandbox-runtime is not supported by Orbit on ${this.platform}` };
  }

  /**
   * Binary present, platform prerequisites present, `srt --version` runs, and
   * a command actually starts under a deny-everything sandbox and is
   * confined there: its write to a canary file must fail. Starting catches
   * what static checks cannot, such as an outer sandbox that forbids
   * nesting; the canary catches a binary that runs commands without
   * confining them (another tool named srt earlier on PATH, a broken
   * install), which wrap() would otherwise trust.
   */
  async available(): Promise<{ ok: boolean; detail: string }> {
    const precheck = this.platformCheck();
    if (!precheck.ok) return { ok: false, detail: precheck.detail };
    const srt = this.resolveSrt();
    if (!srt) return { ok: false, detail: this.missingDetail() };
    const platform = this.platformCheck(srt.path);
    if (!platform.ok) return { ok: false, detail: platform.detail };
    const timeoutMs = this.opts.probeTimeoutMs ?? 15_000;

    const version = await runBounded(srt.path, ['--version'], { timeoutMs });
    if (version.code !== 0) return { ok: false, detail: `srt at ${srt.path} does not run (${probeFailure(version)})` };

    const dir = mkdtempSync(join(this.opts.settingsDir ?? tmpdir(), 'orbit-srt-probe-'));
    try {
      const file = join(dir, 'settings.json');
      const settings: SrtSettings = buildSrtSettings({ writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs, memoryMb: null, cpus: null, pids: null } });
      writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
      const canaryDir = join(dir, 'canary');
      mkdirSync(canaryDir);
      const canary = join(canaryDir, 'orbit-canary');
      const probe = await runBounded(srt.path, ['--settings', file, '--', '/bin/sh', '-c', 'echo x > "$1" 2>/dev/null; exit 0', 'sh', canary], { timeoutMs });
      if (probe.code !== 0) return { ok: false, detail: `srt ${version.stdout.trim()} could not start a sandboxed command (${probeFailure(probe)})` };
      if (existsSync(canary)) return { ok: false, detail: `srt at ${srt.path} ran a command without confining it: a write no rule allowed succeeded` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return { ok: true, detail: `srt ${version.stdout.trim()} (${srt.source}: ${srt.path}); ${platform.detail}; sandbox probe passed` };
  }

  wrap(argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }): WrappedCommand {
    assertArgv(argv);
    const precheck = this.platformCheck();
    if (!precheck.ok) throw new OrbitError('ISOLATION_UNAVAILABLE', `sandbox-runtime unavailable: ${precheck.detail}`);
    const srt = this.resolveSrt();
    if (!srt) throw new OrbitError('ISOLATION_UNAVAILABLE', `sandbox-runtime unavailable: ${this.missingDetail()}`);
    const platform = this.platformCheck(srt.path);
    if (!platform.ok) throw new OrbitError('ISOLATION_UNAVAILABLE', `sandbox-runtime unavailable: ${platform.detail}`);

    const dir = mkdtempSync(join(this.opts.settingsDir ?? tmpdir(), 'orbit-srt-'));
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    };
    try {
      // The sandboxed process has no business reading its own policy.
      const settings = buildSrtSettings(profile, { extraDenyRead: [dir] });
      const reach = sandboxReach(settings, opts.env.HOME);
      assertLauncherOutOfReach(srt.path, reach);
      const launch = launcherEnv(sandboxEnv(opts.env, settings.filesystem.allowWrite), reach);
      // Inside the sandbox, so the limits bind the command and its children but not srt or its proxy.
      const command = withResourceLimits(argv, this.opts.limits, { shell: this.opts.limitShell });
      if (launch.restore.length && command[0]!.includes('=')) {
        throw new OrbitError('INTERNAL', `command name ${JSON.stringify(command[0])} contains "=", which /usr/bin/env would read as an assignment`);
      }
      const file = join(dir, 'settings.json');
      writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(file, 0o600);
      return {
        argv: [srt.path, '--settings', file, '--', ...(launch.restore.length ? ['/usr/bin/env', '--', ...launch.restore] : []), ...command],
        env: launch.env,
        cleanup,
        limitations: limitationsFor(profile, this.platform, this.opts.limits),
      };
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  private missingDetail(): string {
    if (this.opts.srtPath !== undefined) return `configured srt ${this.opts.srtPath} is not an absolute path to an executable file`;
    const where = this.opts.orbitInstallDir ? ` or ${join(this.opts.orbitInstallDir, 'node_modules', '.bin', 'srt')}` : '';
    return `srt not found on PATH${where}; install @anthropic-ai/sandbox-runtime`;
  }
}

/**
 * Where srt 0.0.78 looks for its seccomp helper relative to its own code
 * (`getLocalSeccompPaths`, resolved from dist/sandbox/): bundled beside the
 * module, at the package root, or under dist/. Orbit checks the same places
 * from the real path of the srt CLI (dist/cli.js).
 */
export function seccompHelperFor(srtPath: string, arch: string): string | null {
  const vendorArch = SECCOMP_ARCHES[arch];
  if (!vendorArch) return null;
  let dist: string;
  try {
    dist = dirname(realpathSync(srtPath));
  } catch {
    return null;
  }
  const rel = join('vendor', 'seccomp', vendorArch, 'apply-seccomp');
  return [join(dist, 'sandbox', rel), join(dist, '..', rel), join(dist, rel)].find((p) => existsSync(p)) ?? null;
}

/**
 * Two temp directories meet here. srt replaces the child's TMPDIR with
 * /tmp/claude, shared by every sandbox on the machine, unless
 * CLAUDE_CODE_TMPDIR is set in srt's own environment (srt 0.0.78
 * `generateProxyEnvVars`); Claude Code reads the same variable for its own
 * temp files. srt itself, outside the sandbox, puts its proxy sockets in
 * os.tmpdir(), that is its own TMPDIR. So a private TMPDIR the sandbox can
 * write is handed over as CLAUDE_CODE_TMPDIR, while srt's own TMPDIR is kept
 * out of every writable path: sockets there could be replaced from inside,
 * and a deep directory would overflow the socket path limit (104 bytes on
 * macOS, observed as EADDRINUSE).
 */
function sandboxEnv(env: Record<string, string>, allowWrite: string[]): Record<string, string> {
  const out = { ...env };
  const writable = (p: string | undefined): boolean => {
    if (!p) return false;
    try {
      const real = canonicalPath(p);
      return allowWrite.some((w) => isWithin(real, w));
    } catch {
      return false;
    }
  };
  if (writable(env.TMPDIR)) {
    if (out.CLAUDE_CODE_TMPDIR === undefined) out.CLAUDE_CODE_TMPDIR = env.TMPDIR!;
    out.TMPDIR = [tmpdir(), '/tmp'].find((candidate) => !writable(candidate)) ?? '/tmp';
  }
  return out;
}

/** What a sandboxed process can change, or other sandboxes can: nothing srt's launcher runs may come from there. */
interface SandboxReach {
  /** Writable for this sandbox: allowWrite plus srt's own defaults. */
  writable: string[];
  /** Write-denied inside those. */
  protectedPaths: string[];
  /** Read-denied for this sandbox: other workers' worktrees, other repositories, Orbit state. */
  denied: string[];
}

function sandboxReach(settings: SrtSettings, envHome: string | undefined): SandboxReach {
  // srt 0.0.78 `getDefaultWritePaths`: always /tmp/claude, and two
  // convenience directories under os.homedir() of srt itself, which is HOME
  // when set and the account's home directory otherwise.
  const home = envHome || userInfo().homedir;
  const defaults = ['/tmp/claude', '/private/tmp/claude', ...(home && isAbsolute(home) ? [join(home, '.npm', '_logs'), join(home, '.claude', 'debug')] : [])];
  return {
    writable: uniq([...settings.filesystem.allowWrite, ...defaults.map(canonicalPath)]),
    protectedPaths: settings.filesystem.denyWrite,
    denied: settings.filesystem.denyRead,
  };
}

function writableIn(reach: SandboxReach, p: string): boolean {
  return reach.writable.some((w) => isWithin(p, w)) && !reach.protectedPaths.some((d) => isWithin(p, d));
}

/**
 * srt is a node script: if the sandbox could rewrite its package (for
 * example srt bundled with Orbit under a provider config directory the
 * worker may write), the next launch would run the worker's code with no
 * sandbox at all.
 */
function assertLauncherOutOfReach(srtPath: string, reach: SandboxReach): void {
  let real: string;
  try {
    real = realpathSync(srtPath);
  } catch {
    throw new OrbitError('ISOLATION_UNAVAILABLE', `srt at ${srtPath} cannot be resolved`);
  }
  const dir = dirname(real);
  const pkg = basename(dir) === 'dist' ? dirname(dir) : dir;
  const exposed = writableIn(reach, pkg) || reach.writable.some((w) => isWithin(w, pkg) && !reach.protectedPaths.some((d) => isWithin(w, d)));
  if (exposed) {
    throw new OrbitError('ISOLATION_UNAVAILABLE', `srt at ${pkg} is inside a path the sandbox may write, so a sandboxed command could replace the sandbox itself`, { path: pkg });
  }
}

// Read by the dynamic loader, node or the shell before any code of the
// launcher runs; a value pointing at a file the sandbox can write (often
// relative to the worktree, srt's working directory) runs that file outside
// the sandbox.
const LOADER_ENV_NAMES = new Set(['NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'NODE_REPL_EXTERNAL_MODULE', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'PS4']);
const LOADER_ENV_PREFIXES = ['LD_', 'DYLD_', 'BASH_FUNC_'];

function isLoaderEnv(name: string): boolean {
  return LOADER_ENV_NAMES.has(name) || LOADER_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * srt runs outside the sandbox as `#!/usr/bin/env node`, then (0.0.78)
 * spawnSync('which'), `/bin/sh -c 'env ... sandbox-exec ...'` on macOS and
 * bwrap and socat by name on Linux, all resolved through the PATH of the
 * environment it was given, which is also the command's environment. A
 * directory the sandbox can write on that PATH (a worktree's
 * node_modules/.bin, a provider config directory) lets a sandboxed command
 * plant `env` or `node` for the next launch to run unconfined; this was
 * reproduced. The launcher therefore gets a PATH of absolute entries outside
 * the sandbox's reach and no loader variables, and the command gets its own
 * values back, set inside the sandbox by /usr/bin/env.
 */
function launcherEnv(env: Record<string, string>, reach: SandboxReach): { env: Record<string, string>; restore: string[] } {
  const out: Record<string, string> = {};
  const restore: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (isLoaderEnv(name)) restore.push(`${name}=${value}`);
    else out[name] = value;
  }
  if (env.PATH !== undefined) {
    const safe = env.PATH.split(delimiter).filter((entry) => launcherPathEntryIsSafe(entry, reach));
    const joined = uniq(safe).join(delimiter);
    if (joined !== env.PATH) {
      out.PATH = joined;
      restore.unshift(`PATH=${env.PATH}`);
    }
  }
  return { env: out, restore };
}

function launcherPathEntryIsSafe(entry: string, reach: SandboxReach): boolean {
  if (!entry || !isAbsolute(entry) || /[\n\r\0]/.test(entry)) return false;
  let real: string;
  try {
    real = canonicalPath(entry);
  } catch {
    return false;
  }
  // Inside a writable or denied region, or containing something writable
  // (a writable file directly in a PATH directory is as bad as the directory).
  if (reach.writable.some((w) => isWithin(real, w) || isWithin(w, real))) return false;
  return !reach.denied.some((d) => isWithin(real, d));
}

function limitationsFor(profile: SandboxProfile, platform: NodeJS.Platform, limits?: IsolationLimits | null): string[] {
  const out = [...SRT_LIMITATIONS];
  if (hasLimits(limits)) {
    out[0] = `sandbox-runtime confines filesystem access and network egress; isolation.limits adds ulimit hard limits inside the sandbox (${describeLimits(limits).join(', ')}). Memory is not limited, and the process limit counts every process of the user id.`;
  }
  if (platform === 'linux') out.push(LINUX_LIMITATION);
  const { memoryMb, cpus, pids } = profile.limits;
  const requested = [memoryMb !== null ? `memory ${memoryMb} MB` : null, cpus !== null ? `${cpus} CPUs` : null, pids !== null ? `${pids} processes` : null].filter(Boolean);
  if (requested.length) out.push(`Requested resource limits (${requested.join(', ')}) are NOT enforced by sandbox-runtime; use the container provider for them.`);
  return out;
}

function isWsl1(): boolean {
  try {
    const v = readFileSync('/proc/version', 'utf8');
    return !/WSL\d+/i.test(v) && /microsoft/i.test(v);
  } catch {
    return false;
  }
}
