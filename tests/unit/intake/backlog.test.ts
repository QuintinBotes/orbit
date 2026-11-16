/**
 * Planning a backlog of issues (issue #171): the frontier, why every other issue waits, and dependency cycles. Pure:
 * the issues are built here as GitHub would report them.
 */
import { describe, expect, it } from 'vitest';
import { blockingCycles, planBacklog } from '../../../src/intake/backlog.ts';
import type { IssueInfo } from '../../../src/intake/github.ts';

const READY = 'ready-for-agent';
const HUMAN = 'ready-for-human';

function issue(number: number, o: { open?: boolean; labels?: string[]; blockedBy?: number[]; title?: string } = {}, all?: Map<number, boolean>): IssueInfo {
  return {
    repo: 'acme/app',
    number,
    title: o.title ?? `Issue ${number}`,
    body: '',
    open: o.open ?? true,
    stateReason: null,
    locked: false,
    isPullRequest: false,
    labels: o.labels ?? [READY],
    updatedAt: '',
    url: '',
    blockedBy: (o.blockedBy ?? []).map((n) => ({ repo: 'acme/app', number: n, open: all?.get(n) ?? true })),
  };
}

/** A backlog in priority order, each blocker's state taken from the backlog itself. */
function backlog(specs: [number, { open?: boolean; labels?: string[]; blockedBy?: number[]; title?: string }][]): IssueInfo[] {
  const open = new Map(specs.map(([n, o]) => [n, o.open ?? true]));
  return specs.map(([n, o]) => issue(n, o, open));
}

const plan = (issues: IssueInfo[], owned: [number, string][] = []) => planBacklog(issues, { label: READY, humanLabel: HUMAN, owned: new Map(owned) });

describe('the frontier', () => {
  it('story 1: of A, B and C where B blocks C, A and B are the frontier and C waits for B', () => {
    const p = plan(backlog([[1, { title: 'A' }], [2, { title: 'B' }], [3, { title: 'C', blockedBy: [2] }]]));
    expect(p.frontier).toEqual([
      { number: 1, title: 'A' },
      { number: 2, title: 'B' },
    ]);
    expect(p.held).toEqual([{ number: 3, title: 'C', reason: 'blocked by #2 (open)', blockedBy: [2] }]);
    // Once B is closed, C is in the frontier.
    expect(plan(backlog([[1, {}], [2, { open: false }], [3, { blockedBy: [2] }]])).frontier.map((f) => f.number)).toEqual([1, 3]);
  });

  it('keeps the backlog order, which is the priority order', () => {
    expect(plan(backlog([[9, {}], [3, {}], [5, {}]])).frontier.map((f) => f.number)).toEqual([9, 3, 5]);
  });

  it('never takes an issue labelled ready-for-human, nor one without ready-for-agent; label names compare without case', () => {
    const p = plan(backlog([[1, { labels: [READY, HUMAN] }], [2, { labels: ['spec'] }], [3, { labels: ['Ready-For-Agent'] }]]));
    expect(p.frontier.map((f) => f.number)).toEqual([3]);
    expect(p.ignored).toEqual([
      { number: 1, title: 'Issue 1', reason: 'labelled ready-for-human: a person decides' },
      { number: 2, title: 'Issue 2', reason: 'not labelled ready-for-agent' },
    ]);
  });

  it('story 1, scenario 2: a dependant of an issue handed to a person is held, and says which blocker and why', () => {
    const p = plan(backlog([[1, { labels: [READY, HUMAN] }], [2, {}], [3, { blockedBy: [1] }], [4, { blockedBy: [3] }]]));
    expect(p.frontier.map((f) => f.number)).toEqual([2]);
    expect(p.held).toEqual([
      { number: 3, title: 'Issue 3', reason: 'blocked by #1 (needs a person: labelled ready-for-human)', blockedBy: [1] },
      { number: 4, title: 'Issue 4', reason: 'blocked by #3 (itself blocked)', blockedBy: [3] },
    ]);
  });

  it('holds an issue Orbit already owns (an unfinished run, a delivery waiting to merge), and names it as a blocker', () => {
    const p = plan(backlog([[1, {}], [2, { blockedBy: [1] }]]), [[1, 'delivered: pull request #7 waits to be merged into next']]);
    expect(p.frontier).toEqual([]);
    expect(p.held.map((h) => [h.number, h.reason])).toEqual([
      [1, 'delivered: pull request #7 waits to be merged into next'],
      [2, 'blocked by #1 (delivered: pull request #7 waits to be merged into next)'],
    ]);
  });

  it('names a blocker outside the backlog or in another repository', () => {
    const i = issue(5, { blockedBy: [99] });
    i.blockedBy.push({ repo: 'acme/lib', number: 4, open: true }, { repo: 'acme/lib', number: 6, open: false });
    expect(plan([i]).held[0]!.reason).toBe('blocked by #99 (open), acme/lib#4 (open)');
  });
});

