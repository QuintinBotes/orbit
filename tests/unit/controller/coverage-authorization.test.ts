import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Operation } from '../../../src/policy/types.ts';
import { setQuestionAnswer, withdrawQuestion } from '../../../src/inquisition/store.ts';
import { getDecision, listDecisions, recordDecision } from '../../../src/storage/decisions.ts';
import {
  APPROVE_ONCE,
  AUTHORIZATION_GRANT_KIND,
  AUTHORIZATION_REQUEST_KIND,
  DENY,
  GRANT_POLICY_FILE,
  attemptSubject,
  authorizedOnce,
  deniedDependencyOperations,
  deniedWorkerOperations,
  grantFor,
  grantPolicy,
  operationKey,
  requestAttemptAuthorization,
  requestAuthorization,
  scopeWithGrants,
  sessionEvents,
  ungrantedCommands,
  type GuardedOperation,
} from '../../../src/controller/authorization.ts';
import { addCandidate, cleanScope, makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const supervised = (c: { mode: string }): void => {
  c.mode = 'supervised';
};

function guarded(op: Operation, rule?: string): GuardedOperation {
  return { op, key: operationKey(op), summary: op.kind === 'bash' ? `run \`${op.command}\`` : `do ${op.kind}`, denial: 'actions.change_permissions: denied', ...(rule ? { rule } : {}) };
}

describe('operationKey', () => {
  it('is stable for the same operation and differs for another', () => {
    const a = operationKey({ kind: 'network', host: 'a.example.test' });
    expect(a).toBe(operationKey({ kind: 'network', host: 'a.example.test' }));
    expect(a).not.toBe(operationKey({ kind: 'network', host: 'b.example.test' }));
    expect(a).toMatch(/^op-[0-9a-f]{16}$/);
  });
});

describe('deniedDependencyOperations', () => {
  it('lists the lockfile and manifest changes the policy does not authorize, with the manifests sorted', () => {
    lab = makeUnitLab();
    const snap = lab.ctx().snapshot;
    const ops = deniedDependencyOperations(cleanScope({ lockfile_changed: true, dependency_manifest_changed: ['package.json', 'apps/package.json'] }), snap);
    expect(ops.map((o) => [o.op, o.summary])).toEqual([
      [{ kind: 'dependency', change: 'change_lockfile', detail: 'lockfile changed by the candidate' }, 'change the dependency lockfile'],
      [{ kind: 'dependency', change: 'add_package', detail: 'apps/package.json, package.json' }, 'change dependencies in apps/package.json, package.json'],
    ]);
    expect(ops.every((o) => o.denial.length > 0 && o.key.startsWith('op-'))).toBe(true);
  });

  it('lists nothing when the scope has no such change, or the policy allows it', () => {
    lab = makeUnitLab({
      tweak: (c) => {
        c.dependencies = { ...c.dependencies, add_packages: true, change_lockfile: true };
      },
    });
    expect(deniedDependencyOperations(cleanScope({ lockfile_changed: true, dependency_manifest_changed: ['package.json'] }), lab.ctx().snapshot)).toEqual([]);
    expect(deniedDependencyOperations(cleanScope(), lab.ctx().snapshot)).toEqual([]);
  });
});

describe('asking a person and reading the answer', () => {
  const op = guarded({ kind: 'dependency', change: 'add_package', detail: 'package.json' });

  it('asks once per operation and tree: the same ask again returns the same question and records the request once', () => {
    lab = makeUnitLab({ tweak: supervised });
    lab.walk(['PREFLIGHT']);
    const cand = addCandidate(lab);
    const ctx = lab.ctx();
    const q1 = requestAuthorization(ctx, op, cand);
    const q2 = requestAuthorization(ctx, op, cand);
    expect(q2.id).toBe(q1.id);
    expect(q1).toMatchObject({ status: 'open', material: true, mode: 'risk-review' });
    expect(q1.options.map((o) => o.label)).toEqual([APPROVE_ONCE, DENY]);
    expect(listDecisions(lab.db, lab.runId, { kind: AUTHORIZATION_REQUEST_KIND })).toHaveLength(1);
    expect(grantFor(ctx, op, cand.treeHash)).toEqual({ state: 'pending', questionId: q1.id });
  });

  it('has no grant before any ask, nor once the question was withdrawn', () => {
    lab = makeUnitLab({ tweak: supervised });
    lab.walk(['PREFLIGHT']);
    const cand = addCandidate(lab);
    const ctx = lab.ctx();
    expect(grantFor(ctx, op, cand.treeHash)).toEqual({ state: 'none' });
    const q = requestAuthorization(ctx, op, cand);
    withdrawQuestion(lab.db, q.id, 'no longer needed', lab.clock);
    expect(grantFor(ctx, op, cand.treeHash)).toEqual({ state: 'none' });
  });

  it('a person\'s approve-once grants exactly that operation for that tree, records the grant once, and applies to nothing else', () => {
    lab = makeUnitLab({ tweak: supervised });
    lab.walk(['PREFLIGHT']);
    const cand = addCandidate(lab);
    const other = addCandidate(lab, { tree: 'o'.repeat(40), commit: 'e'.repeat(40) });
    const ctx = lab.ctx();
    const q = requestAuthorization(ctx, op, cand);
    setQuestionAnswer(lab.db, q.id, APPROVE_ONCE, 'quintin', lab.clock);
    const g = grantFor(ctx, op, cand.treeHash);
    expect(g).toMatchObject({ state: 'granted', approvedBy: 'quintin', questionId: q.id });
    expect(grantFor(ctx, op, cand.treeHash)).toEqual(g);
    const decisions = listDecisions(lab.db, lab.runId, { kind: AUTHORIZATION_GRANT_KIND });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.summary).toContain(`candidate tree ${cand.treeHash.slice(0, 12)} only`);
    expect(authorizedOnce(ctx, op, cand.treeHash)).toBe(true);
    expect(authorizedOnce(ctx, op, other.treeHash)).toBe(false);
    expect(getDecision(lab.db, (g as { decisionId: string }).decisionId)).not.toBeNull();
  });

  it('refuses an answer that is not approve-once, or that a model or worker identity gave', () => {
    lab = makeUnitLab({ tweak: supervised });
    lab.walk(['PREFLIGHT']);
    const cand = addCandidate(lab);
    const ctx = lab.ctx();
    const q = requestAuthorization(ctx, op, cand);
    setQuestionAnswer(lab.db, q.id, DENY, 'quintin', lab.clock);
    expect(grantFor(ctx, op, cand.treeHash)).toEqual({ state: 'denied', questionId: q.id, by: 'quintin' });
    lab.cleanup();

    lab = makeUnitLab({ tweak: supervised });
    lab.walk(['PREFLIGHT']);
    const cand2 = addCandidate(lab);
    const ctx2 = lab.ctx();
    const q2 = requestAuthorization(ctx2, op, cand2);
    setQuestionAnswer(lab.db, q2.id, APPROVE_ONCE, 'claude-worker', lab.clock);
    expect(grantFor(ctx2, op, cand2.treeHash)).toEqual({ state: 'denied', questionId: q2.id, by: 'claude-worker' });
    expect(authorizedOnce(ctx2, op, cand2.treeHash)).toBe(false);
  });

  it('the policy is asked first: an operation it allows needs no grant', () => {
    lab = makeUnitLab({
      tweak: (c) => {
        supervised(c);
        c.dependencies = { ...c.dependencies, add_packages: true };
      },
    });
    expect(authorizedOnce(lab.ctx(), op, 't'.repeat(40))).toBe(true);
  });

  it('an attempt grant names the attempt, is asked once, and reads as an implementation attempt in the record', () => {
    lab = makeUnitLab({ tweak: supervised });
    lab.walk(['PREFLIGHT']);
    const ctx = lab.ctx();
    const chmod = guarded({ kind: 'bash', command: 'chmod +x apps/run.sh' }, 'actions.change_permissions');
    const q = requestAttemptAuthorization(ctx, chmod, 2, { id: 'wrk-9', role: 'implementer' });
    expect(requestAttemptAuthorization(ctx, chmod, 2, { id: 'wrk-9', role: 'implementer' }).id).toBe(q.id);
    expect(q.question).toContain('implementation attempt 2');
    expect(grantFor(ctx, chmod, attemptSubject(1))).toEqual({ state: 'none' });
    expect(grantFor(ctx, chmod, attemptSubject(2))).toEqual({ state: 'pending', questionId: q.id });
    setQuestionAnswer(lab.db, q.id, APPROVE_ONCE, 'quintin', lab.clock);
    expect(grantFor(ctx, chmod, attemptSubject(2))).toMatchObject({ state: 'granted' });
    const [grant] = listDecisions(lab.db, lab.runId, { kind: AUTHORIZATION_GRANT_KIND });
    expect(grant?.summary).toContain('implementation attempt 2 only');
    expect(grant?.data).toMatchObject({ attempt: 2, subject: 'attempt:2' });
  });
});

