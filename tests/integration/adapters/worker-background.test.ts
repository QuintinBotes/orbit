import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import { readExitRecord } from '../../../src/adapters/shim.ts';
import { prepareWorkerTmpDir, profileForWorker } from '../../../src/isolation/profiles.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { startFakeAnthropicApi } from '../../fakes/fake-anthropic-api.mjs';
import { IMPLEMENTER_OUTPUT, alive, implementerSpec, makeFixture, waitFor, withHarnessLoopback, type Fixture } from './helpers.ts';

/**
 * Review of issue #31. `claude -p` writes its result and then does not exit while a background task of the session is
 * alive: a command the model starts with run_in_background, or a foreground one Claude Code moves to the background when
 * it outlives its Bash timeout. Measured before the fix with the REAL claude CLI against a fake API (worker timeout
 * 45 s), with a test server, the long command agents start most, and in the review's control with a background sleep:
 * the sessions wrote their result within seconds and then ran to the timeout, so the adapter reported `timeout` for
 * finished work, which recovery sends to diagnosis. Background tasks are now off for workers
 * (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS): the parameter is refused, a foreground command ends at its Bash timeout, and the
 * session ends with its result. A worker may not listen on macOS (its server would die at once), so the long command here
 * is a process that records its pid and stays alive.
 */
const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
const CLAUDE = which.status === 0 ? which.stdout.trim() : null;
const ORBIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const srt = new SandboxRuntimeIsolation({ orbitInstallDir: ORBIT_ROOT });
const srtStatus = await srt.available();
const WORKER_TIMEOUT_MS = 45_000;
const LONG = `require('fs').writeFileSync('pid.txt', String(process.pid));
console.log('running');
setInterval(() => {}, 1000);
`;

let api: Awaited<ReturnType<typeof startFakeAnthropicApi>>;
let configDir: string;
const fixtures: Fixture[] = [];

/** One implementer session whose one Bash step starts the long command as given, then gives its result. */
async function session(tier: 'os-sandbox' | 'claude-sandbox', bash: Record<string, unknown>) {
  const f = makeFixture('version: 1\nmode: supervised\nscope: {allowed_paths: ["**"]}\nnetwork: {allowed_hosts: []}\n');
  fixtures.push(f);
  writeFileSync(join(f.repo, 'long.cjs'), LONG);
  const snapshot = verifySnapshot(f.policyPath, f.policyHash);
  const sandbox = profileForWorker({ worktree: f.repo, workerDir: f.workerDir, snapshot, provider: 'claude', claudeConfigDir: configDir, homeDir: homedir(), tmpDir: prepareWorkerTmpDir(f.workerDir), policyPath: f.policyPath, readablePaths: [ORBIT_ROOT], timeoutMs: WORKER_TIMEOUT_MS, env: {} });
  expect(sandbox.allowLocalBinding).toBeUndefined();
  api.setSteps([{ tool: 'Bash', input: { description: 'start the long command', ...bash } }, { structured: IMPLEMENTER_OUTPUT }]);
  const a = new ClaudeAdapter({
    command: [CLAUDE!],
    // In the os-sandbox tier the CLI runs inside srt and reaches the fake API on loopback only through the harness.
    ...(tier === 'os-sandbox' ? { isolation: withHarnessLoopback(srt) } : { tier }),
    graceMs: 1_000,
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'dumb', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-fake-000', CLAUDE_CONFIG_DIR: configDir },
  });
  const spec = implementerSpec(f, { env: {}, cwd: f.repo, sandbox, timeoutMs: WORKER_TIMEOUT_MS });
  const started = Date.now();
  const handle = await a.startTask(spec);
  expect(handle.tier).toBe(tier);
  const result = await waitFor(() => a.collectResult(handle, spec), 120_000, 100);
  const elapsedMs = Date.now() - started;
  const tool = readFileSync(join(f.workerDir, 'log.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; message?: { content?: unknown } })
    .filter((e) => e.type === 'user' && Array.isArray(e.message?.content))
    .flatMap((e) => (e.message!.content as { type: string; content?: unknown }[]).filter((c) => c.type === 'tool_result').map((c) => JSON.stringify(c.content)))[0];
  const pidFile = join(f.repo, 'pid.txt');
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null;
  return { result, elapsedMs, exit: readExitRecord(f.workerDir), tool: tool ?? '', pid };
}

describe.skipIf(!CLAUDE)('a long command a worker starts does not hold its session open (real claude CLI, fake API)', () => {
  beforeAll(async () => {
    api = await startFakeAnthropicApi({ steps: [{ text: 'ok' }] });
    configDir = mkdtempSync(join(tmpdir(), 'orbit-claude-cfg-'));
  });
  afterAll(async () => {
    await api?.close();
    rmSync(configDir, { recursive: true, force: true });
    for (const f of fixtures) rmSync(f.base, { recursive: true, force: true });
  });

  // srt on Linux gives the whole CLI a loopback of its own, where the host's fake API is out of reach.
  const tiers = (['claude-sandbox', 'os-sandbox'] as const).filter((t) => t === 'claude-sandbox' || (srtStatus.ok && process.platform === 'darwin'));
  for (const tier of tiers) {
    it(`${tier} tier: a command started with run_in_background is refused, and the session ends with its result`, async () => {
      const s = await session(tier, { command: 'node long.cjs', run_in_background: true });
      expect(s.result.status, s.result.error ?? '').toBe('succeeded');
      expect(s.exit).toMatchObject({ timedOut: false, escalation: [] });
      expect(s.elapsedMs).toBeLessThan(WORKER_TIMEOUT_MS / 2);
      expect(s.tool).not.toMatch(/running in background/i);
      expect(s.pid).toBeNull();
    }, 180_000);

    it(`${tier} tier: a foreground command ends at its Bash timeout instead of moving to the background, and is gone afterwards`, async () => {
      const s = await session(tier, { command: 'node long.cjs', timeout: 3_000 });
      expect(s.result.status, s.result.error ?? '').toBe('succeeded');
      expect(s.exit).toMatchObject({ timedOut: false, escalation: [] });
      expect(s.elapsedMs).toBeLessThan(WORKER_TIMEOUT_MS / 2);
      expect(s.tool).toMatch(/timed out/i);
      expect(s.tool).not.toMatch(/moved to the background/i);
      expect(s.pid).not.toBeNull();
      expect(alive(s.pid!)).toBe(false);
    }, 180_000);
  }
});
