/**
 * `orbit retro` (issue #174): runs grouped by failure class and signature become one proposal citing them (AC-1); an
 * approved check is committed on a new branch, never on the base branch (AC-2); a run that ended in `gate-deadlock`
 * yields a draft file with paths redacted and the person is asked before anything is sent (AC-3); a declined proposal
 * is not made again.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCommand } from '../../../src/cli/args.ts';
import { createContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { ghSend, RETRO_OPTIONS, RETRO_USAGE, runRetro, terminalAsk, type RetroDeps } from '../../../src/cli/commands/retro.ts';
import { UsageError } from '../../../src/cli/exit.ts';
import { ManualClock, systemClock } from '../../../src/core/clock.ts';
import { acquireLease, releaseLease, transition } from '../../../src/controller/run-store.ts';
import type { RunState } from '../../../src/controller/states.ts';
import type { FailureClass } from '../../../src/controller/failure-class.ts';
import { recordDecision } from '../../../src/storage/decisions.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { draftFileName, findDecision, retroProposals, listDecisions, redactPaths } from '../../../src/observability/retro.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

/** The states a run passes through before it can succeed: no edge leads from planning straight to SUCCEEDED. */
const TO_SUCCESS: RunState[] = ['IMPLEMENTING', 'VERIFYING', 'REVIEWING'];

/**
 * A run that ends in `state` through the run store, carrying `outcome`, as a controller ends it. `denials` are the policy
 * rules that denied its worker's calls, recorded as the transcript reader records them; `cause` is the class the ending
 * step names when the outcome marks none.
 */
function endRun(l: Lab, id: string, state: RunState, outcome: Record<string, unknown> | null, over: { goal?: string; reason?: string; cause?: FailureClass; denials?: string[] } = {}): void {
  l.newRun(over.goal ?? 'Add a mul function to the calculator.', id);
  const db = l.db();
  for (const rule of over.denials ?? []) {
    recordDecision(db, join(l.repo, '.orbit', 'runs', id), { runId: id, kind: 'policy.deny', summary: `implementer: Bash denied by the guard hook (${rule})`, data: { source: 'guard-hook', rule, tool: 'Bash', target: `npx vitest run ${l.repo}/tests/secret.test.ts | tail`, reason: 'the command cannot be inspected' } }, systemClock);
  }
  acquireLease(db, id, 'test-controller', 60_000, systemClock);
  try {
    const path: RunState[] = ['PREFLIGHT', 'CONTRACTING', 'PLANNING', ...(state === 'SUCCEEDED' ? TO_SUCCESS : [])];
    for (const to of path) transition(db, { runId: id, to, ownerId: 'test-controller', reason: 'test' }, systemClock);
    transition(db, { runId: id, to: state, ownerId: 'test-controller', reason: over.reason ?? 'ended', ...(over.cause ? { cause: over.cause } : {}), ...(outcome ? { patch: { outcomeReason: over.reason ?? 'ended', outcomeJson: JSON.stringify(outcome) } } : {}) }, systemClock);
  } finally {
    releaseLease(db, id, 'test-controller');
  }
}

const DEADLOCK = { questions: [{ id: 'q1' }], blocked_criteria: ['AC-1'] };
/** A fake Anthropic key, built at run time as in core/redact.test.ts. */
const SECRET = `sk-ant-api03-${'Z'.repeat(32)}`;

interface Fake extends RetroDeps {
  asked: string[];
  sent: { repo: string; title: string; body: string }[];
}

/** Deps that answer `answer` and record what was asked and what was sent. */
function fake(answer: boolean | null, fail?: string): Fake {
  const f: Fake = {
    asked: [],
    sent: [],
    async ask(q) {
      f.asked.push(q);
      return answer;
    },
    async send(input) {
      f.sent.push({ repo: input.repo, title: input.title, body: input.body });
      if (fail) throw new Error(fail);
      return 'https://github.com/QuintinBotes/orbit/issues/999';
    },
  };
  return f;
}

async function retro(l: Lab, argv: string[], deps: RetroDeps, over: Parameters<Lab['cli']>[1] = {}): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo();
  const ctx = createContext({ io, cwd: l.repo, homeDir: l.home, orbitHome: join(l.home, '.orbit'), env: { ...process.env, HOME: l.home }, user: 'alice', ...over });
  const code = await runRetro(parseCommand(argv, RETRO_OPTIONS, RETRO_USAGE), ctx, deps);
  return { code, out: io.stdout, err: io.stderr };
}

