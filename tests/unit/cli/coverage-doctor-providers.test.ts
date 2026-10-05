/**
 * `orbit doctor`, the provider and model checks: what each provider CLI
 * reports, how its credential is judged, the worker tier, independent review
 * and which models are eligible. The provider adapters are recorded answers
 * (what `claude` or `codex` would say about themselves); the credential
 * logic, reviewer selection and model registry are the real ones.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor, type DoctorCheck } from '../../../src/cli/commands/doctor.ts';
import { createContext, type CliContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import type { CredentialStatus, ProviderAdapter, ProviderCapabilities } from '../../../src/adapters/types.ts';
import type { IsolationProvider } from '../../../src/isolation/types.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import { openDb } from '../../../src/storage/db.ts';
import { stateDbPath } from '../../../src/controller/start.ts';
import { codexCatalog } from '../routing/fixtures.ts';

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
  return {
    ...actual,
    createAdapters: (...a: Parameters<typeof actual.createAdapters>) => {
      const r = hooks.adapters ? hooks.adapters() : actual.createAdapters(...a);
      if (r instanceof Error) throw r;
      return r;
    },
  } as typeof actual;
});
vi.mock('../../../src/isolation/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/isolation/index.ts')>();
  return { ...actual, getIsolation: (...a: Parameters<typeof actual.getIsolation>) => (hooks.isolation ? hooks.isolation() : actual.getIsolation(...a)) } as typeof actual;
});

const GIT_ENV = { GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const dirs: string[] = [];
const srt = (ok = true): IsolationProvider => ({ kind: 'sandbox-runtime', available: async () => ({ ok, detail: 'srt present' }), wrap: () => ({}) as never });
beforeEach(() => {
  hooks.config = null;
  hooks.adapters = null;
  hooks.isolation = () => srt();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface World {
  repo: string;
  home: string;
  bin: string;
  env: Record<string, string | undefined>;
  ctx(over?: Partial<CliContext>): CliContext;
}
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-docp-')));
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
  // Only the fake bin directory and the system directories, so a provider CLI installed on this machine is never found.
  const env: Record<string, string | undefined> = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...GIT_ENV };
  return { repo, home, bin, env, ctx: (over = {}) => createContext({ io: memoryIo(), cwd: repo, env, homeDir: home, orbitHome: join(home, '.orbit'), platform: 'linux', uid: 1000, user: 'alice', clock: systemClock, ...over }) };
}

interface Spec {
  cap?: Partial<ProviderCapabilities> | Error | string;
  cred?: CredentialStatus | Error;
  probe?: ((opts: { model?: string; timeoutMs?: number }) => Promise<CredentialStatus>) | null;
}
function adapter(id: string, spec: Spec = {}): ProviderAdapter {
  const a = {
    discoverCapabilities: async (): Promise<ProviderCapabilities> => {
      if (spec.cap instanceof Error) throw spec.cap;
      if (typeof spec.cap === 'string') throw spec.cap;
      return { provider: id, available: true, version: '2.1.300', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'exact', costReporting: true, detail: 'ok', ...(spec.cap ?? {}) };
    },
    validateCredentials: async (): Promise<CredentialStatus> => {
      if (spec.cred instanceof Error) throw spec.cred;
      return spec.cred ?? { state: 'valid', method: 'api_key', detail: 'ANTHROPIC_API_KEY is set' };
    },
    ...(spec.probe === null ? {} : { probeCredentials: spec.probe ?? (async () => ({ state: 'valid' as const, method: 'api_key', detail: 'live ok' })) }),
  };
  return a as unknown as ProviderAdapter;
}

function cfg(over: (c: OrbitConfig) => void = () => {}): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.isolation = { ...c.isolation, provider: 'none', allow_unisolated: true };
  c.providers = { claude: { ...c.providers.claude!, data_policy_eligible: true }, codex: { ...c.providers.codex!, data_policy_eligible: true } };
  c.routing.allowed_models = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'codex:*'];
  over(c);
  return c;
}

async function doctor(w: World, adapters: Record<string, ProviderAdapter>, config: OrbitConfig, over: { probe?: boolean; env?: Record<string, string | undefined> } = {}): Promise<Record<string, DoctorCheck>> {
  hooks.adapters = () => adapters;
  hooks.config = () => config;
  const report = await runDoctor(w.ctx(over.env ? { env: { ...w.env, ...over.env } } : {}), { probe: over.probe ?? false });
  return Object.fromEntries(report.checks.map((c) => [c.id, c]));
}

/** A state database whose registry knows the Claude models and a codex catalog, so review has a codex model to pick. */
function seedRegistry(w: World, mutate: (r: ModelRegistry) => void = () => {}): void {
  mkdirSync(join(w.repo, '.orbit'), { recursive: true });
  const db = openDb(stateDbPath(w.repo));
  const registry = new ModelRegistry(db, systemClock);
  registry.seed();
  registry.registerCodexCatalog(codexCatalog(), { source: 'live' });
  mutate(registry);
  db.close();
}

