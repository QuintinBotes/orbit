import { mkdirSync, mkdtempSync, linkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authorize } from '../../../src/policy/authorize.ts';
import { effectiveProtectedPaths } from '../../../src/policy/builtin.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig, PolicySnapshot } from '../../../src/policy/types.ts';

function snapshotOf(yaml: string): PolicySnapshot {
  const config: OrbitConfig = parseConfig(`version: 1\n${yaml}`);
  return {
    schema: 'orbit.policy/1',
    run_id: 'orb-cov',
    created_at: '2026-01-01T00:00:00.000Z',
    repo_root: '/repo',
    config,
    effective_protected_paths: effectiveProtectedPaths(config),
    check_config_hashes: {},
  };
}

const POLICY = snapshotOf('scope: {allowed_paths: ["apps/**", "docs/**"], protected_paths: [".github/**", "infra/**", "a/**/b/**/c"]}\n');

let base: string;
let wt: string;
let home: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'orbit-authz-cov-'));
  wt = join(base, 'wt');
  home = join(base, 'home');
  mkdirSync(join(wt, 'apps', 'web'), { recursive: true });
  mkdirSync(join(wt, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(wt, 'docs'), { recursive: true });
  mkdirSync(join(wt, 'big'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(wt, 'apps', 'a.ts'), 'x');
  writeFileSync(join(wt, '.github', 'workflows', 'ci.yml'), 'x');
  writeFileSync(join(wt, 'apps', 'h1'), 'x');
  linkSync(join(wt, 'apps', 'h1'), join(wt, 'apps', 'h2'));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
});

const edit = (path: string, s = POLICY) => authorize(s, { kind: 'edit', path }, { worktreeRoot: wt, home });
const bash = (command: string, ctx: { cwd?: string } = {}, s = POLICY) => authorize(s, { kind: 'bash', command }, { worktreeRoot: wt, home, ...ctx });
const denied = (rule: string) => expect.objectContaining({ allowed: false, rule });

describe('authorize fails closed', () => {
  it('turns an unexpected exception into an internal.error denial', () => {
    const broken = { ...POLICY, config: undefined } as unknown as PolicySnapshot;
    const d = authorize(broken, { kind: 'edit', path: 'x' }, { worktreeRoot: wt });
    expect(d).toMatchObject({ allowed: false, rule: 'internal.error' });
    expect(d.reason).toMatch(/^authorization failed closed: /);
  });
});

describe('edit boundary cases', () => {
  it('rejects a missing path and a missing worktree root', () => {
    expect(edit('')).toEqual(expect.objectContaining({ allowed: false, rule: 'path.invalid', reason: 'the path is missing' }));
    expect(edit(undefined as unknown as string)).toMatchObject({ rule: 'path.invalid' });
    expect(authorize(POLICY, { kind: 'edit', path: 'apps/a.ts' })).toMatchObject({ allowed: false, rule: 'scope.no-root' });
  });

  it('reports an unresolvable path (NUL byte, absurd length, vanished root) as path.invalid', () => {
    expect(edit('apps/\0x')).toMatchObject({ allowed: false, rule: 'path.invalid' });
    expect(edit(`apps/${'a'.repeat(5000)}`).rule).toBe('path.invalid');
    expect(authorize(POLICY, { kind: 'edit', path: 'x' }, { worktreeRoot: join(base, 'no-such-root') })).toMatchObject({ rule: 'path.invalid' });
  });

  it('refuses the worktree root itself and a hard-linked file', () => {
    expect(edit(wt)).toMatchObject({ allowed: false, rule: 'scope.not-allowed', reason: 'the worktree root itself is not an editable file' });
    expect(edit('apps/h1')).toMatchObject({ allowed: false, rule: 'scope.hardlink' });
    expect(edit('apps/h2').rule).toBe('scope.hardlink');
  });

  it('judges a path that leaves the root and comes back by the root name, by where it lands', () => {
    expect(edit('../wt/apps/a.ts')).toMatchObject({ allowed: true, rule: 'scope.allowed', reason: 'apps/a.ts is inside scope.allowed_paths' });
    expect(edit('../wt/.github/workflows/ci.yml')).toMatchObject({ allowed: false, rule: 'scope.protected' });
  });
});

