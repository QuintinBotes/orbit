// Issue #233: with knowledge.shared_memory on, doctor reports whether the memory command answers; off, it says nothing.
import { describe, expect, it } from 'vitest';
import { sharedMemoryCheck } from '../../../src/cli/commands/doctor-shared-memory.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';

function config(shared: { enabled: boolean; command: string[] } | undefined, inPrompts = true): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.knowledge = { ...c.knowledge, lessons_in_prompts: inPrompts, ...(shared ? { shared_memory: shared } : {}) };
  return c;
}
const ok = () => [];
const broken = () => {
  throw new Error('spawn memory ENOENT');
};

describe('sharedMemoryCheck', () => {
  it('says nothing when shared memory is not configured or is off', () => {
    expect(sharedMemoryCheck({ config: config(undefined), cwd: '/repo', recall: broken })).toEqual([]);
    expect(sharedMemoryCheck({ config: config({ enabled: false, command: ['memory'] }), cwd: '/repo', recall: broken })).toEqual([]);
  });
  it('passes when the command answers a recall', () => {
    const [c] = sharedMemoryCheck({ config: config({ enabled: true, command: ['memory'] }), cwd: '/repo', recall: ok });
    expect(c).toMatchObject({ id: 'knowledge.memory', area: 'knowledge', status: 'pass' });
  });
  it('warns, with the command to check, when the command cannot run', () => {
    const [c] = sharedMemoryCheck({ config: config({ enabled: true, command: ['memory'] }), cwd: '/repo', recall: broken });
    expect(c).toMatchObject({ status: 'warn' });
    expect(c!.summary).toContain('ENOENT');
    expect(c!.fix).toContain('knowledge.shared_memory.command');
  });
  it('warns when enabled with no command, and when lessons_in_prompts is off so nothing is recalled', () => {
    expect(sharedMemoryCheck({ config: config({ enabled: true, command: [] }), cwd: '/repo', recall: ok })[0]).toMatchObject({ status: 'warn', summary: expect.stringContaining('no command') });
    expect(sharedMemoryCheck({ config: config({ enabled: true, command: ['memory'] }, false), cwd: '/repo', recall: ok })[0]).toMatchObject({ status: 'warn', summary: expect.stringContaining('lessons_in_prompts') });
  });
});
