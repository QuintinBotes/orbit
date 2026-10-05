// `orbit doctor`'s ui.browser-isolation check (docs/decisions/0001-runtime-choices.md, "Browsers under sandbox-runtime
// on macOS"): the srt version against the one the Chromium preload was verified with, a real headless Chromium launch
// through the preload, and the limitation; Linux is reported as unverified. The launch is Orbit's own command against
// Playwright's headless Chromium binary: no JavaScript of the repository runs, every credential path is read-denied,
// and only a page the browser really rendered (a nonce its script computed) counts as a start.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browserIsolationCheck, headlessChromiumOf, type BrowserLaunch } from '../../../src/cli/commands/doctor.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { HOME_DENY_READ, SYSTEM_DENY_READ } from '../../../src/isolation/profiles.ts';
import { CHROMIUM_MACH_RENDEZVOUS_LIMITATION } from '../../../src/isolation/sandbox-runtime.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { canonicalPath } from '../../../src/isolation/util.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-doctor-browser-')));
  dirs.push(d);
  return d;
}

const ARCH_DIR = process.arch === 'arm64' ? 'chrome-headless-shell-mac-arm64' : 'chrome-headless-shell-mac-x64';

/**
 * A repository with Playwright installed: its @playwright/test is hostile (it would record that it ran), and its
 * playwright-core names the headless shell revision. A browser cache holding that revision's binary, unless `binary`
 * is false.
 */
function fixture(opts: { installed?: boolean; revision?: string; binary?: boolean } = {}) {
  const root = temp();
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const cache = join(root, 'ms-playwright');
  const ran = join(root, 'repository-code-ran');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"name":"acme-app"}');
  if (opts.installed !== false) {
    const pwt = join(repo, 'node_modules', '@playwright', 'test');
    mkdirSync(pwt, { recursive: true });
    writeFileSync(join(pwt, 'package.json'), JSON.stringify({ name: '@playwright/test', version: '1.63.0', main: 'index.js' }));
    writeFileSync(join(pwt, 'index.js'), `require('fs').writeFileSync(${JSON.stringify(ran)}, 'x'); process.exit(0);`);
    const core = join(repo, 'node_modules', 'playwright-core');
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.63.0' }));
    writeFileSync(join(core, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium', revision: '1243' }, { name: 'chromium-headless-shell', revision: opts.revision ?? '1243' }] }));
  }
  const exe = join(cache, `chromium_headless_shell-${opts.revision ?? '1243'}`, ARCH_DIR, 'chrome-headless-shell');
  if (opts.binary !== false) {
    mkdirSync(join(exe, '..'), { recursive: true });
    writeFileSync(exe, '#!/bin/sh\nexit 0\n');
    chmodSync(exe, 0o755);
  }
  return { repo, home, cache, exe, ran, env: { PATH: '/usr/bin:/bin', HOME: home, PLAYWRIGHT_BROWSERS_PATH: cache } };
}

/** An srt-like provider: what browserIsolation() reports, and every profile wrap() is given. */
function srtLike(info: { rules: boolean; srtVersion: string | null; verified: boolean; detail: string }) {
  const profiles: SandboxProfile[] = [];
  const inner = new NoIsolation();
  const provider = {
    kind: 'sandbox-runtime' as const,
    available: () => inner.available(),
    browserIsolation: () => info,
    wrap(argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }): WrappedCommand {
      profiles.push(profile);
      return { ...inner.wrap(argv, profile, opts), adjustments: ['chromium-mach-rendezvous'], runtimeVersion: info.srtVersion };
    },
  };
  return { provider: provider as IsolationProvider, profiles };
}

const verified = { rules: true, srtVersion: '0.0.78', verified: true, detail: 'srt 0.0.78 is the version the Chromium preload was verified against' };

/** What a real headless shell prints for --dump-dom: the page after its script ran, so the nonce joined. */
function rendered(argv: string[]): string {
  const url = argv.at(-1) ?? '';
  const html = decodeURIComponent(url.replace(/^data:text\/html,/, ''));
  const m = /\['orbit',(\d+),(\d+)\]/.exec(html);
  return m ? `<html><body><p id="o">orbit-${m[1]}-${m[2]}</p></body></html>` : '';
}
const okLaunch: BrowserLaunch = async (argv) => ({ exitCode: 0, output: rendered(argv) });

