import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOrbitError } from '../../../src/core/errors.ts';
import {
  CLAUDE_CONFIG_DENIED,
  CLAUDE_CONFIG_READ_ONLY,
  CODEX_HOME_READ_ONLY,
  HOME_DENY_READ,
  PROVIDER_HOSTS,
  WORKER_DIR_READ_ONLY,
  codexReviewerProfile,
  orbitTmpRoot,
  prepareWorkerTmpDir,
  profileForCheck,
  profileForWorker,
  providerDirs,
  repoParentDenial,
  workerTmpDir,
} from '../../../src/isolation/profiles.ts';
import { buildSrtSettings } from '../../../src/isolation/sandbox-runtime.ts';
import { canonicalPath, isWithin } from '../../../src/isolation/util.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';
import { checkFor, snapshotFor, tempRoot } from './fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/**
 * The layout Orbit uses: projects side by side, worktrees under ~/.orbit,
 * worker directories under the repository's .orbit. The worktree is a real
 * linked-worktree shape so the git directory is discovered.
 */
function layout() {
  const t = tempRoot();
  cleanups.push(t.remove);
  const r = t.root;
  const home = join(r, 'home');
  const repo = join(r, 'projects', 'acme');
  const gitdir = join(repo, '.git', 'worktrees', 'w1');
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  const worktree = join(home, '.orbit', 'worktrees', 'h', 'orb-1', 'w1');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
  const workerDir = join(repo, '.orbit', 'runs', 'orb-1', 'workers', 'w1');
  mkdirSync(workerDir, { recursive: true });
  return { r, home, repo, worktree, workerDir, claudeDir: join(home, '.claude-alt') };
}

