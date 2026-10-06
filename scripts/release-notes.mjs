#!/usr/bin/env node
// Prints the CHANGELOG.md section of one version, for use as the notes of its GitHub release.
//   node scripts/release-notes.mjs <version or vTag> [--file CHANGELOG.md]
// A section starts at the heading `## <version>` (optionally followed by a date) and ends at the next level 2
// heading. Lines inside a code fence never count as headings. Exits 1 when the section is missing or empty.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'CHANGELOG.md');
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** The trimmed body of the section for `version` (a leading v is ignored), or null when there is no such heading. */
export function extractSection(changelog, version) {
  const wanted = version.replace(/^v/, '');
  if (!VERSION.test(wanted)) return null;
  const lines = changelog.split(/\r?\n/);
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const heading = /^## (\S+)(?:\s.*)?$/.exec(line);
    if (!heading) continue;
    if (start === -1) {
      if (heading[1].replace(/^\[|\]$/g, '') === wanted) start = i + 1;
    } else {
      end = i;
      break;
    }
  }
  if (start === -1) return null;
  return lines.slice(start, end).join('\n').trim();
}

function main(argv) {
  let version;
  let file = DEFAULT_FILE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') file = resolve(argv[++i] ?? '');
    else version ??= argv[i];
  }
  if (!version || !VERSION.test(version.replace(/^v/, ''))) {
    console.error('usage: node scripts/release-notes.mjs <version or vTag> [--file CHANGELOG.md]');
    return 2;
  }
  if (!existsSync(file)) {
    console.error(`release notes: ${file} not found`);
    return 2;
  }
  const bare = version.replace(/^v/, '');
  const section = extractSection(readFileSync(file, 'utf8'), bare);
  if (section === null) {
    console.error(`release notes: ${file} has no section for ${bare}; add a "## ${bare} (date)" heading`);
    return 1;
  }
  if (section === '') {
    console.error(`release notes: the section for ${bare} is empty`);
    return 1;
  }
  process.stdout.write(`${section}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