describe('scopeWithGrants', () => {
  it('clears only what a grant covers and keeps the facts of the rest', () => {
    const scope = cleanScope({ lockfile_changed: true, dependency_manifest_changed: ['package.json'] });
    const lock = guarded({ kind: 'dependency', change: 'change_lockfile', detail: 'x' });
    const pkg = guarded({ kind: 'dependency', change: 'add_package', detail: 'package.json' });
    expect(scopeWithGrants(scope, [lock])).toMatchObject({ lockfile_changed: false, dependency_manifest_changed: ['package.json'] });
    expect(scopeWithGrants(scope, [pkg])).toMatchObject({ lockfile_changed: true, dependency_manifest_changed: [] });
    expect(scopeWithGrants(scope, [lock, pkg])).toMatchObject({ lockfile_changed: false, dependency_manifest_changed: [] });
    expect(scopeWithGrants(scope, [guarded({ kind: 'network', host: 'a.example.test' })])).toEqual(scope);
    expect(scopeWithGrants(scope, [])).toEqual(scope);
  });
});

describe('deniedWorkerOperations', () => {
  const worker = (): { id: string; cwd: string } => ({ id: 'wrk-1', cwd: lab.repo });

  function deny(data: Record<string, unknown>, id?: string): void {
    recordDecision(lab.db, lab.ctx().runDir, { ...(id ? { id } : {}), runId: lab.runId, kind: 'policy.deny', summary: 'denied', data: { source: 'guard-hook', worker_id: 'wrk-1', tool: 'Bash', rule: 'actions.change_permissions', ...data } }, lab.clock);
  }

  it('turns the askable guard denials of one worker into operations, once each, with the rule and reason', () => {
    lab = makeUnitLab({ tweak: supervised, path: ['PREFLIGHT'] });
    deny({ target: 'chmod +x apps/run.sh', reason: 'chmod changes permissions' }, 'd1');
    deny({ target: 'chmod +x apps/run.sh', reason: 'again' }, 'd2');
    deny({ target: 'https://registry.example.test/pkg', rule: 'network.not-allowed', tool: 'WebFetch', reason: null }, 'd3');
    deny({ target: 'curl https://Other.Example.test/x', rule: 'network.not-allowed' }, 'd4');
    const ops = deniedWorkerOperations(lab.ctx(), worker());
    expect(ops.map((o) => [o.op, o.rule, o.summary])).toEqual([
      [{ kind: 'bash', command: 'chmod +x apps/run.sh' }, 'actions.change_permissions', 'run `chmod +x apps/run.sh`'],
      [{ kind: 'network', host: 'registry.example.test' }, 'network.not-allowed', 'reach registry.example.test'],
      [{ kind: 'bash', command: 'curl https://Other.Example.test/x' }, 'network.not-allowed', 'run `curl https://Other.Example.test/x`'],
    ]);
    expect(ops[0]?.denial).toBe('actions.change_permissions: chmod changes permissions');
    expect(ops[1]?.denial).toMatch(/^network\.not-allowed: /);
  });

  it('ignores other workers, other sources, rules that cannot be asked about, never-grantable rules and denials with no target', () => {
    lab = makeUnitLab({ tweak: supervised, path: ['PREFLIGHT'] });
    deny({ worker_id: 'wrk-2', target: 'chmod +x a' }, 'e1');
    deny({ source: 'permission-rules', target: 'chmod +x b' }, 'e2');
    deny({ rule: 'protected_path', target: 'chmod +x c' }, 'e3');
    deny({ rule: undefined, target: 'chmod +x d' }, 'e4');
    deny({ rule: 'actions.change_secrets', target: 'rm secrets' }, 'e5');
    deny({ target: null }, 'e6');
    deny({ target: '' }, 'e7');
    expect(deniedWorkerOperations(lab.ctx(), worker())).toEqual([]);
  });

  it('cannot name a network denial it sees no host for, or a non-shell tool it cannot understand', () => {
    lab = makeUnitLab({ tweak: supervised, path: ['PREFLIGHT'] });
    deny({ rule: 'network.not-allowed', target: 'curl somewhere' }, 'f1');
    deny({ tool: 'Edit', rule: 'actions.edit', target: 'apps/a.mjs' }, 'f2');
    deny({ tool: 'WebFetch', rule: 'network.not-allowed', target: 'no host here' }, 'f3');
    expect(deniedWorkerOperations(lab.ctx(), worker())).toEqual([]);
  });

  it('leaves out an operation the policy allows after all', () => {
    lab = makeUnitLab({
      tweak: (c) => {
        supervised(c);
        c.network = { ...c.network, allowed_hosts: ['registry.example.test'] };
      },
      path: ['PREFLIGHT'],
    });
    deny({ tool: 'WebFetch', rule: 'network.not-allowed', target: 'https://registry.example.test/x' }, 'g1');
    expect(deniedWorkerOperations(lab.ctx(), worker())).toEqual([]);
  });

  it('a decision without data is skipped', () => {
    lab = makeUnitLab({ tweak: supervised, path: ['PREFLIGHT'] });
    recordDecision(lab.db, lab.ctx().runDir, { id: 'nodata', runId: lab.runId, kind: 'policy.deny', summary: 'denied' }, lab.clock);
    expect(deniedWorkerOperations(lab.ctx(), worker())).toEqual([]);
  });
});