describe('profileForWorker', () => {
  it('lets a Claude worker write only its worktree, worker dir, private tmp and Claude config dir', () => {
    const l = layout();
    const p = profileForWorker({
      worktree: l.worktree,
      workerDir: l.workerDir,
      snapshot: snapshotFor({ repoRoot: l.repo, allowedHosts: ['registry.npmjs.org', 'api.anthropic.com'], wallMinutes: 30 }),
      provider: 'claude',
      claudeConfigDir: l.claudeDir,
      homeDir: l.home,
      env: {},
    });
    // ~/.claude.json belongs to the default login, not to this config dir: neither writable nor readable.
    expect(p.writablePaths).toEqual([l.worktree, l.workerDir, workerTmpDir(l.workerDir), l.claudeDir]);
    expect(p.allowedHosts).toEqual(['api.anthropic.com', 'claude.ai', 'platform.claude.com', 'registry.npmjs.org']);
    expect(p.limits).toEqual({ timeoutMs: 30 * 60_000, memoryMb: null, cpus: null, pids: null });
    expect(p.readablePaths).toContain(join(l.repo, '.git'));

    for (const rel of ['.ssh', '.aws', '.config/gh', '.gnupg', '.netrc', '.npmrc', '.docker', '.orbit', '.config/publish-guard']) {
      expect(p.denyReadPaths, rel).toContain(join(l.home, rel));
    }
    expect(p.denyReadPaths).toContain(join(l.repo, '.orbit'));
    // Other workers' temp directories; this worker's own is re-allowed by being writable.
    expect(p.denyReadPaths).toContain(orbitTmpRoot());
    expect(buildSrtSettings(p).filesystem.allowRead).toContain(workerTmpDir(l.workerDir));
    // Other projects next to the repository, the Codex login and the default Claude login are denied.
    expect(p.denyReadPaths).toContain(join(l.r, 'projects'));
    expect(p.denyReadPaths).toContain(join(l.home, '.codex'));
    expect(p.denyReadPaths).toContain(join(l.home, '.claude'));
    expect(p.denyReadPaths).toContain(join(l.home, '.claude.json'));
    expect(p.denyReadPaths).not.toContain(l.claudeDir);
  });

  it('keeps the config dir surfaces that run code on the host read-only', () => {
    const l = layout();
    const p = profileForWorker({
      worktree: l.worktree,
      workerDir: l.workerDir,
      snapshot: snapshotFor({ repoRoot: l.repo }),
      provider: 'claude',
      claudeConfigDir: l.claudeDir,
      homeDir: l.home,
      env: {},
    });
    const denyWrite = buildSrtSettings(p).filesystem.denyWrite;
    // Hooks, plugins (Orbit itself when installed as a plugin), settings and the global config with its MCP server commands.
    for (const rel of CLAUDE_CONFIG_READ_ONLY) expect(denyWrite, rel).toContain(join(l.claudeDir, rel));
    // Files the controller and the CLI trust in the worker directory.
    for (const rel of WORKER_DIR_READ_ONLY) expect(denyWrite, rel).toContain(join(l.workerDir, rel));
    // Transcripts and the rest of the config dir stay writable.
    expect(buildSrtSettings(p).filesystem.allowWrite).toContain(l.claudeDir);
    expect(denyWrite).not.toContain(join(l.claudeDir, 'projects'));
  });

  // Review of #31: a running IDE extension (VS Code, JetBrains) writes <config dir>/ide/<port>.lock with the auth token of
  // its MCP server on loopback (openFile, saveDocument, executeCode in a Jupyter kernel). A worker that could read the lock
  // and reach loopback could act through the IDE, outside its sandbox; a check never could (the whole config dir is denied
  // to it). Workers reach no loopback service today, so this is a second barrier, kept for any path to loopback.
  it('denies its own config dir\'s IDE lock directory, for reading and for writing, and keeps the rest of the dir writable', () => {
    const l = layout();
    for (const claudeConfigDir of [l.claudeDir, join(l.home, '.claude')]) {
      const p = profileForWorker({ worktree: l.worktree, workerDir: l.workerDir, snapshot: snapshotFor({ repoRoot: l.repo }), provider: 'claude', claudeConfigDir, homeDir: l.home, env: {} });
      expect(CLAUDE_CONFIG_DENIED).toEqual(['ide']);
      expect(p.denyReadPaths, claudeConfigDir).toContain(join(claudeConfigDir, 'ide'));
      const fs = buildSrtSettings(p).filesystem;
      expect(fs.denyRead).toContain(join(claudeConfigDir, 'ide'));
      expect(fs.denyWrite).toContain(join(claudeConfigDir, 'ide'));
      expect(fs.allowWrite).toContain(claudeConfigDir);
      expect(fs.denyRead).not.toContain(claudeConfigDir);
    }
    // A check already gets none of any Claude config dir.
    const check = profileForCheck({ worktree: l.worktree, check: checkFor(), snapshot: snapshotFor({ repoRoot: l.repo }), homeDir: l.home, claudeConfigDir: l.claudeDir, env: {} });
    expect(check.denyReadPaths).toEqual(expect.arrayContaining([l.claudeDir, join(l.home, '.claude')]));
  });

  it('treats ~/.claude.json as the global config of the default dir: readable, never writable', () => {
    const l = layout();
    const p = profileForWorker({
      worktree: l.worktree,
      workerDir: l.workerDir,
      snapshot: snapshotFor({ repoRoot: l.repo }),
      provider: 'claude',
      claudeConfigDir: join(l.home, '.claude'),
      homeDir: l.home,
      env: {},
    });
    expect(p.writablePaths).not.toContain(join(l.home, '.claude.json'));
    expect(p.denyReadPaths).not.toContain(join(l.home, '.claude.json'));
    expect(p.readablePaths).toContain(join(l.home, '.claude.json'));
  });

  it('denies the user\'s own login when the worker runs with a private config dir', () => {
    const l = layout();
    const userDir = join(l.home, '.claude-acme');
    const userCodex = join(l.home, '.codex-acme');
    const privateDir = join(l.workerDir, 'claude-config');
    const p = profileForWorker({
      worktree: l.worktree,
      workerDir: l.workerDir,
      snapshot: snapshotFor({ repoRoot: l.repo }),
      provider: 'claude',
      claudeConfigDir: privateDir,
      homeDir: l.home,
      env: { CLAUDE_CONFIG_DIR: userDir, CODEX_HOME: userCodex },
    });
    expect(p.writablePaths).toContain(privateDir);
    expect(p.denyReadPaths).toEqual(expect.arrayContaining([userDir, join(l.home, '.claude'), join(l.home, '.claude.json'), userCodex, join(l.home, '.codex')]));
    expect(p.denyReadPaths).not.toContain(privateDir);
  });

  it('lets the guard hook read the frozen policy without letting the worker change it', () => {
    const l = layout();
    const policy = join(l.repo, '.orbit', 'runs', 'orb-1', 'policy.json');
    const p = profileForWorker({
      worktree: l.worktree,
      workerDir: l.workerDir,
      snapshot: snapshotFor({ repoRoot: l.repo }),
      provider: 'claude',
      claudeConfigDir: l.claudeDir,
      homeDir: l.home,
      policyPath: policy,
      env: {},
    });
    const s = buildSrtSettings(p);
    expect(s.filesystem.allowRead).toContain(policy);
    expect(s.filesystem.allowWrite.some((w) => isWithin(policy, w))).toBe(false);
  });

  it('refuses a provider config dir that is the home directory or above it', () => {
    const l = layout();
    for (const dir of [l.home, l.r]) {
      let caught: unknown;
      try {
        profileForWorker({ worktree: l.worktree, workerDir: l.workerDir, snapshot: snapshotFor({ repoRoot: l.repo }), provider: 'codex', claudeConfigDir: l.claudeDir, homeDir: l.home, codexHome: dir, env: {} });
      } catch (err) {
        caught = err;
      }
      expect(isOrbitError(caught, 'ISOLATION_UNAVAILABLE'), dir).toBe(true);
    }
  });

  it('refuses a provider config dir that is, contains or sits inside the Orbit home (the service launcher lives there)', () => {
    const l = layout();
    const orbitHome = join(l.r, 'orbit-state');
    const refused = (dir: string, env: Record<string, string>, provider: 'claude' | 'codex'): string => {
      try {
        profileForWorker({ worktree: l.worktree, workerDir: l.workerDir, snapshot: snapshotFor({ repoRoot: l.repo }), provider, homeDir: l.home, env, ...(provider === 'codex' ? { codexHome: dir, claudeConfigDir: l.claudeDir } : { claudeConfigDir: dir }) });
        return 'no error';
      } catch (err) {
        return isOrbitError(err, 'ISOLATION_UNAVAILABLE') ? 'ISOLATION_UNAVAILABLE' : String(err);
      }
    };
    for (const provider of ['claude', 'codex'] as const) {
      // The default Orbit home, ~/.orbit, and the launcher directory inside it.
      expect(refused(join(l.home, '.orbit'), {}, provider), provider).toBe('ISOLATION_UNAVAILABLE');
      expect(refused(join(l.home, '.orbit', 'bin'), {}, provider), provider).toBe('ISOLATION_UNAVAILABLE');
      // ORBIT_HOME elsewhere: that directory, a directory inside it, and one that contains it.
      expect(refused(orbitHome, { ORBIT_HOME: orbitHome }, provider), provider).toBe('ISOLATION_UNAVAILABLE');
      expect(refused(join(orbitHome, 'bin'), { ORBIT_HOME: orbitHome }, provider), provider).toBe('ISOLATION_UNAVAILABLE');
      expect(refused(join(l.r, 'state'), { ORBIT_HOME: join(l.r, 'state', 'orbit') }, provider), provider).toBe('ISOLATION_UNAVAILABLE');
      // A directory of its own beside them is fine.
      expect(refused(join(l.r, 'provider-own'), { ORBIT_HOME: orbitHome }, provider), provider).toBe('no error');
    }
  });

  it('denies container-engine state and keychains, which hold root-equivalent sockets and keys', () => {
    const l = layout();
    const p = profileForWorker({ worktree: l.worktree, workerDir: l.workerDir, snapshot: snapshotFor({ repoRoot: l.repo }), provider: 'claude', claudeConfigDir: l.claudeDir, homeDir: l.home, env: {} });
    for (const rel of ['.orbstack', '.colima', '.lima', 'Library/Keychains', '.config/op', '.gemini']) expect(p.denyReadPaths, rel).toContain(join(l.home, rel));
    expect(p.denyReadPaths).toContain(canonicalPath('/var/run/docker.sock'));
  });

  it('lets a Codex worker write CODEX_HOME and denies every Claude login', () => {
    const l = layout();
    const codexHome = join(l.r, 'codex-home');
    const p = profileForWorker({
      worktree: l.worktree,
      workerDir: l.workerDir,
      snapshot: snapshotFor({ repoRoot: l.repo, container: { image: 'x', memory_mb: 512, cpus: 1, pids: 128 } }),
      provider: 'codex',
      claudeConfigDir: l.claudeDir,
      homeDir: l.home,
      env: { CODEX_HOME: codexHome },
      timeoutMs: 5_000,
    });
    expect(p.writablePaths).toEqual([l.worktree, l.workerDir, workerTmpDir(l.workerDir), codexHome]);
    expect(p.allowedHosts).toEqual(['api.openai.com', 'chatgpt.com']);
    expect(p.denyReadPaths).toEqual(expect.arrayContaining([l.claudeDir, join(l.claudeDir, '.claude.json'), join(l.home, '.claude'), join(l.home, '.claude.json'), join(l.home, '.codex')]));
    expect(p.denyReadPaths).not.toContain(codexHome);
    const denyWrite = buildSrtSettings(p).filesystem.denyWrite;
    for (const rel of CODEX_HOME_READ_ONLY) expect(denyWrite, rel).toContain(join(codexHome, rel));
    expect(p.limits).toEqual({ timeoutMs: 5_000, memoryMb: 512, cpus: 1, pids: 128 });
  });

  it('does not deny the default Claude dir when it is the configured one', () => {
    const l = layout();
    const p = profileForWorker({
      worktree: l.worktree,
      workerDir: l.workerDir,
      snapshot: snapshotFor({ repoRoot: l.repo }),
      provider: 'claude',
      claudeConfigDir: join(l.home, '.claude'),
      homeDir: l.home,
      env: {},
    });
    expect(p.writablePaths).toContain(join(l.home, '.claude'));
    expect(p.denyReadPaths).not.toContain(join(l.home, '.claude'));
  });

  it('translates into srt rules that re-open exactly the worker’s own paths', () => {
    const l = layout();
    const install = join(l.r, 'projects', 'orbit');
    const p = profileForWorker({
      worktree: l.worktree,
      workerDir: l.workerDir,
      snapshot: snapshotFor({ repoRoot: l.repo }),
      provider: 'claude',
      claudeConfigDir: l.claudeDir,
      homeDir: l.home,
      readablePaths: [install],
      env: {},
    });
    const s = buildSrtSettings(p);
    // Worktree under ~/.orbit, worker dir under <repo>/.orbit, git dir and Orbit's install dir under the denied projects dir.
    expect(s.filesystem.allowRead).toEqual(expect.arrayContaining([l.worktree, l.workerDir, join(l.repo, '.git'), install]));
    expect(s.filesystem.allowRead).not.toContain(join(l.repo, '.orbit'));
    expect(s.filesystem.allowRead).not.toContain(l.repo);
    expect(s.network.allowedDomains).toEqual(PROVIDER_HOSTS.claude);
  });

  // Issue #31: srt's allowLocalBinding lets a process listen on every address of this machine, not on loopback only
  // (measured: a listener on 0.0.0.0 answered on the LAN address), and Seatbelt has no rule that narrows it. A worker runs
  // model-driven commands, so it gets none: a server it started could serve what it may read to the network.
  it('never lets a worker listen, on any address, whatever its snapshot carries, and leaves its outbound rules alone', () => {
    const l = layout();
    const snapshot = snapshotFor({ repoRoot: l.repo, allowedHosts: ['registry.npmjs.org'] });
    const p = profileForWorker({ worktree: l.worktree, workerDir: l.workerDir, snapshot, provider: 'claude', claudeConfigDir: l.claudeDir, homeDir: l.home, env: {} });
    expect(p.allowLocalBinding).toBeUndefined();
    expect(buildSrtSettings(p).network).toMatchObject({ allowLocalBinding: false, allowedDomains: ['api.anthropic.com', 'claude.ai', 'platform.claude.com', 'registry.npmjs.org'] });
    // A snapshot a development build froze with the key it no longer has: still nothing.
    const stray = { ...snapshot, config: { ...snapshot.config, network: { ...snapshot.config.network, local_binding: true } } } as PolicySnapshot;
    const q = profileForWorker({ worktree: l.worktree, workerDir: l.workerDir, snapshot: stray, provider: 'claude', claudeConfigDir: l.claudeDir, homeDir: l.home, env: {} });
    expect(q).toEqual(p);
    // A check keeps its own local_binding (default true), unchanged.
    expect(profileForCheck({ worktree: l.worktree, check: checkFor(), snapshot, homeDir: l.home, claudeConfigDir: l.claudeDir, env: {} }).allowLocalBinding).toBe(true);
  });

  it('refuses a snapshot without a repository root', () => {
    const l = layout();
    let caught: unknown;
    try {
      profileForWorker({ worktree: l.worktree, workerDir: l.workerDir, snapshot: snapshotFor({ repoRoot: '' }), provider: 'claude', claudeConfigDir: l.claudeDir, homeDir: l.home });
    } catch (err) {
      caught = err;
    }
    expect(isOrbitError(caught, 'INTERNAL')).toBe(true);
  });
});

