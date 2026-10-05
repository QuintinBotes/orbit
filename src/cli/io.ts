/**
 * Everything the CLI prints goes through here, and everything printed is
 * redacted first (spec section 4: output never includes secrets). Commands
 * never write to process.stdout directly, which also lets tests capture them.
 */
import type { Readable, Writable } from 'node:stream';
import { redact } from '../core/redact.ts';

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** Whole stdin as text; empty when there is none. */
  readStdin(): Promise<string>;
  readonly stdoutIsTty: boolean;
}

function write(stream: Writable, text: string): void {
  try {
    stream.write(redact(text));
  } catch {
    // A closed pipe (`orbit logs | head`) is the reader's choice, not a failure.
  }
}

export function createIo(stdout: Writable, stderr: Writable, stdin?: Readable): Io {
  return {
    out: (text) => write(stdout, text),
    err: (text) => write(stderr, text),
    stdoutIsTty: (stdout as { isTTY?: boolean }).isTTY === true,
    async readStdin() {
      if (!stdin) return '';
      const chunks: Buffer[] = [];
      for await (const c of stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer));
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

/** A capture for tests and for commands that compose other commands. */
export function memoryIo(stdin = ''): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: '',
    stderr: '',
    stdoutIsTty: false,
    out(text: string) {
      io.stdout += redact(text);
    },
    err(text: string) {
      io.stderr += redact(text);
    },
    readStdin: async () => stdin,
  };
  return io;
}

export function line(io: Io, text = ''): void {
  io.out(`${text}\n`);
}

export function json(io: Io, value: unknown): void {
  io.out(`${JSON.stringify(value, null, 2)}\n`);
}

/** Fixed-width table with a header row; cells are one line each. */
export function table(rows: readonly (readonly string[])[], header?: readonly string[]): string {
  const all = header ? [header, ...rows] : [...rows];
  if (all.length === 0) return '';
  const widths = all[0]!.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const fmt = (r: readonly string[]) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return `${all.map(fmt).join('\n')}\n`;
}

export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

export function ago(now: number, then: number | null): string {
  if (then === null) return 'never';
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function iso(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toISOString();
}
