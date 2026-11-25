/**
 * Issue #231: Review Voice's CLI as the same-family review pass. The mapping of its review-output findings, the runner's
 * one retry, the availability check that decides the fallback, and the config key.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/policy/config.ts';
import { reviewMode } from '../../../src/policy/review.ts';
import { mapReviewVoiceOutput, reviewVoiceAvailability, reviewVoiceEnv, reviewVoiceRange, reviewVoiceTimeoutMs, runReviewVoice, type ReviewVoiceExec } from '../../../src/review/review-voice.ts';
import { reviewVoiceCheck } from '../../../src/cli/commands/doctor-review-voice.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'orbit-rvu-'));
  dirs.push(d);
  return d;
};

const COMMIT = 'a'.repeat(40);
const CHANGED = new Set(['src/a.ts', 'src/b.ts']);
const map = (doc: unknown, changed: ReadonlySet<string> = CHANGED) => mapReviewVoiceOutput(doc, COMMIT, changed);
const finding = (severity: string, id = 'rv_01', path = 'src/a.ts', line = 3) => ({ finding_id: id, severity, path, line, category: 'correctness', text: 'Problem. Consequence.', word_count: 2 });

describe('mapReviewVoiceOutput (FR-002)', () => {
  it.each([
    ['blocking', 'high'],
    ['important', 'medium'],
    ['minor', 'low'],
    ['nit', 'info'],
    ['question', 'info'],
  ])('maps %s to %s and keeps the anchor and id', (rv, orbit) => {
    const r = map({ review_run_id: 'r', findings: [finding(rv)] });
    expect(r.findings).toEqual([expect.objectContaining({ externalId: 'RV-1', severity: orbit, location: 'src/a.ts:3', path: 'src/a.ts', line: 3, category: 'correctness', claim: 'Problem. Consequence.' })]);
    expect(r.candidateRevision).toBe(COMMIT);
  });

  it('asks for repair on a blocking finding and approves otherwise', () => {
    expect(map({ review_run_id: 'r', findings: [finding('blocking'), finding('nit', 'rv_02')] }).verdict).toBe('REPAIR_REQUIRED');
    expect(map({ review_run_id: 'r', findings: [finding('important')] }).verdict).toBe('APPROVE');
    expect(map({ review_run_id: 'r', findings: [], no_findings_response: 'No actionable findings.' })).toMatchObject({ verdict: 'APPROVE', findings: [] });
  });

  it('refuses output that is not a review-output document, and an unknown severity', () => {
    expect(() => map({ nope: true })).toThrow(/review-output/);
    expect(() => map({ review_run_id: 'r', findings: [finding('catastrophic')] })).toThrow(/severity/);
  });
});

describe('mapReviewVoiceOutput validates the untrusted document (issue #231 review)', () => {
  const doc = (...findings: object[]) => ({ review_run_id: 'r', findings });
  const f = (over: Record<string, unknown> = {}) => ({ ...finding('important'), ...over });

  it('refuses more than 100 findings, and accepts exactly 100 (positive control)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => f({ finding_id: `rv_${String(i + 1).padStart(2, '0')}` }));
    expect(() => map(doc(...many(101)))).toThrow(/100/);
    expect(map(doc(...many(100))).findings).toHaveLength(100);
  });
  it.each([['rv_1'], ['RV-1'], ['SEC-1'], ['rv_xx'], [7]])('refuses the finding id %s', (id) => {
    expect(() => map(doc(f({ finding_id: id })))).toThrow(/finding_id|id/);
  });
  it('refuses text over the length cap, and accepts text at it (positive control)', () => {
    expect(() => map(doc(f({ text: 'x'.repeat(1001) })))).toThrow(/text/);
    expect(map(doc(f({ text: 'x'.repeat(1000) }))).findings).toHaveLength(1);
  });
  it.each([[0], [-3], [1.5], ['4'], [Number.MAX_SAFE_INTEGER + 2]])('refuses the line %s', (line) => {
    expect(() => map(doc(f({ line })))).toThrow(/line/);
  });
  it.each([['/etc/passwd'], ['../secret.ts'], ['src/../../x.ts'], ['C:\\x.ts'], ['src/a.ts\n'], ['']])('drops a finding at the unsafe path %j and says so', (path) => {
    const r = map(doc(f({ path }), f({ finding_id: 'rv_02', path: 'src/b.ts' })));
    expect(r.findings.map((x) => x.path)).toEqual(['src/b.ts']);
    expect(r.warnings.join(' ')).toMatch(/dropped/);
  });
  it('drops a finding on a file the candidate did not change, naming it, and keeps the others', () => {
    const r = map(doc(f({ path: 'src/untouched.ts' }), f({ finding_id: 'rv_02', path: 'src/a.ts' })));
    expect(r.findings.map((x) => x.path)).toEqual(['src/a.ts']);
    expect(r.warnings).toEqual([expect.stringMatching(/rv_01.*src\/untouched\.ts.*not changed/)]);
  });
});

describe('mapReviewVoiceOutput assigns Orbit ids and categories (issue #231 review)', () => {
  const doc = (...findings: object[]) => ({ review_run_id: 'r', findings });
  it('gives each finding Orbit\'s own RV-n id, never the CLI\'s id and never SEC-', () => {
    const r = map(doc(finding('minor', 'rv_07'), finding('minor', 'rv_09', 'src/b.ts')));
    expect(r.findings.map((x) => x.externalId)).toEqual(['RV-1', 'RV-2']);
    expect(r.findings.every((x) => !x.externalId.startsWith('SEC-'))).toBe(true);
    expect(r.findings[0]!.evidence).toMatch(/rv_07/);
  });
  it.each([['evidence-classification'], ['missing-test'], ['SEC-auth'], ['made up'], [undefined]])('maps the category %s to one that carries no meaning of its own, and a blocking finding stays blocking', (category) => {
    const r = map(doc({ ...finding('blocking'), category }));
    expect(r.findings[0]!.severity).toBe('high');
    expect(r.verdict).toBe('REPAIR_REQUIRED');
    expect(['evidence-classification', 'missing-test']).not.toContain(r.findings[0]!.category);
    expect(r.findings[0]!.category).toBe('review-voice');
  });
  it('keeps a category from Review Voice\'s own set (positive control)', () => {
    expect(map(doc({ ...finding('minor'), category: 'authorization' })).findings[0]!.category).toBe('authorization');
  });
});

describe('the CLI\'s environment, range and timeout', () => {
  it('passes exactly the allowlist: no provider key, no token, no other variable', () => {
    const env = { PATH: '/bin', HOME: '/h', USER: 'u', LANG: 'C', TMPDIR: '/t', XDG_DATA_HOME: '/x', XDG_CONFIG_HOME: '/c', APPDATA: '/a', REVIEW_VOICE_DATA_DIR: '/d', REVIEW_VOICE_CONFIG: '/f', ANTHROPIC_API_KEY: 'k1', OPENAI_API_KEY: 'k2', GITHUB_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', META_API_KEY: 'm', SECRET: 's' };
    expect(Object.keys(reviewVoiceEnv(env)).sort()).toEqual(['APPDATA', 'HOME', 'LANG', 'PATH', 'REVIEW_VOICE_CONFIG', 'REVIEW_VOICE_DATA_DIR', 'TMPDIR', 'USER', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']);
  });
  it('names the run\'s base and the candidate commit, and refuses a run with no base revision', () => {
    expect(reviewVoiceRange({ baseRevision: 'b1' }, { commitSha: 'c1' })).toEqual({ ok: true, base: 'b1', head: 'c1' });
    expect(reviewVoiceRange({ baseRevision: null }, { commitSha: 'c1' })).toMatchObject({ ok: false, reason: expect.stringMatching(/no base revision/) });
    expect(reviewVoiceRange({ baseRevision: '' }, { commitSha: 'c1' })).toMatchObject({ ok: false });
  });
  it('takes review.review_voice.timeout_s, 900 s when it is unset', () => {
    expect(reviewVoiceTimeoutMs(undefined)).toBe(900_000);
    expect(reviewVoiceTimeoutMs({ command: ['x'] })).toBe(900_000);
    expect(reviewVoiceTimeoutMs({ command: ['x'], timeout_s: 30 })).toBe(30_000);
  });
  it('accepts timeout_s from 1 to 1200 and refuses 0 and 1201 (two attempts must fit the 45 minute step timeout)', () => {
    const cfg = (t: number) => parseConfig(`version: 1\nreview:\n  mode: review-voice\n  review_voice:\n    command: [rv]\n    timeout_s: ${t}\n`);
    expect(cfg(1).review.review_voice?.timeout_s).toBe(1);
    expect(cfg(1200).review.review_voice?.timeout_s).toBe(1200);
    expect(() => cfg(0)).toThrow(/timeout_s/);
    expect(() => cfg(1201)).toThrow(/timeout_s/);
  });
});

describe('runReviewVoice (edge cases: one retry, then the fallback)', () => {
  const ok = JSON.stringify({ review_run_id: 'r', findings: [] });
  const run = (exec: ReviewVoiceExec) => runReviewVoice({ command: ['rv', 'review'], cwd: '/repo', base: 'b', head: COMMIT, timeoutMs: 1000, env: {} }, exec);

  it('passes the exact range and returns the parsed output', async () => {
    const calls: string[][] = [];
    const r = await run(async (file, args) => (calls.push([file, ...args]), { stdout: ok, timedOut: false }));
    expect(r).toMatchObject({ ok: true, attempts: 1 });
    expect(calls).toEqual([['rv', 'review', '--base', 'b', '--head', COMMIT, '--json']]);
  });

  it('retries a timeout once and uses the second answer', async () => {
    let n = 0;
    const r = await run(async () => (++n === 1 ? { stdout: '', timedOut: true } : { stdout: ok, timedOut: false }));
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  it('gives up after a second failure, naming why', async () => {
    let n = 0;
    const r = await run(async () => (++n === 1 ? { stdout: '', timedOut: true } : { stdout: 'not json', timedOut: false }));
    expect(n).toBe(2);
    expect(r).toMatchObject({ ok: false, attempts: 2, reason: expect.stringMatching(/timed out|not valid JSON/) });
  });

  it('treats a thrown spawn error as a failure, not a crash', async () => {
    const r = await run(async () => {
      throw new Error('boom');
    });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/boom/) });
  });
});

describe('runReviewVoice against real children (a CLI that misbehaves must not hang or flood the controller)', () => {
  const script = (body: string): string[] => {
    const f = join(tmp(), 'child.mjs');
    writeFileSync(f, body);
    return [process.execPath, f];
  };
  // A generous timeout: only the limit under test may end a child. The SIGTERM test alone waits for its (short) timeout.
  const go = (command: string[], extra: { maxBuffer?: number; timeoutMs?: number } = {}) => runReviewVoice({ command, cwd: tmp(), base: 'b', head: COMMIT, timeoutMs: 60_000, env: { PATH: process.env.PATH ?? '' }, ...extra });

  it('kills a child that ignores SIGTERM and never exits, and gives up after the retry', async () => {
    const r = await go(script("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"), { timeoutMs: 400 });
    expect(r).toMatchObject({ ok: false, attempts: 2, reason: expect.stringMatching(/timed out/) });
  });

  it('kills a child that floods stdout past the cap', async () => {
    const r = await go(script("const fs = await import('node:fs'); const chunk = 'x'.repeat(65536); for (;;) fs.writeSync(1, chunk);"), { maxBuffer: 1024 * 1024 });
    expect(r).toMatchObject({ ok: false, attempts: 2, reason: expect.stringMatching(/output cap/) });
  });

  it('kills a child that floods stderr past the cap', async () => {
    const r = await go(script("const fs = await import('node:fs'); const chunk = 'x'.repeat(65536); for (;;) fs.writeSync(2, chunk);"), { maxBuffer: 1024 * 1024 });
    expect(r).toMatchObject({ ok: false, attempts: 2, reason: expect.stringMatching(/output cap/) });
  });

  it('reports a command that does not exist', async () => {
    const r = await go([join(tmp(), 'no-such-command')]);
    expect(r).toMatchObject({ ok: false, attempts: 2, reason: expect.stringMatching(/could not be run/) });
  });

  it('positive control: a well-behaved child that prints a review-output document is read', async () => {
    const r = await go(script("process.stdout.write(JSON.stringify({ review_run_id: 'r', findings: [] }));"));
    expect(r).toMatchObject({ ok: true, attempts: 1 });
  });
});

describe('reviewVoiceAvailability (FR-004)', () => {
  const dataDir = (): string => {
    const d = tmp();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'review-voice.db'), '');
    return d;
  };
  const exe = (): string => {
    const f = join(tmp(), 'rv');
    writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
    return f;
  };

  it('is usable when the command runs and its data directory holds the database', () => {
    expect(reviewVoiceAvailability({ command: [exe()] }, { REVIEW_VOICE_DATA_DIR: dataDir() })).toEqual({ ok: true });
  });
  it('names a missing command setting, a missing executable and a missing setup, each on its own', () => {
    expect(reviewVoiceAvailability(undefined, {})).toMatchObject({ ok: false, reason: expect.stringMatching(/review\.review_voice\.command/) });
    expect(reviewVoiceAvailability({ command: [join(tmp(), 'absent')] }, { REVIEW_VOICE_DATA_DIR: dataDir() })).toMatchObject({ ok: false, reason: expect.stringMatching(/not installed|not found/) });
    expect(reviewVoiceAvailability({ command: [exe()] }, { REVIEW_VOICE_DATA_DIR: tmp() })).toMatchObject({ ok: false, reason: expect.stringMatching(/not set up/) });
  });
});

describe('review.mode (FR-005)', () => {
  it('is off by default and accepts review-voice; anything else is refused', () => {
    expect(reviewMode(parseConfig('version: 1\n').review)).toBe('default');
    expect(reviewMode(parseConfig('version: 1\nreview:\n  mode: review-voice\n').review)).toBe('review-voice');
    expect(() => parseConfig('version: 1\nreview:\n  mode: both\n')).toThrow(/mode/);
  });
});

describe('doctor: reviewVoiceCheck (FR-004)', () => {
  const config = (mode: 'default' | 'review-voice', command?: string[]) => ({ review: { mode, ...(command ? { review_voice: { command } } : {}) } }) as never;
  it('reports nothing while the mode is off', () => {
    expect(reviewVoiceCheck(config('default'), {})).toBeNull();
  });
  it('fails, with a fix, when the mode is on and the CLI cannot be used', () => {
    const c = reviewVoiceCheck(config('review-voice', [join(tmp(), 'absent')]), {});
    expect(c).toMatchObject({ id: 'review.review-voice', status: 'fail' });
    expect(c!.fix).toMatch(/review-voice/);
  });
  it('passes when installed and set up', () => {
    const d = tmp();
    writeFileSync(join(d, 'review-voice.db'), '');
    const f = join(tmp(), 'rv');
    writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
    expect(reviewVoiceCheck(config('review-voice', [f]), { REVIEW_VOICE_DATA_DIR: d })).toMatchObject({ status: 'pass' });
  });
});
