import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import { prepareWorkerTmpDir, profileForWorker } from '../../../src/isolation/profiles.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { startFakeAnthropicApi } from '../../fakes/fake-anthropic-api.mjs';
import { FAKE_CLAUDE, IMPLEMENTER_OUTPUT, implementerSpec, makeFixture, waitFor, writeScenario, type Fixture } from './helpers.ts';

// The os-sandbox tier: the whole provider process inside srt. Skipped when
// srt cannot run here (no binary, or an outer sandbox that forbids nesting).
const ORBIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const srt = new SandboxRuntimeIsolation({ orbitInstallDir: ORBIT_ROOT });
const srtStatus = await srt.available();
const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
const CLAUDE = which.status === 0 ? which.stdout.trim() : null;

const fixtures: Fixture[] = [];
let configDir: string;

function osSpec(f: Fixture, extraHosts: string[] = []) {
  // The fixture's base directory is the repository's parent, which the
  // profile denies (sibling projects), so the fake's scenario lives in the
  // worker directory.
  const spec = implementerSpec(f, { env: { ORBIT_FAKE_SCENARIO: join(f.workerDir, 'scenario.json') } });
  const snapshot = verifySnapshot(f.policyPath, f.policyHash);
  const tmp = prepareWorkerTmpDir(f.workerDir);
  const profile = profileForWorker({ worktree: f.repo, workerDir: f.workerDir, snapshot, provider: 'claude', claudeConfigDir: configDir, homeDir: homedir(), tmpDir: tmp, policyPath: f.policyPath, readablePaths: [ORBIT_ROOT], timeoutMs: 60_000 });
  return { ...spec, sandbox: { ...profile, allowedHosts: [...profile.allowedHosts, ...extraHosts] } };
}

describe.skipIf(!srtStatus.ok)(`ClaudeAdapter os-sandbox tier under srt (${srtStatus.detail})`, () => {
  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), 'orbit-claude-cfg-'));
  });
  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
    for (const f of fixtures) rmSync(f.base, { recursive: true, force: true });
  });

  it('confines a forbidden write at the OS level while in-worktree edits succeed', async () => {
    const f = makeFixture();
    fixtures.push(f);
    const outside = join(f.base, 'outside.txt');
    writeScenario({ ...f, scenarioPath: join(f.workerDir, 'scenario.json') }, { roles: { '*': [{ edits: [{ op: 'write', path: 'apps/inside.ts', content: 'ok\n' }], forbiddenWrite: { path: outside }, structured: IMPLEMENTER_OUTPUT }] } });
    const a = new ClaudeAdapter({
      command: [process.execPath, FAKE_CLAUDE],
      isolation: srt,
      tier: 'os-sandbox',
      graceMs: 300,
      baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: 'sk-ant-fake-000', CLAUDE_CONFIG_DIR: configDir },
    });
    const spec = osSpec(f);
    const handle = await a.startTask(spec);
    expect(handle.tier).toBe('os-sandbox');
    expect(handle.limitations.join(' ')).toMatch(/CPU, memory or process-count/);
    const result = await waitFor(() => a.collectResult(handle, spec), 60_000);
    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(readFileSync(join(f.repo, 'apps', 'inside.ts'), 'utf8')).toBe('ok\n');
    expect(existsSync(outside)).toBe(false);
    expect(readFileSync(join(f.workerDir, 'log.jsonl'), 'utf8')).toMatch(/denied: EPERM/);
  });

  it('refuses the os-sandbox tier without an environment credential (a keychain login is invisible inside srt)', async () => {
    const f = makeFixture();
    fixtures.push(f);
    const a = new ClaudeAdapter({ command: [process.execPath, FAKE_CLAUDE], isolation: srt, tier: 'os-sandbox', baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME } });
    await expect(a.startTask(osSpec(f))).rejects.toMatchObject({ code: 'AUTH_MISSING' });
  });

  // The real CLI starts inside srt (srt's own flags end at "--", so claude's
  // --settings reaches claude) and its session comes up in dontAsk. The fake
  // API cannot be reached from inside: the worker profile allows no loopback
  // connections, so a local mock is out of reach by design and the run ends
  // in a connection error, not a hang.
  it.skipIf(!CLAUDE)('starts the real claude CLI inside srt with an env credential; loopback stays unreachable', async () => {
    const api = await startFakeAnthropicApi({ steps: [{ structured: IMPLEMENTER_OUTPUT }] });
    try {
      const f = makeFixture();
      fixtures.push(f);
      const a = new ClaudeAdapter({
        command: [CLAUDE!],
        isolation: srt,
        graceMs: 1_000,
        baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'dumb', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-fake-000', CLAUDE_CONFIG_DIR: configDir },
      });
      const spec = { ...osSpec(f, ['127.0.0.1', 'localhost']), env: {} };
      const handle = await a.startTask(spec);
      expect(handle.tier).toBe('os-sandbox');
      const result = await waitFor(() => a.collectResult(handle, spec), 90_000, 100);
      const init = JSON.parse(readFileSync(join(f.workerDir, 'log.jsonl'), 'utf8').split('\n')[0]!) as Record<string, unknown>;
      expect(init).toMatchObject({ type: 'system', subtype: 'init', permissionMode: 'dontAsk', mcp_servers: [] });
      expect(result.status).not.toBe('succeeded');
      expect(api.mainRequests()).toHaveLength(0);
    } finally {
      await api.close();
    }
  });
});
