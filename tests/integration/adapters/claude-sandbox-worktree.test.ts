import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import { readJsonIfExists } from '../../../src/core/fsx.ts';
import { profileForWorker } from '../../../src/isolation/profiles.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';
import { startFakeAnthropicApi } from '../../fakes/fake-anthropic-api.mjs';
import { IMPLEMENTER_OUTPUT, implementerSpec, makeFixture, waitFor, type Fixture } from './helpers.ts';

// P14: in the claude-sandbox tier the worktree lives under ~/.orbit, which
// every worker profile read-denies (it holds every run). Claude Code's Bash
// sandbox got that deny list but no way back into the worktree, so node and
// npm died with "EPERM: operation not permitted, uv_cwd". The REAL claude CLI
// against a fake API, with the profile Orbit builds for a real run: the
// worktree is a git worktree under <home>/.orbit, the checkout and its parent
// are denied. Node and npm must run in the worktree, git must read the shared
// git directory, and credentials, the checkout and other runs stay denied.
const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
const CLAUDE = which.status === 0 ? which.stdout.trim() : null;
const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

type Api = Awaited<ReturnType<typeof startFakeAnthropicApi>>;
let api: Api;
let configDir: string;
const fixtures: Fixture[] = [];

function toolResults(f: Fixture): string[] {
  return readFileSync(join(f.workerDir, 'log.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; message?: { content?: unknown } })
    .filter((e) => e.type === 'user' && Array.isArray(e.message?.content))
    .flatMap((e) => (e.message!.content as { type: string; content?: unknown }[]).filter((c) => c.type === 'tool_result').map((c) => JSON.stringify(c.content)));
}

describe.skipIf(!CLAUDE || !canStripTypes)('claude-sandbox tier with a worktree under ~/.orbit (real claude CLI, fake API)', () => {
  beforeAll(async () => {
    api = await startFakeAnthropicApi({ steps: [{ text: 'ok' }] });
    configDir = mkdtempSync(join(tmpdir(), 'orbit-claude-cfg-'));
  });
  afterAll(async () => {
    await api?.close();
    rmSync(configDir, { recursive: true, force: true });
    for (const f of fixtures) rmSync(f.base, { recursive: true, force: true });
  });

  it('runs node, npm and git in the worktree while credentials, the checkout and other runs stay unreadable', async () => {
    const f = makeFixture('version: 1\nmode: supervised\nscope: {allowed_paths: ["apps/**"]}\nnetwork: {allowed_hosts: []}\n');
    fixtures.push(f);
    const home = join(f.base, 'home');
    const orbitHome = join(home, '.orbit');
    const worktree = join(orbitHome, 'repos', 'acme', 'worktrees', 'w1');
    mkdirSync(join(orbitHome, 'repos', 'acme', 'worktrees'), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'orbit/w1', worktree], { cwd: f.repo, stdio: 'ignore' });
    const wt = realpathSync(worktree);
    // Secrets the worker must not read: an SSH key, another run's state, the user's uncommitted checkout, a .env in the worktree.
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'ACME-SSH-SECRET\n');
    mkdirSync(join(orbitHome, 'runs', 'other'), { recursive: true });
    writeFileSync(join(orbitHome, 'runs', 'other', 'state.txt'), 'ACME-OTHER-RUN\n');
    writeFileSync(join(f.repo, 'uncommitted.txt'), 'ACME-CHECKOUT\n');
    writeFileSync(join(wt, '.env'), 'ACME_TOKEN=ACME-DOTENV\n');
    writeFileSync(join(wt, 'print-cwd.mjs'), "process.stdout.write('node-cwd=' + process.cwd());\n");
    writeFileSync(join(wt, 'read-file.mjs'), "import { readFileSync } from 'node:fs';\ntry { process.stdout.write(readFileSync(process.argv[2], 'utf8')); } catch (e) { process.stdout.write('read-failed ' + e.code); }\n");
    writeFileSync(join(wt, 'package.json'), '{"name":"acme","version":"1.0.0","private":true,"scripts":{"hello":"node -e \\"process.stdout.write(\'npm-ran-in=\'+process.cwd())\\""}}\n');

    const snapshot = readJsonIfExists<PolicySnapshot>(f.policyPath)!;
    const sandbox = profileForWorker({ worktree: wt, workerDir: f.workerDir, snapshot, provider: 'claude', claudeConfigDir: configDir, homeDir: home, policyPath: f.policyPath, env: {} });
    expect(sandbox.denyReadPaths).toContain(orbitHome);

    // One read per step: the guard hook refuses a whole command that names a credential path, which would hide whether
    // the sandbox itself denies the other reads.
    const reads = [join(home, '.ssh', 'id_ed25519'), join(orbitHome, 'runs', 'other', 'state.txt'), join(f.repo, 'uncommitted.txt'), join(wt, '.env')];
    api.setSteps([
      { tool: 'Bash', input: { command: 'node print-cwd.mjs', description: 'node' } },
      { tool: 'Bash', input: { command: 'npm run -s hello', description: 'npm' } },
      { tool: 'Bash', input: { command: 'git status --porcelain=v1 --branch && echo git-ok', description: 'git' } },
      ...reads.map((p) => ({ tool: 'Bash', input: { command: `head -n 1 ${p}; echo read-done`, description: 'read' } })),
      // The same credentials through a script, which the guard hook cannot see into: only the sandbox stands between.
      ...[reads[0]!, reads[3]!].map((p) => ({ tool: 'Bash', input: { command: `node read-file.mjs ${p}`, description: 'script read' } })),
      { structured: IMPLEMENTER_OUTPUT },
    ]);
    const a = new ClaudeAdapter({
      command: [CLAUDE!],
      tier: 'claude-sandbox',
      graceMs: 2_000,
      baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'dumb', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-fake-000', CLAUDE_CONFIG_DIR: configDir },
    });
    const spec = implementerSpec(f, { env: {}, model: 'sonnet', cwd: wt, sandbox });
    const handle = await a.startTask(spec);
    const result = await waitFor(() => a.collectResult(handle, spec), 90_000, 100);
    expect(result.status).toBe('succeeded');

    const outs = toolResults(f);
    // node, npm, git, each read, then the structured-output tool's own result.
    expect(outs).toHaveLength(3 + reads.length + 2 + 1);
    const [nodeOut, npmOut, gitOut, ...readOuts] = outs.slice(0, -1);
    expect(nodeOut).toContain(`node-cwd=${wt}`);
    expect(nodeOut).not.toContain('uv_cwd');
    expect(npmOut).toContain(`npm-ran-in=${wt}`);
    expect(gitOut).toContain('git-ok');
    expect(gitOut).toContain('orbit/w1');
    expect(readOuts).toHaveLength(reads.length + 2);
    const all = readOuts.join('\n');
    for (const secret of ['ACME-SSH-SECRET', 'ACME-OTHER-RUN', 'ACME-CHECKOUT', 'ACME-DOTENV']) expect(all).not.toContain(secret);
    // Another run's state and the user's checkout are refused by the OS sandbox, not only by the guard hook. Seatbelt
    // (macOS) refuses the read; bubblewrap (Linux) hides a denied path behind an empty tmpfs, so the file is not there.
    const denied = process.platform === 'darwin' ? /Operation not permitted/ : /No such file or directory/;
    expect(readOuts[1]).toMatch(denied);
    expect(readOuts[2]).toMatch(denied);
    // A credential file nested inside the re-opened worktree stays denied, as does the SSH key.
    // The error differs by platform and path kind (EPERM from Seatbelt; EACCES or ENOENT from bubblewrap's masks).
    const scriptDenied = process.platform === 'darwin' ? /read-failed EPERM/ : /read-failed E(ACCES|NOENT)/;
    expect(readOuts[4]).toMatch(scriptDenied);
    expect(readOuts[5]).toMatch(scriptDenied);
  }, 180_000);
});
