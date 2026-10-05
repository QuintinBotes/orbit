import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { ingestSourceId } from '../../../src/knowledge/ingest.ts';
import type { EvalRunner } from '../../../src/knowledge/evals.ts';
import { makeLesson, ev } from '../knowledge/helpers.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (o?: Parameters<typeof makeLab>[0]) => {
  const l = makeLab(o);
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const CONFIG = (evalBudget: number) =>
  ['version: 1', 'mode: autonomous', 'isolation: {provider: none, allow_unisolated: true}', 'knowledge:', '  enabled: true', `  eval_budget_usd: ${evalBudget}`, ''].join('\n');

function writeConfig(l: Lab, text: string): void {
  mkdirSync(join(l.repo, '.orbit'), { recursive: true });
  writeFileSync(join(l.repo, '.orbit', 'config.yaml'), text);
}

function openStore(l: Lab): KnowledgeStore {
  return KnowledgeStore.open(join(l.repo, '.orbit', 'knowledge.sqlite'));
}

describe('orbit learn list, show and export', () => {
  it('has nothing to read before the first lesson exists', async () => {
    const l = lab();
    const r = await l.cli(['learn', 'list']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/no repository knowledge graph/);
  });

  it('lists, filters, searches and shows lessons with their evidence', async () => {
    const l = lab();
    mkdirSync(join(l.repo, '.orbit'), { recursive: true });
    const s = openStore(l);
    const a = makeLesson({ statement: 'Pin the clock in tests that format dates.', status: 'validated', evidence: [ev('r1'), ev('r2')] });
    const b = makeLesson({ statement: 'Name fixtures after the scenario they build.', status: 'candidate', kind: 'convention' });
    s.upsertLesson(a);
    s.upsertLesson(b);
    s.close();

    const all = JSON.parse((await l.cli(['learn', 'list', '--json'])).out) as { id: string; stats: { support: number } }[];
    expect(all.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    const validated = JSON.parse((await l.cli(['learn', 'list', '--status', 'validated', '--json'])).out) as { id: string }[];
    expect(validated.map((x) => x.id)).toEqual([a.id]);
    const found = JSON.parse((await l.cli(['learn', 'list', '--search', 'fixtures', '--json'])).out) as { id: string }[];
    expect(found.map((x) => x.id)).toEqual([b.id]);
    expect((await l.cli(['learn', 'list', '--status', 'nonsense'])).code).toBe(2);
    expect((await l.cli(['learn', 'list'])).out).toMatch(/ID\s+STATUS\s+KIND/);

    const show = await l.cli(['learn', 'show', a.id.slice(0, 12)]);
    expect(show.code, show.err).toBe(0);
    expect(show.out).toContain('Pin the clock in tests that format dates.');
    expect(show.out).toMatch(/evidence:\s+2 supporting run\(s\), 0 contradicting/);
    expect((await l.cli(['learn', 'show', 'no-such-lesson'])).code).toBe(3);
  });

  it('exports the graph as JSON-LD to stdout or a file', async () => {
    const l = lab();
    mkdirSync(join(l.repo, '.orbit'), { recursive: true });
    const s = openStore(l);
    s.upsertLesson(makeLesson());
    s.close();
    const out = await l.cli(['learn', 'export']);
    const doc = JSON.parse(out.out) as { '@context': unknown; '@graph': unknown[] };
    expect(doc['@context']).toBeDefined();
    expect(doc['@graph'].length).toBeGreaterThan(0);
    const file = join(l.base, 'lessons.jsonld');
    const w = await l.cli(['learn', 'export', '--out', file]);
    expect(w.code, w.err).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))['@graph']).toBeDefined();
  });
});

