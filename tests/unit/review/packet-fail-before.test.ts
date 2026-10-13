// The review packet's fail-before part (ADR 0014 and its 0.3.1 addendum), from the 0.3.0 retest:
// - advisory and off: the probe outcome is reported to the person and reaches no reviewer. An advisory packet carried a
//   Fail-before section, and the reviewer raised "the fail-before evidence only shows a load failure" as a high finding on
//   two rounds (python run orb-20261013-080355-6ac27f, demo ui run orb-20261013-080027-02f61e).
// - required: a compile, collection or import failure of a new symbol counts by policy and is not a finding. The packet
//   told the reviewer to report a load-only failure as a blocking high finding, which every test of a new function is, so
//   the run ended EXHAUSTED (python run orb-20261013-081148-e86c15).
// - required: the packet showed the tail of the probe log, passing suites and a summary, not the tests that failed
//   (demo ui reviews/1/packet.md lines 119-131).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReviewPacket, type ReviewPacketInput } from '../../../src/review/packet.ts';
import type { CriterionFailBefore, EvidenceReport } from '../../../src/evidence/types.ts';
import type { FailBeforeMode } from '../../../src/policy/types.ts';
import { contract, evidenceReport, snapshotOf } from './fixtures.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };

const LOG = 'evidence/1/fail-before/unit~1.log';

/** The retest's AC-4, verbatim, as in tests/unit/contract/draft-fail-before.test.ts. */
const RETEST_AC_4 = 'The new tests fail on the base revision (ImportError for round_price) and pass with the change; existing apply_discount tests still pass.';

/** The paragraph an advisory or off packet carries after the criteria, whatever they say. */
const PROMISE_PARAGRAPH = /Whether the new tests fail on the base revision is Orbit's to establish[^\n]*\n/;

/** A TAP log shaped like the demo ui probe: the failures come first, then a long run of passing suites and a summary. */
function tapLog(): string {
  const lines = [
    'TAP version 13',
    "# Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'src/views/reports-csv.ts' imported from tests/unit/csv.test.ts",
    '# Subtest: tests/unit/csv.test.ts',
    'not ok 1 - tests/unit/csv.test.ts',
    '  ---',
    "  error: 'test failed'",
    '  ...',
    '# Subtest: export route behaviour',
    '    not ok 1 - answers /reports.csv with 200',
    '      ---',
    "      error: 'Expected values to be strictly equal: 404 !== 200'",
    "      code: 'ERR_ASSERTION'",
    '      ...',
  ];
  for (let i = 0; i < 120; i++) lines.push(`ok ${i + 2} - existing suite ${i}`, '  ---', `  duration_ms: 0.${i}`, '  ...');
  lines.push('# tests 124', '# pass 122', '# fail 2', '[orbit] check=unit status=FAILED exit=1');
  return `${lines.join('\n')}\n`;
}

function failBefore(mode: FailBeforeMode, over: Partial<CriterionFailBefore> = {}): CriterionFailBefore {
  return {
    mode,
    outcome: 'failed-before',
    checks: [{ id: 'unit', outcome: 'failed-before', attempts: [{ status: 'FAILED', exit_code: 1, log: 'evidence/1/fail-before/unit.log' }, { status: 'FAILED', exit_code: 1, log: LOG }] }],
    probe_tree: 'c'.repeat(40),
    test_paths: { paths: ['tests/unit/csv.test.ts'], count: 1 },
    reason: 'unit failed on the base revision with the new tests (exit 1, 2 attempts)',
    ...over,
  };
}