describe('provider CLIs', () => {
  it('reports each CLI with its version and where it is, and the capabilities that matter', async () => {
    const w = world();
    const claudeAt = join(w.bin, 'claude');
    writeFileSync(claudeAt, '#!/bin/sh\n', { mode: 0o755 });
    const c = await doctor(w, { claude: adapter('claude'), codex: adapter('codex', { cap: { version: null, readOnlySandbox: false, structuredOutput: false, usageReporting: 'partial', costReporting: false } }) }, cfg((x) => (x.review.independent_provider_required = false)));
    expect(c['claude.cli']).toMatchObject({ status: 'pass', summary: `claude 2.1.300 at ${claudeAt}`, details: ['structured output: yes', 'read-only sandbox: yes', 'usage reporting: exact', 'cost reporting: yes'] });
    expect(c['codex.cli']).toMatchObject({ status: 'pass', summary: 'codex version unknown at codex', details: ['structured output: no', 'read-only sandbox: no', 'usage reporting: partial', 'cost reporting: no'] });
  });

  it('fails for a CLI a run cannot do without, and only warns for one it can, with the install hint for each kind', async () => {
    const w = world();
    const down = { available: false, version: null, detail: 'claude: command not found\non PATH' };
    const bad = await doctor(w, { claude: adapter('claude', { cap: down }), codex: adapter('codex', { cap: { ...down, detail: 'codex: command not found' } }) }, cfg((x) => (x.review.independent_provider_required = false)));
    expect(bad['claude.cli']).toMatchObject({ status: 'fail', summary: 'claude is not usable: claude: command not found on PATH', missing: 'the claude CLI (claude) on PATH, >= 2.1.284 for Sonnet 5.5', fix: 'install Claude Code (https://code.claude.com)' });
    expect(bad['codex.cli']).toMatchObject({ status: 'warn', summary: 'codex is not usable: codex: command not found', missing: 'the codex CLI (codex) on PATH', fix: expect.stringMatching(/codex/i) });
    expect(bad['claude.auth']).toBeUndefined();
    const needed = await doctor(w, { claude: adapter('claude'), codex: adapter('codex', { cap: { available: false, version: null, detail: 'gone' } }) }, cfg());
    expect(needed['codex.cli']?.status).toBe('fail');
  });

  it('records a CLI whose capability probe throws as unavailable, with the message or the thrown text', async () => {
    const w = world();
    const c = await doctor(w, { claude: adapter('claude', { cap: new Error('spawn claude EACCES') }), codex: adapter('codex', { cap: 'plain failure' }) }, cfg((x) => (x.review.independent_provider_required = false)));
    expect(c['claude.cli']!.summary).toBe('claude is not usable: spawn claude EACCES');
    expect(c['codex.cli']!.summary).toBe('codex is not usable: plain failure');
  });

  it('fails when the providers cannot be set up at all', async () => {
    const w = world();
    hooks.adapters = () => new Error('providers.claude.command must not be empty');
    hooks.config = () => cfg();
    const report = await runDoctor(w.ctx(), { probe: false });
    const c = report.checks.find((x) => x.id === 'providers')!;
    expect(c).toMatchObject({ status: 'fail', summary: 'providers.claude.command must not be empty', missing: 'valid provider settings', fix: 'fix providers in .orbit/config.yaml' });
    expect(report.checks.find((x) => x.id === 'models')?.status).toBeDefined();
  });
});

