import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManualClock } from '../../../src/core/clock.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';

// The hook runs as its own process; exit codes are its contract with Claude Code
// (2 blocks, anything else does not). Running the TypeScript source directly needs
// Node's built-in type stripping.
const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
const HOOK_MODULE = fileURLToPath(new URL('../../../src/policy/guard-hook.ts', import.meta.url));

let base: string;
let env: Record<string, string>;

function runHook(stdin: string, extraEnv: Record<string, string | undefined> = env, prelude = '') {
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `import { runGuardHookProcess } from ${JSON.stringify(HOOK_MODULE)}; ${prelude} await runGuardHookProcess();`], {
    input: stdin,
    env: { PATH: process.env.PATH ?? '', HOME: join(base, 'home'), ...extraEnv } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!canStripTypes)('guard hook as a process (skipped when Node cannot run .ts sources directly)', () => {
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'orbit-guardp-'));
    const wt = join(base, 'wt');
    mkdirSync(join(wt, 'apps'), { recursive: true });
    const config = parseConfig('version: 1\nscope: {allowed_paths: ["apps/**"]}\n');
    const snap = snapshotPolicy(config, { runId: 'orb-p', repoRoot: base, runDir: join(base, 'run'), clock: new ManualClock() });
    env = { ORBIT_POLICY_PATH: snap.path, ORBIT_POLICY_HASH: snap.hash, ORBIT_WORKTREE: wt };
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const event = (tool_name: string, tool_input: object) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd: env.ORBIT_WORKTREE, tool_name, tool_input });

  it('exits 0 silently for an allowed call', () => {
    const r = runHook(event('Write', { file_path: join(env.ORBIT_WORKTREE!, 'apps', 'a.ts'), content: '' }));
    expect(r).toMatchObject({ code: 0, stdout: '' });
  });

  it('exits 0 with a deny decision for a denied call', () => {
    const r = runHook(event('Bash', { command: 'git push' }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  });

  it('exits 2 on garbage input', () => {
    const r = runHook('}{ not json');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Orbit guard failed closed/);
  });

  it('exits 2, never 1, when something crashes asynchronously while the hook runs', () => {
    // Exit 1 is non-blocking in Claude Code, so a crash must not end the process with it.
    const r = runHook(event('Write', { file_path: join(env.ORBIT_WORKTREE!, 'apps', 'a.ts'), content: '' }), env, "setImmediate(() => { throw new Error('async crash'); });");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Orbit guard failed closed: async crash/);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('exits 2 when the policy environment is missing or the snapshot is wrong', () => {
    expect(runHook(event('Read', { file_path: '/x' }), {}).code).toBe(2);
    expect(runHook(event('Read', { file_path: '/x' }), { ...env, ORBIT_POLICY_HASH: `sha256:${'f'.repeat(64)}` }).code).toBe(2);
    expect(runHook(event('Read', { file_path: '/x' }), { ...env, ORBIT_POLICY_PATH: join(base, 'missing.json') }).code).toBe(2);
  });
});
