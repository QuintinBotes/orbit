/**
 * `orbit retro`, the issue-draft part, through the real CLI as a child process and the real `gh` sender against a
 * stand-in `gh` on PATH (issue #174, AC-3): a run that ended in `gate-deadlock` yields a draft file with paths redacted,
 * the person is asked before anything is sent, and nothing reaches `gh` without an explicit yes at a terminal.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCommand } from '../../../src/cli/args.ts';
import { createContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { ghSend, RETRO_OPTIONS, RETRO_USAGE, runRetro, terminalAsk } from '../../../src/cli/commands/retro.ts';
import { stateDbPath } from '../../../src/controller/start.ts';
import { openDb } from '../../../src/storage/db.ts';
import { findDecision, listDecisions } from '../../../src/observability/retro.ts';
import { DEADLOCK_OUTCOME, seedRuns, writeFakeGh } from '../../support/retro-runs.ts';
import { makeSandbox, type Sandbox } from './helpers.ts';

const boxes: Sandbox[] = [];
const sandbox = (): Sandbox => {
  const s = makeSandbox();
  boxes.push(s);
  return s;
};
afterEach(() => boxes.splice(0).forEach((s) => s.close()));

const KEY = 'issue-draft:gate-deadlock:blocked_criteria+questions';
const SECRET = 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
const draftDir = (s: Sandbox): string => join(s.repo, '.orbit', 'runs', 'retro-drafts');
const drafts = (s: Sandbox): string[] => (existsSync(draftDir(s)) ? readdirSync(draftDir(s)) : []);
const readDraft = (s: Sandbox): string => readFileSync(join(draftDir(s), drafts(s)[0]!), 'utf8');

/** A repository whose state holds a run that ended held at a gate, with an absolute path and a secret in everything a person typed or a model said. */
function deadlocked(s: Sandbox): void {
  const where = join(s.repo, 'src', 'billing.ts');
  seedRuns(s.repo, [
    {
      id: 'orb-dead-1',
      state: 'BLOCKED',
      outcome: { ...DEADLOCK_OUTCOME, questions: [{ id: 'q1', question: `rate in ${where}? ${SECRET}` }] },
      goal: `Fix the rate in ${where} using ${SECRET}`,
      reason: `waiting for a decision about ${where}`,
    },
  ]);
}

function ghLog(s: Sandbox): string {
  const log = join(s.base, 'gh.log');
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
}

