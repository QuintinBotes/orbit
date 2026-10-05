/**
 * `orbit hook pre-tool-use` is the one place where failing is not safe: in
 * Claude Code's protocol only exit code 2 blocks a tool call, and a crash, a
 * timeout or a missing binary lets it through. These tests run the real
 * entry point in a child process and check that every way of going wrong ends
 * in exit code 2, while a decision the guard actually made is passed through.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import { CLI_ENTRY, ORBIT_ROOT } from './helpers.ts';

interface Out {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNode(entry: string, args: string[], opts: { input?: string | Buffer; env?: Record<string, string> } = {}): Promise<Out> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', entry, ...args], { env: { PATH: process.env.PATH ?? '', ...(opts.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    // The child may exit before reading everything (it fails closed early); that is not a test failure.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

const hook = (opts?: Parameters<typeof runNode>[2]) => runNode(CLI_ENTRY, ['hook', 'pre-tool-use'], opts);

function denied(out: Out): { permissionDecision: string; permissionDecisionReason: string } {
  const j = JSON.parse(out.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  expect(j.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  return j.hookSpecificOutput;
}

let base: string;
let worktree: string;
let env: Record<string, string>;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-hook-')));
  worktree = join(base, 'wt');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  const config = defaultConfig('autonomous');
  config.scope.allowed_paths = ['src/**'];
  const runDir = join(base, 'run');
  const snap = snapshotPolicy(config, { runId: 'orb-hook-test', repoRoot: worktree, runDir, clock: systemClock });
  env = { ORBIT_POLICY_PATH: snap.path, ORBIT_POLICY_HASH: snap.hash, ORBIT_WORKTREE: worktree, HOME: base };
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const event = (tool_name: string, tool_input: Record<string, unknown>) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: worktree });

describe('orbit hook pre-tool-use fails closed', () => {
  it('exits 2 on garbage standard input', async () => {
    for (const garbage of ['not json at all', '{"hook_event_name":', '\u0000\u0001\u0002', '[]', 'null', '42', '"PreToolUse"']) {
      const r = await hook({ input: garbage, env });
      expect(r.code, garbage).toBe(2);
      expect(denied(r).permissionDecision).toBe('deny');
      expect(r.stderr).toMatch(/Orbit guard failed closed/);
    }
  });

  it('exits 2 on empty standard input', async () => {
    const r = await hook({ input: '', env });
    expect(r.code).toBe(2);
    expect(denied(r).permissionDecisionReason).toMatch(/hook input is empty/);
  });

  it('exits 2 when it is configured with nothing, or with a snapshot that does not verify', async () => {
    const none = await hook({ input: event('Write', { file_path: join(worktree, 'src', 'a.ts') }), env: { HOME: base } });
    expect(none.code).toBe(2);
    expect(denied(none).permissionDecisionReason).toMatch(/ORBIT_POLICY_PATH is not set/);
    const wrongHash = await hook({ input: event('Write', { file_path: join(worktree, 'src', 'a.ts') }), env: { ...env, ORBIT_POLICY_HASH: `sha256:${'0'.repeat(64)}` } });
    expect(wrongHash.code).toBe(2);
    const missing = await hook({ input: event('Write', { file_path: join(worktree, 'src', 'a.ts') }), env: { ...env, ORBIT_POLICY_PATH: join(base, 'no-such-policy.json') } });
    expect(missing.code).toBe(2);
  });

  it('exits 2 on an event the guard does not understand', async () => {
    expect((await hook({ input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {} }), env })).code).toBe(2);
    expect((await hook({ input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: {} }), env })).code).toBe(2);
    expect((await hook({ input: event('Write', {}), env })).code).toBe(2);
  });

  it('exits 2 on oversized input', async () => {
    const r = await hook({ input: Buffer.alloc(6 * 1024 * 1024, 0x61), env });
    expect(r.code).toBe(2);
  });

  it('exits 2 for an unknown hook name', async () => {
    const r = await runNode(CLI_ENTRY, ['hook', 'post-tool-use'], { input: '{}', env });
    expect(r.code).toBe(2);
    expect(denied(r).permissionDecisionReason).toMatch(/unknown hook "post-tool-use"/);
    const bare = await runNode(CLI_ENTRY, ['hook'], { input: '{}', env });
    expect(bare.code).toBe(2);
  });
});

describe('orbit hook pre-tool-use passes the guard\'s real decisions through', () => {
  it('lets an in-scope edit through with exit 0 and no output (the hook only ever takes away)', async () => {
    const r = await hook({ input: event('Write', { file_path: join(worktree, 'src', 'feature.ts') }), env });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('denies a relative file path, which the tool would resolve somewhere else', async () => {
    const r = await hook({ input: event('Write', { file_path: 'relative/path.ts' }), env });
    expect(r.code).toBe(0);
    expect(denied(r).permissionDecisionReason).toMatch(/path\.relative/);
  });

  it('denies a protected path with exit 0 and a deny decision', async () => {
    const r = await hook({ input: event('Write', { file_path: join(worktree, '.orbit', 'config.yaml') }), env });
    expect(r.code, r.stderr).toBe(0);
    expect(denied(r).permissionDecision).toBe('deny');
    expect(denied(r).permissionDecisionReason).toMatch(/Orbit policy \(/);
  });

  it('denies a dangerous shell command and an out-of-worktree read', async () => {
    const sh = await hook({ input: event('Bash', { command: 'git push origin main' }), env });
    expect(sh.code).toBe(0);
    expect(denied(sh).permissionDecision).toBe('deny');
    const read = await hook({ input: event('Read', { file_path: join(base, '..', 'elsewhere', 'id_rsa') }), env });
    expect(read.code).toBe(0);
    expect(denied(read).permissionDecision).toBe('deny');
  });

  it('does not decide for a tool it has no rule for', async () => {
    const r = await hook({ input: event('WebFetch', { url: 'https://example.test' }), env });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('the wrapper installs its handlers before the policy module loads', () => {
  let dir: string;
  function stage(guardSource: string | null): string {
    dir = mkdtempSync(join(tmpdir(), 'orbit-hook-copy-'));
    mkdirSync(join(dir, 'cli'), { recursive: true });
    copyFileSync(join(ORBIT_ROOT, 'src', 'cli', 'main.ts'), join(dir, 'cli', 'main.ts'));
    copyFileSync(join(ORBIT_ROOT, 'src', 'cli', 'hook.ts'), join(dir, 'cli', 'hook.ts'));
    if (guardSource !== null) {
      mkdirSync(join(dir, 'policy'), { recursive: true });
      writeFileSync(join(dir, 'policy', 'guard-hook.ts'), guardSource);
    }
    return join(dir, 'cli', 'main.ts');
  }
  const cleanup = () => dir && rmSync(dir, { recursive: true, force: true });

  it('exits 2 when the policy module cannot be loaded at all', async () => {
    const entry = stage(null);
    const r = await runNode(entry, ['hook', 'pre-tool-use'], { input: '{}' });
    cleanup();
    expect(r.code).toBe(2);
    expect(denied(r).permissionDecisionReason).toMatch(/Orbit guard failed closed/);
  });

  it('exits 2 when the policy module throws while loading', async () => {
    const entry = stage("throw new Error('module broke at load');\nexport async function runGuardHookProcess() {}\n");
    const r = await runNode(entry, ['hook', 'pre-tool-use'], { input: '{}' });
    cleanup();
    expect(r.code).toBe(2);
    expect(denied(r).permissionDecisionReason).toMatch(/module broke at load/);
  });

  it('exits 2 when the guard throws, rejects later, or throws outside any promise', async () => {
    const sources: Record<string, string> = {
      sync: "export async function runGuardHookProcess() { process.exitCode = 0; throw new Error('guard bug'); }\n",
      rejection: "export async function runGuardHookProcess() { process.exitCode = 0; Promise.reject(new Error('late rejection')); await new Promise((r) => setTimeout(r, 100)); }\n",
      uncaught: "export async function runGuardHookProcess() { process.exitCode = 0; setTimeout(() => { throw new Error('timer bug'); }, 10); await new Promise((r) => setTimeout(r, 300)); }\n",
    };
    for (const [name, src] of Object.entries(sources)) {
      const entry = stage(src);
      const r = await runNode(entry, ['hook', 'pre-tool-use'], { input: '{}' });
      cleanup();
      expect(r.code, name).toBe(2);
      expect(denied(r).permissionDecision, name).toBe('deny');
    }
  });

  it('leaves the guard\'s own answer alone when it finishes normally', async () => {
    const entry = stage("export async function runGuardHookProcess() { process.exitCode = 0; }\n");
    const r = await runNode(entry, ['hook', 'pre-tool-use'], { input: '{}' });
    cleanup();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });
});
