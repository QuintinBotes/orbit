/**
 * Issue #233 review: the port's process handling, against tests/fakes/fake-memory.mjs. Every failure is an outcome
 * (a rejection or a throw), never a duration; the short timeouts only bound the tests that need one to fire.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callMemoryTool, recallShared, type SharedMemoryConfig } from '../../../src/knowledge/shared-memory.ts';

const FAKE = fileURLToPath(new URL('../../fakes/fake-memory.mjs', import.meta.url));
const memory: SharedMemoryConfig = { enabled: true, command: [process.execPath, FAKE] };
const ask = { paths: ['apps/**'], checkIds: ['unit'], fingerprints: [], maxTokens: 100 };
const SHORT = { timeoutMs: 400 };

let base = '';
let repo = '';
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  rmSync(base, { recursive: true, force: true });
});
function fixture(modes: { recall?: string; mcp?: string } = {}, rows = '[mem-1] hazard · a · One (repository)\n'): void {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-sm-')));
  repo = join(base, 'repo');
  mkdirSync(repo);
  writeFileSync(join(base, 'memory.mode'), JSON.stringify(modes));
  writeFileSync(join(base, 'memory.rows'), rows);
}
const log = () => (existsSync(join(base, 'memory.log')) ? readFileSync(join(base, 'memory.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const parkedPid = (): number => Number(readFileSync(join(base, 'memory.pid'), 'utf8'));
const propose = (opts?: { timeoutMs?: number; maxBytes?: number }) => callMemoryTool(memory, repo, 'memory_propose', { statement: 's', scope: 'repository', type: 'hazard', evidence: { source: 'orbit run x' } }, opts);

describe('recallShared', () => {
  it('positive control: reads the rows, from the given directory', () => {
    fixture();
    expect(recallShared(memory, repo, ask)).toEqual([{ id: 'mem-1', text: '[mem-1] hazard · a · One (repository)' }]);
    expect(log()[0]).toMatchObject({ kind: 'recall', cwd: repo });
  });
  it('throws for a command that does not exist', () => {
    fixture();
    expect(() => recallShared({ enabled: true, command: ['/no/such/memory-command'] }, repo, ask)).toThrow(/ENOENT/);
  });
  it('throws when the command never answers, and kills a child that ignores SIGTERM', () => {
    fixture({ recall: 'ignore-term' });
    expect(() => recallShared(memory, repo, ask, SHORT)).toThrow();
    return vi.waitFor(() => expect(alive(parkedPid())).toBe(false));
  });
  it('throws on output past the cap', () => {
    fixture({ recall: 'big' });
    expect(() => recallShared(memory, repo, ask)).toThrow();
  });
  it('gives the child an allowlisted environment, without provider keys', () => {
    fixture({ recall: 'env' });
    process.env.ANTHROPIC_API_KEY = 'sk-secret';
    recallShared(memory, repo, ask);
    const names = log()[0]!.env as string[];
    expect(names).toContain('PATH');
    expect(names).not.toContain('ANTHROPIC_API_KEY');
  });
});

describe('callMemoryTool', () => {
  it('positive control: calls the tool from the given directory and returns its text', async () => {
    fixture();
    await expect(propose()).resolves.toBe('ok');
    expect(log()[0]).toMatchObject({ kind: 'tool', name: 'memory_propose', cwd: repo });
  });
  it('keeps a reply the server wrote just before it exited', async () => {
    fixture({ mcp: 'reply-exit' });
    await expect(propose()).resolves.toBe('ok');
  });
  it('rejects for a command that does not exist', async () => {
    fixture();
    await expect(callMemoryTool({ enabled: true, command: ['/no/such/memory-command'] }, repo, 'memory_feedback', { id: 'x', signal: 'wrong' })).rejects.toThrow(/ENOENT/);
  });
  it('rejects when the server never replies, and kills a child that ignores SIGTERM', async () => {
    fixture({ mcp: 'ignore-term' });
    await expect(propose(SHORT)).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(alive(parkedPid())).toBe(false));
  });
  it('rejects, and kills the child, when the server never replies and honours SIGTERM', async () => {
    fixture({ mcp: 'hang' });
    await expect(propose(SHORT)).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(alive(parkedPid())).toBe(false));
  });
  it('rejects on output past the cap', async () => {
    fixture({ mcp: 'big' });
    await expect(propose({ maxBytes: 100_000 })).rejects.toThrow(/too large/);
  });
  it('gives the child an allowlisted environment, without provider keys', async () => {
    fixture({ mcp: 'env' });
    process.env.ANTHROPIC_API_KEY = 'sk-secret';
    await propose();
    const names = log().find((e) => e.kind === 'mcp-env')!.env as string[];
    expect(names).toContain('PATH');
    expect(names).not.toContain('ANTHROPIC_API_KEY');
  });
});
