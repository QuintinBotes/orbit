import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { OrbitError } from './errors.ts';
import { isGroupAlive, killGroup } from './proc.ts';

/**
 * Running external programs. Never through a shell: argv goes straight to
 * execve, so nothing in an argument (a branch name, a path from a model) is
 * ever interpreted.
 *
 * Every child starts in its own process group. Test runners, dev servers and
 * provider CLIs fork helpers that would otherwise survive a timeout, keep a
 * port bound, or hold our pipes open forever (docs/interfaces/playwright-and-github.md
 * notes an orphaned webServer); signalling the group reaches all of them.
 */

export interface ExecOptions {
  cwd?: string;
  /** Complete environment for the child. Defaults to process.env; callers running untrusted code pass a scrubbed one. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Wall-clock limit. Default 120 s; 0 disables it. */
  timeoutMs?: number;
  /** Written to stdin, which is then closed. Without it stdin is /dev/null. */
  input?: string | Uint8Array;
  /** Per stream; output beyond it is dropped and a marker appended. Default 8 MiB. */
  maxOutputBytes?: number;
  /** Time between SIGTERM and SIGKILL when stopping the group. Default 2 s. */
  killGraceMs?: number;
  /** Stops the command like a timeout, reported as `cancelled`. */
  abortSignal?: AbortSignal;
  /**
   * When the main process exits, stop whatever it left running in its group
   * (backgrounded children, daemons that did not setsid). Default true.
   */
  killGroupOnExit?: boolean;
}

export interface ExecResult {
  /** null when the process was ended by a signal. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  pid: number;
}

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_KILL_GRACE_MS = 2_000;
// How often a stopping group is checked during its grace period.
const KILL_POLL_MS = 50;
/** Start of the line appended to truncated output, so readers can detect it. */
export const TRUNCATION_MARKER = '[orbit: output truncated:';

/**
 * Run `argv` to completion and capture its output. Resolves for any exit
 * status, signal or timeout; rejects only when the program could not be
 * started (OrbitError NOT_FOUND for a missing executable or cwd).
 */
export function execCapture(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  const [command, ...args] = argv;
  if (!command) return Promise.reject(new OrbitError('INTERNAL', 'execCapture needs a command'));
  let cwd: string | undefined;
  try {
    cwd = checkCwd(options.cwd);
  } catch (err) {
    return Promise.reject(err);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxBytes = Math.max(0, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const graceMs = Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);

  return new Promise<ExecResult>((resolvePromise, rejectPromise) => {
    const started = performance.now();
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        env: cleanEnv(options.env ?? process.env),
        detached: true,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      rejectPromise(spawnFailure(command, err));
      return;
    }

    const stdout = new Capture(maxBytes);
    const stderr = new Capture(maxBytes);
    child.stdout?.on('data', (c: Buffer) => stdout.push(c));
    child.stderr?.on('data', (c: Buffer) => stderr.push(c));

    const pgid = child.pid;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let cancelled = false;
    let stopping = false;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (pgid === undefined) return;
      try {
        killGroup(pgid, signal);
      } catch {
        /* already gone, or not ours to signal */
      }
    };
    const groupGone = (): boolean => {
      if (pgid === undefined) return true;
      try {
        return !isGroupAlive(pgid);
      } catch {
        return true;
      }
    };
    const stopGroup = (): void => {
      if (stopping) return;
      stopping = true;
      signalGroup('SIGTERM');
      // SIGKILL only a group that outlives the grace period. Polling rather
      // than one timer means a group already gone is never signalled again:
      // once empty, its id can be handed to an unrelated process group. The
      // poll outlives settling (a member that closed its pipes but ignores
      // SIGTERM still has to go) and is unref'd so it never holds the event
      // loop open.
      const deadline = performance.now() + graceMs;
      const poll = (): void => {
        if (groupGone()) return;
        const left = deadline - performance.now();
        if (left <= 0) {
          signalGroup('SIGKILL');
          return;
        }
        setTimeout(poll, Math.min(KILL_POLL_MS, left)).unref();
      };
      setTimeout(poll, Math.min(KILL_POLL_MS, graceMs)).unref();
    };
    const onAbort = (): void => {
      cancelled = true;
      stopGroup();
    };

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stopGroup();
      }, timeoutMs);
    }
    if (options.abortSignal) {
      if (options.abortSignal.aborted) onAbort();
      else options.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      options.abortSignal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      // After a successful spawn the only errors are from signalling, which
      // we do through process.kill; a missing pid means it never started.
      if (pgid !== undefined || settled) return;
      settled = true;
      cleanup();
      rejectPromise(spawnFailure(command, err));
    });

    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // The command is over. A descendant still holding the pipes must not
      // turn it into a timeout or a cancellation after the fact.
      cleanup();
      // Leftover group members would keep the pipes open and outlive the command.
      if (pgid !== undefined && options.killGroupOnExit !== false && !stopping) {
        let alive = false;
        try {
          alive = isGroupAlive(pgid);
        } catch {
          alive = false;
        }
        if (alive) stopGroup();
      }
      // A descendant that escaped the group (setsid) can hold the pipes open
      // indefinitely; the command is over, so stop waiting for it.
      setTimeout(() => {
        if (settled) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, graceMs + 1_000).unref();
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        exitCode,
        signal: exitSignal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        cancelled,
        durationMs: Math.round(performance.now() - started),
        stdoutTruncated: stdout.dropped > 0,
        stderrTruncated: stderr.dropped > 0,
        pid: pgid ?? -1,
      });
    });

    if (options.input !== undefined && child.stdin) {
      // A child that exits without reading its input closes the pipe; EPIPE is not our failure.
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
  });
}

