/**
 * The worker shim (`orbit shim`): the supervisor between a controller and a
 * provider CLI (docs/architecture.md "Process model").
 *
 * The adapter spawns the shim detached, so it leads its own session and
 * process group. The shim starts the provider process in that same group,
 * sends its stdout and stderr to anonymous spill files (created in the worker
 * directory and unlinked at once, so they are never an artifact), and
 * redacts what arrives line by line (core/redact, ADR 0005) into log.jsonl
 * and stderr.log, so no credential a provider or a worker command prints is
 * ever stored in an artifact. Spill files rather than pipes: a shim killed
 * with SIGKILL must leave the provider running to be found, and a pipe with
 * no reader would kill it on its next write. It records who is running in
 * pid.json, and when the provider ends writes exit.json after the last line
 * is on disk. Both files are written atomically. Nothing here talks to
 * the controller: any controller incarnation can read the files, so a
 * controller crash never loses a worker, and a shim that is itself killed
 * with SIGKILL leaves pid.json without exit.json, which is how
 * reconciliation recognizes a lost worker.
 *
 * Timeouts and cancellation escalate over the whole group (SIGINT, then
 * SIGTERM, then SIGKILL), because provider CLIs leave helpers behind: an
 * MCP server or a backgrounded shell outlived `claude -p` in the verified
 * probes (claude-headless-and-sandbox.md section 7.9). SIGINT goes first
 * because Claude and Codex end their turn on it; SIGINT also makes `claude -p`
 * exit 0 without a result line, so the exit record says what was sent and the
 * adapter never reads that 0 as success.
 *
 * This module must also load under Node's strip-only TypeScript (a source
 * run of the shim in tests), so it uses no parameter properties or enums.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { atomicWriteJson } from '../core/fsx.ts';
import { sha256 } from '../core/hash.ts';
import { processStartTime } from '../core/proc.ts';
import { createRedactor, redactValue, type Redactor } from '../core/redact.ts';

export const PID_FILE = 'pid.json';
export const EXIT_FILE = 'exit.json';
export const LOG_FILE = 'log.jsonl';
export const STDERR_FILE = 'stderr.log';
/** The shim's own stdout and stderr (argument errors, crashes). */
export const SHIM_LOG_FILE = 'shim.log';

export const DEFAULT_GRACE_MS = 5_000;
/** How often the provider's log is scanned for an abort pattern. */
const ABORT_POLL_MS = 200;
/** How often the shim looks for the provider's first line of output (time-to-first-event). */
const FIRST_OUTPUT_POLL_MS = 25;
/** Leftover helpers get this long after the provider exits before the group is killed. */
const LEFTOVER_GRACE_MS = 1_000;
/** How often the provider's spilled output is redacted into the artifacts, and how much one tick moves at most. */
const OUTPUT_POLL_MS = 20;
const OUTPUT_PUMP_BYTES = 8 * 1024 * 1024;
const ESCALATION = ['SIGINT', 'SIGTERM', 'SIGKILL'] as const;
const MAX_TIMER_MS = 2_147_483_647;
type EscalationSignal = (typeof ESCALATION)[number];

/**
 * A top-level field match on one JSON line of the provider's stdout, e.g.
 * {type: 'system', subtype: 'api_retry', error: 'authentication_failed'}.
 * The first line matching any pattern cancels the provider and is recorded
 * as the abort reason, so an authentication failure ends in seconds instead
 * of after the CLI's full retry budget.
 */
export type AbortPattern = Record<string, string>;

export interface ShimOptions {
  workerDir: string;
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  /** Wall-clock limit for the provider process; 0 disables it. */
  timeoutMs: number;
  /** Wait after each escalation signal. Default 5 s. */
  graceMs?: number;
  /** Recorded in pid.json so a restarted controller can resume the session. */
  sessionId?: string | null;
  /** File given to the provider as stdin (the prompt); /dev/null when absent. */
  stdinPath?: string | null;
  abortOn?: AbortPattern[];
  /** Removed once the provider has ended, e.g. a sandbox settings directory. */
  cleanupPaths?: string[];
  clock?: Clock;
  /** Process-level effects (group signals, group listing, signal handlers); tests substitute pieces, production uses the real ones. */
  host?: Partial<ShimHost>;
}

