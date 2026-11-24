#!/usr/bin/env node
// Changelog and traceability fragments: a PR adds one file per entry under changes/ instead of editing CHANGELOG.md or
// the traceability tables, so parallel PRs never conflict on those files (#230).
//   node scripts/fragments.mjs check [--base <ref>]   validate every fragment; with --base, also fail a PR that edits a shared file
//   node scripts/fragments.mjs fold <version> [--date YYYY-MM-DD]   fold the fragments into CHANGELOG.md and docs/traceability.md, then delete them
// changes/changelog/<name>.md:    line 1 `section: <Changes|Fixes|Off by default|Security>`, then the entry (Markdown).
// changes/traceability/<name>.md: line 1 `section: <heading of docs/traceability.md, e.g. 15>`, then one or more table rows.
// The plugin copies (plugin/CHANGELOG.md, plugin/docs/traceability.md) are made by `npm run build`, not by hand.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CHANGELOG_SECTIONS = ['Off by default', 'Changes', 'Fixes', 'Security'];
const STATUSES = ['done', 'partial', 'missing', 'untested'];
const SHARED_FILES = ['CHANGELOG.md', 'plugin/CHANGELOG.md', 'docs/traceability.md', 'plugin/docs/traceability.md'];
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

function read(root, kind) {
  const dir = join(root, 'changes', kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const file = `changes/${kind}/${f}`;
      const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/);
      const section = /^section:\s*(.+?)\s*$/.exec(lines[0] ?? '')?.[1];
      return { file, section, body: lines.slice(1).join('\n').trim() };
    });
}

const cells = (row) => row.replace(/^\||\|$/g, '').split(/(?<!\\)\|/);
const rowsOf = (body) => body.split('\n').filter((l) => l.trim() !== '');

function headingFor(lines, section) {
  const wanted = section.toLowerCase();
  return lines.findIndex((l) => {
    if (!l.startsWith('## ')) return false;
    const t = l.slice(3).toLowerCase();
    return t === wanted || t.startsWith(`${wanted}.`) || t.startsWith(`${wanted} `);
  });
}

/** One message per malformed fragment, each naming its file; empty when every fragment is well formed. */
export function checkFragments(root = DEFAULT_ROOT) {
  const problems = [];
  for (const f of read(root, 'changelog')) {
    if (!f.section) problems.push(`${f.file}: the first line must be "section: <${CHANGELOG_SECTIONS.join('|')}>"`);
    else if (!CHANGELOG_SECTIONS.includes(f.section)) problems.push(`${f.file}: unknown section "${f.section}" (use ${CHANGELOG_SECTIONS.join(', ')})`);
    if (f.body === '') problems.push(`${f.file}: the entry is empty`);
  }
  const table = existsSync(join(root, 'docs/traceability.md')) ? readFileSync(join(root, 'docs/traceability.md'), 'utf8').split('\n') : [];
  for (const f of read(root, 'traceability')) {
    if (!f.section) {
      problems.push(`${f.file}: the first line must be "section: <heading of docs/traceability.md>"`);
      continue;
    }
    if (headingFor(table, f.section) === -1) problems.push(`${f.file}: docs/traceability.md has no section "${f.section}"`);
    const rows = rowsOf(f.body);
    if (rows.length === 0) problems.push(`${f.file}: no table row`);
    for (const row of rows) {
      const c = row.startsWith('|') && row.endsWith('|') ? cells(row) : [];
      if (c.length !== 5 || !STATUSES.includes(c[4].trim())) problems.push(`${f.file}: malformed row "${row}" (5 cells, status one of ${STATUSES.join(', ')})`);
    }
  }
  return problems;
}

/** A PR that edits a shared file instead of writing a fragment; a release (version bump) may edit them. */
export function directEdits(changedFiles, versionBumped) {
  if (versionBumped) return [];
  return changedFiles
    .filter((f) => SHARED_FILES.includes(f))
    .map((f) => `${f} is assembled at release from fragments: write changes/changelog/<name>.md or changes/traceability/<name>.md instead of editing it`);
}

/** Fold the fragments into CHANGELOG.md and docs/traceability.md in a stable order (by file name), then delete them. */
export function foldFragments(root, version, date) {
  if (!VERSION.test(version)) throw new Error(`${version} is not a version`);
  const problems = checkFragments(root);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const changelog = read(root, 'changelog');
  const rows = read(root, 'traceability');
  if (changelog.length > 0) {
    const path = join(root, 'CHANGELOG.md');
    const lines = readFileSync(path, 'utf8').split('\n');
    const at = lines.findIndex((l) => l === '## Unreleased');
    if (at === -1) throw new Error('CHANGELOG.md has no "## Unreleased" heading');
    let end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
    if (end === -1) end = lines.length;
    const kept = lines.slice(at + 1, end).join('\n').trim();
    const parts = kept === '' ? [] : [kept];
    for (const s of CHANGELOG_SECTIONS) {
      const entries = changelog.filter((f) => f.section === s).map((f) => f.body);
      if (entries.length > 0) parts.push(`### ${s}\n\n${entries.join('\n')}`);
    }
    const released = [`## ${version} (${date})`, '', parts.join('\n\n'), ''];
    lines.splice(at + 1, end - at - 1, '', ...released);
    writeFileSync(path, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
  }
  if (rows.length > 0) {
    const path = join(root, 'docs/traceability.md');
    const lines = readFileSync(path, 'utf8').split('\n');
    for (const f of rows) {
      let i = headingFor(lines, f.section);
      while (i < lines.length && !lines[i].startsWith('|')) i++;
      while (i < lines.length && lines[i].startsWith('|')) i++;
      lines.splice(i, 0, ...rowsOf(f.body));
    }
    writeFileSync(path, lines.join('\n'));
  }
  for (const f of [...changelog, ...rows]) rmSync(join(root, f.file));
  return { changelog: changelog.length, traceability: rows.length };
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  if (cmd === 'check') {
    const problems = checkFragments();
    const base = opt('--base');
    if (base) {
      const version = (ref) => JSON.parse(ref === undefined ? readFileSync(join(DEFAULT_ROOT, 'package.json'), 'utf8') : git(DEFAULT_ROOT, ['show', `${ref}:package.json`])).version;
      const changed = git(DEFAULT_ROOT, ['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
      problems.push(...directEdits(changed, version(base) !== version()));
    }
    for (const p of problems) console.error(`fragments: ${p}`);
    if (problems.length === 0) console.log('fragments: ok');
    return problems.length > 0 ? 1 : 0;
  }
  if (cmd === 'fold' && rest[0]) {
    const date = opt('--date') ?? new Date().toISOString().slice(0, 10);
    try {
      const n = foldFragments(DEFAULT_ROOT, rest[0], date);
      console.log(`fragments: folded ${n.changelog} changelog and ${n.traceability} traceability fragments into ${rest[0]}; run npm run build for the plugin copies`);
      return 0;
    } catch (err) {
      console.error(`fragments: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  console.error('usage: node scripts/fragments.mjs check [--base <ref>] | fold <version> [--date YYYY-MM-DD]');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
