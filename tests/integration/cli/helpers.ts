/**
 * A lab for driving the real `orbit` CLI as a child process (Node transforms
 * the TypeScript sources), against a temp git repository, a private HOME and
 * ORBIT_HOME, and the fake provider CLIs placed on PATH. Nothing here touches
 * the developer's own configuration, credentials or terms file.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORBIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const CLI_ENTRY = join(ORBIT_ROOT, 'src', 'cli', 'main.ts');
export const FAKE_CLAUDE = join(ORBIT_ROOT, 'tests', 'fakes', 'fake-claude.mjs');
export const FAKE_CODEX = join(ORBIT_ROOT, 'tests', 'fakes', 'fake-codex.mjs');

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  base: string;
  repo: string;
  home: string;
  orbitHome: string;
  /** Directory holding the fake `claude` and `codex` executables, when created. */
  tools: string;
  env(extra?: Record<string, string>): Record<string, string>;
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number; detached?: boolean }): Promise<CliResult>;
  close(): void;
}

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'acme',
  GIT_AUTHOR_EMAIL: 'dev@acme.test',
  GIT_COMMITTER_NAME: 'acme',
  GIT_COMMITTER_EMAIL: 'dev@acme.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** An executable that runs a fake provider script under this Node, with optional version override. */
export function writeFake(dir: string, name: 'claude' | 'codex', env: Record<string, string> = {}): void {
  const script = name === 'claude' ? FAKE_CLAUDE : FAKE_CODEX;
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('\n');
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(path, 0o755);
}

/** A minimal policy. Isolation is off so tests do not depend on the host's sandbox, and both providers are the fakes found on PATH. */
export const TEST_CONFIG = [
  'version: 1',
  'mode: autonomous',
  'repository:',
  '  base_branch: main',
  'scope:',
  '  allowed_paths: ["src/**"]',
  'checks:',
  '  unit:',
  '    command: [node, -e, "process.exit(0)"]',
  'isolation:',
  '  provider: none',
  '  allow_unisolated: true',
  'providers:',
  '  claude: {command: claude, data_policy_eligible: true}',
  '  codex: {command: codex, data_policy_eligible: true, model: gpt-6-astra}',
  'knowledge:',
  '  enabled: true',
  '',
].join('\n');

export function makeSandbox(opts: { config?: string | null; fakes?: { claude?: Record<string, string> | false; codex?: Record<string, string> | false } } = {}): Sandbox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-cli-')));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const tools = join(base, 'tools');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(tools, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# acme\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  if (opts.config !== null) {
    mkdirSync(join(repo, '.orbit'), { recursive: true });
    writeFileSync(join(repo, '.orbit', 'config.yaml'), opts.config ?? TEST_CONFIG);
  }
  // `node` for the checks that run it. Node's own directory is not on PATH: a globally installed `claude` or `codex` lives beside
  // node on CI runners, and a test that says "no claude on PATH" must not find the real one.
  symlinkSync(process.execPath, join(tools, 'node'));
  const fakes = opts.fakes ?? {};
  if (fakes.claude !== false) writeFake(tools, 'claude', fakes.claude ?? {});
  if (fakes.codex !== false) writeFake(tools, 'codex', fakes.codex ?? {});

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: `${tools}:/usr/bin:/bin`,
    HOME: home,
    ORBIT_HOME: join(home, '.orbit'),
    USER: 'alice',
    LANG: 'C',
    ...GIT_ENV,
    ...extra,
  });
  return {
    base,
    repo,
    home,
    orbitHome: join(home, '.orbit'),
    tools,
    env,
    run(args, o = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', CLI_ENTRY, ...args], { cwd: o.cwd ?? repo, env: env(o.env), stdio: ['pipe', 'pipe', 'pipe'], detached: o.detached === true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`orbit ${args.join(' ')} timed out; stdout: ${stdout.slice(-500)} stderr: ${stderr.slice(-500)}`));
        }, o.timeoutMs ?? 90_000);
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
        child.stdin.end(o.input ?? '');
      });
    },
    close() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const scratch: string[] = [];

/** A directory for files a fake needs before the sandbox that uses it exists (scenario files). Removed by removeScratch(). */
export function makeScratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-cli-scratch-')));
  scratch.push(dir);
  return dir;
}

export function removeScratch(): void {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
}
