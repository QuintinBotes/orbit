// Issue #261: which mapped test paths are files in a commit. A path the contract writes with ./ in the middle is the
// file the tree names; a directory, a missing path and a gitlink are not files.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { filesIn } from '../../../src/evidence/fail-before.ts';

const repo = mkdtempSync(join(tmpdir(), 'orbit-files-in-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

describe('filesIn', () => {
  it('finds a file however its path is spelled, and only files', async () => {
    git('init', '-q');
    mkdirSync(join(repo, 'tests', 'unit'), { recursive: true });
    writeFileSync(join(repo, 'tests', 'unit', 'a.test.ts'), 'x');
    git('add', '.');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'one');
    const head = git('rev-parse', 'HEAD');
    const found = await filesIn(repo, head, ['tests/unit/a.test.ts', 'tests/./unit/a.test.ts', 'tests/unit', 'tests/unit/gone.test.ts']);
    expect([...found].sort()).toEqual(['tests/./unit/a.test.ts', 'tests/unit/a.test.ts']);
  });
});
