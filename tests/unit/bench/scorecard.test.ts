import { describe, expect, it } from 'vitest';
import { buildScorecard, countsOf, parseFalseDones, renderScorecard, scorecardFile, stableJson, TIMESTAMP_FIELDS, type ScenarioRow } from '../../../src/bench/scorecard.ts';

const row = (id: string, over: Partial<ScenarioRow> = {}): ScenarioRow => ({ id, issue: '#130', title: id, result: 'pass', failure_class: null, end_state: 'SUCCEEDED', attempts: 1, spend_usd: 0.03, wall_ms: null, delivered: true, problems: [], ...over });

describe('bench scorecard (#172)', () => {
  it('US1.1: each scenario reports pass or fail, the failure class, attempts and simulated spend; invalid ones are listed and counted nowhere', () => {
    const rows = [
      row('a'),
      row('b', { result: 'fail', failure_class: 'review-dispute', end_state: 'BLOCKED', attempts: 2, spend_usd: 0.05, delivered: false, problems: ['ended BLOCKED, expected SUCCEEDED'] }),
      row('c', { result: 'invalid', attempts: 9, spend_usd: 9, problems: ['expected state RUNNING is not a terminal state'] }),
    ];
    const card = buildScorecard({ tier: 'lab', orbitVersion: '0.4.0', generatedAt: '2026-11-20T00:00:00.000Z', rows });
    expect(card.headline).toMatchObject({ scenarios: 3, valid: 2, passed: 1, failed: 1, invalid: 1, pass_rate: 0.5, attempts: 3, spend_usd: 0.08 });
    const text = renderScorecard(card);
    expect(text).toMatch(/^b\s+#130\s+FAIL\s+BLOCKED\s+review-dispute\s+2\s+\$0\.0500$/m);
    expect(text).toMatch(/^a\s+#130\s+PASS\s+SUCCEEDED\s+-\s+1\s+\$0\.0300$/m);
    expect(text).toContain('simulated spend');
    expect(text).toContain('c (invalid):\n  - expected state RUNNING is not a terminal state');
  });

  it('FR-007, SC-004: the headline is the false-done rate of this version, and each false done links what found it', () => {
    const records = parseFalseDones(
      JSON.stringify([
        { orbit_version: '0.4.0', ref: 'https://github.com/QuintinBotes/orbit/pull/300', found_by: 'revert', link: 'https://github.com/QuintinBotes/orbit/commit/abc1234' },
        { orbit_version: '0.3.2', ref: 'pull 200', found_by: 'reopened-issue', link: 'https://github.com/QuintinBotes/orbit/issues/200' },
      ]),
    );
    const card = buildScorecard({ tier: 'lab', orbitVersion: '0.4.0', generatedAt: 't', rows: [row('a'), row('b'), row('c', { delivered: false, result: 'fail' }), row('d')], falseDones: records });
    expect(card.headline.false_done).toMatchObject({ delivered: 3, count: 1, rate: 0.3333 });
    const lines = renderScorecard(card).split('\n');
    // The rate is the first thing the report says, before any other number.
    expect(lines[2]).toBe('False-done rate for 0.4.0: 1 of 3 delivered runs (33.3%)');
    expect(lines[3]).toBe('  https://github.com/QuintinBotes/orbit/pull/300 found by revert: https://github.com/QuintinBotes/orbit/commit/abc1234');
    expect(renderScorecard(buildScorecard({ tier: 'lab', orbitVersion: '0.4.0', generatedAt: 't', rows: [row('a', { delivered: false })] }))).toContain('False-done rate for 0.4.0: n/a (no delivered runs)');
  });

  it('reads the person-kept false-done file and refuses a malformed record instead of skipping it', () => {
    expect(parseFalseDones('[]')).toEqual([]);
    expect(parseFalseDones('{"records": []}')).toEqual([]);
    expect(() => parseFalseDones('[{"orbit_version": "0.4.0", "ref": "x", "found_by": "a hunch", "link": "https://x.test"}]')).toThrow(/record 1 has an invalid found_by/);
    expect(() => parseFalseDones('[{"orbit_version": "0.4.0", "ref": "x", "found_by": "revert", "link": "not a link"}]')).toThrow(/record 1 has an invalid link/);
    expect(() => parseFalseDones('{')).toThrow(/not JSON/);
  });

  it('FR-004: a scorecard is stored per version and tier as stable JSON, so the same results give the same bytes and two versions diff line by line', () => {
    expect(scorecardFile('0.4.0', 'lab')).toBe('orbit-0.4.0-lab.json');
    expect(scorecardFile('0.4.0', 'lab', 'diagnosis')).toBe('orbit-0.4.0-lab-without-diagnosis.json');
    expect(scorecardFile('0.4.0', 'live')).toBe('orbit-0.4.0-live.json');
    const a = buildScorecard({ tier: 'lab', orbitVersion: '0.4.0', generatedAt: 'then', rows: [row('a'), row('b')] });
    const b = buildScorecard({ tier: 'lab', orbitVersion: '0.4.0', generatedAt: 'now', rows: [row('a'), row('b')] });
    const strip = (s: string): string => s.split('\n').filter((l) => !TIMESTAMP_FIELDS.some((f) => l.includes(`"${f}"`))).join('\n');
    expect(strip(stableJson(a))).toBe(strip(stableJson(b)));
    expect(stableJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n');
  });

  it('US3.1: with one stage off the report shows pass rate and spend with and without it, and names each scenario that changed', () => {
    const card = buildScorecard({ tier: 'lab', orbitVersion: '0.4.0', generatedAt: 't', rows: [row('a', { spend_usd: 0.05 }), row('b')], without: { stage: 'diagnosis', rows: [row('a', { spend_usd: 0.04, result: 'fail' }), row('b')] } });
    expect(card.comparison).toMatchObject({ stage: 'diagnosis', with: { pass_rate: 1, spend_usd: 0.08 }, without: { pass_rate: 0.5, spend_usd: 0.07 }, changed: [{ id: 'a', with: 'pass', without: 'fail' }] });
    const text = renderScorecard(card);
    expect(text).toMatch(/^with\s+2\s+2\s+100\.0%\s+2\s+\$0\.0800$/m);
    expect(text).toMatch(/^without diagnosis\s+2\s+1\s+50\.0%\s+2\s+\$0\.0700$/m);
    expect(text).toContain('Changed without diagnosis: a (pass -> fail)');
  });

  it('FR-005, US2.2: the live headline gives pass rate over the runs, cost per accepted task and time, and the plain-session baseline with the difference', () => {
    const orbit = [row('g#1', { spend_usd: 2, wall_ms: 60_000 }), row('g#2', { spend_usd: 2, wall_ms: 60_000 }), row('g#3', { result: 'fail', spend_usd: 2, wall_ms: 60_000 })];
    const plain = [row('g#1', { spend_usd: 1, wall_ms: 30_000 }), row('g#2', { result: 'fail', spend_usd: 1, wall_ms: 30_000 }), row('g#3', { result: 'fail', spend_usd: 1, wall_ms: 30_000 })];
    const card = buildScorecard({ tier: 'live', orbitVersion: '0.4.0', generatedAt: 't', rows: orbit, baseline: plain, approval: { by: 'owner', budget_usd: 20 } });
    expect(countsOf(orbit)).toMatchObject({ pass_rate: 0.6667, cost_per_pass_usd: 3, wall_ms: 180_000 });
    expect(card.baseline).toMatchObject({ counts: { pass_rate: 0.3333, cost_per_pass_usd: 3 }, difference: { pass_rate: 0.3334, cost_per_pass_usd: 0 } });
    expect(card.approval).toEqual({ by: 'owner', budget_usd: 20 });
    const text = renderScorecard(card);
    expect(text).toContain('Runs: 3 valid, 2 passed, 1 failed, 0 invalid; pass rate 66.7%; 3 attempts; spend $6.0000; cost per accepted task $3.0000; time 180s');
    expect(text).toContain('Plain claude -p session on the same goals: 3 valid, 1 passed');
    expect(text).toContain('Orbit minus the plain session: pass rate +33.3 points, cost per accepted task +$0.0000');
  });
});
