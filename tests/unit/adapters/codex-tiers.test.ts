import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import type { TaskHandle, TaskSpec } from '../../../src/adapters/types.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { isWithin, type IsolationProfile } from '../../../src/isolation/util.ts';
import type { CodexTaskHandle, CodexTierSetting } from '../../../src/adapters/codex.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import { implementerSpec, makeFixture, type Fixture } from '../../integration/adapters/helpers.ts';

/**
 * The Codex reviewer tiers (ADR 0001, "Codex reviewer tiers"): inside srt,
 * srt is the only sandbox and Codex runs with --sandbox danger-full-access;
 * without srt, Codex runs unwrapped under its own --sandbox read-only. The
 * flag is never passed in any other combination. Which tier a run gets is
 * chosen by login type (the last describes, "Second live finding"); the tests
 * of one tier's mechanics give the worker an API key, so `auto` picks srt.
 */
const supMock = vi.hoisted(() => ({ launchShim: vi.fn(), reattachLaunch: vi.fn(), cancelShim: vi.fn() }));
vi.mock('../../../src/adapters/supervise.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/adapters/supervise.ts')>()), ...supMock }));

const { CodexAdapter } = await import('../../../src/adapters/codex.ts');
const { createAdapter } = await import('../../../src/adapters/index.ts');

/** An API key in the worker environment: with one, `auto` puts Codex under srt (the tests below that follow a ChatGPT login leave it out). */
const ACME_KEY = 'sk-acme-test-0000';
const KEYED = { CODEX_API_KEY: ACME_KEY };
const SRT = '/opt/acme/node_modules/.bin/srt';
const SETTINGS = '/tmp/orbit-srt-t1/settings.json';
type Wrap = (argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }) => WrappedCommand;

const fixtures: Fixture[] = [];
function fixture(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}

const homeOf = (f: Fixture) => join(f.base, 'home');
const codexHomeOf = (f: Fixture) => join(homeOf(f), '.codex-reviewer');

function handleFor(workerDir: string, workerId: string): TaskHandle {
  return { provider: 'codex', workerId, workerDir, pid: 4242, pgid: 4242, procStart: null, logPath: join(workerDir, 'log.jsonl'), exitPath: join(workerDir, 'exit.json') };
}

beforeEach(() => {
  supMock.launchShim.mockReset().mockImplementation(async (input: { workerDir: string; workerId: string }) => handleFor(input.workerDir, input.workerId));
  supMock.reattachLaunch.mockReset();
  supMock.cancelShim.mockReset();
});
afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f.base, { recursive: true, force: true });
});

/** A sandbox-runtime stand-in: wrap() puts the command after `srt --settings <file> --`, like the real one. */
function srt(opts: { available?: () => Promise<{ ok: boolean; detail: string }>; wrap?: Wrap } = {}) {
  const defaultWrap: Wrap = (argv, _profile, o) => ({ argv: [SRT, '--settings', SETTINGS, '--', ...argv], env: { ...o.env, WRAPPED: '1' }, cleanup() {}, limitations: ['srt limitation'] });
  return {
    kind: 'sandbox-runtime' as const,
    available: vi.fn(opts.available ?? (async () => ({ ok: true, detail: 'srt 0.0.78' }))),
    wrap: vi.fn(opts.wrap ?? defaultWrap),
  };
}

/** A provider that is not sandbox-runtime. */
function other(kind: 'none' | 'container') {
  return { kind, available: vi.fn(async () => ({ ok: true, detail: 'ok' })), wrap: vi.fn<Wrap>() };
}

function adapter(f: Fixture, isolation: IsolationProvider | null, env: Record<string, string> = {}, tier?: CodexTierSetting) {
  return new CodexAdapter({ command: ['codex'], baseEnv: { PATH: '/usr/bin', HOME: homeOf(f), CODEX_HOME: codexHomeOf(f), ...env }, shimCommand: ['node', 'shim'], clock: new ManualClock(), isolation, ...(tier ? { tier } : {}) });
}

