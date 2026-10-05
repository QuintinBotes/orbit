// One-shot grants for operations denied inside a worker session (spec section 5; docs/gaps.md G15): the grant
// policy widens the frozen snapshot by exactly what each granted operation needs, and a session under it that
// ran anything else the frozen policy denies is caught from its transcript.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../../src/policy/config.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import type { OrbitConfig, PolicySnapshot } from '../../../src/policy/types.ts';
import type { RunContext } from '../../../src/controller/context.ts';
import { grantPolicy, operationKey, ungrantedCommands, type GuardedOperation } from '../../../src/controller/authorization.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-grants-')));

function snap(tweak?: (c: OrbitConfig) => void): PolicySnapshot {
  const c = defaultConfig('supervised');
  tweak?.(c);
  return { schema: 'orbit.policy/1', run_id: 'orb-1', created_at: '2026-10-05T00:00:00.000Z', repo_root: root, config: c, effective_protected_paths: ['.github/**'], check_config_hashes: {} };
}

function granted(command: string, rule = 'actions.change_permissions'): GuardedOperation {
  const op = { kind: 'bash' as const, command };
  return { op, key: operationKey(op), summary: `run \`${command}\``, denial: `${rule}: denied`, rule };
}

const use = (id: string, command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const result = (id: string, text: string, isError: boolean) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });

describe('grant policy', () => {
  it('widens a copy of the frozen snapshot by exactly the granted action and host, read-only and verifiable by its hash', () => {
    const s = snap();
    expect(s.config.actions.change_permissions).toBe(false);
    const dir = mkdtempSync(join(root, 'w-'));
    const ctx = { snapshot: s } as unknown as RunContext;
    const g = grantPolicy(ctx, [granted('chmod +x apps/run.sh'), granted('curl https://registry.acme.example.com/x', 'network.host')], dir);
    expect(g.snapshot.config.actions).toEqual({ ...s.config.actions, change_permissions: true });
    expect(g.snapshot.config.network.allowed_hosts).toEqual([...s.config.network.allowed_hosts, 'registry.acme.example.com']);
    expect(statSync(g.path).mode & 0o222).toBe(0);
    expect(verifySnapshot(g.path, g.hash).config.actions.change_permissions).toBe(true);
    // The frozen snapshot itself is untouched.
    expect(s.config.actions.change_permissions).toBe(false);
    expect(s.config.network.allowed_hosts).not.toContain('registry.acme.example.com');
  });
});

describe('ungranted commands', () => {
  it('names a command the session ran that the frozen policy denies and no grant names; granted, allowed and guard-denied ones are not', () => {
    const s = snap();
    const events = [
      use('a', 'chmod +x apps/run.sh'),
      result('a', '', false),
      use('b', 'chmod 777 apps/other.sh'),
      result('b', '', false),
      use('c', 'echo hi'),
      result('c', 'hi', false),
      use('d', 'chmod -R 777 apps'),
      result('d', 'Orbit policy (actions.change_permissions): chmod -R 777 changes file permissions', true),
    ];
    expect(ungrantedCommands(events, s, root, [granted('chmod +x apps/run.sh')])).toEqual(['chmod 777 apps/other.sh']);
    expect(ungrantedCommands(events, s, root, [granted('chmod +x apps/run.sh'), granted('chmod 777 apps/other.sh')])).toEqual([]);
  });
});
