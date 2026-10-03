import { describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { ContainerIsolation, NoIsolation, SandboxRuntimeIsolation, getIsolation, isUnattended, requireAvailable } from '../../../src/isolation/index.ts';
import type { IsolationProvider, SandboxProfile } from '../../../src/isolation/types.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';

const profile: SandboxProfile = {
  writablePaths: ['/w'],
  denyReadPaths: ['/home/acme/.ssh', '/home/acme/.aws'],
  allowedHosts: ['registry.npmjs.org'],
  limits: { timeoutMs: 1, memoryMb: 256, cpus: 1, pids: 10 },
};

function isolationConfig(over: Partial<OrbitConfig['isolation']> = {}): OrbitConfig['isolation'] {
  return { provider: 'sandbox-runtime', allow_unisolated: false, container: null, ...over };
}

describe('NoIsolation', () => {
  it('wraps nothing and lists every missing protection', async () => {
    const env = { PATH: '/bin' };
    const argv = ['npm', 'test'];
    const w = new NoIsolation().wrap(argv, profile, { cwd: '/w', env });
    expect(w.argv).toEqual(argv);
    expect(w.argv).not.toBe(argv);
    expect(w.env).toEqual(env);
    expect(w.env).not.toBe(env);
    expect(() => w.cleanup()).not.toThrow();
    const text = w.limitations.join('\n');
    for (const missing of [/No filesystem write restriction/, /No read restriction: none of the 2 denied/, /No network restriction.*only registry\.npmjs\.org/, /No CPU, memory or process-count limits/, /No wall-clock enforcement/, /SSH agent, Docker/]) {
      expect(text).toMatch(missing);
    }
    expect((await new NoIsolation().available()).ok).toBe(true);
    expect(() => new NoIsolation().wrap([], profile, { cwd: '/w', env })).toThrow(/non-empty/);
  });
});

describe('getIsolation', () => {
  it('builds the configured provider', () => {
    expect(getIsolation(isolationConfig(), { orbitInstallDir: '/opt/orbit', mode: 'autonomous' })).toBeInstanceOf(SandboxRuntimeIsolation);
    const c = getIsolation(isolationConfig({ provider: 'container', container: { image: 'acme/check:1', memory_mb: 512, cpus: 1, pids: 64 } }), {
      orbitInstallDir: '/opt/orbit',
      mode: 'autonomous',
    });
    expect(c).toBeInstanceOf(ContainerIsolation);
    expect((c as ContainerIsolation).image).toBe('acme/check:1');
    expect((getIsolation(isolationConfig({ provider: 'container' }), { orbitInstallDir: '/opt/orbit' }) as ContainerIsolation).image).toBe('orbit-check:node22');
  });

  it("refuses 'none' for every unattended mode, and when the mode is unknown", () => {
    for (const mode of ['autonomous', 'autonomous-delivery', 'release', undefined] as const) {
      let caught: unknown;
      try {
        getIsolation(isolationConfig({ provider: 'none' }), { orbitInstallDir: '/opt/orbit', mode });
      } catch (err) {
        caught = err;
      }
      expect(isOrbitError(caught, 'ISOLATION_UNAVAILABLE'), String(mode)).toBe(true);
      expect((caught as { details?: { rule?: string } }).details?.rule).toBe('isolation.allow_unisolated');
    }
  });

  it("allows 'none' when supervised or explicitly allowed", () => {
    expect(getIsolation(isolationConfig({ provider: 'none' }), { orbitInstallDir: '/opt/orbit', mode: 'supervised' })).toBeInstanceOf(NoIsolation);
    expect(getIsolation(isolationConfig({ provider: 'none', allow_unisolated: true }), { orbitInstallDir: '/opt/orbit', mode: 'release' })).toBeInstanceOf(NoIsolation);
    expect(isUnattended('supervised')).toBe(false);
    expect(isUnattended('autonomous-delivery')).toBe(true);
  });

  it('rejects an unknown provider name as a configuration error', () => {
    let caught: unknown;
    try {
      getIsolation(isolationConfig({ provider: 'chroot' as never }), { orbitInstallDir: '/opt/orbit', mode: 'supervised' });
    } catch (err) {
      caught = err;
    }
    expect(isOrbitError(caught, 'CONFIG_INVALID')).toBe(true);
  });
});

describe('requireAvailable', () => {
  function stub(ok: boolean): IsolationProvider {
    return { kind: 'sandbox-runtime', available: async () => ({ ok, detail: ok ? 'fine' : 'srt missing' }), wrap: () => { throw new Error('unused'); } };
  }

  it('blocks on an unavailable provider instead of degrading', async () => {
    await expect(requireAvailable(stub(false))).rejects.toMatchObject({ code: 'ISOLATION_UNAVAILABLE', message: 'sandbox-runtime isolation is unavailable: srt missing' });
    await expect(requireAvailable(stub(true))).resolves.toBe('fine');
  });
});
