import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OrbitError } from '../core/errors.ts';
import { redact } from '../core/redact.ts';
import type { IsolationLimits } from '../policy/types.ts';
import { describeLimits, hasLimits, hasMemoryLimit, withResourceLimits } from './limits.ts';
import { DEFAULT_MEMORY_SAMPLE_MS, withMemoryWatchdog, type MemoryWatchdogOptions } from './memory.ts';
import type { IsolationProvider, SandboxProfile, WrapOptions, WrappedCommand } from './types.ts';
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
 * - A stdio file (WrapOptions.stdioFiles) inside a denied region is added to
 *   allowRead and to nothing else: node aborts at startup when fstat fails on
 *   a descriptor for a file Seatbelt does not let it read.
 * - A denied path inside a writable path is also write-denied: whatever the
 *   profile says must not be read is trusted or secret, and overwriting it is
 *   worse than reading it.
 * - A read-only path inside a writable path is write-denied: that is how a
 *   worker keeps its worktree and config directory but cannot touch the
 *   settings, hooks or result files the controller trusts. srt's denyWrite
 *   beats allowWrite whatever their nesting.
 * - No hosts means no network.
 */
export function buildSrtSettings(profile: SandboxProfile, opts: { extraDenyRead?: string[]; stdioFiles?: string[] } = {}): SrtSettings {
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
  const stdio = prepare(opts.stdioFiles ?? [], 'stdio file');
  const hosts = uniq(profile.allowedHosts.map(normalizeHost));

  const hidden = stdio.find((f) => denied.includes(f));
  if (hidden) throw new OrbitError('INTERNAL', `${hidden} is both handed to the command as a descriptor and read-denied in one profile`);
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
      // Stdio files are readable and nothing else: a descriptor for a file the sandbox may not read breaks node's
      // startup (see WrapOptions.stdioFiles), and the descriptor itself needs no write rule.
      allowRead: uniq([...writable, ...readOnly, ...stdio].filter(insideDenied)),
      allowWrite: withoutNested(writable),
      denyWrite: uniq([...denied.filter((d) => !writable.includes(d)), ...readOnly].filter(insideWritable)),
    },
  };
}

export interface SandboxRuntimeOptions {
  /** Explicit srt binary (absolute). When set it is the only candidate: a missing configured binary means unavailable, never a fallback to another srt. */
  srtPath?: string;
  /**
   * Orbit's install directory (the plugin root, or the checkout when running from the sources). After PATH, only its
   * own `node_modules/.bin/srt` and, when it is a development checkout's plugin/, the checkout's are candidates; the
   * lookup never walks further up (docs/decisions/0006-plugin-packaging.md).
   */
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
  /** The memory watchdog's `ps`, node and sampling interval; tests only. */
  memory?: MemoryWatchdogOptions;
  /** macOS's sandbox-exec; tests only. */
  sandboxExecPath?: string;
  /** The preload that adds Chromium's Mach rules (srt-chromium-preload.mjs); tests only. */
  chromiumPreloadPath?: string;
  /** The node that runs srt's CLI with that preload; process.execPath unless a test says otherwise. */
  nodePath?: string;
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

/** The srt package the Chromium preload was written and verified against; browser checks on macOS require exactly it. */
export const SRT_VERIFIED_VERSION = '0.0.78';
const SRT_PACKAGE = '@anthropic-ai/sandbox-runtime';

/**
 * srt-chromium-preload.mjs writes why it refused into this file beside srt's settings file (its REFUSAL_FILE; the preload
 * cannot import Orbit's modules, so the name is kept in both and a test holds them equal).
 */
export const PRELOAD_REFUSAL_FILE = 'chromium-preload-refused';

/** The isolation adjustment recorded with the evidence when a UI check's browser ran with the two Mach rules. */
export const CHROMIUM_MACH_RENDEZVOUS = 'chromium-mach-rendezvous';

/** Stated on every wrap that applies the adjustment, so the evidence never implies Chromium kept its own sandbox. */
export const CHROMIUM_MACH_RENDEZVOUS_LIMITATION =
  "UI checks on macOS: Playwright's bundled Chromium runs with --no-sandbox (its own sandbox cannot start inside Seatbelt), so srt is its only boundary; srt's write allowlist, credential read-denies and egress filter still apply. " +
  'For Chromium to start at all, an Orbit preload on the unmodified srt CLI adds two Seatbelt rules, mach-register and mach-lookup for names matching ^org[.]chromium[.]Chromium[.]MachPortRendezvousServer[.][0-9]+$ and nothing else. ' +
  "This widens one thing: a sandboxed process can look up the rendezvous port of another Playwright Chromium run by the same user, or claim the name a starting one will use, which at worst stops that browser from starting. " +
  "Chromium's temp files (a download is written there first) go to the check's private temp directory through MAC_CHROMIUM_TMPDIR, an environment variable set only when that directory is already writable: no rule, path or host is added for it. " +
  "Only Playwright's bundled Chromium is supported under srt on macOS; Google Chrome, Firefox and WebKit are not.";

/** srt-chromium-preload.mjs: beside this module in the sources, beside the bundle in plugin/dist/ (scripts/build.mjs copies it there). */
export function defaultChromiumPreloadPath(): string {
  return fileURLToPath(new URL('./srt-chromium-preload.mjs', import.meta.url));
}

/**
 * The srt CLI an srt binary really is (links resolved) and the package it belongs to; name and version are null when
 * no readable package.json sits beside its dist/ directory. Null when the binary cannot be resolved.
 */
export function srtPackageOf(srtPath: string): { cli: string; name: string | null; version: string | null } | null {
  let cli: string;
  try {
    cli = realpathSync(srtPath);
  } catch {
    return null;
  }
  const dir = dirname(cli);
  const pkg = basename(dir) === 'dist' ? dirname(dir) : dir;
  try {
    const meta = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    return { cli, name: typeof meta.name === 'string' ? meta.name : null, version: typeof meta.version === 'string' ? meta.version : null };
  } catch {
    return { cli, name: null, version: null };
  }
}

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

