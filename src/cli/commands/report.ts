/**
 * `orbit report <run-id>`: the run's final report, or a live interim report
 * built from the same records while the run is still going. An interim
 * report is never written to disk and says so on its first line.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OrbitDb } from '../../storage/db.ts';
import { buildFinalReport, renderMarkdown } from '../../controller/index.ts';
import { isTerminal } from '../../controller/states.ts';
import { verifySnapshot } from '../../policy/snapshot.ts';
import { KnowledgeStore } from '../../knowledge/store.ts';
import type { Args, OptionSpec } from '../args.ts';
import { findRunByPrefix, resolveRepo, withState, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { json, line, table } from '../io.ts';

export const REPORT_OPTIONS: OptionSpec = {
  learning: { type: 'boolean', description: 'instead of one run: verified pass rate, attempts and cost per accepted run over time, by active overlay version' },
  interim: { type: 'boolean', description: 'build the report from current records even when a final report exists' },
};

export async function reportCommand(args: Args, ctx: CliContext): Promise<number> {
  const repo = await resolveRepo(ctx, args.str('repo'));
  if (args.bool('learning')) return withState(repo, (db) => learningReport(ctx, repo, db, args.bool('json')));
  const [id] = args.expect(1);
  return withState(repo, (db) => {
    const run = findRunByPrefix(db, id!);
    const runDir = dirname(run.policyPath);
    const finalMd = join(runDir, 'final.md');
    const finalJson = join(runDir, 'final.json');
    const asJson = args.bool('json');
    if (isTerminal(run.state) && !args.bool('interim') && existsSync(finalMd)) {
      if (asJson) {
        if (existsSync(finalJson)) ctx.io.out(readFileSync(finalJson, 'utf8'));
        else json(ctx.io, buildFinalReport(db, run, { runDir, clock: ctx.clock, snapshot: snapshotOrNull(run.policyPath, run.policyHash) }));
      } else ctx.io.out(readFileSync(finalMd, 'utf8'));
      return EXIT.OK;
    }
    const report = buildFinalReport(db, run, { runDir, clock: ctx.clock, snapshot: snapshotOrNull(run.policyPath, run.policyHash) });
    if (asJson) {
      json(ctx.io, { interim: !isTerminal(run.state), ...report });
      return EXIT.OK;
    }
    const banner = isTerminal(run.state)
      ? `> Report rebuilt from current records (no final.md was found for this ${run.state} run).`
      : `> INTERIM report: the run is ${run.state}${run.paused ? ' (paused)' : ''} and nothing below is final. It is not saved to disk.`;
    line(ctx.io, banner);
    line(ctx.io);
    ctx.io.out(renderMarkdown(report));
    return EXIT.OK;
  });
}

function snapshotOrNull(path: string, hash: string) {
  try {
    return verifySnapshot(path, hash);
  } catch {
    return null;
  }
}

interface Window {
  label: string;
  from: number;
  to: number;
}

function learningReport(ctx: CliContext, repo: string, db: OrbitDb, asJson: boolean): number {
  const runs = db.all<{ id: string; state: string; created_at: number }>("SELECT id, state, created_at FROM runs WHERE state IN ('SUCCEEDED','EXHAUSTED','IMPOSSIBLE','BLOCKED') ORDER BY created_at");
  // Windows by implementer overlay activation; before the first one the base prompt was in force.
  const windows: Window[] = [{ label: 'base prompt', from: 0, to: Number.POSITIVE_INFINITY }];
  const kPath = join(repo, '.orbit', 'knowledge.sqlite');
  const overlays: { id: string; role: string; version: number; status: string; activated_at: string | null; eval: unknown }[] = [];
  if (existsSync(kPath)) {
    const store = KnowledgeStore.open(kPath, { clock: ctx.clock });
    try {
      for (const o of store.listOverlays({ scope: 'repo' })) {
        overlays.push({ id: o.id, role: o.role, version: o.version, status: o.status, activated_at: o.activated_at, eval: o.eval });
      }
    } finally {
      store.close();
    }
  }
  const activations = overlays
    .filter((o) => o.role === 'implementer' && o.activated_at)
    .map((o) => ({ label: `implementer overlay v${o.version}`, at: Date.parse(o.activated_at!) }))
    .sort((a, b) => a.at - b.at);
  for (const a of activations) {
    windows[windows.length - 1]!.to = a.at;
    windows.push({ label: a.label, from: a.at, to: Number.POSITIVE_INFINITY });
  }
  const rows = windows.map((w) => {
    const inW = runs.filter((r) => r.created_at >= w.from && r.created_at < w.to);
    const accepted = inW.filter((r) => r.state === 'SUCCEEDED');
    const attempts = accepted.map((r) => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workers WHERE run_id = ? AND role = 'implementer'", r.id)?.n ?? 0));
    const cost = accepted.map((r) => db.get<{ c: number | null; unknown: number }>('SELECT SUM(cost_usd) AS c, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown FROM usage WHERE run_id = ?', r.id));
    const unmeasured = cost.some((c) => (c?.unknown ?? 0) > 0);
    const totalCost = cost.reduce((a, c) => a + (c?.c ?? 0), 0);
    return {
      window: w.label,
      runs: inW.length,
      accepted: accepted.length,
      pass_rate: inW.length ? accepted.length / inW.length : null,
      mean_attempts_per_accepted: accepted.length ? attempts.reduce((a, b) => a + b, 0) / accepted.length : null,
      cost_per_accepted_usd: accepted.length ? totalCost / accepted.length : null,
      cost_complete: !unmeasured,
    };
  });
  if (asJson) {
    json(ctx.io, { windows: rows, overlays });
    return EXIT.OK;
  }
  line(ctx.io, 'Learning report: finished runs (SUCCEEDED, EXHAUSTED, IMPOSSIBLE, BLOCKED) grouped by the implementer overlay in force when they started.');
  line(ctx.io, 'Pass rate is accepted runs over finished runs. Cost counts only what providers reported or Orbit estimated; "(partial)" marks windows with unmeasured spend.');
  line(ctx.io);
  const f = (n: number | null, d = 2) => (n === null ? '-' : n.toFixed(d));
  ctx.io.out(table(rows.map((r) => [r.window, String(r.runs), String(r.accepted), r.pass_rate === null ? '-' : `${(r.pass_rate * 100).toFixed(0)}%`, f(r.mean_attempts_per_accepted, 1), r.cost_per_accepted_usd === null ? '-' : `$${f(r.cost_per_accepted_usd)}${r.cost_complete ? '' : ' (partial)'}`]), ['WINDOW', 'RUNS', 'ACCEPTED', 'PASS RATE', 'ATTEMPTS/ACCEPTED', 'COST/ACCEPTED']));
  if (overlays.length > 0) {
    line(ctx.io);
    ctx.io.out(table(overlays.map((o) => [o.id, o.role, `v${o.version}`, o.status]), ['OVERLAY', 'ROLE', 'VERSION', 'STATUS']));
  }
  if (runs.length === 0) line(ctx.io, '\nNo finished runs yet, so there is nothing to compare.');
  return EXIT.OK;
}