describe('provider credentials', () => {
  const only = (x: OrbitConfig) => {
    x.review.independent_provider_required = false;
    x.providers = { claude: x.providers.claude! };
  };

  it('says a credential is present but not verified until --probe, and valid once a live request confirmed it', async () => {
    const w = world();
    const unknown = await doctor(w, { claude: adapter('claude', { cred: { state: 'unknown', method: 'api_key', detail: 'ANTHROPIC_API_KEY is set' } }) }, cfg(only));
    expect(unknown['claude.auth']).toMatchObject({ status: 'pass', summary: 'claude credential present (api_key); not verified (use --probe for a live check)', details: ['method: api_key', 'ANTHROPIC_API_KEY is set'] });
    const nomethod = await doctor(w, { claude: adapter('claude', { cred: { state: 'unknown', method: null, detail: 'no method' } }) }, cfg(only));
    expect(nomethod['claude.auth']).toMatchObject({ summary: 'claude credential present (unknown method); not verified (use --probe for a live check)', details: ['method: unknown', 'no method'] });
    const valid = await doctor(w, { claude: adapter('claude') }, cfg(only));
    expect(valid['claude.auth']).toMatchObject({ summary: 'claude credential valid (api_key)' });
    const probed = await doctor(w, { claude: adapter('claude') }, cfg(only), { probe: true });
    expect(probed['claude.auth']).toMatchObject({ summary: 'claude credential valid (api_key), confirmed by a live request' });
    const liveUnknown = await doctor(w, { claude: adapter('claude', { probe: async () => ({ state: 'unknown', method: null, detail: 'timed out' }) }) }, cfg(only), { probe: true });
    expect(liveUnknown['claude.auth']!.summary).toBe('claude credential present (unknown method); not verified');
    const validNoMethod = await doctor(w, { claude: adapter('claude', { cred: { state: 'valid', method: null, detail: 'ok' } }) }, cfg(only));
    expect(validNoMethod['claude.auth']!.summary).toBe('claude credential valid (unknown method)');
  });

  it('reminds that an unattended service should use an API key when the login is a subscription', async () => {
    const w = world();
    const claudeAi = await doctor(w, { claude: adapter('claude', { cred: { state: 'valid', method: 'claude.ai', detail: 'logged in' } }) }, cfg(only));
    expect(claudeAi['claude.auth']!.details).toContain('unattended service runs should use API-key authentication (docs/decisions/0003-authentication.md); a subscription login is fine for foreground runs');
    const codex = await doctor(w, { claude: adapter('claude'), codex: adapter('codex', { cred: { state: 'valid', method: 'chatgpt', detail: 'logged in' } }) }, cfg((x) => (x.review.independent_provider_required = false)));
    expect(codex['codex.auth']!.details).toHaveLength(3);
    expect(codex['claude.auth']!.details).toHaveLength(2);
  });

  it('blocks on an expired, invalid or missing credential with the login command and the key alternative for that provider', async () => {
    const w = world();
    const claude = await doctor(w, { claude: adapter('claude', { cred: { state: 'expired', method: null, detail: 'token\nexpired' } }) }, cfg(only));
    expect(claude['claude.auth']).toMatchObject({
      status: 'fail',
      summary: 'claude credentials are expired: token expired',
      missing: 'a working claude credential',
      fix: 'claude auth login or set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN from "claude setup-token")',
    });
    const codex = await doctor(w, { claude: adapter('claude'), codex: adapter('codex', { cred: { state: 'missing', method: null, detail: 'not logged in' } }) }, cfg((x) => (x.review.independent_provider_required = false)));
    expect(codex['codex.auth']).toMatchObject({ status: 'warn', summary: 'codex credentials are missing: not logged in', missing: 'a working codex credential', fix: 'codex login or set CODEX_API_KEY' });
    const needed = await doctor(w, { claude: adapter('claude'), codex: adapter('codex', { cred: { state: 'invalid', method: null, detail: 'revoked' } }) }, cfg());
    expect(needed['codex.auth']?.status).toBe('fail');
  });

  it('says a credential could not be checked when the check itself failed, which is not a block', async () => {
    const w = world();
    const c = await doctor(w, { claude: adapter('claude', { cred: new Error('claude auth status timed out') }) }, cfg(only));
    expect(c['claude.auth']).toMatchObject({ status: 'fail', summary: 'claude credentials could not be checked: claude auth status timed out', missing: 'a claude credential check', fix: null });
    const codexWarn = await doctor(w, { claude: adapter('claude'), codex: adapter('codex', { cred: new Error('codex: boom') }) }, cfg((x) => (x.review.independent_provider_required = false)));
    expect(codexWarn['codex.auth']?.status).toBe('warn');
  });
});

