/** NM3 in the controller: a run handed to the service is judged for its delivery credentials too, with the same function admission uses. */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, validateConfig } from '../../../src/policy/config.ts';
import { deliveryEnvironmentProblem, deliversThroughGithub } from '../../../src/controller/delivery-env.ts';
import { environmentGate } from '../../../src/controller/gates.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function binWithGh(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-gh-')));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'gh'), 0o755);
  return dir;
}

describe('deliveryEnvironmentProblem', () => {
  it('asks nothing of a mode that does not deliver, or of the fake provider', () => {
    expect(deliveryEnvironmentProblem(defaultConfig('autonomous'), {})).toBeNull();
    const fake = defaultConfig('autonomous-delivery');
    fake.delivery.provider = 'fake';
    expect(deliversThroughGithub(fake)).toBe(false);
    expect(deliveryEnvironmentProblem(fake, {})).toBeNull();
  });

  it('names a missing gh, then a missing GH_TOKEN, then passes', () => {
    const config = defaultConfig('autonomous-delivery');
    expect(deliveryEnvironmentProblem(config, { PATH: '/nonexistent' })).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', summary: 'the gh CLI was not found' });
    const bin = binWithGh();
    expect(deliveryEnvironmentProblem(config, { PATH: bin })).toMatchObject({ code: 'AUTH_MISSING', summary: 'GH_TOKEN is not set for the controller' });
    expect(deliveryEnvironmentProblem(config, { PATH: bin, GH_TOKEN: 'ghp_acme' })).toBeNull();
  });

  // The 0.3.1 retest: the demo's policy (autonomous-delivery, every delivery action on) without GH_TOKEN was refused with
  // "or set mode: autonomous to run without delivery", and following that alone was refused again, since a delivery action
  // left on is invalid in a mode that does not deliver. The way out names every setting to change.
  it('names the local way out exactly: the policy it describes validates and does not deliver', () => {
    const demo = { version: 1, mode: 'autonomous-delivery', actions: { commit: true, push_task_branch: true, open_pull_request: true, repair_ci: true } };
    const bin = binWithGh();
    for (const env of [{ PATH: bin }, { PATH: '/nonexistent' }]) {
      const p = deliveryEnvironmentProblem(validateConfig(demo), env)!;
      expect(p.fix).toContain('or, to run without delivery, set mode: autonomous and actions.commit, actions.push_task_branch, actions.open_pull_request and actions.repair_ci to false in .orbit/config.yaml');
      // Following it: the mode and each action it names, read from the advice itself.
      const named = [...p.fix.matchAll(/actions\.(\w+)/g)].map((m) => m[1]!);
      const followed = validateConfig({ ...demo, mode: 'autonomous', actions: { ...demo.actions, ...Object.fromEntries(named.map((a) => [a, false])) } });
      expect(deliversThroughGithub(followed)).toBe(false);
    }
    // Only the actions that are on are named.
    const one = deliveryEnvironmentProblem(validateConfig({ version: 1, mode: 'autonomous-delivery', actions: { commit: true, push_task_branch: true, open_pull_request: false, repair_ci: false } }), { PATH: bin })!;
    expect(one.fix).toContain('set mode: autonomous and actions.commit and actions.push_task_branch to false in .orbit/config.yaml');
  });
});

describe('environmentGate with a delivery problem', () => {
  const snapshot = { config: defaultConfig('autonomous-delivery') } as PolicySnapshot;
  const iso = { kind: 'sandbox-runtime' as const, available: true, detail: 'srt present' };

  it('blocks, naming the problem and the way out', () => {
    const g = environmentGate({ snapshot, mode: 'autonomous-delivery', isolation: iso, credentials: [], reviewer: null, delivery: { summary: 'GH_TOKEN is not set for the controller', missing: 'a token', fix: 'export GH_TOKEN in the environment the controller or service runs in', code: 'AUTH_MISSING' } });
    expect(g.passed).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/GH_TOKEN is not set for the controller.*export GH_TOKEN/);
    expect(g.details.code).toBe('AUTH_MISSING');
  });

  it('passes without one', () => {
    expect(environmentGate({ snapshot, mode: 'autonomous-delivery', isolation: iso, credentials: [], reviewer: null, delivery: null }).passed).toBe(true);
  });
});
