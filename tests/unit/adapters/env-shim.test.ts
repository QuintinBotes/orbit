import { describe, expect, it } from 'vitest';
import { buildWorkerEnv, claudeEnvCredential, passThrough } from '../../../src/adapters/env.ts';
import { parseShimArgs, shimArgs } from '../../../src/adapters/shim.ts';
import { sessionIdFor } from '../../../src/adapters/supervise.ts';

const HOST = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/u',
  LANG: 'en_US.UTF-8',
  LC_CTYPE: 'UTF-8',
  TERM: 'xterm',
  CLAUDE_CONFIG_DIR: '/home/u/.claude-x',
  ANTHROPIC_API_KEY: 'sk-ant-user',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-user',
  CODEX_API_KEY: 'sk-codex',
  CODEX_HOME: '/home/u/.codex',
  OPENAI_API_KEY: 'sk-openai',
  GH_TOKEN: 'ghp_x',
  GITHUB_TOKEN: 'ghs_x',
  SSH_AUTH_SOCK: '/tmp/ssh.sock',
  AWS_ACCESS_KEY_ID: 'AKIA',
  AWS_SECRET_ACCESS_KEY: 'secret',
  AWS_PROFILE: 'acme',
  GOOGLE_APPLICATION_CREDENTIALS: '/home/u/gcp.json',
  AZURE_CLIENT_SECRET: 'az',
  NPM_TOKEN: 'npm_x',
  NODE_AUTH_TOKEN: 'npm_y',
  NODE_OPTIONS: '--require /evil.js',
  DYLD_INSERT_LIBRARIES: '/evil.dylib',
  CLAUDE_CODE_RETRY_WATCHDOG: '1',
  CLAUDE_CODE_EFFORT_LEVEL: 'max',
  CLAUDE_CODE_USE_BEDROCK: '1',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
  HTTPS_PROXY: 'http://proxy.acme.test:3128',
};

const input = (provider: 'claude' | 'codex', extra?: Record<string, string>) => ({ provider, base: HOST, policyPath: '/run/policy.json', policyHash: 'sha256:abc', worktree: '/wt', tmpDir: '/tmp/orbit-1/x', extra });