const draftFiles = (l: Lab): string[] => {
  const dir = join(l.repo, '.orbit', 'runs', 'retro-drafts');
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe('orbit retro: a gate-deadlock run becomes an issue draft', () => {
  it('writes a draft file with the run evidence and asks the person, sending nothing without a yes', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    const deps = fake(null);
    const r = await retro(l, [], deps);
    expect(r.code, r.err).toBe(0);
    expect(draftFiles(l)).toHaveLength(1);
    const text = readFileSync(join(l.repo, '.orbit', 'runs', 'retro-drafts', draftFiles(l)[0]!), 'utf8');
    expect(text).toContain('orb-dead-1');
    expect(text).toContain('gate-deadlock');
    expect(text).toContain('BLOCKED');
    expect(text).toContain('blocked_criteria (1)');
    expect(text).toContain('questions (1)');
    expect(text).toContain('PREFLIGHT > CONTRACTING > PLANNING > BLOCKED');
    // The person was asked once, and no one answering means nothing left the machine.
    expect(deps.asked).toHaveLength(1);
    expect(deps.asked[0]).toContain('Nothing is sent without your yes');
    expect(deps.sent).toEqual([]);
    expect(r.out).toContain('nothing was sent');
    expect(r.out).toContain('orb-dead-1');
  });

  it('redacts absolute and repository paths, wherever they would appear', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    const p = retroProposals(l.db(), { since: null, roots: [l.repo, l.home] })[0]!;
    expect(p.body).not.toContain(l.repo);
    expect(p.body).not.toContain(l.home);
    // The net itself: roots (and what is below them), home-relative, POSIX and Windows paths.
    expect(redactPaths(`see ${l.repo}/src/a.ts and /Users/alice/proj/x.ts and ~/work/y and C:\\Users\\bob\\z.ts and /var/folders/ab/T/q`, [l.repo])).toBe('see <repo>/<path> and <path> and <path> and <path> and <path>');
    // A root alone is named, a path below it is not, and a longer name that merely starts like the root is not the root.
    expect(redactPaths(`in ${l.repo}. then ${l.repo}/ and ${l.repo}-other/x`, [l.repo])).toBe('in <repo>. then <repo> and <path>');
    expect(redactPaths('at /srv/work/app/src/billing.ts:12', ['/srv/work/app'])).toBe('at <repo>/<path>');
    expect(redactPaths('a > b, 2026-01-01T00:00:00.000Z | --- |')).toBe('a > b, 2026-01-01T00:00:00.000Z | --- |');
  });

  it('never carries source snippets, secret-like strings or paths that the run recorded in its outcome, reason or goal', async () => {
    const l = lab();
    const secret = SECRET;
    const snippet = 'export function privateBilling(secretRate: number) { return secretRate * 1.07; }';
    const where = '/Users/alice/clients/acme-billing/src/billing.ts';
    endRun(
      l,
      'orb-dead-1',
      'BLOCKED',
      { ...DEADLOCK, questions: [{ id: 'q1', question: snippet, evidence: [where] }], authorization: { reason: `token ${secret} in ${where}` }, gate: [`gate says ${snippet} at ${where}`], unknown_key_with_secret: secret },
      { goal: `Fix ${snippet} using ${secret}`, reason: `blocked at ${where} with ${secret}: ${snippet}` },
    );
    const deps = fake(false);
    const r = await retro(l, [], deps);
    expect(r.code, r.err).toBe(0);
    const text = readFileSync(join(l.repo, '.orbit', 'runs', 'retro-drafts', draftFiles(l)[0]!), 'utf8');
    for (const forbidden of [secret, 'privateBilling', 'secretRate', where, 'acme-billing', 'clients', l.repo, l.home]) {
      expect(text, forbidden).not.toContain(forbidden);
      expect(r.out, forbidden).not.toContain(forbidden);
    }
    // The markers are named, so the draft still says which gate held the run.
    expect(text).toContain('authorization');
    expect(text).toContain('gate (1)');
  });

  it('sends nothing on a decline, records it, and does not propose the draft again', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    const no = fake(false);
    const first = await retro(l, [], no);
    expect(first.out).toContain('declined: nothing was sent');
    expect(no.sent).toEqual([]);
    expect(findDecision(l.db(), 'issue-draft:gate-deadlock:blocked_criteria+questions')).toMatchObject({ decision: 'declined', decidedBy: 'alice', runIds: ['orb-dead-1'] });

    const again = fake(true);
    const second = await retro(l, [], again);
    expect(second.out).toContain('No proposals');
    expect(second.out).toContain('1 proposal(s) were answered before and are not repeated');
    expect(again.asked).toEqual([]);
    expect(again.sent).toEqual([]);
    expect(draftFiles(l)).toHaveLength(1);
  });

  it('sends only on a yes, to the named repository, with the draft title and body, and records it as sent', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    const yes = fake(true);
    const r = await retro(l, ['--issue-repo', 'acme/orbit-fork'], yes);
    expect(r.code, r.err).toBe(0);
    expect(yes.sent).toHaveLength(1);
    expect(yes.sent[0]!.repo).toBe('acme/orbit-fork');
    expect(yes.sent[0]!.title).toContain('gate-deadlock');
    expect(yes.sent[0]!.body).toContain('orb-dead-1');
    expect(yes.sent[0]!.body).not.toMatch(/^# /);
    expect(r.out).toContain('sent to acme/orbit-fork: https://github.com/QuintinBotes/orbit/issues/999');
    expect(findDecision(l.db(), 'issue-draft:gate-deadlock:blocked_criteria+questions')?.decision).toBe('sent');
  });

  it('keeps a draft nobody was asked about pending: the next retro makes it again, citing the runs since, until a person answers', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    await retro(l, [], fake(null));
    expect(listDecisions(l.db()).map((d) => [d.kind, d.decision, d.runIds])).toEqual([['issue-draft', 'drafted', ['orb-dead-1']]]);
    endRun(l, 'orb-dead-2', 'BLOCKED', DEADLOCK);
    const no = fake(false);
    const second = await retro(l, [], no);
    expect(no.asked).toHaveLength(1);
    expect(second.out).toContain('cites 2 run(s): orb-dead-1, orb-dead-2');
    expect(listDecisions(l.db()).map((d) => [d.decision, d.runIds])).toEqual([['declined', ['orb-dead-1', 'orb-dead-2']]]);
    expect(draftFiles(l)).toHaveLength(1);
    const third = await retro(l, [], fake(true));
    expect(third.out).toContain('No proposals');
    expect(third.out).toContain('not repeated');
  });

  it('leaves the names of denied rules out of an issue draft: a worker can print any name in its transcript', async () => {
    const l = lab();
    // A failing command that prints "Orbit policy (<name>): ..." is read back as a denial: here a hex-encoded secret.
    const forged = `x${Buffer.from('db01.internal:hunter2').toString('hex')}`;
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK, { denials: [forged, 'bash.unparseable'] });
    const yes = fake(true);
    const r = await retro(l, [], yes);
    expect(r.code, r.err).toBe(0);
    expect(yes.sent).toHaveLength(1);
    const text = readFileSync(join(l.repo, '.orbit', 'runs', 'retro-drafts', draftFiles(l)[0]!), 'utf8');
    for (const where of [yes.sent[0]!.title, yes.sent[0]!.body, text, r.out]) {
      expect(where).not.toContain(forged);
      expect(where).not.toContain('bash.unparseable');
    }
    expect(findDecision(l.db(), 'issue-draft:gate-deadlock:blocked_criteria+questions')?.decision).toBe('sent');
  });

  it('sends nothing the publication guard holds back: the draft stays pending and the exit is non-zero', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    mkdirSync(join(l.home, 'pg'), { recursive: true });
    writeFileSync(join(l.home, 'pg', 'terms.txt'), 'orb-dead-1\n');
    const yes = fake(true);
    const r = await retro(l, [], yes, { env: { ...process.env, HOME: l.home, PUBLISH_GUARD_CONFIG: join(l.home, 'pg', 'config.json') } });
    expect(r.code).toBe(1);
    expect(yes.sent).toEqual([]);
    expect(r.out).toContain('not sent: the publication guard holds the draft back');
    expect(findDecision(l.db(), 'issue-draft:gate-deadlock:blocked_criteria+questions')?.decision).toBe('drafted');
  });

  it('sends nothing when the Orbit configuration cannot be read: it may name the terms file the guard needs', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    mkdirSync(join(l.repo, '.orbit'), { recursive: true });
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), 'version: 1\nguard:\n  terms_file: /nonexistent/terms.txt\nnot_a_setting: true\n');
    const yes = fake(true);
    const r = await retro(l, [], yes);
    expect(r.code).toBe(1);
    expect(yes.sent).toEqual([]);
    expect(findDecision(l.db(), 'issue-draft:gate-deadlock:blocked_criteria+questions')?.decision).toBe('drafted');
  });

  it('keeps the draft and reports the error when sending fails, and exits non-zero', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    const r = await retro(l, [], fake(true, `gh failed in ${l.repo}/x with ${SECRET}`));
    expect(r.code).toBe(1);
    expect(r.out).toContain('not sent: gh failed in <repo>/<path>');
    expect(r.out).not.toContain(l.repo);
    expect(r.out).not.toContain('sk-ant-api03-ZZZZ');
    expect(draftFiles(l)).toHaveLength(1);
    expect(findDecision(l.db(), 'issue-draft:gate-deadlock:blocked_criteria+questions')?.decision).toBe('drafted');
  });
});

