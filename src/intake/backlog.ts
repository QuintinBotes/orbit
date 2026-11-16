/**
 * Which issue of a backlog runs next (docs/decisions/0020-backlog-queue.md). Pure: it judges issues as GitHub reported
 * them a moment ago, plus what Orbit's own runs say about them, and changes nothing.
 *
 * The frontier is every open issue that carries the queue's label, does not carry the label that hands it to a person,
 * has no open blocking issue (GitHub's issue dependencies) and is not already Orbit's (an unfinished run, or a
 * delivered one waiting to be merged). It keeps the backlog's order, which is the priority order. Every other open
 * issue of the backlog is held with the reason, and issues that block one another are reported as a cycle: none of
 * them can ever reach the frontier.
 */
import { hasLabel, type IssueInfo } from './github.ts';

export interface HeldIssue {
  number: number;
  title: string;
  /** One line: why the issue does not run now. */
  reason: string;
  /** The open issues that block it, by number. */
  blockedBy: number[];
}

export interface BacklogPlan {
  /** Runnable now, in priority order. */
  frontier: { number: number; title: string }[];
  /** Open issues that carry the label but cannot run now. */
  held: HeldIssue[];
  /** Open issues the queue never takes: without the label, or labelled for a person. */
  ignored: { number: number; title: string; reason: string }[];
  /** Sets of issues that block one another, each in ascending order. */
  cycles: number[][];
}

export interface PlanOptions {
  /** The label an issue must carry to be taken (ready-for-agent). */
  label: string;
  /** The label that hands an issue to a person (ready-for-human): such an issue is never taken. */
  humanLabel: string;
  /** Issues Orbit already holds, with the reason: an unfinished run, or a delivered result waiting to be merged. */
  owned: ReadonlyMap<number, string>;
}

/** The sets of open issues that block one another (strongly connected components of more than one issue, or one that blocks itself). */
export function blockingCycles(issues: readonly Pick<IssueInfo, 'number' | 'open' | 'blockedBy'>[]): number[][] {
  const open = new Map(issues.filter((i) => i.open).map((i) => [i.number, i]));
  const edges = (n: number): number[] => (open.get(n)?.blockedBy ?? []).filter((b) => b.open && open.has(b.number)).map((b) => b.number);
  // Tarjan's algorithm, iterative so a long chain cannot overflow the stack.
  let next = 0;
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const out: number[][] = [];
  for (const root of open.keys()) {
    if (index.has(root)) continue;
    const work: { n: number; i: number }[] = [{ n: root, i: 0 }];
    index.set(root, next);
    low.set(root, next++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const succ = edges(top.n);
      if (top.i < succ.length) {
        const m = succ[top.i++]!;
        if (!index.has(m)) {
          index.set(m, next);
          low.set(m, next++);
          stack.push(m);
          onStack.add(m);
          work.push({ n: m, i: 0 });
        } else if (onStack.has(m)) low.set(top.n, Math.min(low.get(top.n)!, index.get(m)!));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.n;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.n)!));
      }
      if (low.get(top.n) === index.get(top.n)) {
        const component: number[] = [];
        for (;;) {
          const m = stack.pop()!;
          onStack.delete(m);
          component.push(m);
          if (m === top.n) break;
        }
        if (component.length > 1 || edges(top.n).includes(top.n)) out.push(component.sort((a, b) => a - b));
      }
    }
  }
  return out.sort((a, b) => a[0]! - b[0]!);
}

/** "#4, #7 block one another", or "#4 blocks itself". */
export function describeCycle(cycle: readonly number[]): string {
  return cycle.length === 1 ? `#${cycle[0]} blocks itself` : `${cycle.map((n) => `#${n}`).join(', ')} block one another`;
}

/** The frontier and why every other open issue of the backlog waits. The backlog is in priority order. */
export function planBacklog(backlog: readonly IssueInfo[], opts: PlanOptions): BacklogPlan {
  const byNumber = new Map(backlog.map((i) => [i.number, i]));
  const candidate = (i: IssueInfo): boolean => i.open && !i.isPullRequest && hasLabel(i, opts.label) && !hasLabel(i, opts.humanLabel);
  const cycles = blockingCycles(backlog.filter(candidate));
  const inCycle = new Map<number, number[]>();
  for (const c of cycles) for (const n of c) inCycle.set(n, c);

  const plan: BacklogPlan = { frontier: [], held: [], ignored: [], cycles };
  const why = (n: number): string => {
    const b = byNumber.get(n);
    if (!b) return `#${n} (open)`;
    if (hasLabel(b, opts.humanLabel)) return `#${n} (needs a person: labelled ${opts.humanLabel})`;
    const owned = opts.owned.get(n);
    if (owned) return `#${n} (${owned})`;
    if (!hasLabel(b, opts.label)) return `#${n} (open, not labelled ${opts.label})`;
    if (b.blockedBy.some((x) => x.open)) return `#${n} (itself blocked)`;
    return `#${n} (open)`;
  };
  for (const i of backlog) {
    if (!i.open || i.isPullRequest) continue;
    if (!hasLabel(i, opts.label)) {
      plan.ignored.push({ number: i.number, title: i.title, reason: `not labelled ${opts.label}` });
      continue;
    }
    if (hasLabel(i, opts.humanLabel)) {
      plan.ignored.push({ number: i.number, title: i.title, reason: `labelled ${opts.humanLabel}: a person decides` });
      continue;
    }
    const blockers = i.blockedBy.filter((b) => b.open);
    const blockedBy = blockers.map((b) => b.number);
    const owned = opts.owned.get(i.number);
    const cycle = inCycle.get(i.number);
    if (owned) plan.held.push({ number: i.number, title: i.title, reason: owned, blockedBy });
    else if (cycle) plan.held.push({ number: i.number, title: i.title, reason: `in a dependency cycle (${describeCycle(cycle)}); none of them runs until a person breaks it`, blockedBy });
    else if (blockers.length > 0) plan.held.push({ number: i.number, title: i.title, reason: `blocked by ${blockers.map((b) => (b.repo.toLowerCase() === i.repo.toLowerCase() ? why(b.number) : `${b.repo}#${b.number} (open)`)).join(', ')}`, blockedBy });
    else plan.frontier.push({ number: i.number, title: i.title });
  }
  return plan;
}
