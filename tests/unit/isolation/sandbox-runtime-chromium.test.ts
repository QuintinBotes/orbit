// wrap() for UI checks on macOS: with SandboxProfile.chromiumMachRendezvous set, srt's CLI runs under node with the
// Orbit preload that adds Chromium's two Mach rendezvous rules (docs/decisions/0001-runtime-choices.md). Built from fake
// files, so these run the same on macOS and Linux.
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import {
  CHROMIUM_MACH_RENDEZVOUS,
  CHROMIUM_MACH_RENDEZVOUS_LIMITATION,
  PRELOAD_REFUSAL_FILE,
  SRT_VERIFIED_VERSION,
  SandboxRuntimeIsolation,
  defaultChromiumPreloadPath,
  srtPackageOf,
} from '../../../src/isolation/sandbox-runtime.ts';
import type { SandboxProfile } from '../../../src/isolation/types.ts';
import { tempRoot, writeExecutable } from './fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function profile(over: Partial<SandboxProfile> = {}): SandboxProfile {
  return { writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 60_000, memoryMb: null, cpus: null, pids: null }, ...over };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? `${err.code}: ${err.message}` : `non-orbit: ${String(err)}`;
  }
  return undefined;
}

/** An installed srt package (package.json, dist/cli.js), a bin link to it, a node, a preload and a sandbox-exec. */
function host(opts: { version?: string | null; name?: string } = {}) {
  const t = tempRoot();
  cleanups.push(t.remove);
  const r = t.root;
  const pkg = join(r, 'lib', 'node_modules', '@anthropic-ai', 'sandbox-runtime');
  const cli = writeExecutable(join(pkg, 'dist', 'cli.js'), 'exit 0');
  if (opts.version !== null) writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: opts.name ?? '@anthropic-ai/sandbox-runtime', version: opts.version ?? '0.0.78' }));
  mkdirSync(join(r, 'bin'));
  const srt = join(r, 'bin', 'srt');
  symlinkSync(cli, srt);
  const node = writeExecutable(join(r, 'node', 'bin', 'node'), 'exit 0');
  const preload = join(r, 'orbit', 'dist', 'srt-chromium-preload.mjs');
  mkdirSync(join(preload, '..'), { recursive: true });
  writeFileSync(preload, '// preload\n');
  const sandboxExec = writeExecutable(join(r, 'usr', 'bin', 'sandbox-exec'), 'exit 0');
  for (const tool of ['bwrap', 'socat', 'rg']) writeExecutable(join(r, 'bin', tool), 'exit 0');
  for (const arch of ['x64', 'arm64']) writeExecutable(join(pkg, 'vendor', 'seccomp', arch, 'apply-seccomp'), 'exit 0');
  const settingsDir = join(r, 'settings');
  mkdirSync(settingsDir);
  const wt = join(r, 'wt');
  mkdirSync(wt);
  return { r, pkg, cli, srt, node, preload, sandboxExec, settingsDir, wt, bin: join(r, 'bin') };
}

function iso(h: ReturnType<typeof host>, over: { platform?: NodeJS.Platform; preloadPath?: string; nodePath?: string } = {}) {
  return new SandboxRuntimeIsolation({ srtPath: h.srt, pathEnv: h.bin, settingsDir: h.settingsDir, platform: over.platform ?? 'darwin', sandboxExecPath: h.sandboxExec, chromiumPreloadPath: over.preloadPath ?? h.preload, nodePath: over.nodePath ?? h.node });
}