describe('browserIsolationCheck', () => {
  it('passes on macOS when srt is the verified version and headless Chromium renders the page through the preload, stating the limitation', async () => {
    const f = fixture();
    const s = srtLike(verified);
    const seen: string[][] = [];
    const launch: BrowserLaunch = async (argv) => (seen.push(argv), { exitCode: 0, output: rendered(argv) });
    const c = await browserIsolationCheck({ wanted: true, provider: s.provider, available: true, repo: f.repo, env: f.env, homeDir: f.home, launch });
    expect(c).toMatchObject({ id: 'ui.browser-isolation', area: 'ui', status: 'pass', summary: 'Chromium starts under srt 0.0.78 with the two Mach rendezvous rules' });
    expect(c.details).toContain(verified.detail);
    expect(c.details).toContain(`limitation: ${CHROMIUM_MACH_RENDEZVOUS_LIMITATION}`);
    expect(s.profiles).toHaveLength(1);
    expect(s.profiles[0]).toMatchObject({ chromiumMachRendezvous: true, allowedHosts: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe(f.exe);
    expect(seen[0]).toEqual(expect.arrayContaining(['--headless', '--no-sandbox', '--dump-dom']));
  });

  it('runs no JavaScript of the repository: Orbit launches the browser binary, never node with the repository\'s Playwright', async () => {
    const f = fixture();
    const seen: string[][] = [];
    const launch: BrowserLaunch = async (argv) => (seen.push(argv), { exitCode: 0, output: rendered(argv) });
    await browserIsolationCheck({ wanted: true, provider: srtLike(verified).provider, available: true, repo: f.repo, env: f.env, homeDir: f.home, launch });
    expect(seen[0]![0]).not.toBe(process.execPath);
    expect(seen[0]!.join(' ')).not.toMatch(/@playwright|require\(|chromium\.launch/);
    expect(existsSync(f.ran)).toBe(false);
  });

  it('read-denies every credential path, Orbit\'s state and the repository to the browser it launches', async () => {
    const f = fixture();
    const s = srtLike(verified);
    await browserIsolationCheck({ wanted: true, provider: s.provider, available: true, repo: f.repo, env: f.env, homeDir: f.home, launch: okLaunch });
    const denied = s.profiles[0]!.denyReadPaths;
    for (const rel of HOME_DENY_READ) expect(denied).toContain(join(f.home, rel));
    for (const p of SYSTEM_DENY_READ) expect(denied).toContain(canonicalPath(p));
    expect(denied).toContain(join(f.home, '.claude'));
    expect(denied).toContain(join(f.home, '.codex'));
    expect(denied).toContain(f.repo);
  });

  it('does not pass on an exit of 0 alone: the page must show the nonce its script computed', async () => {
    const f = fixture();
    const quiet = await browserIsolationCheck({ wanted: true, provider: srtLike(verified).provider, available: true, repo: f.repo, env: f.env, homeDir: f.home, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(quiet).toMatchObject({ status: 'fail', summary: expect.stringMatching(/did not render the test page/) });
    // The script's source holds the parts of the nonce, never the joined value.
    const echoed = await browserIsolationCheck({ wanted: true, provider: srtLike(verified).provider, available: true, repo: f.repo, env: f.env, homeDir: f.home, launch: async (argv) => ({ exitCode: 0, output: decodeURIComponent(argv.at(-1) ?? '') }) });
    expect(echoed.status).toBe('fail');
  });

  it('fails when the launch fails, naming what the browser printed', async () => {
    const f = fixture();
    const launch: BrowserLaunch = async () => ({ exitCode: 1, output: 'FATAL bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.1: Permission denied (1100)' });
    const c = await browserIsolationCheck({ wanted: true, provider: srtLike(verified).provider, available: true, repo: f.repo, env: f.env, homeDir: f.home, launch });
    expect(c).toMatchObject({ status: 'fail', summary: expect.stringMatching(/^headless Chromium did not start under srt 0\.0\.78 \(exit 1\): FATAL bootstrap_check_in/) });
    const timedOut = await browserIsolationCheck({ wanted: true, provider: srtLike(verified).provider, available: true, repo: f.repo, env: f.env, homeDir: f.home, launch: async () => ({ exitCode: null, output: '' }) });
    expect(timedOut).toMatchObject({ status: 'fail', summary: expect.stringMatching(/\(exit timeout\): \(no output\)/) });
    const thrown = await browserIsolationCheck({ wanted: true, provider: srtLike(verified).provider, available: true, repo: f.repo, env: f.env, homeDir: f.home, launch: async () => { throw new Error('spawn failed'); } });
    expect(thrown).toMatchObject({ status: 'fail', summary: expect.stringMatching(/spawn failed/) });
  });

  it('fails on macOS for an srt that is not the verified version, without launching anything', async () => {
    const f = fixture();
    const s = srtLike({ rules: true, srtVersion: '0.0.80', verified: false, detail: 'srt 0.0.80 is not 0.0.78, the version the Chromium preload was verified against' });
    let launched = false;
    const c = await browserIsolationCheck({ wanted: true, provider: s.provider, available: true, repo: f.repo, env: f.env, homeDir: f.home, launch: async () => ((launched = true), { exitCode: 0, output: '' }) });
    expect(c).toMatchObject({ status: 'fail', summary: expect.stringMatching(/browser checks are refused/), missing: 'srt 0.0.78 (@anthropic-ai/sandbox-runtime)' });
    expect(launched).toBe(false);
  });

  it('says Linux is unverified, and needs nothing for other providers or when no UI is configured', async () => {
    const f = fixture();
    const linux = await browserIsolationCheck({ wanted: true, provider: srtLike({ ...verified, rules: false }).provider, available: true, repo: f.repo, env: f.env, launch: okLaunch });
    expect(linux).toMatchObject({ status: 'warn', summary: expect.stringMatching(/^unverified on Linux: /) });
    expect(await browserIsolationCheck({ wanted: false, provider: srtLike(verified).provider, available: true, repo: null, env: {}, launch: okLaunch })).toMatchObject({ status: 'pass', summary: expect.stringMatching(/^not required/) });
    expect(await browserIsolationCheck({ wanted: true, provider: new NoIsolation(), available: true, repo: null, env: {}, launch: okLaunch })).toMatchObject({ status: 'pass', summary: expect.stringMatching(/^not needed: browser checks run under none/) });
    expect(await browserIsolationCheck({ wanted: true, provider: null, available: false, repo: null, env: {}, launch: okLaunch })).toMatchObject({ status: 'warn', summary: expect.stringMatching(/isolation is unavailable/) });
  });

  it('cannot launch without a repository, Playwright or its headless Chromium, and says so without passing', async () => {
    let launched = false;
    const launch: BrowserLaunch = async (argv) => ((launched = true), { exitCode: 0, output: rendered(argv) });
    expect(await browserIsolationCheck({ wanted: true, provider: srtLike(verified).provider, available: true, repo: null, env: {}, launch })).toMatchObject({ status: 'warn', summary: expect.stringMatching(/no repository/) });
    const none = fixture({ installed: false });
    expect(await browserIsolationCheck({ wanted: true, provider: srtLike(verified).provider, available: true, repo: none.repo, env: none.env, homeDir: none.home, launch })).toMatchObject({ status: 'warn', summary: expect.stringMatching(/Playwright is not installed/) });
    // The repository's Playwright stub would exit 0, but Chromium itself is missing: never a pass.
    const missing = fixture({ revision: '9999', binary: false });
    const c = await browserIsolationCheck({ wanted: true, provider: srtLike(verified).provider, available: true, repo: missing.repo, env: missing.env, homeDir: missing.home, launch });
    expect(c).toMatchObject({ status: 'warn', summary: expect.stringMatching(/headless Chromium \(revision 9999\) is not installed/) });
    expect(launched).toBe(false);
    expect(existsSync(missing.ran)).toBe(false);
  });
});

describe('headlessChromiumOf', () => {
  it('finds the headless shell of the revision the repository\'s Playwright names, in the browser cache', () => {
    const f = fixture();
    expect(headlessChromiumOf(f.repo, f.cache)).toEqual({ exe: f.exe, revision: '1243' });
  });

  it('falls back to the chromium revision and the older headless_shell layout, and says why when nothing fits', () => {
    const f = fixture({ installed: false });
    const core = join(f.repo, 'node_modules', 'playwright-core');
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, 'package.json'), '{"name":"playwright-core"}');
    writeFileSync(join(core, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium', revision: '1100' }] }));
    const old = join(f.cache, 'chromium_headless_shell-1100', 'chrome-mac', 'headless_shell');
    mkdirSync(join(old, '..'), { recursive: true });
    writeFileSync(old, '');
    chmodSync(old, 0o755);
    expect(headlessChromiumOf(f.repo, f.cache)).toEqual({ exe: old, revision: '1100' });
    writeFileSync(join(core, 'browsers.json'), '{ not json');
    expect(headlessChromiumOf(f.repo, f.cache)).toEqual({ problem: expect.stringMatching(/browsers\.json/) });
    writeFileSync(join(core, 'browsers.json'), JSON.stringify({ browsers: [] }));
    expect(headlessChromiumOf(f.repo, f.cache)).toEqual({ problem: expect.stringMatching(/names no Chromium revision/) });
  });
});
