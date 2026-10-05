// One-shot grants for operations denied inside a worker session (spec section 5; docs/gaps.md G15): a grant never
// widens the worker (docs/decisions/0005, finding 7); the controller runs the approved command itself, and a
// retried session that ran anything the frozen policy denies, the approved command included, is caught from its
// transcript.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig, PolicySnapshot } from '../../../src/policy/types.ts';
import * as authorization from '../../../src/controller/authorization.ts';
import { operationKey, ungrantedCommands, type GuardedOperation } from '../../../src/controller/authorization.ts';

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

describe('no grant policy', () => {
  it('offers nothing that widens a snapshot, and a retried session that ran the approved command itself is a violation', () => {
    const s = snap();
    // The widening helper is gone: there is no way to build a wider policy for a worker.
    expect(Object.keys(authorization)).not.toContain('grantPolicy');
    expect(Object.keys(authorization)).not.toContain('GRANT_POLICY_FILE');
    const events = [use('a', 'chmod +x apps/run.sh'), result('a', '', false), use('b', 'curl https://registry.acme.example.com/x'), result('b', '', false)];
    // The retried session is checked with no grant excusing anything: the controller, not the worker, ran what was approved.
    expect(ungrantedCommands(events, s, root, [])).toEqual(['chmod +x apps/run.sh', 'curl https://registry.acme.example.com/x']);
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
