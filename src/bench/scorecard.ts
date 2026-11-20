/**
 * The scorecard `orbit bench` writes: one JSON document per Orbit version and tier, with stable key order so two
 * versions diff cleanly, and a text rendering with the same numbers. The headline carries the per-version false-done
 * rate, with a link to what found each false done.
 *
 * A false done is a run Orbit reported done that was not. Orbit does not collect them; a person records each as a link
 * (the failing hidden check, the review finding, the reopened issue or the revert) in the false-done file the scorecard
 * is built from. A scenario that cannot be judged (its expectation is malformed, or for the live tier its acceptance
 * check does not hold on the reference solution) is `invalid`: it is listed, and left out of every count.
 */
import { join } from 'node:path';
import { FAILURE_CLASSES, type FailureClass } from '../controller/failure-class.ts';

export const SCORECARD_SCHEMA_VERSION = 1;

/** The fields that differ between two otherwise identical runs; everything else in a scorecard is deterministic. */
export const TIMESTAMP_FIELDS: readonly string[] = ['generated_at'];

export type Tier = 'lab' | 'live';
export type ScenarioResult = 'pass' | 'fail' | 'invalid';

export const FALSE_DONE_SOURCES = ['hidden-check', 'review-finding', 'reopened-issue', 'revert'] as const;
export type FalseDoneSource = (typeof FALSE_DONE_SOURCES)[number];

export interface FalseDoneRecord {
  orbit_version: string;
  /** What was wrongly reported done: a pull request, an issue or a scenario id. */
  ref: string;
  found_by: FalseDoneSource;
  link: string;
}

export interface ScenarioRow {
  /** The scenario id; for the live tier the goal id and the run, such as orbit-208#2. */
  id: string;
  /** The issue the scenario or goal was written from: #130 for Orbit's own, else its URL. */
  issue: string;
  title: string;
  result: ScenarioResult;
  /** Why the run ended, from the fixed list of failure classes; null when it did not fail. */
  failure_class: FailureClass | null;
  /** The state the run ended in; null when it did not run. */
  end_state: string | null;
  attempts: number;
  /** Model spend: simulated (the fake providers' reported cost) in the lab tier, billed in the live tier. */
  spend_usd: number;
  /** Wall time of the run; null in the lab tier, whose time says nothing about a model. */
  wall_ms: number | null;
  /** Whether the run was reported done (it delivered). */
  delivered: boolean;
  /** What did not hold, or why the scenario is invalid. */
  problems: string[];
}

export interface Counts {
  scenarios: number;
  valid: number;
  passed: number;
  failed: number;
  invalid: number;
  /** Passed over valid; null when nothing valid ran. */
  pass_rate: number | null;
  attempts: number;
  spend_usd: number;
  /** Spend over passed scenarios (accepted tasks in the live tier); null when none passed. */
  cost_per_pass_usd: number | null;
  wall_ms: number;
}

export interface FalseDoneHeadline {
  delivered: number;
  count: number;
  /** False dones over delivered runs; null when nothing was delivered. */
  rate: number | null;
  records: FalseDoneRecord[];
}

export interface Comparison {
  stage: string;
  with: Counts;
  without: Counts;
  /** Scenarios whose result is not the same with the stage off. */
  changed: { id: string; with: ScenarioResult; without: ScenarioResult }[];
}

/** The same goals attempted by one plain `claude -p` session each (live tier, --baseline). */
export interface Baseline {
  counts: Counts;
  rows: ScenarioRow[];
  /** Orbit minus the plain session; null where either side has no value. */
  difference: { pass_rate: number | null; cost_per_pass_usd: number | null };
}

export interface Scorecard {
  schema_version: number;
  tier: Tier;
  orbit_version: string;
  generated_at: string;
  headline: Counts & { false_done: FalseDoneHeadline };
  scenarios: ScenarioRow[];
  comparison: Comparison | null;
  baseline: Baseline | null;
  /** Live tier: who approved the run and the budget it was given; null in the lab tier. */
  approval: { by: string; budget_usd: number } | null;
}

const round = (n: number, digits = 4): number => Number(n.toFixed(digits));