/** A reviewer task whose generic worker profile is wider than the reviewer may have: the adapter must narrow it. */
function spec(f: Fixture): TaskSpec {
  const base = implementerSpec(f, { role: 'reviewer', readOnly: true, model: 'codex-alpha', effort: 'high' }) as TaskSpec;
  const sandbox: IsolationProfile = {
    writablePaths: [f.repo, f.workerDir, join(f.base, 'tmp-worker'), codexHomeOf(f)],
    denyReadPaths: [join(f.base, 'secrets')],
    allowedHosts: ['api.openai.com', 'chatgpt.com', 'registry.npmjs.org'],
    limits: { timeoutMs: 60_000, memoryMb: null, cpus: null, pids: null },
    readablePaths: [join(f.workerDir, 'prompt.md')],
  };
  return { ...base, sandbox };
}

const sandboxFlag = (argv: string[]): string | undefined => argv[argv.indexOf('--sandbox') + 1];

interface Launch {
  argv: string[];
  env: Record<string, string>;
  meta: { tier: string; limitations: string[] };
  cleanupPaths: string[];
}
const launched = (n = 0): Launch => supMock.launchShim.mock.calls[n]![0] as Launch;

describe('os-sandbox tier: srt is the only sandbox around Codex', () => {
  it('runs Codex with --sandbox danger-full-access inside srt', async () => {
    const f = fixture();
    const iso = srt();
    const handle = await adapter(f, iso, KEYED).startTask(spec(f));
    expect(handle.tier).toBe('os-sandbox');
    const inner = iso.wrap.mock.calls[0]![0];
    expect(sandboxFlag(inner)).toBe('danger-full-access');
    expect(inner.filter((a) => a === '--sandbox')).toHaveLength(1);
    expect(inner).not.toContain('read-only');
    // What is launched is the wrapped command, and the wrapper comes first.
    expect(launched().argv.slice(0, 4)).toEqual([SRT, '--settings', SETTINGS, '--']);
    expect(launched().argv.slice(-inner.length)).toEqual(inner);
    expect(launched().meta.tier).toBe('os-sandbox');
    expect(launched().cleanupPaths).toEqual(['/tmp/orbit-srt-t1']);
  });

  it('gives srt a profile that writes only the worker directory and Codex state, never the review checkout', async () => {
    const f = fixture();
    const iso = srt();
    await adapter(f, iso, KEYED).startTask(spec(f));
    const [, profile, opts] = iso.wrap.mock.calls[0]!;
    const writable = profile.writablePaths;
    expect(writable).toEqual([f.workerDir, codexHomeOf(f)]);
    expect(writable.some((p) => isWithin(f.repo, p) || isWithin(p, f.repo))).toBe(false);
    // The checkout is readable (it may sit under a denied directory), and the caller's own denials survive.
    const readable = (profile as IsolationProfile).readablePaths ?? [];
    expect(readable).toContain(f.repo);
    expect(readable).toContain(join(f.workerDir, 'prompt.md'));
    expect(profile.denyReadPaths).toContain(join(f.base, 'secrets'));
    // The command's temp directory is inside the worker directory, so it needs no write access of its own.
    expect(opts.env.CODEX_HOME).toBe(codexHomeOf(f));
    expect(isWithin(opts.env.TMPDIR!, f.workerDir)).toBe(true);
    expect(opts.cwd).toBe(f.repo);
  });

  it('reaches only the provider hosts, not the hosts the policy allows for implementers', async () => {
    const f = fixture();
    const iso = srt();
    await adapter(f, iso, KEYED).startTask(spec(f));
    expect(iso.wrap.mock.calls[0]![1].allowedHosts).toEqual(['api.openai.com', 'chatgpt.com']);
  });

  it('records that srt is the only sandbox, and no longer claims an unverified nested Codex sandbox', async () => {
    const f = fixture();
    const handle = await adapter(f, srt(), KEYED).startTask(spec(f));
    const text = handle.limitations.join('\n');
    expect(text).toContain('srt limitation');
    expect(text).toMatch(/srt is the only sandbox/);
    expect(text).toMatch(/danger-full-access/);
    expect(text).not.toMatch(/inside srt is unverified/);
    expect(launched().meta.limitations).toEqual(handle.limitations);
  });

  it('uses ~/.codex when CODEX_HOME is not set', async () => {
    const f = fixture();
    const iso = srt();
    const a = new CodexAdapter({ command: ['codex'], baseEnv: { PATH: '/usr/bin', HOME: homeOf(f), ...KEYED }, shimCommand: ['node', 'shim'], clock: new ManualClock(), isolation: iso });
    await a.startTask(spec(f));
    expect(iso.wrap.mock.calls[0]![1].writablePaths).toEqual([f.workerDir, join(homeOf(f), '.codex')]);
  });

  it('resolves the home directory from the account when HOME is not set', async () => {
    const f = fixture();
    const iso = srt();
    const a = new CodexAdapter({ command: ['codex'], baseEnv: { PATH: '/usr/bin', CODEX_HOME: codexHomeOf(f), ...KEYED }, shimCommand: ['node', 'shim'], clock: new ManualClock(), isolation: iso });
    await a.startTask(spec(f));
    expect(iso.wrap.mock.calls[0]![1].writablePaths).toEqual([f.workerDir, codexHomeOf(f)]);
  });

  it('refuses a Codex state directory that would hand over the checkout or the home directory, or is not absolute', async () => {
    const f = fixture();
    const outcome = async (codexHome: string): Promise<string | undefined> => {
      const iso = srt();
      const err = await adapter(f, iso, { ...KEYED, CODEX_HOME: codexHome })
        .startTask(spec(f))
        .then(
          () => null,
          (e: { code?: string }) => e,
        );
      expect(iso.wrap).not.toHaveBeenCalled();
      return err?.code;
    };
    expect(await outcome(f.repo)).toBe('ISOLATION_UNAVAILABLE');
    expect(await outcome(join(f.repo, '.codex'))).toBe('ISOLATION_UNAVAILABLE');
    expect(await outcome(homeOf(f))).toBe('ISOLATION_UNAVAILABLE');
    expect(await outcome('.codex')).toBe('CONFIG_INVALID');
    expect(supMock.launchShim).not.toHaveBeenCalled();
  });
});

