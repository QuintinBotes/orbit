import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { OrbitError } from '../core/errors.ts';
import type { IsolationLimits } from '../policy/types.ts';
import { dockerUlimitArgs } from './limits.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from './types.ts';
import { assertArgv, canonicalPath, isWithin, probeFailure, readablePathsOf, runBounded, uniq, which } from './util.ts';

/**
 * Docker (OrbStack locally) with the hardened flag set verified in
 * docs/interfaces/platform-runtime.md section 5: no network, read-only root,
 * dropped capabilities, no-new-privileges, the host uid:gid, and real CPU,
 * memory and pids limits, which srt cannot give.
 *
 * Docker has no host allowlist: a container either has a network or it does
 * not. A profile that names hosts is refused rather than run with full
 * egress; routing through an egress proxy would be the way to support it.
 */

/** Built from templates/worker.Dockerfile. */
export const DEFAULT_CONTAINER_IMAGE = 'orbit-check:node22';
export const DEFAULT_CONTAINER_LIMITS = { memoryMb: 2048, cpus: 2, pids: 512 } as const;

export interface ContainerOptions {
  image?: string;
  /** Docker CLI; a bare name is looked up on the host PATH. */
  dockerPath?: string;
  /** Used where a profile leaves a limit null; the container always runs with all three. */
  defaults?: { memoryMb: number; cpus: number; pids: number };
  /** Size of the /tmp tmpfs, the only writable place besides the mounts. */
  tmpfsSizeMb?: number;
  /** Extra labels (for example orbit.run=<id>) so orphans can be found with `docker ps --filter label=`. */
  labels?: Record<string, string>;
  /** Environment for the docker CLI itself, which needs HOME and DOCKER_* to find its context. Defaults to process.env. */
  hostEnv?: Record<string, string | undefined>;
  /** Defaults to the current process uid:gid, so files written to the worktree belong to the user. */
  user?: { uid: number; gid: number };
  envFileDir?: string;
  probeTimeoutMs?: number;
  /** `isolation.limits`, passed as docker --ulimit flags (CPU time, process count, file size). */
  ulimits?: IsolationLimits | null;
}

export interface ContainerWrappedCommand extends WrappedCommand {
  /** `docker rm -f <name>` stops it; cleanup() does exactly that. */
  containerName: string;
}

export const CONTAINER_LIMITATIONS: readonly string[] = [
  'Host allowlisting is not available in containers: a profile with allowed hosts is refused, so every container runs with --network none.',
  "The wall-clock limit is enforced by the caller. SIGKILL of the docker CLI leaves the container running; stop it with cleanup() (docker rm -f) or SIGTERM to the CLI.",
  'Exit status 125 means docker itself failed (for example the image is missing under --pull never), not the command; 137 may mean the memory limit was hit, which --rm makes impossible to confirm afterwards.',
  'Hitting the pids limit makes fork fail inside the container but does not by itself change the exit status.',
  'The command runs with the image toolchain: host PATH, HOME and TMPDIR are not forwarded (HOME and TMPDIR are /tmp inside).',
  'Only the profile paths are mounted; a denied path inside a mount is hidden, and a read-only path inside a writable mount protected, only if it existed when the command was wrapped.',
];