export function countsOf(rows: readonly ScenarioRow[]): Counts {
  const valid = rows.filter((r) => r.result !== 'invalid');
  const passed = valid.filter((r) => r.result === 'pass').length;
  const spend = round(valid.reduce((a, r) => a + r.spend_usd, 0));
  return {
    scenarios: rows.length,
    valid: valid.length,
    passed,
    failed: valid.length - passed,
    invalid: rows.length - valid.length,
    pass_rate: valid.length === 0 ? null : round(passed / valid.length),
    attempts: valid.reduce((a, r) => a + r.attempts, 0),
    spend_usd: spend,
    cost_per_pass_usd: passed === 0 ? null : round(spend / passed),
    wall_ms: valid.reduce((a, r) => a + (r.wall_ms ?? 0), 0),
  };
}

export function falseDoneHeadline(rows: readonly ScenarioRow[], records: readonly FalseDoneRecord[], orbitVersion: string): FalseDoneHeadline {
  const delivered = rows.filter((r) => r.result !== 'invalid' && r.delivered).length;
  const mine = records.filter((r) => r.orbit_version === orbitVersion);
  return { delivered, count: mine.length, rate: delivered === 0 ? null : round(mine.length / delivered), records: mine };
}

export interface BuildInput {
  tier: Tier;
  orbitVersion: string;
  generatedAt: string;
  rows: readonly ScenarioRow[];
  falseDones?: readonly FalseDoneRecord[];
  /** The rows of the same scenarios with one stage off. */
  without?: { stage: string; rows: readonly ScenarioRow[] };
  /** The rows of the plain-session baseline (live tier). */
  baseline?: readonly ScenarioRow[];
  approval?: { by: string; budget_usd: number };
}

const diff = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : round(a - b));

export function buildScorecard(input: BuildInput): Scorecard {
  const rows = input.rows.map((r) => ({ ...r, problems: [...r.problems] }));
  let comparison: Comparison | null = null;
  if (input.without) {
    const off = new Map(input.without.rows.map((r) => [r.id, r.result]));
    comparison = {
      stage: input.without.stage,
      with: countsOf(rows),
      without: countsOf(input.without.rows),
      changed: rows.filter((r) => off.has(r.id) && off.get(r.id) !== r.result).map((r) => ({ id: r.id, with: r.result, without: off.get(r.id)! })),
    };
  }
  return {
    schema_version: SCORECARD_SCHEMA_VERSION,
    tier: input.tier,
    orbit_version: input.orbitVersion,
    generated_at: input.generatedAt,
    headline: { ...countsOf(rows), false_done: falseDoneHeadline(rows, input.falseDones ?? [], input.orbitVersion) },
    scenarios: rows,
    comparison,
    baseline: input.baseline ? baselineOf(countsOf(rows), input.baseline) : null,
    approval: input.approval ?? null,
  };
}

function baselineOf(orbit: Counts, rows: readonly ScenarioRow[]): Baseline {
  const counts = countsOf(rows);
  return { counts, rows: rows.map((r) => ({ ...r, problems: [...r.problems] })), difference: { pass_rate: diff(orbit.pass_rate, counts.pass_rate), cost_per_pass_usd: diff(orbit.cost_per_pass_usd, counts.cost_per_pass_usd) } };
}

/** JSON with keys in sorted order at every level, two-space indent and a final newline: the same data always gives the same bytes. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sort(x)]));
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** Where scorecards are kept in the Orbit checkout, one file per version and tier. */
export const SCORECARD_DIR = join('docs', 'scorecards');

/** orbit-<version>-<tier>.json, with the stage in the name for a run with a stage off. */
export function scorecardFile(orbitVersion: string, tier: Tier, without?: string | null): string {
  return `orbit-${orbitVersion}-${tier}${without ? `-without-${without}` : ''}.json`;
}

const pct = (r: number | null): string => (r === null ? 'n/a' : `${(r * 100).toFixed(1)}%`);
const usd = (n: number): string => `$${n.toFixed(4)}`;

