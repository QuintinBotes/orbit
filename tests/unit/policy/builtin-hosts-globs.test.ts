import { describe, expect, it } from 'vitest';
import { BUILTIN_CREDENTIAL_PATHS, BUILTIN_PROTECTED_PATHS, BUILTIN_PROTECTIONS, credentialGlobsOf, effectiveProtectedPaths, isCredentialGlob } from '../../../src/policy/builtin.ts';
import { hostAllowed, hostEntryCovered, hostEntryProblem, normalizeHost } from '../../../src/policy/hosts.ts';
import { compileGlobs, globBases, globProblem } from '../../../src/policy/globs.ts';

describe('built-in protections', () => {
  it('include every protection the policy contract names, each with a reason', () => {
    for (const g of ['.orbit/**', '.git/**', '**/.git/**', '.orbit/config.yaml', '**/.env*', '**/*.pem', '**/id_rsa*', '**/.npmrc', '**/.netrc']) {
      expect(BUILTIN_PROTECTED_PATHS).toContain(g);
    }
    for (const p of BUILTIN_PROTECTIONS) expect(p.why.length).toBeGreaterThan(20);
    expect(Object.isFrozen(BUILTIN_PROTECTED_PATHS)).toBe(true);
  });

  it('mark only secret-holding globs as credentials', () => {
    expect(BUILTIN_CREDENTIAL_PATHS).toEqual(expect.arrayContaining(['**/.env*', '**/*.pem', '**/id_rsa*', '**/.npmrc', '**/.netrc']));
    expect(BUILTIN_CREDENTIAL_PATHS).not.toContain('.git/**');
  });

  it('merge built-ins first with the user list, without duplicates', () => {
    const merged = effectiveProtectedPaths({ scope: { allowed_paths: [], protected_paths: ['infra/**', '**/.env*'] } });
    expect(merged.slice(0, BUILTIN_PROTECTED_PATHS.length)).toEqual([...BUILTIN_PROTECTED_PATHS]);
    expect(merged.filter((g) => g === '**/.env*')).toHaveLength(1);
    expect(merged).toContain('infra/**');
  });
});

describe('protected credential globs of a policy', () => {
  it.each(['secrets/**', 'config/*.key', '**/*.pem', 'deploy/credentials.json', '**/*secret*', 'infra/terraform.tfvars', 'config/api_key.txt', 'private-key/**', '**/.env.production', 'ops/passwords/**', 'certs/*.p12'])('treats %s as credential material', (glob) => {
    expect(isCredentialGlob(glob), glob).toBe(true);
  });

  it.each(['.github/**', 'infra/**', '.orbit/config.yaml', 'apps/locked/**', 'src/tokenizer/**', 'packages/keyboard/**', 'docs/**', 'src/author/**'])('does not treat %s as credential material', (glob) => {
    expect(isCredentialGlob(glob), glob).toBe(false);
  });

  it('adds the policy\'s credential globs to the built-in ones, from the effective list and from the config', () => {
    const globs = credentialGlobsOf({ effective_protected_paths: ['.github/**', 'secrets/**'], config: { scope: { protected_paths: ['config/*.key', 'infra/**'] } } });
    expect(globs).toEqual(expect.arrayContaining([...BUILTIN_CREDENTIAL_PATHS, 'secrets/**', 'config/*.key']));
    expect(globs).not.toContain('.github/**');
    expect(globs).not.toContain('infra/**');
    expect(credentialGlobsOf({})).toEqual([...BUILTIN_CREDENTIAL_PATHS]);
  });
});

describe('hosts', () => {
  it('validates allowlist entries', () => {
    expect(hostEntryProblem('github.com')).toBeNull();
    expect(hostEntryProblem('localhost')).toBeNull();
    expect(hostEntryProblem('10.0.0.1')).toBeNull();
    expect(hostEntryProblem('*.github.com')).toBeNull();
    for (const bad of ['*', '*.com', 'GitHub.com', 'github.com:443', 'https://github.com', 'a/b', 'x.*.com', '*.10.0.0.1', '-bad.com', '1.2.3', '']) {
      expect(hostEntryProblem(bad), bad).not.toBeNull();
    }
  });

  it('normalizes hosts before comparing', () => {
    expect(normalizeHost('GitHub.COM.')).toBe('github.com');
    expect(normalizeHost('github.com:443')).toBe('github.com');
    expect(normalizeHost('[::1]:8080')).toBe('[::1]');
    expect(normalizeHost('github.com:http')).toBeNull();
    expect(normalizeHost('a b')).toBeNull();
  });

  it('matches wildcards on label boundaries only', () => {
    expect(hostAllowed('api.github.com', ['*.github.com'])).toBe(true);
    expect(hostAllowed('github.com', ['*.github.com'])).toBe(false);
    expect(hostAllowed('evilgithub.com', ['*.github.com'])).toBe(false);
    expect(hostAllowed('github.com.evil.org', ['github.com'])).toBe(false);
  });

  it('keeps narrower lists inside broader ones', () => {
    expect(hostEntryCovered('*.api.example.com', ['*.example.com'])).toBe(true);
    expect(hostEntryCovered('*.example.com', ['*.api.example.com'])).toBe(false);
    expect(hostEntryCovered('x.example.com', ['*.example.com'])).toBe(true);
    expect(hostEntryCovered('example.com', ['*.example.com'])).toBe(false);
  });
});

describe('globs', () => {
  it('include dot directories and honour case sensitivity per use', () => {
    expect(compileGlobs(['apps/**'], { nocase: false })('apps/.storybook/main.ts')).toBe(true);
    expect(compileGlobs(['apps/**'], { nocase: false })('APPS/x')).toBe(false);
    expect(compileGlobs(['**/.env*'], { nocase: true })('a/B/.ENV.local')).toBe(true);
    expect(compileGlobs(['apps/**'], { nocase: false })('./apps/x')).toBe(true);
    expect(compileGlobs([], { nocase: false })('anything')).toBe(false);
  });

  it('report literal bases for recursive-delete checks', () => {
    expect(globBases(['.git/**', '**/.env*', '.mcp.json', '.claude/settings*.json'])).toEqual(['.git', '.mcp.json', '.claude']);
  });

  it('reject globs that would escape or invert the scope', () => {
    expect(globProblem('apps/**')).toBeNull();
    for (const bad of ['', '/abs', '~/x', '!apps', './apps', 'a/../b', 'a//b', 'C:/x', 'a\\b']) expect(globProblem(bad), bad).not.toBeNull();
  });
});
