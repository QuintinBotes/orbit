// wrap() for a process that runs .NET on macOS: with SandboxProfile.nisDomainName set, srt's CLI runs under node with the
// Orbit preload's nis-domainname rule set, one read-only Seatbelt rule for the sysctl kern.nisdomainname
// (docs/decisions/0009-toolchain-profiles.md, addendum). .NET's CookieContainer reads it, so without it every .NET HTTP
// client failed under srt, NuGet's restore included. Built from fake files, so these run the same on macOS and Linux.
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { CHROMIUM_MACH_RENDEZVOUS, DOTNET_IPV4_ENV, DOTNET_POLLING_WATCHER_ENV, NIS_DOMAINNAME_LIMITATION, NIS_DOMAINNAME_READ, NIS_DOMAINNAME_SKIPPED, SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import type { SandboxProfile } from '../../../src/isolation/types.ts';
import { tempRoot, writeExecutable } from './fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function profile(over: Partial<SandboxProfile> = {}): SandboxProfile {
  return { writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 60_000, memoryMb: null, cpus: null, pids: null }, ...over };
}

/** An installed srt package (package.json, dist/cli.js), a bin link to it, a node, the preload and a sandbox-exec. */
function host(opts: { version?: string } = {}) {
  const t = tempRoot();
  cleanups.push(t.remove);
  const r = t.root;
  const pkg = join(r, 'lib', 'node_modules', '@anthropic-ai', 'sandbox-runtime');
  const cli = writeExecutable(join(pkg, 'dist', 'cli.js'), 'exit 0');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/sandbox-runtime', version: opts.version ?? '0.0.78' }));
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
  return { r, cli, srt, node, preload, sandboxExec, settingsDir, wt, bin: join(r, 'bin') };
}

function iso(h: ReturnType<typeof host>, platform: NodeJS.Platform = 'darwin') {
  return new SandboxRuntimeIsolation({ srtPath: h.srt, pathEnv: h.bin, settingsDir: h.settingsDir, platform, sandboxExecPath: h.sandboxExec, chromiumPreloadPath: h.preload, nodePath: h.node });
}

function wrap(h: ReturnType<typeof host>, over: Partial<SandboxProfile>, platform: NodeJS.Platform = 'darwin', env: Record<string, string> = {}) {
  const w = iso(h, platform).wrap(['dotnet', 'restore', '-m:1'], profile({ writablePaths: [h.wt], ...over }), { cwd: h.wt, env: { PATH: '/usr/bin:/bin', ...env } });
  cleanups.push(w.cleanup);
  return w;
}

describe('wrap with nisDomainName on macOS', () => {
  it('runs srt\'s real CLI under node with the preload\'s nis-domainname set, reports the adjustment and states the rule', () => {
    const h = host();
    const w = wrap(h, { nisDomainName: true });
    expect(w.argv.slice(0, 5)).toEqual([h.node, '--import', `${pathToFileURL(h.preload).href}?rules=nis-domainname`, h.cli, '--settings']);
    expect(w.argv.slice(6)).toEqual(['--', 'dotnet', 'restore', '-m:1']);
    expect(w.adjustments).toEqual([NIS_DOMAINNAME_READ]);
    expect(w.limitations.filter((l) => l === NIS_DOMAINNAME_LIMITATION)).toHaveLength(1);
    expect(NIS_DOMAINNAME_LIMITATION).toMatch(/sysctl-read of kern\.nisdomainname/);
    expect(NIS_DOMAINNAME_LIMITATION).toMatch(/CookieContainer/);
    expect(w.preloadRefusal?.()).toBeNull();
  });

  it('asks for both sets, Chromium\'s first, for a browser run that also needs .NET', () => {
    const h = host();
    const w = wrap(h, { nisDomainName: true, chromiumMachRendezvous: true });
    expect(w.argv[2]).toBe(`${pathToFileURL(h.preload).href}?rules=chromium,nis-domainname`);
    expect(w.adjustments).toEqual([CHROMIUM_MACH_RENDEZVOUS, NIS_DOMAINNAME_READ]);
  });

  it('names Chromium\'s set alone for a browser run', () => {
    const h = host();
    expect(wrap(h, { chromiumMachRendezvous: true }).argv[2]).toBe(`${pathToFileURL(h.preload).href}?rules=chromium`);
  });

  it('changes nothing without the flag, and on Linux even with it (Linux has no Seatbelt)', () => {
    const h = host();
    for (const w of [wrap(h, {}), wrap(h, { nisDomainName: true }, 'linux')]) {
      expect(w.argv[0]).toBe(h.srt);
      expect(w.adjustments).toEqual([]);
      expect(w.limitations).not.toContain(NIS_DOMAINNAME_LIMITATION);
      expect(w.preloadRefusal).toBeUndefined();
    }
  });

  // The rule only lets .NET's HTTP clients start; without it the command runs as srt alone would run it. So an srt the
  // preload was not verified against does not stop the command, as it stops a browser run: it runs without the rule.
  it('runs srt as it is, saying the rule was not added, with an srt the preload was not verified against', () => {
    const h = host({ version: '0.0.79' });
    const w = wrap(h, { nisDomainName: true });
    expect(w.argv[0]).toBe(h.srt);
    expect(w.adjustments).toEqual([]);
    expect(w.limitations).toContain(NIS_DOMAINNAME_SKIPPED);
    expect(NIS_DOMAINNAME_SKIPPED).toMatch(/GetDomainName: -1/);
  });

  it('refuses a preload the sandbox could rewrite, and a settings directory it could write, where the refusal is recorded', () => {
    const h = host();
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return isOrbitError(err) ? err.code : String(err);
      }
      return null;
    };
    expect(code(() => iso(h).wrap(['true'], profile({ writablePaths: [join(h.r, 'orbit')], nisDomainName: true }), { cwd: h.wt, env: {} }))).toBe('ISOLATION_UNAVAILABLE');
    const logs = join(h.r, '.npm', '_logs');
    mkdirSync(logs, { recursive: true });
    const reachable = new SandboxRuntimeIsolation({ srtPath: h.srt, pathEnv: h.bin, settingsDir: logs, platform: 'darwin', sandboxExecPath: h.sandboxExec, chromiumPreloadPath: h.preload, nodePath: h.node });
    expect(code(() => reachable.wrap(['true'], profile({ writablePaths: [h.wt], nisDomainName: true }), { cwd: h.wt, env: { HOME: h.r } }))).toBe('ISOLATION_UNAVAILABLE');
    expect(readdirSync(logs)).toEqual([]);
  });
});