/**
 * The shim's contact with the operating system's process groups and signals.
 * The defaults are the real calls; an in-process test replaces them so that
 * nothing ever signals the test runner's own group.
 */
export interface ShimHost {
  /** Process group of `pid`, or null when unreadable. */
  pgidOf(pid: number): number | null;
  /** Signal every member of group `pgid`; throws when the group is gone. */
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
  /** Process ids currently in group `pgid`. */
  groupMembers(pgid: number): number[];
  /** Register a handler for a signal the shim itself receives. */
  onSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): void;
}

const DEFAULT_HOST: ShimHost = {
  pgidOf: (pid) => readPgid(pid),
  signalGroup: (pgid, signal) => {
    process.kill(-pgid, signal);
  },
  groupMembers: (pgid) => groupMembers(pgid),
  onSignal: (signal, listener) => {
    process.on(signal, listener);
  },
};

export interface PidRecord {
  version: 1;
  shimPid: number;
  shimStart: string | null;
  pgid: number;
  childPid: number | null;
  childStart: string | null;
  sessionId: string | null;
  /** sha256 of the canonical argv, to tell this launch from a later one in the same directory. */
  argvHash: string;
  startedAt: number;
}

export interface ExitRecord {
  version: 1;
  /** Provider exit code; null when it was ended by a signal or never started. */
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The shim received SIGINT/SIGTERM/SIGHUP from outside (controller cancellation). */
  cancelled: boolean;
  /** The abort pattern that matched, as JSON, when the shim cancelled on output. */
  aborted: string | null;
  /** Signals the shim sent to the group, in order. */
  escalation: string[];
  /** Set when the provider could not be started at all. */
  error: string | null;
  startedAt: number;
  /** When the provider first wrote to its log; null when it wrote nothing (or an older shim wrote this record). */
  firstOutputAt?: number | null;
  endedAt: number;
}

export function argvHash(argv: readonly string[]): string {
  return `sha256:${sha256(JSON.stringify(argv))}`;
}

/** pid.json of a worker directory, or null when absent or unreadable (being replaced). */
export function readPidRecord(workerDir: string): PidRecord | null {
  return readRecord<PidRecord>(join(workerDir, PID_FILE), (o) => typeof o.shimPid === 'number' && typeof o.pgid === 'number');
}

export function readExitRecord(workerDir: string): ExitRecord | null {
  return readRecord<ExitRecord>(join(workerDir, EXIT_FILE), (o) => typeof o.timedOut === 'boolean' && typeof o.endedAt === 'number');
}

function readRecord<T>(path: string, check: (o: Record<string, unknown>) => boolean): T | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(text) as unknown;
    return o !== null && typeof o === 'object' && !Array.isArray(o) && check(o as Record<string, unknown>) ? (o as T) : null;
  } catch {
    return null;
  }
}

/**
 * Run the provider to completion under supervision and return the exit
 * record (also written to exit.json). Must run in a process that leads its
 * own group, because it signals that group; anything else would signal the
 * caller's group (a test runner, a terminal).
 */
export function runShim(options: ShimOptions): Promise<ExitRecord> {
  const host: ShimHost = { ...DEFAULT_HOST, ...options.host };
  const pgid = host.pgidOf(process.pid);
  if (pgid !== process.pid) {
    throw new OrbitError('INTERNAL', `the shim must lead its own process group (pid ${process.pid}, pgid ${String(pgid)}); start it detached`);
  }
  if (options.argv.length === 0 || !options.argv[0]) throw new OrbitError('INTERNAL', 'the shim needs a provider command');
  return new Shim(options, pgid, host).run();
}

class Shim {
  private readonly o: ShimOptions;
  private readonly pgid: number;
  private readonly host: ShimHost;
  private readonly clock: Clock;
  private readonly graceMs: number;
  private readonly workerDir: string;
  private readonly startedAt: number;
  private child: ChildProcess | null = null;
  private timedOut = false;
  private cancelled = false;
  private aborted: string | null = null;
  private readonly escalation: string[] = [];
  private escalating = false;
  // Signals the shim sent to its own group and will therefore receive itself;
  // the handlers swallow that many before treating one as external.
  private readonly selfSent: Record<string, number> = { SIGINT: 0, SIGTERM: 0 };
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private finished = false;
  private childExited = false;
  private settle: ((r: ExitRecord) => void) | null = null;
  private logOffset = 0;
  /** Size of the log when the provider started; output beyond it is the provider's. */
  private logStartSize = 0;
  private firstOutputAt: number | null = null;
  private logCarry = '';
  private readonly redactor: Redactor;
  private spills: Spill[] = [];

