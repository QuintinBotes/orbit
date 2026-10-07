// The Orbit-owned preload that adds Chromium's Mach rendezvous rules to the profile the unmodified srt CLI hands to
// sandbox-exec (docs/decisions/0001-runtime-choices.md, "Browsers under sandbox-runtime on macOS"). It may add exactly
// two constant rules and nothing else, and it must refuse (exit 97) every command shape it was not verified against.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PRELOAD = join(ROOT, 'src/isolation/srt-chromium-preload.mjs');

const RX = '^org[.]chromium[.]Chromium[.]MachPortRendezvousServer[.][0-9]+$';
const REGISTER = `(allow mach-register (global-name-regex #"${RX}"))`;
const LOOKUP = `(allow mach-lookup (global-name-regex #"${RX}"))`;

/** srt 0.0.78's quote(): bare words stay bare, anything else is single-quoted with ' spelled '"'"'. */
function quote(args: string[]): string {
  return args.map((a) => (/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(a) ? a : `'${a.replace(/'/g, `'"'"'`)}'`)).join(' ');
}

function profile(extra = ''): string {
  return ['(version 1)', '(deny default (with message "orbit_tag"))', '', '; Process permissions', '(allow process-exec)', '(allow process-fork)', '', `(deny file-read* (subpath "/Users/acme/.ssh"))${extra}`].join('\n');
}

/** The command srt 0.0.78 spawns with {shell: true} on macOS. */
function srtCommand(p = profile(), inner = "'/usr/bin/env' 'npx' 'playwright' 'test'"): string {
  return `${quote(['env', 'HTTP_PROXY=http://localhost:4100', '/usr/bin/sandbox-exec', '-p', p, '/bin/bash', '-c'])} ${quote([inner])}`;
}

async function load() {
  // The module installs its hook when it loads; here every host object it touches is a fake.
  vi.resetModules();
  const fakeCp = { spawn: vi.fn(), spawnSync: vi.fn(), exec: vi.fn(), execSync: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn() };
  const fakeProcess = { on: vi.fn(), exit: vi.fn(), stderr: { write: vi.fn() }, exitCode: undefined as number | undefined };
  const sync = vi.fn();
  vi.doMock('node:child_process', () => ({ default: fakeCp }));
  vi.doMock('node:module', () => ({ syncBuiltinESMExports: sync }));
  vi.doMock('node:process', () => ({ default: fakeProcess }));
  const mod = await import(pathToFileURL(PRELOAD).href);
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:module');
  vi.doUnmock('node:process');
  return { mod, fakeCp, fakeProcess, sync };
}

afterEach(() => {
  vi.resetModules();
});

describe('patchSandboxExecCommand', () => {
  it('inserts exactly the two constant rules right after the one (allow process-exec) inside the -p argument', async () => {
    const { mod } = await load();
    const cmd = srtCommand();
    const out: string = mod.patchSandboxExecCommand(cmd);
    expect(out).toBe(cmd.replace('(allow process-exec)', `(allow process-exec)\n${REGISTER}\n${LOOKUP}`));
    expect(out.length - cmd.length).toBe(`\n${REGISTER}\n${LOOKUP}`.length);
    expect(out.split('mach-register').length - 1).toBe(1);
    expect(out.split('mach-lookup (global-name-regex').length - 1).toBe(1);
    expect(mod.CHROMIUM_RULES).toEqual([REGISTER, LOOKUP]);
  });

  it('keeps a profile that srt had to quote around an apostrophe', async () => {
    const { mod } = await load();
    const cmd = srtCommand(profile(`\n(deny file-read* (subpath "/private/tmp/it's-a-dir"))`));
    expect(cmd).toContain(`it'"'"'s-a-dir`);
    expect(mod.patchSandboxExecCommand(cmd)).toBe(cmd.replace('(allow process-exec)', `(allow process-exec)\n${REGISTER}\n${LOOKUP}`));
  });

  it('refuses a profile without the marker, with it twice, or with it only in the command after -c', async () => {
    const { mod } = await load();
    const without = profile().replace('(allow process-exec)\n', '');
    expect(() => mod.patchSandboxExecCommand(srtCommand(without))).toThrow(/exactly once/);
    expect(() => mod.patchSandboxExecCommand(srtCommand(profile('\n(allow process-exec)')))).toThrow(/exactly once/);
    // The marker outside -p: the command run inside the sandbox mentions it, the profile does not.
    expect(() => mod.patchSandboxExecCommand(srtCommand(without, "echo '(allow process-exec)'"))).toThrow(/exactly once/);
  });

  it('patches the real rule line when a path in the profile spells the marker or sandbox-exec, and keeps the paths', async () => {
    const { mod } = await load();
    // srt writes paths with JSON.stringify, so a path can hold the marker's text but never a line of its own.
    const odd = ['(deny file-read* (subpath "/private/tmp/(allow process-exec)"))', '(deny file-read* (literal "/Users/acme/repo/.env(allow process-exec)"))', '(deny file-read* (subpath "/Users/acme/usr/bin/sandbox-exec"))', `(deny file-read* (subpath "/tmp/it's /usr/bin/sandbox-exec -p 'x"))`];
    const lines = profile().split('\n');
    const at = lines.indexOf('(allow process-exec)');
    const p = [...lines.slice(0, at), odd[0]!, ...lines.slice(at), ...odd.slice(1)].join('\n');
    const patched = [...lines.slice(0, at), odd[0]!, ...lines.slice(at, at + 1), REGISTER, LOOKUP, ...lines.slice(at + 1), ...odd.slice(1)].join('\n');
    const cmd = srtCommand(p);
    const out: string = mod.patchSandboxExecCommand(cmd);
    expect(out).toBe(srtCommand(patched));
    for (const o of odd) expect(out).toContain(quote([o]).slice(1, -1));
  });

  it('still refuses sandbox-exec spelled outside the profile, in an assignment or the command', async () => {
    const { mod } = await load();
    const assigned = `${quote(['env', "X= /usr/bin/sandbox-exec -p 'y", '/usr/bin/sandbox-exec', '-p', profile(), '/bin/bash', '-c'])} 'true'`;
    expect(() => mod.patchSandboxExecCommand(assigned)).toThrow(/exactly one sandbox-exec/);
  });

  it('refuses a double-quoted profile, a second sandbox-exec, and any other command shape', async () => {
    const { mod } = await load();
    const doubleQuoted = `env /usr/bin/sandbox-exec -p "${profile()}" /bin/bash -c 'true'`;
    expect(() => mod.patchSandboxExecCommand(doubleQuoted)).toThrow(/single-quoted/);
    expect(() => mod.patchSandboxExecCommand(srtCommand(profile(), '/usr/bin/sandbox-exec -p x true'))).toThrow(/exactly one sandbox-exec/);
    expect(() => mod.patchSandboxExecCommand(`/usr/bin/sandbox-exec -p '${profile()}' /bin/bash -c true`)).toThrow(/does not start with env/);
    expect(() => mod.patchSandboxExecCommand(`env /usr/bin/sandbox-exec -f /tmp/acme.sb /bin/bash`)).toThrow(/single-quoted/);
    expect(() => mod.patchSandboxExecCommand(`env /usr/bin/sandbox-exec -p '${profile()}`)).toThrow(/unterminated/);
    expect(() => mod.patchSandboxExecCommand(`env /usr/bin/sandbox-exec -p '${profile()}'x /bin/bash`)).toThrow(/unterminated/);
    expect(() => mod.patchSandboxExecCommand(srtCommand(profile().replace('(version 1)', '(version 2)')))).toThrow(/version 1/);
    expect(() => mod.patchSandboxExecCommand(srtCommand(profile().replace('(allow process-exec)', '(allow process-exec) ')))).toThrow(/exactly once/);
    expect(() => mod.patchSandboxExecCommand(42)).toThrow(/not a string/);
  });
});

describe('the spawn hook', () => {
  it('installs itself on load: patches spawn, guards the other spawners, re-syncs the ESM exports and watches exit', async () => {
    const { fakeCp, fakeProcess, sync } = await load();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(fakeProcess.on).toHaveBeenCalledWith('exit', expect.any(Function));
    expect(fakeCp.spawn).not.toBe(undefined);
  });

  it('hands srt\'s sandbox-exec command to the real spawn patched, and passes everything else through untouched', async () => {
    const { mod } = await load();
    const real = { spawn: vi.fn((..._a: unknown[]) => 'child'), spawnSync: vi.fn((..._a: unknown[]) => 'sync'), exec: vi.fn(), execSync: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn() };
    const proc = { on: vi.fn(), exit: vi.fn((code: number) => { throw new Error(`exit ${code}`); }), stderr: { write: vi.fn() }, exitCode: undefined as number | undefined };
    const spawn = real.spawn;
    mod.installSandboxExecHook(real, proc, () => {});
    expect(real.spawn('log', ['stream'])).toBe('child');
    expect(spawn.mock.calls.at(-1)).toEqual(['log', ['stream']]);
    const cmd = srtCommand();
    expect(real.spawn(cmd, { shell: true, stdio: 'inherit' })).toBe('child');
    expect(spawn.mock.calls.at(-1)).toEqual([cmd.replace('(allow process-exec)', `(allow process-exec)\n${REGISTER}\n${LOOKUP}`), { shell: true, stdio: 'inherit' }]);
    expect(real.spawnSync('which', ['bash'])).toBe('sync');

    // Patched once: exiting is fine.
    const onExit = proc.on.mock.calls[0]![1] as () => void;
    onExit();
    expect(proc.exitCode).toBeUndefined();
  });

  it('exits 97 for any other way of running sandbox-exec, a second sandbox, a shell-less spawn, or exiting unpatched', async () => {
    const { mod } = await load();
    const make = () => {
      const real = { spawn: vi.fn((..._a: unknown[]) => 'child'), spawnSync: vi.fn(), exec: vi.fn(), execSync: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn() };
      const proc = { on: vi.fn(), exit: vi.fn((code: number) => { throw new Error(`exit ${code}`); }), stderr: { write: vi.fn() }, exitCode: undefined as number | undefined };
      mod.installSandboxExecHook(real, proc, () => {});
      return { real, proc };
    };
    for (const name of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const) {
      const { real, proc } = make();
      expect(() => (real[name] as (...a: unknown[]) => unknown)('/usr/bin/sandbox-exec', ['-p', 'x'])).toThrow('exit 97');
      expect(proc.stderr.write.mock.calls[0]![0]).toMatch(new RegExp(`${name}.*sandbox-exec`));
      expect(() => (real[name] as (...a: unknown[]) => unknown)('env', ['/usr/bin/sandbox-exec'])).toThrow('exit 97');
    }
    const shellless = make();
    expect(() => shellless.real.spawn(srtCommand(), { shell: false })).toThrow('exit 97');
    expect(() => shellless.real.spawn('/usr/bin/sandbox-exec', ['-p', profile()])).toThrow('exit 97');
    const bad = make();
    expect(() => bad.real.spawn(srtCommand(profile('\n(allow process-exec)')), { shell: true })).toThrow('exit 97');
    expect(bad.proc.stderr.write.mock.calls[0]![0]).toMatch(/orbit srt-chromium-preload: .*exactly once/);
    const twice = make();
    twice.real.spawn(srtCommand(), { shell: true });
    expect(() => twice.real.spawn(srtCommand(), { shell: true })).toThrow('exit 97');
    const unpatched = make();
    (unpatched.proc.on.mock.calls[0]![1] as () => void)();
    expect(unpatched.proc.exitCode).toBe(97);
    expect(unpatched.proc.stderr.write.mock.calls[0]![0]).toMatch(/exited without starting a patched sandbox/);
    expect(mod.REFUSAL_EXIT_CODE).toBe(97);
  });
});

describe('the preload in a real node process', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A stand-in for srt's cli.js: a named ESM import of spawn, as srt has, and nothing else. */
  function fakeCli(command: string): string {
    dir = mkdtempSync(join(tmpdir(), 'orbit-preload-'));
    mkdirSync(join(dir, 'dist'));
    const cli = join(dir, 'dist', 'cli.js');
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(
      cli,
      `import { spawn } from 'child_process';\nconst child = spawn(${JSON.stringify(command)}, { shell: true, stdio: 'ignore' });\nprocess.stdout.write(JSON.stringify(child.spawnargs));\nchild.on('exit', () => process.exit(0));\nchild.on('error', () => process.exit(0));\n`,
    );
    return cli;
  }

  it('patches the named spawn import of an unmodified CLI', () => {
    const cmd = srtCommand(profile(), 'true');
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(PRELOAD).href, fakeCli(cmd)], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const spawned = JSON.parse(r.stdout) as string[];
    expect(spawned.at(-1)).toBe(cmd.replace('(allow process-exec)', `(allow process-exec)\n${REGISTER}\n${LOOKUP}`));
  });

  it('exits 97 before running anything when the marker is tampered with', () => {
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(PRELOAD).href, fakeCli(srtCommand(profile().replace('(allow process-exec)', '(allow  process-exec)')))], { encoding: 'utf8' });
    expect(r.status).toBe(97);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/orbit srt-chromium-preload: .*refusing/);
  });

  it('records its refusal beside srt\'s settings file, where the sandboxed command cannot write, and nowhere without one', () => {
    const cmd = srtCommand(profile().replace('(allow process-exec)', '(allow  process-exec)'));
    const cli = fakeCli(cmd);
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, '{}');
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(PRELOAD).href, cli, '--settings', settings, '--', 'true'], { encoding: 'utf8' });
    expect(r.status).toBe(97);
    expect(readFileSync(join(dir, 'chromium-preload-refused'), 'utf8')).toMatch(/exactly once/);
    // Not a settings.json, or a relative one: nothing is written.
    rmSync(join(dir, 'chromium-preload-refused'));
    for (const args of [['--settings', join(dir, 'other.json')], ['--settings', 'settings.json'], ['--settings'], []]) {
      const r2 = spawnSync(process.execPath, ['--import', pathToFileURL(PRELOAD).href, cli, ...args], { encoding: 'utf8', cwd: dir });
      expect(r2.status).toBe(97);
      expect(existsSync(join(dir, 'chromium-preload-refused'))).toBe(false);
    }
  });

  it('records an exit without a patched sandbox, and never overwrites a record', async () => {
    const { mod } = await load();
    dir = mkdtempSync(join(tmpdir(), 'orbit-preload-'));
    const settings = join(dir, 'settings.json');
    const record = mod.refusalRecorder(['node', 'cli.js', '--settings', settings, '--', 'x']);
    const real = { spawn: vi.fn(), spawnSync: vi.fn(), exec: vi.fn(), execSync: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn() };
    const proc = { on: vi.fn(), exit: vi.fn(), stderr: { write: vi.fn() }, exitCode: undefined as number | undefined };
    mod.installSandboxExecHook(real, proc, () => {}, record);
    (proc.on.mock.calls[0]![1] as () => void)();
    expect(proc.exitCode).toBe(97);
    expect(readFileSync(join(dir, mod.REFUSAL_FILE), 'utf8')).toBe('srt exited without starting a patched sandbox\n');
    record('second');
    expect(readFileSync(join(dir, mod.REFUSAL_FILE), 'utf8')).toBe('srt exited without starting a patched sandbox\n');
  });

  it('exits 97 when the CLI exits without starting a sandbox', () => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-preload-'));
    const cli = join(dir, 'cli.mjs');
    writeFileSync(cli, 'process.exit(0);\n');
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(PRELOAD).href, cli], { encoding: 'utf8' });
    expect(r.status).toBe(97);
  });
});

