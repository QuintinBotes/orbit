/** NM3 in the controller: a run handed to the service is judged for its delivery credentials too, with the same function admission uses. */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/policy/config.ts';
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