/** The false-done line of the headline, then one line per false done with the link to what found it. */
export function falseDoneLines(f: FalseDoneHeadline, orbitVersion: string): string[] {
  const head = f.rate === null ? `False-done rate for ${orbitVersion}: n/a (no delivered runs)` : `False-done rate for ${orbitVersion}: ${f.count} of ${f.delivered} delivered runs (${pct(f.rate)})`;
  return [head, ...f.records.map((r) => `  ${r.ref} found by ${r.found_by}: ${r.link}`)];
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(0)}s`;

export function renderScorecard(card: Scorecard): string {
  const h = card.headline;
  const live = card.tier === 'live';
  const spendWord = live ? 'spend' : 'simulated spend';
  const totals = (c: Counts): string => `${c.valid} valid, ${c.passed} passed, ${c.failed} failed, ${c.invalid} invalid; pass rate ${pct(c.pass_rate)}; ${c.attempts} attempts; ${spendWord} ${usd(c.spend_usd)}${live ? `; cost per accepted task ${c.cost_per_pass_usd === null ? 'n/a' : usd(c.cost_per_pass_usd)}; time ${secs(c.wall_ms)}` : ''}`;
  const rowsOf = (rows: readonly ScenarioRow[]): string[] =>
    table(
      ['scenario', 'issue', 'result', 'end state', 'failure class', 'attempts', spendWord, ...(live ? ['time'] : [])],
      rows.map((r) => [r.id, r.issue, r.result.toUpperCase(), r.end_state ?? '-', r.failure_class ?? '-', String(r.attempts), usd(r.spend_usd), ...(live ? [r.wall_ms === null ? '-' : secs(r.wall_ms)] : [])]),
    );
  const out: string[] = [`Orbit ${card.orbit_version} bench, tier ${card.tier} (${card.generated_at})`, '', ...falseDoneLines(h.false_done, card.orbit_version), `${live ? 'Runs' : 'Scenarios'}: ${totals(h)}`, '', ...(card.scenarios.length === 0 ? ['No scenarios ran.'] : rowsOf(card.scenarios))];
  for (const r of card.scenarios.filter((x) => x.problems.length > 0)) out.push('', `${r.id} (${r.result}):`, ...r.problems.map((p) => `  - ${p}`));
  if (card.comparison) {
    const c = card.comparison;
    const line = (name: string, x: Counts): string[] => [name, String(x.valid), String(x.passed), pct(x.pass_rate), String(x.attempts), usd(x.spend_usd)];
    out.push('', `With and without the ${c.stage} stage:`, ...table(['configuration', 'valid', 'passed', 'pass rate', 'attempts', spendWord], [line('with', c.with), line(`without ${c.stage}`, c.without)]));
    out.push(c.changed.length === 0 ? `No scenario changed its result without ${c.stage}.` : `Changed without ${c.stage}: ${c.changed.map((x) => `${x.id} (${x.with} -> ${x.without})`).join(', ')}`);
  }
  if (card.baseline) {
    const b = card.baseline;
    const sign = (n: number | null, f: (v: number) => string): string => (n === null ? 'n/a' : `${n >= 0 ? '+' : '-'}${f(Math.abs(n))}`);
    out.push('', `Plain claude -p session on the same goals: ${totals(b.counts)}`, ...rowsOf(b.rows));
    out.push(`Orbit minus the plain session: pass rate ${sign(b.difference.pass_rate, (v) => `${(v * 100).toFixed(1)} points`)}, cost per accepted task ${sign(b.difference.cost_per_pass_usd, usd)}`);
  }
  return `${out.join('\n')}\n`;
}

/** The scenarios a regression is reported for: those that ran and did not hold. */
export function failedScenarios(card: Scorecard): ScenarioRow[] {
  return card.scenarios.filter((r) => r.result === 'fail');
}

export function isFailureClassName(v: string): v is FailureClass {
  return (FAILURE_CLASSES as readonly string[]).includes(v);
}

/** The false-done file: a list of records, each checked. Anything malformed is an error naming the record, never skipped. */
export function parseFalseDones(text: string): FalseDoneRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`the false-done file is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? (data as { records?: unknown }).records : undefined;
  if (!Array.isArray(list)) throw new Error('the false-done file must be a list of records, or an object with a "records" list');
  return list.map((item: unknown, i: number): FalseDoneRecord => {
    const r = (item ?? {}) as Record<string, unknown>;
    const problems: string[] = [];
    if (typeof r.orbit_version !== 'string' || r.orbit_version === '') problems.push('orbit_version');
    if (typeof r.ref !== 'string' || r.ref === '') problems.push('ref');
    if (typeof r.found_by !== 'string' || !(FALSE_DONE_SOURCES as readonly string[]).includes(r.found_by)) problems.push(`found_by (one of ${FALSE_DONE_SOURCES.join(', ')})`);
    if (typeof r.link !== 'string' || !/^https?:\/\/\S+$/.test(r.link)) problems.push('link (an http or https URL)');
    if (problems.length > 0) throw new Error(`false-done record ${i + 1} has an invalid ${problems.join(', ')}`);
    return { orbit_version: r.orbit_version as string, ref: r.ref as string, found_by: r.found_by as FalseDoneSource, link: r.link as string };
  });
}