// A second rule set, for .NET (docs/decisions/0009-toolchain-profiles.md, addendum): .NET's CookieContainer reads the
// NIS domain name, which srt's Seatbelt profile does not let a process read, so every .NET HTTP client failed, NuGet's
// restore included ("The type initializer for 'System.Net.CookieContainer' threw an exception ... GetDomainName: -1").
// Orbit names the sets it wants in the query of the preload's URL; each set is a constant of the preload.
describe('rule sets', () => {
  const NIS = '(allow sysctl-read (sysctl-name "kern.nisdomainname"))';

  it('holds exactly one read-only rule for the NIS domain name, and nothing else', async () => {
    const { mod } = await load();
    expect(mod.NIS_DOMAINNAME_RULES).toEqual([NIS]);
    expect(Object.isFrozen(mod.NIS_DOMAINNAME_RULES)).toBe(true);
    expect(Object.keys(mod.RULE_SETS)).toEqual(['chromium', 'nis-domainname']);
  });

  it('reads the sets from its URL: Chromium alone without a query, as before', async () => {
    const { mod } = await load();
    const url = pathToFileURL(PRELOAD).href;
    expect(mod.rulesFor(url)).toEqual([REGISTER, LOOKUP]);
    expect(mod.rulesFor(`${url}?rules=nis-domainname`)).toEqual([NIS]);
    expect(mod.rulesFor(`${url}?rules=chromium,nis-domainname`)).toEqual([REGISTER, LOOKUP, NIS]);
    for (const bad of ['?rules=', '?rules=acme', '?rules=chromium,chromium', '?rules=nis-domainname&rules=chromium', '?sets=chromium']) {
      expect(() => mod.rulesFor(`${url}${bad}`), bad).toThrow(/rule set/);
    }
  });

  it('inserts the rules it is given right after the one (allow process-exec)', async () => {
    const { mod } = await load();
    const cmd = srtCommand();
    expect(mod.patchSandboxExecCommand(cmd, [NIS])).toBe(cmd.replace('(allow process-exec)', `(allow process-exec)\n${NIS}`));
  });

  it('patches with the sets its URL names in a real node process, and refuses an unknown set before anything runs', () => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-preload-'));
    const cmd = srtCommand(profile(), 'true');
    const cli = join(dir, 'cli.mjs');
    writeFileSync(cli, `import { spawn } from 'child_process';\nconst child = spawn(${JSON.stringify(cmd)}, { shell: true, stdio: 'ignore' });\nprocess.stdout.write(JSON.stringify(child.spawnargs));\nchild.on('exit', () => process.exit(0));\nchild.on('error', () => process.exit(0));\n`);
    const url = pathToFileURL(PRELOAD).href;
    const r = spawnSync(process.execPath, ['--import', `${url}?rules=nis-domainname`, cli], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as string[]).at(-1)).toBe(cmd.replace('(allow process-exec)', `(allow process-exec)\n${NIS}`));
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, '{}');
    const bad = spawnSync(process.execPath, ['--import', `${url}?rules=acme`, cli, '--settings', settings, '--', 'true'], { encoding: 'utf8' });
    expect(bad.status).toBe(97);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toMatch(/orbit srt-chromium-preload: unknown rule set "acme"; refusing to start the sandbox \(exit 97\)/);
    expect(readFileSync(join(dir, 'chromium-preload-refused'), 'utf8')).toMatch(/unknown rule set "acme"/);
  });

  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
});
