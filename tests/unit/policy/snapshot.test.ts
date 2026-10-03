import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../../src/core/clock.ts';
import { hashObject } from '../../../src/core/hash.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { BUILTIN_PROTECTED_PATHS } from '../../../src/policy/builtin.ts';
import { checkConfigHash, snapshotPolicy, verifySnapshot } from '../../../src/policy/snapshot.ts';

let dir: string;
const config = parseConfig('version: 1\nchecks:\n  lint: {command: [npm, run, lint]}\n  unit: {command: [npm, test], flaky_reruns: 1}\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-snap-'));
});

afterEach(() => {
  // Read-only files inside are removable because the directory itself is writable.
  rmSync(dir, { recursive: true, force: true });
});

function snap() {
  return snapshotPolicy(config, { runId: 'orb-1', repoRoot: dir, runDir: join(dir, 'runs', 'orb-1'), clock: new ManualClock(1_700_000_000_000) });
}

function expectTampered(fn: () => unknown, message: RegExp): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe('POLICY_TAMPERED');
    expect((err as Error).message).toMatch(message);
    return;
  }
  throw new Error('expected POLICY_TAMPERED');
}

describe('snapshotPolicy', () => {
  it('writes a read-only, self-describing snapshot and returns its canonical hash', () => {
    const { snapshot, hash, path } = snap();
    expect(path).toBe(join(dir, 'runs', 'orb-1', 'policy.json'));
    expect(statSync(path).mode & 0o777).toBe(0o444);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash).toBe(hashObject(JSON.parse(readFileSync(path, 'utf8'))));
    expect(snapshot.schema).toBe('orbit.policy/1');
    expect(snapshot.created_at).toBe('2023-11-14T22:13:20.000Z');
    expect(snapshot.effective_protected_paths).toEqual(expect.arrayContaining([...BUILTIN_PROTECTED_PATHS, '.github/**', 'infra/**']));
    expect(Object.keys(snapshot.check_config_hashes).sort()).toEqual(['lint', 'unit']);
    expect(snapshot.check_config_hashes.lint).toBe(checkConfigHash(config.checks.lint!));
    expect(snapshot.check_config_hashes.lint).not.toBe(snapshot.check_config_hashes.unit);
  });

  it('gives the same check hash for the same definition regardless of key order', () => {
    const a = parseConfig('version: 1\nchecks:\n  x: {command: [a], timeout_seconds: 5, mandatory: false}\n');
    const b = parseConfig('version: 1\nchecks:\n  x: {mandatory: false, timeout_seconds: 5, command: [a]}\n');
    expect(checkConfigHash(a.checks.x!)).toBe(checkConfigHash(b.checks.x!));
  });

  it('refuses to overwrite an existing snapshot', () => {
    snap();
    expectTampered(() => snap(), /already exists/);
  });
});

describe('verifySnapshot', () => {
  it('returns the snapshot, frozen, when the file matches its hash', () => {
    const { hash, path, snapshot } = snap();
    const verified = verifySnapshot(path, hash);
    expect(verified).toEqual(snapshot);
    expect(Object.isFrozen(verified.config.scope.allowed_paths)).toBe(true);
  });

  it('reports a missing repository root', () => {
    expect(() => snapshotPolicy(config, { runId: 'x', repoRoot: join(dir, 'nope'), runDir: join(dir, 'r'), clock: new ManualClock() })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('detects an edited snapshot', () => {
    const { hash, path } = snap();
    chmodSync(path, 0o644);
    const tampered = JSON.parse(readFileSync(path, 'utf8'));
    tampered.config.scope.allowed_paths.push('**');
    writeFileSync(path, JSON.stringify(tampered));
    chmodSync(path, 0o444);
    expectTampered(() => verifySnapshot(path, hash), /does not match its recorded hash/);
  });

  it('detects a snapshot made writable even when its content is unchanged', () => {
    const { hash, path } = snap();
    chmodSync(path, 0o644);
    expectTampered(() => verifySnapshot(path, hash), /writable/);
    chmodSync(path, 0o446);
    expectTampered(() => verifySnapshot(path, hash), /writable/);
  });

  it('fails closed on a missing file, a malformed hash, bad JSON and a foreign shape', () => {
    const { hash, path } = snap();
    expectTampered(() => verifySnapshot(join(dir, 'missing.json'), hash), /cannot be opened/);
    expectTampered(() => verifySnapshot(path, ''), /expected policy hash/);
    expectTampered(() => verifySnapshot(path, 'sha256:xyz'), /expected policy hash/);
    expectTampered(() => verifySnapshot(path, hash.replace(/.$/, (c) => (c === '0' ? '1' : '0'))), /does not match/);
    const junk = join(dir, 'junk.json');
    writeFileSync(junk, '{not json', { mode: 0o444 });
    expectTampered(() => verifySnapshot(junk, hash), /not valid JSON/);
    const foreign = join(dir, 'foreign.json');
    writeFileSync(foreign, JSON.stringify({ schema: 'something-else' }), { mode: 0o444 });
    expectTampered(() => verifySnapshot(foreign, hash), /orbit\.policy\/1 shape/);
  });

  it('refuses a symlink or a directory in place of the snapshot', () => {
    const { hash, path } = snap();
    const copy = join(dir, 'copy.json');
    copyFileSync(path, copy);
    chmodSync(copy, 0o444);
    const link = join(dir, 'link.json');
    symlinkSync(copy, link);
    expectTampered(() => verifySnapshot(link, hash), /cannot be opened/);
    const d = join(dir, 'a-dir');
    mkdirSync(d);
    expectTampered(() => verifySnapshot(d, hash), /not a regular file|cannot be read/);
  });
});
