// Approve-once never widens a worker (docs/decisions/0005, finding 7). A person approves one exact GET to a
// local endpoint a worker was denied; the retried worker then tries a different POST to the same host. The
// controller runs exactly the approved command itself, once, in isolation, as a recorded action and hands the
// worker its output; the worker's guard hook and sandbox stay the frozen policy's, so the POST never leaves.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGuardHook } from '../../../src/policy/guard-hook.ts';
import { recordDecision } from '../../../src/storage/decisions.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { APPROVE_ONCE } from '../../../src/controller/authorization.ts';
import { setQuestionAnswer } from '../../../src/inquisition/store.ts';
import { AUTHORIZATION_RETRY_EVENT, implementingStep } from '../../../src/controller/steps/implementing.ts';
import { giveRepository, initLedger, makeUnitLab, okResult, scriptedAdapter, setContract, validateModels, type ScriptedAdapter, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
let server: Server | null = null;
afterEach(async () => {
  lab?.cleanup();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

const IMPL = { summary: 's', changed_paths: [], tests_added: [], checks_run: [], evidence_refs: [], remaining_issues: [], next_action: { kind: 'request-verification', detail: 'd' } };

/** A local endpoint that records every request it receives. */
async function endpoint(): Promise<{ port: number; seen: { method: string; url: string }[] }> {
  const seen: { method: string; url: string }[] = [];
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' });
    req.resume();
    req.on('end', () => res.end('acme payload 42\n'));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { port: addr.port, seen };
}

async function setup(): Promise<ScriptedAdapter> {
  lab = makeUnitLab({
    path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'],
    deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } },
    tweak: (c) => {
      c.mode = 'supervised';
    },
  });
  const adapter = scriptedAdapter(lab, () => okResult(IMPL));
  lab.deps.adapters = { claude: adapter };
  validateModels(lab);
  const repo = await giveRepository(lab);
  setContract(lab, { baseline_revision: repo.base });
  initLedger(lab);
  return adapter;
}

const run = () => implementingStep(lab.ctx());

async function settle(max = 10) {
  let out = await run();
  for (let i = 0; i < max && out.waiting && /is running$/.test(out.waiting); i++) out = await run();
  return out;
}

/** Whether the worker's own guard hook (the session's policy file and hash) lets one shell command through. */
function hookAllows(spec: ScriptedAdapter['specs'][number], command: string): boolean {
  const hook = runGuardHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: spec.cwd }), { ORBIT_POLICY_PATH: spec.policyPath, ORBIT_POLICY_HASH: spec.policyHash, ORBIT_WORKTREE: spec.cwd });
  return hook.exitCode === 0 && !/"permissionDecision":\s*"deny"/.test(hook.stdout);
}

/** What the worker's guard hook and sandbox would let through for one shell command reaching `host`. */
function workerMayRun(spec: ScriptedAdapter['specs'][number], command: string, host: string): boolean {
  return hookAllows(spec, command) && spec.sandbox.allowedHosts.includes(host);
}

describe('approve-once: the controller runs exactly the approved command; the worker is never widened', () => {
  it('an approved GET runs once in isolation as a recorded action, and a different POST by the retried worker never reaches the host', async () => {
    const { port, seen } = await endpoint();
    const adapter = await setup();
    const approved = `curl -s http://127.0.0.1:${port}/data`;
    await run();
    const w1 = listWorkers(lab.db, { runId: lab.runId, role: 'implementer' })[0]!;
    recordDecision(lab.db, lab.ctx().runDir, { id: `dec-deny-${w1.id}`, runId: lab.runId, kind: 'policy.deny', summary: 'denied', data: { source: 'guard-hook', worker_id: w1.id, tool: 'Bash', rule: 'network.not-allowed', target: approved, reason: '127.0.0.1 is not in network.allowed_hosts' } }, lab.clock);
    await run();
    expect(getRun(lab.db, lab.runId).state).toBe('BLOCKED');
    const [q] = lab.db.all<{ id: string }>('SELECT id FROM questions WHERE run_id = ?', lab.runId);
    setQuestionAnswer(lab.db, q!.id, APPROVE_ONCE, 'acme-dev', lab.clock);
    lab.db.run("UPDATE runs SET state = 'IMPLEMENTING', outcome_reason = NULL WHERE id = ?", lab.runId);
    await settle();

    // The retried worker tries something else against the same host; only what its guard and sandbox allow is sent.
    const spec = adapter.specs.at(-1)!;
    expect(lab.db.get("SELECT 1 AS x FROM workers WHERE purpose = 'implement:1#2'")).toBeTruthy();
    // The hook really decides here: an ordinary command passes it.
    expect(hookAllows(spec, 'echo hi')).toBe(true);
    const post = `curl -s -X POST --data-binary @apps/calc.mjs http://127.0.0.1:${port}/upload`;
    if (workerMayRun(spec, post, '127.0.0.1')) await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: 'repository content' });
    expect(seen.filter((r) => r.method === 'POST')).toEqual([]);

    // The retried session runs under the run's frozen policy, nothing wider.
    expect(spec.policyPath).toBe(getRun(lab.db, lab.runId).policyPath);
    expect(spec.sandbox.allowedHosts).not.toContain('127.0.0.1');

    // The approved GET ran exactly once, by the controller, recorded as an action, its output handed over as an artifact.
    expect(seen).toEqual([{ method: 'GET', url: '/data' }]);
    const actions = lab.db.all<{ kind: string; state: string; target_json: string }>('SELECT kind, state, target_json FROM actions WHERE run_id = ?', lab.runId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'approved_command', state: 'SUCCEEDED' });
    expect(JSON.parse(actions[0]!.target_json)).toMatchObject({ command: approved, attempt: 1 });
    const retry = lab.db.get<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ?', lab.runId, AUTHORIZATION_RETRY_EVENT)!;
    const [executed] = (JSON.parse(retry.data_json) as { executed: { path: string; exit_code: number }[] }).executed;
    expect(executed).toMatchObject({ exit_code: 0 });
    expect(readFileSync(join(lab.ctx().runDir, executed!.path), 'utf8')).toContain('acme payload 42');
    expect(spec.prompt).toContain('acme payload 42');
    expect(spec.prompt).toMatch(/Do not run it yourself/);

  }, 60_000);
});