  constructor(options: ShimOptions, pgid: number, host: ShimHost) {
    this.o = options;
    this.pgid = pgid;
    this.host = host;
    this.clock = options.clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
    this.graceMs = Math.max(0, options.graceMs ?? DEFAULT_GRACE_MS);
    this.workerDir = resolve(options.workerDir);
    this.startedAt = this.clock.now();
    this.redactor = createRedactor({ env: cleanEnv(options.env) });
  }

  run(): Promise<ExitRecord> {
    return new Promise<ExitRecord>((resolvePromise) => {
      this.settle = resolvePromise;
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) this.host.onSignal(sig, () => this.onSignal(sig));
      this.start();
    });
  }

  private start(): void {
    const [command, ...args] = this.o.argv as [string, ...string[]];
    const fds: number[] = [];
    let child: ChildProcess;
    try {
      const log = openSync(join(this.workerDir, LOG_FILE), 'a', 0o600);
      fds.push(log);
      const errLog = openSync(join(this.workerDir, STDERR_FILE), 'a', 0o600);
      fds.push(errLog);
      let stdin: number | 'ignore' = 'ignore';
      if (this.o.stdinPath) {
        stdin = openSync(this.o.stdinPath, 'r');
        fds.push(stdin);
      }
      try {
        this.logOffset = statSync(join(this.workerDir, LOG_FILE)).size;
      } catch {
        this.logOffset = 0;
      }
      this.logStartSize = this.logOffset;
      // Same process group as the shim (no `detached`), so one group signal
      // reaches the provider and everything it forks.
      // Output goes to spill files and is redacted into the artifacts as it arrives (ADR 0005). The sinks keep
      // their own descriptors for the artifacts; the shim's other copies are closed below.
      this.spills = [new Spill(this.openSpill('out'), this.sinkFor(log)), new Spill(this.openSpill('err'), this.sinkFor(errLog))];
      child = spawn(command, args, { cwd: this.o.cwd, env: cleanEnv(this.o.env), stdio: [stdin, this.spills[0]!.fd, this.spills[1]!.fd], windowsHide: true });
    } catch (err) {
      this.closeOutput();
      this.finishWithoutChild(`could not start ${command}: ${describe(err)}`);
      return;
    } finally {
      for (const fd of fds) if (!this.spills.some((sp) => sp.sink.fd === fd)) safeClose(fd);
    }
    this.child = child;
    this.pumpLater();
    child.once('error', (err) => {
      // ENOENT and EACCES arrive here, after spawn() returned.
      if (child.pid === undefined) {
        this.closeOutput();
        this.finishWithoutChild(`could not start ${command}: ${describe(err)}`);
      }
    });
    if (child.pid === undefined) return;
    child.once('exit', (code, signal) => void this.onChildExit(code, signal));

    this.writePid(child);
    this.watchFirstOutput();

    if (this.o.timeoutMs > 0) {
      this.later(this.o.timeoutMs, () => {
        this.timedOut = true;
        void this.escalate(0, false);
      });
    }
    if (this.o.abortOn && this.o.abortOn.length > 0) this.watchForAbort();
  }

  private onSignal(sig: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void {
    if (sig !== 'SIGHUP' && this.selfSent[sig]! > 0) {
      this.selfSent[sig]!--;
      return;
    }
    if (this.finished) return;
    this.cancelled = true;
    // Forward to the provider itself: when the signal was sent to the whole
    // group it already has it, and a repeat is harmless; when only the shim
    // was signalled, this is the only way it learns.
    const forward = sig === 'SIGHUP' ? 'SIGTERM' : sig;
    try {
      this.child?.kill(forward);
    } catch {
      /* already gone */
    }
    // The signal received counts as the first stage: the provider gets the
    // grace period to end its turn before anything firmer follows.
    void this.escalate(sig === 'SIGINT' ? 1 : 2, true);
  }

  /**
   * Signal the group from stage `from` on, waiting graceMs between stages,
   * until the provider exits. With `waitFirst` the grace period runs before
   * the first signal (a signal from outside already started the sequence).
   */
  private async escalate(from: number, waitFirst: boolean): Promise<void> {
    if (this.escalating || this.finished) return;
    this.escalating = true;
    if (waitFirst) await this.clock.sleep(this.graceMs);
    for (let i = from; i < ESCALATION.length; i++) {
      if (this.finished || this.childExited) return;
      const sig = ESCALATION[i]!;
      if (sig === 'SIGKILL') {
        this.killGroupAndFinish(null, 'SIGKILL', true);
        return;
      }
      this.signalGroup(sig);
      await this.clock.sleep(this.graceMs);
    }
  }

  private signalGroup(sig: Exclude<EscalationSignal, 'SIGKILL'>): void {
    this.escalation.push(sig);
    this.selfSent[sig]!++;
    try {
      this.host.signalGroup(this.pgid, sig);
    } catch {
      this.selfSent[sig]!--;
    }
  }

  private async onChildExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.finished) return;
    this.childExited = true;
    // Helpers the provider left behind (MCP servers, background shells) still
    // hold the group; give them a moment, then the group goes.
    if (this.leftovers().length > 0) {
      this.signalGroup('SIGTERM');
      const deadline = this.clock.now() + Math.min(this.graceMs, LEFTOVER_GRACE_MS);
      while (this.clock.now() < deadline && this.leftovers().length > 0) await this.clock.sleep(50);
      if (this.leftovers().length > 0) {
        this.killGroupAndFinish(code, signal);
        return;
      }
    }
    this.closeOutput();
    this.finish(this.record(code, signal, null));
  }

  /** An anonymous file the provider writes one stream to: created in the worker directory and unlinked at once, so it is no artifact. */
  private openSpill(name: string): number {
    const path = join(this.workerDir, `.spill-${name}-${process.pid}-${randomBytes(4).toString('hex')}`);
    const fd = openSync(path, 'a+', 0o600);
    try {
      unlinkSync(path);
    } catch {
      /* the name is gone either way for readers that matter: nothing else knows it */
    }
    return fd;
  }

  private sinkFor(fd: number): LineSink {
    return new LineSink(fd, (line) => this.redactLine(line));
  }

  /** Move what the provider has written so far, redacted, into the artifacts; at most a bounded amount per call. */
  private pumpOutput(limit: number): void {
    for (const sp of this.spills) sp.pump(limit);
  }

  private pumpLater(): void {
    this.later(OUTPUT_POLL_MS, () => {
      if (this.finished || this.spills.length === 0) return;
      this.pumpOutput(OUTPUT_PUMP_BYTES);
      this.pumpLater();
    });
  }

  /**
   * One line of provider output with every secret removed. A line that is a JSON document is redacted by value
   * and written back as JSON, so a replacement can never break its quoting; any other line is redacted as text.
   */
  private redactLine(line: string): string {
    const t = line.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const value = JSON.parse(line) as unknown;
        const before = JSON.stringify(value);
        const after = JSON.stringify(redactValue(value, this.redactor.redact));
        if (after !== before) return after;
        const text = this.redactor.redact(line);
        if (text === line) return line;
        try {
          JSON.parse(text);
          return text;
        } catch {
          // Redaction matched text the structured walk did not, and the text form is no longer JSON.
          return JSON.stringify({ type: 'orbit_redacted_line' });
        }
      } catch {
        /* not JSON after all: redact it as text */
      }
    }
    return this.redactor.redact(line);
  }

  /** Write everything the provider produced, redacted, flush the unterminated tails and close the files. */
  private closeOutput(): void {
    const spills = this.spills;
    this.spills = [];
    for (const sp of spills) {
      sp.pump(Infinity);
      sp.sink.flush();
      safeClose(sp.fd);
      safeClose(sp.sink.fd);
    }
  }

  /**
   * Write exit.json first: SIGKILL to the group ends the shim too. `code` and
   * `signal` are the provider's own exit when it already ended and only
   * leftovers are being killed; otherwise the provider dies by this SIGKILL.
   */
  private killGroupAndFinish(code: number | null, signal: string | null, providerKilled = false): void {
    this.escalation.push('SIGKILL');
    this.closeOutput();
    const rec = this.record(code, providerKilled ? 'SIGKILL' : signal, null);
    this.persist(rec);
    try {
      this.host.signalGroup(this.pgid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
    this.finish(rec, false);
  }

  /** The provider never started. pid.json is still written, so every reader finds the shim the same way. */
  private finishWithoutChild(error: string): void {
    if (!existsSync(join(this.workerDir, PID_FILE))) this.writePid(null);
    this.finish(this.record(null, null, error));
  }

  private writePid(child: ChildProcess | null): void {
    const pid: PidRecord = {
      version: 1,
      shimPid: process.pid,
      shimStart: safeStart(process.pid),
      pgid: this.pgid,
      childPid: child?.pid ?? null,
      childStart: child?.pid ? safeStart(child.pid) : null,
      sessionId: this.o.sessionId ?? null,
      argvHash: argvHash(this.o.argv),
      startedAt: this.startedAt,
    };
    atomicWriteJson(join(this.workerDir, PID_FILE), pid, 0o600);
  }

  private record(code: number | null, signal: string | null, error: string | null): ExitRecord {
    this.noteFirstOutput();
    return {
      version: 1,
      code,
      signal,
      timedOut: this.timedOut,
      cancelled: this.cancelled,
      aborted: this.aborted,
      escalation: [...this.escalation],
      error,
      startedAt: this.startedAt,
      firstOutputAt: this.firstOutputAt,
      endedAt: this.clock.now(),
    };
  }

  private persist(rec: ExitRecord): void {
    atomicWriteJson(join(this.workerDir, EXIT_FILE), rec, 0o600);
    this.cleanup();
  }

  private finish(rec: ExitRecord, write = true): void {
    if (this.finished) return;
    this.finished = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (write) this.persist(rec);
    this.settle?.(rec);
  }

  private cleanup(): void {
    for (const p of this.o.cleanupPaths ?? []) {
      if (!isRemovable(p)) continue;
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* best effort: a temp directory left behind is harmless */
      }
    }
  }

  private leftovers(): number[] {
    return this.host.groupMembers(this.pgid).filter((p) => p !== process.pid);
  }

  private later(ms: number, fn: () => void): void {
    // setTimeout fires at once for delays past 2^31-1 ms (about 24.8 days),
    // which would turn a very long timeout into an immediate kill.
    if (ms > MAX_TIMER_MS) {
      this.later(MAX_TIMER_MS, () => this.later(ms - MAX_TIMER_MS, fn));
      return;
    }
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /** Note the moment the provider first wrote to the log, for the model's time-to-first-event latency. */
  private noteFirstOutput(): void {
    if (this.firstOutputAt !== null) return;
    try {
      if (statSync(join(this.workerDir, LOG_FILE)).size > this.logStartSize) this.firstOutputAt = this.clock.now();
    } catch {
      /* no log yet */
    }
  }

  private watchFirstOutput(): void {
    this.later(FIRST_OUTPUT_POLL_MS, () => {
      if (this.finished) return;
      this.noteFirstOutput();
      if (this.firstOutputAt === null) this.watchFirstOutput();
    });
  }

  private watchForAbort(): void {
    this.later(ABORT_POLL_MS, () => {
      if (this.finished || this.escalating) return;
      const hit = this.scanLog();
      if (hit) {
        this.aborted = hit;
        void this.escalate(0, false);
        return;
      }
      this.watchForAbort();
    });
  }

  /** Read new complete lines of the provider's stdout and test them against the abort patterns. */
  private scanLog(): string | null {
    const buf = readFrom(join(this.workerDir, LOG_FILE), this.logOffset);
    if (!buf) return null;
    this.logOffset += buf.length;
    const text = this.logCarry + buf.toString('utf8');
    const lines = text.split('\n');
    this.logCarry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o === null || typeof o !== 'object') continue;
      for (const pattern of this.o.abortOn ?? []) {
        if (Object.entries(pattern).every(([k, v]) => (o as Record<string, unknown>)[k] === v)) return JSON.stringify(pattern);
      }
    }
    return null;
  }
}