describe('orbit learn ingest', () => {
  const draft = (sourceId: string) => ({
    schema: 'orbit.lesson/1',
    kind: 'hazard',
    statement: 'Bound retries with exponential backoff and a maximum attempt count.',
    rationale: 'Unbounded retries turned a partial outage into a full one.',
    applicability: { languages: [], frameworks: [], paths: [], check_ids: [], fingerprints: [], roles: [], keywords: ['retries', 'backoff'] },
    verification: 'Retries in the changed code are bounded and use increasing delays.',
    evidence: [{ run_id: sourceId, artifact: sourceId, relation: 'supports' }],
    provenance: { source: 'ingest', uri: null, derived_from: [sourceId], generated_by: 'm', generated_at: '2026-10-03T08:00:00.000Z' },
    confidence: 'high',
    code_free: true,
    supersedes: null,
  });

  it('prints the redacted, fenced curator task without sending anything anywhere', async () => {
    const l = lab();
    writeConfig(l, CONFIG(0));
    writeFileSync(join(l.repo, 'postmortem.md'), 'We leaked token ghp_Q1w2E3r4T5Q1w2E3r4T5Q1w2E3r4T5Q1w2E3r4T5 in a log.\nRetries made it worse.\n');
    const r = await l.cli(['learn', 'ingest', 'postmortem.md', '--print-task']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('UNTRUSTED INGESTED FILE');
    expect(r.out).not.toContain('ghp_Q1w2E3r4T5');
    expect(r.out).toContain('Retries made it worse.');
  });

  it('accepts curator output as low-confidence candidates with no run evidence', async () => {
    const l = lab();
    writeConfig(l, CONFIG(0));
    const content = 'Retries amplified the outage.\n';
    writeFileSync(join(l.repo, 'notes.md'), content);
    const id = ingestSourceId({ kind: 'file', ref: 'notes.md', content });
    writeFileSync(join(l.base, 'curated.json'), JSON.stringify({ lessons: [draft(id)], discarded: [] }));
    const r = await l.cli(['learn', 'ingest', 'notes.md', '--curator-output', join(l.base, 'curated.json'), '--json']);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { created: string[]; rejected: unknown[]; source: { kind: string; ref: string } };
    expect(j.rejected).toEqual([]);
    expect(j.created).toHaveLength(1);
    expect(j.source).toEqual({ kind: 'file', ref: 'notes.md' });
    const s = openStore(l);
    const lesson = s.getLesson(j.created[0]!)!;
    s.close();
    expect(lesson).toMatchObject({ status: 'candidate', confidence: 'low', provenance: { source: 'ingest', uri: 'notes.md' } });
    expect(lesson.evidence).toEqual([]);
    // Ingesting the same material again merges instead of duplicating.
    const again = JSON.parse((await l.cli(['learn', 'ingest', 'notes.md', '--curator-output', join(l.base, 'curated.json'), '--json'])).out) as { created: string[]; merged: string[] };
    expect(again.created).toEqual([]);
    expect(again.merged).toHaveLength(1);
  });

  it('reads pasted text from standard input and refuses a missing file, a directory or an empty input', async () => {
    const l = lab();
    writeConfig(l, CONFIG(0));
    const ok = await l.cli(['learn', 'ingest', '-', '--label', 'standup notes', '--print-task'], {}, 'Cap retries.\n');
    expect(ok.out).toContain('UNTRUSTED INGESTED TEXT');
    expect((await l.cli(['learn', 'ingest', '-'], {}, '  \n')).code).toBe(2);
    expect((await l.cli(['learn', 'ingest', 'missing.md'])).code).toBe(3);
    expect((await l.cli(['learn', 'ingest', '.'])).code).toBe(4);
  });

  it('needs a curator budget to run a model, and learning switched on', async () => {
    const l = lab();
    writeConfig(l, ['version: 1', 'mode: autonomous', 'isolation: {provider: none, allow_unisolated: true}', 'knowledge:', '  curator_budget_usd: 0', ''].join('\n'));
    writeFileSync(join(l.repo, 'n.md'), 'x\n');
    const r = await l.cli(['learn', 'ingest', 'n.md']);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/curator_budget_usd is 0/);
    writeConfig(l, ['version: 1', 'mode: autonomous', 'isolation: {provider: none, allow_unisolated: true}', 'knowledge:', '  enabled: false', ''].join('\n'));
    const off = await l.cli(['learn', 'ingest', 'n.md']);
    expect(off.code).toBe(4);
    expect(off.err).toMatch(/knowledge.enabled is false/);
  });
});

