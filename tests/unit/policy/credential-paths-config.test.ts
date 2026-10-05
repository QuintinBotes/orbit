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
