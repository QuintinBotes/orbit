/**
 * NM3 and NM4: what `orbit run` can see before it creates a run. Delivery-mode runs need the delivery credentials,
 * and a repository with no commits, a policy with no checks, and a UI policy without Playwright can never produce a
 * run that ends well: each is refused with the exact fix, before a run row or a model call exists.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const runCount = (l: Lab): number => l.db().get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')!.n;
const CHECK = '  unit-tests:\n    command: [node, -e, "process.exit(0)"]\n';

/** `orbit init`, then a policy with one real check (the starter ships only commented examples). */
async function initWithCheck(l: Lab, edit: (text: string) => string = (t) => t): Promise<string> {
  await l.cli(['init']);
  const path = join(l.repo, '.orbit', 'config.yaml');
  writeFileSync(path, edit(readFileSync(path, 'utf8').replace('# example-checks:start\n', `${CHECK}# example-checks:start\n`)));
  return path;
}

function envWithGh(l: Lab, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const bin = join(l.base, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const { GH_TOKEN: _t, GITHUB_TOKEN: _g, ...rest } = process.env;
  return { ...rest, ...GIT_ENV, HOME: l.home, PATH: `${bin}:${process.env.PATH ?? ''}`, ...extra };
}

/** Collaborators whose environment gate passes (isolation, credentials, no mandatory reviewer), and that fail on any model call. */
function healthyEnvironment(calls: { n: number }) {
  const adapter = (id: string) => ({
    discoverCapabilities: async () => ({ provider: id, available: true, version: '2.1.300', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'exact', costReporting: true, detail: 'ok' }),
    validateCredentials: async () => ({ state: 'valid', method: 'api_key', detail: 'ok' }),
    run: async () => {
      calls.n++;
      throw new Error('no model call may happen');
    },
  });
  return () => ({ adapters: { claude: adapter('claude'), codex: adapter('codex') }, registry: { seed: () => ({ inserted: [], updated: [] }), list: () => [], assess: () => ({ eligible: [], excluded: [] }), get: () => null }, isolationFor: () => ({ kind: 'sandbox-runtime', available: async () => ({ ok: true, detail: 'srt present' }), wrap: () => ({}) }) }) as never;
}

const withoutMandatoryReview = (t: string): string => t.replace('independent_provider_required: true', 'independent_provider_required: false').replace('fallback_same_provider_allowed: false', 'fallback_same_provider_allowed: true');

describe('NM3: a delivery-mode run is refused at admission without delivery credentials', () => {
  it('names GH_TOKEN and the fix, creates no run, and calls no model', async () => {
    const l = lab();
    await initWithCheck(l, withoutMandatoryReview);
    const calls = { n: 0 };
    const r = await l.cli(['run', '--goal', 'x', '--mode', 'autonomous-delivery', '--foreground'], { env: envWithGh(l), seams: { controllerDeps: healthyEnvironment(calls) } });
    expect(r.code, r.err).toBe(7);
    expect(r.err).toMatch(/GH_TOKEN is not set/);
    expect(r.err).toMatch(/export GH_TOKEN/);
    expect(r.err).toMatch(/No run was created/);
    expect(calls.n).toBe(0);
    expect(runCount(l)).toBe(0);
  });

  it('names the missing gh CLI when there is none on PATH', async () => {
    const l = lab();
    await initWithCheck(l, withoutMandatoryReview);
    // A PATH with git and nothing else: GitHub's Ubuntu runners ship gh in /usr/bin, so '/usr/bin:/bin' is not "no gh".
    const bin = join(l.base, 'git-only-bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
    const env = { ...envWithGh(l, { GH_TOKEN: 'ghp_acme' }), PATH: bin };
    const r = await l.cli(['run', '--goal', 'x', '--mode', 'autonomous-delivery', '--foreground'], { env, seams: { controllerDeps: healthyEnvironment({ n: 0 }) } });
    expect(r.code, r.err).toBe(7);
    expect(r.err).toMatch(/the gh CLI was not found/);
    expect(runCount(l)).toBe(0);
  });

  it('is not asked of a mode that does not deliver', async () => {
    const l = lab();
    await initWithCheck(l);
    const r = await l.cli(['run', '--goal', 'x', '--mode', 'autonomous', '--detach'], { env: envWithGh(l) });
    expect(r.code, r.err).toBe(0);
  });
});

describe('NM4: cheap admission gaps', () => {
  it('a controller preflight that still meets a repository with no commits says so, instead of ending in an empty git error', async () => {
    const l = lab({ git: false });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: l.repo, env: { ...process.env, ...GIT_ENV } });
    const { resolveCommit } = await import('../../../src/evidence/git.ts');
    await expect(resolveCommit(l.repo, 'HEAD')).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringMatching(/HEAD does not name a commit.*no commits.*initial commit/) });
    await expect(resolveCommit(l.repo, 'no-such-branch')).rejects.toMatchObject({ message: expect.stringMatching(/^no-such-branch does not name a commit/) });
  });

  it('refuses a repository with no commits, naming the commit to make', async () => {
    const l = lab({ git: false });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: l.repo, env: { ...process.env, ...GIT_ENV } });
    await initWithCheck(l);
    const r = await l.cli(['run', '--goal', 'x', '--detach']);
    expect(r.code, r.err).toBe(4);
    expect(r.err).toMatch(/has no commits/);
    expect(r.err).toMatch(/git commit/);
    expect(r.err).toMatch(/No run was created/);
    expect(runCount(l)).toBe(0);
  });

  it('refuses a policy with no checks, naming where to define them', async () => {
    const l = lab();
    await l.cli(['init']);
    const r = await l.cli(['run', '--goal', 'x', '--detach']);
    expect(r.code, r.err).toBe(4);
    expect(r.err).toMatch(/no checks are defined/);
    expect(r.err).toMatch(/checks:/);
    expect(r.err).toMatch(/No run was created/);
    expect(runCount(l)).toBe(0);
  });

  it('refuses a UI policy when @playwright/test is not installed in the repository', async () => {
    const l = lab();
    await initWithCheck(l, (t) => t.replace('ui: null', 'ui:\n  required_when_ui_changes: true\n  ui_paths: ["apps/web/**/*.tsx"]'));
    const r = await l.cli(['run', '--goal', 'x', '--detach']);
    expect(r.code, r.err).toBe(4);
    expect(r.err).toMatch(/@playwright\/test is not installed/);
    expect(r.err).toMatch(/npm install -D @playwright\/test/);
    expect(runCount(l)).toBe(0);
  });

  it('reports every cheap problem at once', async () => {
    const l = lab();
    await l.cli(['init']);
    writeFileSync(join(l.repo, 'scratch.txt'), 'uncommitted\n');
    const r = await l.cli(['run', '--goal', 'x', '--detach']);
    expect(r.err).toMatch(/uncommitted changes/);
    expect(r.err).toMatch(/no checks are defined/);
  });
});
