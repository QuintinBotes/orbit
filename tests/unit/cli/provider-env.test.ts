import { describe, expect, it } from 'vitest';
import { toolEnv } from '../../../src/cli/commands/doctor.ts';
import { probeEnv } from '../../../src/cli/commands/models.ts';

// A macOS keychain (subscription) login is only found when USER is set: without it
// `claude auth status` reports loggedIn false and doctor would wrongly fail claude.auth.
describe('provider CLI environments keep the login identity and drop delivery credentials', () => {
  const host = { PATH: '/bin', HOME: '/home/acme', USER: 'acme', LOGNAME: 'acme', GH_TOKEN: 'not-for-providers', CLAUDE_CONFIG_DIR: '/home/acme/.claude-alt' };
  for (const [name, fn] of [['doctor toolEnv', toolEnv], ['models probeEnv', probeEnv]] as const) {
    it(`${name} passes USER and LOGNAME through`, () => {
      const env = fn(host);
      expect(env.USER).toBe('acme');
      expect(env.LOGNAME).toBe('acme');
      expect(env.CLAUDE_CONFIG_DIR).toBe('/home/acme/.claude-alt');
    });
    it(`${name} never passes delivery credentials`, () => {
      expect(fn(host).GH_TOKEN).toBeUndefined();
    });
  }
});
