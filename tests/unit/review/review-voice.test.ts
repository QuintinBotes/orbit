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
import { mapReviewVoiceOutput, reviewVoiceAvailability, runReviewVoice, type ReviewVoiceExec } from '../../../src/review/review-voice.ts';
import { reviewVoiceCheck } from '../../../src/cli/commands/doctor-review-voice.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'orbit-rvu-'));
  dirs.push(d);
  return d;
};

const COMMIT = 'a'.repeat(40);
const finding = (severity: string, id = 'rv_01', path = 'src/a.ts', line = 3) => ({ finding_id: id, severity, path, line, category: 'correctness', text: 'Problem. Consequence.', word_count: 2 });

describe('mapReviewVoiceOutput (FR-002)', () => {
  it.each([
    ['blocking', 'high'],
    ['important', 'medium'],
    ['minor', 'low'],
    ['nit', 'info'],
    ['question', 'info'],
  ])('maps %s to %s and keeps the anchor and id', (rv, orbit) => {
    const r = mapReviewVoiceOutput({ review_run_id: 'r', findings: [finding(rv)] }, COMMIT);
    expect(r.findings).toEqual([expect.objectContaining({ externalId: 'rv_01', severity: orbit, location: 'src/a.ts:3', path: 'src/a.ts', line: 3, category: 'correctness', claim: 'Problem. Consequence.' })]);
    expect(r.candidateRevision).toBe(COMMIT);
  });

  it('asks for repair on a blocking finding and approves otherwise', () => {
    expect(mapReviewVoiceOutput({ review_run_id: 'r', findings: [finding('blocking'), finding('nit', 'rv_02')] }, COMMIT).verdict).toBe('REPAIR_REQUIRED');
    expect(mapReviewVoiceOutput({ review_run_id: 'r', findings: [finding('important')] }, COMMIT).verdict).toBe('APPROVE');
    expect(mapReviewVoiceOutput({ review_run_id: 'r', findings: [], no_findings_response: 'No actionable findings.' }, COMMIT)).toMatchObject({ verdict: 'APPROVE', findings: [] });
  });

  it('refuses output that is not a review-output document, and an unknown severity', () => {
    expect(() => mapReviewVoiceOutput({ nope: true }, COMMIT)).toThrow(/review-output/);
    expect(() => mapReviewVoiceOutput({ review_run_id: 'r', findings: [finding('catastrophic')] }, COMMIT)).toThrow(/severity/);
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
  const go = (command: string[], extra: { maxBuffer?: number } = {}) => runReviewVoice({ command, cwd: tmp(), base: 'b', head: COMMIT, timeoutMs: 400, env: { PATH: process.env.PATH ?? '' }, ...extra });

  it('kills a child that ignores SIGTERM and never exits, and gives up after the retry', async () => {
    const r = await go(script("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"));
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