describe('profileForCheck', () => {
  it('gives a check its worktree, extra outputs and declared hosts, and no provider credentials', () => {
    const l = layout();
    const out = join(l.r, 'evidence');
    const p = profileForCheck({
      worktree: l.worktree,
      check: checkFor({ timeout_seconds: 90, network_hosts: ['registry.npmjs.org'] }),
      snapshot: snapshotFor({ repoRoot: l.repo, allowedHosts: ['github.com'] }),
      extraWritable: [out],
      homeDir: l.home,
      env: { CLAUDE_CONFIG_DIR: l.claudeDir },
    });
    expect(p.writablePaths).toEqual([l.worktree, out]);
    // Only the check's own hosts; the policy-wide list is not inherited.
    expect(p.allowedHosts).toEqual(['registry.npmjs.org']);
    expect(p.limits.timeoutMs).toBe(90_000);
    expect(p.denyReadPaths).toEqual(
      expect.arrayContaining([l.claudeDir, join(l.home, '.claude'), join(l.home, '.claude.json'), join(l.home, '.codex'), join(l.repo, '.orbit'), join(l.r, 'projects')]),
    );
    expect(p.denyReadPaths).toEqual(expect.arrayContaining(HOME_DENY_READ.map((rel) => join(l.home, rel))));
  });

  it('lets a check listen on loopback by default and refuses it when local_binding is false, without touching the outbound rules', () => {
    const l = layout();
    const profile = (check: ReturnType<typeof checkFor>) => profileForCheck({ worktree: l.worktree, check, snapshot: snapshotFor({ repoRoot: l.repo, allowedHosts: ['github.com'] }), homeDir: l.home, env: {} });
    const open = profile(checkFor({ local_binding: true, network_hosts: ['github.com'] }));
    const strict = profile(checkFor({ local_binding: false, network_hosts: ['github.com'] }));
    expect(open.allowLocalBinding).toBe(true);
    expect(strict.allowLocalBinding).toBe(false);
    // The two profiles differ in nothing else: hosts, paths and limits are the check's own either way.
    expect({ ...open, allowLocalBinding: false }).toEqual(strict);
    expect(open.allowedHosts).toEqual(['github.com']);
    expect(profile(checkFor()).allowLocalBinding).toBe(true);
    // A definition frozen into an older snapshot has no such key; it reads as the default.
    const { local_binding: _omitted, ...older } = checkFor();
    expect(profile(older as ReturnType<typeof checkFor>).allowLocalBinding).toBe(true);
  });

  it('means no network for a check that names no hosts', () => {
    const l = layout();
    const p = profileForCheck({ worktree: l.worktree, check: checkFor(), snapshot: snapshotFor({ repoRoot: l.repo, allowedHosts: ['github.com'] }), homeDir: l.home, env: {} });
    expect(p.allowedHosts).toEqual([]);
  });
});

