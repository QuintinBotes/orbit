/**
 * Bypass attempts found by an adversarial review of the policy engine. Each
 * case is a concrete way a worker could get past the guard (or hide a change
 * from the controller) before the fix; the test pins the fixed behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../../src/core/clock.ts';
import { authorize } from '../../../src/policy/authorize.ts';
import { classifyBash } from '../../../src/policy/bash.ts';
import { effectiveProtectedPaths } from '../../../src/policy/builtin.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { handlePreToolUse, type GuardOptions } from '../../../src/policy/guard-hook.ts';
import { parseShell } from '../../../src/policy/shell.ts';
import { snapshotPolicy, snapshotHash, verifySnapshot } from '../../../src/policy/snapshot.ts';
import type { OrbitConfig, PolicySnapshot } from '../../../src/policy/types.ts';

function snapshotOf(yaml: string): PolicySnapshot {
  const config: OrbitConfig = parseConfig(`version: 1\n${yaml}`);
  return { schema: 'orbit.policy/1', run_id: 'orb-adv', created_at: '', repo_root: '/repo', config, effective_protected_paths: effectiveProtectedPaths(config), check_config_hashes: {} };
}

// Broad scope on purpose: the protections must hold even when everything else is allowed.
const WIDE = snapshotOf('scope: {allowed_paths: ["**"], protected_paths: [".github/**", "infra/**"]}\n');

let base: string;
let wt: string;
// Outside the temp dir on purpose: writes under the system temp dir are allowed scratch space.
const home = '/nonexistent-orbit-home/acme';

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'orbit-adv-')));
  wt = join(base, 'wt');
  mkdirSync(join(wt, 'apps', 'web'), { recursive: true });
  mkdirSync(join(wt, '.claude'), { recursive: true });
  mkdirSync(join(wt, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(wt, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(base, 'outside'), { recursive: true });
  writeFileSync(join(wt, 'node_modules', '.bin', 'vitest'), '');
  writeFileSync(join(wt, '.claude', 'settings.json'), '{}');
  writeFileSync(join(wt, 'apps', 'web', 'key.pem'), 'k');
  writeFileSync(join(wt, 'apps', 'web', 'a.ts'), 'a');
  writeFileSync(join(base, 'outside', '.zshrc'), '# rc');
  // A hard link inside the worktree that shares its inode with a file outside it.
  linkSync(join(base, 'outside', '.zshrc'), join(wt, 'apps', 'web', 'notes.txt'));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const bash = (command: string, cwd?: string) => authorize(WIDE, { kind: 'bash', command }, { worktreeRoot: wt, home, ...(cwd ? { cwd } : {}) });

describe('shell words the lexer used to misread', () => {
  it('decodes ANSI-C hex, octal, unicode and control escapes like bash', () => {
    const words = (src: string) => parseShell(src).commands[0]!.words.map((w) => w.text);
    expect(words(`$'\\x67\\x69\\x74' push`)).toEqual(['git', 'push']);
    expect(words(`$'\\147it' push`)).toEqual(['git', 'push']);
    expect(words(`$'\\u0067it' push`)).toEqual(['git', 'push']);
    expect(words(`$'\\U00000067it' push`)).toEqual(['git', 'push']);
    expect(words(`$'\\cA'`)).toEqual(['\x01']);
    // bash cuts a $'...' string at an encoded NUL, then keeps reading the word.
    expect(words(`$'gi\\0junk't push`)).toEqual(['git', 'push']);
    // An escape without digits stays literal, as in bash.
    expect(words(`$'\\xZ'`)).toEqual(['\\xZ']);
  });

  it('performs brace expansion on unquoted braces only', () => {
    const words = (src: string) => parseShell(src).commands[0]!.words.map((w) => w.text);
    expect(words('{git,push} origin')).toEqual(['git', 'push', 'origin']);
    expect(words('echo a{b,c{d,e}}f')).toEqual(['echo', 'abf', 'acdf', 'acef']);
    expect(words('echo {1..3} {a..c}')).toEqual(['echo', '1', '2', '3', 'a', 'b', 'c']);
    expect(words(`echo '{a,b}' "{c,d}" \\{e,f} {g} {} x{,}`)).toEqual(['echo', '{a,b}', '{c,d}', '{e,f}', '{g}', '{}', 'x', 'x']);
    expect(words('echo ${x:-{a,b}}')).toEqual(['echo', '${x:-{a,b}}']);
    // Assignments are not brace-expanded.
    expect(parseShell('A={x,y} env').commands[0]!.assigns[0]!.text).toBe('A={x,y}');
  });

  it('marks an explosive brace expansion as computed instead of enumerating it', () => {
    const w = parseShell('{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b} x').commands[0]!.words[0]!;
    expect(w.dynamic).toBe(true);
  });

  it('treats a carriage return as part of a word, as bash does', () => {
    expect(parseShell('echo a\rb').commands[0]!.words.map((w) => w.text)).toEqual(['echo', 'a\rb']);
  });
});

describe('bash commands that slipped past the guard', () => {
  it.each([
    [`$'\\x67\\x69\\x74' push`, 'bash.publish'],
    [`$'\\147it' push origin`, 'bash.publish'],
    ['{git,push} origin main', 'bash.publish'],
    ['git {push,--version}', 'bash.publish'],
    ['tee {.claude/settings.json,/dev/null} < x', 'bash.protected-write'],
    ['echo x > .cl?ude/settings.json', 'bash.protected-write'],
    ['cp evil .cl*/settings.json', 'bash.protected-write'],
    ['echo k > apps/web/*.pem', 'bash.protected-write'],
    ['rm -f apps/web/*', 'bash.protected-write'],
    ['echo x > .en?', 'bash.protected-write'],
    ['busybox rm -rf /', 'bash.destructive'],
    ['command time git push', 'bash.publish'],
    ['/usr/bin/time -p git push', 'bash.publish'],
    ['strace -f -o /dev/null git push', 'bash.publish'],
    ['dotenv -e .env.test -- git push', 'bash.publish'],
    ['hyperfine "git push"', 'bash.publish'],
    ['concurrently "npm test" "git push"', 'bash.publish'],
    ['echo x > .{cl,}aude/settings.json', 'bash.protected-write'],
    [`echo x > $'\\x2e'claude/settings.json`, 'bash.protected-write'],
    ['npx @acme/evil', 'dependencies.add_packages'],
  ])('%s is denied (%s)', (command, rule) => {
    expect(bash(command)).toMatchObject({ allowed: false, rule });
  });

  it.each([
    'parallel git ::: push',
    'tmux new-session -d "git push"',
    'expect -c "spawn git push"',
    'shopt -s dotglob; rm -rf *',
    'GLOBIGNORE=x; rm -rf *',
    'GIT_PAGER="sh -c evil" git -p log',
    'LESSOPEN="|sh -c evil %s" less a',
    'VISUAL="sh -c evil" ls',
    'git -c pager.log="sh -c evil" log',
    'git -c diff.external=evil diff',
    'git --work-tree=/ checkout -- etc/hosts',
    'git difftool -y -x "sh -c evil"',
    'git grep -O"sh -c evil" x',
    // xargs puts its input where the replace string is, so the shell body is computed.
    "echo 'git push' | xargs -I{} sh -c '{}'",
    "echo 'git push' | xargs -i sh -c '{}'",
    "echo 'git push' | xargs -I % bash -c %",
  ])('%s is denied as hidden behaviour', (command) => {
    expect(bash(command).allowed).toBe(false);
  });

  it('denies relative writes after the shell moved to a directory it cannot know', () => {
    for (const command of ['cd - && echo x > settings.json', 'pushd .claude; pushd /tmp; popd; echo x > settings.json', 'pushd; echo x > y', 'cd "$DIR" && echo x > f']) {
      expect(bash(command)).toMatchObject({ allowed: false, rule: 'bash.unknown-directory' });
    }
    // A known directory keeps working.
    expect(bash('cd apps && echo x > out.txt').allowed).toBe(true);
  });

  it('resolves $HOME, $PWD and $TMPDIR targets instead of ignoring them', () => {
    expect(bash('echo x >> $HOME/.zshrc')).toMatchObject({ allowed: false, rule: 'bash.write-outside-root' });
    expect(bash('echo x > "${HOME}/.ssh/authorized_keys"')).toMatchObject({ allowed: false, rule: 'bash.write-outside-root' });
    expect(bash('echo x > "$PWD/.claude/settings.json"')).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
    expect(bash('echo x > "$TMPDIR/scratch.txt"').allowed).toBe(true);
  });

  it('denies links that expose a protected or outside path under an allowed name', () => {
    expect(bash('ln -s ../.claude/settings.json apps/s.json')).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
    expect(bash('ln -s ../../.claude apps/web/cfg')).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
    expect(bash(`ln -sf ${join(home, '.zshrc')} apps/rc`)).toMatchObject({ allowed: false, rule: 'bash.write-outside-root' });
    expect(bash('ln ~/.zshrc apps/rc')).toMatchObject({ allowed: false, rule: 'bash.write-outside-root' });
    expect(bash('link .claude/settings.json apps/s.json')).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
    expect(bash('cp -l .claude/settings.json apps/s.json')).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
    // Links that stay inside the worktree and away from protected paths are fine.
    expect(bash('ln -s ../web/a.ts apps/web/b.ts').allowed).toBe(true);
    expect(bash('ln -s a.ts', join(wt, 'apps', 'web')).allowed).toBe(true);
  });

  it('denies writes through a hard link, which would change the other name too', () => {
    expect(bash('echo pwned >> apps/web/notes.txt')).toMatchObject({ allowed: false, rule: 'scope.hardlink' });
    expect(authorize(WIDE, { kind: 'edit', path: join(wt, 'apps', 'web', 'notes.txt') }, { worktreeRoot: wt })).toMatchObject({ allowed: false, rule: 'scope.hardlink' });
    // Deleting one name of a hard-linked file leaves the other intact.
    expect(bash('rm apps/web/notes.txt').allowed).toBe(true);
  });

  it('treats extraction and clone targets as writes', () => {
    expect(bash('tar -xzf payload.tgz -C .claude')).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
    expect(bash('tar --extract --file=p.tar --directory=.github')).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
    expect(bash('unzip -o p.zip -d .claude')).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
    expect(bash('git clone https://github.com/acme/x .github/x')).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
    expect(bash('tar -czf out.tgz -C .claude .').allowed).toBe(true);
  });

  it('treats npx of a package that is not installed locally as a package install', () => {
    expect(bash('npx cowsay hi')).toMatchObject({ allowed: false, rule: 'dependencies.add_packages' });
    expect(bash('bunx cowsay hi')).toMatchObject({ allowed: false, rule: 'dependencies.add_packages' });
    expect(bash('npx vitest run').allowed).toBe(true);
    expect(bash('npx vitest run', join(wt, 'apps', 'web')).allowed).toBe(true);
  });

  it('applies git -C to the paths git writes', () => {
    expect(bash('git -C .claude checkout -- settings.json')).toMatchObject({ allowed: false, rule: 'bash.protected-write' });
  });

  it('still allows ordinary work', () => {
    for (const command of ['rm -rf dist/*', 'rm -f apps/web/*.log', 'ls apps/{web,api}', 'echo {a,b}', 'cp -r src/. out/', 'npx vitest run && npm run lint', 'time npm test', 'cat x > /tmp/out.txt']) {
      expect(bash(command), command).toMatchObject({ allowed: true });
    }
  });
});

