// .github/workflows/release.yml: what a v* tag push does. The workflow is not run here; its structure is checked.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const text = readFileSync(`${ROOT}.github/workflows/release.yml`, 'utf8');
const ci = readFileSync(`${ROOT}.github/workflows/ci.yml`, 'utf8');

interface Step { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> }
interface Job { needs?: string | string[]; permissions?: Record<string, string>; steps: Step[]; if?: string }
const wf = parse(text) as { on: { push: { tags: string[]; branches?: unknown } }; permissions: unknown; jobs: Record<string, Job> };
const allSteps = Object.values(wf.jobs).flatMap((j) => j.steps);
const runs = (job: Job) => job.steps.map((s) => s.run ?? '').join('\n');

describe('release workflow', () => {
  it('runs on a pushed v* tag only, with no default token permissions', () => {
    expect(wf.on.push.tags).toEqual(['v*']);
    expect(wf.on.push.branches).toBeUndefined();
    expect(Object.keys(wf.on)).toEqual(['push']);
    expect(wf.permissions).toEqual({});
  });

  it('pins every action by a 40 character commit SHA with a version comment', () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const [, ref, rest] of uses) {
      expect(ref, 'action reference').toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(rest, `version comment for ${ref}`).toMatch(/^\s+# v\d+(\.\d+)*/);
    }
    expect(text).toMatch(/actions\/attest-build-provenance@[0-9a-f]{40} # v\d/);
  });

  it('uses the same checkout and setup-node pins as ci.yml', () => {
    for (const action of ['actions/checkout', 'actions/setup-node']) {
      const pin = ci.match(new RegExp(`${action}@[0-9a-f]{40} # v\\d+`));
      expect(pin, action).not.toBeNull();
      expect(text).toContain((pin as RegExpMatchArray)[0]);
    }
  });

  it('runs the whole gate of ci.yml, with its prerequisites, before anything is published', () => {
    const verify = wf.jobs.verify as Job;
    const gate = runs(verify);
    for (const cmd of [
      'npm ci',
      'npm run typecheck',
      'npm run test:unit',
      'npm run test:integration',
      'npm run test:fault',
      'npm run test:acceptance',
      'npm run check:dist',
      'node scripts/check-plugin.mjs',
      'npx playwright install --with-deps chromium',
      'npm install --global @anthropic-ai/claude-code',
      'apt-get install -y -qq bubblewrap socat ripgrep',
      'kernel.apparmor_restrict_unprivileged_userns=0',
    ]) {
      expect(ci, `ci.yml has ${cmd}`).toContain(cmd);
      expect(gate, `release gate has ${cmd}`).toContain(cmd);
    }
    expect(verify.permissions).toEqual({ contents: 'read' });
  });

  it('verifies the tag against the three versions, the CHANGELOG and main, before the tests', () => {
    const verifySteps = (wf.jobs.verify as Job).steps;
    const gate = runs(wf.jobs.verify as Job);
    expect(gate).toContain('node scripts/check-release-versions.mjs "$GITHUB_REF_NAME"');
    expect(gate).toContain('git merge-base --is-ancestor');
    expect(gate).toContain('node scripts/release-notes.mjs "$GITHUB_REF_NAME"');
    const firstTest = verifySteps.findIndex((s) => /test:unit/.test(s.run ?? ''));
    const versions = verifySteps.findIndex((s) => /check-release-versions/.test(s.run ?? ''));
    expect(versions).toBeGreaterThan(-1);
    expect(versions).toBeLessThan(firstTest);
  });

  it('builds the archive of plugin/, attests it, and creates the release from the CHANGELOG section', () => {
    const release = wf.jobs.release as Job;
    expect(release.needs).toBe('verify');
    expect(release.permissions).toEqual({ contents: 'write', 'id-token': 'write', attestations: 'write' });
    const attestAt = release.steps.findIndex((s) => s.uses?.startsWith('actions/attest-build-provenance@'));
    const archiveAt = release.steps.findIndex((s) => /git archive/.test(s.run ?? ''));
    const createAt = release.steps.findIndex((s) => /gh release create/.test(s.run ?? ''));
    expect(archiveAt).toBeGreaterThan(-1);
    expect(attestAt).toBeGreaterThan(archiveAt);
    expect(createAt).toBeGreaterThan(attestAt);
    expect(runs(release)).toContain('HEAD:plugin');
    expect(runs(release)).toContain('--notes-file');
    expect(runs(release)).toContain('--verify-tag');
    expect(String(release.steps[attestAt]?.with?.['subject-path'])).toMatch(/orbit-plugin-/);
  });

  it('opens the catalog pull request only with CATALOG_PR_TOKEN, and says so when it is absent', () => {
    const catalog = wf.jobs.catalog as Job;
    expect(catalog.needs).toBe('release');
    expect(catalog.permissions).toEqual({});
    expect(text).toContain('secrets.CATALOG_PR_TOKEN');
    const body = runs(catalog);
    expect(body).toContain('QuintinBotes/claude-plugins');
    expect(body).toContain('scripts/bump-catalog-ref.mjs');
    expect(body).toContain('gh pr create');
    expect(body).toContain('::notice::$msg');
    expect(body).toMatch(/the CATALOG_PR_TOKEN secret is not set/);
    expect(body).toContain('GITHUB_STEP_SUMMARY');
    expect(body).toContain('exit 0');
    // A prerelease is never offered to the catalog.
    expect(text).toMatch(/prerelease/);
  });

  it('never interpolates the tag name into a shell script', () => {
    for (const step of allSteps) expect(step.run ?? '', step.name).not.toMatch(/\$\{\{\s*(github\.ref_name|github\.ref|github\.head_ref)/);
  });

  it('does not persist the checkout token and has no em or en dashes', () => {
    for (const step of allSteps.filter((s) => s.uses?.startsWith('actions/checkout@'))) expect(step.with?.['persist-credentials']).toBe(false);
    expect(text).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`));
  });
});
