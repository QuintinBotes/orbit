import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Write-then-rename so a reader never observes a partial file and a crash
 * leaves either the old content or the new, never a torn mix. The temp file
 * lives in the same directory so the rename stays on one filesystem.
 */
export function atomicWrite(path: string, data: string | Uint8Array, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, mode);
  fsyncDir(dirname(path));
}

export function atomicWriteJson(path: string, value: unknown, mode = 0o644): void {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Append one JSON line and fsync, for append-only logs such as decisions.jsonl. */
export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o644);
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readJsonIfExists<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function ensureDir(path: string, mode = 0o755): string {
  mkdirSync(path, { recursive: true, mode });
  return path;
}

function fsyncDir(dir: string): void {
  // Directory fsync makes the rename itself durable. Not every platform allows
  // opening a directory for this; where it fails the rename is still atomic.
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best effort */
  }
}