describe('orbit learn overlays and eval', () => {
  function seed(l: Lab): void {
    writeConfig(l, CONFIG(1));
    l.newRun('one', 'orb-r1');
    l.db().run("UPDATE runs SET state = 'SUCCEEDED', contract_json = ?, base_revision = 'abc123' WHERE id = 'orb-r1'", JSON.stringify({ version: '1.0', required_check_ids: ['unit'] }));
    const s = openStore(l);
    for (const statement of ['Pin the clock in tests that format dates.', 'Prefer table-driven tests for every parser.']) s.upsertLesson(makeLesson({ statement, status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } }));
    s.close();
  }

  const winning: EvalRunner = {
    async runCase(_suite, c, overlay) {
      // The candidate does better than the base prompt on every case.
      return { case_id: c.id, verified: overlay !== null, attempts: overlay ? 1 : 2, cost_usd: 0.1, false_pass: false };
    },
  };

  it('explains that evaluation is off when no budget is configured', async () => {
    const l = lab();
    writeConfig(l, CONFIG(0));
    const r = await l.cli(['learn', 'eval', '--role', 'implementer']);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/eval_budget_usd is 0/);
  });

  it('says plainly when no replay runner is available instead of faking a result', async () => {
    const l = lab();
    seed(l);
    const r = await l.cli(['learn', 'eval', '--role', 'implementer']);
    expect(r.code).toBe(7);
    expect(r.err).toMatch(/no replay runner/);
    expect(r.err).toMatch(/--metrics/);
  });

  it('distills a candidate, replays it, and adopts it only when it improves without regression', async () => {
    const l = lab();
    seed(l);
    const r = await l.cli(['learn', 'eval', '--role', 'implementer', '--json'], { seams: { evalRunner: winning } });
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { overlay: { id: string; status: string; version: number; eval: { improved: boolean; cases: number } }; decision: { adopt: boolean } };
    expect(j.decision.adopt).toBe(true);
    expect(j.overlay).toMatchObject({ status: 'active', version: 1 });
    expect(j.overlay.eval).toMatchObject({ improved: true, cases: 1 });
    const list = await l.cli(['learn', 'overlays']);
    expect(list.out).toMatch(/implementer\s+v1\s+active/);
    const rolled = await l.cli(['learn', 'overlays', 'rollback', j.overlay.id, '--reason', 'live metrics regressed']);
    expect(rolled.code, rolled.err).toBe(0);
    expect(rolled.out).toMatch(/rolled back; the base prompt is in force again/);
    expect((await l.cli(['learn', 'overlays', '--status', 'rolled_back'])).out).toContain(j.overlay.id);
    expect((await l.cli(['learn', 'overlays', 'rollback'])).code).toBe(2);
  });

  it('does not adopt a candidate that regresses, and keeps its evaluation', async () => {
    const l = lab();
    seed(l);
    const worse: EvalRunner = { async runCase(_s, c, overlay) { return { case_id: c.id, verified: overlay === null, attempts: 1, cost_usd: 0.1, false_pass: false }; } };
    const r = await l.cli(['learn', 'eval', '--role', 'implementer', '--json'], { seams: { evalRunner: worse } });
    const j = JSON.parse(r.out) as { overlay: { status: string }; decision: { adopt: boolean; reason: string } };
    expect(j.decision.adopt).toBe(false);
    expect(j.overlay.status).toBe('rejected');
  });

  it('stops replaying when the evaluation budget is spent', async () => {
    const l = lab();
    seed(l);
    l.db().run("UPDATE runs SET created_at = created_at");
    for (const id of ['orb-r2', 'orb-r3']) {
      l.newRun(id, id);
      l.db().run("UPDATE runs SET state = 'SUCCEEDED', contract_json = ?, base_revision = 'abc123' WHERE id = ?", JSON.stringify({ version: '1.0', required_check_ids: ['unit'] }), id);
    }
    const pricey: EvalRunner = { async runCase(_s, c) { return { case_id: c.id, verified: true, attempts: 1, cost_usd: 5, false_pass: false }; } };
    const r = await l.cli(['learn', 'eval', '--role', 'implementer'], { seams: { evalRunner: pricey } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/evaluation budget of \$1\.00 is spent/);
  });

  it('evaluates again when the active overlay changed during the replay', async () => {
    const l = lab();
    seed(l);
    let calls = 0;
    const racing: EvalRunner = {
      async runCase(_s, c, overlay) {
        calls++;
        if (calls === 1) {
          // Another evaluation adopts a different overlay while this replay is running.
          const s = openStore(l);
          const { createCandidateOverlay, startEvaluation, completeEvaluation, distillOverlay } = await import('../../../src/knowledge/overlays.ts');
          const lessons = s.listLessons({ statuses: ['validated'] });
          const stats = s.statsMany(lessons.map((x) => x.id));
          const other = createCandidateOverlay(s, distillOverlay('implementer', lessons.map((lesson) => ({ lesson, stats: stats.get(lesson.id)! }))), 'repo');
          startEvaluation(s, other.id);
          const m = { verified_pass_rate: 0.5, mean_attempts: 2, mean_cost_usd: 1, false_pass_rate: 0 };
          completeEvaluation(s, other.id, { suite_id: 'x', cases: 1, baseline: m, candidate: { ...m, verified_pass_rate: 0.9 }, baseline_overlay_id: null });
          s.close();
        }
        return { case_id: c.id, verified: overlay !== null, attempts: 1, cost_usd: 0.01, false_pass: false };
      },
    };
    const r = await l.cli(['learn', 'eval', '--role', 'implementer', '--json'], { seams: { evalRunner: racing } });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/active overlay changed during the replay; evaluating again/);
    expect(calls).toBeGreaterThan(2);
  });

  it('records metrics measured elsewhere without needing a runner', async () => {
    const l = lab();
    seed(l);
    const m = { verified_pass_rate: 0.5, mean_attempts: 2, mean_cost_usd: 1, false_pass_rate: 0 };
    writeFileSync(join(l.base, 'm.json'), JSON.stringify({ cases: 8, baseline: m, candidate: { ...m, verified_pass_rate: 0.75 } }));
    const r = await l.cli(['learn', 'eval', '--role', 'implementer', '--metrics', join(l.base, 'm.json'), '--json']);
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as { decision: { adopt: boolean } }).decision.adopt).toBe(true);
    writeFileSync(join(l.base, 'bad.json'), '{}');
    expect((await l.cli(['learn', 'eval', '--role', 'implementer', '--metrics', join(l.base, 'bad.json')])).code).toBe(4);
  });

  it('needs a role or an overlay to evaluate', async () => {
    const l = lab();
    writeConfig(l, CONFIG(1));
    expect((await l.cli(['learn', 'eval'])).code).toBe(2);
    seed(l);
    expect((await l.cli(['learn', 'eval', '--role', 'reviewer'], { seams: { evalRunner: winning } })).code).toBe(3);
    expect((await l.cli(['learn', 'eval', '--overlay', 'ovl-none'], { seams: { evalRunner: winning } })).code).toBe(3);
  });
});
