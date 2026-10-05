import { describe, expect, it, vi } from 'vitest';
import { checkEnv } from '../../../src/evidence/runner.ts';
import { checkDef } from './fixtures.ts';

// The platform the runner sees; everything else in node:os is real.
const os = vi.hoisted(() => ({ platform: 'darwin' as string }));
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), platform: () => os.platform }));

const dirs = { homeDir: '/h', tmpDir: '/t', artifactsDir: '/a' };

describe('checkEnv locale by platform', () => {
  it('uses the macOS locale on darwin and C.UTF-8 elsewhere', () => {
    os.platform = 'darwin';
    expect(checkEnv(checkDef('x'), dirs, '/bin').LANG).toBe('en_US.UTF-8');
    os.platform = 'linux';
    expect(checkEnv(checkDef('x'), dirs, '/bin').LANG).toBe('C.UTF-8');
    os.platform = 'win32';
    expect(checkEnv(checkDef('x'), dirs, '/bin').LANG).toBe('C.UTF-8');
  });
});
