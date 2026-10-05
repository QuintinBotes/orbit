import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCheck } from '../../../src/policy/config.ts';
import type { CheckDefinition } from '../../../src/policy/types.ts';
import { assertCheckCommandAllowed, buildArgv, collectAttachments, enforcedFlags, shellQuote, toEvidenceUi } from '../../../src/ui/runner.ts';
import type { UiJourneyStatus, UiRunResult } from '../../../src/ui/types.ts';
import { journeyResult, runResult } from './builders.ts';

const check = (over: Partial<CheckDefinition> = {}): CheckDefinition => ({ ...defaultCheck('ui'), kind: 'playwright', command: ['npx', 'playwright', 'test'], ...over });

describe('assertCheckCommandAllowed', () => {
  it.each([['-u'], ['--update-snapshots'], ['--update-snapshots=all'], ['--update-snapshots=changed'], ['--ignore-snapshots'], ['--pass-with-no-tests'], ['--run-agents=all'], ['--reporter=list'], ['--add-reporter=html'], ['--output=/tmp/x'], ['--trace=off'], ['--retries=9'], ['--headed'], ['--debug'], ['--ui']])('refuses %s', (arg) => {
    expect(() => assertCheckCommandAllowed(check({ command: ['npx', 'playwright', 'test', arg] }))).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });

  it('accepts selection flags and the spellings Orbit enforces itself', () => {
    expect(() => assertCheckCommandAllowed(check({ command: ['npx', 'playwright', 'test', '--config=pw.config.ts', '--project=desktop', '-g', 'export', '--reporter=json', '--update-snapshots=none', '--trace=retain-on-failure'] }))).not.toThrow();
  });

  it('looks inside a shell script too', () => {
    expect(() => assertCheckCommandAllowed(check({ shell: true, command: ['npm run build && npx playwright test -u'] }))).toThrow(/-u/);
    expect(() => assertCheckCommandAllowed(check({ shell: true, command: ['npx playwright test --update-snapshots all;echo done'] }))).toThrow(/--update-snapshots/);
    expect(() => assertCheckCommandAllowed(check({ shell: true, command: ['npm run build && npx playwright test --project=desktop'] }))).not.toThrow();
  });
});

describe('command construction', () => {
  it('enforces the recording flags and the policy retry count', () => {
    const flags = enforcedFlags(check({ flaky_reruns: 2 }), '/out', ['desktop', 'mobile']);
    expect(flags).toEqual(['--reporter=json', '--update-snapshots=none', '--trace=retain-on-failure', '--output=/out', '--retries=2', '--project=desktop', '--project=mobile']);
  });

  it('appends flags to an argv check', () => {
    expect(buildArgv(check(), ['--reporter=json'])).toEqual(['npx', 'playwright', 'test', '--reporter=json']);
  });

  it('passes flags to a shell script as positional parameters, never by interpolation', () => {
    const argv = buildArgv(check({ shell: true, command: ['npm run build && npx playwright test'] }), ['--output=/tmp/a b; rm -rf /']);
    expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(argv[2]).toBe('npm run build && npx playwright test "$@"');
    expect(argv.slice(3)).toEqual(['orbit-ui', '--output=/tmp/a b; rm -rf /']);
  });

  it('quotes a reproduction command for a terminal', () => {
    expect(shellQuote('plain-1.2')).toBe('plain-1.2');
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
  });
});