describe('worker tier', () => {
  const only = (x: OrbitConfig) => {
    x.review.independent_provider_required = false;
    x.providers = { claude: x.providers.claude! };
  };

  it('is the strongest tier when a Claude credential is exported and the sandbox is in use', async () => {
    const w = world();
    const c = await doctor(w, { claude: adapter('claude') }, cfg((x) => { only(x); x.isolation = { ...x.isolation, provider: 'sandbox-runtime' }; }), { env: { ANTHROPIC_API_KEY: 'k' } });
    expect(c['claude.worker-tier']).toMatchObject({ status: 'pass', summary: expect.stringContaining('workers run in the os-sandbox tier (') });
  });

  it('is the claude-sandbox tier without an exported credential, saying why and what to do', async () => {
    const w = world();
    const c = await doctor(w, { claude: adapter('claude') }, cfg((x) => { only(x); x.isolation = { ...x.isolation, provider: 'sandbox-runtime' }; }), { env: { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined } });
    expect(c['claude.worker-tier']).toMatchObject({
      status: 'warn',
      summary: 'workers run in the claude-sandbox tier: no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the environment (a keychain login is invisible inside srt)',
      missing: 'an exported Claude credential plus sandbox-runtime for the strongest tier',
      fix: 'export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)',
    });
    expect(c['claude.worker-tier']!.details.length).toBeGreaterThan(0);
  });

  it('is also the claude-sandbox tier when the sandbox is not the isolation in use', async () => {
    const w = world();
    hooks.isolation = () => ({ kind: 'none', available: async () => ({ ok: true, detail: 'not isolated' }), wrap: () => ({}) as never });
    const c = await doctor(w, { claude: adapter('claude') }, cfg(only), { env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } });
    expect(c['claude.worker-tier']!.summary).toBe('workers run in the claude-sandbox tier: sandbox-runtime isolation is not in use');
    hooks.isolation = () => srt(false);
    const unavailable = await doctor(w, { claude: adapter('claude') }, cfg((x) => { only(x); x.isolation = { ...x.isolation, provider: 'sandbox-runtime' }; }), { env: { ANTHROPIC_API_KEY: 'k' } });
    expect(unavailable['claude.worker-tier']!.summary).toBe('workers run in the claude-sandbox tier: sandbox-runtime isolation is not in use');
  });
});

