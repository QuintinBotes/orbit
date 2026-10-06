#!/usr/bin/env node
// A release tag must match the version of everything the release ships: package.json, plugin/package.json and
// plugin/.claude-plugin/plugin.json. The release workflow runs this first, so a tag on a commit that was not bumped
// fails before any test runs or anything is published.
//   node scripts/check-release-versions.mjs <tag> [--root <dir>]
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;
const FILES = ['package.json', 'plugin/package.json', 'plugin/.claude-plugin/plugin.json'];

/** `v1.2.3` or `v1.2.3-rc.1` as { version, prerelease }, or null when the text is not a release tag. */
export function parseTag(tag) {
  const m = TAG.exec(tag);
  return m ? { version: m[1], prerelease: m[2] !== undefined } : null;
}

/** One message per file whose version is not the tag's version; empty when the release is consistent. */
export function checkReleaseVersions(tag, root = DEFAULT_ROOT) {
  const parsed = parseTag(tag);
  if (!parsed) return [`${tag} is not a release tag (expected vMAJOR.MINOR.PATCH, optionally with a -prerelease suffix)`];
  const problems = [];
  for (const file of FILES) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch (err) {
      problems.push(`${file} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      problems.push(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (typeof json?.version !== 'string') problems.push(`${file} has no version string`);
    else if (json.version !== parsed.version) problems.push(`${file} is ${json.version}, the tag ${tag} needs ${parsed.version}`);
  }
  return problems;
}

function main(argv) {
  let tag;
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = resolve(argv[++i] ?? '');
    else tag ??= argv[i];
  }
  if (!tag) {
    console.error('usage: node scripts/check-release-versions.mjs <tag> [--root <dir>]');
    return 2;
  }
  const problems = checkReleaseVersions(tag, root);
  for (const p of problems) console.error(`release versions: ${p}`);
  if (problems.length > 0) return 1;
  console.log(`release versions: ${tag} matches ${FILES.join(', ')}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