// Host-side meaning only; inside the container they would point at nothing.
const HOST_SPECIFIC_ENV = new Set(['PATH', 'HOME', 'TMPDIR']);
const CLI_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// --mount takes comma-separated key=value fields; a comma or quote in a path would change its meaning.
const UNSAFE_MOUNT_PATH = /[,"\n\r\0]/;
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

export class ContainerIsolation implements IsolationProvider {
  readonly kind = 'container' as const;
  readonly image: string;
  private readonly opts: ContainerOptions;
  private readonly hostEnv: Record<string, string | undefined>;

  constructor(opts: ContainerOptions = {}) {
    this.opts = opts;
    this.image = opts.image ?? DEFAULT_CONTAINER_IMAGE;
    if (!IMAGE_NAME.test(this.image)) throw new OrbitError('CONFIG_INVALID', `container image ${JSON.stringify(this.image)} is not a valid image reference`);
    this.hostEnv = opts.hostEnv ?? process.env;
  }

  resolveDocker(): string | null {
    // which() refuses relative names and relative PATH entries: either would resolve against a repository.
    return which(this.opts.dockerPath ?? 'docker', this.hostEnv.PATH);
  }

  /** The docker CLI's own environment: enough to find the daemon and its context, nothing meant for the command. */
  cliEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.hostEnv)) {
      if (value !== undefined && (CLI_ENV_KEYS.includes(key) || key.startsWith('DOCKER_'))) out[key] = value;
    }
    return out;
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    const docker = this.resolveDocker();
    if (!docker) return { ok: false, detail: `docker CLI ${this.opts.dockerPath ?? 'docker'} not found` };
    const timeoutMs = this.opts.probeTimeoutMs ?? 5_000;
    const env = this.cliEnv();
    const info = await runBounded(docker, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs, env });
    const version = info.stdout.trim();
    if (info.code !== 0 || !version) return { ok: false, detail: `docker daemon not reachable (${probeFailure(info)})` };
    const image = await runBounded(docker, ['image', 'inspect', '--format', '{{.Id}}', this.image], { timeoutMs, env });
    if (image.code !== 0) {
      return { ok: false, detail: `docker ${version} is reachable but image ${this.image} is not present locally; build templates/worker.Dockerfile or pull it` };
    }
    return { ok: true, detail: `docker ${version}; image ${this.image} present` };
  }

  /** Preflight: pull the image when it is missing, so runs can use --pull never and fail fast. */
  async ensureImage(timeoutMs = 300_000): Promise<void> {
    const docker = this.resolveDocker();
    if (!docker) throw new OrbitError('ISOLATION_UNAVAILABLE', 'docker CLI not found');
    const env = this.cliEnv();
    const inspect = await runBounded(docker, ['image', 'inspect', '--format', '{{.Id}}', this.image], { timeoutMs: 30_000, env });
    if (inspect.code === 0) return;
    const pull = await runBounded(docker, ['pull', this.image], { timeoutMs, env });
    if (pull.code !== 0) throw new OrbitError('ISOLATION_UNAVAILABLE', `could not pull ${this.image} (${probeFailure(pull)})`, { image: this.image });
  }

  wrap(argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }): ContainerWrappedCommand {
    assertArgv(argv);
    if (profile.allowedHosts.length > 0) {
      throw new OrbitError(
        'ISOLATION_UNAVAILABLE',
        `the container provider cannot restrict egress to ${profile.allowedHosts.join(', ')}: docker offers no network or full network, and Orbit refuses full network`,
        { hosts: profile.allowedHosts },
      );
    }
    const docker = this.resolveDocker();
    if (!docker) throw new OrbitError('ISOLATION_UNAVAILABLE', `docker CLI ${this.opts.dockerPath ?? 'docker'} not found`);
    const user = this.opts.user ?? currentUser();
    const limits = this.limitsFor(profile);
    const { mounts, notes } = planMounts(profile);
    const cwd = canonicalPath(opts.cwd);
    if (!mounts.some((m) => m.kind !== 'shadow' && isWithin(cwd, m.path))) {
      throw new OrbitError('INTERNAL', `working directory ${cwd} is not inside any mounted path, so it would not exist in the container`);
    }
    const containerEnv = containerEnvFor(opts.env);

    const name = `orbit-${randomBytes(6).toString('hex')}`;
    const dir = mkdtempSync(join(this.opts.envFileDir ?? tmpdir(), 'orbit-docker-'));
    const cliEnv = this.cliEnv();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
      // Removes a container the caller's kill left behind; a no-op error when --rm already did.
      spawnSync(docker, ['rm', '-f', name], { env: cliEnv, stdio: 'ignore', timeout: 15_000 });
    };
    try {
      // Values go through a 0600 file, not argv, so they never show up in `ps`.
      const envFile = join(dir, 'env');
      writeFileSync(envFile, Object.entries(containerEnv).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600, flag: 'wx' });
      chmodSync(envFile, 0o600);

      const labels = { 'orbit.isolation': 'container', ...(this.opts.labels ?? {}) };
      const args = [
        'run', '--rm', '--pull', 'never', '--name', name,
        ...Object.entries(labels).flatMap(([k, v]) => ['--label', labelArg(k, v)]),
        '--network', 'none',
        '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`,
        '--cpus', String(limits.cpus), '--pids-limit', String(limits.pids),
        ...dockerUlimitArgs(this.opts.ulimits),
        '--read-only', '--tmpfs', `/tmp:rw,noexec,nosuid,size=${this.opts.tmpfsSizeMb ?? 256}m`,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--user', `${user.uid}:${user.gid}`,
        '--init', '--stop-timeout', '5',
        '--env-file', envFile,
        ...mounts.flatMap((m) => ['--mount', mountArg(m)]),
        '-w', cwd,
        this.image,
        ...argv,
      ];
      return {
        argv: [docker, ...args],
        env: cliEnv,
        cleanup,
        limitations: [
          ...CONTAINER_LIMITATIONS,
          ...(this.opts.ulimits?.memory_mb ? [`isolation.limits.memory_mb (${this.opts.ulimits.memory_mb} MB) is not used by the container provider; Docker enforces ${limits.memoryMb} MB (isolation.container.memory_mb) instead.`] : []),
          ...notes,
        ],
        containerName: name,
      };
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  private limitsFor(profile: SandboxProfile): { memoryMb: number; cpus: number; pids: number } {
    const defaults = this.opts.defaults ?? DEFAULT_CONTAINER_LIMITS;
    const memoryMb = profile.limits.memoryMb ?? defaults.memoryMb;
    const cpus = profile.limits.cpus ?? defaults.cpus;
    const pids = profile.limits.pids ?? defaults.pids;
    // Docker's own floor for --memory is 6 MB.
    if (!Number.isInteger(memoryMb) || memoryMb < 6) throw new OrbitError('CONFIG_INVALID', `container memory limit must be an integer of at least 6 MB, got ${memoryMb}`);
    if (!(Number.isFinite(cpus) && cpus > 0)) throw new OrbitError('CONFIG_INVALID', `container CPU limit must be positive, got ${cpus}`);
    if (!Number.isInteger(pids) || pids < 1) throw new OrbitError('CONFIG_INVALID', `container pids limit must be a positive integer, got ${pids}`);
    return { memoryMb, cpus, pids };
  }
}