describe('credential files inside the worktree', () => {
  function plant(worktree: string): string[] {
    const files = ['.env', '.env.production', 'config/server.pem', 'deploy/.npmrc', 'deploy/keys/id_ed25519', 'docs/.netrc'];
    for (const rel of files) {
      mkdirSync(join(worktree, rel, '..'), { recursive: true });
      writeFileSync(join(worktree, rel), 'synthetic acme secret\n');
    }
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'index.ts'), 'export {};\n');
    mkdirSync(join(worktree, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(worktree, 'node_modules', 'pkg', '.env'), 'vendored\n');
    return files.map((rel) => join(worktree, rel));
  }

  it('are on a worker\'s OS read-deny list, with the rest of the worktree still readable', () => {
    const l = layout();
    const planted = plant(l.worktree);
    const p = profileForWorker({ worktree: l.worktree, workerDir: l.workerDir, snapshot: snapshotFor({ repoRoot: l.repo }), provider: 'claude', claudeConfigDir: l.claudeDir, homeDir: l.home, env: {} });
    for (const f of planted) expect(p.denyReadPaths, f).toContain(f);
    expect(p.denyReadPaths).not.toContain(join(l.worktree, 'src', 'index.ts'));
    expect(p.denyReadPaths).not.toContain(l.worktree);
    // srt keeps a deny inside a re-allowed worktree as the more specific rule.
    const srt = buildSrtSettings(p).filesystem;
    expect(srt.denyRead).toContain(join(l.worktree, '.env'));
    expect(srt.allowRead).toContain(l.worktree);
  });

  it('are on a check\'s read-deny list too', () => {
    const l = layout();
    const planted = plant(l.worktree);
    const p = profileForCheck({ worktree: l.worktree, check: checkFor(), snapshot: snapshotFor({ repoRoot: l.repo }), homeDir: l.home, env: {} });
    for (const f of planted) expect(p.denyReadPaths, f).toContain(f);
  });

  it('include one a symlink names, by the file it reaches', () => {
    const l = layout();
    writeFileSync(join(l.worktree, 'real.txt'), 'x\n');
    symlinkSync(join(l.worktree, 'real.txt'), join(l.worktree, '.env.local'));
    const p = profileForWorker({ worktree: l.worktree, workerDir: l.workerDir, snapshot: snapshotFor({ repoRoot: l.repo }), provider: 'claude', claudeConfigDir: l.claudeDir, homeDir: l.home, env: {} });
    expect(p.denyReadPaths).toContain(join(l.worktree, 'real.txt'));
  });
});

