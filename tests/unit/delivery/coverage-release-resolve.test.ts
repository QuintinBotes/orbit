import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import type { ActionRecord } from '../../../src/delivery/actions.ts';
import { resolveDeploy, unresolvedDeploys } from '../../../src/delivery/release.ts';
import { makeLab, type Lab } from '../../integration/delivery/harness.ts';

let lab: Lab | null = null;
afterEach(() => {
  lab?.cleanup();
  lab = null;
});

const node = process.execPath;
const verify = (script: string) => [node, '-e', script];
const noop = [node, '-e', ''];

function setup(tweak: (c: OrbitConfig) => void = () => {}): Lab {
  lab = makeLab({
    mode: 'release',
    tweak: (cfg) => {
      cfg.isolation = { ...cfg.isolation, provider: 'none', allow_unisolated: true };
      cfg.release = {
        merge: { method: 'squash', require_checks: [], delete_branch: false, mark_ready: true },
        environments: {
          preview: { deploy_command: noop, allowed_branches: ['orbit/*'], require_ci_green: false, network_hosts: [], timeout_seconds: 60, verify_command: verify('process.exit(0)') },
          staging: { deploy_command: noop, allowed_branches: ['main'], require_ci_green: false, network_hosts: [], timeout_seconds: 60, verify_command: verify('process.exit(1)') },
        },
      };
      tweak(cfg);
    },
  });
  return lab;
}

const workDir = (l: Lab) => join(l.dir, 'runs', l.runId);

/** A deploy whose outcome nobody knows: started, no receipt. Built through the ledger, as performRelease would leave it. */
function unknownDeploy(l: Lab, sha: string, environment = 'preview', over: { treeHash?: string | null } = {}): ActionRecord {
  const ledger = l.ledger();
  const { action } = ledger.recordIntent({
    runId: l.runId,
    kind: 'deploy',
    idempotencyKey: `release:${l.runId}:deploy:${environment}:${sha}`,
    target: { environment, branch: 'orbit/x', sha, command: ['x'] },
    ...(over.treeHash === null ? {} : { treeHash: over.treeHash ?? 'a'.repeat(40) }),
    commitSha: sha,
  });
  return ledger.markExecuting(action);
}

const resolve = (l: Lab, over: Partial<Parameters<typeof resolveDeploy>[0]> = {}) =>
  resolveDeploy({ run: l.deliveryRun, snapshot: l.snapshot, ledger: l.ledger(), clock: l.clock, workDir: workDir(l), resolution: 'verify', by: 'acme-operator', isolation: new NoIsolation(), ...over });

describe('resolveDeploy: what it refuses', () => {
  it('needs a release profile', async () => {
    const l = setup((cfg) => void (cfg.release = undefined));
    await expect(resolve(l)).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'release.profile-missing' } });
  });

  it('names the environment when asked about one that has nothing unresolved', async () => {
    const l = setup();
    unknownDeploy(l, l.base, 'preview');
    await expect(resolve(l, { environment: 'staging' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('no deploy with an unknown outcome to staging') });
    lab!.cleanup();
    const empty = setup();
    await expect(resolve(empty)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/no deploy with an unknown outcome$/) });
  });

  it('wants a name when two deploys await resolution, and settles only the named one', async () => {
    const l = setup();
    unknownDeploy(l, l.base, 'preview');
    unknownDeploy(l, l.base, 'staging');
    expect(unresolvedDeploys(l.ledger(), l.runId, workDir(l)).map((a) => (a.target as { environment: string }).environment)).toEqual(['preview', 'staging']);
    await expect(resolve(l, { resolution: 'not-deployed' })).rejects.toMatchObject({ code: 'TRANSITION_INVALID', message: expect.stringContaining('2 deploys with an unknown outcome (preview, staging); name one with --environment') });
    const r = await resolve(l, { resolution: 'not-deployed', environment: 'staging' });
    expect(r).toMatchObject({ environment: 'staging', verdict: 'not-deployed', via: 'person' });
    expect(unresolvedDeploys(l.ledger(), l.runId, workDir(l)).map((a) => (a.target as { environment: string }).environment)).toEqual(['preview', 'staging']);
  });

  it('refuses to verify an environment the profile no longer defines, and without an isolation provider', async () => {
    const l = setup();
    unknownDeploy(l, l.base, 'retired');
    await expect(resolve(l)).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('release environment retired is no longer defined') });
    lab!.cleanup();
    const l2 = setup();
    unknownDeploy(l2, l2.base);
    await expect(resolve(l2, { isolation: undefined })).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('needs an isolation provider') });
  });

  it('refuses to verify when the command needs a host the policy does not allow', async () => {
    const l = setup((cfg) => void (cfg.release!.environments.preview!.network_hosts = ['exfil.example.net']));
    unknownDeploy(l, l.base);
    await expect(resolve(l)).rejects.toMatchObject({ code: 'POLICY_DENIED', details: expect.objectContaining({ definitive: true }), message: expect.stringContaining('needs network access to exfil.example.net') });
  });
});

