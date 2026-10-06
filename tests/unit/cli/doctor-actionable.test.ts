/**
 * `orbit doctor` gives the fix that matches the failure and never cuts the
 * actionable part of a line (P6, P8), and warns when the configured scope
 * matches nothing (P24). Provider adapters and the isolation provider are
 * recorded answers; selection, registry and rendering are the real ones.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand, runDoctor, type DoctorCheck, type DoctorReport } from '../../../src/cli/commands/doctor.ts';
import { parseCommand } from '../../../src/cli/args.ts';
import { createContext, type CliContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import type { CredentialStatus, ProviderAdapter, ProviderCapabilities } from '../../../src/adapters/types.ts';
import type { IsolationProvider } from '../../../src/isolation/types.ts';

const hooks = vi.hoisted(() => ({
  config: null as null | (() => unknown),
  adapters: null as null | (() => unknown),
  isolation: null as null | (() => unknown),
}));
vi.mock('../../../src/policy/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/policy/index.ts')>();
  return { ...actual, loadConfig: (...a: Parameters<typeof actual.loadConfig>) => (hooks.config ? hooks.config() : actual.loadConfig(...a)) } as typeof actual;
});
vi.mock('../../../src/adapters/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/adapters/index.ts')>();
  return { ...actual, createAdapters: (...a: Parameters<typeof actual.createAdapters>) => (hooks.adapters ? hooks.adapters() : actual.createAdapters(...a)) } as typeof actual;
});
vi.mock('../../../src/isolation/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/isolation/index.ts')>();
  return { ...actual, getIsolation: (...a: Parameters<typeof actual.getIsolation>) => (hooks.isolation ? hooks.isolation() : actual.getIsolation(...a)) } as typeof actual;
});

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const dirs: string[] = [];
const iso = (kind: IsolationProvider['kind'], ok: boolean, detail: string): IsolationProvider => ({ kind, available: async () => ({ ok, detail }), wrap: () => ({}) as never });
beforeEach(() => {
  hooks.config = null;
  hooks.adapters = null;
  hooks.isolation = () => iso('sandbox-runtime', true, 'srt present');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface World {
  repo: string;
  ctx(io?: ReturnType<typeof memoryIo>): CliContext;
}
function world(files: Record<string, string> = { 'README.md': '# acme\n' }): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-docact-')));
  dirs.push(base);
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  for (const d of [repo, home, bin]) mkdirSync(d, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, ...GIT_ENV }, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...GIT_ENV };
  return { repo, ctx: (io = memoryIo()) => createContext({ io, cwd: repo, env, homeDir: home, orbitHome: join(home, '.orbit'), platform: 'linux', uid: 1000, user: 'alice', clock: systemClock }) };
}

function adapter(id: string, cap: Partial<ProviderCapabilities> = {}, cred?: CredentialStatus): ProviderAdapter {
  return {
    discoverCapabilities: async (): Promise<ProviderCapabilities> => ({ provider: id, available: true, version: '2.1.300', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'exact', costReporting: true, detail: 'ok', ...cap }),
    validateCredentials: async (): Promise<CredentialStatus> => cred ?? { state: 'valid', method: 'api_key', detail: 'ok' },
  } as unknown as ProviderAdapter;
}

function cfg(over: (c: OrbitConfig) => void = () => {}): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.isolation = { ...c.isolation, provider: 'none', allow_unisolated: true };
  c.providers = { claude: { ...c.providers.claude!, data_policy_eligible: true }, codex: { ...c.providers.codex!, data_policy_eligible: true, model: null } };
  c.routing.allowed_models = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'codex:*'];
  over(c);
  return c;
}

async function report(w: World, config: OrbitConfig, adapters: Record<string, ProviderAdapter> = { claude: adapter('claude'), codex: adapter('codex') }): Promise<DoctorReport> {
  hooks.adapters = () => adapters;
  hooks.config = () => config;
  return runDoctor(w.ctx(), { probe: false });
}
const byId = (r: DoctorReport): Record<string, DoctorCheck> => Object.fromEntries(r.checks.map((c) => [c.id, c]));

describe('P6: the review fix matches the reason', () => {
  it('with codex eligible but no model qualified, the fix is to refresh the catalog or name a model', async () => {
    const w = world();
    const c = byId(await report(w, cfg()));
    expect(c.review).toMatchObject({ status: 'fail' });
    expect(c.review!.summary).toMatch(/"codex" has no model qualified for review/);
    expect(c.review!.fix).toContain('orbit models refresh');
    expect(c.review!.fix).toContain('providers.codex.model');
    expect(c.review!.fix).not.toMatch(/log in/);
  });

  it('with codex not eligible, the fix is the data policy attestation', async () => {
    const w = world();
    // A model is named, so the data policy is the only unmet prerequisite (without one, issue 7: both are listed).
    const c = byId(await report(w, cfg((x) => { x.providers.codex!.data_policy_eligible = false; x.providers.codex!.model = 'gpt-6-astra'; })));
    expect(c.review!.fix).toContain('providers.codex.data_policy_eligible: true');
    expect(c.review!.fix).not.toContain('orbit models refresh');
  });

  it('issue 7: with codex not eligible AND no model qualified, both prerequisites and both fixes are listed at once', async () => {
    const w = world();
    const c = byId(await report(w, cfg((x) => (x.providers.codex!.data_policy_eligible = false))));
    expect(c.review).toMatchObject({ status: 'fail' });
    expect(c.review!.fix).toContain('providers.codex.data_policy_eligible: true');
    expect(c.review!.fix).toContain('orbit models refresh');
    const lines = c.review!.details.join('\n');
    expect(lines).toMatch(/data_policy_eligible is not true/);
    expect(lines).toMatch(/no model of "codex" is qualified for review/);
  });

  it('issue 7: with codex logged out, not eligible and no model qualified, all three are listed', async () => {
    const w = world();
    const c = byId(await report(w, cfg((x) => (x.providers.codex!.data_policy_eligible = false)), { claude: adapter('claude'), codex: adapter('codex', {}, { state: 'missing', method: null, detail: 'not logged in' }) }));
    expect(c.review!.fix).toMatch(/codex login/);
    expect(c.review!.fix).toContain('providers.codex.data_policy_eligible: true');
    expect(c.review!.fix).toContain('orbit models refresh');
  });

  it('with codex logged out, the fix is the login', async () => {
    const w = world();
    const c = byId(await report(w, cfg(), { claude: adapter('claude'), codex: adapter('codex', {}, { state: 'missing', method: null, detail: 'not logged in' }) }));
    expect(c.review!.fix).toMatch(/codex login/);
  });
});

describe('P8: actionable text is shown in full', () => {
  it('names the whole install command for a missing srt, in the fix and in the JSON', async () => {
    const w = world();
    const long = `srt not found on PATH or ${join('/very/long/install/directory/that/goes/on/and/on', 'node_modules', '.bin', 'srt')} (and a second location /another/rather/long/path/node_modules/.bin/srt); install @anthropic-ai/sandbox-runtime`;
    hooks.isolation = () => iso('sandbox-runtime', false, long);
    const r = await report(w, cfg((x) => (x.isolation = { ...x.isolation, provider: 'sandbox-runtime' })));
    const c = byId(r);
    expect(c.isolation!.status).toBe('fail');
    expect(c.isolation!.fix).toContain('npm install --global @anthropic-ai/sandbox-runtime');
    expect(c.isolation!.summary).toContain(long);
    expect(c.isolation!.summary).not.toMatch(/\.\.\.$/);

    const io = memoryIo();
    hooks.adapters = () => ({ claude: adapter('claude'), codex: adapter('codex') });
    hooks.config = () => cfg((x) => (x.isolation = { ...x.isolation, provider: 'sandbox-runtime' }));
    await doctorCommand(parseCommand(['--json'], undefined, 'orbit doctor'), w.ctx(io));
    const j = JSON.parse(io.stdout) as DoctorReport;
    expect(j.checks.find((x) => x.id === 'isolation')!.summary).toContain('install @anthropic-ai/sandbox-runtime');
  });

  it('prints the whole review reason and every fix line, never ending in an ellipsis', async () => {
    const w = world();
    const io = memoryIo();
    hooks.adapters = () => ({ claude: adapter('claude'), codex: adapter('codex') });
    hooks.config = () => cfg((x) => (x.providers.codex!.data_policy_eligible = false));
    await doctorCommand(parseCommand([], undefined, 'orbit doctor'), w.ctx(io));
    const text = io.stdout;
    expect(text).toContain('verification is incomplete until an independent provider is available.');
    expect(text).not.toMatch(/\.\.\.$/m);
  });
});

describe('P24: doctor warns when the allowed paths match nothing', () => {
  it('warns on scope in a repository laid out under src/ with the starter paths', async () => {
    const w = world({ 'README.md': '# acme\n', 'src/a.ts': 'export {};\n' });
    const c = byId(await report(w, cfg((x) => (x.scope.allowed_paths = ['apps/**', 'packages/**', 'tests/**', 'docs/**']))));
    expect(c.scope).toMatchObject({ status: 'warn' });
    expect(c.scope!.summary).toMatch(/scope\.allowed_paths \(apps\/\*\*.*\) matches no tracked file/);
    expect(c.scope!.fix).toMatch(/allowed_paths/);
  });

  it('passes when at least one tracked file is in scope', async () => {
    const w = world({ 'README.md': '# acme\n', 'src/a.ts': 'export {};\n' });
    const c = byId(await report(w, cfg((x) => (x.scope.allowed_paths = ['src/**']))));
    expect(c.scope).toMatchObject({ status: 'pass' });
  });
});