describe('credential enumeration covers the policy and node_modules, and fails closed', () => {
  function worker(l: ReturnType<typeof layout>, extra: { protectedPaths?: string[]; credentialWalkLimit?: number } = {}) {
    return profileForWorker({
      worktree: l.worktree,
      workerDir: l.workerDir,
      snapshot: snapshotFor({ repoRoot: l.repo, ...(extra.protectedPaths ? { protectedPaths: extra.protectedPaths } : {}) }),
      provider: 'claude',
      claudeConfigDir: l.claudeDir,
      homeDir: l.home,
      env: {},
      ...(extra.credentialWalkLimit === undefined ? {} : { credentialWalkLimit: extra.credentialWalkLimit }),
    });
  }

  function plantFile(worktree: string, rel: string): string {
    mkdirSync(join(worktree, rel, '..'), { recursive: true });
    writeFileSync(join(worktree, rel), 'synthetic acme value\n');
    return join(worktree, rel);
  }

  it('puts files named by the policy\'s protected credential globs on the read-deny list', () => {
    const l = layout();
    const secret = plantFile(l.worktree, 'secrets/db-password.txt');
    const key = plantFile(l.worktree, 'config/prod.key');
    const workflow = plantFile(l.worktree, '.github/workflows/ci.yml');
    const infra = plantFile(l.worktree, 'infra/main.tf');
    const p = worker(l, { protectedPaths: ['.github/**', 'infra/**', 'secrets/**', 'config/*.key'] });
    // A directory the glob names (`secrets/**` names `secrets`) is denied as a whole, which covers the file.
    // (The worktree itself sits under a denied directory and is re-allowed, so only denies inside it count.)
    const covered = (f: string) => p.denyReadPaths.some((d) => d !== l.worktree && isWithin(d, l.worktree) && isWithin(f, d));
    expect(covered(secret)).toBe(true);
    expect(covered(key)).toBe(true);
    // Protected for writing is not unreadable: a worker repairing CI must still read the workflow and the infra code.
    expect(covered(workflow)).toBe(false);
    expect(covered(infra)).toBe(false);
  });

  it('does the same for a check', () => {
    const l = layout();
    const secret = plantFile(l.worktree, 'secrets/db-password.txt');
    const p = profileForCheck({ worktree: l.worktree, check: checkFor(), snapshot: snapshotFor({ repoRoot: l.repo, protectedPaths: ['secrets/**'] }), homeDir: l.home, env: {} });
    expect(p.denyReadPaths.some((d) => d !== l.worktree && isWithin(d, l.worktree) && isWithin(secret, d))).toBe(true);
  });

  it('does not skip node_modules', () => {
    const l = layout();
    const vendored = plantFile(l.worktree, 'node_modules/pkg/.env');
    const nestedKey = plantFile(l.worktree, 'node_modules/@acme/tool/certs/server.pem');
    const p = worker(l);
    expect(p.denyReadPaths).toContain(vendored);
    expect(p.denyReadPaths).toContain(nestedKey);
  });

  it('refuses to build a worker profile when the walk hits its traversal cap', () => {
    const l = layout();
    for (let i = 0; i < 12; i++) plantFile(l.worktree, `src/file-${i}.ts`);
    plantFile(l.worktree, '.env');
    let caught: unknown;
    try {
      worker(l, { credentialWalkLimit: 5 });
    } catch (err) {
      caught = err;
    }
    expect(isOrbitError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('ISOLATION_UNAVAILABLE');
    expect((caught as Error).message).toMatch(/credential/i);
    expect((caught as Error).message).toMatch(/5/);
  });

  it('refuses for a check as well, and still builds when the cap is not reached', () => {
    const l = layout();
    for (let i = 0; i < 12; i++) plantFile(l.worktree, `src/file-${i}.ts`);
    const check = (limit: number) => profileForCheck({ worktree: l.worktree, check: checkFor(), snapshot: snapshotFor({ repoRoot: l.repo }), homeDir: l.home, env: {}, credentialWalkLimit: limit });
    expect(() => check(5)).toThrow(/credential/i);
    expect(() => check(1000)).not.toThrow();
  });
});

describe('repoParentDenial', () => {
  it('denies the projects directory when that is safe', () => {
    const l = layout();
    expect(repoParentDenial(l.repo, l.home).path).toBe(join(l.r, 'projects'));
  });

  it('never denies the home directory, its ancestors, the root or a shared temp root', () => {
    const l = layout();
    expect(repoParentDenial(join(l.home, 'acme'), l.home)).toMatchObject({ path: null, reason: expect.stringMatching(/contains the home directory/) });
    expect(repoParentDenial('/acme', l.home).path).toBeNull();
    // A home outside the temp roots, so the temp rule is what decides.
    const home = '/nonexistent-orbit-home/acme';
    expect(repoParentDenial(join(tmpdir(), 'acme'), home)).toMatchObject({ path: null, reason: expect.stringMatching(/shared temp directory/) });
    expect(repoParentDenial('/tmp/acme', home)).toMatchObject({ path: null, reason: expect.stringMatching(/shared temp directory/) });
    expect(repoParentDenial(join(tmpdir(), 'projects', 'acme'), home).path).toBe(join(canonicalPath(tmpdir()), 'projects'));
  });
});

describe('the main checkout', () => {
  it('is denied even when its parent cannot be, with the git directory re-allowed', () => {
    const l = layout();
    // A repository directly in the home directory: the parent (home) cannot be denied.
    const repo = join(l.home, 'acme');
    const gitdir = join(repo, '.git', 'worktrees', 'w1');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    writeFileSync(join(repo, '.env'), 'TOKEN=acme');
    const worktree = join(l.home, '.orbit', 'worktrees', 'h2', 'orb-1', 'w1');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
    const p = profileForCheck({ worktree, check: checkFor(), snapshot: snapshotFor({ repoRoot: repo }), homeDir: l.home, env: {} });
    expect(p.denyReadPaths).toContain(repo);
    expect(p.denyReadPaths).not.toContain(l.home);
    const s = buildSrtSettings(p);
    expect(s.filesystem.allowRead).toEqual(expect.arrayContaining([worktree, join(repo, '.git')]));
    expect(s.filesystem.allowRead).not.toContain(repo);
  });

  it('is not denied when the checks run in the checkout itself', () => {
    const l = layout();
    const p = profileForCheck({ worktree: l.repo, check: checkFor(), snapshot: snapshotFor({ repoRoot: l.repo }), homeDir: l.home, env: {} });
    expect(p.denyReadPaths).not.toContain(l.repo);
    const s = buildSrtSettings(p);
    expect(s.filesystem.allowWrite).toEqual([l.repo]);
    // .orbit inside it stays unreadable and unwritable.
    expect(s.filesystem.denyWrite).toContain(join(l.repo, '.orbit'));
  });
});

describe('provider directories and the worker tmp dir', () => {
  it('follows CLAUDE_CONFIG_DIR and CODEX_HOME, ignoring blank values', () => {
    const l = layout();
    expect(providerDirs({ homeDir: l.home, env: {} })).toEqual({ claudeConfigDir: join(l.home, '.claude'), codexHome: join(l.home, '.codex') });
    expect(providerDirs({ homeDir: l.home, env: { CLAUDE_CONFIG_DIR: l.claudeDir, CODEX_HOME: ' ' } })).toEqual({ claudeConfigDir: l.claudeDir, codexHome: join(l.home, '.codex') });
    expect(providerDirs({ homeDir: l.home, claudeConfigDir: '/opt/c', codexHome: '/opt/x', env: { CLAUDE_CONFIG_DIR: l.claudeDir } })).toEqual({
      claudeConfigDir: canonicalPath('/opt/c'),
      codexHome: canonicalPath('/opt/x'),
    });
  });

  it('keeps worker temp directories short, stable and under a per-user root', () => {
    const l = layout();
    const uid = process.getuid!();
    expect(orbitTmpRoot(uid)).toBe(canonicalPath(`/tmp/orbit-${uid}`));
    const dir = workerTmpDir(l.workerDir);
    expect(dir).toMatch(new RegExp(`^${orbitTmpRoot(uid)}/[0-9a-f]{12}$`));
    expect(workerTmpDir(l.workerDir)).toBe(dir);
    expect(workerTmpDir(join(l.workerDir, '..', 'w2'))).not.toBe(dir);
    // Unix socket paths must stay under 104 bytes on macOS.
    expect(dir.length).toBeLessThan(60);
  });

  it('creates the private tmp dir owner-only', () => {
    const l = layout();
    const root = join(l.r, 'tmp-root');
    const dir = prepareWorkerTmpDir(l.workerDir, root);
    expect(dir).toBe(workerTmpDir(l.workerDir, root));
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(prepareWorkerTmpDir(l.workerDir, root)).toBe(dir);
  });

  it('refuses a temp root that someone else could read or replace', () => {
    const l = layout();
    const open = join(l.r, 'open-root');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(() => prepareWorkerTmpDir(l.workerDir, open)).toThrow(/not a private directory/);
    const target = join(l.r, 'elsewhere');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(l.r, 'link-root'));
    let caught: unknown;
    try {
      prepareWorkerTmpDir(l.workerDir, join(l.r, 'link-root'));
    } catch (err) {
      caught = err;
    }
    expect(isOrbitError(caught, 'ISOLATION_UNAVAILABLE')).toBe(true);
  });
});

