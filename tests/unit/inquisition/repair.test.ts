import { describe, expect, it } from 'vitest';
import type { DiagnosisOutput } from '../../../src/contract/model-outputs.ts';
import type { RepairBrief } from '../../../src/evidence/types.ts';
import { briefFromDiagnosis, nonProgress, nonProgressThreshold, progressSince, validateRepairBrief, type AttemptSnapshot, type BriefContext } from '../../../src/inquisition/repair.ts';
import type { PriorHypothesis } from '../../../src/inquisition/hypotheses.ts';

const CHECKS = ['lint', 'typecheck', 'reports-tests', 'build'];
const CTX: BriefContext = { policyCheckIds: CHECKS, protectedTests: ['tests/reports/export.test.ts'], expectedFingerprint: 'fp-page' };

function brief(over: Partial<RepairBrief> = {}): RepairBrief {
  return {
    fingerprint: 'fp-page',
    evidence: ['reports-tests failed: expected 250 rows, received 100 (log reports-tests.log line 42)', 'The query in apps/api/reports.ts applies LIMIT before the filter.'],
    hypotheses: [
      { statement: 'The export query applies the page limit before the filter.', supporting: 'The generated SQL in the log shows LIMIT 100 before the WHERE clause.' },
      { statement: 'The serializer stops reading after the first chunk.', supporting: 'The row count equals exactly one chunk size.', refuting: 'The chunk size is 500, not 100.' },
    ],
    experiment: 'Run the export on a fixture with 250 matching rows and print the generated SQL.',
    expected_observation: 'The SQL shows LIMIT before WHERE and only 100 rows are returned.',
    scoped_fix: 'Move the limit clause after the filter in buildExportQuery in apps/api/reports.ts.',
    post_fix_checks: ['reports-tests', 'typecheck'],
    preserved_constraints: ['tests/reports/export.test.ts must stay unchanged and pass', 'The on-screen report keeps its current page size.'],
    ...over,
  };
}

function problems(over: Partial<RepairBrief> | unknown, ctx: BriefContext = CTX): string[] {
  return validateRepairBrief(typeof over === 'object' && over !== null && !Array.isArray(over) ? brief(over as Partial<RepairBrief>) : over, ctx).problems;
}

describe('validateRepairBrief', () => {
  it('accepts a complete, specific brief', () => {
    expect(validateRepairBrief(brief(), CTX)).toEqual({ valid: true, problems: [], novelty: [] });
  });

  it('rejects non-objects', () => {
    expect(problems(null)).toEqual(['repair brief must be an object']);
  });

  it('requires every spec section 14 field', () => {
    const empty = validateRepairBrief({}, CTX).problems.join('\n');
    for (const needle of ['fingerprint is missing', 'evidence is missing', 'at least one hypothesis', 'experiment must be', 'expected_observation', 'scoped_fix', 'post_fix_checks', 'preserved_constraints']) {
      expect(empty).toContain(needle);
    }
  });

  it('the fingerprint must be the failure being repaired', () => {
    expect(problems({ fingerprint: 'fp-other' }).join()).toContain('not the failure being repaired');
    expect(problems({ fingerprint: 'unknown' }).join()).toContain('fingerprint is missing');
  });

  it('rejects placeholder or bare-instruction content', () => {
    expect(problems({ evidence: ['TBD'] }).join()).toContain('each evidence entry');
    expect(problems({ experiment: 'Investigate the failure' }).join()).toContain('experiment must be');
    expect(problems({ experiment: 'debug' }).join()).toContain('experiment must be');
    expect(problems({ expected_observation: 'it works' }).join()).toContain('expected_observation');
    expect(problems({ scoped_fix: 'fix it' }).join()).toContain('scoped_fix');
    expect(problems({ hypotheses: [{ statement: 'todo', supporting: 'n/a' }] }).join()).toContain('hypothesis 1 needs');
  });

  it('rejects a fix that is not scoped', () => {
    expect(problems({ scoped_fix: 'Rewrite the entire export module and refactor all the tests too.' }).join()).toContain('not scoped');
    expect(problems({ scoped_fix: 'Update all the tests and all the code to make this pass.' }).join()).toContain('not scoped');
  });

  it('post-fix checks must be check ids the policy defines', () => {
    expect(problems({ post_fix_checks: [] }).join()).toContain('at least one check');
    const p = problems({ post_fix_checks: ['reports-tests', 'curl-evil', 'npm test'] }).join();
    expect(p).toContain('unknown: curl-evil, npm test');
  });

  it('preserved constraints must include every protected test', () => {
    expect(problems({ preserved_constraints: ['The on-screen report keeps its current page size.'] }).join()).toContain('protected test tests/reports/export.test.ts');
    expect(problems({ preserved_constraints: ['Keep ./tests/reports/export.test.ts passing and unmodified.'] })).toEqual([]);
    expect(problems({ preserved_constraints: [] }).join()).toContain('preserved_constraints must name');
  });

  it('hypotheses within one brief must compete, not restate each other', () => {
    const p = problems({
      hypotheses: [
        { statement: 'The export query applies the page limit before the filter.', supporting: 'The SQL in the log shows LIMIT first.' },
        { statement: 'The page limit is applied before the filter by the export query.', supporting: 'Same SQL evidence in the log.' },
      ],
    });
    expect(p.join()).toContain('hypothesis 2 restates');
  });

  it('refuses a brief whose hypotheses only reword earlier ones, but accepts a genuinely new one', () => {
    const priors: PriorHypothesis[] = [
      { id: 'hyp-1', statement: 'The export query applies the page limit before the filter.', fingerprint: 'fp-page', experiment: 'Run the export on a fixture with 250 matching rows and print the generated SQL.', expectedObservation: 'The SQL shows LIMIT before WHERE and only 100 rows are returned.', status: 'eliminated' },
      { id: 'hyp-2', statement: 'The serializer stops reading after the first chunk.', fingerprint: 'fp-page', experiment: 'Log chunk reads during export.', expectedObservation: 'One chunk read, then close.', status: 'eliminated' },
    ];
    const rejected = validateRepairBrief(brief(), { ...CTX, priorHypotheses: priors });
    expect(rejected.valid).toBe(false);
    expect(rejected.problems.join()).toContain('no hypothesis is new');
    const fresh = validateRepairBrief(
      brief({ hypotheses: [{ statement: 'The CSV writer closes the stream before the final flush completes.', supporting: 'The last chunk is missing in the written file.' }], experiment: 'Add a flush log and export 250 rows.', expected_observation: 'The flush log line appears after the close log line.' }),
      { ...CTX, priorHypotheses: priors },
    );
    expect(fresh.valid).toBe(true);
    expect(fresh.novelty[0]?.novelty.isNew).toBe(true);
  });
});