interface PlannedMount {
  kind: 'rw' | 'ro' | 'shadow';
  path: string;
  /** For shadows: hide a directory under an empty tmpfs, or a file under /dev/null. */
  isDir?: boolean;
}

/**
 * Writable paths are bound read-write and read-only ones read-only, each at
 * its own absolute path so paths in output and configs mean the same inside
 * and out. A read-only path inside a writable mount gets a read-only bind of
 * its own on top, so it stays read-only there too; one that does not exist
 * yet cannot be bound and is named in the notes, since the command could
 * create it. Nothing else of the host exists in the container, which is how
 * denied paths stay unreadable; a denied path that sits inside a mount is
 * covered by an empty mount of its own.
 */
export function planMounts(profile: SandboxProfile): { mounts: PlannedMount[]; notes: string[] } {
  const notes: string[] = [];
  const check = (p: string) => {
    const real = canonicalPath(p);
    if (UNSAFE_MOUNT_PATH.test(real)) throw new OrbitError('ISOLATION_UNAVAILABLE', `cannot mount ${JSON.stringify(real)}: commas, quotes and newlines are not representable in --mount`);
    return real;
  };
  const writable = uniq(profile.writablePaths.map(check)).filter((p) => {
    if (existsSync(p)) return true;
    notes.push(`${p} does not exist and was not mounted.`);
    return false;
  });
  const readOnly = uniq(readablePathsOf(profile).map(check)).filter((p) => {
    if (existsSync(p)) return true;
    if (writable.some((w) => isWithin(p, w))) notes.push(`${p} does not exist, so it could not be mounted read-only and the command can create it.`);
    else notes.push(`${p} does not exist and was not mounted.`);
    return false;
  });
  if (writable.some((w) => readOnly.includes(w))) throw new OrbitError('INTERNAL', `${writable.find((w) => readOnly.includes(w))} is both writable and read-only in one profile`);
  // Parents before children, so a nested read-only bind lands on top of the writable one.
  const mounts: PlannedMount[] = [...writable.map((path) => ({ kind: 'rw' as const, path })), ...readOnly.map((path) => ({ kind: 'ro' as const, path }))].sort(
    (a, b) => a.path.split('/').length - b.path.split('/').length,
  );
  for (const denied of uniq(profile.denyReadPaths.map(check))) {
    if (!mounts.some((m) => isWithin(denied, m.path))) continue;
    if (!existsSync(denied)) continue;
    if (mounts.some((m) => m.path === denied)) throw new OrbitError('INTERNAL', `${denied} is both mounted and read-denied in one profile`);
    mounts.push({ kind: 'shadow', path: denied, isDir: statSync(denied).isDirectory() });
  }
  return { mounts, notes };
}

function mountArg(m: PlannedMount): string {
  if (m.kind === 'shadow') return m.isDir ? `type=tmpfs,dst=${m.path},tmpfs-size=65536` : `type=bind,src=/dev/null,dst=${m.path},readonly`;
  return `type=bind,src=${m.path},dst=${m.path}${m.kind === 'ro' ? ',readonly' : ''}`;
}

function labelArg(key: string, value: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(key) || /[\n\r\0]/.test(value)) throw new OrbitError('INTERNAL', `invalid container label ${JSON.stringify(key)}`);
  return `${key}=${value}`;
}

/**
 * The command's environment inside the container. Docker's env-file format
 * is one KEY=VALUE per line with no quoting, so a newline in a value cannot be
 * passed and is refused rather than truncated.
 */
export function containerEnvFor(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (HOST_SPECIFIC_ENV.has(key)) continue;
    if (!ENV_NAME.test(key)) throw new OrbitError('INTERNAL', `environment name ${JSON.stringify(key)} cannot be passed to a container`);
    if (/[\n\r\0]/.test(value)) throw new OrbitError('INTERNAL', `environment value of ${key} contains a newline and cannot be passed to a container`);
    out[key] = value;
  }
  out.HOME = '/tmp';
  out.TMPDIR = '/tmp';
  return out;
}

function currentUser(): { uid: number; gid: number } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new OrbitError('ISOLATION_UNAVAILABLE', 'cannot determine the host uid:gid to run the container as');
  return { uid, gid };
}
