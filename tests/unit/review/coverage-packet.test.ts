import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildReviewPacket, type ReviewPacketInput } from '../../../src/review/packet.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import { contract, evidenceReport, snapshotOf } from './fixtures.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };

describe.skipIf(!gitAvailable)('buildReviewPacket: branches the main tests do not reach', () => {
  let top: string;
  let repo: string;
  let base = '';
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
  const write = (rel: string, content: string | Buffer) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  };

  beforeAll(() => {
    top = mkdtempSync(join(tmpdir(), 'orbit-packet-cov-'));
    repo = join(top, 'repo');
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    write('README.md', '# acme\n');
    write('assets/old.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    write('assets/gone.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 3, 4]));
    write('src/a.ts', 'export const a = 1;\n');
    write('src/b.ts', 'export const b = 1;\n');
    write('src/c.ts', 'export const c = 1;\n');
    write('src/d.ts', 'export const d = 1;\n');
    write('docs/x.md', 'docs\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    base = git('rev-parse', 'HEAD');
  });
  afterAll(() => rmSync(top, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());

  /** A candidate commit on the base: `change` edits the working tree (reset to the base first). */
  function candidate(change: () => void, stageAll = true): { commitSha: string; treeHash: string } {
    git('checkout', '-q', '--detach', base);
    git('reset', '-q', '--hard', base);
    git('clean', '-qfdx');
    change();
    if (stageAll) git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'candidate');
    return { commitSha: git('rev-parse', 'HEAD'), treeHash: git('rev-parse', 'HEAD^{tree}') };
  }

  function input(c: { commitSha: string; treeHash: string }, over: Partial<ReviewPacketInput> = {}): ReviewPacketInput {
    return { contract: contract(), snapshot: snapshotOf(), candidate: c, baseRev: base, repoRoot: repo, evidenceReport: evidenceReport(c.treeHash), ledger: [], questions: [], provider: 'codex', ...over };
  }

  it('describes each kind of binary change, and ranks files by relevance: hot paths, then the contract text, then plain, then docs', async () => {
    const c = candidate(() => {
      write('assets/new.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9]));
      write('assets/old.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 5, 6, 7]));
      git('rm', '-q', 'assets/gone.png');
      write('src/a.ts', 'export const a = 2;\n');
      write('src/b.ts', 'export const b = 2;\n');
      write('src/c.ts', 'export const c = 2;\n');
      write('src/d.ts', 'export const d = 2;\n');
      write('docs/x.md', 'more docs\n');
    });
    const ev = evidenceReport(c.treeHash);
    ev.scope.forbidden_paths_changed = ['src/b.ts'];
    ev.scope.out_of_scope_paths_changed = ['src/a.ts'];
    const k = contract({ acceptance_criteria: [{ id: 'AC-1', statement: 'src/c.ts exports c', proof: [], mandatory: true }] });
    const p = await buildReviewPacket(input(c, { evidenceReport: ev, contract: k }));
    expect(p.included.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'docs/x.md']);
    const binary = Object.fromEntries(p.excluded.filter((e) => e.reason === 'binary').map((e) => [e.path, e.detail]));
    expect(binary).toEqual({ 'assets/new.png': 'binary file, added', 'assets/old.png': 'binary file, modified', 'assets/gone.png': 'binary file, deleted' });
  });

  it('shows at most 40 criteria, says how many were left out, and cuts an over-long line', async () => {
    const c = candidate(() => write('src/a.ts', 'export const a = 3;\n'));
    const criteria: GoalContract['acceptance_criteria'] = Array.from({ length: 45 }, (_, i) => ({ id: `AC-${i}`, statement: `criterion ${i}`, proof: i === 0 ? [] : ['a test'], mandatory: i % 2 === 0, ...(i === 1 ? { ui: true } : {}) }));
    criteria[2] = { ...criteria[2]!, statement: 'x'.repeat(900) };
    const p = await buildReviewPacket(input(c, { contract: contract({ acceptance_criteria: criteria }) }));
    expect(p.text).toContain('- ... 5 more not shown');
    expect(p.text).toContain('AC-0 (mandatory): criterion 0\n');
    expect(p.text).toContain('AC-1 (ui): criterion 1 Proof: a test');
    expect(p.text).toMatch(/AC-2 \(mandatory\): x{600,}\.\.\./);
    expect(p.text).not.toContain('AC-41');
  });

  it('summarizes a policy with nothing allowed: empty lists read "none", many protected paths are counted, security waivers are listed', async () => {
    const c = candidate(() => write('src/a.ts', 'export const a = 4;\n'));
    const snapshot = snapshotOf((cfg) => {
      cfg.scope.allowed_paths = [];
      cfg.network.allowed_hosts = [];
      for (const k of Object.keys(cfg.actions) as (keyof typeof cfg.actions)[]) cfg.actions[k] = false;
      (cfg.review as unknown as { security: unknown }).security = {
        block_severities: ['critical'],
        exceptions: [
          { category: 'crypto', severities: ['low', 'medium'], reason: 'legacy hash', location: 'src/legacy/**', expires: null },
          { category: 'privacy', severities: ['high'], reason: 'accepted', location: null, expires: null },
        ],
      };
    });
    snapshot.effective_protected_paths = Array.from({ length: 35 }, (_, i) => `secrets/p${i}`);
    const p = await buildReviewPacket(input(c, { snapshot, contract: contract({ allowed_paths: [] }) }));
    expect(p.text).toContain('- allowed paths: none');
    expect(p.text).toContain('- contract allowed paths: none');
    expect(p.text).toContain('and 5 more');
    expect(p.text).toContain('- actions permitted: none');
    expect(p.text).toContain('- network hosts: none');
    expect(p.text).toContain('- findings at critical severity block delivery until resolved');
    expect(p.text).toContain('- security exceptions listed in policy (still report matching findings): crypto at src/legacy/** (low/medium); privacy (high)');
  });

  it('prints checks without an exit code, flaky checks, notes, UI journeys and over-long lists as the reviewer needs them', async () => {
    const c = candidate(() => write('src/a.ts', 'export const a = 5;\n'));
    const ev = evidenceReport(c.treeHash, {
      checks: [{ id: 'unit', status: 'ERROR', exit_code: null, flaky: true, log: 'unit.log' }],
      acceptance_evidence: [{ criterion_id: 'AC-1', status: 'unverified', artifacts: [], note: 'no   executed\ncheck is mapped' }],
      ui: [{ journey: 'checkout', status: 'PASSED', artifacts: [] }],
      unverified: Array.from({ length: 35 }, (_, i) => `gap ${i}`),
    });
    const p = await buildReviewPacket(input(c, { evidenceReport: ev }));
    expect(p.text).toContain('- unit: ERROR, exit none, flaky (passed only on rerun)');
    expect(p.text).toContain('- AC-1: unverified (no executed check is mapped)');
    expect(p.text).toContain('- checkout: PASSED');
    expect(p.text).toContain('- ... 5 more not shown');
  });

  it('lists exclusions up to its reserve and then counts the rest', async () => {
    const c = candidate(() => {
      for (let i = 0; i < 120; i++) write(`vendor/lib${i}/index.js`, `module.exports = ${i};\n`);
      write('src/a.ts', 'export const a = 6;\n');
    });
    const p = await buildReviewPacket(input(c));
    expect(p.excluded.filter((e) => e.reason === 'generated')).toHaveLength(120);
    expect(p.text).toMatch(/- \.\.\. \d+ more exclusions not listed/);
    expect(p.bytes).toBeLessThan(160_000);
  });

  it('names a changed path git cannot read as a file, and still lists it with its diff', async () => {
    const c = candidate(() => {
      // A gitlink (submodule) is a changed path whose blob cannot be read.
      git('update-index', '--add', '--cacheinfo', `160000,${base},vendored-sub`);
      write('src/a.ts', 'export const a = 7;\n');
      git('add', 'src/a.ts');
    }, false);
    const p = await buildReviewPacket(input(c));
    expect(p.excluded).toContainEqual({ path: 'vendored-sub', part: 'file', reason: 'size-budget', detail: 'could not be read from the candidate tree' });
    expect(p.included.find((f) => f.path === 'vendored-sub')).toMatchObject({ diff: true, file: false });
  });

  it('ends a fenced block with a newline of its own when the text has none', async () => {
    const c = candidate(() => write('src/a.ts', 'export const a = 8;'));
    const p = await buildReviewPacket(input(c));
    expect(p.text).toContain('```file src/a.ts\nexport const a = 8;\n```');
  });

  it('stops listing full files once their budget is spent, while the diffs are still shown', async () => {
    const c = candidate(() => {
      for (let i = 0; i < 14; i++) write(`src/m${String(i).padStart(2, '0')}.ts`, `${Array.from({ length: 22 }, (_, j) => `export const v${i}_${j} = ${j};`).join('\n')}\n`);
    });
    const p = await buildReviewPacket(input(c, { limits: { maxBytes: 18_000 } }));
    const reasons = p.excluded.map((e) => `${e.part}:${e.reason}`);
    expect(reasons).toContain('diff:size-budget');
    expect(p.excluded.some((e) => e.part === 'file' && e.reason === 'size-budget' && e.detail === 'file budget exhausted; the diff is shown')).toBe(true);
    expect(p.bytes).toBeLessThanOrEqual(18_000);
  });

  it('truncates diffs at tiny limits without ever cutting a character in half', async () => {
    const c = candidate(() => write('src/a.ts', `export const smile = "${'\u{1F600}'.repeat(400)}";\n`));
    for (const maxFileDiffBytes of [50, 1000, 1001, 1002, 1003, 1004]) {
      const p = await buildReviewPacket(input(c, { limits: { maxFileDiffBytes } }));
      expect(p.text).not.toContain('�');
      expect(p.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
      expect(p.excluded.some((e) => e.part === 'diff' && e.reason === 'truncated')).toBe(true);
    }
  });

  describe('when git reports a path with no line counts, or no path at all', () => {
    it('lists a type-changed file with zero counts and skips a record without a path', async () => {
      const c = candidate(() => write('src/a.ts', 'export const a = 9;\n'));
      const bin = join(top, 'fakebin');
      mkdirSync(bin, { recursive: true });
      const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" --name-status "*) printf 'T\\0src/typechanged.ts\\0M\\0\\0'; exit 0;; *" --numstat "*) exit 0;; esac\nexec '${real}' "$@"\n`);
      chmodSync(join(bin, 'git'), 0o755);
      vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
      const p = await buildReviewPacket(input(c));
      expect(p.included.map((f) => f.path)).toEqual(['src/typechanged.ts']);
    });
  });
});
