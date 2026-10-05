import { OrbitError } from '../core/errors.ts';
import type { IsolationLimits } from '../policy/types.ts';
import { isExecutableFile } from './util.ts';

/**
 * Per-process resource limits (`isolation.limits`, spec section 5 "Restrict
 * ... CPU, ... process count"). sandbox-runtime confines files and network
 * only, so the limits are set with the shell's `ulimit` inside the sandbox,
 * right before the command is exec'd: they then bind the command and
 * everything it starts, and are set as hard limits so it cannot raise them
 * again. The container provider passes the same limits to docker as
 * `--ulimit` flags.
 *
 * What each limit is (setrlimit semantics, the same on macOS and Linux):
 *   cpu_seconds    RLIMIT_CPU: CPU time per process; the kernel sends SIGXCPU
 *                  then SIGKILL. Wall-clock time is the check timeout's job.
 *   max_processes  RLIMIT_NPROC: processes of the same user id, counted
 *                  across the whole account, not only the command's own. Set
 *                  it well above what the account already runs.
 *   max_file_mb    RLIMIT_FSIZE: largest file a process may write (SIGXFSZ).
 * Memory is not limited here: RLIMIT_AS breaks runtimes that reserve large
 * virtual ranges (node, the JVM, Go), and macOS ignores RLIMIT_RSS.
 * `memory_mb` is enforced by the resident-memory watchdog (isolation/memory.ts)
 * under sandbox-runtime, and by Docker's own memory limit under the container
 * provider.
 */

/** bash, not /bin/sh: `ulimit -u` and the 1024-byte unit of `-f` are bash's; dash spells them differently. */
export const LIMIT_SHELLS: readonly string[] = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'];

/** argv[0] of the wrapper, shown in process listings and in `$0` errors. */
export const LIMIT_WRAPPER_NAME = 'orbit-limits';

export function hasLimits(limits: IsolationLimits | null | undefined): limits is IsolationLimits {
  return !!limits && (limits.cpu_seconds !== null || limits.max_processes !== null || limits.max_file_mb !== null);
}

export function hasMemoryLimit(limits: IsolationLimits | null | undefined): limits is IsolationLimits & { memory_mb: number } {
  return !!limits && limits.memory_mb !== null && limits.memory_mb !== undefined;
}

/** Plain words for the evidence record: what the ulimit wrapper enforces. */
export function describeLimits(limits: IsolationLimits): string[] {
  const out: string[] = [];
  if (limits.cpu_seconds !== null) out.push(`CPU time ${limits.cpu_seconds} s per process`);
  if (limits.max_processes !== null) out.push(`${limits.max_processes} processes for the user id`);
  if (limits.max_file_mb !== null) out.push(`files up to ${limits.max_file_mb} MB`);
  return out;
}

/**
 * The `ulimit` script. Values are validated integers, never interpolated
 * from anything else, and the command follows as `"$@"`, so nothing of the
 * command is ever parsed by this shell.
 */
export function limitScript(limits: IsolationLimits): string {
  const steps: string[] = [];
  const int = (v: number, what: string): number => {
    if (!Number.isSafeInteger(v) || v < 1) throw new OrbitError('CONFIG_INVALID', `isolation.limits.${what} must be a positive integer (got ${String(v)})`);
    return v;
  };
  // Neither -H nor -S: bash sets both, so the command cannot raise the limit back.
  if (limits.cpu_seconds !== null) steps.push(`ulimit -t ${int(limits.cpu_seconds, 'cpu_seconds')}`);
  if (limits.max_processes !== null) steps.push(`ulimit -u ${int(limits.max_processes, 'max_processes')}`);
  // bash counts -f in 1024-byte blocks outside POSIX mode, which `set +o posix` guarantees.
  if (limits.max_file_mb !== null) steps.push(`ulimit -f ${int(limits.max_file_mb, 'max_file_mb') * 1024}`);
  return `set +o posix; ${steps.join(' && ')} && exec "$@"`;
}

export function findLimitShell(candidates: readonly string[] = LIMIT_SHELLS): string | null {
  return candidates.find((p) => isExecutableFile(p)) ?? null;
}

/**
 * `argv` run under the limits, or unchanged when none is set. Fails closed:
 * limits that were asked for and cannot be applied are an error, never a
 * silent run without them.
 */
export function withResourceLimits(argv: readonly string[], limits: IsolationLimits | null | undefined, opts: { shell?: string | null } = {}): string[] {
  if (!hasLimits(limits)) return [...argv];
  const shell = opts.shell === undefined ? findLimitShell() : opts.shell;
  if (!shell) throw new OrbitError('ISOLATION_UNAVAILABLE', `isolation.limits needs bash to apply ulimit, and none was found (looked in ${LIMIT_SHELLS.join(', ')})`, { rule: 'isolation.limits' });
  return [shell, '-c', limitScript(limits), LIMIT_WRAPPER_NAME, ...argv];
}

/** docker run flags for the same limits; docker sets soft and hard alike. */
export function dockerUlimitArgs(limits: IsolationLimits | null | undefined): string[] {
  if (!hasLimits(limits)) return [];
  const out: string[] = [];
  if (limits.cpu_seconds !== null) out.push('--ulimit', `cpu=${limits.cpu_seconds}:${limits.cpu_seconds}`);
  if (limits.max_processes !== null) out.push('--ulimit', `nproc=${limits.max_processes}:${limits.max_processes}`);
  if (limits.max_file_mb !== null) {
    const bytes = limits.max_file_mb * 1024 * 1024;
    out.push('--ulimit', `fsize=${bytes}:${bytes}`);
  }
  return out;
}