describe('codex-sandbox tier: no srt, Codex runs under its own read-only sandbox', () => {
  const cases: [string, () => IsolationProvider | null, RegExp | null][] = [
    ['no isolation provider', () => null, null],
    ['the none provider', () => other('none'), null],
    ['the container provider, which is not verified around Codex', () => other('container'), /container/],
    ['an srt that cannot start here', () => srt({ available: async () => ({ ok: false, detail: 'sandbox-exec is missing' }) }), /sandbox-exec is missing/],
  ];

  it.each(cases)('runs unwrapped with --sandbox read-only and records unrestricted reads: %s', async (_name, make, why) => {
    const f = fixture();
    const iso = make();
    const handle = await adapter(f, iso, KEYED).startTask(spec(f));
    expect(handle.tier).toBe('codex-sandbox');
    if (iso) expect(iso.wrap).not.toHaveBeenCalled();
    const argv = launched().argv;
    expect(argv[0]).toBe('codex');
    expect(sandboxFlag(argv)).toBe('read-only');
    expect(argv).not.toContain('danger-full-access');
    expect(launched().cleanupPaths).toEqual([]);
    const text = handle.limitations.join('\n');
    expect(text).toMatch(/reads are unrestricted/i);
    expect(text).toMatch(/No OS isolation/);
    if (why) expect(text).toMatch(why);
    expect(launched().meta).toMatchObject({ tier: 'codex-sandbox', limitations: handle.limitations });
  });
});

