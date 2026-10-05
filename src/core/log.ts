import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Clock } from './clock.ts';
import { redact, redactValue } from './redact.ts';

/**
 * Structured JSON-lines logging. One object per line:
 *
 *   {"ts":"2026-10-03T09:37:05.123Z","level":"info","msg":"lease acquired","run_id":"orb-...","owner":"..."}
 *
 * Every string, at any depth, passes through redaction before it is written,
 * because log files end up in reports, bug threads and provider prompts.
 *
 * Logging never throws and never blocks the caller on a broken sink: a full
 * disk or an unwritable path must not turn into a failed state transition.
 * Writes are synchronous appends so lines from one process stay ordered and a
 * crash loses at most the line being written.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  log(level: LogLevel, msg: string, fields?: LogFields): void;
  isEnabled(level: LogLevel): boolean;
  /** A logger that adds `bound` (run_id, worker_id...) to every line. */
  child(bound: LogFields): Logger;
}

export interface LoggerOptions {
  /** JSON-lines file to append to (mode 0600); missing parent directories are created 0700. */
  file?: string;
  /** Also write each line to stderr. */
  stderr?: boolean;
  /** Minimum level written. Default 'info'. */
  level?: LogLevel;
  /** Fields on every line from this logger and its children. */
  base?: LogFields;
  clock?: Clock;
  /** Redaction applied to every string. Default: `redact` (known shapes plus secret env values). */
  redactor?: (text: string) => string;
  /** Extra destination, mainly for tests. Receives the serialized line without the newline. */
  sink?: (line: string) => void;
}

// Same as clock.systemClock; see core/proc.ts for why it is not imported.
// Exported only so tests can exercise it: the logger itself never sleeps.
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(['ts', 'level', 'msg']);

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(LEVELS, value);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  // A level from config that is not one of the four would compare as
  // undefined: every line written while isEnabled reported nothing.
  const level: LogLevel = isLogLevel(options.level) ? options.level : 'info';
  const clock = options.clock ?? realClock;
  const redactor = options.redactor ?? ((s: string) => redact(s));
  let dirReady = false;

  const write = (line: string): void => {
    if (options.file) {
      try {
        // Private to the user: even redacted logs carry code, paths and prompts.
        if (!dirReady) {
          mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
          dirReady = true;
        }
        appendFileSync(options.file, `${line}\n`, { mode: 0o600 });
      } catch {
        // A logging failure must never become an operational failure.
        dirReady = false;
      }
    }
    if (options.stderr) {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        /* closed stderr */
      }
    }
    if (options.sink) {
      try {
        options.sink(line);
      } catch {
        /* test sinks may throw */
      }
    }
  };

  const make = (bound: LogFields): Logger => {
    const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
      if (LEVELS[lvl] < LEVELS[level]) return;
      try {
        write(serialize(lvl, msg, bound, fields, clock, redactor));
      } catch {
        try {
          write(JSON.stringify({ ts: safeIso(clock), level: lvl, msg: redactor(String(msg)), log_error: 'unserializable fields' }));
        } catch {
          /* give up on this line */
        }
      }
    };
    return {
      level,
      debug: (msg, fields) => emit('debug', msg, fields),
      info: (msg, fields) => emit('info', msg, fields),
      warn: (msg, fields) => emit('warn', msg, fields),
      error: (msg, fields) => emit('error', msg, fields),
      log: (lvl, msg, fields) => emit(isLogLevel(lvl) ? lvl : 'info', msg, fields),
      isEnabled: (lvl) => LEVELS[lvl] >= LEVELS[level],
      child: (more) => make({ ...bound, ...more }),
    };
  };

  return make({ ...(options.base ?? {}) });
}

/** Discards everything; for callers that take an optional logger. */
export const nullLogger: Logger = {
  level: 'error',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  log: () => {},
  isEnabled: () => false,
  child: () => nullLogger,
};

function serialize(level: LogLevel, msg: string, bound: LogFields, fields: LogFields | undefined, clock: Clock, redactor: (s: string) => string): string {
  const merged: Record<string, unknown> = {};
  for (const source of [bound, fields]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || RESERVED.has(key)) continue;
      merged[key] = toPlain(value, 0, new WeakSet());
    }
  }
  // Redacted as one object so top-level names like `password` count too.
  const record = { ts: safeIso(clock), level, msg: redactor(String(msg)), ...(redactValue(merged, redactor) as Record<string, unknown>) };
  return JSON.stringify(record, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

function safeIso(clock: Clock): string {
  try {
    return new Date(clock.now()).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Errors, Dates, Maps, Sets, buffers and objects with toJSON become plain
 * data first, so redaction sees every string they would serialize to and
 * nothing renders as `{}`.
 */
function toPlain(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`;
  if (seen.has(value)) return '[Circular]';
  if (depth > 10) return '[MaxDepth]';
  seen.add(value);
  try {
    if (value instanceof Error) {
      const out: Record<string, unknown> = { name: value.name, message: value.message };
      const extra = value as { code?: unknown; details?: unknown };
      if (extra.code !== undefined) out.code = toPlain(extra.code, depth + 1, seen);
      if (extra.details !== undefined) out.details = toPlain(extra.details, depth + 1, seen);
      if (value.stack) out.stack = value.stack;
      if (value.cause !== undefined) out.cause = toPlain(value.cause, depth + 1, seen);
      return out;
    }
    if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), toPlain(v, depth + 1, seen)]));
    if (value instanceof Set) return [...value].map((v) => toPlain(v, depth + 1, seen));
    if (Array.isArray(value)) return value.map((v) => toPlain(v, depth + 1, seen));
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') return toPlain(toJSON.call(value), depth + 1, seen);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toPlain(v, depth + 1, seen);
    return out;
  } finally {
    seen.delete(value);
  }
}