describe('collectAttachments', () => {
  let dir: string;
  let checkout: string;
  let outputDir: string;
  let artifactDir: string;
  let secret: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-collect-'));
    checkout = join(dir, 'checkout');
    outputDir = join(dir, 'out');
    artifactDir = join(dir, 'artifacts');
    mkdirSync(checkout);
    mkdirSync(outputDir);
    secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'hunter2');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const att = (name: string, path: string | null, body: string | null = null, contentType = 'text/plain') => ({ name, contentType, path, body: body === null ? null : Buffer.from(body) });

  it('stores files from the output directory in place and hashes them', () => {
    writeFileSync(join(outputDir, 'trace.zip'), 'zip bytes');
    const c = collectAttachments([att('trace', join(outputDir, 'trace.zip'), null, 'application/zip')], { checkoutDir: checkout, outputDir, artifactDir });
    expect(c.artifacts).toHaveLength(1);
    expect(c.artifacts[0]).toMatchObject({ kind: 'trace', bytes: 9 });
    expect(c.artifacts[0]?.path.endsWith('trace.zip')).toBe(true);
  });

  it('copies a file from the checkout (a stored baseline) into the artifact directory', () => {
    writeFileSync(join(checkout, 'baseline.png'), 'png');
    const c = collectAttachments([att('reports-expected.png', join(checkout, 'baseline.png'), null, 'image/png')], { checkoutDir: checkout, outputDir, artifactDir });
    expect(c.artifacts[0]).toMatchObject({ kind: 'visual-expected' });
    expect(c.artifacts[0]?.path.startsWith(artifactDir) || c.artifacts[0]?.path.includes('artifacts')).toBe(true);
  });

  it('refuses a path outside the output directory and the checkout', () => {
    const c = collectAttachments([att('x', secret)], { checkoutDir: checkout, outputDir, artifactDir });
    expect(c.artifacts).toEqual([]);
  });

  it('refuses a symlink inside the output directory that points outside it', () => {
    symlinkSync(secret, join(outputDir, 'link.txt'));
    const c = collectAttachments([att('x', join(outputDir, 'link.txt'))], { checkoutDir: checkout, outputDir, artifactDir });
    expect(c.artifacts).toEqual([]);
  });

  it('refuses a missing file and a directory', () => {
    mkdirSync(join(outputDir, 'd'));
    const c = collectAttachments([att('a', join(outputDir, 'nope')), att('b', join(outputDir, 'd'))], { checkoutDir: checkout, outputDir, artifactDir });
    expect(c.artifacts).toEqual([]);
  });

  it('writes inline bodies as redacted files and parses the fixture attachments', () => {
    const diag = JSON.stringify({ browserName: 'chromium', browserVersion: '1.2.3.4', viewport: { width: 390, height: 844 }, project: 'mobile', consoleErrors: [{ type: 'error', text: 'oops ghp_abcdefghijklmnopqrstuvwxyz0123456789', url: 'u', line: 1 }], pageErrors: [], failedRequests: [], badResponses: [], finalUrl: 'http://x/', dropped: 0 });
    const c = collectAttachments([att('orbit-diagnostics', null, diag, 'application/json')], { checkoutDir: checkout, outputDir, artifactDir });
    expect(c.browser).toEqual({ name: 'chromium', version: '1.2.3.4', viewport: { width: 390, height: 844 }, project: 'mobile' });
    expect(c.diagnostics?.consoleErrors).toHaveLength(1);
    expect(c.artifacts[0]).toMatchObject({ kind: 'diagnostics' });
  });
});

describe('toEvidenceUi', () => {
  const run = (verdict: UiRunResult['verdict'], statuses: UiJourneyStatus[]): UiRunResult => runResult({ verdict, journeys: statuses.map((status, i) => journeyResult({ id: `j${i}`, status })) });
  it('maps journey statuses to evidence statuses', () => {
    expect(toEvidenceUi(run('FAIL', ['PASSED', 'FLAKY', 'FAILED', 'SKIPPED', 'TIMED_OUT', 'INTERRUPTED'])).map((e) => e.status)).toEqual(['PASSED', 'PASSED', 'FAILED', 'FAILED', 'TIMEOUT', 'CANCELLED']);
  });
  it('lets an errored, timed out or cancelled run override its journeys', () => {
    expect(toEvidenceUi(run('ERROR', ['PASSED']))[0]?.status).toBe('ERROR');
    expect(toEvidenceUi(run('TIMEOUT', ['PASSED']))[0]?.status).toBe('TIMEOUT');
    expect(toEvidenceUi(run('CANCELLED', ['PASSED']))[0]?.status).toBe('CANCELLED');
  });
});
