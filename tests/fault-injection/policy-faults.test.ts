// Policy faults (spec sections 5, 6 and 17): an indirect shell write to a protected path that no
// tool-level guard sees, and a policy snapshot edited while the run is in progress.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { listReviews } from '../../src/review/store.ts';
import { alive, baseScenario, calls, canStripTypes, drive, git, implementMul, runState, startLabRun, tracker, transitions, waitFor, writeScenario } from './helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

interface TranscriptLine {
  type: string;
  message?: { content?: { type: string; name?: string; input?: { command?: string; file_path?: string } }[] };
}

describe.skipIf(!canStripTypes)('fault: indirect shell writes', () => {
  it('a protected path written through a shell redirect is caught by scope inspection of the candidate, although no Edit or Write tool named it', async () => {
    const l = t.lab();
    writeScenario(l, baseScenario({ implementer: [{ ...implementMul('*'), forbiddenWrite: { path: '.github/workflows/release.yml', content: 'on: push\njobs: {}\n' } }] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    // The write happened (no OS sandbox in this lab) and only a Bash redirect carried it: a PreToolUse guard keyed
    // on Edit/Write file paths had nothing to inspect.
    const [impl] = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    const uses = readFileSync(join(impl!.workerDir, 'log.jsonl'), 'utf8')
      .split('\n')
      .filter((x) => x.trim().startsWith('{'))
      .map((x) => JSON.parse(x) as TranscriptLine)
      .flatMap((x) => (x.type === 'assistant' ? (x.message?.content ?? []) : []))
      .filter((c) => c.type === 'tool_use');
    expect(uses.some((u) => u.name === 'Bash' && /> \S*\.github\/workflows\/release\.yml/.test(u.input?.command ?? ''))).toBe(true);
    expect(uses.some((u) => u.name !== 'Bash' && (u.input?.file_path ?? '').includes('.github'))).toBe(false);
    expect(readFileSync(join(runState(l, run.id).worktreePath!, '.github/workflows/release.yml'), 'utf8')).toContain('on: push');

    // The controller's own diff inspection is the gate.
    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/policy violation.*\.github\/workflows\/release\.yml/);
    expect(listDecisions(l.db(), run.id, { kind: 'policy.deny' })).toHaveLength(1);
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' })).toEqual([]);
    expect(listReviews(l.db(), run.id)).toEqual([]);
    expect(git(l.repo, 'branch', '--list', `orbit/${run.id}`)).toBe('');
  }, 30_000);
});

describe.skipIf(!canStripTypes)('fault: policy edits', () => {
  it('a policy snapshot edited mid-run blocks the run with POLICY_TAMPERED and stops its worker', async () => {
    const l = t.lab();
    writeScenario(l, baseScenario({ implementer: [{ ...implementMul('*'), sleepMs: 4_000 }] }));
    const run = startLabRun(l);
    const driving = drive(l, run.id);
    const impl = await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'implementer' }).find((w) => w.state === 'RUNNING' && w.pid !== null), 30_000);
    t.group(impl.pgid);

    // Widen the frozen scope in place and put the read-only mode back, as a worker or a script might.
    const path = runState(l, run.id).policyPath;
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as { config: { scope: { allowed_paths: string[]; protected_paths: string[] } } };
    snapshot.config.scope.allowed_paths = ['**'];
    snapshot.config.scope.protected_paths = [];
    chmodSync(path, 0o644);
    writeFileSync(path, JSON.stringify(snapshot));
    chmodSync(path, 0o444);
    await driving;

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/^POLICY_TAMPERED/);
    expect(transitions(l, run.id).at(-1)).toBe('IMPLEMENTING>BLOCKED');
    // Nothing continued under the edited policy: the worker was stopped and no candidate went on to review.
    expect(alive(impl.pid!)).toBe(false);
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' }).map((w) => w.state)).not.toContain('RUNNING');
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' })).toEqual([]);
    expect(calls(l, 'implementer')).toHaveLength(1);
  }, 30_000);
});