describe('credential reads', () => {
  it.each([
    '.claude/.credentials.json',
    // An IDE extension's lock file: the token of its MCP server on loopback (final review of #31).
    '.claude/ide/4243.lock',
    '.codex/auth.json',
    '.vault-token',
    '.cargo/credentials.toml',
    '.gem/credentials',
    '.pgpass',
    '.terraform.d/credentials.tfrc.json',
    '.config/glab-cli/config.yml',
    '.yarnrc.yml',
    '.m2/settings.xml',
    '.gradle/gradle.properties',
    'Library/Keychains/login.keychain-db',
    '.password-store/acme.gpg',
  ])('denies reading ~/%s', (rel) => {
    expect(authorize(WIDE, { kind: 'read', path: `${home}/${rel}` }, { worktreeRoot: wt, home })).toMatchObject({ allowed: false, rule: 'read.credential' });
  });

  it('still allows ordinary files under home', () => {
    expect(authorize(WIDE, { kind: 'read', path: `${home}/.gitconfig` }, { worktreeRoot: wt, home }).allowed).toBe(true);
  });
});

describe('classifyBash on the same tricks', () => {
  it('reports the hidden program instead of an unknown one', () => {
    expect(classifyBash(`$'\\x67\\x69\\x74' push`).category).toBe('publish');
    expect(classifyBash('{sudo,ls}').category).toBe('privilege');
    expect(classifyBash('busybox sh -c "git push"').category).toBe('publish');
  });
});

