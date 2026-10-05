/**
 * `orbit models list` and `orbit models refresh`. The provider CLIs are
 * replaced by recorded answers (what `claude` reports about itself, what
 * `codex debug models` prints), so the command's own decisions are what is
 * checked: which model it marks unavailable, what a probe may validate and
 * how each failure is reported.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { codexCatalog } from '../routing/fixtures.ts';
import { makeLab, type Lab } from './lab.ts';

interface FakeAdapter {
  discoverCapabilities: () => Promise<{ available: boolean; version: string | null; detail: string }>;
  probeCredentials?: (o: { model: string; timeoutMs: number }) => Promise<{ state: string; method?: string; detail: string }>;
}
const hooks = vi.hoisted(() => ({
  config: null as null | (() => unknown),
  adapter: null as null | ((id: string) => unknown),
  exec: null as null | ((argv: readonly string[]) => unknown),
  adapterCalls: [] as Array<{ id: string; env: Record<string, string | undefined> }>,
  execCalls: [] as Array<{ argv: readonly string[]; opts: Record<string, unknown> }>,
}));

vi.mock('../../../src/policy/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/policy/index.ts')>();
  return { ...actual, loadConfig: (...a: Parameters<typeof actual.loadConfig>) => (hooks.config ? hooks.config() : actual.loadConfig(...a)) } as typeof actual;
});
vi.mock('../../../src/adapters/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/adapters/index.ts')>();
  return {
    ...actual,
    createAdapter: (id: string, _pc: unknown, opts: { baseEnv: Record<string, string | undefined> }) => {
      hooks.adapterCalls.push({ id, env: opts.baseEnv });
      return hooks.adapter ? hooks.adapter(id) : actual.createAdapter(id, _pc as never, opts as never);
    },
  } as typeof actual;
});
vi.mock('../../../src/core/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/exec.ts')>();
  return {
    ...actual,
    execCapture: (argv: readonly string[], opts: Record<string, unknown>) => {
      if (argv.includes('debug') && argv.includes('models')) {
        hooks.execCalls.push({ argv, opts });
        const fake = hooks.exec?.(argv);
        if (fake instanceof Error) return Promise.reject(fake);
        return Promise.resolve(fake);
      }
      return actual.execCapture(argv, opts as never);
    },
  };
});

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
beforeEach(() => {
  hooks.config = null;
  hooks.adapter = null;
  hooks.exec = null;
  hooks.adapterCalls = [];
  hooks.execCalls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  labs.splice(0).forEach((l) => l.close());
});

const answer = (stdout: string, exitCode: number | null = 0) => ({ exitCode, signal: null, stdout, stderr: '', timedOut: false, cancelled: false, durationMs: 1, stdoutTruncated: false, stderrTruncated: false, pid: 1 });

function config(over: (c: OrbitConfig) => void = () => {}): OrbitConfig {
  const c = defaultConfig('autonomous');
  over(c);
  return c;
}

describe('orbit models list', () => {
  it('without a valid config or state says so, and shows eligibility under the default allowed models', async () => {
    const l = lab();
    const r = await l.cli(['models', 'list']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^MODEL\s+SURFACE\s+AVAILABILITY\s+POLICY\s+ELIGIBLE\n/);
    expect(r.out).toContain('\n(no valid .orbit/config.yaml: showing eligibility under the default allowed_models)\n');
    expect(r.out).toContain('(no state database yet: showing the shipped registry seed)\n');
    expect(r.out).toContain('unvalidated means Orbit has not yet seen the model run on that surface');
    expect(r.out).toMatch(/claude-fable-5-1\s+claude-cli\s+unvalidated\s+not allowed\s+no: /);
  });

  it('with a valid config and state prints neither note, and marks wildcard and explicit policy matches', async () => {
    const l = lab();
    await l.cli(['init']);
    l.db();
    hooks.config = () => config((c) => (c.routing.allowed_models = ['claude-sonnet-5-5', 'codex:*']));
    const registry = new ModelRegistry(l.db(), systemClock);
    registry.seed();
    registry.registerCodexCatalog(codexCatalog(), { source: 'live' });
    const r = await l.cli(['models', 'list']);
    expect(r.out).not.toContain('no valid .orbit/config.yaml');
    expect(r.out).not.toContain('no state database yet');
    expect(r.out).toMatch(/claude-sonnet-5-5\s+claude-cli\s+unvalidated\s+allowed\s+/);
    expect(r.out).toMatch(/codex-alpha\s+codex-cli\s+available\s+wildcard\s+/);
    const j = JSON.parse((await l.cli(['models', 'list', '--json'])).out) as { config_loaded: boolean; persisted: boolean; allowed_models: string[]; models: Array<{ model: string; policy: string; eligible: boolean }> };
    expect(j).toMatchObject({ config_loaded: true, persisted: true, allowed_models: ['claude-sonnet-5-5', 'codex:*'] });
    expect(j.models.find((m) => m.model === 'codex-alpha')).toMatchObject({ policy: 'wildcard' });
  });

  it('seeds an existing but empty registry, and lists a model with no surface under the Claude CLI', async () => {
    const l = lab();
    l.db();
    const registry = new ModelRegistry(l.db(), systemClock);
    expect(registry.list()).toEqual([]);
    const r = await l.cli(['models', 'list', '--json']);
    const j = JSON.parse(r.out) as { persisted: boolean; models: Array<{ model: string }> };
    expect(j.persisted).toBe(true);
    expect(j.models.length).toBeGreaterThan(0);
    expect(registry.list().length).toBeGreaterThan(0);
    l.db().run("UPDATE model_registry SET surfaces_json = '[]'");
    const bare = JSON.parse((await l.cli(['models', 'list', '--json'])).out) as { models: Array<{ surface: string; availability: string; availability_detail: string | null }> };
    expect(bare.models.every((m) => m.surface === 'claude-cli' && m.availability === 'unvalidated' && m.availability_detail === null)).toBe(true);
  });

  it('rejects an argument', async () => {
    expect((await lab().cli(['models', 'list', 'x'])).code).toBe(2);
  });
});

describe('orbit models refresh', () => {
  const ok = (version: string, probe?: FakeAdapter['probeCredentials']): FakeAdapter => ({ discoverCapabilities: async () => ({ available: true, version, detail: '' }), ...(probe ? { probeCredentials: probe } : {}) });

  it('reseeds the registry and records the installed claude version, passing only the environment a provider needs', async () => {
    const l = lab();
    hooks.config = () => config((c) => (c.providers = { claude: c.providers.claude! }));
    hooks.adapter = () => ok('9.9.9');
    const r = await l.cli(['models', 'refresh'], { env: { PATH: process.env.PATH, HOME: '/h', SECRET_TOKEN: 'leak', ANTHROPIC_API_KEY: 'k' } });
    expect(r.code, r.err).toBe(0);
    const lines = r.out.trim().split('\n');
    expect(lines[0]).toMatch(/^seeded the registry: \d+ added, \d+ refreshed$/);
    expect(lines[1]).toBe('provider claude: claude 9.9.9');
    expect(lines).toHaveLength(2);
    expect(hooks.adapterCalls[0]!.env).toEqual({ PATH: process.env.PATH, HOME: '/h', ANTHROPIC_API_KEY: 'k' });
    // Refresh creates the state it records into.
    expect(new ModelRegistry(l.db(), systemClock).list().length).toBeGreaterThan(0);
  });

  it('marks the models an old claude cannot run as unavailable, and says which', async () => {
    const l = lab();
    hooks.config = () => config((c) => (c.providers = { claude: c.providers.claude! }));
    hooks.adapter = () => ok('2.1.270');
    const r = await l.cli(['models', 'refresh', '--json']);
    const j = JSON.parse(r.out) as { notes: string[]; models: Array<{ model: string; available: boolean | null }> };
    expect(j.notes).toContain('  claude-sonnet-5-5: unavailable (needs claude >= 2.1.284)');
    expect(j.notes).toContain('  claude-opus-5-5: unavailable (needs claude >= 2.1.280)');
    expect(j.notes.some((n) => n.includes('claude-fable-5-1: unavailable'))).toBe(false);
    const row = new ModelRegistry(l.db(), systemClock).list().find((m) => m.modelId === 'claude-sonnet-5-5')!;
    expect(row.surfaces.find((s) => s.surface === 'claude-cli')).toMatchObject({ available: false, detail: 'installed claude 2.1.270 is older than 2.1.284, which claude-sonnet-5-5 needs' });
    expect(j.models.find((m) => m.model === 'claude-sonnet-5-5')?.available).toBe(false);
  });

  it('leaves availability alone when claude is not installed or reports no version', async () => {
    const l = lab();
    hooks.config = () => config((c) => (c.providers = { claude: c.providers.claude! }));
    hooks.adapter = () => ({ discoverCapabilities: async () => ({ available: false, version: null, detail: 'claude: command not found' }) });
    const gone = await l.cli(['models', 'refresh']);
    expect(gone.out).toContain('provider claude: claude CLI unavailable (claude: command not found); registry availability left as it was\n');
    hooks.adapter = () => ({ discoverCapabilities: async () => ({ available: true, version: null, detail: 'no version printed' }) });
    expect((await l.cli(['models', 'refresh'])).out).toContain('claude CLI unavailable (no version printed)');
  });

  it('with --probe validates only allowed models that are not known unavailable, and does not mark an inconclusive probe', async () => {
    const l = lab();
    hooks.config = () => config((c) => {
      c.providers = { claude: c.providers.claude! };
      c.routing.allowed_models = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'];
    });
    const probed: string[] = [];
    hooks.adapter = () =>
      ok('2.1.282', async ({ model, timeoutMs }) => {
        probed.push(`${model}:${timeoutMs}`);
        return model === 'haiku' ? { state: 'expired', detail: 'login   expired\nplease log in' } : { state: 'valid', method: 'oauth', detail: '' };
      });
    const r = await l.cli(['models', 'refresh', '--probe']);
    expect(r.out).toContain('  claude-opus-5-5: validated by a live request\n');
    expect(r.out).toContain('  claude-haiku-4-5-20251001: probe inconclusive (expired: login expired please log in); not marked\n');
    // sonnet needs 2.1.284 and was just marked unavailable; fable is not allowed.
    expect(probed.sort()).toEqual(['haiku:90000', 'opus:90000']);
    const reg = new ModelRegistry(l.db(), systemClock);
    expect(reg.list().find((m) => m.modelId === 'claude-opus-5-5')!.surfaces.find((s) => s.surface === 'claude-cli')).toMatchObject({ available: true, detail: 'live probe succeeded (oauth)' });
    expect(reg.list().find((m) => m.modelId === 'claude-haiku-4-5-20251001')!.surfaces.find((s) => s.surface === 'claude-cli')?.available).not.toBe(true);
  });

  it('says so, once per provider, when an adapter has no live probe, and a probe with no method is a plain credential', async () => {
    const l = lab();
    hooks.config = () => config((c) => (c.providers = { claude: c.providers.claude! }));
    hooks.adapter = () => ok('9.9.9');
    const none = await l.cli(['models', 'refresh', '--probe']);
    expect(none.out).toContain('  --probe: claude has no live probe\n');
    hooks.adapter = () => ok('9.9.9', async () => ({ state: 'valid', detail: '' }));
    await l.cli(['models', 'refresh', '--probe']);
    const detail = new ModelRegistry(l.db(), systemClock).list().find((m) => m.modelId === 'claude-sonnet-5-5')!.surfaces.find((s) => s.surface === 'claude-cli')?.detail;
    expect(detail).toBe('live probe succeeded (credential)');
  });

  it('probes with a model\'s CLI alias when it has one', async () => {
    const l = lab();
    hooks.config = () => config((c) => {
      c.providers = { claude: c.providers.claude! };
      c.routing.allowed_models = ['claude-sonnet-5-5'];
    });
    const models: string[] = [];
    hooks.adapter = () => ok('9.9.9', async ({ model }) => (models.push(model), { state: 'valid', detail: '' }));
    await l.cli(['models', 'refresh', '--probe']);
    expect(models).toEqual(['sonnet']);
  });

  it('skips a provider id it has no adapter for, and says why', async () => {
    const l = lab();
    hooks.config = () => config((c) => (c.providers = { 'mystery-ai': c.providers.claude! }));
    const r = await l.cli(['models', 'refresh']);
    expect(r.out).toContain('provider mystery-ai: skipped (providers.mystery-ai: unknown provider; Orbit has adapters for claude and codex)\n');
    expect(hooks.adapterCalls).toEqual([]);
  });

  describe('codex catalog', () => {
    const only = (c: OrbitConfig) => {
      c.providers = { codex: { ...c.providers.codex!, command: 'codex-fake' } };
    };

    it('registers what `codex debug models` lists, and reports hidden models and the default', async () => {
      const l = lab();
      hooks.config = () => config(only);
      hooks.exec = () => answer(JSON.stringify(codexCatalog()));
      const r = await l.cli(['models', 'refresh', '--json']);
      expect(r.code, r.err).toBe(0);
      const j = JSON.parse(r.out) as { notes: string[]; changes: Record<string, { listed: string[]; hidden: string[] }> };
      expect(j.notes[1]).toBe('provider codex: 2 model(s) listed, 1 hidden; default codex-alpha');
      expect(j.changes['catalog:codex']).toMatchObject({ listed: ['codex-alpha', 'codex-beta'], hidden: ['codex-internal'] });
      expect(hooks.execCalls[0]!.argv).toEqual(['codex-fake', 'debug', 'models']);
      expect(hooks.execCalls[0]!.opts).toMatchObject({ timeoutMs: 60_000, cwd: l.repo });
    });

    it('runs a script command under this Node, and says what dropped out of a later catalog', async () => {
      const l = lab();
      hooks.config = () => config((c) => (c.providers = { codex: { ...c.providers.codex!, command: '/opt/codex/cli.mjs' } }));
      hooks.exec = () => answer(JSON.stringify(codexCatalog()));
      await l.cli(['models', 'refresh']);
      expect(hooks.execCalls[0]!.argv).toEqual([process.execPath, '/opt/codex/cli.mjs', 'debug', 'models']);
      const smaller = codexCatalog() as { models: unknown[] };
      smaller.models = smaller.models.slice(0, 1);
      hooks.exec = () => answer(JSON.stringify(smaller));
      const r = await l.cli(['models', 'refresh']);
      expect(r.out).toContain('provider codex: 1 model(s) listed, 1 no longer offered; default codex-alpha\n');
    });

    it('notes a command that cannot run, or that exits non-zero, and keeps the registry as it was', async () => {
      const l = lab();
      hooks.config = () => config(only);
      hooks.exec = () => new Error('spawn codex-fake ENOENT\nmore');
      const missing = await l.cli(['models', 'refresh']);
      expect(missing.out).toContain('provider codex: spawn codex-fake ENOENT more\n');
      hooks.exec = () => answer('', 2);
      expect((await l.cli(['models', 'refresh'])).out).toContain('provider codex: "codex-fake debug models" exited 2; registry availability left as it was\n');
      hooks.exec = () => answer('', null);
      expect((await l.cli(['models', 'refresh'])).out).toContain('exited by signal; registry availability left as it was');
      expect(new ModelRegistry(l.db(), systemClock).list().some((m) => m.modelId === 'codex-alpha')).toBe(false);
    });

    it('fails with exit 1 when the output is not a model catalog', async () => {
      const l = lab();
      hooks.config = () => config(only);
      hooks.exec = () => answer('this is not json');
      const r = await l.cli(['models', 'refresh']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/^orbit: codex: "debug models" printed something that is not a model catalog \(/);
      hooks.exec = () => answer('{"models": "nope"}');
      expect((await l.cli(['models', 'refresh'])).err).toMatch(/not a model catalog/);
    });
  });

  it('uses the default configuration when the repository has none, and refuses an argument', async () => {
    const l = lab();
    hooks.adapter = () => ok('9.9.9');
    hooks.exec = () => answer(JSON.stringify(codexCatalog()));
    const r = await l.cli(['models', 'refresh']);
    expect(r.out).toContain('provider claude: claude 9.9.9\n');
    expect(r.out).toContain('provider codex: 2 model(s) listed');
    expect((await l.cli(['models', 'refresh', 'extra'])).code).toBe(2);
    mkdirSync(join(l.repo, '.orbit'), { recursive: true });
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), 'not: [valid');
    expect((await l.cli(['models', 'refresh'])).code).toBe(0);
  });
});
