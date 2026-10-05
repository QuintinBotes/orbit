// The per-file coverage floor (docs/gaps.md G57): scripts/check-coverage-floor.mjs reads
// coverage/coverage-summary.json after `vitest run --coverage` and fails with the files under 80% lines.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error a plain ESM script with no declaration file
import { filesBelowFloor } from '../../../scripts/check-coverage-floor.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/check-coverage-floor.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (covered: number, total: number) => ({ lines: { total, covered, skipped: 0, pct: total === 0 ? 100 : Math.round((covered / total) * 10_000) / 100 } });

function run(summary: unknown, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-covfloor-'));
  dirs.push(dir);
  const path = join(dir, 'coverage-summary.json');
  writeFileSync(path, typeof summary === 'string' ? summary : JSON.stringify(summary));
  const r = spawnSync(process.execPath, [SCRIPT, path, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('per-file coverage floor', () => {
  it('fails and lists every file under 80% lines, worst first, while the total stays above the global thresholds', () => {
    const res = run({
      total: entry(970, 1000),
      [`${ROOT}src/big/steady.ts`]: entry(900, 900),
      [`${ROOT}src/small/slipped.ts`]: entry(7, 10),
      [`${ROOT}src/small/barely.ts`]: entry(79, 100),
      [`${ROOT}src/small/exact.ts`]: entry(80, 100),
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/2 of 4 files are below 80% lines covered/);
    const lines = res.stderr.split('\n').filter((l) => l.startsWith('  '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('src/small/slipped.ts');
    expect(lines[0]).toContain('70.00%');
    expect(lines[1]).toContain('src/small/barely.ts');
    expect(res.stderr).not.toContain('steady.ts');
    expect(res.stderr).not.toContain('exact.ts');
  });

  it('passes when every file is at or above the floor, and ignores files with no executable lines', () => {
    const res = run({ total: entry(10, 10), '/x/src/a.ts': entry(80, 100), '/x/src/types.ts': entry(0, 0) });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/all 2 files have at least 80% lines covered/);
  });

  it('takes the floor from --floor, and refuses a missing or unreadable summary', () => {
    expect(run({ '/x/src/a.ts': entry(85, 100) }, '--floor', '90').status).toBe(1);
    expect(run({ '/x/src/a.ts': entry(85, 100) }, '--floor', '90').stderr).toMatch(/below 90%/);
    expect(run({}, '--floor', 'lots').status).toBe(2);
    expect(run('not json').status).toBe(2);
    const missing = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'orbit-no-such-summary.json')], { encoding: 'utf8' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/run vitest with --coverage first/);
  });

  it('filesBelowFloor treats a file with a malformed entry as nothing to judge, and sorts ties by name', () => {
    expect(filesBelowFloor({ '/a': {}, '/b': { lines: { total: 'x' } } })).toEqual([]);
    expect(filesBelowFloor({ '/b': entry(1, 2), '/a': entry(1, 2) }).map((f: { file: string }) => f.file)).toEqual(['/a', '/b']);
  });

  it('is what npm run test:coverage runs after vitest', () => {
    const scripts = JSON.parse(spawnSync('node', ['-e', "process.stdout.write(JSON.stringify(require('./package.json').scripts))"], { cwd: ROOT, encoding: 'utf8' }).stdout) as Record<string, string>;
    expect(scripts['test:coverage']).toBe('vitest run --coverage && node scripts/check-coverage-floor.mjs');
  });
});