describe('read boundary cases', () => {
  it('rejects a missing path, a NUL byte and an unresolvable path', () => {
    const read = (path: unknown) => authorize(POLICY, { kind: 'read', path: path as string }, { worktreeRoot: wt, home });
    expect(read('')).toMatchObject({ allowed: false, rule: 'path.invalid', reason: 'the path is missing' });
    expect(read(7)).toMatchObject({ rule: 'path.invalid' });
    expect(read('a\0b')).toMatchObject({ allowed: false, rule: 'path.invalid', reason: 'the path contains a NUL byte' });
    expect(read(`/${'x'.repeat(5000)}`)).toMatchObject({ allowed: false, rule: 'path.invalid' });
  });

  it('without a worktree root judges a relative path by its name alone', () => {
    const read = (path: string) => authorize(POLICY, { kind: 'read', path }, { home });
    expect(read('.env')).toMatchObject({ allowed: false, rule: 'read.credential', reason: '.env holds credentials' });
    expect(read('config/../.env')).toMatchObject({ allowed: false, rule: 'read.credential' });
    expect(read('README.md')).toMatchObject({ allowed: true, rule: 'read.allowed' });
  });

  it('protects credential locations under a home directory that does not exist', () => {
    const ghost = join(base, 'ghost-home');
    const d = authorize(POLICY, { kind: 'read', path: join(ghost, '.config', 'gh', 'hosts.yml') }, { worktreeRoot: wt, home: ghost });
    expect(d).toMatchObject({ allowed: false, rule: 'read.credential' });
    expect(d.reason).toMatch(/is a credential location$/);
  });
});

describe('actions, dependencies and network edge cases', () => {
  it('never lets the base branch be a push target, even under a prefix that would cover it', () => {
    const s = snapshotOf('');
    const forged: PolicySnapshot = { ...s, config: { ...s.config, repository: { ...s.config.repository, base_branch: 'orbit/main' } } };
    expect(authorize(forged, { kind: 'action', action: 'push_task_branch', target: 'orbit/main' })).toMatchObject({
      allowed: false,
      rule: 'actions.push_task_branch.target',
      reason: 'the base branch is never a push target',
    });
    expect(authorize(forged, { kind: 'action', action: 'push_task_branch', target: 'refs/heads/orbit/main' }).rule).toBe('actions.push_task_branch.target');
  });

  it('denies opening a pull request when delivery.pull_request is none', () => {
    const github = snapshotOf('mode: autonomous-delivery\nactions: {open_pull_request: true}\ndelivery: {pull_request: draft}\n');
    // parseConfig refuses this combination, so only a hand-built snapshot can carry it.
    const none: PolicySnapshot = { ...github, config: { ...github.config, delivery: { ...github.config.delivery, pull_request: 'none' } } };
    expect(authorize(none, { kind: 'action', action: 'open_pull_request' })).toMatchObject({ allowed: false, rule: 'delivery.pull_request', reason: 'delivery.pull_request is "none"' });
    expect(authorize(github, { kind: 'action', action: 'open_pull_request' })).toMatchObject({ allowed: true, rule: 'actions.open_pull_request' });
  });

  it('rejects unknown dependency changes and unnamed install-script packages', () => {
    expect(authorize(POLICY, { kind: 'dependency', change: 'rewrite_everything' as never, detail: '' })).toMatchObject({ allowed: false, rule: 'op.invalid' });
    const allowlist = snapshotOf('dependencies: {install_script_allowlist: [esbuild]}\n');
    expect(authorize(allowlist, { kind: 'dependency', change: 'install_script', detail: undefined as never })).toMatchObject({ allowed: false, reason: 'this package is not on install_script_allowlist' });
    expect(authorize(allowlist, { kind: 'dependency', change: 'install_script', detail: 42 as never })).toMatchObject({ allowed: false });
    expect(authorize(POLICY, { kind: 'dependency', change: 'add_package', detail: undefined as never })).toMatchObject({ allowed: false, reason: 'adding packages is not authorized' });
  });

  it('rejects a missing or non-string network host', () => {
    expect(authorize(POLICY, { kind: 'network', host: undefined as never })).toMatchObject({ allowed: false, rule: 'network.invalid-host', reason: 'the host is missing' });
    expect(authorize(POLICY, { kind: 'network', host: 'not a host' })).toMatchObject({ allowed: false, rule: 'network.invalid-host' });
  });
});

