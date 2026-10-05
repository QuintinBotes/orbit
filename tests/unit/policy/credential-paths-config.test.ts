import { describe, expect, it } from 'vitest';
import { credentialGlobsOf } from '../../../src/policy/builtin.ts';

// scope.credential_paths is the explicit, authoritative list of credential locations a
// repository adds; the name-based reading of protected globs stays as a fallback.
describe('scope.credential_paths', () => {
  it('adds explicitly listed credential paths even when their names say nothing about credentials', () => {
    const globs = credentialGlobsOf({ config: { scope: { protected_paths: [], credential_paths: ['deploy/acme-signing.bin', 'ops/vault/**'] } } });
    expect(globs).toContain('deploy/acme-signing.bin');
    expect(globs).toContain('ops/vault/**');
  });
  it('keeps write-only protections readable', () => {
    const globs = credentialGlobsOf({ config: { scope: { protected_paths: ['.github/**'], credential_paths: [] } } });
    expect(globs).not.toContain('.github/**');
  });
});

describe('scope.credential_paths validation', () => {
  it('rejects absolute and escaping entries, which could never match a repository path', async () => {
    const { validateConfig } = await import('../../../src/policy/config.ts');
    for (const bad of ['/repo/ops/vault.bin', '../outside/key.pem']) {
      expect(() => validateConfig({ version: 1, scope: { credential_paths: [bad] } })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
  });
  it('accepts repository-relative globs', async () => {
    const { validateConfig } = await import('../../../src/policy/config.ts');
    expect(validateConfig({ version: 1, scope: { credential_paths: ['ops/vault/**'] } }).scope.credential_paths).toEqual(['ops/vault/**']);
  });
});
