import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import { prepareWorkerTmpDir, profileForWorker } from '../../../src/isolation/profiles.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { startFakeAnthropicApi } from '../../fakes/fake-anthropic-api.mjs';
import { IMPLEMENTER_OUTPUT, implementerSpec, makeFixture, waitFor, withHarnessLoopback, type Fixture } from './helpers.ts';

/**
 * Review of issue #31. A running IDE extension (VS Code, JetBrains) writes <config dir>/ide/<port>.lock, which holds the
 * auth token of the extension's MCP server on loopback (openFile, saveDocument, executeCode in a Jupyter kernel). A worker
 * that can read that token and reach loopback can call the server, which runs outside every sandbox. Measured while this
 * branch let workers use loopback, with the REAL claude CLI against a fake API and a stand-in server that answers only
 * the token: in the os-sandbox tier the worker's Bash read the lock and the server accepted it; in the claude-sandbox
 * tier Bash could not read it, but the Read tool, which runs outside Claude Code's sandbox there, returned the token to
 * the model, and a Bash command carrying it was accepted. A check never could: its profile denies the whole config dir.
 * Workers no longer reach loopback (they may not listen, and connect only to their proxy), so the deny is a second
 * barrier; the os-sandbox case runs with loopback opened by the harness (for the fake API), the setting that needs it.
 */
const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
const CLAUDE = which.status === 0 ? which.stdout.trim() : null;
const ORBIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const srt = new SandboxRuntimeIsolation({ orbitInstallDir: ORBIT_ROOT });
const srtStatus = await srt.available();
const TOKEN = 'ide-lock-token-5f1c0e9a7b';

let api: Awaited<ReturnType<typeof startFakeAnthropicApi>>;
let ide: Server;
let port = 0;
let accepted = 0;
let configDir: string;
const fixtures: Fixture[] = [];

/** One implementer session: the Read tool on the lock file, then a Bash step whose script reads it and calls the server. */
async function session(tier: 'os-sandbox' | 'claude-sandbox') {
  const f = makeFixture('version: 1\nmode: supervised\nscope: {allowed_paths: ["**"]}\nnetwork: {allowed_hosts: []}\n');
  fixtures.push(f);
  const lock = join(configDir, 'ide', `${port}.lock`);
  writeFileSync(
    join(f.repo, 'probe.cjs'),
    `const fs = require('fs');
let t = '';
try { t = JSON.parse(fs.readFileSync(${JSON.stringify(lock)}, 'utf8')).authToken; } catch (e) { console.log('READ-FAIL ' + e.code); }
require('http').get({ host: '127.0.0.1', port: ${port}, headers: { 'x-claude-code-ide-authorization': t } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => console.log('RESP ' + r.statusCode + ' ' + b)); }).on('error', (e) => console.log('CONNECT-FAIL ' + e.code));
`,
  );
  const snapshot = verifySnapshot(f.policyPath, f.policyHash);
  const sandbox = profileForWorker({ worktree: f.repo, workerDir: f.workerDir, snapshot, provider: 'claude', claudeConfigDir: configDir, homeDir: homedir(), tmpDir: prepareWorkerTmpDir(f.workerDir), policyPath: f.policyPath, readablePaths: [ORBIT_ROOT], timeoutMs: 60_000, env: {} });
  expect(sandbox.allowLocalBinding).toBeUndefined();
  api.setSteps([{ tool: 'Read', input: { file_path: lock } }, { tool: 'Bash', input: { command: 'node probe.cjs', description: 'probe' } }, { structured: IMPLEMENTER_OUTPUT }]);
  const a = new ClaudeAdapter({
    command: [CLAUDE!],
    // In the os-sandbox tier the CLI runs inside srt and reaches the fake API on loopback only through the harness.
    ...(tier === 'os-sandbox' ? { isolation: withHarnessLoopback(srt) } : { tier }),
    graceMs: 1_000,
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'dumb', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-fake-000', CLAUDE_CONFIG_DIR: configDir },
  });
  const spec = implementerSpec(f, { env: {}, cwd: f.repo, sandbox, timeoutMs: 60_000 });
  const before = api.requests.length;
  const handle = await a.startTask(spec);
  expect(handle.tier).toBe(tier);
  const result = await waitFor(() => a.collectResult(handle, spec), 120_000, 100);
  // What the model was sent back: every tool result in this session's requests.
  const seen = api.requests
    .slice(before)
    .filter((r) => r.main)
    .flatMap((r) => (r.toolResults ?? []) as { content: unknown }[])
    .map((c) => JSON.stringify(c.content));
  return { result, seen: [...new Set(seen)], stderr: readFileSync(join(f.workerDir, 'stderr.log'), 'utf8') };
}

describe.skipIf(!CLAUDE)('a worker cannot read the token of an IDE extension on loopback (real claude CLI, fake API)', () => {
  beforeAll(async () => {
    api = await startFakeAnthropicApi({ steps: [{ text: 'ok' }] });
    ide = createServer((req, res) => {
      const ok = req.headers['x-claude-code-ide-authorization'] === TOKEN;
      if (ok) accepted++;
      res.end(ok ? 'IDE-ACCEPTED' : 'IDE-REFUSED');
    });
    await new Promise<void>((resolve) => ide.listen(0, '127.0.0.1', () => resolve()));
    port = (ide.address() as { port: number }).port;
    configDir = mkdtempSync(join(tmpdir(), 'orbit-claude-cfg-'));
    mkdirSync(join(configDir, 'ide'));
    writeFileSync(join(configDir, 'ide', `${port}.lock`), JSON.stringify({ pid: process.pid, workspaceFolders: [ORBIT_ROOT], ideName: 'Visual Studio Code', transport: 'ws', runningInWindows: false, authToken: TOKEN }));
  });
  afterAll(async () => {
    await api?.close();
    await new Promise((resolve) => ide?.close(resolve));
    rmSync(configDir, { recursive: true, force: true });
    for (const f of fixtures) rmSync(f.base, { recursive: true, force: true });
  });

  // srt on Linux gives the whole CLI a loopback of its own, where the host's fake API is out of reach.
  it.skipIf(!srtStatus.ok || process.platform !== 'darwin')('os-sandbox tier: neither the Read tool nor Bash reads the lock, and the session still succeeds', async () => {
    const { result, seen, stderr } = await session('os-sandbox');
    expect(result.status, `${result.error ?? ''} ${stderr}`).toBe('succeeded');
    expect(seen.join('\n')).not.toContain(TOKEN);
    expect(seen[0]).toMatch(/EPERM|not permitted/i);
    expect(seen[1]).toMatch(/READ-FAIL EPERM/);
    expect(seen[1]).not.toMatch(/IDE-ACCEPTED/);
    expect(accepted).toBe(0);
  });

  it('claude-sandbox tier: the Read tool is denied by permission and Bash cannot read the lock', async () => {
    const { result, seen, stderr } = await session('claude-sandbox');
    expect(result.status, `${result.error ?? ''} ${stderr}`).toBe('succeeded');
    expect(seen.join('\n')).not.toContain(TOKEN);
    expect(seen[0]).toMatch(/denied|permission/i);
    expect(seen[1]).toMatch(/READ-FAIL E[A-Z]+/);
    expect(seen[1]).not.toMatch(/IDE-ACCEPTED/);
    expect(accepted).toBe(0);
  });
});