describe('bash preconditions', () => {
  it('needs a command string and an existing worktree root', () => {
    expect(authorize(POLICY, { kind: 'bash', command: undefined as never }, { worktreeRoot: wt })).toMatchObject({ allowed: false, rule: 'bash.unparseable', reason: 'the command is missing' });
    expect(authorize(POLICY, { kind: 'bash', command: 'ls' }, {})).toMatchObject({ allowed: false, rule: 'scope.no-root' });
    expect(authorize(POLICY, { kind: 'bash', command: 'ls' }, { worktreeRoot: join(base, 'vanished') })).toMatchObject({ allowed: false, rule: 'scope.no-root', reason: 'the worktree root does not exist' });
  });

  it('starts relative paths at the root when the hook cwd is not absolute', () => {
    expect(bash('echo x > .github/y', { cwd: 'relative/dir' })).toMatchObject(denied('bash.protected-write'));
    expect(bash('echo x > apps/new.txt', { cwd: join(wt, 'docs') }).allowed).toBe(true);
    expect(bash('echo x > ../.github/y', { cwd: join(wt, 'docs') })).toMatchObject(denied('bash.protected-write'));
  });
});

describe('bash writes whose target is not fully known', () => {
  it('judges the literal text of a run-time target against protected globs', () => {
    expect(bash('echo x > .github/$NAME')).toMatchObject({ allowed: false, rule: 'bash.protected-write', reason: '> writes .github/$NAME, a protected path' });
    expect(bash('echo x > "$NAME"').allowed).toBe(true);
    expect(bash('echo x > $UNSET_VAR/y').allowed).toBe(true);
  });

  it('a write relative to a directory the command lost track of is denied, with the verb of the operation', () => {
    expect(bash('cd - && echo x > f')).toMatchObject({ allowed: false, rule: 'bash.unknown-directory' });
    expect(bash('cd "$D" && rm f').reason).toMatch(/^rm deletes f relative to a directory/);
    expect(bash('popd && ln -s a b').reason).toMatch(/ links to a relative to a directory/);
  });

  it('a target that cannot be resolved is path.invalid', () => {
    expect(bash(`echo x > ${'a'.repeat(5000)}`)).toMatchObject({ allowed: false, rule: 'path.invalid' });
    expect(bash(`echo x > ${'a'.repeat(5000)}*`)).toMatchObject({ allowed: false, rule: 'path.invalid' });
  });
});