describe('buildWorkerEnv', () => {
  it('starts from an allowlist: delivery, cloud, registry and loader variables never reach a worker', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const env = buildWorkerEnv(input(provider));
      for (const leaked of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CLIENT_SECRET', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'CLAUDE_CODE_RETRY_WATCHDOG', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_USE_BEDROCK', 'DOCKER_HOST', 'OPENAI_API_KEY']) {
        expect(env, `${provider}: ${leaked}`).not.toHaveProperty(leaked);
      }
      expect(env).toMatchObject({ PATH: HOST.PATH, HOME: HOST.HOME, LANG: HOST.LANG, LC_CTYPE: 'UTF-8', HTTPS_PROXY: HOST.HTTPS_PROXY, GIT_OPTIONAL_LOCKS: '0', TMPDIR: '/tmp/orbit-1/x' });
      expect(env).toMatchObject({ ORBIT_POLICY_PATH: '/run/policy.json', ORBIT_POLICY_HASH: 'sha256:abc', ORBIT_WORKTREE: '/wt' });
    }
  });

  it('marks every worker environment with ORBIT_WORKER=1 for the plugin hooks, and refuses a caller that tries to unset it', () => {
    for (const provider of ['claude', 'codex'] as const) expect(buildWorkerEnv(input(provider)).ORBIT_WORKER).toBe('1');
    expect(() => buildWorkerEnv(input('claude', { ORBIT_WORKER: '0' }))).toThrow(/may not set/);
  });

  it('passes each provider only its own credentials and config directory', () => {
    const claude = buildWorkerEnv(input('claude'));
    expect(claude).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant-user', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-user', CLAUDE_CONFIG_DIR: '/home/u/.claude-x', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_MAX_RETRIES: '4' });
    expect(claude).not.toHaveProperty('CODEX_API_KEY');
    // Observed to switch the session out of dontAsk; never set.
    expect(claude).not.toHaveProperty('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB');
    const codex = buildWorkerEnv(input('codex'));
    expect(codex).toMatchObject({ CODEX_API_KEY: 'sk-codex', CODEX_HOME: '/home/u/.codex' });
    expect(codex).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(codex).not.toHaveProperty('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
  });

  it('refuses extra variables that would add credentials or undo fixed settings, and cannot be used to move the guard', () => {
    for (const bad of ['GH_TOKEN', 'AWS_REGION', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'LD_PRELOAD', 'CLAUDE_CODE_EFFORT_LEVEL', 'ORBIT_POLICY_PATH', 'ORBIT_WORKTREE']) {
      expect(() => buildWorkerEnv(input('claude', { [bad]: 'x' })), bad).toThrow(/may not set/);
    }
    expect(buildWorkerEnv(input('claude', { ORBIT_FAKE_SCENARIO: '/s.json', CI: '1' }))).toMatchObject({ ORBIT_FAKE_SCENARIO: '/s.json', CI: '1' });
    expect(() => passThrough(HOST, ['GITHUB_TOKEN'])).toThrow(/may not pass through/);
    expect(passThrough(HOST, ['LANG', 'MISSING'])).toEqual({ LANG: HOST.LANG });
  });

  it('names (never returns) the env credential that enables the os-sandbox tier', () => {
    expect(claudeEnvCredential(HOST)).toBe('ANTHROPIC_API_KEY');
    expect(claudeEnvCredential({ CLAUDE_CODE_OAUTH_TOKEN: 't' })).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(claudeEnvCredential({ ANTHROPIC_API_KEY: '  ' })).toBeNull();
  });
});

describe('shim command line', () => {
  it('round-trips through shimArgs and parseShimArgs, provider argv untouched after --', () => {
    const args = shimArgs({ workerDir: '/w', timeoutMs: 5000, graceMs: 100, sessionId: 's', stdinPath: '/w/prompt.md', cwd: '/wt', abortOn: [{ type: 'system', error: 'authentication_failed' }], cleanupPaths: ['/tmp/orbit-srt-1'], argv: ['claude', '--settings', 'x', '--', '-p'] });
    expect(parseShimArgs(args)).toEqual({ workerDir: '/w', timeoutMs: 5000, graceMs: 100, sessionId: 's', stdinPath: '/w/prompt.md', cwd: '/wt', abortOn: [{ type: 'system', error: 'authentication_failed' }], cleanupPaths: ['/tmp/orbit-srt-1'], argv: ['claude', '--settings', 'x', '--', '-p'] });
  });

  it('rejects malformed invocations', () => {
    expect(() => parseShimArgs(['--worker-dir', '/w'])).toThrow(/expected --/);
    expect(() => parseShimArgs(['--worker-dir', 'rel', '--', 'x'])).toThrow(/absolute/);
    expect(() => parseShimArgs(['--worker-dir', '/w', '--timeout-ms', '-1', '--', 'x'])).toThrow(/non-negative/);
    expect(() => parseShimArgs(['--worker-dir', '/w', '--bogus', '1', '--', 'x'])).toThrow(/unknown option/);
    expect(() => parseShimArgs(['--worker-dir', '/w', '--abort-on', '[1]', '--', 'x'])).toThrow(/JSON object/);
    expect(() => parseShimArgs(['--worker-dir', '--', 'x'])).toThrow();
  });
});

describe('sessionIdFor', () => {
  it('is a deterministic version 4 UUID per worker and attempt', () => {
    const a = sessionIdFor('w1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionIdFor('w1')).toBe(a);
    expect(sessionIdFor('w1', 1)).not.toBe(a);
    expect(sessionIdFor('w2')).not.toBe(a);
  });
});
