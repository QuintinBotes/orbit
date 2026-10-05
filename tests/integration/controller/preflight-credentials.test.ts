// ADR 0005 decision 3: a repository whose git configuration carries credential material is refused at preflight,
// because the worker may read the shared git directory. The synthetic credentials are built at runtime.
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../../../src/controller/loop.ts';
import { gitCredentialProblems } from '../../../src/controller/steps/preflight.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { baseScenario, git, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
const SECRET = ['tok', 'en', '-', 'acme', '-', '0123456789abcdef'].join('');

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});
function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  return l;
}

describe.skipIf(!canStripTypes)('preflight: credentials in the git configuration', () => {
  it('refuses a repository whose remote URL carries credentials, naming the remote and never the secret', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    git(l.repo, 'remote', 'add', 'origin', `https://acme-bot:${SECRET}@github.com/acme/app.git`);
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/git configuration/);
    expect(done.outcomeReason).toContain('remote.origin.url');
    expect(JSON.stringify(done)).not.toContain(SECRET);
    expect(listWorkers(l.db(), { runId: run.id })).toEqual([]);
  }, 60_000);

  it('accepts ordinary remotes', async () => {
    const l = lab();
    git(l.repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    git(l.repo, 'remote', 'add', 'upstream', 'git@github.com:acme/app.git');
    git(l.repo, 'remote', 'add', 'mirror', 'ssh://git@github.com/acme/app.git');
    expect(await gitCredentialProblems(l.repo)).toEqual([]);
  });

  it.each([
    ['a token as the userinfo of an https remote', ['remote', 'add', 'origin', `https://${SECRET}@github.com/acme/app.git`], 'remote.origin.url'],
    ['a password in an ssh remote', ['remote', 'add', 'origin', `ssh://git:${SECRET}@github.com/acme/app.git`], 'remote.origin.url'],
    ['credentials in a push URL', ['config', 'remote.origin.pushurl', `https://u:${SECRET}@github.com/acme/app.git`], 'remote.origin.pushurl'],
    ['an authorization header', ['config', 'http.https://github.com/.extraheader', `AUTHORIZATION: basic ${SECRET}`], 'http.https://github.com/.extraheader'],
    ['a credential store inside the repository', ['config', 'credential.helper', 'store --file=.git/credentials'], 'credential.helper'],
    ['a literal password for a credential helper', ['config', 'credential.https://github.com.password', SECRET], 'credential.https://github.com.password'],
  ])('flags %s', async (_name, args, key) => {
    const l = lab();
    git(l.repo, ...(args as string[]));
    const problems = await gitCredentialProblems(l.repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(key);
    expect(problems.join('\n')).not.toContain(SECRET);
  });

  it('also reads the configuration shared by a linked worktree', async () => {
    const l = lab();
    git(l.repo, 'remote', 'add', 'origin', `https://${SECRET}@github.com/acme/app.git`);
    git(l.repo, 'worktree', 'add', '-q', '--detach', `${l.base}/wt`);
    expect(await gitCredentialProblems(`${l.base}/wt`)).toHaveLength(1);
  });
});