describe('codexReviewerProfile: the os-sandbox tier, where srt is the only sandbox around Codex', () => {
  function reviewerLayout(codexName = '.codex-reviewer') {
    const l = layout();
    const codexHome = join(l.home, codexName);
    mkdirSync(codexHome, { recursive: true });
    const snapshot = snapshotFor({ repoRoot: l.repo, allowedHosts: ['registry.npmjs.org'] });
    const worker = profileForWorker({ worktree: l.worktree, workerDir: l.workerDir, snapshot, provider: 'codex', claudeConfigDir: l.claudeDir, homeDir: l.home, codexHome, env: {} });
    const input = { checkout: l.worktree, workerDir: l.workerDir, codexHome, homeDir: l.home };
    return { l, codexHome, worker, input, profile: codexReviewerProfile(worker, input) };
  }

  it('writes only the worker directory and Codex state, never the review checkout', () => {
    const { l, codexHome, worker, profile } = reviewerLayout();
    // The generic Codex worker profile may write its worktree and private tmp; the reviewer profile may not.
    expect(worker.writablePaths).toEqual(expect.arrayContaining([l.worktree, workerTmpDir(l.workerDir)]));
    expect(profile.writablePaths).toEqual([l.workerDir, codexHome]);
    const srt = buildSrtSettings(profile);
    expect(srt.filesystem.allowWrite).toEqual([l.workerDir, codexHome]);
    expect(srt.filesystem.allowWrite.some((w) => isWithin(l.worktree, w))).toBe(false);
  });

  it('reaches only the Codex provider hosts, not the policy hosts', () => {
    const { worker, profile } = reviewerLayout();
    expect(worker.allowedHosts).toContain('registry.npmjs.org');
    expect(profile.allowedHosts).toEqual(['api.openai.com', 'chatgpt.com']);
    expect(profile.allowedHosts).toEqual([...PROVIDER_HOSTS.codex]);
    expect(buildSrtSettings(profile).network.allowedDomains).toEqual(['api.openai.com', 'chatgpt.com']);
    expect(profile.allowLocalBinding).toBeUndefined();
  });

  it('keeps the checkout readable although it sits under a denied directory, and unwritable', () => {
    const { l, profile } = reviewerLayout();
    const srt = buildSrtSettings(profile);
    expect(srt.filesystem.denyRead).toContain(join(l.home, '.orbit'));
    expect(srt.filesystem.allowRead).toContain(l.worktree);
    expect(srt.filesystem.allowWrite).not.toContain(l.worktree);
    expect(srt.filesystem.denyWrite).not.toContain(l.worktree);
    // git still works in the linked worktree: its shared directory stays readable.
    expect(srt.filesystem.allowRead).toContain(join(l.repo, '.git'));
  });

  it('denies every credential location except Codex own state directory, which holds the auth file it must read', () => {
    const { l, codexHome, profile } = reviewerLayout();
    for (const rel of ['.ssh', '.aws', '.config/gh', '.gnupg', '.netrc', '.npmrc', '.orbit']) expect(profile.denyReadPaths, rel).toContain(join(l.home, rel));
    // Another Codex login (the default ~/.codex here), and every Claude login.
    expect(profile.denyReadPaths).toEqual(expect.arrayContaining([join(l.home, '.codex'), l.claudeDir, join(l.home, '.claude'), join(l.home, '.claude.json')]));
    const srt = buildSrtSettings(profile);
    for (const p of [codexHome, join(codexHome, 'auth.json')]) {
      expect(profile.denyReadPaths).not.toContain(p);
      expect(srt.filesystem.denyRead).not.toContain(p);
    }
    // The login may be refreshed in place, so the auth file is writable; the entries that run code on the host are not.
    expect(srt.filesystem.allowWrite).toContain(codexHome);
    expect(srt.filesystem.denyWrite).not.toContain(join(codexHome, 'auth.json'));
    for (const rel of CODEX_HOME_READ_ONLY) expect(srt.filesystem.denyWrite, rel).toContain(join(codexHome, rel));
    for (const rel of WORKER_DIR_READ_ONLY) expect(srt.filesystem.denyWrite, rel).toContain(join(l.workerDir, rel));
  });

  it('uses its own Codex state directory even when the caller\'s profile counted it as another login', () => {
    const l = layout();
    const mine = join(l.home, '.codex-mine');
    mkdirSync(mine, { recursive: true });
    // The caller named another configured directory, so CODEX_HOME (the one Codex will really use) reads as another login to it.
    const worker = profileForWorker({ worktree: l.worktree, workerDir: l.workerDir, snapshot: snapshotFor({ repoRoot: l.repo }), provider: 'codex', claudeConfigDir: l.claudeDir, homeDir: l.home, codexHome: join(l.home, '.codex-callers'), env: { CODEX_HOME: mine } });
    expect(worker.denyReadPaths).toContain(mine);
    const profile = codexReviewerProfile(worker, { checkout: l.worktree, workerDir: l.workerDir, codexHome: mine, homeDir: l.home });
    expect(profile.denyReadPaths).not.toContain(mine);
    expect(profile.denyReadPaths).toContain(join(l.home, '.codex'));
    expect(profile.writablePaths).toEqual([l.workerDir, mine]);
    expect(() => buildSrtSettings(profile)).not.toThrow();
  });

  it('refuses any layout in which a writable path overlaps the review checkout', () => {
    const { l, worker, codexHome } = reviewerLayout();
    const refused = (input: { checkout: string; workerDir: string; codexHome: string }) => {
      try {
        codexReviewerProfile(worker, { ...input, homeDir: l.home });
      } catch (err) {
        return isOrbitError(err) ? err.code : String(err);
      }
      return 'no error';
    };
    // CODEX_HOME at, inside or above the checkout; the worker directory the same.
    expect(refused({ checkout: l.worktree, workerDir: l.workerDir, codexHome: l.worktree })).toBe('ISOLATION_UNAVAILABLE');
    expect(refused({ checkout: l.worktree, workerDir: l.workerDir, codexHome: join(l.worktree, '.codex') })).toBe('ISOLATION_UNAVAILABLE');
    expect(refused({ checkout: l.worktree, workerDir: join(l.worktree, 'worker'), codexHome })).toBe('ISOLATION_UNAVAILABLE');
    expect(refused({ checkout: join(l.workerDir, 'checkout'), workerDir: l.workerDir, codexHome })).toBe('ISOLATION_UNAVAILABLE');
    expect(refused({ checkout: join(codexHome, 'checkout'), workerDir: l.workerDir, codexHome })).toBe('ISOLATION_UNAVAILABLE');
    // A Codex home that is the home directory or above it would hand over every dotfile.
    expect(refused({ checkout: l.worktree, workerDir: l.workerDir, codexHome: l.home })).toBe('ISOLATION_UNAVAILABLE');
    expect(refused({ checkout: l.worktree, workerDir: l.workerDir, codexHome: l.r })).toBe('ISOLATION_UNAVAILABLE');
    // Nor the Orbit home or anything in it: the service launcher in ~/.orbit/bin runs outside any sandbox.
    expect(refused({ checkout: l.worktree, workerDir: l.workerDir, codexHome: join(l.home, '.orbit', 'bin') })).toBe('ISOLATION_UNAVAILABLE');
    expect(refused({ checkout: l.worktree, workerDir: l.workerDir, codexHome })).toBe('no error');
  });

  it('keeps the limits and the other read rules of the profile it narrows', () => {
    const { worker, profile } = reviewerLayout();
    expect(profile.limits).toEqual(worker.limits);
    expect(profile.denyReadPaths).toEqual(expect.arrayContaining(worker.denyReadPaths));
    expect(profile.readablePaths).toEqual(expect.arrayContaining(worker.readablePaths));
  });
});
