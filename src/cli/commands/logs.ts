/**
 * `orbit logs <run-id>`: the controller's log lines for the run and each
 * worker's transcript, redacted. `--follow` keeps printing until the run is
 * terminal or the command is interrupted.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isTerminal } from '../../controller/states.ts';
import { getRun } from '../../controller/run-store.ts';
import { listWorkers } from '../../storage/workers.ts';
import type { Args, OptionSpec } from '../args.ts';
import { findRunByPrefix, resolveRepo, withState, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { oneLine, clockTime } from '../io.ts';

export const LOGS_OPTIONS: OptionSpec = {
  follow: { type: 'boolean', short: 'f', description: 'keep printing new lines until the run ends' },
  lines: { type: 'string', description: 'how many trailing lines of each source to show first (default 100)', valueName: 'n' },
  controller: { type: 'boolean', description: 'only the controller log' },
  workers: { type: 'boolean', description: 'only worker logs' },
  worker: { type: 'string', description: 'only this worker id', valueName: 'id' },
};

interface Source {
  label: string;
  path: string;
  kind: 'controller' | 'worker';
  /** Keep only lines that belong to this run (the controller log is shared by every run of the repository). */
  runId?: string;
  offset: number;
}

const TAIL_BYTES = 512 * 1024;

function readTail(path: string, lines: number): { lines: string[]; size: number } {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const all = text.split('\n').filter((l) => l.length > 0);
    return { lines: all, size };
  } finally {
    closeSync(fd);
  }
}

/** New complete lines since `offset`; a trailing partial line stays for the next poll. */
function readNew(path: string, offset: number): { lines: string[]; next: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { lines: [], next: size < offset ? 0 : offset };
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return { lines: [], next: offset };
    return { lines: text.slice(0, end).split('\n').filter((l) => l.length > 0), next: offset + Buffer.byteLength(text.slice(0, end + 1)) };
  } finally {
    closeSync(fd);
  }
}

function belongs(source: Source, text: string): boolean {
  if (!source.runId) return true;
  try {
    const o = JSON.parse(text) as { run_id?: unknown };
    return o.run_id === source.runId;
  } catch {
    return false;
  }
}

function render(source: Source, text: string, asJson: boolean): string {
  if (asJson) return JSON.stringify({ source: source.label, line: text });
  if (source.kind === 'controller') {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      const { ts, level, msg, ...rest } = o;
      const at = clockTime(typeof ts === 'string' ? ts : undefined);
      const extra = Object.entries(rest)
        .filter(([k]) => k !== 'run_id')
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      return `[${at}] ${String(level ?? 'info').padEnd(5)} ${String(msg ?? '')}${extra ? `  ${oneLine(extra, 200)}` : ''}`;
    } catch {
      return text;
    }
  }
  return `[${source.label}] ${oneLine(text, 400)}`;
}

export async function logsCommand(args: Args, ctx: CliContext): Promise<number> {
  const [runRef] = args.expect(1);
  const tail = args.int('lines') ?? 100;
  const repo = await resolveRepo(ctx, args.str('repo'));
  const asJson = args.bool('json');
  return withState(repo, async (db) => {
    const run = findRunByPrefix(db, runRef!);
    const runDir = dirname(run.policyPath);
    const wantController = !args.bool('workers') && !args.str('worker');
    const wantWorkers = !args.bool('controller');
    const sources: Source[] = [];
    const known = new Set<string>();
    const discover = (): void => {
      const add = (s: Omit<Source, 'offset'>): void => {
        if (known.has(s.path) || !existsSync(s.path)) return;
        known.add(s.path);
        sources.push({ ...s, offset: 0 });
      };
      if (wantController) {
        add({ label: 'controller', kind: 'controller', path: join(ctx.orbitHome, 'logs', 'controller.jsonl'), runId: run.id });
        add({ label: 'controller', kind: 'controller', path: join(runDir, 'logs', 'controller.jsonl') });
      }
      if (wantWorkers) {
        for (const w of listWorkers(db, { runId: run.id })) {
          if (args.str('worker') && w.id !== args.str('worker')) continue;
          for (const f of ['log.jsonl', 'stderr.log', 'shim.log']) add({ label: `${w.id}${f === 'log.jsonl' ? '' : `:${f.split('.')[0]}`}`, kind: 'worker', path: join(w.workerDir, f) });
        }
      }
    };
    discover();
    if (sources.length === 0 && !args.bool('follow')) {
      ctx.io.err(`no logs found for run ${run.id}; "orbit status ${run.id}" shows what it is doing, and the durable event history is in the state database\n`);
    }
    for (const s of sources) {
      const t = readTail(s.path, tail);
      s.offset = t.size;
      const mine = tail > 0 ? t.lines.filter((l) => belongs(s, l)).slice(-tail) : [];
      for (const l of mine) ctx.io.out(`${render(s, l, asJson)}\n`);
    }
    if (!args.bool('follow')) return EXIT.OK;

    let stop = false;
    const signals = ctx.seams.signals ?? process;
    const onInt = (): void => {
      stop = true;
    };
    signals.on('SIGINT', onInt);
    signals.on('SIGTERM', onInt);
    try {
      let finishedPasses = 0;
      while (!stop) {
        discover();
        let printed = 0;
        for (const s of sources) {
          const r = readNew(s.path, s.offset);
          s.offset = r.next;
          for (const l of r.lines) {
            if (!belongs(s, l)) continue;
            ctx.io.out(`${render(s, l, asJson)}\n`);
            printed++;
          }
        }
        // One more quiet pass after the run ends drains what was written between the last read and the final transition.
        if (isTerminal(getRun(db, run.id).state)) finishedPasses = printed === 0 ? finishedPasses + 1 : 0;
        if (finishedPasses >= 1) break;
        await new Promise((r) => setTimeout(r, ctx.seams.pollMs ?? 500));
      }
    } finally {
      signals.off('SIGINT', onInt);
      signals.off('SIGTERM', onInt);
    }
    return EXIT.OK;
  });
}
