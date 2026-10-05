/**
 * Spec section 17, scenarios 11 to 14: unattended execution never deadlocks
 * on a permission prompt (the real claude binary against the fake Messages
 * API), expired credentials produce a truthful blocker (and an environment
 * repair resumes the run through the CLI), simple work uses a low-cost
 * eligible route, and difficult work escalates only with recorded
 * justification.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '../../src/core/clock.ts';
import { createAdapter } from '../../src/adapters/index.ts';
import { repoKey } from '../../src/controller/context.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { listEvidenceReports, listFailures } from '../../src/evidence/store.ts';
import { startFakeAnthropicApi, type FakeAnthropicApi } from '../fakes/fake-anthropic-api.mjs';
import { argvCalls, drive, labAdapters, makeLab, orbit, READY, runState, startLabRun, waitFor, writeScenario, type Lab } from './helpers/lab.ts';
import { APPROVE, GOAL, GOOD_IMPLEMENTATION, implementer, NOT_FOUND_TEXT, planner, REGRESSION_DIAGNOSIS, scenario, SRC_FIX_REGRESSION, SRC_REGRESSION, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

interface RouteData {
  provider: string;
  model: string;
  family: string;
  purpose: string;
  escalated_from?: { model: string };
  justification: { signals: { signal: string; evidence: string[] }[] };
  alternatives_considered: { model: string; eligible: boolean; rejected_because: string }[];
}
function routes(l: Lab, runId: string): RouteData[] {
  return listDecisions(l.db(), runId, { kind: 'route' }).map((d) => d.data as RouteData);
}

const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
const CLAUDE = which.status === 0 ? which.stdout.trim() : null;

describe.skipIf(!READY || !CLAUDE)('acceptance: no permission-prompt deadlock (real claude CLI, fake API; skipped when claude is not installed)', () => {
  let api: FakeAnthropicApi;
  let configDir: string;
  beforeAll(async () => {
    api = await startFakeAnthropicApi({ steps: [{ text: 'ok' }] });
    configDir = mkdtempSync(join(tmpdir(), 'orbit-acc-claude-cfg-'));
  });
  afterAll(async () => {
    await api?.close();
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  it('scenario 11: an unattended run whose worker asks for edits and commands that need permission is denied without a prompt and completes', async () => {
    const l = lab();
    const run = startLabRun(l, GOAL);
    const wt = join(l.orbitHome, 'worktrees', repoKey(l.repo), run.id, 'implementer');
    const server = join(wt, 'src', 'server.ts');
    const test = join(wt, 'tests', 'unit', 'server.test.ts');
    const statusLine = "    assert.equal(handle('/nope', new URLSearchParams()).status, 404);\n";
    const impl = (implementer([]) as { structured: object }).structured;
    api.setSteps([
      // The planner (read-only).
      { structured: (planner() as { structured: object }).structured },
      // The implementer: two calls that would prompt a person in an interactive session...
      { tool: 'Write', input: { file_path: join(wt, 'NOTES.md'), content: '# acme notes\n' } },
      { tool: 'Bash', input: { command: 'curl -s https://example.com', description: 'fetch a page' } },
      // ...then the in-scope change.
      { tool: 'Read', input: { file_path: server } },
      { tool: 'Edit', input: { file_path: server, old_string: "body: 'not found'", new_string: `body: '${NOT_FOUND_TEXT}'` } },
      { tool: 'Read', input: { file_path: test } },
      { tool: 'Edit', input: { file_path: test, old_string: statusLine, new_string: `${statusLine}    assert.equal(handle('/nope', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n` } },
      { structured: impl },
    ]);
    // The reviewer stays the codex fake; Claude is the real CLI against the fake API.
    writeScenario(l, scenario({}));
    const claude = createAdapter('claude', { command: CLAUDE!, data_policy_eligible: true, model: null, reasoning_effort: null, extra_args: [] }, {
      claudeTier: 'claude-sandbox',
      graceMs: 2_000,
      clock: systemClock,
      baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'dumb', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-fake-000', CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    });
    const started = Date.now();
    const done = await drive(l, run.id, { adapters: { ...labAdapters(l), claude } });

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    // Bounded: nothing waited on a prompt.
    expect(Date.now() - started).toBeLessThan(150_000);
    const db = l.db();
    const [w] = listWorkers(db, { runId: run.id, role: 'implementer' });
    expect(w?.state).toBe('SUCCEEDED');
    // The workers ran in dontAsk mode: the out-of-scope edit and the network command were denied, not prompted.
    const log = readFileSync(join(w!.workerDir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x) as { type: string; subtype?: string; permissionMode?: string; permission_denials?: { tool_name: string }[] });
    expect(log[0]).toMatchObject({ type: 'system', subtype: 'init', permissionMode: 'dontAsk' });
    const denials = log.find((e) => e.type === 'result')?.permission_denials?.map((d) => d.tool_name) ?? [];
    expect(denials).toEqual(expect.arrayContaining(['Write', 'Bash']));
    expect(existsSync(join(wt, 'NOTES.md'))).toBe(false);
    // The in-scope change was made and verified.
    expect(listEvidenceReports(db, run.id).at(-1)?.verdict).toBe('PASS');
    expect(api.mainRequests().length).toBeGreaterThanOrEqual(8);
    assertRunInvariants(l, run.id);
  }, 240_000);
});

describe.skipIf(!READY)('acceptance: credentials and routing', () => {
  it('scenario 12: reviewer credentials that expire mid-run produce a truthful blocker before review, and an environment repair resumes the run (orbit resume)', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [implementer([SRC_TEXT, TEST_TEXT], { extra: { sleepMs: 1_500 } })] }));
    const run = startLabRun(l, GOAL);
    const driving = drive(l, run.id);
    // While the implementer works, the codex login expires.
    await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'implementer' }).some((w) => w.state === 'RUNNING'), 90_000);
    writeScenario(l, scenario({ implementer: [implementer([SRC_TEXT, TEST_TEXT])] }, { valid: false, loggedIn: true, method: 'api_key' }));
    const blocked = await driving;

    expect(blocked.state, blocked.outcomeReason ?? '').toBe('BLOCKED');
    // Truthful: which provider, what happened, the exact command to fix it and how to resume.
    expect(blocked.outcomeReason).toMatch(/^Blocked: the codex credentials .*\. Run `codex .*`.*orbit resume /);
    expect(blocked.outcomeReason).toContain(run.id);
    expect(blocked.outcomeReason).toMatch(/does not retry authentication failures/);
    const outcome = JSON.parse(blocked.outcomeJson!) as { blocker: { kind: string; provider: string } };
    expect(outcome.blocker).toMatchObject({ kind: 'authentication', provider: 'codex' });
    expect(transitions(l.db(), run.id).slice(-2)).toEqual(['REVIEWING', 'BLOCKED']);
    // No review was attempted with the expired login and nothing was delivered; the evidence is kept.
    expect(argvCalls(l).filter((c) => c.role === 'reviewer')).toEqual([]);
    expect(listEvidenceReports(l.db(), run.id).at(-1)?.verdict).toBe('PASS');
    expect(l.github().state.prs).toEqual([]);
    expect(readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8')).toMatch(/BLOCKED[\s\S]*credentials/);
    assertRunInvariants(l, run.id);

    // The person logs in again; `orbit resume` (the real CLI, as a child process) drives the run to completion.
    writeScenario(l, scenario({ implementer: [implementer([SRC_TEXT, TEST_TEXT])] }));
    const child = orbit(l, ['resume', run.id, '--foreground', '--policy', l.configPath]);
    // CI reports green on the delivered commit (FakeGitHub), so the CLI's controller completes on observed CI.
    await waitFor(() => existsSync(join(l.runDir(run.id), 'delivery.json')), 120_000, 100);
    const delivered = JSON.parse(readFileSync(join(l.runDir(run.id), 'delivery.json'), 'utf8')) as { commit: string };
    l.github().scriptCi(delivered.commit, [[{ name: 'ci', bucket: 'pass' }]]);
    expect(await child.exited(), child.output().slice(-3000)).toBe(0);
    expect(runState(l, run.id).outcomeJson).toMatch(/"ci":"passed"/);
    expect(runState(l, run.id).state).toBe('SUCCEEDED');
    expect(transitions(l.db(), run.id)).toEqual(expect.arrayContaining(['BLOCKED', 'REVIEWING', 'DELIVERING', 'SUCCEEDED']));
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(1);
    expect(l.github().state.prs).toHaveLength(1);
    assertRunInvariants(l, run.id);
  }, 240_000);

  // DEFECT: a Claude session that fails authentication (401, total_cost_usd 0, empty modelUsage) is charged the full session-cap ceiling, and the BUDGET_EXHAUSTED this raises preempts the credentials blocker: the run ends EXHAUSTED "cost_usd exhausted" with nothing spent.
  it.fails('scenario 12: an implementer whose credentials expire mid-run (401) blocks on credentials, not on budget', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [{ ...GOOD_IMPLEMENTATION(), outcome: 'auth_failure' }] }));
    const run = startLabRun(l, GOAL);
    const blocked = await drive(l, run.id);
    expect(blocked.state, blocked.outcomeReason ?? '').toBe('BLOCKED');
    expect(blocked.outcomeReason).toMatch(/^Blocked: the claude credentials /);
    expect(argvCalls(l).filter((c) => c.role === 'implementer')).toHaveLength(1);
  }, 180_000);

  it('scenario 12: credentials already expired at the start block in preflight, before any model spend, naming the provider', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }, { loggedIn: false }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    expect(done.state).toBe('BLOCKED');
    expect(transitions(l.db(), run.id)).toEqual(['PREFLIGHT', 'BLOCKED']);
    expect(done.outcomeReason).toMatch(/^Blocked: the (claude|codex) credentials /);
    expect(listWorkers(l.db(), { runId: run.id })).toEqual([]);
    expect(argvCalls(l).filter((c) => c.role && c.role !== 'unknown')).toEqual([]);
    assertRunInvariants(l, run.id);
  }, 120_000);

  it('scenario 13: simple work uses the low-cost eligible route, with the more expensive alternatives recorded and not taken', async () => {
    const l = lab({ tweak: (c) => void (c.routing.allowed_models = ['opus', 'sonnet', 'haiku']) });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(done.difficulty).toBe('simple');
    const all = routes(l, run.id);
    const impl = all.find((r) => r.purpose === 'implement:1')!;
    expect(impl.provider).toBe('claude');
    expect(['haiku', 'sonnet']).toContain(impl.family);
    expect(impl.escalated_from).toBeUndefined();
    expect(impl.justification.signals).toEqual([]);
    // Opus was eligible and considered, and declined as more than this work needs; Fable never by default.
    const opus = impl.alternatives_considered.find((a) => /opus/.test(a.model));
    expect(opus).toMatchObject({ eligible: true });
    expect(opus!.rejected_because).toMatch(/higher tier than this work needs|lower expected cost/);
    expect(all.every((r) => r.family !== 'fable' && r.family !== 'opus')).toBe(true);
    // The worker ran on that route and its spend was recorded.
    const [w] = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    expect(w!.model).toBe(impl.model);
    const usage = l.db().all<{ cost_usd: number | null }>('SELECT cost_usd FROM usage WHERE run_id = ?', run.id);
    expect(usage.length).toBeGreaterThanOrEqual(3);
    expect(readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8')).toMatch(/## Budget consumption[\s\S]*model cost: \$/);
    assertRunInvariants(l, run.id);
  }, 180_000);

  async function escalationRun(): Promise<{ l: Lab; runId: string }> {
    const l = lab();
    writeScenario(
      l,
      scenario({
        implementer: [implementer([SRC_REGRESSION, TEST_TEXT]), implementer([SRC_FIX_REGRESSION], { changed: [['src/server.ts', 'modify']] })],
        verifier: [REGRESSION_DIAGNOSIS],
        reviewer: [APPROVE],
      }),
    );
    const run = startLabRun(l, GOAL);
    await drive(l, run.id);
    return { l, runId: run.id };
  }

  it('scenario 14: difficult work escalates only with recorded justification that names the failure records it rests on', async () => {
    const { l, runId } = await escalationRun();
    const db = l.db();
    expect(l.db().get<{ state: string }>('SELECT state FROM runs WHERE id = ?', runId)!.state).toBe('SUCCEEDED');
    const all = routes(l, runId);
    // The first attempt starts at the routine tier with no escalation.
    const first = all.find((r) => r.purpose === 'implement:1')!;
    expect(first.escalated_from).toBeUndefined();
    expect(first.justification.signals).toEqual([]);
    // Every escalation carries observed-difficulty signals whose evidence ids are real failure records of this run.
    const failureIds = new Set(listFailures(db, runId).map((f) => `failure:${f.id}`));
    const escalated = all.filter((r) => r.escalated_from);
    expect(escalated.length).toBeGreaterThanOrEqual(1);
    for (const r of escalated) {
      expect(r.justification.signals.length).toBeGreaterThan(0);
      for (const s of r.justification.signals) {
        expect(s.evidence.length).toBeGreaterThan(0);
        for (const ref of s.evidence) expect(failureIds.has(ref), `${ref} is a recorded failure`).toBe(true);
      }
    }
    // The implementer of the escalated attempt ran on the escalated model, and the report says so.
    const second = all.find((r) => r.purpose === 'implement:2')!;
    expect(listWorkers(db, { runId, role: 'implementer' }).find((w) => w.attempt === 2)?.model).toBe(second.model);
    expect(readFileSync(join(l.runDir(runId), 'final.md'), 'utf8')).toMatch(/escalated from/);
    assertRunInvariants(l, runId);
  }, 180_000);

  // DEFECT: the router escalates the implementer from Sonnet to Opus after one failed attempt (signal strong-attempt-failed), although docs/architecture.md ("Token efficiency") allows it only after repeated equivalent failures.
  it.fails('scenario 14: the implementer is not escalated on a single localized failure (architecture: only after repeated equivalent failures)', async () => {
    const { l, runId } = await escalationRun();
    const second = routes(l, runId).find((r) => r.purpose === 'implement:2')!;
    const threshold = l.config.scheduler.repeated_failure_threshold;
    const repeated = new Set(listFailures(l.db(), runId).filter((f) => f.candidateId !== null).map((f) => f.candidateId)).size;
    expect(repeated).toBeLessThan(threshold);
    expect(second.escalated_from).toBeUndefined();
  }, 180_000);
});
