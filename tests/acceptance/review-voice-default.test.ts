/**
 * Issue #231, FR-005: with no review.mode the mode is off and nothing else changes. The same risky lab run as
 * tests/acceptance/review-voice.test.ts, with no review settings at all, leaves the decisions, reviewer sessions, state path
 * and final report that origin/next left before this change (review-voice-default.fixture.json, captured from c116082 with
 * helpers/default-capture.ts), and the default config hashes as it did, so the frozen policy snapshot is unchanged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { drive, makeLab, ORBIT_ROOT, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, GOOD_IMPLEMENTATION, planner, scenario } from './helpers/scenarios.ts';
import { captureDefaultRun } from './helpers/default-capture.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const RISKY = planner({
  allowed: ['src/server.ts', 'src/notes/**', 'tests/unit/**'],
  files: [
    ['src/server.ts', 'modify', 'new not-found text'],
    ['tests/unit/server.test.ts', 'modify', 'assert the text'],
    ['src/notes/not-found.md', 'add', 'note the text'],
  ],
  risks: [{ risk: 'the not-found handler sits in front of the auth token check', impact: 'high', mitigation: 'keep the check order' }],
});

describe.skipIf(!READY)('acceptance: review.mode is off by default and changes nothing (issue #231, FR-005)', () => {
  it('a default-mode risky run records what origin/next recorded, and the default config hashes as before', async () => {
    const l = makeLab({ tweak: (c) => void (c.routing.implementers = ['codex', 'claude']) });
    labs.push(l);
    writeScenario(l, scenario({ planner: [RISKY], implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    expect((await drive(l, run.id)).state).toBe('SUCCEEDED');
    const fixture = JSON.parse(readFileSync(join(ORBIT_ROOT, 'tests', 'acceptance', 'review-voice-default.fixture.json'), 'utf8')) as Record<string, unknown>;
    const now = captureDefaultRun(l, run.id) as Record<string, unknown>;
    expect(now.default_config_hash).toBe(fixture.default_config_hash);
    expect(now).toEqual(fixture);
  }, 300_000);
});