/** Longest line held back waiting for its newline; beyond it, all but the last few KiB are written so memory stays bounded. */
const MAX_PENDING_LINE = 64 * 1024 * 1024;
const PENDING_OVERLAP = 8 * 1024;

/**
 * Splits a byte stream into lines, passes each through `redact` and appends it to a file descriptor. Whole lines
 * only, so a secret is never cut by a chunk boundary; the unterminated tail is written by `flush`.
 */
class LineSink {
  readonly fd: number;
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private readonly redact: (line: string) => string;

  constructor(fd: number, redact: (line: string) => string) {
    this.fd = fd;
    this.redact = redact;
  }

  write(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    let start = 0;
    for (let nl = this.pending.indexOf('\n', start); nl !== -1; nl = this.pending.indexOf('\n', start)) {
      this.emit(this.pending.slice(start, nl), true);
      start = nl + 1;
    }
    this.pending = this.pending.slice(start);
    if (this.pending.length > MAX_PENDING_LINE) {
      this.emit(this.pending.slice(0, this.pending.length - PENDING_OVERLAP), false);
      this.pending = this.pending.slice(this.pending.length - PENDING_OVERLAP);
    }
  }

  flush(): void {
    this.pending += this.decoder.end();
    if (this.pending.length > 0) this.emit(this.pending, false);
    this.pending = '';
  }

