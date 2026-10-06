/**
 * `orbit timeline <run-id>`: what happened in a run, one line per significant step in order. Built from the
 * durable events, decisions and worker records (src/observability/timeline.ts), so it is the same answer whether
 * a controller is running or not. `orbit logs` stays the raw output; this is the reading copy.
 */
import { isTerminal } from '../../controller/states.ts';
import { getRun } from '../../controller/run-store.ts';
import { buildTimeline, type Timeline, type TimelineEntry } from '../../observability/timeline.ts';
import type { Args, OptionSpec } from '../args.ts';
import { findRunByPrefix, resolveRepo, withState, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { clockTime, flat, json } from '../io.ts';

export const TIMELINE_OPTIONS: OptionSpec = {
  follow: { type: 'boolean', short: 'f', description: 'keep printing new steps until the run ends or blocks' },
  last: { type: 'string', description: 'only the last n steps (default: all)', valueName: 'n' },
  all: { type: 'boolean', description: 'include housekeeping events (heartbeats, lease bookkeeping, planned checks and workers)' },
};

export const TIMELINE_USAGE = 'orbit timeline <run-id> [--follow] [--last n] [--all] [--json]';

function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The line of one step: local time, what kind of step, what happened. */
export function renderEntry(e: TimelineEntry): string {
  return `${clockTime(e.at)}  ${e.category.padEnd(9)} ${flat(e.text)}`;
}

export function renderHeader(t: Timeline): string {
  const lines = [`run ${t.run.id}  ${t.run.state}`, `goal:      ${flat(t.run.goal)}`];
  if (t.run.outcome_reason) lines.push(`outcome:   ${flat(t.run.outcome_reason)}`);
  return `${lines.join('\n')}\n`;
}

/** Entries as lines, with a date line before the first and wherever the local date changes. */
export function renderEntries(entries: readonly TimelineEntry[], lastDate: { value: string | null }): string {
  let out = '';
  for (const e of entries) {
    const day = localDate(e.at);
    if (day !== lastDate.value) {
      out += `-- ${day} --\n`;
      lastDate.value = day;
    }
    out += `${renderEntry(e)}\n`;
  }
  return out;
}

export function renderTimeline(t: Timeline): string {
  return `${renderHeader(t)}${renderEntries(t.entries, { value: null })}cost so far: ${t.cost.note}\n`;
}

export async function timelineCommand(args: Args, ctx: CliContext): Promise<number> {
  const [runRef] = args.expect(1);
  const last = args.int('last');
  const all = args.bool('all');
  const asJson = args.bool('json');
  const repo = await resolveRepo(ctx, args.str('repo'));
  return withState(repo, async (db) => {
    const run = findRunByPrefix(db, runRef!);
    const build = (): Timeline => buildTimeline(db, getRun(db, run.id), { all });
    const tail = (entries: TimelineEntry[]): TimelineEntry[] => (last === undefined ? entries : last === 0 ? [] : entries.slice(-last));

    if (!args.bool('follow')) {
      const t = build();
      const shown = { ...t, entries: tail(t.entries) };
      if (asJson) json(ctx.io, shown);
      else ctx.io.out(renderTimeline(shown));
      return EXIT.OK;
    }

    let t = build();
    const printed = new Set<string>();
    const date = { value: null as string | null };
    if (!asJson) ctx.io.out(renderHeader(t));
    const emit = (entries: TimelineEntry[]): number => {
      const fresh = entries.filter((e) => !printed.has(e.key));
      for (const e of fresh) printed.add(e.key);
      if (asJson) for (const e of fresh) ctx.io.out(`${JSON.stringify(e)}\n`);
      else ctx.io.out(renderEntries(fresh, date));
      return fresh.length;
    };
    // The backlog may be cut to the last n steps; whatever was cut counts as seen.
    const backlog = tail(t.entries);
    const shownNow = new Set(backlog.map((e) => e.key));
    for (const e of t.entries) if (!shownNow.has(e.key)) printed.add(e.key);
    emit(backlog);

    let stop = false;
    const signals = ctx.seams.signals ?? process;
    const onInt = (): void => {
      stop = true;
    };
    signals.on('SIGINT', onInt);
    signals.on('SIGTERM', onInt);
    try {
      let quietPasses = isTerminal(getRun(db, run.id).state) ? 1 : 0;
      while (!stop) {
        // One more quiet pass after the run ends drains what was written between the last read and the final transition.
        const over = isTerminal(getRun(db, run.id).state);
        if (over && quietPasses >= 1) break;
        await new Promise((r) => setTimeout(r, ctx.seams.pollMs ?? 500));
        t = build();
        const n = emit(t.entries);
        if (over) quietPasses = n === 0 ? quietPasses + 1 : 0;
      }
    } finally {
      signals.off('SIGINT', onInt);
      signals.off('SIGTERM', onInt);
    }
    if (!asJson) ctx.io.out(`cost so far: ${t.cost.note}\n`);
    return EXIT.OK;
  });
}