describe('briefFromDiagnosis', () => {
  it('turns a null refutation into an absent one', () => {
    const out: Pick<DiagnosisOutput, 'repair_brief'> = {
      repair_brief: {
        fingerprint: 'fp',
        evidence: ['e'],
        hypotheses: [{ statement: 's', supporting: 'x', refuting: null }, { statement: 't', supporting: 'y', refuting: 'z' }],
        experiment: 'x',
        expected_observation: 'o',
        scoped_fix: 'f',
        post_fix_checks: ['lint'],
        preserved_constraints: ['c'],
      },
    };
    const b = briefFromDiagnosis(out);
    expect(b.hypotheses[0]).toEqual({ statement: 's', supporting: 'x' });
    expect('refuting' in b.hypotheses[0]!).toBe(false);
    expect(b.hypotheses[1]?.refuting).toBe('z');
  });
});

function attempt(n: number, over: Partial<AttemptSnapshot> = {}): AttemptSnapshot {
  return {
    attempt: n,
    supportedCriteria: [],
    passingMandatoryChecks: ['lint'],
    failingMandatoryChecks: ['reports-tests'],
    failureFingerprints: ['fp-page'],
    eliminatedHypotheses: [],
    localizedFault: null,
    resolvedAmbiguities: [],
    ...over,
  };
}

describe('progressSince', () => {
  it('counts a newly supported criterion', () => {
    const p = progressSince(attempt(1), attempt(2, { supportedCriteria: ['AC-2'] }));
    expect(p).toMatchObject({ newly_supported_criteria: ['AC-2'], made_progress: true });
  });

  it('counts a mandatory check that was failing and now passes', () => {
    const p = progressSince(attempt(1), attempt(2, { failingMandatoryChecks: [], passingMandatoryChecks: ['lint', 'reports-tests'] }));
    expect(p.fixed_checks).toEqual(['reports-tests']);
    expect(p.made_progress).toBe(true);
  });

  it('a check that merely disappeared from the results is not fixed', () => {
    const p = progressSince(attempt(1), attempt(2, { failingMandatoryChecks: [], passingMandatoryChecks: ['lint'] }));
    expect(p.fixed_checks).toEqual([]);
    expect(p.made_progress).toBe(false);
  });

  it('counts an eliminated hypothesis, a localized fault and a resolved ambiguity', () => {
    expect(progressSince(attempt(1), attempt(2, { eliminatedHypotheses: ['hyp-1'] }))).toMatchObject({ eliminated_hypotheses: ['hyp-1'], made_progress: true });
    expect(progressSince(attempt(1), attempt(2, { localizedFault: 'apps/api/reports.ts:buildExportQuery' }))).toMatchObject({ localized_fault: 'apps/api/reports.ts:buildExportQuery', made_progress: true });
    expect(progressSince(attempt(1), attempt(2, { resolvedAmbiguities: ['q-1'] }))).toMatchObject({ resolved_ambiguity: ['q-1'], made_progress: true });
  });

  it('only the newly eliminated and newly localized count, not the cumulative totals', () => {
    const prev = attempt(1, { eliminatedHypotheses: ['hyp-1'], localizedFault: 'a.ts:f', resolvedAmbiguities: ['q-1'] });
    const p = progressSince(prev, attempt(2, { eliminatedHypotheses: ['hyp-1'], localizedFault: 'a.ts:f', resolvedAmbiguities: ['q-1'] }));
    expect(p.made_progress).toBe(false);
    expect(p.summary).toBe('no measurable progress');
  });

  it('more tokens and a bigger diff never count, and are reported as ignored', () => {
    const p = progressSince(attempt(1, { tokens: 1000, diffLines: 10 }), attempt(2, { tokens: 90_000, diffLines: 900 }));
    expect(p.made_progress).toBe(false);
    expect(p.ignored).toEqual(['more tokens spent', 'larger diff']);
  });

  it('a swap (fix one, break another) is not progress', () => {
    const prev = attempt(1, { supportedCriteria: ['AC-1'], passingMandatoryChecks: ['lint', 'typecheck'], failingMandatoryChecks: ['reports-tests'] });
    const cur = attempt(2, { supportedCriteria: ['AC-2'], passingMandatoryChecks: ['lint', 'reports-tests'], failingMandatoryChecks: ['typecheck'] });
    const p = progressSince(prev, cur);
    expect(p.regressions).toEqual({ lost_criteria: ['AC-1'], newly_failing_checks: ['typecheck'] });
    expect(p.made_progress).toBe(false);
    expect(p.summary).toContain('no net progress');
  });

  it('gains that outweigh losses are progress, and the first attempt compares against nothing', () => {
    const prev = attempt(1, { supportedCriteria: ['AC-1'] });
    expect(progressSince(prev, attempt(2, { supportedCriteria: ['AC-2', 'AC-3'] })).made_progress).toBe(true);
    expect(progressSince(null, attempt(1, { supportedCriteria: ['AC-1'] })).newly_supported_criteria).toEqual(['AC-1']);
  });
});

