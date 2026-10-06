// scripts/check-release-versions.mjs: a release tag must match the versions the release ships, including the CLI's own.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseVersions, parseTag } from '../../../scripts/check-release-versions.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/check-release-versions.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(versions: { root?: unknown; plugin?: unknown; manifest?: unknown; cli?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-relver-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'plugin', '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'orbit-dev', version: versions.root }));
  writeFileSync(join(dir, 'plugin', 'package.json'), JSON.stringify({ name: 'orbit-plugin', version: versions.plugin }));
  writeFileSync(join(dir, 'plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'orbit', version: versions.manifest }));
  mkdirSync(join(dir, 'src', 'cli'), { recursive: true });
  if (versions.cli !== undefined) writeFileSync(join(dir, 'src', 'cli', 'version.ts'), `export const ORBIT_VERSION = '${versions.cli}';\n`);
  return dir;
}
const same = (v: string) => ({ root: v, plugin: v, manifest: v, cli: v });

describe('release tag parsing', () => {
  it('accepts vMAJOR.MINOR.PATCH with an optional prerelease and returns the version', () => {
    expect(parseTag('v0.2.0')).toEqual({ version: '0.2.0', prerelease: false });
    expect(parseTag('v1.12.3-rc.1')).toEqual({ version: '1.12.3-rc.1', prerelease: true });
  });
  it('rejects anything else', () => {
    for (const bad of ['0.2.0', 'v0.2', 'v01.2.3', 'v0.2.0+build', 'vx', '', 'v0.2.0 ', 'refs/tags/v0.2.0']) expect(parseTag(bad)).toBeNull();
  });
});

describe('checkReleaseVersions', () => {
  it('names the version orbit --version reports when it differs from the tag, or cannot be found', () => {
    expect(checkReleaseVersions('v0.2.0', tree({ ...same('0.2.0'), cli: '0.1.0' }))).toEqual(['src/cli/version.ts is 0.1.0, the tag v0.2.0 needs 0.2.0']);
    expect(checkReleaseVersions('v0.2.0', tree({ root: '0.2.0', plugin: '0.2.0', manifest: '0.2.0' }))[0]).toMatch(/^src\/cli\/version\.ts cannot be read/);
    const dir = tree(same('0.2.0'));
    writeFileSync(join(dir, 'src', 'cli', 'version.ts'), 'export const ORBIT_VERSION = VERSION;\n');
    expect(checkReleaseVersions('v0.2.0', dir)).toEqual(['src/cli/version.ts has no ORBIT_VERSION string']);
  });
  it('has no problems when the tag and all four versions agree', () => {
    expect(checkReleaseVersions('v0.2.0', tree(same('0.2.0')))).toEqual([]);
  });

  it('names each file whose version differs from the tag', () => {
    const problems = checkReleaseVersions('v0.2.0', tree({ root: '0.1.0', plugin: '0.2.0', manifest: '0.1.9', cli: '0.2.0' }));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/package\.json is 0\.1\.0, the tag v0\.2\.0 needs 0\.2\.0/);
    expect(problems[1]).toMatch(/plugin\/\.claude-plugin\/plugin\.json is 0\.1\.9/);
  });

  it('reports a missing or non-string version, an unreadable file and a malformed tag', () => {
    expect(checkReleaseVersions('v0.2.0', tree({ root: '0.2.0', plugin: undefined, manifest: 2, cli: '0.2.0' }))).toEqual([
      expect.stringMatching(/plugin\/package\.json has no version string/),
      expect.stringMatching(/plugin\/\.claude-plugin\/plugin\.json has no version string/),
    ]);
    const dir = tree(same('0.2.0'));
    writeFileSync(join(dir, 'package.json'), '{ not json');
    rmSync(join(dir, 'plugin', 'package.json'));
    const problems = checkReleaseVersions('v0.2.0', dir);
    expect(problems.some((p) => /package\.json is not valid JSON/.test(p))).toBe(true);
    expect(problems.some((p) => /plugin\/package\.json cannot be read/.test(p))).toBe(true);
    expect(checkReleaseVersions('release-1', dir)).toEqual([expect.stringMatching(/not a release tag/)]);
  });

  it('the CLI exits 0 on a match, 1 on a mismatch and 2 without a tag', () => {
    const ok = tree(same('0.2.0'));
    const good = spawnSync(process.execPath, [SCRIPT, 'v0.2.0', '--root', ok], { encoding: 'utf8' });
    expect(good.status).toBe(0);
    expect(good.stdout).toMatch(/v0\.2\.0 matches/);
    const bad = spawnSync(process.execPath, [SCRIPT, 'v0.3.0', '--root', ok], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/needs 0\.3\.0/);
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
  });

  it('agrees with the repository: its own three versions are one version', () => {
    const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    expect(checkReleaseVersions(`v${version}`, ROOT)).toEqual([]);
  });
});