describe('grantPolicy', () => {
  it('widens only for known, grantable actions, and for the host a network or shell operation names', () => {
    lab = makeUnitLab({ tweak: supervised });
    const ctx = lab.ctx();
    const dir = mkdtempSync(join(lab.base, 'g-'));
    const grant = grantPolicy(
      ctx,
      [
        guarded({ kind: 'bash', command: 'chmod +x a' }, 'actions.change_permissions'),
        guarded({ kind: 'bash', command: 'sh -c secrets' }, 'actions.change_secrets'),
        guarded({ kind: 'bash', command: 'x' }, 'actions.unknown_action'),
        guarded({ kind: 'bash', command: 'curl https://Shell.Example.test/x' }, 'network.not-allowed'),
        guarded({ kind: 'bash', command: 'curl nothing' }, 'network.not-allowed'),
        guarded({ kind: 'network', host: 'net.example.test' }, 'network.not-allowed'),
        guarded({ kind: 'network', host: 'net.example.test' }, 'network.not-allowed'),
        guarded({ kind: 'dependency', change: 'add_package', detail: 'p' }, 'network.not-allowed'),
        guarded({ kind: 'bash', command: 'other' }, 'protected_path'),
        guarded({ kind: 'bash', command: 'norule' }),
      ],
      dir,
    );
    const c = grant.snapshot.config;
    expect(c.actions.change_permissions).toBe(true);
    expect(c.actions.change_secrets).toBe(false);
    expect((c.actions as Record<string, unknown>).unknown_action).toBeUndefined();
    expect(c.network.allowed_hosts).toEqual([...ctx.snapshot.config.network.allowed_hosts, 'shell.example.test', 'net.example.test']);
    expect(grant.path).toBe(join(dir, GRANT_POLICY_FILE));
  });

  it('keeps an existing grant file as it is and returns the same hash for the same widening', () => {
    lab = makeUnitLab({ tweak: supervised });
    const ctx = lab.ctx();
    const dir = mkdtempSync(join(lab.base, 'g-'));
    const ops = [guarded({ kind: 'bash', command: 'chmod +x a' }, 'actions.change_permissions')];
    const first = grantPolicy(ctx, ops, dir);
    const before = readFileSync(first.path, 'utf8');
    const second = grantPolicy(ctx, ops, dir);
    expect(second.hash).toBe(first.hash);
    expect(readFileSync(second.path, 'utf8')).toBe(before);
  });
});