describe('orbit retro: which runs it proposes from', () => {
  it('makes one draft for runs that share a signature, citing them all, and another for a different signature', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    endRun(l, 'orb-dead-2', 'BLOCKED', DEADLOCK);
    endRun(l, 'orb-dead-3', 'EXHAUSTED', { ...DEADLOCK, review_gate: ['no approving review'] });
    const r = await retro(l, ['--json'], fake(true));
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { proposals: { signature: string; runs: string[]; outcome: string }[] };
    expect(j.proposals.map((p) => [p.signature, p.runs, p.outcome])).toEqual([
      ['blocked_criteria+questions', ['orb-dead-1', 'orb-dead-2'], 'drafted'],
      ['blocked_criteria+questions+review_gate', ['orb-dead-3'], 'drafted'],
    ]);
  });

  it('with --json never asks: stdout belongs to the data, so nothing is sent', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    const deps = fake(true);
    const r = await retro(l, ['--json'], deps);
    expect(deps.asked).toEqual([]);
    expect(deps.sent).toEqual([]);
    expect(JSON.parse(r.out)).toMatchObject({ window: { since: null }, proposals: [{ kind: 'issue-draft', failure_class: 'gate-deadlock', outcome: 'drafted', draft: expect.stringMatching(/^\.orbit\/runs\/retro-drafts\/.+\.md$/) }], already_decided: 0 });
  });

  it('proposes nothing for runs of other classes, for a run that succeeded, or for one still running', async () => {
    const l = lab();
    endRun(l, 'orb-ok', 'SUCCEEDED', null);
    endRun(l, 'orb-scope', 'BLOCKED', { scope: { within_scope: false } });
    endRun(l, 'orb-env', 'BLOCKED', { environment_failures: [{ check_id: 'unit' }] });
    l.newRun('still going', 'orb-live');
    const deps = fake(true);
    const r = await retro(l, [], deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain('No proposals from all runs');
    expect(deps.asked).toEqual([]);
    expect(draftFiles(l)).toEqual([]);
  });

  it('limits the runs to --since, by creation time, and says which window', async () => {
    const l = lab();
    endRun(l, 'orb-old', 'BLOCKED', DEADLOCK);
    endRun(l, 'orb-new', 'BLOCKED', { ...DEADLOCK, review_gate: ['x'] });
    const clock = new ManualClock(Date.UTC(2026, 9, 5, 12, 0, 0));
    l.db().run('UPDATE runs SET created_at = ? WHERE id = ?', clock.now() - 10 * 86_400_000, 'orb-old');
    l.db().run('UPDATE runs SET created_at = ? WHERE id = ?', clock.now() - 1 * 86_400_000, 'orb-new');
    const r = await retro(l, ['--since', '3d', '--json'], fake(null), { clock });
    const j = JSON.parse(r.out) as { window: { since: string }; proposals: { runs: string[] }[] };
    expect(j.window.since).toBe('2026-10-02T12:00:00.000Z');
    expect(j.proposals.map((p) => p.runs)).toEqual([['orb-new']]);
    const none = await retro(l, ['--since', '2026-10-05'], fake(null), { clock });
    expect(none.out).toContain('No proposals from runs created since 2026-10-05T00:00:00.000Z');
  });

  it('a bad --since or --issue-repo is a usage error naming retro, before anything is read or written', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    const deps = fake(true);
    for (const argv of [['--since', 'yesterday'], ['--issue-repo', 'not a repo'], ['--issue-repo', '../x/y']]) {
      await expect(retro(l, argv, deps)).rejects.toThrow(UsageError);
    }
    await expect(retro(l, ['--since', 'yesterday'], deps)).rejects.toMatchObject({ usage: RETRO_USAGE, message: expect.stringContaining('--since must be an ISO date or time') });
    expect(deps.asked).toEqual([]);
    expect(draftFiles(l)).toEqual([]);
    expect(listDecisions(l.db())).toEqual([]);
  });

  it('is a command of the CLI: from a terminal-less run it drafts, sends nothing and says how to file it', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    // The suite may itself run inside an Orbit worker; this is a person's shell.
    const env = { ...process.env, HOME: l.home, ORBIT_HOME: join(l.home, '.orbit'), ORBIT_WORKER: undefined, ORBIT_POLICY_HASH: undefined, ORBIT_POLICY_PATH: undefined };
    const r = await l.cli(['retro'], { env });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('1 proposal(s)');
    expect(r.out).toContain('no one was asked');
    expect(r.out).toContain('gh issue create --repo QuintinBotes/orbit');
    const bad = await l.cli(['retro', '--since', 'soon'], { env });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('usage: orbit retro');
    expect((await l.cli(['help'], { env })).out).toContain('retro');
  });

  it('is refused inside a worker, which can neither write a draft nor send an issue', async () => {
    const l = lab();
    endRun(l, 'orb-dead-1', 'BLOCKED', DEADLOCK);
    const r = await l.cli(['retro'], { env: { ...process.env, HOME: l.home, ORBIT_HOME: join(l.home, '.orbit'), ORBIT_WORKER: '1' } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('refused inside a worker');
    expect(draftFiles(l)).toEqual([]);
    expect(listDecisions(l.db())).toEqual([]);
  });
});