describe('dependency cycles', () => {
  it('reports issues that block one another, and none of them, nor what they block, runs', () => {
    const p = plan(backlog([[1, { blockedBy: [3] }], [2, { blockedBy: [1] }], [3, { blockedBy: [2] }], [4, { blockedBy: [2] }], [5, {}], [6, { blockedBy: [6] }]]));
    expect(p.cycles).toEqual([[1, 2, 3], [6]]);
    expect(p.frontier.map((f) => f.number)).toEqual([5]);
    expect(p.held.find((h) => h.number === 1)!.reason).toBe('in a dependency cycle (#1, #2, #3 block one another); none of them runs until a person breaks it');
    expect(p.held.find((h) => h.number === 4)!.reason).toBe('blocked by #2 (itself blocked)');
    expect(p.held.find((h) => h.number === 6)!.reason).toBe('in a dependency cycle (#6 blocks itself); none of them runs until a person breaks it');
  });

  it('a closed issue breaks a cycle, and a long chain is no cycle', () => {
    expect(blockingCycles(backlog([[1, { blockedBy: [2] }], [2, { open: false, blockedBy: [1] }]]))).toEqual([]);
    const chain = backlog(Array.from({ length: 5000 }, (_, i) => [i + 1, { blockedBy: i === 0 ? [] : [i] }] as [number, { blockedBy: number[] }]));
    expect(blockingCycles(chain)).toEqual([]);
  });
});

describe('the backlog of orbit#165, as the queue will see it once #166, #167, #170 and #171 are closed', () => {
  // The parent's table: order, spec, blocked by. GitHub holds the same links as issue dependencies.
  const TABLE: [number, number[]][] = [
    [166, []],
    [167, [166]],
    [168, [166]],
    [169, [166]],
    [170, [166]],
    [171, [170]],
    [172, [167]],
    [173, [167, 172]],
    [174, [167]],
    [175, [172]],
    [176, [168, 172]],
    [177, [167, 168]],
    [178, [166]],
  ];
  const CLOSED = new Set([166, 167, 170, 171]);
  const issues = (): IssueInfo[] => backlog(TABLE.map(([n, by]) => [n, { open: !CLOSED.has(n), labels: ['spec', READY], blockedBy: by }]));

  it('the frontier is every unblocked spec, in the table order, and the rest wait on #168 and #172', () => {
    const p = plan(issues());
    expect(p.frontier.map((f) => f.number)).toEqual([168, 169, 172, 174, 178]);
    expect(p.held.map((h) => [h.number, h.reason])).toEqual([
      [173, 'blocked by #172 (open)'],
      [175, 'blocked by #172 (open)'],
      [176, 'blocked by #168 (open), #172 (open)'],
      [177, 'blocked by #168 (open)'],
    ]);
    expect(p.cycles).toEqual([]);
  });

  it('after #168 and #172 are delivered and their pull requests merged (the issues closed), the four that waited come next', () => {
    const merged = issues().map((i) => (i.number === 168 || i.number === 172 ? { ...i, open: false } : { ...i, blockedBy: i.blockedBy.map((b) => (b.number === 168 || b.number === 172 ? { ...b, open: false } : b)) }));
    expect(plan(merged, [[169, 'delivered: pull request #190 waits to be merged into next']]).frontier.map((f) => f.number)).toEqual([173, 174, 175, 176, 177, 178]);
  });
});