describe('guard hook path handling', () => {
  let opts: GuardOptions;
  beforeAll(() => {
    const config = parseConfig('version: 1\nscope: {allowed_paths: ["**"], protected_paths: [".github/**"]}\n');
    const snap = snapshotPolicy(config, { runId: 'orb-adv-g', repoRoot: base, runDir: join(base, 'run-g'), clock: new ManualClock() });
    opts = { snapshotPath: snap.path, expectedHash: snap.hash, worktreeRoot: wt, home };
  });
  const event = (tool_name: string, tool_input: object, cwd = wt) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name, tool_input });

  it('denies relative file paths, which the tool would resolve against the session cwd', () => {
    // From .github the tool would write .github/workflows/ci.yml; the root-relative reading looked harmless.
    const r = handlePreToolUse(event('Write', { file_path: 'workflows/ci.yml', content: 'x' }, join(wt, '.github')), opts);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/path\.relative/) });
    for (const tool of ['Edit', 'Read']) {
      expect(JSON.parse(handlePreToolUse(event(tool, { file_path: 'apps/web/a.ts' }), opts).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });

  it('does not fall back to file_path when notebook_path is present but malformed', () => {
    const r = handlePreToolUse(event('NotebookEdit', { notebook_path: 5, file_path: join(wt, 'apps', 'n.ipynb'), new_source: 'x' }), opts);
    expect(r.exitCode).toBe(2);
  });
});

describe('snapshot integrity', () => {
  it('refuses a snapshot carrying __proto__ keys, which the canonical hash cannot see', () => {
    const config = parseConfig('version: 1\n');
    const dir = join(base, 'run-proto');
    const snap = snapshotPolicy(config, { runId: 'orb-proto', repoRoot: base, runDir: dir, clock: new ManualClock() });
    const text = readFileSync(snap.path, 'utf8').replace('"actions": {', '"actions": {\n    "__proto__": {"merge": true},');
    const forged = join(base, 'forged.json');
    writeFileSync(forged, text);
    chmodSync(forged, 0o444);
    // canonicalJson keeps __proto__ as an ordinary key, so the forged file hashes differently;
    // verifySnapshot refuses it either way.
    expect(snapshotHash(JSON.parse(text) as PolicySnapshot)).not.toBe(snap.hash);
    expect(() => verifySnapshot(forged, snap.hash)).toThrow(expect.objectContaining({ code: 'POLICY_TAMPERED' }));
  });
});
