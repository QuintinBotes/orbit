import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import type { OrbitDb } from '../../../src/storage/db.ts';
import { baseScenario, DIAGNOSIS, implementMul, labDeps, makeLab, startLabRun, writeScenario, type Lab } from '../controller/harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
function lab(tweak?: (c: Lab['config']) => void): Lab {
  const l = makeLab({
    tweak: (c) => {
      c.knowledge = { ...c.knowledge, enabled: true, auto_adopt_overlays: false, eval_budget_usd: 0 };
      tweak?.(c);
    },
  });
  labs.push(l);
  return l;
}
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

/** A failure that is repaired: something the curator is asked to learn from. */
const REPAIRED = { implementer: [implementMul('+'), implementMul('*')], verifier: [DIAGNOSIS], curator: [{ structured: { lessons: [], discarded: [] } }] };

async function runToEnd(l: Lab): Promise<string> {
  writeScenario(l, baseScenario(REPAIRED));
  const run = startLabRun(l);
  await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
  expect(l.db().get<{ state: string }>('SELECT state FROM runs WHERE id = ?', run.id)?.state).toBe('SUCCEEDED');
  return run.id;
}

const learningOf = (l: Lab, runId: string) => JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', runId, 'learning.json'), 'utf8')) as { skipped: string | null; learn: { observations: number } | null };
const eventTypes = (l: Lab, runId: string) => l.db().all<{ type: string }>('SELECT type FROM events WHERE run_id = ? ORDER BY id', runId).map((e) => e.type);

describe.skipIf(!canStripTypes)('the curator is a recorded worker of the finished run', () => {
  it('plans a curator worker on the terminal run, runs it, and charges its usage to the run', async () => {
    const l = lab();
    const runId = await runToEnd(l);
    const curators = listWorkers(l.db(), { runId, role: 'curator' });
    expect(curators).toHaveLength(1);
    expect(curators[0]).toMatchObject({ state: 'SUCCEEDED', purpose: 'curate:1', provider: 'claude' });
    expect(existsSync(join(curators[0]!.workerDir, 'exit.json'))).toBe(true);
    expect(learningOf(l, runId)).toMatchObject({ skipped: null });
    expect(learningOf(l, runId).learn?.observations).toBeGreaterThan(0);
    // Its cost is a usage row of that worker, and the spend cap it ran under was recorded first.
    expect(l.db().get('SELECT 1 AS x FROM usage WHERE run_id = ? AND worker_id = ?', runId, curators[0]!.id)).toBeTruthy();
    expect(l.db().get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'worker.spend-cap' AND data_json LIKE '%curate:1%'", runId)).toBeTruthy();
    const types = eventTypes(l, runId);
    expect(types.indexOf('worker.planned', types.lastIndexOf('state.transition'))).toBeGreaterThan(-1);
    expect(types).toContain('learning.completed');
    expect(types).not.toContain('learning.curation-skipped');
  }, 120_000);

  it('skips curation, and records why, when knowledge.curator_budget_usd is 0', async () => {
    const l = lab((c) => void (c.knowledge.curator_budget_usd = 0));
    const runId = await runToEnd(l);
    expect(listWorkers(l.db(), { runId, role: 'curator' })).toEqual([]);
    expect(learningOf(l, runId).skipped).toMatch(/curator_budget_usd is 0/);
    expect(eventTypes(l, runId)).toContain('learning.curation-skipped');
  }, 120_000);

  it('skips curation, and records why, when the budget reserve cannot pay for it', async () => {
    // The Codex review reports no cost, so its ceiling is charged; a curator budget the hard cap cannot also hold is refused.
    const l = lab((c) => void (c.knowledge.curator_budget_usd = 29));
    const runId = await runToEnd(l);
    expect(listWorkers(l.db(), { runId, role: 'curator' })).toEqual([]);
    expect(learningOf(l, runId).skipped).toMatch(/budget reserve cannot pay for curation/);
    expect(eventTypes(l, runId)).toContain('learning.curation-skipped');
  }, 120_000);
});

describe.skipIf(!canStripTypes)('orbit learn ingest uses the same curator runner', () => {
  async function ingest(l: Lab, scenario: object) {
    writeScenario(l, scenario);
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), JSON.stringify(l.config));
    writeFileSync(join(l.repo, 'NOTES.md'), 'Retries must be bounded.\n');
    const io = memoryIo('');
    const code = await main(['learn', 'ingest', 'NOTES.md', '--json'], {
      io,
      cwd: l.repo,
      homeDir: l.base,
      orbitHome: l.orbitHome,
      env: { ...process.env, ORBIT_HOME: l.orbitHome },
      user: 'alice',
      seams: { controllerDeps: (input) => labDeps(l, input.db as OrbitDb) },
    });
    return { code, out: io.stdout, err: io.stderr };
  }

  it('runs the curator through the adapter and accepts its output', async () => {
    const l = lab();
    l.db();
    const r = await ingest(l, { roles: { curator: [{ structured: { lessons: [], discarded: [] } }] } });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ source: { kind: 'file', ref: 'NOTES.md' }, created: [], merged: [] });
    expect(readFileSync(l.argvLog, 'utf8')).toContain('"role":"curator"');
  }, 60_000);

  it('reports a rejected credential as an authentication failure, not a generic one', async () => {
    const l = lab();
    l.db();
    const r = await ingest(l, { roles: { curator: [{ outcome: 'auth_failure' }] } });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/curator ended auth_failed/);
  }, 60_000);
});
