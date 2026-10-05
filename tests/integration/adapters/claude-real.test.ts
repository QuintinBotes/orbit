import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, type ClaudeTaskHandle } from '../../../src/adapters/claude.ts';
import type { ClaudeTaskResult } from '../../../src/adapters/claude-transcript.ts';
import { readExitRecord } from '../../../src/adapters/shim.ts';
import { archiveAttempt } from '../../../src/adapters/supervise.ts';
import { startFakeAnthropicApi } from '../../fakes/fake-anthropic-api.mjs';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';
import { IMPLEMENTER_OUTPUT, REVIEW_OUTPUT, implementerSpec, makeFixture, waitFor, type Fixture } from './helpers.ts';

// The REAL claude binary against a local fake Messages API: no model spend,
// real permission engine, real hooks, real stream-json. Pattern verified in
// tests/fakes/reference/claude-against-mock.reference.sh.
const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
const CLAUDE = which.status === 0 ? which.stdout.trim() : null;
const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

type Api = Awaited<ReturnType<typeof startFakeAnthropicApi>>;
let api: Api;
let configDir: string;
const fixtures: Fixture[] = [];

function setup(steps: object[]): { f: Fixture; a: ClaudeAdapter } {
  api.setSteps(steps);
  const f = makeFixture('version: 1\nmode: supervised\nscope: {allowed_paths: ["apps/**"]}\nnetwork: {allowed_hosts: []}\n');
  fixtures.push(f);
  const a = new ClaudeAdapter({
    command: [CLAUDE!],
    tier: 'claude-sandbox',
    graceMs: 2_000,
    baseEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TERM: 'dumb',
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'sk-ant-fake-000',
      CLAUDE_CONFIG_DIR: configDir,
      GH_TOKEN: 'ghp_must_not_reach_the_worker',
    },
  });
  return { f, a };
}

async function run(a: ClaudeAdapter, f: Fixture, over: Parameters<typeof implementerSpec>[1] = {}): Promise<{ handle: ClaudeTaskHandle; result: ClaudeTaskResult }> {
  const spec = implementerSpec(f, { env: {}, model: 'sonnet', ...over });
  const handle = await a.startTask(spec);
  const result = await waitFor(() => a.collectResult(handle, spec), 60_000, 100);
  return { handle, result };
}

