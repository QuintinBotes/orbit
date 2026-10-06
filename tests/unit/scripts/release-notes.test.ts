// scripts/release-notes.mjs prints the CHANGELOG section of one version: the release notes.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSection } from '../../../scripts/release-notes.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/release-notes.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CHANGELOG = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '- Not released yet.',
  '',
  '## 0.2.0 (2026-11-01)',
  '',
  'Intro line.',
  '',
  '```bash',
  '## not a heading, it is in a fence',
  '```',
  '',
  '### Fixed',
  '',
  '- A fix.',
  '',
  '## 0.1.0 (2026-10-06)',
  '',
  '- The first release.',
  '',
  '## 0.0.9-rc.1',
  '',
  '- A candidate.',
  '',
].join('\n');

function run(changelog: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-relnotes-'));
  dirs.push(dir);
  const path = join(dir, 'CHANGELOG.md');
  writeFileSync(path, changelog);
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--file', path], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('release notes extraction', () => {
  it('returns the body between the version heading and the next level 2 heading, trimmed', () => {
    expect(extractSection(CHANGELOG, '0.1.0')).toBe('- The first release.');
    const section = extractSection(CHANGELOG, '0.2.0');
    expect(section).toMatch(/^Intro line\./);
    expect(section).toContain('### Fixed');
    expect(section).toContain('- A fix.');
    expect(section).not.toContain('The first release');
    expect(section).not.toContain('Not released yet');
  });

  it('keeps a "## " line inside a code fence as part of the section', () => {
    expect(extractSection(CHANGELOG, '0.2.0')).toContain('## not a heading, it is in a fence');
  });

  it('accepts a leading v, a prerelease version, a heading with no date and CRLF line endings', () => {
    expect(extractSection(CHANGELOG, 'v0.1.0')).toBe('- The first release.');
    expect(extractSection(CHANGELOG, '0.0.9-rc.1')).toBe('- A candidate.');
    expect(extractSection(CHANGELOG.replace(/\n/g, '\r\n'), '0.1.0')).toBe('- The first release.');
  });

  it('does not match a version that only shares a prefix, or the Unreleased heading', () => {
    expect(extractSection(CHANGELOG, '0.2')).toBeNull();
    expect(extractSection(CHANGELOG, '0.1.00')).toBeNull();
    expect(extractSection(CHANGELOG, '9.9.9')).toBeNull();
    expect(extractSection(CHANGELOG, 'Unreleased')).toBeNull();
  });

  it('returns an empty string for a heading with no body', () => {
    expect(extractSection('## 1.0.0\n\n## 0.9.0\n\n- x\n', '1.0.0')).toBe('');
  });

  it('the CLI prints the section and exits 0', () => {
    const res = run(CHANGELOG, 'v0.1.0');
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('- The first release.\n');
  });

  it('the CLI exits 1 when the version has no section or an empty one, and 2 on a bad argument', () => {
    const missing = run(CHANGELOG, 'v9.9.9');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/no section for 9\.9\.9/);
    expect(missing.stdout).toBe('');
    const empty = run('## 1.0.0\n\n## 0.9.0\n\n- x\n', 'v1.0.0');
    expect(empty.status).toBe(1);
    expect(empty.stderr).toMatch(/section for 1\.0\.0 is empty/);
    expect(run(CHANGELOG).status).toBe(2);
    expect(run(CHANGELOG, 'banana').status).toBe(2);
    const noFile = spawnSync(process.execPath, [SCRIPT, 'v0.1.0', '--file', join(tmpdir(), 'orbit-no-such-changelog.md')], { encoding: 'utf8' });
    expect(noFile.status).toBe(2);
    expect(noFile.stderr).toMatch(/not found/);
  });

  it('the CLI reads the repository CHANGELOG.md by default and finds the 0.1.0 release', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'v0.1.0'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/first release/);
  });
});