describe('bash shell globs', () => {
  it('expands existing matches and judges each', () => {
    expect(bash('echo x > .github/*')).toMatchObject({ allowed: false, rule: 'bash.protected-write', reason: '> writes .github/workflows, a protected path' });
    expect(bash('echo x > .git*')).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
    expect(bash('echo x > apps/h*')).toMatchObject({ allowed: false, rule: 'scope.hardlink' });
    expect(bash('echo x > apps/*.ts').allowed).toBe(true);
  });

  it('judges what a pattern over directories not yet created could match', () => {
    expect(bash('echo x > .gi*/x')).toMatchObject({ allowed: false, rule: 'bash.protected-write', reason: '> .gi*/x can match a protected path' });
    expect(bash('echo x > */*/*/c').rule).toBe('bash.protected-write');
    expect(bash('rm -rf ./*').rule).toBe('bash.protected-write');
    expect(bash('rm -rf a/*/*/b/*/c').rule).toBe('bash.protected-write');
    expect(bash('cp x a/*/b/*/c').rule).toBe('bash.protected-write');
    expect(bash('echo x > docs/*/y').allowed).toBe(true);
    expect(bash('echo x > apps/h1x*').allowed).toBe(true);
  });

  it('a recursive delete or archive extraction that would reach a protected directory is denied', () => {
    expect(bash('rm -rf .').reason).toMatch(/would delete the protected path/);
    expect(bash('tar xf a.tar').reason).toMatch(/would expose the protected path/);
    expect(bash('tar xf a.tar -C apps').allowed).toBe(true);
    expect(bash('rm -rf apps').allowed).toBe(true);
  });

  it('refuses a pattern that expands to more files than a hook can inspect', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (orig) => {
      const real = await orig<typeof import('node:fs')>();
      return {
        ...real,
        readdirSync: (p: string, ...rest: unknown[]) => (String(p).endsWith(`${wt}/big`) || String(p).endsWith('/big') ? Array.from({ length: 20_001 }, (_, i) => `f${i}.txt`) : (real.readdirSync as (...a: unknown[]) => unknown)(p, ...rest)),
      };
    });
    const mod = await import('../../../src/policy/authorize.ts');
    const d = mod.authorize(POLICY, { kind: 'bash', command: 'rm big/*.txt' }, { worktreeRoot: wt, home });
    expect(d).toMatchObject({ allowed: false, rule: 'bash.glob-too-broad' });
    expect(d.reason).toBe('rm big/*.txt matches too many files to inspect');
  });

  it('ignores directory entries that vanish between listing and inspection', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (orig) => {
      const real = await orig<typeof import('node:fs')>();
      return {
        ...real,
        readdirSync: (p: string, ...rest: unknown[]) => {
          const entries = (real.readdirSync as (...a: unknown[]) => string[])(p, ...rest);
          return String(p).endsWith('/apps') ? [...entries, 'ghost.ts'] : entries;
        },
      };
    });
    const mod = await import('../../../src/policy/authorize.ts');
    const d = mod.authorize(POLICY, { kind: 'bash', command: 'echo x > apps/*.ts' }, { worktreeRoot: wt, home });
    expect(d).toMatchObject({ allowed: true, rule: 'bash.allowed' });
  });
});

describe('bash writes outside the worktree', () => {
  it('denies paths outside the root but allows scratch space, and judges link targets like writes', () => {
    expect(bash('echo x > /nonexistent-orbit-dir/f')).toMatchObject({ allowed: false, rule: 'bash.write-outside-root', reason: '> writes /nonexistent-orbit-dir/f, outside the worktree' });
    expect(bash('echo x > /tmp/orbit-cov-scratch.txt').allowed).toBe(true);
    expect(bash('ln -s /etc/passwd apps/l')).toMatchObject({ allowed: false, rule: 'bash.write-outside-root', reason: 'ln links to /etc/passwd, outside the worktree' });
    expect(bash('ln -s ../.github/x apps/l').rule).toBe('bash.protected-write');
  });

  it('the edit permission also gates what a command writes', () => {
    const noEdit = snapshotOf('scope: {allowed_paths: ["apps/**"]}\nactions: {edit: false}\n');
    expect(bash('echo x > apps/new.txt', {}, noEdit)).toMatchObject({ allowed: false, rule: 'actions.edit' });
  });

  it('a hard-linked file is protected from shell writes too', () => {
    expect(bash('echo x > apps/h1')).toMatchObject({ allowed: false, rule: 'scope.hardlink' });
    expect(bash('rm apps/h1').allowed).toBe(true);
  });
});

describe('permission-changing commands', () => {
  it('are denied unless actions.change_permissions is true', () => {
    expect(bash('chmod 755 apps/a.ts')).toMatchObject({ allowed: false, rule: 'actions.change_permissions' });
    const allowed = snapshotOf('scope: {allowed_paths: ["apps/**"]}\nactions: {change_permissions: true}\n');
    expect(bash('chmod 755 apps/a.ts', {}, allowed).allowed).toBe(true);
  });
});

describe('shell glob versus protected glob matching', () => {
  it('handles protected globs with consecutive ** segments (shared sub-problems) without blowing up', () => {
    const nested = snapshotOf('scope: {allowed_paths: ["apps/**"], protected_paths: ["**/**/zzz", "k/**/**/**/m"]}\n');
    expect(bash('echo x > docs/*/y/*/q', {}, nested).allowed).toBe(true);
    expect(bash('echo x > k/*/*/*/*/m*', {}, nested)).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
    expect(bash('echo x > */*/*/zz*', {}, nested)).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
  });
});