describe('nonProgress (scenario 6: repeated non-progress terminates)', () => {
  it('the same failure going round again ends the loop at the threshold', () => {
    const history = [attempt(1, { tokens: 1000 }), attempt(2, { tokens: 5000, diffLines: 40 }), attempt(3, { tokens: 20_000, diffLines: 300 })];
    const d = nonProgress(history, 2);
    expect(d).toMatchObject({ terminate: true, consecutiveNoProgress: 2, threshold: 2, fingerprint: 'fp-page', suggestedState: 'EXHAUSTED' });
    expect(d.reason).toContain('fp-page');
    expect(d.reason).toContain('more attempts, tokens or lines');
  });

  it('does not terminate below the threshold', () => {
    const d = nonProgress([attempt(1), attempt(2)], 2);
    expect(d).toMatchObject({ terminate: false, consecutiveNoProgress: 1, suggestedState: null });
    expect(d.reason).toBe('1 of 2 attempts without progress');
  });

  it('progress resets the streak, so a slow repair is not cut off', () => {
    const history = [attempt(1), attempt(2), attempt(3, { eliminatedHypotheses: ['hyp-1'] }), attempt(4, { eliminatedHypotheses: ['hyp-1'] })];
    const d = nonProgress(history, 2);
    expect(d.terminate).toBe(false);
    expect(d.consecutiveNoProgress).toBe(1);
  });

  it('an old burst of progress does not save a loop that has since stalled', () => {
    const history = [attempt(1), attempt(2, { supportedCriteria: ['AC-1'] }), attempt(3, { supportedCriteria: ['AC-1'] }), attempt(4, { supportedCriteria: ['AC-1'] })];
    expect(nonProgress(history, 2)).toMatchObject({ terminate: true, consecutiveNoProgress: 2 });
  });

  it('regressions count as non-progress', () => {
    const history = [attempt(1, { supportedCriteria: ['AC-1', 'AC-2'] }), attempt(2, { supportedCriteria: ['AC-1'] }), attempt(3, { supportedCriteria: [] })];
    expect(nonProgress(history, 2).terminate).toBe(true);
  });

  it('shorter histories and bad thresholds', () => {
    expect(nonProgress([], 2)).toMatchObject({ terminate: false, consecutiveNoProgress: 0 });
    expect(nonProgress([attempt(1)], 1).terminate).toBe(false);
    expect(() => nonProgress([attempt(1)], 0)).toThrow(/positive integer/);
    expect(() => nonProgress([attempt(1)], 1.5)).toThrow(/positive integer/);
  });

  it('names no fingerprint when the stalled attempts failed differently', () => {
    const d = nonProgress([attempt(1), attempt(2, { failureFingerprints: ['fp-a'] }), attempt(3, { failureFingerprints: ['fp-b'] })], 2);
    expect(d.terminate).toBe(true);
    expect(d.fingerprint).toBeNull();
  });

  it('the termination threshold is one past the repeated-failure threshold that called the Inquisition in', () => {
    expect(nonProgressThreshold(2)).toBe(3);
  });
});

describe('nonProgress names an attempt that changed nothing (P17)', () => {
  it('says the stalled attempts produced the same tree as an earlier attempt', () => {
    const history = [attempt(1, { treeHash: 'tree-a' }), attempt(2, { treeHash: 'tree-a' }), attempt(3, { treeHash: 'tree-a' })];
    const d = nonProgress(history, 2);
    expect(d.terminate).toBe(true);
    expect(d.reason).toContain('no measurable progress (same tree as attempt 1)');
  });
});
