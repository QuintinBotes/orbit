import { describe, expect, it } from 'vitest';
import { packageScriptOf } from '../../../src/cli/commands/doctor.ts';

describe('packageScriptOf', () => {
  it('skips flags between run and the script name', () => {
    expect(packageScriptOf(['npm', 'run', '--silent', 'lint'])).toBe('lint');
    expect(packageScriptOf(['pnpm', 'run', '-s', '--if-present', 'build'])).toBe('build');
  });
  it('handles test, run-script and commands that are not scripts', () => {
    expect(packageScriptOf(['npm', 'test'])).toBe('test');
    expect(packageScriptOf(['yarn', 'run-script', 'ci'])).toBe('ci');
    expect(packageScriptOf(['npm', 'ci'])).toBeUndefined();
    expect(packageScriptOf(['node', 'run', 'x'])).toBeUndefined();
  });
});