describe('orbit retro: repeated failures become one proposal (AC-1, FR-001, FR-002, SC-002)', () => {
  it('AC-1: three runs with the same failure class and signature give one proposal citing those runs', async () => {
    const l = lab();
    // Three runs that lost their turns to the same policy denial, and one that lost them to another.
    for (const id of ['orb-tc-1', 'orb-tc-2', 'orb-tc-3']) endRun(l, id, 'EXHAUSTED', null, { cause: 'turn-cap', denials: ['bash.unparseable'] });
    endRun(l, 'orb-tc-other', 'EXHAUSTED', null, { cause: 'turn-cap', denials: ['dependencies.add_packages'] });
    const r = await retro(l, ['--json'], fake(null));
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { proposals: { kind: string; failure_class: string; signature: string; runs: string[]; draft: string; outcome: string }[] };
    expect(j.proposals.map((p) => [p.kind, p.failure_class, p.signature, p.runs, p.outcome])).toEqual([['policy', 'turn-cap', 'denied:bash.unparseable', ['orb-tc-1', 'orb-tc-2', 'orb-tc-3'], 'drafted']]);
    const text = readFileSync(join(l.repo, j.proposals[0]!.draft), 'utf8');
    for (const expected of ['orb-tc-1', 'orb-tc-2', 'orb-tc-3', '`bash.unparseable` denied calls in every one of these runs', 'worker_turns_per_session']) expect(text).toContain(expected);
    // The denied command and its path are the run's, not the draft's.
    for (const forbidden of ['orb-tc-other', 'vitest', 'secret.test.ts', l.repo]) expect(text, forbidden).not.toContain(forbidden);
  });

  it('FR-002: the kind follows the class: a review dispute is a reviewer standard when no declared check is missing, the rest a policy change', async () => {
    const l = lab();
    for (const id of ['orb-rd-1', 'orb-rd-2']) endRun(l, id, 'BLOCKED', { open_findings: [{ id: 'f1', claim: 'privateBilling rounds wrong' }] });
    for (const id of ['orb-sc-1', 'orb-sc-2']) endRun(l, id, 'BLOCKED', { scope: { within_scope: false } });
    for (const id of ['orb-x-1', 'orb-x-2']) endRun(l, id, 'CANCELLED', null);
    const r = await retro(l, ['--json'], fake(null));
    const j = JSON.parse(r.out) as { proposals: { kind: string; failure_class: string; signature: string; runs: string[] }[] };
    expect(j.proposals.map((p) => [p.kind, p.failure_class, p.signature, p.runs])).toEqual([
      ['standard', 'review-dispute', 'open_findings', ['orb-rd-1', 'orb-rd-2']],
      ['policy', 'scope', 'scope', ['orb-sc-1', 'orb-sc-2']],
    ]);
    expect(readFileSync(join(l.repo, '.orbit', 'runs', 'retro-drafts', draftFiles(l).find((f) => f.startsWith('standard'))!), 'utf8')).not.toContain('privateBilling');
  });

  it('SC-002: runs with no repeated failure make no proposal, and a declined proposal is not made again', async () => {
    const l = lab();
    endRun(l, 'orb-tc', 'EXHAUSTED', null, { cause: 'turn-cap', denials: ['bash.unparseable'] });
    endRun(l, 'orb-scope', 'BLOCKED', { scope: { within_scope: false } });
    endRun(l, 'orb-rd', 'BLOCKED', { open_findings: [{ id: 'f1' }] });
    endRun(l, 'orb-env', 'BLOCKED', { environment_failures: [{ check_id: 'unit' }] });
    const deps = fake(true);
    const none = await retro(l, [], deps);
    expect(none.out).toContain('No proposals from all runs');
    expect(deps.asked).toEqual([]);
    expect(draftFiles(l)).toEqual([]);

    endRun(l, 'orb-tc-2', 'EXHAUSTED', null, { cause: 'turn-cap', denials: ['bash.unparseable'] });
    const no = fake(false);
    expect((await retro(l, [], no)).out).toContain('declined: nothing was applied');
    expect(no.asked[0]).toContain('Orbit changes nothing');
    endRun(l, 'orb-tc-3', 'EXHAUSTED', null, { cause: 'turn-cap', denials: ['bash.unparseable'] });
    const again = fake(true);
    expect((await retro(l, [], again)).out).toContain('1 proposal(s) were answered before and are not repeated');
    expect(again.asked).toEqual([]);
  });
});