describe('independent review', () => {
  it('names the reviewer a run would choose, and the providers it would not use', async () => {
    const w = world();
    seedRegistry(w);
    const c = await doctor(w, { claude: adapter('claude'), codex: adapter('codex', { cred: { state: 'valid', method: 'api_key', detail: 'ok' } }) }, cfg());
    expect(c.review).toMatchObject({ status: 'pass', summary: expect.stringMatching(/^independent review: codex\/\S+ \(independent\)$/) });
    const alternatives = await doctor(w, { claude: adapter('claude'), codex: adapter('codex', { cap: { structuredOutput: false } }) }, cfg((x) => (x.review.independent_provider_required = false)));
    // Review by the implementer's own provider cannot be shown to use a different tier when the implementer's model is not fixed.
    expect(alternatives.review).toMatchObject({ status: 'warn' });
    expect(alternatives.review!.summary).toContain("same-provider review is allowed, but the implementer's model tier is unknown");
  });

  it('fails when an independent reviewer is required and none is usable, and only warns when it is not required', async () => {
    const w = world();
    seedRegistry(w);
    const required = await doctor(w, { claude: adapter('claude'), codex: adapter('codex', { cap: { available: false, version: null, detail: 'codex missing' } }) }, cfg());
    expect(required.review).toMatchObject({ status: 'fail', missing: 'a usable, data-policy-eligible reviewer from another provider' });
    expect(required.review!.summary).toMatch(/^independent review would block: independent review is required .*codex missing/);
    expect(required.review!.fix).toContain('data_policy_eligible: true');
    const optional = await doctor(w, { claude: adapter('claude'), codex: adapter('codex', { cap: { available: false, version: null, detail: 'codex missing' } }) }, cfg((x) => { x.review.independent_provider_required = false; x.review.fallback_same_provider_allowed = false; }));
    expect(optional.review).toMatchObject({ status: 'warn', missing: 'a usable, data-policy-eligible reviewer from another provider' });
    const blocked = await doctor(w, { claude: adapter('claude', { cap: { available: false, version: null, detail: 'gone' } }), codex: adapter('codex', { cap: { available: false, version: null, detail: 'gone' } }) }, cfg((x) => (x.review.independent_provider_required = false)));
    expect(blocked.review).toMatchObject({ status: 'warn' });
    expect(blocked.review!.summary).toMatch(/^independent review would block: /);
  });

  it('is not judged at all when review is optional and only Claude is configured', async () => {
    const w = world();
    const c = await doctor(w, { claude: adapter('claude') }, cfg((x) => { x.review.independent_provider_required = false; x.providers = { claude: x.providers.claude! }; }));
    expect(c.review).toBeUndefined();
  });
});

