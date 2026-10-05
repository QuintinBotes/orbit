import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { orbitTmpRoot, prepareWorkerTmpDir, profileForCheck, profileForWorker } from '../../../src/isolation/profiles.ts';
import type { SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { which } from '../../../src/isolation/util.ts';
import { checkFor, snapshotFor, tempRoot, writeExecutable } from '../../unit/isolation/fixtures.ts';
import { runWrapped } from './run.ts';

/**
 * Real processes under the real srt. Everything lives in a temp root with a
 * fake HOME, so the "credentials" read here are planted, never the user's.
 */
const orbitInstallDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const provider = new SandboxRuntimeIsolation({ orbitInstallDir });
const status = await provider.available();
const hasGit = which('git', process.env.PATH) !== null;
const curl = which('curl', process.env.PATH);

describe.skipIf(!status.ok)(status.ok ? 'sandbox-runtime isolation (real srt)' : `sandbox-runtime isolation skipped: ${status.detail}`, () => {
  // Collection runs this body even when the suite is skipped, so only create files when it will run.
  const t = status.ok ? tempRoot('orbit-srt-int-') : { root: '/nonexistent-orbit-test', remove: () => {} };
  const home = join(t.root, 'home');
  const repo = join(t.root, 'projects', 'acme');
  const worktree = join(home, '.orbit', 'worktrees', 'h', 'orb-1', 'w1');
  const outside = join(t.root, 'outside');
  const privateKey = 'FAKE-PRIVATE-KEY-acme';
  const wraps: WrappedCommand[] = [];
  let env: Record<string, string>;
  let checkProfile: SandboxProfile;

  beforeAll(() => {
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), privateKey);
    mkdirSync(join(t.root, 'projects', 'other'), { recursive: true });
    writeFileSync(join(t.root, 'projects', 'other', 'secret.txt'), 'other project');
    mkdirSync(join(repo, '.orbit'), { recursive: true });
    writeFileSync(join(repo, '.orbit', 'policy.json'), '{"frozen":true}');
    mkdirSync(outside);
    writeFileSync(join(repo, 'README.md'), 'acme\n');
    mkdirSync(dirname(worktree), { recursive: true });
    if (hasGit) {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
      git('init', '-q', '-b', 'main');
      git('add', 'README.md');
      git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'init');
      git('worktree', 'add', '-q', '-b', 'orbit-w1', worktree);
    } else {
      mkdirSync(worktree, { recursive: true });
    }
    env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
    checkProfile = profileForCheck({ worktree, check: checkFor(), snapshot: snapshotFor({ repoRoot: repo }), homeDir: home, env: {} });
  });

  afterAll(() => {
    for (const w of wraps) w.cleanup();
    t.remove();
    // The shared per-user root may hold real workers' directories; remove it only when this suite left it empty.
    try {
      rmdirSync(orbitTmpRoot());
    } catch {
      /* not empty, or already gone */
    }
  });

  function wrap(argv: string[], profile: SandboxProfile = checkProfile, extraEnv: Record<string, string> = {}): WrappedCommand {
    const w = provider.wrap(argv, profile, { cwd: worktree, env: { ...env, ...extraEnv } });
    wraps.push(w);
    return w;
  }

  it('writes inside the worktree and passes the exit status through', async () => {
    const r = await runWrapped(wrap(['sh', '-c', 'echo inside > made.txt; exit 7']), worktree);
    expect(r.code).toBe(7);
    expect(readFileSync(join(worktree, 'made.txt'), 'utf8')).toBe('inside\n');
  });

  it('cannot write outside the worktree', async () => {
    for (const target of [join(outside, 'f.txt'), join(home, 'planted.txt'), join(repo, '.orbit', 'policy.json'), join(repo, 'README.md')]) {
      const r = await runWrapped(wrap(['sh', '-c', 'echo tampered > "$1"', 'sh', target]), worktree);
      expect(r.code, target).not.toBe(0);
      expect(r.stderr, target).toMatch(/Operation not permitted/);
    }
    expect(existsSync(join(outside, 'f.txt'))).toBe(false);
    expect(existsSync(join(home, 'planted.txt'))).toBe(false);
    expect(readFileSync(join(repo, '.orbit', 'policy.json'), 'utf8')).toBe('{"frozen":true}');
  });

  it('cannot read ~/.ssh (a planted key under a fake HOME)', async () => {
    expect(readFileSync(join(home, '.ssh', 'id_ed25519'), 'utf8')).toBe(privateKey);
    const r = await runWrapped(wrap(['sh', '-c', 'cat "$HOME/.ssh/id_ed25519"; ls "$HOME/.ssh"']), worktree);
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain(privateKey);
    expect(r.stderr).toMatch(/Operation not permitted/);
  });

  it('cannot read sibling projects, the main checkout or Orbit state', async () => {
    for (const target of [join(t.root, 'projects', 'other', 'secret.txt'), join(repo, '.orbit', 'policy.json'), join(repo, 'README.md')]) {
      const r = await runWrapped(wrap(['cat', target]), worktree);
      expect(r.code, target).not.toBe(0);
      expect(r.stdout, target).toBe('');
    }
  });

  it.runIf(hasGit)('can still use git in its linked worktree, read-only', async () => {
    writeFileSync(join(worktree, 'README.md'), 'acme changed\n');
    const status = await runWrapped(wrap(['git', 'status', '--short']), worktree);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('M README.md');
    // The shared git directory is readable, not writable: staging is the controller's job.
    const add = await runWrapped(wrap(['git', 'add', 'README.md']), worktree);
    expect(add.code).not.toBe(0);
  });

  it('has no network when no hosts are allowed (local server control)', async () => {
    const server: Server = createServer((_q, res) => res.end('reachable'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const probe = `fetch(${JSON.stringify(url)}).then(r => r.text()).then(t => { console.log(t); }, e => { console.log('blocked', e.cause?.code ?? e.message); process.exit(3); })`;
      // Unsandboxed control first; async, because the server lives in this process.
      const direct = await new Promise<string>((done, fail) =>
        execFile(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 10_000 }, (err, out) => (err ? fail(err) : done(out))),
      );
      expect(direct.trim()).toBe('reachable');
      const r = await runWrapped(wrap([process.execPath, '-e', probe]), worktree);
      expect(r.code).toBe(3);
      expect(r.stdout).toMatch(/blocked/);
    } finally {
      server.close();
    }
  });

  it.runIf(curl !== null)('refuses a host that is not on the allowlist', async () => {
    const allowNpm = { ...checkProfile, allowedHosts: ['registry.npmjs.org'] };
    const r = await runWrapped(wrap([curl!, '-sS', '--max-time', '10', '-o', '/dev/null', 'https://example.com/'], allowNpm), worktree);
    expect(r.code).not.toBe(0);
    // The proxy's refusal, not a DNS or connectivity failure that would pass offline for any host.
    expect(r.stderr).toMatch(/CONNECT tunnel failed, response 403/);
  });

  it('passes argv through verbatim, including flags srt itself understands', async () => {
    const r = await runWrapped(wrap(['sh', '-c', 'printf "%s|" "$@"', 'sh', '-c', '--settings', 'a b', '--']), worktree);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('-c|--settings|a b|--|');
  });

  it('keeps a private TMPDIR the sandbox can write', async () => {
    const tmp = join(t.root, 'worker-tmp');
    mkdirSync(tmp, { mode: 0o700 });
    const profile = { ...checkProfile, writablePaths: [...checkProfile.writablePaths, tmp] };
    const r = await runWrapped(wrap(['sh', '-c', 'echo "$TMPDIR"; echo x > "$TMPDIR/t" && echo wrote'], profile, { TMPDIR: tmp }), worktree);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${tmp}\nwrote\n`);
  });

  it('confines a worker profile: own worktree, worker dir and private tmp, not another worker\'s tmp', async () => {
    const workerDir = join(repo, '.orbit', 'runs', 'orb-1', 'workers', 'w1');
    const otherWorkerDir = join(repo, '.orbit', 'runs', 'orb-1', 'workers', 'w2');
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(otherWorkerDir, { recursive: true });
    const tmp = prepareWorkerTmpDir(workerDir);
    const otherTmp = prepareWorkerTmpDir(otherWorkerDir);
    try {
      writeFileSync(join(otherTmp, 'scratch'), 'other worker');
      const profile = profileForWorker({
        worktree,
        workerDir,
        snapshot: snapshotFor({ repoRoot: repo }),
        provider: 'claude',
        claudeConfigDir: join(home, '.claude-cfg'),
        homeDir: home,
        env: {},
      });
      const script = [
        'echo t > "$TMPDIR/own" && cat "$TMPDIR/own"',
        `echo r > ${JSON.stringify(join(workerDir, 'result.txt'))} && echo worker-dir-ok`,
        `cat ${JSON.stringify(join(otherTmp, 'scratch'))} || echo other-tmp-denied`,
        `cat ${JSON.stringify(join(repo, '.orbit', 'policy.json'))} || echo policy-denied`,
      ].join('; ');
      const r = await runWrapped(wrap(['sh', '-c', script], profile, { TMPDIR: tmp }), worktree);
      expect(r.stdout).toBe('t\nworker-dir-ok\nother-tmp-denied\npolicy-denied\n');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(otherTmp, { recursive: true, force: true });
    }
  });

  it('does not let tools planted on PATH run outside the sandbox (reproduced escape)', async () => {
    // A sandboxed command may write the worktree, so it can plant tools in
    // node_modules/.bin. srt starts through `/usr/bin/env node`, `which` and
    // (macOS) `env` looked up on the PATH it is given, outside the sandbox.
    const wtBin = join(worktree, 'node_modules', '.bin');
    mkdirSync(wtBin, { recursive: true });
    const marker = join(home, 'ESCAPED');
    const realNode = process.execPath;
    const plant = (tool: string, target: string) =>
      writeExecutable(join(wtBin, tool), `echo "$0" >> ${JSON.stringify(marker)} 2>/dev/null || echo "planted ${tool} confined"\nexec ${JSON.stringify(target)} "$@"`);
    plant('env', '/usr/bin/env');
    plant('which', '/usr/bin/which');
    plant('node', realNode);
    try {
      const PATH = [wtBin, dirname(realNode), '/usr/bin', '/bin'].join(':');
      const r = await runWrapped(wrap(['sh', '-c', 'echo "$PATH"; env true; node -e "console.log(\'inner node\')"'], checkProfile, { PATH }), worktree);
      expect(existsSync(marker)).toBe(false);
      expect(r.code).toBe(0);
      // The command still gets its own PATH, and the planted tools run inside the sandbox.
      expect(r.stdout).toBe(`${PATH}\nplanted env confined\nplanted node confined\ninner node\n`);
    } finally {
      rmSync(wtBin, { recursive: true, force: true });
    }
  });

  it('does not let NODE_OPTIONS load worktree code into the launcher', async () => {
    const marker = join(home, 'ESCAPED-NODE');
    writeFileSync(join(worktree, 'setup.cjs'), `try { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); } catch { console.log('setup confined'); }\n`);
    try {
      const r = await runWrapped(wrap([process.execPath, '-e', 'console.log("inner")'], checkProfile, { NODE_OPTIONS: '--require ./setup.cjs' }), worktree);
      expect(existsSync(marker)).toBe(false);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('setup confined\ninner\n');
    } finally {
      rmSync(join(worktree, 'setup.cjs'), { force: true });
    }
  });

  it('keeps a worker away from host-executed config, trusted worker files and the main checkout', async () => {
    const workerDir = join(repo, '.orbit', 'runs', 'orb-1', 'workers', 'w3');
    const cfg = join(home, '.claude-cfg');
    mkdirSync(join(cfg, 'plugins', 'orbit'), { recursive: true });
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(cfg, 'settings.json'), '{}');
    writeFileSync(join(cfg, '.claude.json'), '{}');
    writeFileSync(join(workerDir, 'settings.json'), '{}');
    writeFileSync(join(home, '.claude.json'), '{"other":"login"}');
    writeFileSync(join(repo, '.env'), 'TOKEN=acme-main-checkout');
    const tmp = prepareWorkerTmpDir(workerDir);
    try {
      const profile = profileForWorker({ worktree, workerDir, snapshot: snapshotFor({ repoRoot: repo }), provider: 'claude', claudeConfigDir: cfg, homeDir: home, env: {} });
      const attempt = (label: string, cmd: string) => `if ${cmd} 2>/dev/null; then echo "${label}=open"; else echo "${label}=blocked"; fi`;
      const script = [
        attempt('settings', `echo '{"hooks":{}}' > ${JSON.stringify(join(cfg, 'settings.json'))}`),
        attempt('plugin', `echo x > ${JSON.stringify(join(cfg, 'plugins', 'orbit', 'hook.sh'))}`),
        attempt('global-config', `echo '{"mcpServers":{}}' > ${JSON.stringify(join(cfg, '.claude.json'))}`),
        attempt('exit-json', `echo '{"code":0}' > ${JSON.stringify(join(workerDir, 'exit.json'))}`),
        attempt('worker-settings', `echo x > ${JSON.stringify(join(workerDir, 'settings.json'))}`),
        attempt('transcript', `mkdir -p ${JSON.stringify(join(cfg, 'projects'))} && echo t > ${JSON.stringify(join(cfg, 'projects', 's.jsonl'))}`),
        attempt('read-global-config', `cat ${JSON.stringify(join(cfg, '.claude.json'))} >/dev/null`),
        attempt('read-other-login', `cat ${JSON.stringify(join(home, '.claude.json'))}`),
        attempt('read-main-checkout', `cat ${JSON.stringify(join(repo, '.env'))}`),
      ].join('\n');
      const r = await runWrapped(wrap(['sh', '-c', script], profile, { TMPDIR: tmp }), worktree);
      expect(r.stdout.trim().split('\n')).toEqual([
        'settings=blocked',
        'plugin=blocked',
        'global-config=blocked',
        'exit-json=blocked',
        'worker-settings=blocked',
        'transcript=open',
        'read-global-config=open',
        'read-other-login=blocked',
        'read-main-checkout=blocked',
      ]);
      expect(r.stdout).not.toContain('acme-main-checkout');
      expect(readFileSync(join(cfg, 'settings.json'), 'utf8')).toBe('{}');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps a worker shell from reading credential files in its own worktree', async () => {
    const workerDir = join(repo, '.orbit', 'runs', 'orb-1', 'workers', 'w4');
    mkdirSync(workerDir, { recursive: true });
    const planted = [join(worktree, '.env'), join(worktree, 'deploy', 'server.pem')];
    mkdirSync(join(worktree, 'deploy'), { recursive: true });
    writeFileSync(planted[0]!, 'TOKEN=acme-worktree-secret');
    writeFileSync(planted[1]!, 'acme-worktree-pem');
    writeFileSync(join(worktree, 'notes.txt'), 'plain acme notes');
    const tmp = prepareWorkerTmpDir(workerDir);
    try {
      const profile = profileForWorker({ worktree, workerDir, snapshot: snapshotFor({ repoRoot: repo }), provider: 'claude', claudeConfigDir: join(home, '.claude-cfg'), homeDir: home, env: {} });
      const attempt = (label: string, cmd: string) => `if ${cmd} 2>/dev/null; then echo "${label}=open"; else echo "${label}=blocked"; fi`;
      const script = [
        attempt('env', 'cat .env >/dev/null'),
        attempt('pem', 'cat deploy/server.pem >/dev/null'),
        attempt('env-redirect', 'sh -c "read x < .env"'),
        attempt('notes', 'cat notes.txt >/dev/null'),
      ].join('\n');
      const r = await runWrapped(wrap(['sh', '-c', script], profile, { TMPDIR: tmp }), worktree);
      expect(r.stdout.trim().split('\n')).toEqual(['env=blocked', 'pem=blocked', 'env-redirect=blocked', 'notes=open']);
      expect(r.stdout).not.toContain('acme-worktree-secret');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      for (const f of [...planted, join(worktree, 'notes.txt')]) rmSync(f, { force: true });
    }
  });

  it('reports exit 0 when the caller kills the group with SIGTERM (documented limitation)', async () => {
    const w = wrap(['sleep', '30']);
    expect(w.limitations.join('\n')).toMatch(/SIGTERM or SIGINT, srt exits 0/);
    const started = Date.now();
    const r = await runWrapped(w, worktree, { killAfterMs: 1_500, killSignal: 'SIGTERM' });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.code).toBe(0);
  });

  it('removes its settings file on cleanup', () => {
    const w = provider.wrap(['true'], checkProfile, { cwd: worktree, env });
    const file = w.argv[2]!;
    expect(existsSync(file)).toBe(true);
    w.cleanup();
    expect(existsSync(file)).toBe(false);
  });
});
