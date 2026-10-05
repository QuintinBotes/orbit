import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRedactPatterns } from '../../../src/core/redact.ts';
import { buildFinalReport, writeFinalReport } from '../../../src/controller/report.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { recordDecision } from '../../../src/storage/decisions.ts';
import { dbFixture } from '../review/fixtures.ts';

// A shape no built-in rule knows: only the configured pattern can catch it.
const CUSTOM = 'acme_ledger_55Qz8xLm';
const BUILTIN = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

describe('final.json redaction (S3.28, G46)', () => {
  it('redacts every string of final.json, not only final.md', () => {
    applyRedactPatterns(['acme_ledger_[0-9A-Za-z]{8}']);
    const { db, clock, runDir } = dbFixture();
    mkdirSync(runDir, { recursive: true });
    db.run('UPDATE runs SET goal = ?, outcome_reason = ?, state = ? WHERE id = ?', `ship it with ${CUSTOM}`, `push refused with ${BUILTIN}`, 'BLOCKED', 'run-1');
    recordDecision(db, runDir, { id: 'dec-1', runId: 'run-1', kind: 'note', summary: `the log quoted ${CUSTOM}`, data: {} }, clock, { actor: 'controller' });

    const report = writeFinalReport(db, 'run-1', { runDir, clock });
    const json = readFileSync(join(runDir, 'final.json'), 'utf8');
    const md = readFileSync(join(runDir, 'final.md'), 'utf8');
    for (const text of [json, md, JSON.stringify(report)]) {
      expect(text).not.toContain(CUSTOM);
      expect(text).not.toContain(BUILTIN);
    }
    const parsed = JSON.parse(json) as { original_goal: string; outcome_reason: string; decisions: { summary: string }[] };
    expect(parsed.original_goal).toBe('ship it with [REDACTED:custom]');
    expect(parsed.outcome_reason).toContain('[REDACTED:');
    expect(parsed.decisions.map((d) => d.summary)).toEqual(['the log quoted [REDACTED:custom]']);
  });

  it('buildFinalReport (what `orbit report --json` prints for a live run) is redacted too, and keeps non-secret fields intact', () => {
    applyRedactPatterns(['acme_ledger_[0-9A-Za-z]{8}']);
    const { db, clock, runDir } = dbFixture();
    db.run('UPDATE runs SET goal = ? WHERE id = ?', `use ${CUSTOM}`, 'run-1');
    const report = buildFinalReport(db, getRun(db, 'run-1'), { runDir, clock });
    expect(JSON.stringify(report)).not.toContain(CUSTOM);
    expect(report.schema).toBe('orbit.final/1');
    expect(report.run_id).toBe('run-1');
    expect(report.budget?.tokens).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
  });
});
