import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeLab, type Lab } from './lab.ts';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test' };

let lab: Lab;
afterEach(() => lab?.close());

function labWith(files: Record<string, string>): Lab {
  lab = makeLab();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(lab.repo, rel)), { recursive: true });
    writeFileSync(join(lab.repo, rel), text);
  }
  execFileSync('git', ['add', '-A'], { cwd: lab.repo, env: GIT_ENV });
  execFileSync('git', ['commit', '-q', '-m', 'files'], { cwd: lab.repo, env: GIT_ENV });
  return lab;
}

const FILES = {
  'src/a.ts': "import { b } from './b.ts';\n",
  'src/b.ts': 'export const b = 1;\n',
  'tests/b.test.ts': "import { b } from '../src/b.ts';\n",
  '.orbit/config.yaml': 'version: 1\nchecks:\n  unit:\n    command: [npx, vitest, run, tests]\n',
};

describe('orbit map build and orbit map query (#175 FR-001, FR-005)', () => {
  it('builds the map of HEAD, then serves it from the cache', async () => {
    labWith(FILES);
    const first = await lab.cli(['map', 'build']);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/repository map of tree [0-9a-f]{40}: 5 files, 0 generated, 1 tests, 2 import edges, 1 test links, 1 checks/);
    expect(first.out).toMatch(/built: \d+ files read/);
    expect((await lab.cli(['map', 'build'])).out).toContain('served from the cache');
  });

  it("answers a worker's structural question about a file: imports, importers, tests and checks", async () => {
    labWith(FILES);
    const r = await lab.cli(['map', 'query', 'src/b.ts', 'tests/b.test.ts']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('src/b.ts (20 bytes)\n  imports:     none\n  imported by: src/a.ts, tests/b.test.ts\n  tests:       tests/b.test.ts\n  checks:      none name it\n');
    expect(r.out).toContain('tests/b.test.ts (');
    expect(r.out).toContain('  checks:      unit\n');
    const json = JSON.parse((await lab.cli(['map', 'query', 'src', '--json'])).out);
    expect(json.results[0]).toMatchObject({ path: 'src', kind: 'directory' });
    expect(json.results[0].files.map((f: { path: string }) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('exits NOT_FOUND for a path the tree does not have', async () => {
    labWith(FILES);
    const r = await lab.cli(['map', 'query', 'src/nope.ts']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('src/nope.ts: not in tree');
  });
});
