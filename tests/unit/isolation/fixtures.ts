import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckDefinition, PolicySnapshot } from '../../../src/policy/types.ts';

/** A real (symlink-resolved) temp directory, removed by the returned function. */
export function tempRoot(prefix = 'orbit-iso-'): { root: string; remove: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

export function writeExecutable(path: string, body: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Only the snapshot fields isolation reads are meaningful; the rest of the
 * config is irrelevant here, so the object is cast rather than spelled out.
 */
export function snapshotFor(opts: {
  repoRoot: string;
  allowedHosts?: string[];
  wallMinutes?: number;
  container?: { image: string; memory_mb: number; cpus: number; pids: number } | null;
  /** The user's scope.protected_paths; the snapshot's effective list is the built-ins plus these. */
  protectedPaths?: string[];
}): PolicySnapshot {
  return {
    schema: 'orbit.policy/1',
    run_id: 'orb-test',
    created_at: '2026-10-03T00:00:00Z',
    repo_root: opts.repoRoot,
    config: {
      mode: 'autonomous',
      network: { allowed_hosts: opts.allowedHosts ?? [] },
      scheduler: { hard_limits: { wall_minutes: opts.wallMinutes ?? 120 } },
      isolation: { provider: 'sandbox-runtime', allow_unisolated: false, container: opts.container ?? null },
      scope: { allowed_paths: [], protected_paths: opts.protectedPaths ?? [] },
    },
    effective_protected_paths: [...(opts.protectedPaths ?? [])],
    check_config_hashes: {},
  } as unknown as PolicySnapshot;
}

export function checkFor(overrides: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id: 'unit',
    command: ['npm', 'test'],
    shell: false,
    cwd: '.',
    timeout_seconds: 300,
    network_hosts: [],
    local_binding: true,
    env: {},
    mandatory: true,
    flaky_reruns: 0,
    kind: 'command',
    ...overrides,
  };
}
