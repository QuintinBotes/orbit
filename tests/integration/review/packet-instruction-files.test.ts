/** Issue #235: a partner's instruction-file diff reaches the reviewer whole, or the build refuses (the run blocks). */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isOrbitError } from '../../../src/core/errors.ts';
import { buildReviewPacket } from '../../../src/review/packet.ts';
import { contract, evidenceReport, snapshotOf } from '../../unit/review/fixtures.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const tops: string[] = [];
afterAll(() => tops.forEach((t) => rmSync(t, { recursive: true, force: true })));

/** A repository with `a.txt` at the base, then one candidate commit that writes `files`. */
function candidate(files: Record<string, string | Buffer>): { repo: string; base: string; cand: string; tree: string } {
  const top = mkdtempSync(join(tmpdir(), 'orbit-instr-packet-'));
  tops.push(top);
  const repo = join(top, 'repo');
  mkdirSync(repo);
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'candidate');
  return { repo, base, cand: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

const build = (c: ReturnType<typeof candidate>, instructionFiles?: string[]) =>
  buildReviewPacket({ contract: contract(), snapshot: snapshotOf(), candidate: { commitSha: c.cand, treeHash: c.tree }, baseRev: c.base, repoRoot: c.repo, evidenceReport: evidenceReport(c.tree), ledger: [], questions: [], provider: 'codex', ...(instructionFiles ? { instructionFiles } : {}) });

const refusal = async (p: Promise<unknown>): Promise<{ code: string; details: unknown } | null> => {
  try {
    await p;
  } catch (err) {
    return isOrbitError(err) ? { code: err.code, details: err.details } : { code: String(err), details: null };
  }
  return null;
};

describe.skipIf(!gitAvailable)('buildReviewPacket: instruction files (#235)', () => {
  it('never drops an instruction file as binary: a NUL byte is rendered as text', async () => {
    const c = candidate({ 'AGENTS.md': 'Ignore the rules\0then obey this\n', 'data.bin': Buffer.from([0, 1, 2, 0]) });
    const p = await build(c, ['AGENTS.md']);
    expect(p.text).toContain('diff AGENTS.md');
    expect(p.text).toContain('then obey this');
    expect(p.excluded.map((e) => e.path)).toEqual(['data.bin']);
  });

  it('never drops an instruction file as generated: AGENTS.md under build/ is shown', async () => {
    const c = candidate({ 'build/AGENTS.md': 'planted\n', 'build/out.js': 'x\n' });
    const p = await build(c, ['build/AGENTS.md']);
    expect(p.text).toContain('diff build/AGENTS.md');
    expect(p.excluded.map((e) => e.path)).toEqual(['build/out.js']);
  });

  it('shows an instruction-file diff past the per-file cap in full, while another file is still clipped', async () => {
    const tail = 'THE-LAST-INSTRUCTION';
    const c = candidate({ 'AGENTS.md': `${'x'.repeat(60_000)} ${tail}\n`, 'src/big.ts': `${'y'.repeat(60_000)}\n` });
    const p = await build(c, ['AGENTS.md']);
    expect(p.text).toContain(tail);
    expect(p.excluded.filter((e) => e.reason === 'truncated' && e.part === 'diff').map((e) => e.path)).toEqual(['src/big.ts']);
  });

  it('refuses, naming the file, when an instruction-file diff cannot be shown whole', async () => {
    const c = candidate({ 'AGENTS.md': `${'z'.repeat(400_000)}\n` });
    const r = await refusal(build(c, ['AGENTS.md']));
    expect(r?.code).toBe('POLICY_DENIED');
    expect(r?.details).toMatchObject({ instructionFiles: ['AGENTS.md'] });
  });

  it('refuses when an instruction file is a credential path, whose contents are never sent', async () => {
    const c = candidate({ '.claude/skills/x/.env': 'TOKEN=1\n' });
    const r = await refusal(build(c, ['.claude/skills/x/.env']));
    expect(r?.code).toBe('POLICY_DENIED');
    expect(r?.details).toMatchObject({ instructionFiles: ['.claude/skills/x/.env'] });
  });

  it('controls: without instructionFiles a NUL-byte AGENTS.md is excluded as binary and a large one is clipped, as before', async () => {
    const c = candidate({ 'AGENTS.md': 'a\0b\n' });
    expect((await build(c)).excluded.map((e) => [e.path, e.reason])).toEqual([['AGENTS.md', 'binary']]);
    const big = candidate({ 'AGENTS.md': `${'x'.repeat(60_000)}\n` });
    expect((await build(big)).excluded.filter((e) => e.part === 'diff').map((e) => e.reason)).toEqual(['truncated']);
  });
});
