/**
 * Separable work units for parallel writers within one run (spec section 8: "spawn extra workers only for
 * bounded independent units"; "separable changes in isolated worktrees"; "bad parallelism: shared-file edits").
 *
 * The planner maps every criterion to the files it expects to change. Criteria whose files could overlap are
 * one unit (conservative glob overlap: a wrong "overlap" only serializes); units are therefore pairwise disjoint
 * in what they own. A criterion with no mapped file cannot be bounded, so the plan stays a single writer, as it
 * does when everything collapses into one unit. Plain data in and out: the controller persists the result.
 */
import { pathsOverlap } from './scheduler.ts';

export interface CriterionFiles {
  /** Contract criterion id (AC-n). */
  id: string;
  /** Repository-relative paths (or globs) the planner expects this criterion to change. */
  paths: string[];
}

export interface WorkUnitPlan {
  /** Stable within the attempt: u1, u2, ... in criterion order. */
  id: string;
  criteria: string[];
  /** What the unit's writer owns: the union of its criteria's paths, sorted. */
  ownedPaths: string[];
}

/** Disjoint work units for the criteria, or null when the work cannot be split into at least two of them. */
export function planWorkUnits(criteria: readonly CriterionFiles[]): WorkUnitPlan[] | null {
  if (criteria.length < 2) return null;
  const paths = criteria.map((c) => [...new Set(c.paths.map((p) => p.trim()).filter((p) => p.length > 0))]);
  if (paths.some((p) => p.length === 0)) return null;
  // Union-find over criteria: two criteria whose paths may overlap belong to one unit.
  const parent = criteria.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < criteria.length; i++) {
    for (let j = i + 1; j < criteria.length; j++) {
      if (pathsOverlap(paths[i]!, paths[j]!)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < criteria.length; i++) {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  if (groups.size < 2) return null;
  const ordered = [...groups.values()].sort((a, b) => a[0]! - b[0]!);
  return ordered.map((members, k) => ({
    id: `u${k + 1}`,
    criteria: members.map((i) => criteria[i]!.id),
    ownedPaths: [...new Set(members.flatMap((i) => paths[i]!))].sort(),
  }));
}
