import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../../src/adapters/codex.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';
import { PROVIDER_HOSTS, codexReviewerProfile, profileForWorker } from '../../../src/isolation/profiles.ts';
import { SandboxRuntimeIsolation, buildSrtSettings } from '../../../src/isolation/sandbox-runtime.ts';
import type { SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { which } from '../../../src/isolation/util.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { snapshotFor, tempRoot } from '../../unit/isolation/fixtures.ts';
import { runWrapped } from '../isolation/run.ts';
import { FAKE_CODEX, REVIEW_OUTPUT, implementerSpec, makeFixture, waitFor, writeScenario, type Fixture } from './helpers.ts';

/**
 * The Codex reviewer in the os-sandbox tier, under the real srt: srt is the
 * only sandbox (Codex's own cannot start inside it on macOS), so its profile
 * is what keeps the review checkout read-only, the network closed to all but
 * the provider, and credentials unread. Skipped only when srt cannot run
 * here (no binary, or an outer sandbox that forbids nesting).
 */
const ORBIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const srt = new SandboxRuntimeIsolation({ orbitInstallDir: ORBIT_ROOT });
const srtStatus = await srt.available();
const hasGit = which('git', process.env.PATH) !== null;
const curl = which('curl', process.env.PATH);

describe.skipIf(!srtStatus.ok)(srtStatus.ok ? 'Codex reviewer profile under real srt' : `Codex reviewer profile skipped: ${srtStatus.detail}`, () => {
  // Collection runs this body even when the suite is skipped, so only create files when it will run.
  const t = srtStatus.ok ? tempRoot('orbit-codex-srt-') : { root: '/nonexistent-orbit-test', remove: () => {} };
  const home = join(t.root, 'home');
  const repo = join(t.root, 'projects', 'acme');
  // The default layout: the review checkout under ~/.orbit, a denied directory the profile has to re-open for reading.
  const checkout = join(home, '.orbit', 'worktrees', 'h', 'orb-1', 'rev-1');
  const workerDir = join(repo, '.orbit', 'runs', 'orb-1', 'workers', 'rev-1');
  const codexHome = join(home, '.codex-reviewer');
  const otherCodexHome = join(home, '.codex');
  const wraps: WrappedCommand[] = [];
  let env: Record<string, string>;
  let profile: SandboxProfile;

  beforeAll(() => {
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'FAKE-PRIVATE-KEY-acme');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-acme-own"}');
    mkdirSync(otherCodexHome, { recursive: true });
    writeFileSync(join(otherCodexHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-acme-other-login"}');
    mkdirSync(join(repo, '.orbit'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), 'acme\n');
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(join(workerDir, 'tmp'), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(checkout), { recursive: true });
    if (hasGit) {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
      git('init', '-q', '-b', 'main');
      git('add', 'README.md');
      git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'init');
      git('worktree', 'add', '-q', '-b', 'orbit-rev-1', checkout);
    } else {
      mkdirSync(checkout, { recursive: true });
      writeFileSync(join(checkout, 'README.md'), 'acme\n');
    }
    env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome, TMPDIR: join(workerDir, 'tmp'), GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
    // What the controller builds for a Codex worker, narrowed the way the adapter narrows it for a reviewer.
    const worker = profileForWorker({ worktree: checkout, workerDir, snapshot: snapshotFor({ repoRoot: repo, allowedHosts: ['registry.npmjs.org'] }), provider: 'codex', claudeConfigDir: join(home, '.claude'), codexHome, homeDir: home, env: {} });
    profile = codexReviewerProfile(worker, { checkout, workerDir, codexHome, homeDir: home });
  });

  afterAll(() => {
    for (const w of wraps) w.cleanup();
    t.remove();
  });

  const run = (script: string, ...args: string[]) => {
    const w = srt.wrap(['sh', '-c', script, 'sh', ...args], profile, { cwd: checkout, env });
    wraps.push(w);
    return runWrapped(w, checkout);
  };

  it('cannot write into the review checkout, while it can read it', async () => {
    for (const target of [join(checkout, 'planted.txt'), join(checkout, 'README.md')]) {
      const r = await run('echo tampered > "$1"', target);
      expect(r.code, target).not.toBe(0);
      expect(r.stderr, target).toMatch(/Operation not permitted/);
    }
    const mk = await run('mkdir "$1"', join(checkout, 'newdir'));
    expect(mk.code).not.toBe(0);
    expect(existsSync(join(checkout, 'planted.txt'))).toBe(false);
    expect(existsSync(join(checkout, 'newdir'))).toBe(false);
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('acme\n');
    // Not "everything denied": the checkout sits under a denied ~/.orbit and is still readable.
    const read = await run('cat "$1"', join(checkout, 'README.md'));
    expect(read.stdout).toBe('acme\n');
    if (hasGit) {
      const status = await run('git status --short && echo clean');
      expect(status.code).toBe(0);
      const add = await run('git add README.md');
      expect(add.code).not.toBe(0);
    }
  });

  it('writes the worker directory (not its trusted files), its temp directory and Codex state', async () => {
    const r = await run(
      'echo m > "$1/last-message.json" && echo worker-dir-ok; echo t > "$TMPDIR/scratch" && echo tmp-ok; echo s > "$CODEX_HOME/session.json" && echo codex-state-ok; echo r > "$1/result.json" || echo trusted-file-denied',
      workerDir,
    );
    expect(r.stdout).toBe('worker-dir-ok\ntmp-ok\ncodex-state-ok\ntrusted-file-denied\n');
    expect(readFileSync(join(workerDir, 'last-message.json'), 'utf8')).toBe('m\n');
    expect(existsSync(join(workerDir, 'result.json'))).toBe(false);
  });

  it('denies credentials, except Codex own auth file, which it can read and refresh', async () => {
    const r = await run(
      `cat "$HOME/.ssh/id_ed25519" || echo ssh-denied; cat ${JSON.stringify(join(otherCodexHome, 'auth.json'))} || echo other-login-denied; cat "$CODEX_HOME/auth.json" && echo; echo '{"refreshed":true}' > "$CODEX_HOME/auth.json" && echo auth-refreshed`,
    );
    expect(r.stdout).not.toContain('FAKE-PRIVATE-KEY-acme');
    expect(r.stdout).not.toContain('sk-acme-other-login');
    expect(r.stdout).toBe('ssh-denied\nother-login-denied\n{"OPENAI_API_KEY":"sk-acme-own"}\nauth-refreshed\n');
    expect(readFileSync(join(codexHome, 'auth.json'), 'utf8')).toBe('{"refreshed":true}\n');
  });

  it('allows egress to the Codex provider hosts only', () => {
    expect(profile.allowedHosts).toEqual([...PROVIDER_HOSTS.codex]);
    expect(buildSrtSettings(profile).network.allowedDomains).toEqual(['api.openai.com', 'chatgpt.com']);
  });

  it.runIf(curl !== null)('cannot reach a host that is not allowed, and the refusal is the proxy\'s, not an offline machine', async () => {
    const w = srt.wrap([curl!, '-sS', '--max-time', '10', '-o', '/dev/null', 'https://example.com/'], profile, { cwd: checkout, env });
    wraps.push(w);
    const denied = await runWrapped(w, checkout);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toMatch(/CONNECT tunnel failed, response 403/);
    // A host the policy allows for implementers is not allowed for the reviewer either.
    const w2 = srt.wrap([curl!, '-sS', '--max-time', '10', '-o', '/dev/null', 'https://registry.npmjs.org/'], profile, { cwd: checkout, env });
    wraps.push(w2);
    const npm = await runWrapped(w2, checkout);
    expect(npm.stderr).toMatch(/CONNECT tunnel failed, response 403/);
  });
});

describe.skipIf(!srtStatus.ok)(srtStatus.ok ? 'CodexAdapter os-sandbox tier under real srt' : `CodexAdapter os-sandbox tier skipped: ${srtStatus.detail}`, () => {
  const fixtures: Fixture[] = [];
  const codexHomes: string[] = [];
  afterAll(() => {
    for (const f of fixtures) rmSync(f.base, { recursive: true, force: true });
    for (const d of codexHomes) rmSync(d, { recursive: true, force: true });
  });

  it('launches Codex with --sandbox danger-full-access inside srt; the checkout stays untouched and the worker directory is written', async () => {
    const f = makeFixture();
    fixtures.push(f);
    const codexHome = join(f.base, 'codex-state');
    mkdirSync(codexHome, { recursive: true });
    codexHomes.push(codexHome);
    // The fixture's repository is the review checkout; a stand-in codex tries to plant a file in it and reports what happened.
    const planted = join(f.repo, 'apps', 'planted.ts');
    const argvLog = join(f.workerDir, 'argv.jsonl');
    writeScenario({ ...f, scenarioPath: join(f.workerDir, 'scenario.json') }, { roles: { reviewer: [{ forbiddenWrite: { path: planted }, structured: REVIEW_OUTPUT }] } });
    const base = implementerSpec(f, { role: 'reviewer', readOnly: true, model: 'gpt-6-astra', effort: 'high', outputSchema: MODEL_OUTPUT_SCHEMAS.review, prompt: 'Review candidate abc123.', env: { ORBIT_FAKE_SCENARIO: join(f.workerDir, 'scenario.json'), ORBIT_FAKE_ARGV_LOG: argvLog } });
    const sandbox = profileForWorker({ worktree: f.repo, workerDir: f.workerDir, snapshot: verifySnapshot(f.policyPath, f.policyHash), provider: 'codex', claudeConfigDir: join(f.base, 'claude'), codexHome, homeDir: homedir(), policyPath: f.policyPath, readablePaths: [ORBIT_ROOT], timeoutMs: 60_000, env: {} });
    const spec = { ...base, sandbox };
    const a = new CodexAdapter({ command: [process.execPath, FAKE_CODEX], isolation: srt, graceMs: 300, baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: codexHome } });
    const handle = await a.startTask(spec);
    expect(handle.tier).toBe('os-sandbox');
    const result = await waitFor(() => a.collectResult(handle, spec), 60_000);
    // Succeeding at all shows the process ran in the profile and could write the worker directory (log, last message).
    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(existsSync(join(f.workerDir, 'last-message.json'))).toBe(true);
    const call = JSON.parse(readFileSync(argvLog, 'utf8').trim().split('\n')[0]!) as { argv: string[] };
    expect(call.argv[call.argv.indexOf('--sandbox') + 1]).toBe('danger-full-access');
    expect(existsSync(planted)).toBe(false);
    expect(readFileSync(join(f.workerDir, 'log.jsonl'), 'utf8')).toMatch(/"aggregated_output":"EPERM"/);
  });
});
