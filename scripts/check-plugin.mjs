#!/usr/bin/env node
// `claude plugin validate` does not flag ignored frontmatter keys, so lint them here
// against the verified lists in docs/interfaces/claude-code-plugin.md, after running
// the validator itself in --strict mode.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SKILL_KEYS = new Set([
  'name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation',
  'user-invocable', 'allowed-tools', 'disallowed-tools', 'model', 'effort', 'context', 'agent',
  'background', 'hooks', 'paths', 'shell', 'metadata', 'license', 'compatibility',
]);
// Plugin agents silently ignore permissionMode, hooks, mcpServers and initialPrompt, so they are errors here.
export const AGENT_KEYS = new Set([
  'name', 'description', 'model', 'effort', 'maxTurns', 'tools', 'disallowedTools', 'skills',
  'memory', 'background', 'omitClaudeMd', 'isolation', 'color', 'experimental',
]);

export function frontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  return end < 0 ? null : parse(text.slice(4, end));
}

function walk(dir, name) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, name));
    else if (name(e)) out.push(p);
  }
  return out;
}

export function lint(rootDir = root) {
  const problems = [];
  const files = [
    ...walk(join(rootDir, 'skills'), (f) => f === 'SKILL.md').map((p) => [p, SKILL_KEYS, 'skill']),
    ...walk(join(rootDir, 'agents'), (f) => f.endsWith('.md')).map((p) => [p, AGENT_KEYS, 'agent']),
  ];
  for (const [path, allowed, kind] of files) {
    const rel = path.slice(rootDir.length + 1);
    let fm;
    try { fm = frontmatter(readFileSync(path, 'utf8')); } catch (e) { problems.push(`${rel}: frontmatter does not parse: ${e.message}`); continue; }
    if (!fm || typeof fm !== 'object') { problems.push(`${rel}: missing frontmatter`); continue; }
    for (const k of Object.keys(fm)) if (!allowed.has(k)) problems.push(`${rel}: ${kind} key "${k}" is ignored or unsupported`);
    if (kind === 'skill' && fm['disable-model-invocation'] !== true) problems.push(`${rel}: Orbit skills must set disable-model-invocation: true`);
    if (!fm.description) problems.push(`${rel}: missing description`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const v = spawnSync('claude', ['plugin', 'validate', '--strict', root], { encoding: 'utf8', timeout: 120_000 });
  process.stdout.write(v.stdout ?? '');
  process.stderr.write(v.stderr ?? '');
  const problems = lint();
  for (const p of problems) console.error(p);
  if (v.status !== 0 || problems.length > 0) process.exit(1);
  console.log('plugin ok');
}
