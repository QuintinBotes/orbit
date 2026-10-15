// Fail-before for browser checks (ADR 0016, item 4): a browser check (kind playwright, or one of
// ui.journey_check_ids) under which a new journey lies is probeable without a result on the base revision, which
// the baseline never gives it. The ui probe's control run on the base revision stands in for that result, and the
// check's outcome then reaches the criterion's fail_before entry like a test check's does.
import { describe, expect, it } from 'vitest';
import { criterionFailBefore, isBrowserCheck, newTestSupport, type FailBeforeEvidence, type ProbeResult } from '../../../src/evidence/fail-before.ts';
import { defaultUi } from '../../../src/policy/config.ts';
import type { BaseComparison } from '../../../src/evidence/report.ts';
import { contract, fakeSnapshot } from './report-fixtures.ts';
import { checkDef } from './fixtures.ts';

const journeys = checkDef('journeys', { kind: 'playwright', category: 'ui', command: ['npx', 'playwright', 'test'] });
const visual = checkDef('visual', { kind: 'playwright', category: 'ui', command: ['npx', 'playwright', 'test'], mandatory: false });
const snapshot = fakeSnapshot([checkDef('unit'), journeys, visual], (c) => void (c.ui = { ...defaultUi(), journey_check_ids: ['journeys'] }));
const twoCriteria = contract({
  acceptance_criteria: [
    { id: 'AC-1', statement: 'the login journey signs in', proof: ['e2e/login.spec.ts'], mandatory: true, ui: true, check_ids: ['journeys'] },
    { id: 'AC-2', statement: 'mul multiplies', proof: ['tests/mul.test.mjs'], mandatory: true, check_ids: ['unit'] },
  ],
  required_check_ids: ['unit', 'journeys'],
});
const base: BaseComparison = {
  treeHash: 'tree-base',
  // The baseline runs command checks only: the browser check has no result on the base revision.
  checks: [{ checkId: 'unit', status: 'PASSED' }],
  changedPaths: ['apps/login.mjs', 'e2e/login.spec.ts', 'tests/mul.test.mjs'],
};

describe('browser checks are probeable', () => {
  it('isBrowserCheck: a playwright check or a journey check, never a command check', () => {
    expect(isBrowserCheck(snapshot, 'journeys')).toBe(true);
    expect(isBrowserCheck(snapshot, 'visual')).toBe(true);
    expect(isBrowserCheck(snapshot, 'unit')).toBe(false);
    expect(isBrowserCheck(snapshot, 'missing')).toBe(false);
  });

  it('a browser check with a new journey is probeable with no base result, and a command check still needs its base pass', () => {
    const support = newTestSupport(twoCriteria, snapshot, base);
    expect(support[0]).toMatchObject({ criterionId: 'AC-1', withTests: ['journeys'], probeable: ['journeys'], testPaths: ['e2e/login.spec.ts', 'tests/mul.test.mjs'] });
    expect(support[1]).toMatchObject({ criterionId: 'AC-2', withTests: ['unit'], probeable: ['unit'] });
    const noBasePass = newTestSupport(twoCriteria, snapshot, { ...base, checks: [] });
    expect(noBasePass[0]!.probeable).toEqual(['journeys']);
    expect(noBasePass[1]!.probeable).toEqual([]);
  });

  it('a browser check the probe found failing before gives its criterion failed-before', () => {
    const support = newTestSupport(twoCriteria, snapshot, base)[0]!;
    const probe: ProbeResult = {
      probeId: 'probe-ui-1',
      probeTree: 'tree-probe',
      baseRevision: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0',
      testPaths: ['e2e/login.spec.ts'],
      reused: false,
      checks: [
        {
          checkId: 'journeys',
          outcome: 'failed-before',
          reason: 'journeys failed on the base revision with the new tests (exit 1, 2 attempts)',
          attempts: [
            { attempt: 1, status: 'FAILED', exitCode: 1, signals: [], log: 'evidence/1/fail-before/ui/probe-1/journeys/run.log' },
            { attempt: 2, status: 'FAILED', exitCode: 1, signals: [], log: 'evidence/1/fail-before/ui/probe-2/journeys/run.log' },
          ],
        },
      ],
    };
    const fb: FailBeforeEvidence = { mode: 'required', probe, skipped: null, accepted: [] };
    expect(criterionFailBefore(support, fb)).toMatchObject({
      outcome: 'failed-before',
      probe_tree: 'tree-probe',
      checks: [{ id: 'journeys', outcome: 'failed-before', attempts: [{ status: 'FAILED', exit_code: 1 }, { status: 'FAILED', exit_code: 1 }] }],
    });
  });
});
