import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const hasEntry = existsSync(join(root, 'src/cli/main.ts'));
const run = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) =>
  spawnSync(cmd, args, { cwd: opts.cwd ?? root, env: opts.env ?? process.env, input: opts.input, encoding: 'utf8', timeout: 90_000 });

const tmp: string[] = [];
const mkTmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

describe('plugin manifest and components', () => {
  it('validates under --strict', () => {
    const r = run('claude', ['plugin', 'validate', '--strict', root]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('has no CLAUDE.md at the plugin root', () => {
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('lists six skills and the agents', () => {
    const r = run('claude', ['--plugin-dir', root, 'plugin', 'details', 'orbit']);
    expect(r.status, r.stderr).toBe(0);
    for (const s of ['inquisition', 'repair', 'resume', 'run', 'status', 'verify']) expect(r.stdout).toMatch(new RegExp(`Skills \\(6\\).*\\b${s}\\b`));
    for (const a of ['reviewer', 'inquisitor', 'curator', 'verifier', 'planner', 'implementer']) expect(r.stdout).toMatch(new RegExp(`Agents \\(6\\).*\\b${a}\\b`));
  });

  it('keeps frontmatter inside the verified key lists', () => {
    const r = run('node', ['scripts/check-plugin.mjs']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('skills pass arguments through verbatim to the bundle', () => {
    for (const s of ['run', 'inquisition', 'verify', 'repair', 'status', 'resume']) {
      const text = readFileSync(join(root, 'skills', s, 'SKILL.md'), 'utf8');
      expect(text).toContain('node "${CLAUDE_PLUGIN_ROOT}/dist/orbit.mjs"');
      expect(text).toContain('$ARGUMENTS');
      expect(text).toContain(`/orbit:${s}`);
    }
  });
});

describe('hooks.json', () => {
  const hooks = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8')) as {
    hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; args?: string[]; timeout?: number }[] }[]>;
  };
  const handlers = Object.values(hooks.hooks).flatMap((g) => g.flatMap((e) => e.hooks));

  it('uses exec-form commands whose script files exist and with short timeouts', () => {
    expect(handlers.length).toBeGreaterThan(0);
    for (const h of handlers) {
      expect(h.type).toBe('command');
      expect(h.command).toBe('node');
      const script = (h.args?.[0] ?? '').replace('${CLAUDE_PLUGIN_ROOT}', root);
      expect(existsSync(script), script).toBe(true);
      expect(h.timeout).toBeLessThanOrEqual(10);
    }
  });

  it('guards the expected tools', () => {
    expect(hooks.hooks.PreToolUse?.[0]?.matcher).toBe('Bash|PowerShell|Edit|Write|NotebookEdit|Read');
  });

  it('guard is a no-op outside workers and fails closed for workers', () => {
    const env = { ...process.env };
    delete env.ORBIT_WORKER;
    expect(run('node', ['hooks/guard.mjs'], { env, input: '{}' }).status).toBe(0);
    // A copy without dist/ models a missing bundle: the guard must block, not silently pass.
    const plugin = mkTmp('orbit-plugin-');
    mkdirSync(join(plugin, 'hooks'));
    cpSync(join(root, 'hooks/guard.mjs'), join(plugin, 'hooks/guard.mjs'));
    const r = run('node', [join(plugin, 'hooks/guard.mjs')], { env: { ...env, ORBIT_WORKER: '1' }, input: '{}' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('failed closed');
  });

  it('session start is silent in a repo without Orbit state', () => {
    const dir = mkTmp('orbit-ss-');
    const r = run('node', [join(root, 'hooks/session-start.mjs')], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('hook scripts against a fake bundle', () => {
  // A throwaway plugin copy lets the scripts run against controlled bundle behaviour.
  const mkPlugin = (bundleSrc: string) => {
    const plugin = mkTmp('orbit-fake-');
    mkdirSync(join(plugin, 'hooks'));
    mkdirSync(join(plugin, 'dist'));
    for (const f of ['guard.mjs', 'session-start.mjs']) cpSync(join(root, 'hooks', f), join(plugin, 'hooks', f));
    writeFileSync(join(plugin, 'dist/orbit.mjs'), bundleSrc);
    return plugin;
  };
  const worker = { ...process.env, ORBIT_WORKER: '1' };

  it.each([
    ['sync throw', 'throw new Error("x")'],
    ['syntax error', 'this is not javascript'],
    ['unhandled rejection', 'await Promise.reject(new Error("r"))'],
    ['late uncaught exception', 'setTimeout(() => { throw new Error("late"); }, 30)'],
    ['never settles', 'await new Promise(() => {})'],
  ])('guard fails closed when the bundle has a %s', (_n, src) => {
    const plugin = mkPlugin(src);
    expect(run('node', [join(plugin, 'hooks/guard.mjs')], { env: worker, input: '{}' }).status).toBe(2);
  });

  it('guard passes the hook argv to the bundle and keeps the bundle verdict', () => {
    const plugin = mkPlugin('process.stderr.write(process.argv.slice(2).join(" ")); process.exitCode = 0;');
    const r = run('node', [join(plugin, 'hooks/guard.mjs')], { env: worker, input: '{}' });
    expect(r.stderr).toBe('hook pre-tool-use');
    expect(r.status).toBe(0);
  });

  it('session start prints capped, labelled questions only for non-worker sessions', () => {
    const plugin = mkPlugin('process.stdout.write("Q".repeat(50000));');
    const repo = mkTmp('orbit-ssrepo-');
    mkdirSync(join(repo, '.orbit'));
    writeFileSync(join(repo, '.orbit/state.sqlite'), '');
    const env = { ...process.env };
    delete env.ORBIT_WORKER;
    const r = run('node', [join(plugin, 'hooks/session-start.mjs')], { cwd: repo, env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not instructions');
    expect(r.stdout.length).toBeLessThan(4200);
    expect(run('node', [join(plugin, 'hooks/session-start.mjs')], { cwd: repo, env: worker }).stdout).toBe('');
  });

  it('session start never fails when the bundle crashes', () => {
    const plugin = mkPlugin('process.stdout.write("partial"); process.exit(3);');
    const repo = mkTmp('orbit-ssrepo-');
    mkdirSync(join(repo, '.orbit'));
    writeFileSync(join(repo, '.orbit/state.sqlite'), '');
    const env = { ...process.env };
    delete env.ORBIT_WORKER;
    const r = run('node', [join(plugin, 'hooks/session-start.mjs')], { cwd: repo, env });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('build script', () => {
  it('builds an entry outside the repo, resolves repo dependencies, and detects staleness', () => {
    const dir = mkTmp('orbit-build-');
    const entry = join(dir, 'e.mjs');
    writeFileSync(entry, "import Ajv from 'ajv';\nimport { parse } from 'yaml';\nif (process.argv[2] === '--version') console.log('9.9.9', typeof Ajv, parse('a: 1').a);\n");
    const out = join(dir, 'out/orbit.mjs');
    const env = { ...process.env, ORBIT_BUILD_ENTRY: entry, ORBIT_BUILD_OUT: out };
    const b = run('node', ['scripts/build.mjs'], { env });
    expect(b.status, b.stdout + b.stderr).toBe(0);
    expect(readFileSync(out, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(run('node', ['scripts/build.mjs', '--check'], { env }).status).toBe(0);
    appendFileSync(out, '// tampered\n');
    expect(run('node', ['scripts/build.mjs', '--check'], { env }).status).toBe(1);
  });

  it('fails cleanly on a missing entry or a broken import', () => {
    const dir = mkTmp('orbit-build-');
    expect(run('node', ['scripts/build.mjs'], { env: { ...process.env, ORBIT_BUILD_ENTRY: join(dir, 'nope.ts'), ORBIT_BUILD_OUT: join(dir, 'o.mjs') } }).status).toBe(1);
    const bad = join(dir, 'bad.mjs');
    writeFileSync(bad, "import 'does-not-exist-pkg';\n");
    const r = run('node', ['scripts/build.mjs'], { env: { ...process.env, ORBIT_BUILD_ENTRY: bad, ORBIT_BUILD_OUT: join(dir, 'o.mjs') } });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('    at ');
  });
});

describe.skipIf(!hasEntry)('bundle', () => {
  beforeAll(() => {
    const r = run('node', ['scripts/build.mjs']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('is current and starts with a node shebang', () => {
    expect(readFileSync(join(root, 'dist/orbit.mjs'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(run('node', ['scripts/build.mjs', '--check']).status).toBe(0);
  });

  it('runs --version and doctor --json in a temp repo', () => {
    const repo = mkTmp('orbit-bundle-');
    const home = mkTmp('orbit-home-');
    run('git', ['init', '-q'], { cwd: repo });
    const env = { ...process.env, ORBIT_HOME: home };
    const v = run('node', [join(root, 'dist/orbit.mjs'), '--version'], { cwd: repo, env });
    expect(v.status, v.stderr).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const d = run('node', [join(root, 'dist/orbit.mjs'), 'doctor', '--json'], { cwd: repo, env });
    expect(() => JSON.parse(d.stdout), d.stdout + d.stderr).not.toThrow();
  });

  it('runs the worker guard through the plugin hook script', () => {
    const r = run('node', ['hooks/guard.mjs'], { env: { ...process.env, ORBIT_WORKER: '1' }, input: 'not json' });
    // Malformed input must block (2), never pass.
    expect(r.status).toBe(2);
  });
});
