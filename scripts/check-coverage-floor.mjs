#!/usr/bin/env node
// Per-file coverage floor: the global thresholds in vitest.config.ts cannot see one small file
// falling behind, so after `vitest run --coverage` this reads coverage/coverage-summary.json and
// fails with the list of files whose line coverage is under the floor (default 80%).
//   node scripts/check-coverage-floor.mjs [summary.json] [--floor <percent>]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_FLOOR = 80;

/** Files whose covered/total lines are under `floor` percent, worst first. Files with no executable lines are skipped. */
export function filesBelowFloor(summary, floor = DEFAULT_FLOOR) {
  const below = [];
  for (const [file, entry] of Object.entries(summary)) {
    if (file === 'total') continue;
    const lines = entry?.lines;
    if (!lines || typeof lines.total !== 'number' || typeof lines.covered !== 'number' || lines.total === 0) continue;
    const pct = (lines.covered / lines.total) * 100;
    if (pct < floor) below.push({ file, pct, covered: lines.covered, total: lines.total });
  }
  return below.sort((a, b) => a.pct - b.pct || a.file.localeCompare(b.file));
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let summaryPath = join(root, 'coverage', 'coverage-summary.json');
  let floor = DEFAULT_FLOOR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--floor') {
      floor = Number(argv[++i]);
      if (!Number.isFinite(floor) || floor < 0 || floor > 100) {
        console.error('coverage floor: --floor needs a percentage between 0 and 100');
        return 2;
      }
    } else summaryPath = resolve(argv[i]);
  }
  if (!existsSync(summaryPath)) {
    console.error(`coverage floor: ${summaryPath} not found; run vitest with --coverage first`);
    return 2;
  }
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  } catch (err) {
    console.error(`coverage floor: ${summaryPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const below = filesBelowFloor(summary, floor);
  const files = Object.keys(summary).filter((k) => k !== 'total').length;
  if (below.length === 0) {
    console.log(`coverage floor: all ${files} files have at least ${floor}% lines covered`);
    return 0;
  }
  console.error(`coverage floor: ${below.length} of ${files} files are below ${floor}% lines covered:`);
  for (const b of below) console.error(`  ${b.pct.toFixed(2)}%  ${b.covered}/${b.total}  ${relative(root, b.file) || b.file}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