function toolResults(f: Fixture): string[] {
  return readFileSync(join(f.workerDir, 'log.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; message?: { content?: unknown } })
    .filter((e) => e.type === 'user' && Array.isArray(e.message?.content))
    .flatMap((e) => (e.message!.content as { type: string; content?: unknown }[]).filter((c) => c.type === 'tool_result').map((c) => JSON.stringify(c.content)));
}

describe.skipIf(!CLAUDE || !canStripTypes)('ClaudeAdapter with the real claude CLI against a fake API (skipped when claude is not installed)', () => {
  beforeAll(async () => {
    api = await startFakeAnthropicApi({ steps: [{ text: 'ok' }] });
    configDir = mkdtempSync(join(tmpdir(), 'orbit-claude-cfg-'));
  });
  afterAll(async () => {
    await api?.close();
    rmSync(configDir, { recursive: true, force: true });
    for (const f of fixtures) rmSync(f.base, { recursive: true, force: true });
  });

  it('enforces policy through the rendered settings: in-scope Write allowed; out-of-scope Write and git push denied by the guard hook; protected paths denied by deny rules and the hook', async () => {
    const { f, a } = setup([]);
    api.setSteps([
      { tool: 'Write', input: { file_path: join(f.repo, 'apps', 'new.ts'), content: 'export const n = 1;\n' } },
      { tool: 'Write', input: { file_path: join(f.repo, 'README.md'), content: 'out of scope\n' } },
      { tool: 'Write', input: { file_path: join(f.repo, 'apps', '.env'), content: 'SECRET=1\n' } },
      { tool: 'Write', input: { file_path: join(f.repo, '.orbit', 'config.yaml'), content: 'version: 1\n' } },
      { tool: 'Write', input: { file_path: join(f.repo, 'apps', '.ENV.local'), content: 'SECRET=1\n' } },
      { tool: 'Bash', input: { command: 'git push origin main', description: 'push' } },
      { structured: IMPLEMENTER_OUTPUT, usage: { input: 2000, output: 300, cacheRead: 500, cacheWrite: 100 } },
    ]);
    const { result } = await run(a, f);
    expect(result.status).toBe('succeeded');
    expect(result.structured).toEqual(IMPLEMENTER_OUTPUT);
    expect(existsSync(join(f.repo, 'apps', 'new.ts'))).toBe(true);
    expect(existsSync(join(f.repo, 'README.md'))).toBe(false);
    expect(existsSync(join(f.repo, 'apps', '.env'))).toBe(false);
    const denied = result.permissionDenials.map((d) => d.tool_name);
    expect(denied).toEqual(['Write', 'Write', 'Write', 'Write', 'Bash']);
    // Out of scope: no static rule names README.md, so the guard hook decides.
    // Protected paths: the settings' deny rules stop the call even before the
    // hook runs (Claude Code matches them case-insensitively on macOS).
    const results = toolResults(f);
    expect(results[1]).toContain('Orbit policy (scope.not-allowed)');
    expect(results.slice(2, 5).every((r) => r.includes('denied by your permission settings'))).toBe(true);
    expect(results[5]).toContain('Orbit policy (bash.publish)');

    // The rendered hook itself, run exactly as settings.json tells Claude Code
    // to, also denies the protected path (the layer behind the static rules).
    const settings = JSON.parse(readFileSync(join(f.workerDir, 'settings.json'), 'utf8')) as { hooks: { PreToolUse: { hooks: { command: string; args: string[] }[] }[] } };
    const hook = settings.hooks.PreToolUse[0]!.hooks[0]!;
    const r = spawnSync(hook.command, hook.args, {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: f.repo, tool_name: 'Write', tool_input: { file_path: join(f.repo, 'apps', '.env'), content: 'x' } }),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_POLICY_PATH: f.policyPath, ORBIT_POLICY_HASH: f.policyHash, ORBIT_WORKTREE: f.repo },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    expect(r.stdout).toContain('Orbit policy (scope.protected');

    // Usage comes from modelUsage, keyed by the model actually used.
    expect(result.models).toEqual(['claude-sonnet-5-5']);
    expect(result.usage).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', costSource: 'reported' });
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(2000);
    expect(result.usage.costUsd).toBeGreaterThan(0);

    // The worker never saw delivery credentials.
    const init = readFileSync(join(f.workerDir, 'log.jsonl'), 'utf8').split('\n')[0]!;
    expect(JSON.parse(init)).toMatchObject({ type: 'system', subtype: 'init', permissionMode: 'dontAsk', mcp_servers: [] });
  });

  it('claude-sandbox tier: an implementer\'s Bash runs inside the worktree, and a Bash write outside it is stopped by the sandbox', async () => {
    const { f, a } = setup([]);
    api.setSteps([
      { tool: 'Bash', input: { command: 'echo inside > apps/bash.txt', description: 'write inside' } },
      { tool: 'Bash', input: { command: `echo outside > ${join(f.base, 'outside.txt')}`, description: 'write outside' } },
      { structured: IMPLEMENTER_OUTPUT },
    ]);
    const { result } = await run(a, f);
    expect(result.status).toBe('succeeded');
    expect(readFileSync(join(f.repo, 'apps', 'bash.txt'), 'utf8')).toBe('inside\n');
    expect(existsSync(join(f.base, 'outside.txt'))).toBe(false);
  });

  it('a read-only role cannot change the worktree: Write, Edit and Bash are all refused, even inside allowed paths', async () => {
    const { f, a } = setup([]);
    api.setSteps([
      { tool: 'Write', input: { file_path: join(f.repo, 'apps', 'review.ts'), content: 'x\n' } },
      { tool: 'Edit', input: { file_path: join(f.repo, 'apps', 'a.ts'), old_string: 'a = 1', new_string: 'a = 2' } },
      { tool: 'Bash', input: { command: 'echo x > apps/bash-review.txt', description: 'write' } },
      { structured: REVIEW_OUTPUT },
    ]);
    const { result } = await run(a, f, { role: 'reviewer', readOnly: true, outputSchema: MODEL_OUTPUT_SCHEMAS.review });
    expect(result.status).toBe('succeeded');
    expect(result.structured).toEqual(REVIEW_OUTPUT);
    expect(existsSync(join(f.repo, 'apps', 'review.ts'))).toBe(false);
    expect(existsSync(join(f.repo, 'apps', 'bash-review.txt'))).toBe(false);
    expect(readFileSync(join(f.repo, 'apps', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('never hangs on a permission prompt: an unallowed tool call is denied and the run completes', async () => {
    const { f, a } = setup([]);
    api.setSteps([{ tool: 'Bash', input: { command: 'curl -s https://example.com', description: 'net' } }, { structured: IMPLEMENTER_OUTPUT }]);
    const started = Date.now();
    const { result } = await run(a, f, { timeoutMs: 45_000 });
    expect(result.status).toBe('succeeded');
    expect(result.permissionDenials.map((d) => d.tool_name)).toContain('Bash');
    expect(Date.now() - started).toBeLessThan(40_000);
  });

  it('rejects structured output that does not match the role schema (the CLI retries, then Orbit classifies malformed_output)', async () => {
    const { f, a } = setup([]);
    api.setSteps([{ structured: { summary: 'only a summary' } }]);
    const { result } = await run(a, f);
    expect(result.status).toBe('malformed_output');
    expect(result.reason).toBe('structured_output_retries');
  });

  it('classifies a 401 as auth_failed within seconds by aborting on the first authentication_failed retry event', async () => {
    const { f, a } = setup([]);
    api.setSteps([{ status: 401, error: { type: 'authentication_error', message: 'invalid x-api-key' } }]);
    const before = api.mainRequests().length;
    const started = Date.now();
    const { result } = await run(a, f);
    expect(result.status).toBe('auth_failed');
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(api.mainRequests().length - before).toBeLessThanOrEqual(3);
  });

  it('treats SIGINT cancellation (exit 0, no result line) as cancelled, never success', async () => {
    const { f, a } = setup([]);
    api.setSteps([{ delayMs: 30_000, text: 'too late' }]);
    const spec = implementerSpec(f, { env: {}, model: 'sonnet' });
    const handle = await a.startTask(spec);
    await waitFor(() => api.mainRequests().length > 0 || null, 20_000);
    await a.cancelTask(handle);
    const result = await waitFor(() => a.collectResult(handle, spec), 30_000);
    expect(result.status).toBe('cancelled');
    const exit = readExitRecord(f.workerDir)!;
    expect(exit.cancelled).toBe(true);
    expect(exit.code === 0 || exit.signal !== null).toBe(true);
  });

  it('restarts a worker in the same directory after archiving the attempt: the new attempt gets a new session id, so the CLI does not refuse it as already in use', async () => {
    const { f, a } = setup([]);
    api.setSteps([{ structured: IMPLEMENTER_OUTPUT }, { structured: IMPLEMENTER_OUTPUT }]);
    const first = await run(a, f);
    expect(first.result.status).toBe('succeeded');
    expect(archiveAttempt('claude', f.workerDir)).not.toBeNull();
    const second = await run(a, f);
    expect(second.handle.sessionId).not.toBe(first.handle.sessionId);
    expect(second.result.error).toBeNull();
    expect(second.result.status).toBe('succeeded');
    expect(second.result.sessionId).toBe(second.handle.sessionId);
  });

  it('treats SIGTERM sent to the shim alone as cancelled (the shim forwards it)', async () => {
    const { f, a } = setup([]);
    api.setSteps([{ delayMs: 30_000, text: 'too late' }]);
    const spec = implementerSpec(f, { env: {}, model: 'sonnet' });
    const handle = await a.startTask(spec);
    await waitFor(() => api.mainRequests().length > 0 || null, 20_000);
    process.kill(handle.pid, 'SIGTERM');
    const result = await waitFor(() => a.collectResult(handle, spec), 30_000);
    expect(result.status).toBe('cancelled');
    expect(readExitRecord(f.workerDir)).toMatchObject({ cancelled: true });
    archiveAttempt('claude', f.workerDir);
  });
});
