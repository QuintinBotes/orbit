import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineeringPracticesSection, buildReviewPacket, practiceReviewQuestions } from '../../../src/review/packet.ts';
import { ENGINEERING_PRACTICES } from '../../../src/contract/practices.ts';
import { practiceSelection } from '../contract/fixtures.ts';
import { contract, evidenceReport, snapshotOf } from './fixtures.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };

describe('review packet: engineering practices (S5.40)', () => {
  it('lists every practice with its decision and reason, marking omissions', () => {
    const c = contract({ practices: practiceSelection(['accessibility']) });
    const text = engineeringPracticesSection(c);
    for (const p of ENGINEERING_PRACTICES) expect(text).toContain(`- ${p} [`);
    expect(text).toContain('- accessibility [OMITTED]: ');
    expect(text).toContain('- behavior-tests [applicable]: covered by the planned tests');
  });

  it('says so when a contract has no selection or an incomplete one, rather than reading as "nothing needed"', () => {
    expect(engineeringPracticesSection(contract())).toBe('');
    expect(practiceReviewQuestions(contract())[0]).toContain('No practice selection is recorded');
    const partial = contract({ practices: practiceSelection().slice(0, 7) });
    expect(engineeringPracticesSection(partial)).toContain('- rollback-and-migration: NOT ACCOUNTED FOR');
  });

  it('asks the reviewer to reject an unjustified omission, naming the omitted practices', () => {
    const [q] = practiceReviewQuestions(contract({ practices: practiceSelection(['accessibility', 'performance-hotspots']) }));
    expect(q).toContain('performance-hotspots, accessibility');
    expect(q).toContain('Report a finding for every omission whose justification is unsound');
    expect(practiceReviewQuestions(contract({ practices: practiceSelection([]) }))).toHaveLength(1);
    expect(practiceReviewQuestions(contract())).toHaveLength(1);
    expect(practiceReviewQuestions(contract({ practices: practiceSelection().slice(0, 7) }))).toHaveLength(2);
  });

  describe.skipIf(!gitAvailable)('in a built packet', () => {
    let top: string;
    let repo: string;
    let base = '';
    let cand = '';
    let tree = '';
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
    const write = (rel: string, content: string) => {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), content);
    };

    beforeAll(() => {
      top = mkdtempSync(join(tmpdir(), 'orbit-packet-practices-'));
      repo = join(top, 'repo');
      mkdirSync(repo);
      git('init', '-q', '-b', 'main');
      write('src/export.ts', 'export const a = 1;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      base = git('rev-parse', 'HEAD');
      write('src/export.ts', 'export const a = 2;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'candidate');
      cand = git('rev-parse', 'HEAD');
      tree = git('rev-parse', 'HEAD^{tree}');
    });
    afterAll(() => rmSync(top, { recursive: true, force: true }));

    it('carries the selection and the omission question, ahead of the caller\'s questions', async () => {
      const packet = await buildReviewPacket({
        contract: contract({ practices: practiceSelection(['accessibility']) }),
        snapshot: snapshotOf(),
        candidate: { commitSha: cand, treeHash: tree },
        baseRev: base,
        repoRoot: repo,
        evidenceReport: evidenceReport(tree),
        ledger: [],
        questions: ['Does the export honour the tenant boundary?'],
        provider: 'codex',
      });
      expect(packet.text).toContain('## Engineering practices');
      expect(packet.text).toContain('- accessibility [OMITTED]: ');
      const questions = packet.text.slice(packet.text.indexOf('## Review questions'));
      expect(questions.indexOf('Is each omitted engineering practice (accessibility) really not needed')).toBeGreaterThan(0);
      expect(questions.indexOf('Is each omitted engineering practice')).toBeLessThan(questions.indexOf('Does the export honour the tenant boundary?'));
    });
  });
});