describe('models', () => {
  const only = (x: OrbitConfig) => {
    x.review.independent_provider_required = false;
    x.providers = { claude: x.providers.claude! };
  };

  it('lists each Claude model as eligible or excluded, with the reason, and passes when at least one can be used', async () => {
    const w = world();
    const c = await doctor(w, { claude: adapter('claude', { cap: { version: '2.1.282' } }) }, cfg((x) => { only(x); x.routing.allowed_models = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude:*']; }));
    expect(c.models).toMatchObject({ status: 'pass', summary: '2 Claude model(s) eligible under the policy' });
    const d = c.models!.details.join('\n');
    expect(d).toContain('claude-opus-5-5: eligible, unvalidated (validated on first use, or "orbit models refresh --probe")');
    expect(d).toContain('claude-sonnet-5-5: excluded, needs claude >= 2.1.284, installed 2.1.282');
    expect(d).toContain('claude-haiku-4-5-20251001: eligible, unvalidated');
    expect(d).toContain('claude-fable-5-1: excluded, needs an explicit routing.allowed_models entry');
  });

  it('shows a model a check marked unavailable, and one that was validated', async () => {
    const w = world();
    seedRegistry(w, (r) => {
      r.markAvailability('claude-sonnet-5-5', 'claude-cli', true, 'observed');
      r.markAvailability('claude-opus-5-5', 'claude-cli', false, 'org policy blocks it');
      r.markAvailability('claude-haiku-4-5-20251001', 'claude-cli', false, null as never);
    });
    const c = await doctor(w, { claude: adapter('claude') }, cfg(only));
    const d = c.models!.details.join('\n');
    expect(d).toContain('claude-sonnet-5-5: eligible, validated');
    expect(d).toContain('claude-opus-5-5: excluded, unavailable: org policy blocks it');
    expect(d).toContain('claude-haiku-4-5-20251001: excluded, unavailable: a check said so');
  });

  it('fails when no allowed model can be used', async () => {
    const w = world();
    const c = await doctor(w, { claude: adapter('claude') }, cfg((x) => { only(x); x.routing.allowed_models = ['codex:*']; }));
    expect(c.models).toMatchObject({ status: 'fail', summary: 'no allowed Claude model is eligible', missing: 'at least one routing.allowed_models entry that the installed claude CLI can run' });
    expect(c.models!.fix).toContain('allow sonnet, opus or haiku');
  });

  it('with --probe asks one tiny question per eligible model, through the CLI alias, and reports the answer', async () => {
    const w = world();
    const asked: string[] = [];
    const probe = async ({ model }: { model?: string }): Promise<CredentialStatus> => {
      asked.push(String(model));
      if (model === 'opus') throw new Error('probe crashed');
      return model === 'haiku' ? { state: 'unknown', method: null, detail: 'rate   limited\nlater' } : { state: 'valid', method: 'api_key', detail: 'ok' };
    };
    const c = await doctor(w, { claude: adapter('claude', { probe }) }, cfg(only), { probe: true });
    const d = c.models!.details.join('\n');
    // The credential check asks once with no model; each eligible model is then asked by its alias.
    expect(asked.filter((m) => m !== 'undefined').sort()).toEqual(['haiku', 'opus', 'sonnet']);
    expect(d).toContain('claude-sonnet-5-5: eligible, unvalidated (validated on first use, or "orbit models refresh --probe"); live probe answered');
    expect(d).toContain('claude-haiku-4-5-20251001: eligible, unvalidated (validated on first use, or "orbit models refresh --probe"); live probe inconclusive (unknown: rate limited later)');
    expect(d).toContain('live probe inconclusive (unknown: probe crashed)');
    const plain = await doctor(w, { claude: adapter('claude', { probe }) }, cfg(only), { probe: false });
    expect(plain.models!.details.join('\n')).not.toContain('live probe');
  });

  it('does not probe when the credential is already known to be bad, or the adapter has no probe', async () => {
    const w = world();
    const asked: string[] = [];
    // The live credential check already found the login expired, so no model is asked.
    const probe = async ({ model }: { model?: string }): Promise<CredentialStatus> => (asked.push(String(model)), { state: 'expired', method: null, detail: 'login expired' });
    const expired = await doctor(w, { claude: adapter('claude', { probe }) }, cfg(only), { probe: true });
    expect(asked.filter((m) => m !== 'undefined')).toEqual([]);
    expect(expired.models!.details.join('\n')).not.toContain('live probe');
    const noProbe = await doctor(w, { claude: adapter('claude', { probe: null }) }, cfg(only), { probe: true });
    expect(noProbe.models!.details.join('\n')).not.toContain('live probe');
  });

  it('looks through a wrapper that exposes the real adapter as inner', async () => {
    const w = world();
    const asked: string[] = [];
    const inner = adapter('claude', { probe: async ({ model }) => (asked.push(String(model)), { state: 'valid', method: 'api_key', detail: '' }) });
    const wrapped = { ...adapter('claude', { probe: null }), inner } as unknown as ProviderAdapter;
    const c = await doctor(w, { claude: wrapped }, cfg((x) => { only(x); x.routing.allowed_models = ['claude-sonnet-5-5']; }), { probe: true });
    expect(asked.filter((m) => m !== 'undefined')).toEqual(['sonnet']);
    expect(c.models!.details.join('\n')).toContain('live probe answered');
  });

  it('takes the installed version from any adapter that reports itself as Claude, and ignores an unknown one', async () => {
    const w = world();
    const alias = await doctor(w, { 'claude-work': adapter('claude-work', { cap: { provider: 'claude-work', version: '2.1.270' } }) }, cfg((x) => { x.review.independent_provider_required = false; x.providers = { 'claude-work': { ...x.providers.claude! } }; }));
    expect(alias.models!.details.join('\n')).toContain('claude-sonnet-5-5: excluded, needs claude >= 2.1.284, installed 2.1.270');
    const odd = await doctor(w, { claude: adapter('claude', { cap: { provider: 'mystery', version: '1.0.0' } }) }, cfg(only));
    expect(odd.models!.details.join('\n')).not.toContain('needs claude >=');
  });
});