  private emit(line: string, terminated: boolean): void {
    const text = this.redact(line) + (terminated ? '\n' : '');
    try {
      const buf = Buffer.from(text, 'utf8');
      let off = 0;
      while (off < buf.length) off += writeSync(this.fd, buf, off, buf.length - off);
    } catch {
      /* the artifact could not be written (descriptor closed, disk full): the provider carries on */
    }
  }
}

/** A provider output stream's spill file and how far the shim has read it (positional reads: the offset the provider writes at is never moved). */
class Spill {
  readonly fd: number;
  readonly sink: LineSink;
  private pos = 0;

  constructor(fd: number, sink: LineSink) {
    this.fd = fd;
    this.sink = sink;
  }

  pump(limit: number): void {
    let moved = 0;
    const buf = Buffer.alloc(1024 * 1024);
    while (moved < limit) {
      let size: number;
      try {
        size = fstatSync(this.fd).size;
      } catch {
        return;
      }
      if (this.pos >= size) return;
      let n = 0;
      try {
        n = readSync(this.fd, buf, 0, Math.min(buf.length, size - this.pos), this.pos);
      } catch {
        return;
      }
      if (n <= 0) return;
      this.pos += n;
      moved += n;
      this.sink.write(buf.subarray(0, n));
    }
  }
}

