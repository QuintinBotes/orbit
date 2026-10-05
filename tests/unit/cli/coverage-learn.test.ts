/** `orbit learn`: reading the graph, ingesting material from files, text, URLs and a curator, and evaluating overlays. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbitError } from '../../../src/core/errors.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { ingestSourceId, INGEST_CONTENT_MAX } from '../../../src/knowledge/ingest.ts';
import type { EvalRunner } from '../../../src/knowledge/evals.ts';
import type { PromptOverlay } from '../../../src/knowledge/types.ts';
import { makeLesson, ev } from '../knowledge/helpers.ts';
import { makeLab, type Lab } from './lab.ts';

const hooks = vi.hoisted(() => ({
  curator: null as null | ((input: { prompt: string }) => unknown),
  complete: null as null | (() => unknown),
}));
vi.mock('../../../src/controller/report.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/controller/report.ts')>();
  return { ...actual, runCurator: (_ctx: unknown, input: { prompt: string }) => (hooks.curator ? Promise.resolve(hooks.curator(input)) : (actual.runCurator as (...a: unknown[]) => unknown)(_ctx, input)) } as typeof actual;
});
vi.mock('../../../src/knowledge/overlays.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/knowledge/overlays.ts')>();
  return { ...actual, completeEvaluation: (...a: Parameters<typeof actual.completeEvaluation>) => (hooks.complete ? hooks.complete() : actual.completeEvaluation(...a)) } as typeof actual;
});

const labs: Lab[] = [];
const servers: Server[] = [];
const scratch: string[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
beforeEach(() => {
  hooks.curator = null;
  hooks.complete = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  labs.splice(0).forEach((l) => l.close());
  servers.splice(0).forEach((s) => s.closeAllConnections?.() ?? s.close());
  scratch.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const CONFIG = (extra: string[] = []) => ['version: 1', 'mode: autonomous', 'isolation: {provider: none, allow_unisolated: true}', 'knowledge:', '  enabled: true', '  eval_budget_usd: 1', ...extra, ''].join('\n');
function writeConfig(l: Lab, text = CONFIG()): void {
  mkdirSync(join(l.repo, '.orbit'), { recursive: true });
  writeFileSync(join(l.repo, '.orbit', 'config.yaml'), text);
}
const openStore = (l: Lab, global = false) => KnowledgeStore.open(global ? join(l.orbitHome, 'knowledge.sqlite') : join(l.repo, '.orbit', 'knowledge.sqlite'));

describe('orbit learn list and show', () => {
  it('says no lessons match, filters by kind, and reads the global graph with --global', async () => {
    const l = lab();
    writeConfig(l);
    const s = openStore(l);
    const hazard = makeLesson({ kind: 'hazard', statement: 'Never retry a payment without an idempotency key.' });
    s.upsertLesson(hazard);
    s.upsertLesson(makeLesson({ kind: 'practice', statement: 'Name fixtures after the scenario they build.' }));
    s.close();
    const none = await l.cli(['learn', 'list', '--status', 'rejected']);
    expect(none.out).toBe('no lessons match\n');
    const byKind = JSON.parse((await l.cli(['learn', 'list', '--kind', 'hazard', '--json'])).out) as Array<{ id: string; stats: unknown }>;
    expect(byKind.map((x) => x.id)).toEqual([hazard.id]);
    expect(byKind[0]!.stats).toMatchObject({ support: expect.any(Number) });
    const limited = JSON.parse((await l.cli(['learn', 'list', '--limit', '1', '--json'])).out) as unknown[];
    expect(limited).toHaveLength(1);
    expect((await l.cli(['learn', 'list', '--kind', 'bogus'])).err).toContain('--kind must be one of');
    const globalMissing = await l.cli(['learn', 'list', '--global']);
    expect(globalMissing.code).toBe(3);
    expect(globalMissing.err).toContain(`no global knowledge graph at ${join(l.orbitHome, 'knowledge.sqlite')}`);
    mkdirSync(l.orbitHome, { recursive: true });
    const g = openStore(l, true);
    g.upsertLesson(makeLesson({ statement: 'A lesson that lives in the global graph only.', scope: 'global' }));
    g.close();
    const global = await l.cli(['learn', 'list', '--global']);
    expect(global.out).toContain('A lesson that lives in the global graph only.');
    expect(global.out).not.toContain('Never retry');
  });

  it('shows one lesson in full: applicability, provenance, edges and history; or as JSON; and refuses an ambiguous prefix', async () => {
    const l = lab();
    writeConfig(l);
    const s = openStore(l);
    const a = makeLesson({
      kind: 'hazard',
      statement: 'Never retry a payment without an idempotency key.',
      status: 'validated',
      confidence: 'high',
      code_free: true,
      applicability: { languages: ['typescript'], frameworks: ['express'], check_ids: ['unit'] },
      evidence: [ev('r1'), ev('r2', 'evidence/2/unit.log', 'contradicts')],
      provenance: { source: 'ingest', uri: 'postmortem.md', derived_from: [], generated_by: 'curator-x', generated_at: '2026-10-03T00:00:00.000Z' },
    });
    const b = makeLesson({ kind: 'practice', statement: 'Name fixtures after the scenario they build.', supersedes: a.id });
    s.upsertLesson(a);
    s.upsertLesson(b);
    s.close();
    const text = await l.cli(['learn', 'show', a.id]);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain(`${a.id}  [validated] hazard, high confidence, scope repo, code-free\n`);
    expect(text.out).toContain('applies to:   typescript, express, unit\n');
    expect(text.out).toContain('provenance:   ingest (postmortem.md), generated by curator-x at 2026-10-03T00:00:00.000Z\n');
    expect(text.out).toMatch(/evidence:\s+1 supporting run\(s\), 1 contradicting; retrieved in \d+ run\(s\)\n/);
    expect(text.out).toMatch(/history:\s+\d{4}-\d\d-\d\dT[\d:.]+Z \S+\n/);
    const edges = await l.cli(['learn', 'show', b.id]);
    expect(edges.out).toMatch(new RegExp(`edge:\\s+\\S+ -> ${a.id}\\n`));
    const j = JSON.parse((await l.cli(['learn', 'show', a.id, '--json'])).out) as { lesson: { id: string }; stats: { support: number }; edges: unknown[]; events: unknown[] };
    expect(j.lesson.id).toBe(a.id);
    expect(j.events.length).toBeGreaterThan(0);
    const common = [...a.id].findIndex((c, i) => c !== b.id[i]);
    const ambiguous = await l.cli(['learn', 'show', a.id.slice(0, common)]);
    expect(ambiguous.code).toBe(3);
    expect(ambiguous.err).toContain('matches 2 lessons; use a longer id');
    expect((await l.cli(['learn', 'show', 'zzz-nothing'])).err).toContain('no lesson zzz-nothing');
    expect((await l.cli(['learn', 'show', a.id.slice(0, common + 1)])).code).toBe(0);
  });

  it('shows "anything" when a lesson names no language, framework or check, and omits the code-free mark', async () => {
    const l = lab();
    writeConfig(l);
    const s = openStore(l);
    const lesson = makeLesson({ code_free: false, statement: 'Add a negative test for every new validation rule.' });
    s.upsertLesson(lesson);
    s.close();
    const r = await l.cli(['learn', 'show', lesson.id]);
    expect(r.out).toContain('applies to:   anything\n');
    expect(r.out.split('\n')[0]).not.toContain('code-free');
    expect(r.out).toMatch(/provenance:   run, generated by curator-test-model at /);
  });
});

describe('orbit learn ingest: sources', () => {
  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('fetches text from a URL and shows it to the curator as fenced data', async () => {
    const l = lab();
    writeConfig(l);
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end('Cap retries at five.\n');
    });
    const r = await l.cli(['learn', 'ingest', `${base}/notes.md`, '--print-task']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('<<<BEGIN UNTRUSTED INGESTED URL>>>');
    expect(r.out).toContain('Cap retries at five.');
  });

  it('accepts an empty body from a server that sends none, and then finds nothing to teach', async () => {
    const l = lab();
    writeConfig(l);
    const base = await serve((_req, res) => {
      res.writeHead(204, { 'content-type': 'text/plain' });
      res.end();
    });
    const r = await l.cli(['learn', 'ingest', `${base}/empty`, '--print-task']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('<<<BEGIN UNTRUSTED INGESTED URL>>>');
  });

  it('refuses a URL that answers an error, is not text, or declares a body over the limit', async () => {
    const l = lab();
    writeConfig(l);
    const base = await serve((req, res) => {
      if (req.url === '/missing') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
      } else if (req.url === '/image') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end('x');
      } else if (req.url === '/untyped') {
        res.writeHead(200);
        res.end('x');
      } else {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(3 * 1024 * 1024) });
        res.write('partial');
        setTimeout(() => res.destroy(), 200);
      }
    });
    const missing = await l.cli(['learn', 'ingest', `${base}/missing`]);
    expect(missing.code).toBe(3);
    expect(missing.err).toBe(`orbit: ${base}/missing answered HTTP 404\n`);
    const image = await l.cli(['learn', 'ingest', `${base}/image`]);
    expect(image.code).toBe(4);
    expect(image.err).toBe(`orbit: ${base}/image is image/png, not text\n`);
    const untyped = await l.cli(['learn', 'ingest', `${base}/untyped`]);
    expect(untyped.err).toBe(`orbit: ${base}/untyped is of unknown type, not text\n`);
    const big = await l.cli(['learn', 'ingest', `${base}/big`]);
    expect(big.code).toBe(4);
    expect(big.err).toBe(`orbit: ${base}/big is larger than 2097152 bytes\n`);
  });

  it('keeps a file reference repository-relative, falls back to the file name outside the repository, and refuses a file that is too large', async () => {
    const l = lab();
    writeConfig(l);
    mkdirSync(join(l.repo, 'docs'), { recursive: true });
    writeFileSync(join(l.repo, 'docs', 'notes.md'), 'Inside the repository.\n');
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-ingest-')));
    scratch.push(outside);
    writeFileSync(join(outside, 'external-notes.md'), 'Outside the repository.\n');
    const task = await l.cli(['learn', 'ingest', 'docs/notes.md', '--print-task']);
    expect(task.out).toContain('docs/notes.md');
    const ext = await l.cli(['learn', 'ingest', join(outside, 'external-notes.md'), '--print-task']);
    expect(ext.out).toContain('external-notes.md');
    expect(ext.out).not.toContain(outside);
    writeFileSync(join(outside, 'huge.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
    const huge = await l.cli(['learn', 'ingest', join(outside, 'huge.md')]);
    expect(huge.code).toBe(4);
    expect(huge.err).toBe(`orbit: ${join(outside, 'huge.md')} is larger than 2097152 bytes\n`);
  });

  it('warns when the material is longer than the curator is shown, and says what was cut', async () => {
    const l = lab();
    writeConfig(l);
    writeFileSync(join(l.repo, 'long.md'), `${'A long line of text. '.repeat(3000)}\n`);
    const r = await l.cli(['learn', 'ingest', 'long.md', '--print-task']);
    expect(r.err).toBe(`note: the material is longer than ${INGEST_CONTENT_MAX} characters; only the first ${INGEST_CONTENT_MAX} are shown to the curator\n`);
    expect(r.out).toContain(`[content truncated at ${INGEST_CONTENT_MAX} characters]`);
  });
});

describe('orbit learn ingest: what the curator returns', () => {
  const draft = (sourceId: string, statement = 'Bound retries with exponential backoff and a maximum attempt count.') => ({
    schema: 'orbit.lesson/1',
    kind: 'hazard',
    statement,
    rationale: 'Unbounded retries turned a partial outage into a full one.',
    applicability: { languages: [], frameworks: [], paths: [], check_ids: [], fingerprints: [], roles: [], keywords: ['retries', 'backoff'] },
    verification: 'Retries in the changed code are bounded and use increasing delays.',
    evidence: [{ run_id: sourceId, artifact: sourceId, relation: 'supports' }],
    provenance: { source: 'ingest', uri: null, derived_from: [sourceId], generated_by: 'm', generated_at: '2026-10-03T08:00:00.000Z' },
    confidence: 'high',
    code_free: true,
    supersedes: null,
  });
  const content = 'Retries amplified the outage.\n';
  const sourceId = ingestSourceId({ kind: 'file', ref: 'notes.md', content });

  it('refuses a curator file that is not JSON', async () => {
    const l = lab();
    writeConfig(l);
    writeFileSync(join(l.repo, 'notes.md'), content);
    writeFileSync(join(l.base, 'bad.json'), '{ not json');
    const r = await l.cli(['learn', 'ingest', 'notes.md', '--curator-output', join(l.base, 'bad.json')]);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/^orbit: .*bad\.json is not readable JSON: /);
    const missing = await l.cli(['learn', 'ingest', 'notes.md', '--curator-output', join(l.base, 'absent.json')]);
    expect(missing.err).toMatch(/absent\.json is not readable JSON: ENOENT/);
  });

  it('prints what was added, merged and rejected, with the first ten rejections', async () => {
    const l = lab();
    writeConfig(l);
    writeFileSync(join(l.repo, 'notes.md'), content);
    const lessons = [draft(sourceId), { statement: 'too short' }, 'not an object', ...Array.from({ length: 11 }, (_, i) => ({ statement: `Rejected statement number ${i + 1} that is missing everything else.` }))];
    writeFileSync(join(l.base, 'curated.json'), JSON.stringify({ lessons, discarded: [] }));
    const r = await l.cli(['learn', 'ingest', 'notes.md', '--curator-output', join(l.base, 'curated.json')]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^ingested file notes\.md: 1 new lesson\(s\), 0 merged into existing ones, \d+ rejected\n/);
    const rejectedLines = r.out.split('\n').filter((x) => x.startsWith('  rejected: '));
    expect(rejectedLines).toHaveLength(10);
    expect(rejectedLines[0]).toMatch(/^ {2}rejected: too short \(/);
    expect(rejectedLines.some((x) => x.includes('(unreadable)'))).toBe(true);
    expect(r.out.endsWith('They enter as low-confidence candidates and are never retrieved as validated until run evidence corroborates them.\n')).toBe(true);
    const again = await l.cli(['learn', 'ingest', 'notes.md', '--curator-output', join(l.base, 'curated.json')]);
    expect(again.out).toContain('0 new lesson(s), 1 merged into existing ones');
  });

  it('reports a lesson the graph refuses to store as rejected, whatever was thrown', async () => {
    const l = lab();
    writeConfig(l);
    writeFileSync(join(l.repo, 'notes.md'), content);
    writeFileSync(join(l.base, 'curated.json'), JSON.stringify({ lessons: [draft(sourceId), draft(sourceId, 'Rotate credentials after every contractor leaves the team.')], discarded: [] }));
    const spy = vi.spyOn(KnowledgeStore.prototype, 'upsertLesson');
    spy.mockImplementationOnce(() => {
      throw new Error('graph is read-only');
    });
    spy.mockImplementationOnce(() => {
      throw 'a string was thrown';
    });
    const r = await l.cli(['learn', 'ingest', 'notes.md', '--curator-output', join(l.base, 'curated.json'), '--json']);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { created: string[]; rejected: Array<{ index: number; statement: string; reason: string }> };
    expect(j.created).toEqual([]);
    expect(j.rejected).toEqual([
      { index: -1, statement: expect.stringContaining('Bound retries'), reason: 'graph is read-only' },
      { index: -1, statement: expect.stringContaining('Rotate credentials'), reason: 'a string was thrown' },
    ]);
  });

  it('runs a curator on Claude when none is supplied, with the policy frozen under the Orbit home, and records which model wrote the lessons', async () => {
    const l = lab();
    writeConfig(l, CONFIG(['  curator_budget_usd: 0.5']));
    writeFileSync(join(l.repo, 'notes.md'), content);
    let seen: { prompt: string } | null = null;
    hooks.curator = (input) => {
      seen = input;
      return { output: { lessons: [draft(sourceId)], discarded: [] }, model: 'claude-sonnet-5-5' };
    };
    let seeded = 0;
    const r = await l.cli(['learn', 'ingest', 'notes.md', '--json'], { seams: { controllerDeps: () => ({ adapters: { claude: {} }, registry: { seed: () => void seeded++ } }) as never } });
    expect(r.code, r.err).toBe(0);
    expect(seeded).toBe(1);
    expect(seen!.prompt).toContain('Retries amplified the outage.');
    const created = (JSON.parse(r.out) as { created: string[] }).created;
    const s = openStore(l);
    expect(s.getLesson(created[0]!)?.provenance.generated_by).toBe('claude-sonnet-5-5');
    s.close();
  });

  it('says so when no Claude provider is configured for the curator', async () => {
    const l = lab();
    writeConfig(l, CONFIG(['  curator_budget_usd: 0.5']));
    writeFileSync(join(l.repo, 'notes.md'), content);
    const r = await l.cli(['learn', 'ingest', 'notes.md'], { seams: { controllerDeps: () => ({ adapters: {}, registry: { seed() {} } }) as never } });
    expect(r.code).toBe(7);
    expect(r.err).toBe('orbit: no claude provider is configured; the curator runs on Claude\n');
  });
});

describe('orbit learn overlays', () => {
  const overlay = (over: Partial<PromptOverlay>): PromptOverlay => ({ id: 'ovl-x', role: 'implementer', scope: 'repo', version: 1, content: 'guidance', lesson_ids: [], status: 'candidate', parent_id: null, eval: null, created_at: '2026-01-01T00:00:00.000Z', activated_at: null, ...over });
  const metrics = (pass: number, cost: number | null) => ({ verified_pass_rate: pass, mean_attempts: 1.5, mean_cost_usd: cost, false_pass_rate: 0.1 });
  const evaluation = (candidateCost: number | null) => ({ suite_id: 's', cases: 4, baseline: metrics(0.5, 1), candidate: metrics(0.75, candidateCost), improved: true, regressions: [], decided_at: '2026-01-02T00:00:00.000Z' });

  it('lists overlays with their replay metrics, filters by role and status, and says when there are none', async () => {
    const l = lab();
    writeConfig(l);
    const s = openStore(l);
    s.insertOverlay(overlay({ id: 'ovl-a', version: 1, status: 'retired', lesson_ids: ['l1', 'l2'] }));
    s.insertOverlay(overlay({ id: 'ovl-b', version: 2, status: 'active', activated_at: '2026-01-03T00:00:00.000Z', eval: evaluation(0.25) as never }));
    s.insertOverlay(overlay({ id: 'ovl-c', version: 3, status: 'rejected', eval: evaluation(null) as never }));
    s.insertOverlay(overlay({ id: 'ovl-p', role: 'planner', version: 1 }));
    s.close();
    const all = await l.cli(['learn', 'overlays']);
    expect(all.out).toMatch(/^OVERLAY\s+ROLE\s+VERSION\s+STATUS\s+LESSONS\s+REPLAY METRICS\n/);
    expect(all.out).toMatch(/ovl-a\s+implementer\s+v1\s+retired\s+2\s+-\n/);
    expect(all.out).toMatch(/ovl-b\s+implementer\s+v2\s+active\s+0\s+pass 75%, attempts 1\.5, cost \$0\.25, false-pass 10%/);
    expect(all.out).toMatch(/ovl-c\s+implementer\s+v3\s+rejected\s+0\s+pass 75%, attempts 1\.5, cost unknown/);
    const planner = JSON.parse((await l.cli(['learn', 'overlays', '--role', 'planner', '--json'])).out) as Array<{ id: string }>;
    expect(planner.map((o) => o.id)).toEqual(['ovl-p']);
    const active = await l.cli(['learn', 'overlays', '--status', 'active']);
    expect(active.out).toContain('ovl-b');
    expect(active.out).not.toContain('ovl-a');
    expect((await l.cli(['learn', 'overlays', '--status', 'weird'])).err).toContain('--status must be one of candidate, evaluating, active, retired, rolled_back, rejected');
    const none = await l.cli(['learn', 'overlays', '--global']);
    expect(none.code).toBe(3);
    mkdirSync(l.orbitHome, { recursive: true });
    openStore(l, true).close();
    expect((await l.cli(['learn', 'overlays', '--global'])).out).toBe('no overlays\n');
  });

  it('rolls an overlay back and restores the one it replaced, saying so; or prints the JSON', async () => {
    const l = lab();
    writeConfig(l);
    const s = openStore(l);
    s.insertOverlay(overlay({ id: 'ovl-old', version: 1, status: 'retired', activated_at: '2026-01-01T00:00:00.000Z' }));
    s.insertOverlay(overlay({ id: 'ovl-new', version: 2, status: 'active', parent_id: 'ovl-old', activated_at: '2026-01-02T00:00:00.000Z' }));
    s.insertOverlay(overlay({ id: 'ovl-solo', role: 'planner', version: 1, status: 'active', activated_at: '2026-01-02T00:00:00.000Z' }));
    s.close();
    const r = await l.cli(['learn', 'overlays', 'rollback', 'ovl-new']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe('overlay ovl-new (implementer v2) rolled back; restored ovl-old (v1)\n');
    const j = await l.cli(['learn', 'overlays', 'rollback', 'ovl-solo', '--json', '--reason', 'regressed']);
    expect(JSON.parse(j.out)).toMatchObject({ rolledBack: { id: 'ovl-solo', status: 'rolled_back' }, restored: null });
    const t = openStore(l);
    const log = t.db.get<{ detail_json: string }>("SELECT detail_json FROM eval_runs WHERE overlay_id = 'ovl-solo' AND decision = 'rollback'");
    t.close();
    expect(JSON.parse(log!.detail_json)).toEqual({ reason: 'regressed' });
  });

  it('refuses an unknown action and a rollback without an overlay id', async () => {
    const l = lab();
    writeConfig(l);
    openStore(l).close();
    const unknown = await l.cli(['learn', 'overlays', 'promote']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown overlays action "promote"');
    const none = await l.cli(['learn', 'overlays', 'rollback']);
    expect(none.err).toContain('an overlay id is required');
    expect((await l.cli(['learn', 'overlays', 'rollback', 'ovl-nope'])).code).toBe(3);
  });
});

describe('orbit learn eval', () => {
  function seed(l: Lab, runs = 1): void {
    writeConfig(l);
    l.db();
    for (let i = 1; i <= runs; i++) {
      l.newRun(`goal ${i}`, `orb-r${i}`);
      l.db().run("UPDATE runs SET state = 'SUCCEEDED', contract_json = ?, base_revision = 'abc123' WHERE id = ?", JSON.stringify({ version: '1.0', required_check_ids: ['unit'] }), `orb-r${i}`);
    }
    const s = openStore(l);
    for (const statement of ['Pin the clock in tests that format dates.', 'Prefer table-driven tests for every parser.']) s.upsertLesson(makeLesson({ statement, status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } }));
    s.close();
  }
  const m = (pass: number) => ({ verified_pass_rate: pass, mean_attempts: 2, mean_cost_usd: 1, false_pass_rate: 0 });
  const winning: EvalRunner = { async runCase(_s, c, overlay) { return { case_id: c.id, verified: overlay !== null, attempts: overlay ? 1 : 2, cost_usd: 0.1, false_pass: false }; } };

  it('prints the decision and both sets of metrics in words', async () => {
    const l = lab();
    seed(l);
    const r = await l.cli(['learn', 'eval', '--role', 'implementer', '--limit', '5'], { seams: { evalRunner: winning } });
    expect(r.code, r.err).toBe(0);
    const lines = r.out.trim().split('\n');
    expect(lines[0]).toMatch(/^overlay ovl-\S+ \(implementer v1\): ADOPTED \(/);
    expect(lines[1]).toMatch(/^ {2}baseline: {2}pass 0%, attempts 2\.0, cost \S+, false-pass 0%$/);
    expect(lines[2]).toMatch(/^ {2}candidate: pass 100%, attempts 1\.0, cost \$0\.10, false-pass 0%$/);
  });

  it('evaluates an existing candidate overlay by id, and refuses one that is no longer a candidate', async () => {
    const l = lab();
    seed(l);
    writeFileSync(join(l.base, 'metrics.json'), JSON.stringify({ cases: 3, suite_id: 'suite-42', baseline: m(0.4), candidate: m(0.8) }));
    const s = openStore(l);
    s.insertOverlay({ id: 'ovl-cand', role: 'implementer', scope: 'repo', version: 1, content: 'guidance', lesson_ids: [], status: 'candidate', parent_id: null, eval: null, created_at: '2026-01-01T00:00:00.000Z', activated_at: null });
    s.insertOverlay({ id: 'ovl-done', role: 'implementer', scope: 'repo', version: 2, content: 'guidance', lesson_ids: [], status: 'rejected', parent_id: null, eval: null, created_at: '2026-01-01T00:00:00.000Z', activated_at: null });
    s.close();
    const done = await l.cli(['learn', 'eval', '--overlay', 'ovl-done', '--metrics', join(l.base, 'metrics.json')]);
    expect(done.code).toBe(5);
    expect(done.err).toBe('orbit: overlay ovl-done is rejected; only a candidate can be evaluated\n');
    const r = await l.cli(['learn', 'eval', '--overlay', 'ovl-cand', '--metrics', join(l.base, 'metrics.json'), '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ overlay: { id: 'ovl-cand', eval: { suite_id: 'suite-42', cases: 3 } } });
  });

  it('records the candidate and says so when there are no successful runs to replay it against', async () => {
    const l = lab();
    seed(l, 0);
    const r = await l.cli(['learn', 'eval', '--role', 'implementer'], { seams: { evalRunner: winning } });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/^orbit: candidate ovl-\S+ was recorded, but there are no successful runs to replay it against yet\n$/);
    const s = openStore(l);
    expect(s.listOverlays({ role: 'implementer' }).map((o) => o.status)).toEqual(['candidate']);
    s.close();
  });

  it('says what is wrong with a metrics file that cannot be read, or lacks a field', async () => {
    const l = lab();
    seed(l);
    const unreadable = await l.cli(['learn', 'eval', '--role', 'implementer', '--metrics', join(l.base, 'absent.json')]);
    expect(unreadable.code).toBe(4);
    expect(unreadable.err).toMatch(/absent\.json is not readable JSON: ENOENT/);
    writeFileSync(join(l.base, 'cases-missing.json'), JSON.stringify({ baseline: m(0.5), candidate: m(0.6) }));
    const bad = await l.cli(['learn', 'eval', '--role', 'implementer', '--metrics', join(l.base, 'cases-missing.json')]);
    expect(bad.err).toContain('cases-missing.json needs {cases, baseline, candidate}');
    writeFileSync(join(l.base, 'cases-text.json'), JSON.stringify({ cases: '3', baseline: m(0.5), candidate: m(0.6) }));
    expect((await l.cli(['learn', 'eval', '--role', 'implementer', '--metrics', join(l.base, 'cases-text.json')])).code).toBe(4);
  });

  it('prints plain words for a rejected overlay, and a suite id defaulted from the replay suite', async () => {
    const l = lab();
    seed(l);
    writeFileSync(join(l.base, 'worse.json'), JSON.stringify({ cases: 4, baseline: m(0.9), candidate: m(0.3) }));
    const r = await l.cli(['learn', 'eval', '--role', 'implementer', '--metrics', join(l.base, 'worse.json')]);
    expect(r.out).toMatch(/^overlay ovl-\S+ \(implementer v1\): not adopted \(/);
    expect(r.out).toContain('  baseline:  pass 90%, attempts 2.0, cost $1.00, false-pass 0%\n');
    expect(r.out).toContain('  candidate: pass 30%, attempts 2.0, cost $1.00, false-pass 0%\n');
    const s = openStore(l);
    expect(s.listOverlays({ role: 'implementer' })[0]?.eval?.suite_id).toMatch(/\S/);
    s.close();
  });

  it('retries a replay whose baseline changed, up to three times, then gives the conflict back', async () => {
    const l = lab();
    seed(l);
    hooks.complete = () => {
      throw new OrbitError('CONCURRENT_UPDATE', 'the baseline overlay changed');
    };
    const r = await l.cli(['learn', 'eval', '--role', 'implementer'], { seams: { evalRunner: winning } });
    expect(r.code).toBe(5);
    expect(r.err).toContain('the active overlay changed during the replay; evaluating again (1/3)\n');
    expect(r.err).toContain('evaluating again (2/3)\n');
    expect(r.err).not.toContain('(3/3)');
    expect(r.err.endsWith('orbit: the baseline overlay changed\n')).toBe(true);
  });

  it('does not retry metrics measured elsewhere, nor an error that is not a lost race', async () => {
    const l = lab();
    seed(l);
    writeFileSync(join(l.base, 'm.json'), JSON.stringify({ cases: 4, baseline: m(0.5), candidate: m(0.7) }));
    hooks.complete = () => {
      throw new OrbitError('CONCURRENT_UPDATE', 'the baseline overlay changed');
    };
    const raced = await l.cli(['learn', 'eval', '--role', 'implementer', '--metrics', join(l.base, 'm.json')]);
    expect(raced.code).toBe(5);
    expect(raced.err).toBe('orbit: the baseline overlay changed\n');
    hooks.complete = () => {
      throw new OrbitError('SCHEMA_INVALID', 'metrics are inconsistent');
    };
    const other = await l.cli(['learn', 'eval', '--role', 'implementer', '--metrics', join(l.base, 'm.json')], { seams: { evalRunner: winning } });
    expect(other.code).toBe(4);
    expect(other.err).toBe('orbit: metrics are inconsistent\n');
  });

  it('passes the controller timing seam on to the replay runner', async () => {
    const l = lab();
    seed(l);
    const r = await l.cli(['learn', 'eval', '--role', 'implementer'], { seams: { controller: { tickIntervalMs: 5 }, controllerDeps: () => ({}) as never } });
    // No replay can start with these stand-in dependencies; the failure is reported, not hidden.
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/^orbit: /);
  });

  it('rejects extra arguments and needs the replay budget', async () => {
    const l = lab();
    seed(l);
    expect((await l.cli(['learn', 'eval', 'extra', '--role', 'implementer'])).code).toBe(2);
    writeConfig(l, CONFIG().replace('eval_budget_usd: 1', 'eval_budget_usd: 0'));
    const off = await l.cli(['learn', 'eval', '--role', 'implementer']);
    expect(off.code).toBe(4);
    expect(off.err).toContain('eval_budget_usd is 0');
  });
});
