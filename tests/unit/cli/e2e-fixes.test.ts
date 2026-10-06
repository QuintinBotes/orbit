/**
 * Defects found by the end-to-end test round (P5, P20, P21, P24 and the CLI
 * items of P27 and P28), each pinned by a test that failed before the fix.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../../../src/policy/index.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import { defineCheck, makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
const runCount = (l: Lab): number => l.db().get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')!.n;

describe('P5: the starter config follows the README quickstart', () => {
  it('validates under every mode the quickstart names, with no hand editing', async () => {
    const l = lab();
    expect((await l.cli(['init'])).code).toBe(0);
    for (const mode of ['supervised', 'autonomous', 'autonomous-delivery'] as const) {
      expect(() => loadConfig(l.repo, undefined, { mode }), mode).not.toThrow();
    }
  });

  it('starts in autonomous mode, and writes no delivery action as an explicit true', async () => {
    const l = lab();
    await l.cli(['init']);
    const cfg = parse(readFileSync(join(l.repo, '.orbit', 'config.yaml'), 'utf8')) as { mode: string; actions: Record<string, unknown> };
    expect(cfg.mode).toBe('autonomous');
    for (const a of ['commit', 'push_task_branch', 'open_pull_request', 'repair_ci']) expect(cfg.actions[a], a).toBeUndefined();
  });

  it('"orbit run --goal x --mode autonomous" is accepted on a freshly initialised repository', async () => {
    const l = lab();
    await l.cli(['init']);
    defineCheck(l);
    const r = await l.cli(['run', '--goal', 'x', '--mode', 'autonomous', '--detach']);
    expect(r.code, r.err).toBe(0);
    expect(r.err).not.toMatch(/does not deliver/);
    expect(r.out).toMatch(/created \(autonomous\)/);
  });

  it('opting in to delivery is one line: mode autonomous-delivery makes the actions follow', async () => {
    const l = lab();
    await l.cli(['init']);
    const path = join(l.repo, '.orbit', 'config.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^mode: autonomous$/m, 'mode: autonomous-delivery'));
    const c = loadConfig(l.repo);
    expect(c.actions).toMatchObject({ commit: true, push_task_branch: true, open_pull_request: true, repair_ci: true });
  });
});

describe('P20: orbit run refuses cheap-to-detect problems before it creates a run', () => {
  it('refuses a dirty working tree, creates no run and names the way out', async () => {
    const l = lab();
    await l.cli(['init']);
    defineCheck(l);
    writeFileSync(join(l.repo, 'scratch.txt'), 'uncommitted\n');
    const r = await l.cli(['run', '--goal', 'x', '--mode', 'autonomous', '--detach']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/uncommitted changes \(scratch\.txt\)/);
    expect(r.err).toMatch(/No run was created/);
    expect(r.err).toMatch(/allow_dirty_start/);
    expect(runCount(l)).toBe(0);
    const status = await l.cli(['status', '--all']);
    expect(status.out).toMatch(/no runs yet/);
  });

  it('refuses a failing environment gate in the foreground before any run or model call', async () => {
    const l = lab();
    await l.cli(['init']);
    defineCheck(l);
    let modelCalls = 0;
    const adapter = {
      discoverCapabilities: async () => ({ provider: 'claude', available: false, version: null, models: [], structuredOutput: false, readOnlySandbox: false, usageReporting: 'none', costReporting: false, detail: 'claude: command not found' }),
      validateCredentials: async () => ({ state: 'missing', method: null, detail: 'not logged in' }),
      run: async () => {
        modelCalls++;
        throw new Error('no model call may happen');
      },
    };
    const controllerDeps = () => ({ adapters: { claude: adapter, codex: adapter }, registry: { seed: () => ({ inserted: [], updated: [] }), list: () => [], assess: () => ({ eligible: [], excluded: [] }), get: () => null } }) as never;
    const r = await l.cli(['run', '--goal', 'x', '--mode', 'autonomous', '--foreground'], { seams: { controllerDeps } });
    expect(r.code).toBe(7);
    expect(r.err).toMatch(/environment gate/);
    expect(r.err).toMatch(/No run was created/);
    expect(modelCalls).toBe(0);
    expect(runCount(l)).toBe(0);
  });

  it('on a fresh setup with codex eligible but no catalog, the refusal names "orbit models refresh" (P6 at admission)', async () => {
    const l = lab();
    await l.cli(['init']);
    defineCheck(l);
    const path = join(l.repo, '.orbit', 'config.yaml');
    // review.when_unavailable: block, which was the starter's behaviour before decision 0007 (#6, #8); with the new
    // default (claude) admission lets Claude review instead of refusing.
    writeFileSync(path, readFileSync(path, 'utf8').replace(/(  codex:\n    command: codex\n(?:    #.*\n)*    data_policy_eligible: )false/, '$1true').replace(/^  when_unavailable: claude$/m, '  when_unavailable: block'));
    const adapter = (id: string) => ({
      discoverCapabilities: async () => ({ provider: id, available: true, version: '2.1.300', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'exact', costReporting: true, detail: 'ok' }),
      validateCredentials: async () => ({ state: 'valid', method: 'api_key', detail: 'ok' }),
    });
    const controllerDeps = (input: { db?: unknown }) => {
      const registry = new ModelRegistry(input.db as never, systemClock);
      return { adapters: { claude: adapter('claude'), codex: adapter('codex') }, registry, isolationFor: () => ({ kind: 'sandbox-runtime', available: async () => ({ ok: true, detail: 'srt present' }), wrap: () => ({}) }) } as never;
    };
    const r = await l.cli(['run', '--goal', 'x', '--foreground'], { seams: { controllerDeps } });
    expect(r.code, r.err).toBe(7);
    expect(r.err).toMatch(/"codex" has no model qualified for review/);
    expect(r.err).toContain('orbit models refresh');
    expect(runCount(l)).toBe(0);
  });

  it('a detached run skips the environment gate (the service has its own environment) but still checks the tree', async () => {
    const l = lab();
    await l.cli(['init']);
    defineCheck(l);
    const ok = await l.cli(['run', '--goal', 'x', '--mode', 'autonomous', '--detach']);
    expect(ok.code, ok.err).toBe(0);
    expect(runCount(l)).toBe(1);
  });

  it('allows a dirty tree when the policy allows it', async () => {
    const l = lab();
    await l.cli(['init']);
    defineCheck(l);
    const path = join(l.repo, '.orbit', 'config.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('allow_dirty_start: false', 'allow_dirty_start: true'));
    writeFileSync(join(l.repo, 'scratch.txt'), 'uncommitted\n');
    const r = await l.cli(['run', '--goal', 'x', '--mode', 'autonomous', '--detach']);
    expect(r.code, r.err).toBe(0);
  });
});

describe('P21: status right after init', () => {
  it('says there are no runs yet instead of telling the user to run init again', async () => {
    const l = lab();
    await l.cli(['init']);
    const r = await l.cli(['status']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/no runs yet; start one with: orbit run --goal/);
    expect(r.err).not.toMatch(/orbit init/);
    const j = await l.cli(['status', '--json']);
    expect(JSON.parse(j.out)).toMatchObject({ runs: [] });
  });

  it('a command that needs a run says there are no runs yet, once init has been done', async () => {
    const l = lab();
    await l.cli(['init']);
    const r = await l.cli(['logs', 'orb-nothing']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/no runs yet/);
    expect(r.err).not.toMatch(/run "orbit init"/);
  });

  it('without a config it still says to init', async () => {
    const l = lab();
    const r = await l.cli(['status']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/orbit init/);
  });
});

describe('P24: init derives allowed_paths from the repository layout', () => {
  it('uses the top-level directories the repository tracks', async () => {
    const l = lab();
    mkdirSync(join(l.repo, 'src'));
    mkdirSync(join(l.repo, 'tests'));
    mkdirSync(join(l.repo, '.github'));
    mkdirSync(join(l.repo, 'node_modules'));
    writeFileSync(join(l.repo, 'src', 'a.ts'), 'export {};\n');
    writeFileSync(join(l.repo, 'tests', 'a.test.ts'), 'export {};\n');
    writeFileSync(join(l.repo, '.github', 'ci.yml'), 'x: 1\n');
    git(l.repo, 'add', '-A');
    git(l.repo, 'commit', '-q', '-m', 'layout');
    const r = await l.cli(['init']);
    expect(r.code, r.err).toBe(0);
    const cfg = parse(readFileSync(join(l.repo, '.orbit', 'config.yaml'), 'utf8')) as { scope: { allowed_paths: string[] } };
    expect(cfg.scope.allowed_paths).toEqual(['src/**', 'tests/**']);
    expect(r.out).toMatch(/scope\.allowed_paths set to src\/\*\*, tests\/\*\* from the repository layout/);
    expect(loadConfig(l.repo).scope.allowed_paths).toEqual(['src/**', 'tests/**']);
  });

  it('keeps the template paths when the layout says nothing (and the template stays commented)', async () => {
    const l = lab();
    await l.cli(['init']);
    const cfg = parse(readFileSync(join(l.repo, '.orbit', 'config.yaml'), 'utf8')) as { scope: { allowed_paths: string[] } };
    expect(cfg.scope.allowed_paths).toEqual(['apps/**', 'packages/**', 'tests/**', 'docs/**']);
  });
});

describe('P28 and P27: command line polish', () => {
  it('-v prints the version like --version', async () => {
    const l = lab({ git: false });
    const v = await l.cli(['-v']);
    expect(v.code).toBe(0);
    expect(v.out).toBe((await l.cli(['--version'])).out);
  });

  it.each(['models', 'learn', 'service', 'release', 'policy'])('"orbit %s --help" lists the subcommands and exits 0', async (group) => {
    const l = lab({ git: false });
    const r = await l.cli([group, '--help']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`Usage: orbit ${group} <subcommand>`);
    expect(r.out).toMatch(new RegExp(`orbit ${group} [a-z]+ `));
    const viaHelp = await l.cli(['help', group]);
    expect(viaHelp.code).toBe(0);
    expect(viaHelp.out).toBe(r.out);
  });

  it('"help nosuch" fails with the usage exit code and a suggestion when one is close', async () => {
    const l = lab({ git: false });
    const r = await l.cli(['help', 'nosuch']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command "nosuch"/);
    const close = await l.cli(['help', 'staus']);
    expect(close.code).toBe(2);
    expect(close.err).toMatch(/did you mean "status"\?/);
  });

  it('suggests the closest command for a misspelling', async () => {
    const l = lab({ git: false });
    expect((await l.cli(['staus'])).err).toMatch(/unknown command "staus"; did you mean "status"\?/);
    expect((await l.cli(['dcotor'])).err).toMatch(/did you mean "doctor"\?/);
    expect((await l.cli(['models', 'lst'])).err).toMatch(/did you mean "models list"\?/);
    expect((await l.cli(['frobnicate'])).err).not.toMatch(/did you mean/);
  });

  it('reports an unknown option without the parser\'s unbalanced quote', async () => {
    const l = lab({ git: false });
    const r = await l.cli(['status', '--pending']);
    expect(r.code).toBe(2);
    const first = r.err.split('\n')[0]!;
    expect(first).toMatch(/^orbit: unknown option "--pending" for "orbit status"/);
    expect((first.match(/'/g) ?? []).length % 2).toBe(0);
    expect((first.match(/"/g) ?? []).length % 2).toBe(0);
    expect(r.err).toMatch(/usage: orbit status/);
  });

  it('a missing option value is reported in plain words', async () => {
    const l = lab({ git: false });
    const r = await l.cli(['run', '--goal']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^orbit: option --goal needs a value/);
  });

  it('a missing argument says what is needed', async () => {
    const l = lab({ git: false });
    const r = await l.cli(['logs']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/expected 1 argument\(s\), got 0 \(missing: <run-id>\)/);
  });

  it('a --policy path that does not exist is named, not answered with "run orbit init"', async () => {
    const l = lab();
    await l.cli(['init']);
    const r = await l.cli(['run', '--goal', 'x', '--policy', 'nope.yaml', '--detach']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/policy file .*nope\.yaml does not exist/);
    expect(r.err).not.toMatch(/orbit init/);
    expect(runCount(l)).toBe(0);
  });

  it('models list agrees with doctor about a model that is allowed but not yet validated', async () => {
    const l = lab();
    const r = await l.cli(['models', 'list']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/claude-sonnet-5-5 +claude-cli +unvalidated +allowed +yes, unvalidated/);
    expect(r.out).not.toMatch(/no: availability on claude-cli not yet validated\n/);
    const j = JSON.parse((await l.cli(['models', 'list', '--json'])).out) as { models: { model: string; status: string }[] };
    expect(j.models.find((m) => m.model === 'claude-sonnet-5-5')?.status).toBe('eligible-unvalidated');
  });
});

describe('P28: a finished run is not shown as still being cancelled', () => {
  it('lists CANCELLED without "(cancelling)" while a pending request on a live run still shows', async () => {
    const l = lab();
    await l.cli(['init']);
    const done = l.newRun('finished');
    l.moveTo(done.id, ['PREFLIGHT', 'CANCELLED']);
    l.db().run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', done.id);
    const live = l.newRun('in progress');
    l.db().run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', live.id);
    const list = await l.cli(['status']);
    expect(list.out).toMatch(new RegExp(`${done.id} +CANCELLED +\\w`));
    expect(list.out).not.toContain('CANCELLED (cancelling)');
    expect(list.out).toContain('CREATED (cancelling)');
    const one = await l.cli(['status', done.id]);
    expect(one.out.split('\n')[0]).toBe(`run ${done.id}  CANCELLED`);
  });
});
