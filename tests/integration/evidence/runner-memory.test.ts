import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { runChecks } from '../../../src/evidence/runner.ts';
import { listFailures } from '../../../src/evidence/store.ts';
import { findPs, RESOURCE_LIMIT_EXIT_CODE, withMemoryWatchdog } from '../../../src/isolation/memory.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { nodeCheck } from '../../unit/evidence/fixtures.ts';
import { runnerEnv, type RunnerEnv } from './harness.ts';

/** NoIsolation with the memory watchdog around the command, as sandbox-runtime does with isolation.limits.memory_mb. */
class WatchedIsolation implements IsolationProvider {
  readonly kind = 'none' as const;
  private readonly inner = new NoIsolation();
  private readonly memoryMb: number;
  constructor(memoryMb: number) {
    this.memoryMb = memoryMb;
  }
  available() {
    return this.inner.available();
  }
  wrap(argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }): WrappedCommand {
    const w = this.inner.wrap(argv, profile, opts);
    return { ...w, argv: withMemoryWatchdog(w.argv, this.memoryMb, { intervalMs: 100 }) };
  }
}

const envs: RunnerEnv[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

describe.skipIf(!findPs())('check runner and the memory watchdog (G24)', () => {
  it('records a check stopped for memory as a resource-limit failure that names the limit', async () => {
    const e = await runnerEnv([nodeCheck('hog', "const a=[];for(let i=0;i<40;i++)a.push(Buffer.alloc(10*1024*1024,1));setTimeout(()=>{},20000)")], { isolation: new WatchedIsolation(150) });
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['hog'] });
    expect(r).toMatchObject({ checkId: 'hog', status: 'FAILED', exitCode: RESOURCE_LIMIT_EXIT_CODE });
    const log = readFileSync(r!.logPath, 'utf8');
    expect(log).toMatch(/\[orbit\] check=hog status=FAILED exit=198 note=resource limit exceeded, memory: the command used \d+ MB resident, over isolation\.limits\.memory_mb \(150 MB\)/);
    expect(r!.excerpt).toMatch(/resource limit exceeded, memory/);
    // It is a failure like any other for the repair loop.
    expect(listFailures(e.run.db, e.run.runId)).toHaveLength(1);
  });

  it('leaves an ordinary failing check as an ordinary failure, and cannot be spoofed into a passing one', async () => {
    const e = await runnerEnv(
      [
        nodeCheck('plain', 'console.error("Error: expected 1 to equal 2"); process.exit(3)'),
        nodeCheck('spoof', `console.error("[orbit-resource-limit] memory: pretend"); process.exit(${RESOURCE_LIMIT_EXIT_CODE})`),
        nodeCheck('spoof-pass', 'console.error("[orbit-resource-limit] memory: pretend"); process.exit(0)'),
      ],
      { isolation: new WatchedIsolation(2048) },
    );
    envs.push(e);
    const [plain, spoof, spoofPass] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['plain', 'spoof', 'spoof-pass'] });
    expect(plain).toMatchObject({ status: 'FAILED', exitCode: 3 });
    expect(readFileSync(plain!.logPath, 'utf8')).not.toContain('resource limit exceeded');
    expect(spoofPass).toMatchObject({ status: 'PASSED', exitCode: 0 });
    // A command that prints the marker and uses the reserved status is the same thing as the watchdog's own line; it can only turn a failure into a more specific failure.
    expect(spoof).toMatchObject({ status: 'FAILED' });
  });
});