describe('orbit retro: an approved check is added to the configuration on a branch (AC-2)', () => {
  const GIT_ID = { GIT_AUTHOR_NAME: 'alice', GIT_AUTHOR_EMAIL: 'alice@acme.test', GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: 'alice@acme.test' };
  const git = (l: Lab, ...a: string[]): string => execFileSync('git', a, { cwd: l.repo, env: { ...process.env, ...GIT_ID, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' }).toString().trim();
  const CONFIG = 'version: 1\n# the tests this repository trusts\nchecks:\n  unit:\n    command: [npm, test]\n    category: test\n';

  /** A repository that declares a lint script its committed Orbit configuration does not run, and two runs that ended in the same review dispute. */
  function disputed(config = CONFIG): Lab {
    const l = lab();
    writeFileSync(join(l.repo, 'package.json'), JSON.stringify({ name: 'acme', scripts: { test: 'vitest run', lint: 'eslint .' } }));
    mkdirSync(join(l.repo, '.orbit'), { recursive: true });
    writeFileSync(join(l.repo, '.orbit', 'config.yaml'), config);
    git(l, 'add', 'package.json', '.orbit/config.yaml');
    git(l, 'commit', '-q', '-m', 'orbit config');
    for (const id of ['orb-rd-1', 'orb-rd-2']) endRun(l, id, 'BLOCKED', { open_findings: [{ id: 'f1' }] });
    return l;
  }
  const run = (l: Lab, deps: RetroDeps, argv: string[] = []) => retro(l, argv, deps, { env: { ...process.env, ...GIT_ID, HOME: l.home } });

  it('a yes commits the check on a new branch from the base branch; the base branch, the index and the checkout stay as they were', async () => {
    const d = disputed();
    const base = git(d, 'rev-parse', 'main');
    const yes = fake(true);
    const r = await run(d, yes);
    expect(r.code, r.err).toBe(0);
    expect(yes.asked).toEqual(['Add the check lint to .orbit/config.yaml in a commit on the new branch orbit/retro/check-lint? The base branch and your checkout are not touched.']);
    expect(yes.sent).toEqual([]);
    expect(r.out).toContain('check: Add a check lint: runs ended in review-dispute (open_findings)');
    expect(r.out).toContain('cites 2 run(s): orb-rd-1, orb-rd-2');
    expect(r.out).toContain('added on branch orbit/retro/check-lint');

    // On the branch: one commit on the base tip, changing only the configuration, which Orbit accepts and which keeps what was there.
    expect(git(d, 'rev-parse', 'orbit/retro/check-lint^')).toBe(base);
    expect(git(d, 'diff', '--name-only', 'main', 'orbit/retro/check-lint')).toBe('.orbit/config.yaml');
    const onBranch = git(d, 'show', 'orbit/retro/check-lint:.orbit/config.yaml');
    expect(onBranch).toContain('# the tests this repository trusts');
    const parsed = parseConfig(onBranch);
    expect(parsed.checks.lint).toMatchObject({ command: ['npm', 'run', 'lint'], category: 'lint' });
    expect(parsed.checks.unit).toMatchObject({ command: ['npm', 'test'], category: 'test' });
    // Not on the base branch, not in the checkout, not in the index; HEAD is where it was.
    expect(git(d, 'rev-parse', 'main')).toBe(base);
    expect(git(d, 'show', 'main:.orbit/config.yaml')).toBe(CONFIG.trimEnd());
    expect(readFileSync(join(d.repo, '.orbit', 'config.yaml'), 'utf8')).toBe(CONFIG);
    expect(git(d, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(git(d, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(d, 'diff', '--name-only')).toBe('');

    expect(findDecision(d.db(), 'check:review-dispute:open_findings')).toMatchObject({ decision: 'applied', decidedBy: 'alice', runIds: ['orb-rd-1', 'orb-rd-2'] });
    const again = await run(d, fake(true));
    expect(again.out).toContain('1 proposal(s) were answered before and are not repeated');
  });

  it('runs no hook of the repository: a reference-transaction hook that refuses every ref update does not stop it', async () => {
    const d = disputed();
    const hook = join(d.repo, '.git', 'hooks', 'reference-transaction');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    const r = await run(d, fake(true));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('added on branch orbit/retro/check-lint');
  });

  it('builds the branch from the base branch tip and its committed configuration, wherever the checkout stands', async () => {
    const d = disputed();
    const base = git(d, 'rev-parse', 'main');
    git(d, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(d.repo, 'notes.txt'), 'work in progress\n');
    git(d, 'add', 'notes.txt');
    git(d, 'commit', '-q', '-m', 'wip');
    writeFileSync(join(d.repo, '.orbit', 'config.yaml'), `${CONFIG}# not committed\n`);
    const r = await run(d, fake(true));
    expect(r.code, r.err).toBe(0);
    expect(git(d, 'rev-parse', 'orbit/retro/check-lint^')).toBe(base);
    expect(git(d, 'show', 'orbit/retro/check-lint:.orbit/config.yaml')).not.toContain('# not committed');
    expect(git(d, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature');
    expect(readFileSync(join(d.repo, '.orbit', 'config.yaml'), 'utf8')).toContain('# not committed');
  });

  it('nothing is applied without a yes: a no, or nobody to ask, creates no branch', async () => {
    const d = disputed();
    const before = git(d, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
    const pending = await run(d, fake(null), ['--json']);
    expect(JSON.parse(pending.out)).toMatchObject({ proposals: [{ kind: 'check', outcome: 'drafted' }] });
    const no = await run(d, fake(false));
    expect(no.out).toContain('declined: nothing was applied');
    expect(git(d, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(before);
    expect(findDecision(d.db(), 'check:review-dispute:open_findings')?.decision).toBe('declined');
  });

  it('never replaces a branch that exists: the apply fails, the draft stays pending, and the exit is non-zero', async () => {
    const d = disputed();
    git(d, 'branch', 'orbit/retro/check-lint');
    const mine = git(d, 'rev-parse', 'orbit/retro/check-lint');
    const r = await run(d, fake(true));
    expect(r.code).toBe(1);
    expect(r.out).toContain('not applied: git update-ref failed');
    expect(git(d, 'rev-parse', 'orbit/retro/check-lint')).toBe(mine);
    expect(findDecision(d.db(), 'check:review-dispute:open_findings')?.decision).toBe('drafted');
  });

  it('a yes to a second proposal of the same check finds it on the branch the first yes made', async () => {
    const d = disputed();
    // Another review-dispute signature proposes the same missing check.
    for (const id of ['orb-hf-1', 'orb-hf-2']) endRun(d, id, 'BLOCKED', { held_findings: [{ id: 'f2' }] });
    const yes = fake(true);
    const r = await run(d, yes);
    expect(r.code, r.err).toBe(0);
    expect(yes.asked).toHaveLength(2);
    expect(listDecisions(d.db()).map((x) => `${x.key} ${x.decision}`).sort()).toEqual(['check:review-dispute:held_findings applied', 'check:review-dispute:open_findings applied']);
    expect(git(d, 'rev-list', '--count', 'main..orbit/retro/check-lint')).toBe('1');
  });

  it('a configuration that already runs a check of every declared category gets a reviewer standard instead', async () => {
    const d = disputed(`${CONFIG}  lint:\n    command: [npm, run, lint]\n    category: lint\n`);
    const r = await run(d, fake(null), ['--json']);
    expect(JSON.parse(r.out)).toMatchObject({ proposals: [{ kind: 'standard', failure_class: 'review-dispute' }] });
  });
});

describe('orbit retro: the person is asked on a terminal, and only an explicit yes counts', () => {
  const ctxWith = (tty: boolean) => createContext({ io: { ...memoryIo(), stdoutIsTty: tty } });

  async function answer(text: string, tty = true, stdinTty = true): Promise<boolean | null> {
    const input = Object.assign(new PassThrough(), { isTTY: stdinTty });
    const output = new PassThrough();
    const pending = terminalAsk(ctxWith(tty), input, output)('Send it?');
    input.write(`${text}\n`);
    return pending;
  }

  it.each([['y', true], ['YES', true], [' yes ', true], ['n', false], ['', false], ['yep', false], ['sure', false]])('answer %j is %s', async (text, expected) => {
    expect(await answer(text)).toBe(expected);
  });

  it('takes the end of input (Ctrl-D) as no answer, and asks nothing after it', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const ask = terminalAsk(ctxWith(true), input, new PassThrough());
    const pending = ask('Send it?');
    input.end();
    expect(await pending).toBeNull();
    expect(await ask('And this?')).toBeNull();
  });

  it('cannot ask without a terminal on both ends', async () => {
    expect(await terminalAsk(ctxWith(false), Object.assign(new PassThrough(), { isTTY: true }))('?')).toBeNull();
    expect(await terminalAsk(ctxWith(true), new PassThrough())('?')).toBeNull();
  });
});

describe('orbit retro: the gh sender', () => {
  it('reports a gh that cannot run, without the paths in its message', async () => {
    const ctx = createContext({ env: { PATH: '/nonexistent-dir-for-orbit-retro' } });
    await expect(ghSend(ctx)({ repo: 'acme/x', title: 't', body: 'b', cwd: process.cwd() })).rejects.toThrow(/gh/);
  });
});

describe('draft file names', () => {
  it('are stable, safe and distinct per proposal', () => {
    const a = draftFileName('issue-draft:gate-deadlock:questions+gate');
    expect(a).toMatch(/^issue-draft-gate-deadlock-questions-gate-[0-9a-f]{8}\.md$/);
    expect(draftFileName('issue-draft:gate-deadlock:questions+gate')).toBe(a);
    expect(draftFileName('issue-draft:gate-deadlock:questions-gate')).not.toBe(a);
    expect(draftFileName('../../etc/passwd')).toMatch(/^etc-passwd-[0-9a-f]{8}\.md$/);
  });
});
