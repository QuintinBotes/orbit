// Issue #200: what the proof sessions are given. The auditor gets the mapped tests and the test-owned files they import,
// never a production file (FR-001); the artifact check gets the documents the candidate adds or changes, generated files
// skipped (FR-009).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditFiles, documentationPaths } from '../../../src/controller/proof.ts';
import { isTestOwnedPath } from '../../../src/policy/test-files.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(files: Record<string, string>): { root: string; commit: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-proof-files-')));
  dirs.push(root);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  return { root, commit: git('rev-parse', 'HEAD') };
}

describe('auditFiles (FR-001)', () => {
  it('edge case: gives the auditor the mapped test and the test-owned helpers and fixtures it imports, transitively, and no production file', async () => {
    const { root, commit } = repo({
      'src/queue.ts': 'export const workQueue = () => [];\n',
      'tests/unit/queue.test.ts': "import { workQueue } from '../../src/queue.ts';\nimport { prs } from './helpers.ts';\nimport data from './fixtures/prs.json' with { type: 'json' };\n",
      'tests/unit/helpers.ts': "import { make } from './make.ts';\nexport const prs = make();\n",
      'tests/unit/make.ts': 'export const make = () => [];\n',
      'tests/unit/fixtures/prs.json': '[]\n',
      'tests/unit/other.test.ts': 'unrelated\n',
    });
    const { files, missing } = await auditFiles(root, commit, ['tests/unit/queue.test.ts'], (p) => isTestOwnedPath(p));
    expect([...files.keys()].sort()).toEqual(['tests/unit/fixtures/prs.json', 'tests/unit/helpers.ts', 'tests/unit/make.ts', 'tests/unit/queue.test.ts']);
    expect(missing).toEqual([]);
  });

  it('names a mapped test the candidate does not have', async () => {
    const { root, commit } = repo({ 'tests/a.test.ts': 'x\n' });
    expect((await auditFiles(root, commit, ['tests/gone.test.ts'], () => true)).missing).toEqual(['tests/gone.test.ts']);
  });

  it('edge case: says when the test-owned files it imports are more than the auditor takes, so the packet is never short without saying so', async () => {
    const helpers = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`tests/h${i}.ts`, i < 29 ? `import './h${i + 1}.ts';\n` : 'export const done = true;\n']));
    const { root, commit } = repo({ 'tests/a.test.ts': "import './h0.ts';\n", ...helpers });
    const long = await auditFiles(root, commit, ['tests/a.test.ts'], () => true);
    expect(long.files.size).toBe(25);
    expect(long.truncated).toBe(true);
    expect((await auditFiles(root, commit, ['tests/h25.ts'], () => true)).truncated).toBe(false);
  });
});

describe('documentationPaths (FR-009)', () => {
  it('keeps docs, the changelog, ADRs and READMEs, and skips generated files and code', () => {
    expect(
      documentationPaths(['CHANGELOG.md', 'README.md', 'docs/decisions/0019.md', 'docs/guide.rst', 'plugin/dist/notes.md', 'build/report.md', 'src/queue.ts', 'package-lock.json', 'apps/web/README']),
    ).toEqual(['CHANGELOG.md', 'README.md', 'apps/web/README', 'docs/decisions/0019.md', 'docs/guide.rst']);
  });
});