describe.skipIf(!gitAvailable)('the review packet and fail-before', () => {
  let top: string;
  let repo: string;
  let base = '';
  let cand: { commitSha: string; treeHash: string };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  };

  beforeAll(() => {
    top = mkdtempSync(join(tmpdir(), 'orbit-packet-fb-'));
    repo = join(top, 'repo');
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    write('src/a.ts', 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    base = git('rev-parse', 'HEAD');
    write('src/a.ts', 'export const a = 2;\n');
    write('tests/unit/csv.test.ts', "import { a } from '../../src/a.ts';\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    cand = { commitSha: git('rev-parse', 'HEAD'), treeHash: git('rev-parse', 'HEAD^{tree}') };
  });
  afterAll(() => rmSync(top, { recursive: true, force: true }));

  function report(mode: FailBeforeMode, over: Partial<EvidenceReport> = {}): EvidenceReport {
    const fb = mode === 'off' ? failBefore('off', { outcome: 'not-run', checks: [], probe_tree: null, reason: 'verification.fail_before is off' }) : failBefore(mode);
    return evidenceReport(cand.treeHash, {
      acceptance_evidence: [
        { criterion_id: 'AC-1', status: 'supported', artifacts: ['unit.log'], fail_before: fb },
        { criterion_id: 'AC-2', status: 'supported', artifacts: ['unit.log'], fail_before: fb },
      ],
      unverified: [
        'No load test was run.',
        mode === 'off'
          ? 'fail-before: the probe was not run (verification.fail_before: off), so no new test was shown to fail on the base revision: AC-1, AC-2'
          : 'fail-before (advisory): the new tests of AC-2 pass on the base revision (unit passed on the base revision with the new tests)',
      ],
      ...over,
    });
  }

  function input(mode: FailBeforeMode, over: Partial<ReviewPacketInput> = {}): ReviewPacketInput {
    return {
      contract: contract(),
      snapshot: snapshotOf((c) => {
        c.verification.fail_before = mode;
      }),
      candidate: cand,
      baseRev: base,
      repoRoot: repo,
      evidenceReport: report(mode),
      ledger: [],
      questions: [],
      provider: 'codex',
      failBeforeLogs: new Map([[LOG, tapLog()]]),
      ...over,
    };
  }

  for (const mode of ['advisory', 'off'] as const) {
    it(`${mode}: the packet says nothing about the probe, so no reviewer can raise a finding on it`, async () => {
      const p = await buildReviewPacket(input(mode));
      expect(p.text).not.toContain('### Fail-before');
      expect(p.text).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(p.text).not.toContain(LOG);
      // Apart from the one paragraph on a criterion's promise of fail-before (next test), nothing names the probe.
      const rest = p.text.replace(PROMISE_PARAGRAPH, '');
      expect(rest).not.toBe(p.text);
      expect(rest).not.toMatch(/fail-before/i);
      expect(rest).not.toMatch(/fail_before/);
      expect(rest).not.toMatch(/base revision/);
      // The rest of what is not verified is still shown.
      expect(p.text).toContain('No load test was run.');
    });

    // The retest's AC-4, which stays in the contract now that the draft never removes a criterion. Under advisory the
    // packet showed it as "AC-4 (mandatory)" and "AC-4: supported", backed only by the candidate's passing log, with no
    // word that its promise is Orbit's to keep; the natural finding blocked as a claim the candidate cannot answer.
    it(`${mode}: a criterion that promises fail-before is not a finding against the candidate and does not withhold APPROVE`, async () => {
      const promising = contract({
        acceptance_criteria: [
          { id: 'AC-1', statement: 'round_price rounds half up to two decimals.', proof: ['test_round_price_half_up passes.'], mandatory: true },
          { id: 'AC-4', statement: RETEST_AC_4, proof: [], mandatory: true },
        ],
      });
      const ev = report(mode, {
        acceptance_evidence: [
          { criterion_id: 'AC-1', status: 'supported', artifacts: ['unit.log'] },
          { criterion_id: 'AC-4', status: 'supported', artifacts: ['unit.log'] },
        ],
      });
      const p = await buildReviewPacket(input(mode, { contract: promising, evidenceReport: ev }));
      expect(p.text).toContain('AC-4 (mandatory): The new tests fail on the base revision (ImportError for round_price)');
      expect(p.text).not.toContain('### Fail-before');
      const one = p.text.replace(/\s+/g, ' ');
      expect(one).toMatch(new RegExp(`Whether the new tests fail on the base revision is Orbit's to establish through verification\\.fail_before, which is ${mode} here: Orbit reports it to the person, not to you\\.`));
      expect(one).toMatch(/A criterion's promise of it is therefore not a finding against the candidate and does not withhold APPROVE: judge the criterion's other clauses as usual\./);
      expect(one).toMatch(/A finding that disputes only that promise uses the category evidence-classification\./);
      // It sits with the criteria, before the non-goals, where the reviewer reads them.
      expect(p.text.indexOf('A criterion\'s promise of it')).toBeLessThan(p.text.indexOf('### Non-goals'));
      expect(p.text.indexOf('A criterion\'s promise of it')).toBeGreaterThan(p.text.indexOf('### Acceptance criteria'));
    });
  }

  it('required: the criteria carry no such paragraph; the Fail-before section holds the probe\'s outcome', async () => {
    const p = await buildReviewPacket(input('required'));
    expect(p.text).not.toMatch(PROMISE_PARAGRAPH);
  });

  it('required: a compile, collection or import failure counts by policy and is not a finding; the reviewer reviews test quality only', async () => {
    const p = await buildReviewPacket(input('required'));
    expect(p.text).toContain('### Fail-before');
    expect(p.text).toMatch(/A compile, collection or import failure of a new symbol counts as fail-before by policy: it is not a finding\./);
    // The 0.3.0 instruction that drove the python run to EXHAUSTED is gone.
    expect(p.text).not.toMatch(/load-only failure/i);
    expect(p.text).not.toMatch(/finding of high severity/);
    expect(p.text).not.toMatch(/an assertion about AC-1, or only a load failure/);
    // The reviewer is told not to ask for evidence no check produces.
    expect(p.text).toMatch(/do not ask for mutant runs, stub implementations or a rerun of the probe/);
    // A dispute of the outcome is filed by structure, under its own category, never recognised by its wording.
    expect(p.text).toMatch(/A finding that disputes the outcome all the same uses the category evidence-classification and asks for nothing else; a finding about the new tests or the code uses its normal category\./);
    const questions = p.text.slice(p.text.indexOf('## Review questions'));
    expect(questions).toMatch(/tautolog/);
    expect(questions).toMatch(/cannot fail with any implementation/);
    expect(questions).not.toMatch(/load failure/);
  });

  it('required: the probe log excerpt shows the failing tests, not the tail of passing suites, and says it is check-wide', async () => {
    const p = await buildReviewPacket(input('required'));
    const section = p.text.slice(p.text.indexOf('### Fail-before'), p.text.indexOf('## Assumptions'));
    expect(section).toContain('not ok 1 - tests/unit/csv.test.ts');
    expect(section).toContain('ERR_MODULE_NOT_FOUND');
    expect(section).toContain('not ok 1 - answers /reports.csv with 200');
    expect(section).toContain('404 !== 200');
    expect(section).toMatch(/check-wide/);
    expect(section).not.toContain('existing suite 119');
    expect(section.length).toBeLessThan(6_000);
  });
});