describe('wrap with chromiumMachRendezvous on macOS', () => {
  it('reads the preload\'s refusal record from its own settings directory, before cleanup, and only with the adjustment', () => {
    const h = host();
    const w = iso(h).wrap(['npx', 'playwright', 'test'], profile({ writablePaths: [h.wt], chromiumMachRendezvous: true }), { cwd: h.wt, env: { PATH: '/usr/bin:/bin' } });
    expect(w.preloadRefusal?.()).toBeNull();
    const record = join(w.argv[5]!, '..', PRELOAD_REFUSAL_FILE);
    writeFileSync(record, `the profile does not start with (version 1) ghp_abcdefghijklmnopqrstuvwxyz0123456789\n${'x'.repeat(500)}`);
    expect(w.preloadRefusal?.()).toMatch(/^the profile does not start with \(version 1\) \[REDACTED/);
    expect(w.preloadRefusal?.()!.length).toBeLessThanOrEqual(300);
    writeFileSync(record, '  \n');
    expect(w.preloadRefusal?.()).toBe('(no reason recorded)');
    w.cleanup();
    expect(w.preloadRefusal?.()).toBeNull();
    const plain = iso(h).wrap(['true'], profile({ writablePaths: [h.wt] }), { cwd: h.wt, env: { PATH: '/usr/bin:/bin' } });
    expect(plain.preloadRefusal).toBeUndefined();
    plain.cleanup();
    // The preload writes the same name (it cannot import Orbit's modules, so the constant is kept in both).
    expect(readFileSync(defaultChromiumPreloadPath(), 'utf8')).toContain(`export const REFUSAL_FILE = '${PRELOAD_REFUSAL_FILE}';`);
  });

  it('refuses the adjustment when the sandbox could write the settings directory, where the refusal is recorded', () => {
    const h = host();
    // srt always lets the sandbox write $HOME/.npm/_logs; a settings directory there would be in its reach.
    const logs = join(h.r, '.npm', '_logs');
    mkdirSync(logs, { recursive: true });
    const reachable = new SandboxRuntimeIsolation({ srtPath: h.srt, pathEnv: h.bin, settingsDir: logs, platform: 'darwin', sandboxExecPath: h.sandboxExec, chromiumPreloadPath: h.preload, nodePath: h.node });
    const w = () => reachable.wrap(['true'], profile({ writablePaths: [h.wt], chromiumMachRendezvous: true }), { cwd: h.wt, env: { PATH: '/usr/bin:/bin', HOME: h.r } });
    expect(codeOf(w)).toMatch(/^ISOLATION_UNAVAILABLE: .*settings directory/);
    expect(readdirSync(logs)).toEqual([]);
    // Without the adjustment nothing is recorded there, so nothing is refused.
    const plain = reachable.wrap(['true'], profile({ writablePaths: [h.wt] }), { cwd: h.wt, env: { PATH: '/usr/bin:/bin', HOME: h.r } });
    plain.cleanup();
  });

  it('runs srt\'s real CLI under node with the preload, records the adjustment and the srt version, and states the limitation', () => {
    const h = host();
    const w = iso(h).wrap(['npx', 'playwright', 'test'], profile({ writablePaths: [h.wt], chromiumMachRendezvous: true }), { cwd: h.wt, env: { PATH: '/usr/bin:/bin' } });
    expect(w.argv.slice(0, 5)).toEqual([h.node, '--import', `${pathToFileURL(h.preload).href}?rules=chromium`, h.cli, '--settings']);
    expect(w.argv.slice(6)).toEqual(['--', 'npx', 'playwright', 'test']);
    expect(JSON.parse(readFileSync(w.argv[5]!, 'utf8')).filesystem.allowWrite).toEqual([h.wt]);
    expect(w.adjustments).toEqual([CHROMIUM_MACH_RENDEZVOUS]);
    expect(w.runtimeVersion).toBe(SRT_VERIFIED_VERSION);
    expect(SRT_VERIFIED_VERSION).toBe('0.0.78');
    expect(w.limitations).toContain(CHROMIUM_MACH_RENDEZVOUS_LIMITATION);
    expect(w.limitations.filter((l) => l === CHROMIUM_MACH_RENDEZVOUS_LIMITATION)).toHaveLength(1);
    expect(CHROMIUM_MACH_RENDEZVOUS_LIMITATION).toMatch(/--no-sandbox/);
    expect(CHROMIUM_MACH_RENDEZVOUS_LIMITATION).toMatch(/only boundary/);
    expect(CHROMIUM_MACH_RENDEZVOUS_LIMITATION).toMatch(/mach-register and mach-lookup/);
    expect(CHROMIUM_MACH_RENDEZVOUS_LIMITATION).toMatch(/Playwright's bundled Chromium/);
    expect(CHROMIUM_MACH_RENDEZVOUS_LIMITATION).toMatch(/MAC_CHROMIUM_TMPDIR, an environment variable .*no rule, path or host is added/);
    w.cleanup();
  });

  it('points Chromium\'s own temp directory (MAC_CHROMIUM_TMPDIR) at the private TMPDIR the sandbox writes, and widens no path', () => {
    const h = host();
    const tmp = join(h.r, 'check', 'tmp');
    mkdirSync(tmp, { recursive: true });
    const wrap = (over: Partial<SandboxProfile>, env: Record<string, string>, platform?: NodeJS.Platform) => {
      const w = iso(h, platform ? { platform } : {}).wrap(['npx', 'playwright', 'test'], profile({ writablePaths: [h.wt, tmp], chromiumMachRendezvous: true, ...over }), { cwd: h.wt, env: { PATH: '/usr/bin:/bin', ...env } });
      cleanups.push(w.cleanup);
      return w;
    };
    // Chromium on macOS ignores TMPDIR (base::GetTempDir) and writes a download to its temp directory first.
    const w = wrap({}, { TMPDIR: tmp });
    expect(w.env.MAC_CHROMIUM_TMPDIR).toBe(tmp);
    expect(w.env.CLAUDE_CODE_TMPDIR).toBe(tmp);
    // The Seatbelt profile is untouched: nothing beyond the check's own writable paths.
    expect(JSON.parse(readFileSync(w.argv[5]!, 'utf8')).filesystem.allowWrite).toEqual([h.wt, tmp]);
    // The check's temp directory wins over one the repository names.
    expect(wrap({}, { TMPDIR: tmp, MAC_CHROMIUM_TMPDIR: join(h.r, 'elsewhere') }).env.MAC_CHROMIUM_TMPDIR).toBe(tmp);
    // A writable CLAUDE_CODE_TMPDIR is the child's TMPDIR under srt, so Chromium's too.
    const other = join(h.wt, 'tmp2');
    mkdirSync(other);
    expect(wrap({}, { TMPDIR: tmp, CLAUDE_CODE_TMPDIR: other }).env.MAC_CHROMIUM_TMPDIR).toBe(other);
    // No private temp directory the sandbox can write (srt falls back to the shared /tmp/claude): nothing is set.
    expect(wrap({ writablePaths: [h.wt] }, { TMPDIR: tmp }).env).not.toHaveProperty('MAC_CHROMIUM_TMPDIR');
    expect(wrap({}, { TMPDIR: tmp, CLAUDE_CODE_TMPDIR: join(h.r, 'elsewhere') }).env).not.toHaveProperty('MAC_CHROMIUM_TMPDIR');
    expect(wrap({}, {}).env).not.toHaveProperty('MAC_CHROMIUM_TMPDIR');
    // Not for other commands, and not on Linux, where Chromium honours TMPDIR.
    expect(wrap({ chromiumMachRendezvous: false }, { TMPDIR: tmp }).env).not.toHaveProperty('MAC_CHROMIUM_TMPDIR');
    expect(wrap({}, { TMPDIR: tmp }, 'linux').env).not.toHaveProperty('MAC_CHROMIUM_TMPDIR');
  });

  it('leaves argv alone without the flag, and on Linux even with it', () => {
    const h = host();
    const plain = iso(h).wrap(['true'], profile(), { cwd: h.wt, env: {} });
    expect(plain.argv[0]).toBe(h.srt);
    expect(plain.argv[1]).toBe('--settings');
    expect(plain.adjustments).toEqual([]);
    expect(plain.limitations).not.toContain(CHROMIUM_MACH_RENDEZVOUS_LIMITATION);
    plain.cleanup();
    const linux = iso(h, { platform: 'linux' }).wrap(['true'], profile({ chromiumMachRendezvous: true }), { cwd: h.wt, env: {} });
    expect(linux.argv[0]).toBe(h.srt);
    expect(linux.argv[1]).toBe('--settings');
    expect(linux.adjustments).toEqual([]);
    expect(linux.limitations).not.toContain(CHROMIUM_MACH_RENDEZVOUS_LIMITATION);
    linux.cleanup();
  });

  it('refuses a preload or a node the sandbox could rewrite', () => {
    const h = host();
    const p = (writable: string) => profile({ writablePaths: [writable], chromiumMachRendezvous: true });
    expect(codeOf(() => iso(h).wrap(['true'], p(join(h.r, 'orbit')), { cwd: h.wt, env: {} }))).toMatch(/^ISOLATION_UNAVAILABLE: .*preload .*could replace/);
    expect(codeOf(() => iso(h).wrap(['true'], p(join(h.r, 'orbit', 'dist', 'sub')), { cwd: h.wt, env: {} }))).toMatch(/^ISOLATION_UNAVAILABLE: .*preload/);
    expect(codeOf(() => iso(h).wrap(['true'], p(join(h.r, 'node')), { cwd: h.wt, env: {} }))).toMatch(/^ISOLATION_UNAVAILABLE: .*node .*could replace/);
    // A node reached through a link is judged where it really is.
    const linked = join(h.wt, 'node');
    symlinkSync(h.node, linked);
    const w = iso(h, { nodePath: linked }).wrap(['true'], p(h.wt), { cwd: h.wt, env: {} });
    expect(w.argv[0]).toBe(h.node);
    w.cleanup();
    expect(readdirEmpty(h.settingsDir)).toBe(true);
  });

  it('requires the srt version the preload was verified against, for browser checks only', () => {
    const newer = host({ version: '0.0.79' });
    expect(codeOf(() => iso(newer).wrap(['true'], profile({ chromiumMachRendezvous: true }), { cwd: newer.wt, env: {} }))).toMatch(/^ISOLATION_UNAVAILABLE: .*0\.0\.79.*verified.*0\.0\.78/);
    const w = iso(newer).wrap(['true'], profile(), { cwd: newer.wt, env: {} });
    expect(w.runtimeVersion).toBe('0.0.79');
    w.cleanup();
    const unknown = host({ version: null });
    expect(codeOf(() => iso(unknown).wrap(['true'], profile({ chromiumMachRendezvous: true }), { cwd: unknown.wt, env: {} }))).toMatch(/^ISOLATION_UNAVAILABLE: .*unknown version/);
    const other = host({ name: 'acme-srt' });
    expect(codeOf(() => iso(other).wrap(['true'], profile({ chromiumMachRendezvous: true }), { cwd: other.wt, env: {} }))).toMatch(/^ISOLATION_UNAVAILABLE: .*not @anthropic-ai\/sandbox-runtime/);
    const h = host();
    expect(codeOf(() => iso(h, { preloadPath: join(h.r, 'missing.mjs') }).wrap(['true'], profile({ chromiumMachRendezvous: true }), { cwd: h.wt, env: {} }))).toMatch(/^ISOLATION_UNAVAILABLE: .*preload .*missing/);
    for (const x of [newer, unknown, other, h]) expect(readdirEmpty(x.settingsDir)).toBe(true);
  });

  it('describes what a browser check would get', () => {
    const h = host();
    expect(iso(h).browserIsolation()).toEqual({ rules: true, srtVersion: '0.0.78', verified: true, detail: expect.stringMatching(/srt 0\.0\.78 .*verified/) });
    expect(iso(h, { platform: 'linux' }).browserIsolation()).toMatchObject({ rules: false, srtVersion: '0.0.78', verified: true });
    const newer = host({ version: '0.0.80' });
    expect(iso(newer).browserIsolation()).toMatchObject({ rules: true, srtVersion: '0.0.80', verified: false, detail: expect.stringMatching(/0\.0\.80.*0\.0\.78/) });
    const none = new SandboxRuntimeIsolation({ srtPath: join(h.r, 'gone'), platform: 'darwin' });
    expect(none.browserIsolation()).toMatchObject({ rules: true, srtVersion: null, verified: false });
  });
});

describe('srtPackageOf and the shipped preload', () => {
  it('reads the package an srt binary belongs to through links, and null for anything else', () => {
    const h = host();
    expect(srtPackageOf(h.srt)).toEqual({ cli: h.cli, name: '@anthropic-ai/sandbox-runtime', version: '0.0.78' });
    expect(srtPackageOf(join(h.r, 'nowhere'))).toBeNull();
    const loose = writeExecutable(join(h.r, 'loose', 'srt'), 'exit 0');
    expect(srtPackageOf(loose)).toEqual({ cli: loose, name: null, version: null });
    writeFileSync(join(h.pkg, 'package.json'), 'not json');
    expect(srtPackageOf(h.srt)).toEqual({ cli: h.cli, name: null, version: null });
  });

  it('finds the preload beside this module in the sources', () => {
    expect(defaultChromiumPreloadPath()).toMatch(/src\/isolation\/srt-chromium-preload\.mjs$/);
    expect(existsSync(defaultChromiumPreloadPath())).toBe(true);
  });
});

function readdirEmpty(dir: string): boolean {
  return readdirSync(dir).length === 0;
}