export interface SpawnDetachedOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Appended to; created with mode 0600, missing parent directories with 0700. */
  stdoutPath: string;
  /** May equal stdoutPath to interleave both streams in one file. */
  stderrPath: string;
}

/**
 * Start a process that survives this one: its own session and process group,
 * stdin from /dev/null, output appended to files, and no reference keeping our
 * event loop alive. The controller tracks it by pid, pgid and start time from
 * then on, so a restarted controller can find it again. pgid equals pid
 * because the child leads its new group.
 */
export function spawnDetached(argv: readonly string[], options: SpawnDetachedOptions): { pid: number; pgid: number } {
  const [command, ...args] = argv;
  if (!command) throw new OrbitError('INTERNAL', 'spawnDetached needs a command');
  const cwd = checkCwd(options.cwd);
  const outPath = resolve(options.stdoutPath);
  const errPath = resolve(options.stderrPath);
  const fds: number[] = [];
  let child: ChildProcess;
  try {
    // Worker transcripts hold whatever the model read; keep them private to the user.
    mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(errPath), { recursive: true, mode: 0o700 });
    const outFd = openSync(outPath, 'a', 0o600);
    fds.push(outFd);
    const errFd = errPath === outPath ? outFd : openSync(errPath, 'a', 0o600);
    if (errFd !== outFd) fds.push(errFd);
    child = spawn(command, args, {
      cwd,
      env: cleanEnv(options.env ?? process.env),
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    });
  } catch (err) {
    throw spawnFailure(command, err);
  } finally {
    // The child has its own copies; ours would leak one descriptor per spawn.
    for (const fd of fds) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
  // A failed spawn reports through 'error' on the next tick; without a
  // listener that event would crash the process.
  child.on('error', () => {});
  if (child.pid === undefined) {
    throw new OrbitError('NOT_FOUND', `could not start ${command}: not found or not executable`, { command });
  }
  child.unref();
  return { pid: child.pid, pgid: child.pid };
}

// ---------------------------------------------------------------------------

class Capture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  dropped = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  push(chunk: Buffer): void {
    const room = this.max - this.bytes;
    if (room <= 0) {
      this.dropped += chunk.length;
      return;
    }
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      return;
    }
    this.chunks.push(chunk.subarray(0, room));
    this.bytes += room;
    this.dropped += chunk.length - room;
  }

  text(): string {
    const buf = Buffer.concat(this.chunks);
    if (this.dropped === 0) return buf.toString('utf8');
    // StringDecoder holds back a multi-byte character cut at the limit
    // instead of emitting a replacement character.
    const head = new StringDecoder('utf8').write(buf);
    return `${head}\n${TRUNCATION_MARKER} ${this.dropped} bytes dropped after the first ${this.max}]\n`;
  }
}

function checkCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  let ok = false;
  try {
    ok = statSync(cwd).isDirectory();
  } catch {
    ok = false;
  }
  // spawn reports a missing cwd as ENOENT on the command, which misleads.
  if (!ok) throw new OrbitError('NOT_FOUND', `working directory does not exist: ${cwd}`, { cwd });
  return cwd;
}

function cleanEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

function spawnFailure(command: string, err: unknown): OrbitError {
  if (err instanceof OrbitError) return err;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return new OrbitError('NOT_FOUND', `command not found: ${command}`, { command, errno: code }, { cause: err });
  return new OrbitError('INTERNAL', `could not start ${command}: ${code ?? String(err)}`, { command, errno: code }, { cause: err });
}