  /**
   * srt on Linux always runs bubblewrap with a new network namespace (allowLocalBinding is a macOS-only setting), so
   * each sandbox has a loopback of its own. Seatbelt on macOS shares the host's.
   */
  get privateLoopback(): boolean {
    return this.platform === 'linux';
  }

  resolveSrt(): { path: string; source: SrtSource } | null {
    if (this.opts.srtPath !== undefined) {
      return isAbsolute(this.opts.srtPath) && isExecutableFile(this.opts.srtPath) ? { path: this.opts.srtPath, source: 'configured' } : null;
    }
    const onPath = which('srt', this.pathEnv);
    if (onPath) return { path: onPath, source: 'PATH' };
    for (const bin of this.installBinDirs()) {
      const bundled = join(bin, 'srt');
      if (isExecutableFile(bundled)) return { path: bundled, source: 'install' };
    }
    return null;
  }

  /**
   * The only node_modules/.bin directories searched after PATH (docs/decisions/0006-plugin-packaging.md): the plugin's
   * own, beside its dist/ (or the checkout's, when running from the sources), then the development checkout's when the
   * install directory is that checkout's plugin/. Never anything further up: a node_modules/.bin in a shared parent
   * directory would otherwise supply the srt that confines every command.
   */
  private installBinDirs(): string[] {
    const install = this.opts.orbitInstallDir;
    if (!install || !isAbsolute(install)) return [];
    const checkout = developmentCheckoutOf(install);
    return [join(install, 'node_modules', '.bin'), ...(checkout ? [join(checkout, 'node_modules', '.bin')] : [])];
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
      const sandboxExec = this.opts.sandboxExecPath ?? '/usr/bin/sandbox-exec';
      return isExecutableFile(sandboxExec) ? { ok: true, detail: `macOS Seatbelt (${sandboxExec})` } : { ok: false, detail: `${sandboxExec} is missing` };
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

  /**
   * What a UI check's browser run would get here: whether the Chromium Mach rules apply (macOS), and whether the srt
   * found is the version the preload was verified against. For `orbit doctor`; wrap() enforces the same.
   */
  browserIsolation(): { rules: boolean; srtVersion: string | null; verified: boolean; detail: string } {
    const rules = this.platform === 'darwin';
    const srt = this.resolveSrt();
    const pkg = srt ? srtPackageOf(srt.path) : null;
    const srtVersion = pkg?.name === SRT_PACKAGE ? pkg.version : null;
    const verified = srtVersion === SRT_VERIFIED_VERSION;
    const detail = verified
      ? `srt ${srtVersion} is the version the Chromium preload was verified against`
      : srtVersion !== null
        ? `srt ${srtVersion} is not ${SRT_VERIFIED_VERSION}, the version the Chromium preload was verified against`
        : `the srt package and its version cannot be read (${srt ? srt.path : this.missingDetail()})`;
    return { rules, srtVersion, verified, detail };
  }

  wrap(argv: string[], profile: SandboxProfile, opts: WrapOptions): WrappedCommand {
    assertArgv(argv);
    const precheck = this.platformCheck();
    if (!precheck.ok) throw new OrbitError('ISOLATION_UNAVAILABLE', `sandbox-runtime unavailable: ${precheck.detail}`);
    const srt = this.resolveSrt();
    if (!srt) throw new OrbitError('ISOLATION_UNAVAILABLE', `sandbox-runtime unavailable: ${this.missingDetail()}`);
    const platform = this.platformCheck(srt.path);
    if (!platform.ok) throw new OrbitError('ISOLATION_UNAVAILABLE', `sandbox-runtime unavailable: ${platform.detail}`);
    const pkg = srtPackageOf(srt.path);
    // Linux has no Mach, so the flag changes nothing there.
    const browser = profile.chromiumMachRendezvous === true && this.platform === 'darwin' ? this.chromiumLauncher(pkg) : null;

    const dir = mkdtempSync(join(this.opts.settingsDir ?? tmpdir(), 'orbit-srt-'));
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    };
    try {
      // The sandboxed process has no business reading its own policy.
      const settings = buildSrtSettings(profile, { extraDenyRead: [dir], stdioFiles: opts.stdioFiles });
      const reach = sandboxReach(settings, opts.env.HOME);
      assertLauncherOutOfReach(srt.path, reach);
      if (browser) {
        assertFileOutOfReach(browser.preload, reach, `the Chromium preload ${browser.preload}`);
        assertFileOutOfReach(browser.node, reach, `node ${browser.node}`);
        // The preload records a refusal here; a sandboxed command that could write it could fake one.
        if (writableIn(reach, realpathSync(dir))) throw new OrbitError('ISOLATION_UNAVAILABLE', `the srt settings directory ${dir} is inside a path the sandbox may write, so the Chromium preload's refusal record could be forged`, { path: dir });
      }
      const launch = launcherEnv(sandboxEnv(opts.env, settings.filesystem.allowWrite, browser !== null), reach);
      // Inside the sandbox, so the limits bind the command and its children but not srt or its proxy.
      const command = withResourceLimits(argv, this.opts.limits, { shell: this.opts.limitShell });
      if (launch.restore.length && command[0]!.includes('=')) {
        throw new OrbitError('INTERNAL', `command name ${JSON.stringify(command[0])} contains "=", which /usr/bin/env would read as an assignment`);
      }
      const file = join(dir, 'settings.json');
      writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(file, 0o600);
      // With the browser adjustment, node runs srt's real CLI with the preload loaded first; srt itself is unmodified.
      const launcher = browser ? [browser.node, '--import', pathToFileURL(browser.preload).href, browser.cli] : [srt.path];
      const srtArgv = [...launcher, '--settings', file, '--', ...(launch.restore.length ? ['/usr/bin/env', '--', ...launch.restore] : []), ...command];
      // Outside the sandbox and in the same process group as the command, so a kill of the group stops both.
      const memoryMb = this.opts.limits?.memory_mb ?? null;
      return {
        argv: withMemoryWatchdog(srtArgv, memoryMb, this.opts.memory),
        env: launch.env,
        cleanup,
        limitations: [...limitationsFor(profile, this.platform, this.opts.limits), ...(browser ? [CHROMIUM_MACH_RENDEZVOUS_LIMITATION] : [])],
        adjustments: browser ? [CHROMIUM_MACH_RENDEZVOUS] : [],
        ...(browser ? { preloadRefusal: () => readPreloadRefusal(dir) } : {}),
        runtimeVersion: pkg?.version ?? null,
      };
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  /**
   * How a browser check's srt is started on macOS: node, the preload and srt's real CLI. Fails closed, before anything
   * is written, when srt is not the package version the preload was verified against or the preload is missing.
   */
  private chromiumLauncher(pkg: ReturnType<typeof srtPackageOf>): { node: string; preload: string; cli: string } {
    const unavailable = (why: string) => new OrbitError('ISOLATION_UNAVAILABLE', `sandbox-runtime unavailable for browser checks: ${why}`, { verified: SRT_VERIFIED_VERSION });
    if (!pkg) throw unavailable('srt cannot be resolved');
    const where = dirname(pkg.cli);
    if (pkg.name === null && pkg.version === null) throw unavailable(`srt at ${where} has an unknown version (no readable package.json), and the Chromium preload was verified against ${SRT_PACKAGE} ${SRT_VERIFIED_VERSION} only`);
    if (pkg.name !== SRT_PACKAGE) throw unavailable(`srt at ${where} is not ${SRT_PACKAGE} (package ${String(pkg.name)})`);
    if (pkg.version !== SRT_VERIFIED_VERSION) throw unavailable(`srt at ${where} is version ${String(pkg.version)}, and the Chromium preload was verified against ${SRT_VERIFIED_VERSION} only`);
    const resolve = (path: string, what: string): string => {
      try {
        return realpathSync(path);
      } catch {
        throw unavailable(`${what} ${path} is missing`);
      }
    };
    return { node: resolve(this.opts.nodePath ?? process.execPath, 'node'), preload: resolve(this.opts.chromiumPreloadPath ?? defaultChromiumPreloadPath(), 'the Chromium preload'), cli: pkg.cli };
  }

  private missingDetail(): string {
    if (this.opts.srtPath !== undefined) return `configured srt ${this.opts.srtPath} is not an absolute path to an executable file`;
    const bins = this.installBinDirs();
    const where = bins.length ? ` or in ${bins.join(' or ')}` : '';
    return `srt not found on PATH${where}; install @anthropic-ai/sandbox-runtime`;
  }
}

/** The development workspace's package name (the checkout's package.json); the plugin directory is its plugin/. */
const DEVELOPMENT_PACKAGE = 'orbit-dev';

/**
 * The development checkout an install directory belongs to: its parent, when the install directory is named plugin and
 * the parent's package.json is Orbit's development workspace. Null for every other install (a plugin cache entry).
 */
export function developmentCheckoutOf(installDir: string): string | null {
  if (basename(installDir) !== 'plugin') return null;
  const parent = dirname(installDir);
  try {
    const meta = JSON.parse(readFileSync(join(parent, 'package.json'), 'utf8')) as { name?: unknown };
    return meta.name === DEVELOPMENT_PACKAGE ? parent : null;
  } catch {
    return null;
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
 *
 * A third meets here for a UI check's browser on macOS (`chromium`).
 * Chromium there ignores TMPDIR: base::GetTempDir reads MAC_CHROMIUM_TMPDIR
 * and otherwise asks the system for the per-user temp directory
 * (/var/folders/.../T), which the sandbox cannot write. A download is written
 * to a temp file there first, so under srt every download was cancelled
 * (live demo 3). The child's private temp directory is handed to Chromium as
 * MAC_CHROMIUM_TMPDIR instead; the Seatbelt profile does not change.
 */
function sandboxEnv(env: Record<string, string>, allowWrite: string[], chromium: boolean): Record<string, string> {
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
  // Only a private directory already in the write allowlist: never srt's shared /tmp/claude, never a new path.
  if (chromium && writable(out.CLAUDE_CODE_TMPDIR)) out.MAC_CHROMIUM_TMPDIR = out.CLAUDE_CODE_TMPDIR!;
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

/**
 * The reason the Chromium preload recorded for refusing, or null when it recorded none (it did not refuse, or the
 * directory is already cleaned up). Read only from Orbit's settings directory, which the sandbox cannot write.
 */
function readPreloadRefusal(dir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(dir, PRELOAD_REFUSAL_FILE), 'utf8');
  } catch {
    return null;
  }
  const line = redact(text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '');
  return line ? line.slice(0, 300) : '(no reason recorded)';
}

/**
 * A file node loads to start srt (node itself, the Chromium preload): neither it nor its directory may be writable
 * from inside, or a sandboxed command could replace it and run unconfined at the next launch.
 */
function assertFileOutOfReach(file: string, reach: SandboxReach, what: string): void {
  const dir = dirname(file);
  const exposed = writableIn(reach, file) || writableIn(reach, dir) || reach.writable.some((w) => isWithin(w, dir) && !reach.protectedPaths.some((d) => isWithin(w, d)));
  if (exposed) throw new OrbitError('ISOLATION_UNAVAILABLE', `${what} is inside a path the sandbox may write, so a sandboxed command could replace it`, { path: file });
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
  const parts: string[] = [];
  if (hasLimits(limits) && describeLimits(limits).length > 0) parts.push(`isolation.limits adds ulimit hard limits inside the sandbox (${describeLimits(limits).join(', ')}); the process limit counts every process of the user id`);
  if (hasMemoryLimit(limits)) parts.push(`a watchdog kills the command's processes when their summed resident memory passes ${limits.memory_mb} MB (sampled every ${DEFAULT_MEMORY_SAMPLE_MS} ms, so a fast allocation can overshoot first; shared pages count once per process; processes that detach from the command's tree are not seen)`);
  if (parts.length > 0) {
    out[0] = `sandbox-runtime confines filesystem access and network egress; ${parts.join('; ')}.${hasMemoryLimit(limits) ? '' : ' Memory is not limited.'}`;
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
