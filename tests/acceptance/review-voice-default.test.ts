/**
 * Issue #231, FR-005: with no review.mode the mode is off and nothing else changes. defaultConfig carries no mode (so the
 * frozen policy snapshot of every run is unchanged), and the same risky lab run with no review mode and with
 * `review.mode: default` leaves identical decisions, reviews, reviewer sessions, state path and report, with no
 * review-voice decision and no CLI call. Both runs are of this code, so the test does not depend on what next records.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/policy/config.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { drive, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, GOOD_IMPLEMENTATION, planner, scenario } from './helpers/scenarios.ts';
import { captureDefaultRun } from './helpers/default-capture.ts';

const labs: Lab[] = [];
const dirs: string[] = [];
afterEach(() => {
  labs.splice(0).forEach((l) => l.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const RISKY = planner({
  allowed: ['src/server.ts', 'src/notes/**', 'tests/unit/**'],
  files: [
    ['src/server.ts', 'modify', 'new not-found text'],
    ['tests/unit/server.test.ts', 'modify', 'assert the text'],
    ['src/notes/not-found.md', 'add', 'note the text'],
  ],
  risks: [{ risk: 'the not-found handler sits in front of the auth token check', impact: 'high', mitigation: 'keep the check order' }],
});

describe('review.mode is absent from the default config (issue #231, FR-005)', () => {
  it('leaves mode out, so the policy snapshot hash of every run is unchanged', () => {
    expect('mode' in defaultConfig().review).toBe(false);
  });
});

describe.skipIf(!READY)('acceptance: review.mode is off by default and changes nothing (issue #231, FR-005)', () => {
  async function risky(mode: 'default' | undefined): Promise<{ captured: unknown; kinds: string[]; cliCalls: boolean }> {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-rv-off-'));
    dirs.push(dir);
    const marker = join(dir, 'called');
    const l = makeLab({
      tweak: (c) => {
        c.routing.implementers = ['codex', 'claude'];
        if (mode) c.review.mode = mode;
        // A command that would leave a trace if the Review Voice path ever ran.
        c.review.review_voice = { command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`] };
      },
    });
    labs.push(l);
    writeScenario(l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    expect((await drive(l, run.id)).state).toBe('SUCCEEDED');
    return { captured: captureDefaultRun(l, run.id), kinds: listDecisions(l.db(), run.id, {}).map((d) => d.kind), cliCalls: existsSync(marker) };
  }

  it('a risky run with no review mode records what one with review.mode: default records, and never touches Review Voice', async () => {
    const absent = await risky(undefined);
    const explicit = await risky('default');
    expect(absent.captured).toEqual(explicit.captured);
    for (const r of [absent, explicit]) {
      expect(r.kinds.filter((k) => k.includes('review-voice'))).toEqual([]);
      expect(r.cliCalls).toBe(false);
    }
    // Positive control: the run did have a same-family pass to replace.
    expect((absent.captured as { reviewers: { purpose: string }[] }).reviewers.some((w) => w.purpose.startsWith('review-family:'))).toBe(true);
  }, 400_000);
});