/**
 * Only directories Orbit itself created in a temp location are removed, so a
 * wrong argument can never delete user data.
 */
function isRemovable(p: string): boolean {
  if (!isAbsolute(p) || !existsSync(p)) return false;
  const name = basename(p);
  if (!name.startsWith('orbit-')) return false;
  const parent = dirname(p);
  return parent === tmpdir() || parent === resolve(tmpdir()) || parent === '/tmp' || parent === '/private/tmp';
}

/** Bytes of `path` from `offset` to its current end, at most 4 MiB; null when unreadable. */
export function readFrom(path: string, offset: number, max = 4 * 1024 * 1024): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.max(0, Math.min(size - offset, max));
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    safeClose(fd);
  }
}

/** Process ids in group `pgid`, from `ps -A -o pid=,pgid=` (macOS and Linux procps). */
export function groupMembers(pgid: number): number[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || typeof r.stdout !== 'string') return [];
  const out: number[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    // ps itself runs in the caller's group; it is not a member worth waiting for.
    if (m && Number(m[2]) === pgid && Number(m[1]) !== r.pid) out.push(Number(m[1]));
  }
  return out;
}

/** Process group of `pid`, or null when it cannot be read. */
export function readPgid(pid: number, opts: { platform?: NodeJS.Platform; procDir?: string } = {}): number | null {
  try {
    if ((opts.platform ?? process.platform) === 'linux') {
      const stat = readFileSync(join(opts.procDir ?? '/proc', String(pid), 'stat'), 'utf8');
      const n = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[2]);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }
    const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const n = Number((r.stdout ?? '').trim());
    return r.status === 0 && Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function safeStart(pid: number): string | null {
  try {
    return processStartTime(pid);
  } catch {
    return null;
  }
}

function safeClose(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

function describe(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code ?? (err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Command line: `orbit shim --worker-dir D --timeout-ms N [options] -- <argv...>`

export interface ParsedShimArgs {
  workerDir: string;
  timeoutMs: number;
  graceMs: number;
  sessionId: string | null;
  stdinPath: string | null;
  cwd: string | null;
  abortOn: AbortPattern[];
  cleanupPaths: string[];
  argv: string[];
}

/** Build the argument list parseShimArgs reads back; the adapter's side of the contract. */
export function shimArgs(opts: {
  workerDir: string;
  timeoutMs: number;
  graceMs?: number;
  sessionId?: string | null;
  stdinPath?: string | null;
  cwd?: string | null;
  abortOn?: AbortPattern[];
  cleanupPaths?: string[];
  argv: string[];
}): string[] {
  const out = ['--worker-dir', opts.workerDir, '--timeout-ms', String(opts.timeoutMs)];
  if (opts.graceMs !== undefined) out.push('--grace-ms', String(opts.graceMs));
  if (opts.sessionId) out.push('--session-id', opts.sessionId);
  if (opts.stdinPath) out.push('--stdin', opts.stdinPath);
  if (opts.cwd) out.push('--cwd', opts.cwd);
  for (const p of opts.abortOn ?? []) out.push('--abort-on', JSON.stringify(p));
  for (const p of opts.cleanupPaths ?? []) out.push('--cleanup', p);
  return [...out, '--', ...opts.argv];
}

export function parseShimArgs(args: readonly string[]): ParsedShimArgs {
  const sep = args.indexOf('--');
  if (sep === -1 || sep === args.length - 1) throw new OrbitError('CONFIG_INVALID', 'orbit shim: expected -- followed by the provider command');
  const opts = args.slice(0, sep);
  const out: ParsedShimArgs = { workerDir: '', timeoutMs: 0, graceMs: DEFAULT_GRACE_MS, sessionId: null, stdinPath: null, cwd: null, abortOn: [], cleanupPaths: [], argv: args.slice(sep + 1) };
  for (let i = 0; i < opts.length; i += 2) {
    const flag = opts[i]!;
    const value = opts[i + 1];
    if (value === undefined) throw new OrbitError('CONFIG_INVALID', `orbit shim: ${flag} needs a value`);
    switch (flag) {
      case '--worker-dir':
        out.workerDir = value;
        break;
      case '--timeout-ms':
        out.timeoutMs = nonNegativeInt(flag, value);
        break;
      case '--grace-ms':
        out.graceMs = nonNegativeInt(flag, value);
        break;
      case '--session-id':
        out.sessionId = value;
        break;
      case '--stdin':
        out.stdinPath = value;
        break;
      case '--cwd':
        out.cwd = value;
        break;
      case '--abort-on': {
        const p = JSON.parse(value) as unknown;
        if (p === null || typeof p !== 'object' || Array.isArray(p) || !Object.values(p).every((v) => typeof v === 'string')) {
          throw new OrbitError('CONFIG_INVALID', 'orbit shim: --abort-on takes a JSON object of string fields');
        }
        out.abortOn.push(p as AbortPattern);
        break;
      }
      case '--cleanup':
        out.cleanupPaths.push(value);
        break;
      default:
        throw new OrbitError('CONFIG_INVALID', `orbit shim: unknown option ${flag}`);
    }
  }
  if (!out.workerDir || !isAbsolute(out.workerDir)) throw new OrbitError('CONFIG_INVALID', 'orbit shim: --worker-dir must be an absolute path');
  return out;
}

function nonNegativeInt(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new OrbitError('CONFIG_INVALID', `orbit shim: ${flag} must be a non-negative integer`);
  return n;
}

/** Process entry for `orbit shim`: exit 0 once exit.json is written, 2 on bad arguments. */
export async function shimMain(args: readonly string[], host?: Partial<ShimHost>): Promise<number> {
  let parsed: ParsedShimArgs;
  try {
    parsed = parseShimArgs(args);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  await runShim({
    workerDir: parsed.workerDir,
    argv: parsed.argv,
    env: process.env,
    cwd: parsed.cwd ?? process.cwd(),
    timeoutMs: parsed.timeoutMs,
    graceMs: parsed.graceMs,
    sessionId: parsed.sessionId,
    stdinPath: parsed.stdinPath,
    abortOn: parsed.abortOn,
    cleanupPaths: parsed.cleanupPaths,
    ...(host ? { host } : {}),
  });
  return 0;
}
