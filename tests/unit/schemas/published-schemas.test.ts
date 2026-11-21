/**
 * Issue #178, FR-002: the run report, the scorecard and the spec check result have published, versioned JSON schemas.
 * Each document names its schema and version in `schema` (orbit.<name>/<n>); a change a reader would notice bumps n.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compileSchema } from '../../../src/core/schema.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { buildFinalReport, type FinalReport } from '../../../src/controller/report.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { makeLab, type Lab } from '../cli/lab.ts';
import { buildFullRun } from '../cli/timeline-fixture.ts';

const schemas = fileURLToPath(new URL('../../../schemas/', import.meta.url));
const SPEC = fileURLToPath(new URL('../../fixtures/specs/calc-mul.md', import.meta.url));
const PUBLISHED = { 'run-report.schema.json': 'orbit.final/1', 'scorecard.schema.json': 'orbit.scorecard/1', 'spec-check.schema.json': 'orbit.spec-check/1' } as const;
const load = (f: string) => JSON.parse(readFileSync(join(schemas, f), 'utf8')) as { $id: string; title: string; required: string[]; properties: { schema: { const: string } } };
const validator = (f: keyof typeof PUBLISHED) => compileSchema(join(schemas, f));

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

describe('published, versioned schemas (issue #178, FR-002)', () => {
  it.each(Object.entries(PUBLISHED))('%s has a stable $id and requires the document to name version %s', (file, version) => {
    const s = load(file);
    expect(s.$id).toBe(`https://github.com/QuintinBotes/orbit/schemas/${file}`);
    expect(s.title).toContain(`(${version})`);
    expect(s.properties.schema).toEqual({ const: version });
    expect(s.required).toContain('schema');
  });

  it('the run report schema lists exactly the fields of FinalReport, plus interim', () => {
    // tsc fails this object when FinalReport gains or loses a field, so the schema cannot drift unnoticed.
    const fields: Record<keyof FinalReport, true> = {
      schema: true, run_id: true, outcome: true, outcome_reason: true, failure_class: true, failure_secondary: true, orbit_version: true, mode: true, original_goal: true, objective: true,
      criteria: true, checks: true, evidence: true, reviews: true, review_findings: true, reviewer: true, no_standing_review: true, decisions: true, assumptions: true, practices: true, proof: true,
      repairs: true, worker_plugins: true, revision: true, budget: true, unverified: true, residual_risks: true, worktrees: true, verified_candidate: true, next_action: true, generated_at: true,
    };
    expect(Object.keys(load('run-report.schema.json').properties).sort()).toEqual([...Object.keys(fields), 'interim'].sort());
  });

  it('the run report Orbit builds for a run is valid, and one with an unknown field or version is not', () => {
    const l = makeLab();
    labs.push(l);
    const fx = buildFullRun(l);
    const report = buildFinalReport(l.db(), getRun(l.db(), fx.runId), { runDir: fx.runDir, clock: systemClock });
    const validate = validator('run-report.schema.json');
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...report, interim: true })).toBe(true);
    expect(validate({ ...report, schema: 'orbit.final/2' })).toBe(false);
    expect(validate({ ...report, surprise: 1 })).toBe(false);
  });

  it('the spec check result, passed or failed, is valid and names its version', async () => {
    const l = makeLab();
    labs.push(l);
    const validate = validator('spec-check.schema.json');
    const ok = await l.cli(['spec', 'check', SPEC, '--json']);
    expect(ok.code, ok.err).toBe(0);
    const passed = JSON.parse(ok.out) as Record<string, unknown>;
    expect(passed.schema).toBe('orbit.spec-check/1');
    expect(validate(passed), JSON.stringify(validate.errors)).toBe(true);
    const bad = join(dirname(l.repo), 'bad.md');
    writeFileSync(bad, 'Make it better.\n');
    const failed = await l.cli(['spec', 'check', bad, '--json']);
    expect(failed.code).toBe(4);
    const result = JSON.parse(failed.out) as { ok: boolean; problems: string[] };
    expect(result.ok).toBe(false);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });

  it('a scorecard (issue #172) is valid with its version, tier, headline false-done rate and per-scenario results', () => {
    const validate = validator('scorecard.schema.json');
    const card = {
      schema: 'orbit.scorecard/1',
      orbit_version: '0.4.0',
      tier: 'lab',
      generated_at: '2026-11-20T12:00:00Z',
      without: [],
      headline: { runs: 2, passed: 1, invalid: 0, pass_rate: 0.5, false_done_rate: 0, cost_per_accepted_usd: 0.42 },
      scenarios: [
        { id: 'issue-138-init-documented-commands', results: [{ outcome: 'pass', failure_class: null, attempts: 1, spend_usd: 0.42, spend_simulated: true, duration_ms: 1200, false_done: null }] },
        { id: 'issue-144-verified-candidate', results: [{ outcome: 'fail', failure_class: 'budget', attempts: 5, spend_usd: null, spend_simulated: true, duration_ms: null, false_done: null }] },
      ],
    };
    expect(validate(card), JSON.stringify(validate.errors)).toBe(true);
    const done = { outcome: 'pass', failure_class: null, attempts: 1, spend_usd: 1, spend_simulated: false, duration_ms: 1, false_done: { found_by: 'hidden-check', link: 'checks/hidden-1.log' } };
    expect(validate({ ...card, tier: 'live', scenarios: [{ id: 'goal-1', results: [done, done, done] }] })).toBe(true);
    const { false_done_rate: _drop, ...noRate } = card.headline;
    expect(validate({ ...card, headline: noRate })).toBe(false);
    expect(validate({ ...card, tier: 'bench' })).toBe(false);
    expect(validate({ ...card, scenarios: [{ id: 'x', results: [{ ...done, outcome: 'maybe' }] }] })).toBe(false);
  });
});
