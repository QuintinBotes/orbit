/**
 * The frozen policy for one run (spec §5 "Snapshot and hash policy before
 * execution"). The controller writes it once, read-only, records its hash in
 * runs.policy_hash, and every gate re-verifies the file against that hash
 * before trusting a byte of it. Editing the live config afterwards changes
 * nothing for a running run; editing the snapshot makes it unusable.
 */
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { atomicWrite } from '../core/fsx.ts';
import { hashObject } from '../core/hash.ts';
import { applyRedactPatterns } from '../core/redact.ts';
import type { Clock } from '../core/clock.ts';
import type { OrbitConfig, PolicySnapshot } from './types.ts';
import { effectiveProtectedPaths } from './builtin.ts';

export const POLICY_FILE = 'policy.json';
export const SNAPSHOT_SCHEMA = 'orbit.policy/1';
const SNAPSHOT_MODE = 0o444;
const HASH_FORMAT = /^sha256:[0-9a-f]{64}$/;

export interface SnapshotInput {
  runId: string;
  repoRoot: string;
  /** .orbit/runs/<run-id>; policy.json is written inside it. */
  runDir: string;
  clock: Clock;
}

export interface SnapshotResult {
  snapshot: PolicySnapshot;
  /** `sha256:<hex>` of the canonical JSON of the whole snapshot; goes into runs.policy_hash. */
  hash: string;
  path: string;
}

/** Hash of one check definition: the "check-configuration hash" evidence binds to. */
export function checkConfigHash(check: OrbitConfig['checks'][string]): string {
  return hashObject(check);
}

export function snapshotHash(snapshot: PolicySnapshot): string {
  return hashObject(snapshot);
}

/**
 * Freeze `config` for `runId`. Refuses to overwrite an existing snapshot:
 * a run's policy never changes, and a second write would be either a bug or
 * an attempt to swap authority under a running run.
 */
export function snapshotPolicy(config: OrbitConfig, input: SnapshotInput): SnapshotResult {
  const path = join(input.runDir, POLICY_FILE);
  if (existsSync(path)) {
    throw new OrbitError('POLICY_TAMPERED', `a policy snapshot already exists for run ${input.runId}; snapshots are written once`, { path });
  }
  let repoRoot: string;
  try {
    repoRoot = realpathSync.native(input.repoRoot);
  } catch (err) {
    throw new OrbitError('NOT_FOUND', `repository root does not exist: ${input.repoRoot}`, { code: (err as NodeJS.ErrnoException).code });
  }
  const checkHashes: Record<string, string> = {};
  for (const [id, check] of Object.entries(config.checks)) checkHashes[id] = checkConfigHash(check);
  const snapshot: PolicySnapshot = {
    schema: SNAPSHOT_SCHEMA,
    run_id: input.runId,
    created_at: new Date(input.clock.now()).toISOString(),
    repo_root: repoRoot,
    // A plain copy, so the stored object is independent of the (frozen) live config.
    config: JSON.parse(JSON.stringify(config)) as OrbitConfig,
    effective_protected_paths: effectiveProtectedPaths(config),
    check_config_hashes: checkHashes,
  };
  const hash = snapshotHash(snapshot);
  atomicWrite(path, `${JSON.stringify(snapshot, null, 2)}\n`, SNAPSHOT_MODE);
  applySnapshotRedaction(snapshot);
  return { snapshot: deepFreeze(snapshot), hash, path };
}

/**
 * Re-read and verify a snapshot. Throws POLICY_TAMPERED when the expected
 * hash is malformed, or the file is missing, unreadable, not a regular file,
 * writable by anyone, owned by another user, unparseable, of the wrong
 * schema, or its canonical hash differs. Returns the verified snapshot.
 */
export function verifySnapshot(path: string, expectedHash: string): PolicySnapshot {
  if (typeof expectedHash !== 'string' || !HASH_FORMAT.test(expectedHash)) {
    throw tampered(path, 'the expected policy hash is missing or malformed');
  }
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw tampered(String(path), 'the policy path is missing or malformed');
  let fd: number;
  try {
    // O_NOFOLLOW: a symlink at the snapshot path is a swap, not a snapshot.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    throw tampered(path, `the policy snapshot cannot be opened (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let text: string;
  try {
    // Stat and read the same descriptor so the checks and the bytes refer to one file.
    const st = fstatSync(fd);
    if (!st.isFile()) throw tampered(path, 'the policy snapshot is not a regular file');
    if ((st.mode & 0o222) !== 0) throw tampered(path, `the policy snapshot is writable (mode ${(st.mode & 0o777).toString(8)}); it must be read-only`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && st.uid !== uid) throw tampered(path, 'the policy snapshot is owned by another user');
    text = readFileSync(fd, 'utf8');
  } catch (err) {
    if (err instanceof OrbitError) throw err;
    throw tampered(path, `the policy snapshot cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw tampered(path, 'the policy snapshot is not valid JSON');
  }
  if (!isSnapshotShape(parsed)) throw tampered(path, 'the policy snapshot does not have the orbit.policy/1 shape');
  // canonicalJson rebuilds objects by assignment, so a "__proto__" member would
  // become a prototype and drop out of the hash: an edit the hash cannot see.
  const odd = prototypeKey(parsed, '');
  if (odd !== null) throw tampered(path, `the policy snapshot contains the key ${JSON.stringify(odd)}, which is never written by Orbit`);
  const actual = snapshotHash(parsed);
  if (actual !== expectedHash) throw tampered(path, 'the policy snapshot does not match its recorded hash', { actual });
  // Every process that acts for a run verifies its snapshot first, so this is where the run's own
  // redaction patterns come into force for its logs, prompts, packets and reports (S3.28).
  applySnapshotRedaction(parsed);
  // Frozen so that nothing downstream can drift from what was verified.
  return deepFreeze(parsed);
}

/** Put the snapshot's `retention.redact_patterns` in force for every redaction in this process (core/redact). */
export function applySnapshotRedaction(snapshot: Pick<PolicySnapshot, 'config'>): void {
  const patterns = (snapshot.config as Partial<OrbitConfig>).retention?.redact_patterns;
  if (Array.isArray(patterns)) applyRedactPatterns(patterns.filter((p): p is string => typeof p === 'string'));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function prototypeKey(v: unknown, at: string): string | null {
  if (Array.isArray(v)) {
    for (let k = 0; k < v.length; k++) {
      const hit = prototypeKey(v[k], `${at}[${k}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (v === null || typeof v !== 'object') return null;
  for (const key of Object.keys(v)) {
    const here = at ? `${at}.${key}` : key;
    if (PROTOTYPE_KEYS.has(key)) return here;
    const hit = prototypeKey((v as Record<string, unknown>)[key], here);
    if (hit !== null) return hit;
  }
  return null;
}

function isSnapshotShape(v: unknown): v is PolicySnapshot {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (
    s.schema === SNAPSHOT_SCHEMA &&
    typeof s.run_id === 'string' &&
    typeof s.repo_root === 'string' &&
    s.config !== null &&
    typeof s.config === 'object' &&
    Array.isArray(s.effective_protected_paths) &&
    s.check_config_hashes !== null &&
    typeof s.check_config_hashes === 'object'
  );
}

function tampered(path: string, why: string, extra: Record<string, unknown> = {}): OrbitError {
  return new OrbitError('POLICY_TAMPERED', `${why}: ${path}`, { path, ...extra });
}
