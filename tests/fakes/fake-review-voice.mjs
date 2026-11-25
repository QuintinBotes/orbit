#!/usr/bin/env node
/**
 * A stand-in for the Review Voice CLI, for the acceptance lab (issue #231). It prints a `review-output` document for the
 * diff `--base..--head` it is run on, from a script file named by `--script`:
 *
 *   { "declined": ["path:line"], "calls": [ { "fail": true } | { "fromDiff": "blocking", "findings": [...] } ] }
 *
 * Call n answers with calls[n] (the last entry repeats). `fail` exits 1, `hang` never answers and ignores SIGTERM, and
 * `raw` prints that text as the whole answer. `fromDiff` adds one finding of that severity, at line 1, for each
 * file the diff changes, read with git in the working directory, so the output proves the exact diff was reviewed. A finding
 * at a path:line in `declined` is held back, as Review Voice holds back what its owner declined. Every call is appended to
 * `<script>.log` as one JSON line.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const scriptPath = flag('--script');
const base = flag('--base');
const head = flag('--head');
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
const log = `${scriptPath}.log`;
const n = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
appendFileSync(log, `${JSON.stringify({ base, head, cwd: process.cwd(), args })}\n`);

const calls = script.calls ?? [];
const call = calls[Math.min(n, calls.length - 1)] ?? {};
if (call.hang) {
  // Never answers and ignores SIGTERM: only SIGKILL stops it.
  process.on('SIGTERM', () => {});
  await new Promise(() => setInterval(() => {}, 1000));
} else if (call.raw !== undefined) {
  process.stdout.write(`${call.raw}\n`);
  process.exit(0);
} else if (call.fail) {
  process.stderr.write('fake review-voice: failing as scripted\n');
  process.exit(1);
}
const found = [...(call.findings ?? [])];
if (call.fromDiff) {
  const files = execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const path of files) found.push({ severity: call.fromDiff, path, line: 1, category: 'correctness', text: `Problem in ${path}. It changes behaviour.` });
}
const declined = new Set(script.declined ?? []);
const kept = found.filter((f) => !declined.has(`${f.path}:${f.line}`));
const findings = kept.map((f, i) => ({ finding_id: `rv_${String(i + 1).padStart(2, '0')}`, word_count: String(f.text).split(/\s+/).length, ...f }));
process.stdout.write(`${JSON.stringify(findings.length === 0 ? { review_run_id: 'rv-fake', findings, no_findings_response: 'No actionable findings.' } : { review_run_id: 'rv-fake', findings })}\n`);
