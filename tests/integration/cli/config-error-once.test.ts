import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const MAIN = join(__dirname, '../../../src/cli/main.ts');

describe('orbit prints each config problem once', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  it('lists a contradiction between the mode and the actions exactly once', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orbit-cfg-'));
    dirs.push(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    mkdirSync(join(repo, '.orbit'));
    writeFileSync(join(repo, '.orbit/config.yaml'), 'version: 1\nmode: autonomous\nactions:\n  commit: true\n');
    const r = spawnSync(process.execPath, [MAIN, 'run', '--goal', 'acme', '--foreground'], { cwd: repo, encoding: 'utf8', env: { ...process.env, ORBIT_HOME: join(repo, '.home') } });
    expect(r.status).not.toBe(0);
    const line = 'actions.commit: is true but mode "autonomous" does not deliver';
    expect(r.stderr.split(line).length - 1).toBe(1);
  });
});