// .NET opens dual-stack IPv6 sockets, so its connects to 127.0.0.1 (srt's proxy on localhost included) reach the kernel as
// ::ffff:127.0.0.1, which Seatbelt's localhost rule does not match on GitHub's macOS runner: every .NET HTTP request there
// was denied. A .NET process on macOS gets its sockets in IPv4 only, as srt does for Java.
describe('wrap of a .NET process on macOS: IPv4 sockets', () => {
  it('sets DOTNET_SYSTEM_NET_DISABLEIPV6=1 for the process, with or without the NIS rule', () => {
    expect(DOTNET_IPV4_ENV).toEqual({ DOTNET_SYSTEM_NET_DISABLEIPV6: '1' });
    expect(wrap(host(), { nisDomainName: true }).env).toMatchObject(DOTNET_IPV4_ENV);
    expect(wrap(host({ version: '0.0.79' }), { nisDomainName: true }).env).toMatchObject(DOTNET_IPV4_ENV);
  });

  it('keeps the value the command sets itself', () => {
    expect(wrap(host(), { nisDomainName: true }, 'darwin', { DOTNET_SYSTEM_NET_DISABLEIPV6: '0' }).env.DOTNET_SYSTEM_NET_DISABLEIPV6).toBe('0');
  });

  it('sets nothing for a process that does not run .NET, or on Linux', () => {
    const h = host();
    for (const w of [wrap(h, {}), wrap(h, { nisDomainName: true }, 'linux')]) expect(w.env.DOTNET_SYSTEM_NET_DISABLEIPV6).toBeUndefined();
  });
});

// ASP.NET Core's host watches its configuration files (reloadOnChange) through a FileSystemWatcher, which on macOS asks
// the FSEvents service for events; srt's Seatbelt profile denies that lookup (mach-lookup com.apple.FSEvents), and the
// application then hung at startup with no output: a .NET web application started as ui.environment.start_command never
// became ready under srt (issue #26, measured on macOS 27 with SDK 9.0.305). With the polling watcher it starts.
describe('wrap of a .NET process on macOS: the polling file watcher', () => {
  it('sets DOTNET_USE_POLLING_FILE_WATCHER=1 for the process, with or without the NIS rule', () => {
    expect(DOTNET_POLLING_WATCHER_ENV).toEqual({ DOTNET_USE_POLLING_FILE_WATCHER: '1' });
    expect(wrap(host(), { nisDomainName: true }).env).toMatchObject(DOTNET_POLLING_WATCHER_ENV);
    expect(wrap(host({ version: '0.0.79' }), { nisDomainName: true }).env).toMatchObject(DOTNET_POLLING_WATCHER_ENV);
  });

  it('keeps the value the command sets itself', () => {
    expect(wrap(host(), { nisDomainName: true }, 'darwin', { DOTNET_USE_POLLING_FILE_WATCHER: 'false' }).env.DOTNET_USE_POLLING_FILE_WATCHER).toBe('false');
  });

  it('sets nothing for a process that does not run .NET, or on Linux', () => {
    const h = host();
    for (const w of [wrap(h, {}), wrap(h, { nisDomainName: true }, 'linux')]) expect(w.env.DOTNET_USE_POLLING_FILE_WATCHER).toBeUndefined();
  });
});
