#!/usr/bin/env node
// Points the orbit entry of a plugin catalog (.claude-plugin/marketplace.json) at a release tag: sets its
// source.ref. The release workflow runs this on a clone of QuintinBotes/claude-plugins before it opens the pull
// request. Only the ref text changes; the rest of the file keeps its formatting, so the diff is one line.
//   node scripts/bump-catalog-ref.mjs <marketplace.json> <tag>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTag } from './check-release-versions.mjs';

const REF = /("ref"\s*:\s*)"[^"]*"/g;

/** Start and end (exclusive) of the object that holds the position `at`, scanning strings correctly; null if unbalanced. */
function enclosingObject(text, at) {
  const stack = [];
  let inString = false;
  for (let i = 0; i < at; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') stack.push(i);
    else if (c === '}') stack.pop();
  }
  const start = stack.pop();
  if (start === undefined) return null;
  let depth = 0;
  inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return [start, i + 1];
  }
  return null;
}

/** `text` with the orbit entry's source.ref set to `tag`. Throws when the file is not a catalog with such an entry. */
export function bumpOrbitRef(text, tag) {
  if (!parseTag(tag)) throw new Error(`${tag} is not a release tag (expected vMAJOR.MINOR.PATCH)`);
  let catalog;
  try {
    catalog = JSON.parse(text);
  } catch (err) {
    throw new Error(`the catalog is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entry = Array.isArray(catalog?.plugins) ? catalog.plugins.find((p) => p?.name === 'orbit') : undefined;
  if (!entry) throw new Error('the catalog has no orbit entry');
  if (typeof entry.source?.ref !== 'string') throw new Error('the orbit entry has no source.ref to bump');

  for (const m of text.matchAll(/"name"\s*:\s*"orbit"/g)) {
    const span = enclosingObject(text, m.index);
    if (!span) continue;
    const body = text.slice(span[0], span[1]);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (parsed?.name !== 'orbit' || typeof parsed.source?.ref !== 'string') continue;
    if ((body.match(REF) ?? []).length !== 1) throw new Error('the orbit entry has more than one "ref" key; edit it by hand');
    const out = text.slice(0, span[0]) + body.replace(REF, `$1"${tag}"`) + text.slice(span[1]);
    // The only change anywhere in the catalog is the ref.
    entry.source.ref = tag;
    if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(catalog)) throw new Error('bumping the ref changed more than the ref');
    return out;
  }
  throw new Error('could not locate the orbit entry in the catalog text');
}

function main(argv) {
  const [file, tag] = argv;
  if (!file || !tag) {
    console.error('usage: node scripts/bump-catalog-ref.mjs <marketplace.json> <tag>');
    return 2;
  }
  try {
    const path = resolve(file);
    writeFileSync(path, bumpOrbitRef(readFileSync(path, 'utf8'), tag));
  } catch (err) {
    console.error(`bump catalog ref: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.log(`bump catalog ref: orbit now points at ${tag}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