describe('ungrantedCommands and sessionEvents', () => {
  const bash = (id: string, command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const fetch = (id: string, url: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'WebFetch', input: { url } }] } });

  it('names ungranted shell and network use, and skips what is allowed, granted by exact name, malformed or not an assistant event', () => {
    lab = makeUnitLab({ tweak: supervised });
    const snap = lab.ctx().snapshot;
    const events = [
      { type: 'system' },
      { type: 'assistant' },
      { type: 'assistant', message: { content: 'text' } },
      { type: 'assistant', message: { content: [null, { type: 'text' }, { type: 'tool_use', name: 'Bash', input: { command: 'chmod +x x' } }] } },
      bash('a', 'chmod +x apps/a.sh'),
      bash('b', 'echo fine'),
      bash('c', 'chmod +x apps/granted.sh'),
      fetch('d', 'https://ungranted.example.test/x'),
      fetch('e', 'https://granted.example.test/x'),
      fetch('f', 'no host'),
      fetch('g', 5),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'h', name: 'Bash', input: { command: 7 } }, { type: 'tool_use', id: 'i', name: 'Read' }] } },
    ];
    const granted = [guarded({ kind: 'bash', command: 'chmod +x apps/granted.sh' }), guarded({ kind: 'network', host: 'granted.example.test' })];
    expect(ungrantedCommands(events, snap, lab.repo, granted)).toEqual(['chmod +x apps/a.sh', 'ungranted.example.test']);
  });

  it('reads the transcript of a finished session, or nothing when it has none', () => {
    lab = makeUnitLab();
    const dir = join(lab.base, 'session');
    expect(sessionEvents({ workerDir: dir })).toEqual([]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'log.jsonl'), `${JSON.stringify({ type: 'assistant' })}\n${JSON.stringify({ type: 'result' })}\n`);
    expect(sessionEvents({ workerDir: dir })).toEqual([{ type: 'assistant' }, { type: 'result' }]);
    expect(existsSync(join(dir, 'log.jsonl'))).toBe(true);
  });
});