describe('orbit retro (CLI): a gate-deadlock run becomes a redacted draft and nothing is sent unasked', () => {
  it('writes the draft with the run evidence and no path or secret, asks no one in a pipe, and never calls gh even when stdin says yes', async () => {
    const s = sandbox();
    deadlocked(s);
    writeFakeGh(s.tools, join(s.base, 'gh.log'));
    const r = await s.run(['retro'], { input: 'y\nyes\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('1 proposal(s)');
    expect(r.stdout).toContain('cites 1 run(s): orb-dead-1');
    expect(r.stdout).toContain('nothing was sent (no one was asked');
    expect(drafts(s)).toHaveLength(1);

    const text = readDraft(s);
    for (const expected of ['orb-dead-1', 'gate-deadlock', 'BLOCKED', 'blocked_criteria (1)', 'questions (1)', 'PREFLIGHT > CONTRACTING > PLANNING > BLOCKED']) expect(text).toContain(expected);
    for (const forbidden of [s.base, s.repo, s.home, 'billing.ts', SECRET, 'sk-ant', 'Fix the rate', 'waiting for a decision']) {
      expect(text, forbidden).not.toContain(forbidden);
      expect(r.stdout, forbidden).not.toContain(forbidden);
      expect(r.stderr, forbidden).not.toContain(forbidden);
    }
    // No gh call at all: the stand-in would have logged its arguments.
    expect(ghLog(s)).toBe('');
    expect(existsSync(join(s.base, 'gh.log'))).toBe(false);
  });

  it('keeps an unanswered draft pending: a retro without a terminal makes it again, in the same file, under one record', async () => {
    const s = sandbox();
    deadlocked(s);
    const first = await s.run(['retro', '--json']);
    const j = JSON.parse(first.stdout) as { proposals: { kind: string; failure_class: string; signature: string; runs: string[]; outcome: string; draft: string }[]; already_decided: number };
    expect(j.proposals).toHaveLength(1);
    expect(j.proposals[0]).toMatchObject({ kind: 'issue-draft', failure_class: 'gate-deadlock', signature: 'blocked_criteria+questions', runs: ['orb-dead-1'], outcome: 'drafted' });
    expect(j.already_decided).toBe(0);
    expect(existsSync(join(s.repo, j.proposals[0]!.draft))).toBe(true);

    for (let again = 0; again < 2; again++) {
      const next = await s.run(['retro']);
      expect(next.code, next.stderr).toBe(0);
      expect(next.stdout).toContain('1 proposal(s)');
      expect(next.stdout).toContain('nothing was sent (no one was asked');
    }
    expect(drafts(s)).toHaveLength(1);
    const db = openDb(stateDbPath(s.repo));
    try {
      expect(listDecisions(db).map((d) => [d.key, d.decision, d.runIds])).toEqual([[KEY, 'drafted', ['orb-dead-1']]]);
    } finally {
      db.close();
    }
  });

  it('proposes nothing, and says so, for a window without a deadlock, other classes, or a run that succeeded; a bad --since is a usage error that touches nothing', async () => {
    const s = sandbox();
    seedRuns(s.repo, [
      { id: 'orb-ok', state: 'SUCCEEDED', outcome: null },
      { id: 'orb-scope', state: 'BLOCKED', outcome: { scope: { within_scope: false } } },
    ]);
    const none = await s.run(['retro']);
    expect(none.code, none.stderr).toBe(0);
    expect(none.stdout).toContain('No proposals from all runs');
    expect(drafts(s)).toEqual([]);

    const future = await s.run(['retro', '--since', '2999-01-01']);
    expect(future.code, future.stderr).toBe(0);
    expect(future.stdout).toContain('No proposals from runs created since 2999-01-01T00:00:00.000Z');

    const bad = await s.run(['retro', '--since', 'last tuesday']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--since must be an ISO date or time');
    expect(bad.stderr).toContain('usage: orbit retro');
    expect(drafts(s)).toEqual([]);
  });

  it('with --json never asks and never sends: stdout is only the data', async () => {
    const s = sandbox();
    deadlocked(s);
    writeFakeGh(s.tools, join(s.base, 'gh.log'));
    const r = await s.run(['retro', '--json'], { input: 'y\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(ghLog(s)).toBe('');
  });
});

describe('orbit retro (gh): only an explicit yes at a terminal files the issue', () => {
  /** The command in this process, asked on a pretend terminal that answers `answer`, with the real gh sender and the stand-in gh. */
  async function onTerminal(s: Sandbox, answer: string, argv: string[] = []): Promise<{ code: number; out: string; asked: string }> {
    // Assign onto the capturing io (a spread would copy its getters' current, empty values).
    const io = Object.assign(memoryIo(), { stdoutIsTty: true });
    const ctx = createContext({ io, cwd: s.repo, homeDir: s.home, orbitHome: s.orbitHome, env: { PATH: s.env().PATH, HOME: s.home }, user: 'alice' });
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    let asked = '';
    output.on('data', (d: Buffer) => (asked += d.toString()));
    const ask = terminalAsk(ctx, input, output);
    const code = await runRetro(parseCommand(argv, RETRO_OPTIONS, RETRO_USAGE), ctx, {
      ask: (q) => {
        const pending = ask(q);
        input.write(`${answer}\n`);
        return pending;
      },
      send: ghSend(ctx),
    });
    return { code, out: io.stdout, asked };
  }

  it('a yes files it once with gh, to the named repository, with the redacted body and without the title line, and records it as sent', async () => {
    const s = sandbox();
    deadlocked(s);
    writeFakeGh(s.tools, join(s.base, 'gh.log'));
    const r = await onTerminal(s, 'yes', ['--issue-repo', 'acme/orbit-fork']);
    expect(r.code).toBe(0);
    expect(r.asked).toContain('Nothing is sent without your yes');
    expect(r.out).toContain('sent to acme/orbit-fork: https://github.com/QuintinBotes/orbit/issues/4242');

    const log = ghLog(s);
    const args = log.split('\n');
    expect(args.slice(0, 5)).toEqual(['issue', 'create', '--repo', 'acme/orbit-fork', '--title']);
    expect(log).toContain('gate-deadlock');
    expect(log).toContain('orb-dead-1');
    expect(log.match(/^issue$/gm)).toHaveLength(1);
    for (const forbidden of [s.base, s.repo, s.home, 'billing.ts', SECRET]) expect(log, forbidden).not.toContain(forbidden);

    const db = openDb(stateDbPath(s.repo));
    try {
      expect(findDecision(db, KEY)).toMatchObject({ decision: 'sent', decidedBy: 'alice' });
    } finally {
      db.close();
    }
    const again = await s.run(['retro']);
    expect(again.stdout).toContain('No proposals');
    expect(ghLog(s)).toBe(log);
  });

  it.each(['n', '', 'maybe', 'yep'])('the answer %j files nothing, records the decline, and the proposal is not made again', async (answer) => {
    const s = sandbox();
    deadlocked(s);
    writeFakeGh(s.tools, join(s.base, 'gh.log'));
    const r = await onTerminal(s, answer);
    expect(r.code).toBe(0);
    expect(r.out).toContain('declined: nothing was sent');
    expect(ghLog(s)).toBe('');
    const db = openDb(stateDbPath(s.repo));
    try {
      expect(findDecision(db, KEY)?.decision).toBe('declined');
    } finally {
      db.close();
    }
    expect((await s.run(['retro'])).stdout).toContain('are not repeated');
    expect(ghLog(s)).toBe('');
  });
});