describe('resolveDeploy by a person', () => {
  it('records a receipt without a tree when the action carried none', async () => {
    const l = setup();
    const action = unknownDeploy(l, l.base, 'preview', { treeHash: null });
    const r = await resolve(l, { resolution: 'deployed' });
    expect(r).toMatchObject({ verdict: 'deployed', via: 'person', detail: expect.stringContaining('acme-operator reports the deploy of') });
    const done = l.ledger().get(action.id);
    expect(done.state).toBe('SUCCEEDED');
    expect((done.receipt as { tree: string; isolation: string }).tree).toBe('');
    expect((done.receipt as { isolation: string }).isolation).toBe('person');
  });
});

describe('resolveDeploy by the verify_command', () => {
  it('removes a leftover checkout, runs in a clean one, and reads exit 0 as deployed with its redacted output', async () => {
    const l = setup((cfg) => void (cfg.release!.environments.preview!.verify_command = verify("console.log('live at ' + process.env.ORBIT_RELEASE_SHA.slice(0, 8)); console.error('err ghp_abcdefghijklmnopqrstuvwxyz0123456789')")));
    const c = l.candidate('x');
    unknownDeploy(l, c.commitSha);
    // A checkout left behind by an earlier verification is removed first.
    const leftover = join(workDir(l), 'release', `deploy-preview-${c.commitSha.slice(0, 12)}`, 'verify', 'checkout');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'stale.txt'), 'old');
    const r = await resolve(l, { homeDir: '/nonexistent/acme-home' });
    expect(r).toMatchObject({ verdict: 'deployed', via: 'verify_command' });
    expect(r.detail).toContain(`live at ${c.commitSha.slice(0, 8)}`);
    expect(r.detail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(existsSync(join(leftover, 'stale.txt'))).toBe(false);
  });

  it('reads exit 1 without output as not deployed, with a bare detail', async () => {
    const l = setup((cfg) => void (cfg.release!.environments.preview!.verify_command = verify('process.exit(1)')));
    const c = l.candidate('x');
    unknownDeploy(l, c.commitSha);
    const r = await resolve(l);
    expect(r.verdict).toBe('not-deployed');
    expect(r.detail).toMatch(/^verify_command exited 1 for [0-9a-f]{12} in preview$/);
  });

  it('cannot tell after another exit status, a signal, or a timeout, and says which', async () => {
    const cases: [string, (cfg: OrbitConfig) => void, RegExp][] = [
      ['exit 3', (cfg) => void (cfg.release!.environments.preview!.verify_command = verify("console.log('odd'); process.exit(3)")), /verify_command exited 3 \(0 means deployed, 1 means not deployed\), so the outcome is still unknown: odd/],
      ['signal', (cfg) => void (cfg.release!.environments.preview!.verify_command = verify("process.kill(process.pid, 'SIGKILL')")), /verify_command was stopped by a signal/],
      ['timeout', (cfg) => {
        cfg.release!.environments.preview!.verify_command = verify('setTimeout(() => {}, 60000)');
        cfg.release!.environments.preview!.timeout_seconds = 1;
      }, /the verify_command timed out after 1s/],
    ];
    for (const [, tweak, detail] of cases) {
      const l = setup(tweak);
      const c = l.candidate('x');
      unknownDeploy(l, c.commitSha);
      const r = await resolve(l);
      expect(r.verdict).toBe('unknown');
      expect(r.detail).toMatch(detail);
      // Nothing changed: the deploy still awaits resolution.
      expect(unresolvedDeploys(l.ledger(), l.runId, workDir(l))).toHaveLength(1);
      l.cleanup();
    }
    lab = null;
  }, 30_000);

  it('cannot tell when the commit is not in the repository', async () => {
    const l = setup();
    unknownDeploy(l, '1'.repeat(40));
    const r = await resolve(l);
    expect(r).toMatchObject({ verdict: 'unknown', via: 'verify_command', detail: expect.stringContaining('is not in the repository, so the verify_command has nothing to run on') });
  });

  it('still settles the deploy when the verification checkout cannot be cleaned up', async () => {
    const l = setup((cfg) => void (cfg.release!.environments.preview!.verify_command = verify("const fs=require('fs');fs.rmSync('.git');fs.mkdirSync('.git')")));
    const c = l.candidate('x');
    unknownDeploy(l, c.commitSha);
    expect((await resolve(l)).verdict).toBe('deployed');
  });
});