describe('danger-full-access is refused outside the srt wrapper', () => {
  it('refuses a sandbox-runtime provider whose wrap() returned the command unwrapped', async () => {
    const f = fixture();
    const cleanup = vi.fn();
    const iso = srt({ wrap: (argv, _profile, o) => ({ argv, env: o.env, cleanup, limitations: [] }) });
    await expect(adapter(f, iso, KEYED).startTask(spec(f))).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining('danger-full-access') });
    expect(supMock.launchShim).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });

  it('refuses a wrapper that dropped the command it was given', async () => {
    const f = fixture();
    const iso = srt({ wrap: (_argv, _profile, o) => ({ argv: [SRT, '--settings', SETTINGS, '--', 'codex'], env: o.env, cleanup() {}, limitations: [] }) });
    await expect(adapter(f, iso, KEYED).startTask(spec(f))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(supMock.launchShim).not.toHaveBeenCalled();
  });

  it('launches it only wrapped by srt, whichever isolation provider is configured', async () => {
    const providers: (IsolationProvider | null)[] = [null, other('none'), other('container'), srt({ available: async () => ({ ok: false, detail: 'no' }) }), srt()];
    const seen: string[] = [];
    for (const [i, iso] of providers.entries()) {
      const f = fixture();
      await adapter(f, iso, KEYED).startTask(spec(f));
      const argv = launched(i).argv;
      const dangerous = argv.includes('danger-full-access');
      const wrapped = argv[0] === SRT;
      seen.push(`${iso?.kind ?? 'null'}:${dangerous ? 'danger-full-access' : sandboxFlag(argv)}:${wrapped ? 'srt' : 'bare'}`);
      // The invariant: the dangerous mode appears exactly when srt wraps the command.
      expect(dangerous).toBe(wrapped);
    }
    expect(seen).toEqual(['null:read-only:bare', 'none:read-only:bare', 'container:read-only:bare', 'sandbox-runtime:read-only:bare', 'sandbox-runtime:danger-full-access:srt']);
  });

  it('probes srt once per adapter, not once per task', async () => {
    const f = fixture();
    const g = fixture();
    const iso = srt();
    const a = adapter(f, iso, KEYED);
    await a.startTask(spec(f));
    await a.startTask(spec(g));
    expect(iso.available).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ADR 0001, "Second live finding": the tier is chosen by login type. Inside
// srt Codex cannot use a ChatGPT login ("workspace routing discovery failed"),
// so srt is only used when an API key is in the worker environment.

const API_KEYS = ['CODEX_API_KEY', 'OPENAI_API_KEY'] as const;

describe('auto: the login type chooses the tier', () => {
  it('runs a ChatGPT login (no API key) unwrapped even though srt is available, and records why', async () => {
    const f = fixture();
    const iso = srt();
    const handle = await adapter(f, iso).startTask(spec(f));
    expect(handle.tier).toBe('codex-sandbox');
    // srt is neither used nor probed: nothing it said could change the answer.
    expect(iso.wrap).not.toHaveBeenCalled();
    expect(iso.available).not.toHaveBeenCalled();
    const argv = launched().argv;
    expect(argv[0]).toBe('codex');
    expect(sandboxFlag(argv)).toBe('read-only');
    expect(argv).not.toContain('danger-full-access');
    expect(launched().cleanupPaths).toEqual([]);
    const text = handle.limitations.join('\n');
    expect(text).toMatch(/reads are unrestricted/i);
    expect(text).toMatch(/ChatGPT login cannot run under srt/);
    expect(text).toMatch(/CODEX_API_KEY or OPENAI_API_KEY/);
    expect(launched().meta).toMatchObject({ tier: 'codex-sandbox', limitations: handle.limitations });
  });

  it('runs an API key in either variable inside srt, and the key reaches the worker environment', async () => {
    for (const [i, name] of API_KEYS.entries()) {
      const f = fixture();
      const iso = srt();
      const handle = await adapter(f, iso, { [name]: ACME_KEY }).startTask(spec(f));
      expect(handle.tier, name).toBe('os-sandbox');
      expect(sandboxFlag(iso.wrap.mock.calls[0]![0]), name).toBe('danger-full-access');
      expect(launched(i).env[name], name).toBe(ACME_KEY);
      expect(handle.limitations.join('\n'), name).not.toMatch(/ChatGPT/);
    }
  });

  it('treats a blank key as no key', async () => {
    for (const env of [{ CODEX_API_KEY: '' }, { OPENAI_API_KEY: '   ' }] as Record<string, string>[]) {
      const f = fixture();
      const iso = srt();
      expect((await adapter(f, iso, env).startTask(spec(f))).tier, JSON.stringify(env)).toBe('codex-sandbox');
      expect(iso.wrap).not.toHaveBeenCalled();
    }
  });

  it('judges the key by the environment the worker will really get, task overrides included', async () => {
    const f = fixture();
    const g = fixture();
    const blanked = srt();
    const base = adapter(f, blanked, { CODEX_API_KEY: ACME_KEY });
    expect((await base.startTask({ ...spec(f), env: { ...spec(f).env, CODEX_API_KEY: '' } })).tier).toBe('codex-sandbox');
    expect(blanked.wrap).not.toHaveBeenCalled();
    const supplied = srt();
    expect((await adapter(g, supplied).startTask({ ...spec(g), env: { ...spec(g).env, OPENAI_API_KEY: ACME_KEY } })).tier).toBe('os-sandbox');
    expect(supplied.wrap).toHaveBeenCalledTimes(1);
  });

  it('with an API key but no usable srt, falls back to codex-sandbox and says why', async () => {
    const f = fixture();
    const iso = srt({ available: async () => ({ ok: false, detail: 'sandbox-exec is missing' }) });
    const handle = await adapter(f, iso, { CODEX_API_KEY: ACME_KEY }).startTask(spec(f));
    expect(handle.tier).toBe('codex-sandbox');
    expect(handle.limitations.join('\n')).toMatch(/sandbox-exec is missing/);
    expect(iso.available).toHaveBeenCalledTimes(1);
  });
});

describe('an explicit tier overrides the login type', () => {
  const unusable: [string, () => IsolationProvider | null][] = [
    ['no isolation provider', () => null],
    ['the none provider', () => other('none')],
    ['the container provider, which is not used around Codex', () => other('container')],
    ['an srt that cannot start here', () => srt({ available: async () => ({ ok: false, detail: 'sandbox-exec is missing' }) })],
  ];

  it.each(unusable)('os-sandbox without a usable srt fails closed with ISOLATION_UNAVAILABLE and launches nothing: %s', async (_name, make) => {
    const f = fixture();
    const iso = make();
    // An API key does not help: the user asked for srt and there is none.
    const err = await adapter(f, iso, { CODEX_API_KEY: ACME_KEY }, 'os-sandbox')
      .startTask(spec(f))
      .then(
        () => null,
        (e: { code?: string; message?: string }) => e,
      );
    expect(err?.code).toBe('ISOLATION_UNAVAILABLE');
    expect(err?.message).toMatch(/providers\.codex\.tier/);
    expect(supMock.launchShim).not.toHaveBeenCalled();
    expect(existsSync(join(f.workerDir, 'prompt.md'))).toBe(false);
    if (iso) expect(iso.wrap).not.toHaveBeenCalled();
  });

  it('os-sandbox with srt runs under srt even with a ChatGPT login, and records that this may not work', async () => {
    const f = fixture();
    const iso = srt();
    const handle = await adapter(f, iso, {}, 'os-sandbox').startTask(spec(f));
    expect(handle.tier).toBe('os-sandbox');
    expect(sandboxFlag(iso.wrap.mock.calls[0]![0])).toBe('danger-full-access');
    const text = handle.limitations.join('\n');
    expect(text).toMatch(/ChatGPT login cannot run under srt/);
    expect(text).toMatch(/providers\.codex\.tier/);
  });

  it('codex-sandbox never wraps, with srt available and an API key set, and does not probe srt', async () => {
    const f = fixture();
    const iso = srt();
    const handle = await adapter(f, iso, { CODEX_API_KEY: ACME_KEY }, 'codex-sandbox').startTask(spec(f));
    expect(handle.tier).toBe('codex-sandbox');
    expect(iso.wrap).not.toHaveBeenCalled();
    expect(iso.available).not.toHaveBeenCalled();
    expect(sandboxFlag(launched().argv)).toBe('read-only');
    expect(launched().argv).not.toContain('danger-full-access');
    const text = handle.limitations.join('\n');
    expect(text).toMatch(/reads are unrestricted/i);
    expect(text).toMatch(/providers\.codex\.tier/);
  });

  it('keeps the guard in every combination: danger-full-access appears exactly when srt wraps the command', async () => {
    const isolations: [string, () => IsolationProvider | null][] = [
      ['null', () => null],
      ['none', () => other('none')],
      ['container', () => other('container')],
      ['srt-down', () => srt({ available: async () => ({ ok: false, detail: 'no' }) })],
      ['srt', () => srt()],
    ];
    const keys: [string, Record<string, string>][] = [['chatgpt', {}], ['api-key', { OPENAI_API_KEY: ACME_KEY }]];
    const seen: Record<string, string> = {};
    let n = 0;
    for (const setting of ['auto', 'os-sandbox', 'codex-sandbox'] as const) {
      for (const [isoName, make] of isolations) {
        for (const [keyName, env] of keys) {
          const f = fixture();
          const label = `${setting}/${isoName}/${keyName}`;
          const outcome = await adapter(f, make(), env, setting)
            .startTask(spec(f))
            .then(
              (h) => {
                const argv = launched(n++).argv;
                const dangerous = argv.includes('danger-full-access');
                expect(dangerous, label).toBe(argv[0] === SRT);
                return `${h.tier}:${dangerous ? 'danger-full-access' : sandboxFlag(argv)}`;
              },
              (e: { code?: string }) => e.code ?? 'error',
            );
          seen[label] = outcome;
        }
      }
    }
    const srtRuns = 'os-sandbox:danger-full-access';
    const bare = 'codex-sandbox:read-only';
    expect(seen).toEqual({
      'auto/null/chatgpt': bare, 'auto/null/api-key': bare,
      'auto/none/chatgpt': bare, 'auto/none/api-key': bare,
      'auto/container/chatgpt': bare, 'auto/container/api-key': bare,
      'auto/srt-down/chatgpt': bare, 'auto/srt-down/api-key': bare,
      'auto/srt/chatgpt': bare, 'auto/srt/api-key': srtRuns,
      'os-sandbox/null/chatgpt': 'ISOLATION_UNAVAILABLE', 'os-sandbox/null/api-key': 'ISOLATION_UNAVAILABLE',
      'os-sandbox/none/chatgpt': 'ISOLATION_UNAVAILABLE', 'os-sandbox/none/api-key': 'ISOLATION_UNAVAILABLE',
      'os-sandbox/container/chatgpt': 'ISOLATION_UNAVAILABLE', 'os-sandbox/container/api-key': 'ISOLATION_UNAVAILABLE',
      'os-sandbox/srt-down/chatgpt': 'ISOLATION_UNAVAILABLE', 'os-sandbox/srt-down/api-key': 'ISOLATION_UNAVAILABLE',
      'os-sandbox/srt/chatgpt': srtRuns, 'os-sandbox/srt/api-key': srtRuns,
      'codex-sandbox/null/chatgpt': bare, 'codex-sandbox/null/api-key': bare,
      'codex-sandbox/none/chatgpt': bare, 'codex-sandbox/none/api-key': bare,
      'codex-sandbox/container/chatgpt': bare, 'codex-sandbox/container/api-key': bare,
      'codex-sandbox/srt-down/chatgpt': bare, 'codex-sandbox/srt-down/api-key': bare,
      'codex-sandbox/srt/chatgpt': bare, 'codex-sandbox/srt/api-key': bare,
    });
  });
});

describe('providers.<id>.tier reaches the adapter', () => {
  const codexCfg = (tier: CodexTierSetting) => ({ ...defaultConfig().providers.codex!, tier });

  it('createAdapter passes the configured tier to the Codex adapter, for codex and codex-<name> ids', async () => {
    for (const id of ['codex', 'codex-review']) {
      const f = fixture();
      const iso = srt();
      const a = createAdapter(id, codexCfg('codex-sandbox'), { isolation: iso, baseEnv: { PATH: '/usr/bin', HOME: homeOf(f), CODEX_HOME: codexHomeOf(f), CODEX_API_KEY: ACME_KEY }, shimCommand: ['node', 'shim'], clock: new ManualClock() });
      expect(((await a.startTask(spec(f))) as CodexTaskHandle).tier, id).toBe('codex-sandbox');
      expect(iso.wrap, id).not.toHaveBeenCalled();
      expect(sandboxFlag(launched(supMock.launchShim.mock.calls.length - 1).argv), id).toBe('read-only');
    }
  });

  it('a config without a tier (an older snapshot) behaves as auto', async () => {
    const f = fixture();
    const iso = srt();
    const { tier: _tier, ...noTier } = codexCfg('auto');
    const a = createAdapter('codex', noTier, { isolation: iso, baseEnv: { PATH: '/usr/bin', HOME: homeOf(f), CODEX_HOME: codexHomeOf(f), CODEX_API_KEY: ACME_KEY }, shimCommand: ['node', 'shim'], clock: new ManualClock() });
    expect(((await a.startTask(spec(f))) as CodexTaskHandle).tier).toBe('os-sandbox');
  });

  it('the codex fake takes the tier from the config too', async () => {
    const f = fixture();
    const a = createAdapter('codex', { ...codexCfg('os-sandbox'), command: '/opt/acme/tests/fakes/fake-codex.mjs' }, { isolation: null, baseEnv: { PATH: '/usr/bin', HOME: homeOf(f) }, shimCommand: ['node', 'shim'], clock: new ManualClock() });
    await expect(a.startTask(spec(f))).rejects.toMatchObject({ code: 'ISOLATION_UNAVAILABLE' });
  });
});
