/**
 * Issue #9: before any run, `orbit doctor` lists the plugins a worker session would load (from
 * `claude plugin list --json`) and whether the policy allows each, with the config line that would allow a
 * refused one. Workers start with `--setting-sources ""`, so user, project and local plugins never load;
 * managed ones always do. The `claude` here is a stand-in script that answers with a recorded plugin list.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor, type DoctorCheck } from '../../../src/cli/commands/doctor.ts';
import { createContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { systemClock } from '../../../src/core/clock.ts';

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const HUMAN_POLICY_NOTE = 'A person, not an agent, must make any edit to agents.allowed_plugins or providers.codex.data_policy_eligible in .orbit/config.yaml. Do not ask an agent to apply this fix. An auto-mode classifier may flag worker launches.';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FAKE = `
import { readFileSync } from 'node:fs';
const a = process.argv.slice(2);
const here = new URL('.', import.meta.url).pathname;
if (a[0] === '--version') { process.stdout.write('2.1.291 (Claude Code)\\n'); process.exit(0); }
if (a[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) + '\\n'); process.exit(0); }
if (a[0] === 'plugin' && a[1] === 'list' && a.includes('--json')) {
  const out = readFileSync(here + 'plugin-list.out', 'utf8');
  if (out.startsWith('EXIT')) { process.stderr.write('plugin list failed\\n'); process.exit(1); }
  process.stdout.write(out);
  process.exit(0);
}
process.exit(2);
`;

async function pluginCheck(pluginList: unknown, agents = ''): Promise<DoctorCheck | undefined> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-docplug-')));
  dirs.push(base);
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  for (const d of [repo, home, bin]) mkdirSync(d, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, ...GIT_ENV }, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# acme\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const claude = join(bin, 'claude-acme.mjs');
  writeFileSync(claude, FAKE);
  writeFileSync(join(bin, 'plugin-list.out'), typeof pluginList === 'string' ? pluginList : JSON.stringify(pluginList, null, 2));
  mkdirSync(join(repo, '.orbit'), { recursive: true });
  writeFileSync(
    join(repo, '.orbit', 'config.yaml'),
    [
      'version: 1',
      'mode: supervised',
      'isolation: {provider: none, allow_unisolated: true}',
      'review: {independent_provider_required: false}',
      `providers: {claude: {command: ${JSON.stringify(claude)}}}`,
      ...(agents ? [`agents: ${agents}`] : []),
      '',
    ].join('\n'),
  );
  const env: Record<string, string | undefined> = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...GIT_ENV };
  const ctx = createContext({ io: memoryIo(), cwd: repo, env, homeDir: home, orbitHome: join(home, '.orbit'), platform: 'linux', uid: 1000, user: 'alice', clock: systemClock });
  const report = await runDoctor(ctx, { probe: false });
  return report.checks.find((c) => c.id === 'claude.plugins');
}

const LIST = [
  { id: 'acme-guard@acme-it', version: '1.0.0', scope: 'managed', enabled: true, installPath: '/opt/acme/acme-guard' },
  { id: 'acme-notes@acme', version: '0.2.0', scope: 'user', enabled: true, installPath: '/home/dev/.claude/plugins/acme-notes' },
  { id: 'acme-off@acme-it', version: '1.0.0', scope: 'managed', enabled: false, installPath: '/opt/acme/acme-off' },
];

describe('doctor: plugins a worker would load (issue #9)', () => {
  it('fails on a managed plugin the default policy refuses, naming it and the config line that allows it', async () => {
    const c = await pluginCheck(LIST);
    expect(c).toMatchObject({
      status: 'fail',
      area: 'providers',
      summary: 'workers would load 1 plugin(s) the policy does not allow, so every worker session would be refused: acme-guard@acme-it (scope managed)',
      missing: 'a policy that allows each plugin a worker loads',
      fix: `add to .orbit/config.yaml: agents.allowed_plugins: ["acme-guard@acme-it"] (or agents.allow_managed_plugins: true for every managed plugin); a plugin can add hooks and tools to workers; ${HUMAN_POLICY_NOTE}`,
    });
    expect(c!.details).toEqual([
      'acme-guard@acme-it (scope managed): refused; allow it with agents.allowed_plugins: ["acme-guard@acme-it"] or agents.allow_managed_plugins: true',
      'not loaded by workers: acme-notes@acme (scope user; workers load no user, project or local settings)',
      'not loaded by workers: acme-off@acme-it (disabled)',
      'scope source: claude plugin list --json (system/init does not report a plugin\'s scope)',
    ]);
  });

  it('passes when the policy allows the plugin, and says the report names what the sessions loaded', async () => {
    const managed = await pluginCheck(LIST, '{allow_managed_plugins: true}');
    expect(managed).toMatchObject({ status: 'pass', summary: 'workers would load 1 plugin(s), each allowed by the policy: acme-guard@acme-it (scope managed, agents.allow_managed_plugins)' });
    expect(managed!.details[0]).toBe('acme-guard@acme-it (scope managed): allowed by agents.allow_managed_plugins');
    expect(managed!.details).toContain("a plugin can add hooks and tools to workers; a run's final report lists the plugins its worker sessions reported loading and says nothing when they loaded none");
    const exact = await pluginCheck(LIST, '{allowed_plugins: ["acme-guard@acme-it"]}');
    expect(exact).toMatchObject({ status: 'pass', summary: 'workers would load 1 plugin(s), each allowed by the policy: acme-guard@acme-it (scope managed, agents.allowed_plugins)' });
  });

  it('passes with only built-ins, and warns when the list cannot be read or a scope is one it cannot place', async () => {
    expect(await pluginCheck([LIST[1]])).toMatchObject({ status: 'pass', summary: 'workers load only Claude Code built-ins' });
    expect(await pluginCheck('EXIT')).toMatchObject({ status: 'warn', summary: expect.stringMatching(/^could not list the installed plugins \(claude plugin list --json: exit 1/), missing: 'the output of claude plugin list --json' });
    expect(await pluginCheck('not json')).toMatchObject({ status: 'warn', summary: 'could not list the installed plugins (claude plugin list --json gave no plugin list)' });
    const odd = await pluginCheck([{ id: 'acme-sync@acme', scope: 'synced', enabled: true }]);
    expect(odd).toMatchObject({ status: 'warn', summary: 'workers may load 1 plugin(s) the policy does not allow: acme-sync@acme (scope synced)', fix: `add to .orbit/config.yaml: agents.allowed_plugins: ["acme-sync@acme"]; a plugin can add hooks and tools to workers; ${HUMAN_POLICY_NOTE}` });
  });
});
