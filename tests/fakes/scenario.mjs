// Shared scenario handling for fake-claude.mjs and fake-codex.mjs. See README.md.
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Output schema title -> role, so a fake knows which worker it is from the same argv the real CLI gets. */
const TITLE_ROLES = {
  'Orbit planner output': 'planner',
  'Orbit implementer output': 'implementer',
  'Orbit diagnosis output': 'verifier',
  'Orbit review output': 'reviewer',
  'Orbit inquisitor output': 'inquisitor',
  'Orbit curator output': 'curator',
};

export function roleFromSchema(schema) {
  if (schema && typeof schema.title === 'string' && TITLE_ROLES[schema.title]) return TITLE_ROLES[schema.title];
  return '*';
}

/**
 * The scenario step for this call: scenario.roles[role][n] (n counts calls
 * per role, starting at 0), falling back to roles['*'], repeating the last
 * entry once a list is exhausted. The counter is a file next to the
 * scenario that grows by one byte per call (O_APPEND keeps it atomic across
 * concurrent fakes).
 */
export function loadStep(role, env = process.env) {
  const path = env.ORBIT_FAKE_SCENARIO;
  if (!path) return { scenario: {}, step: {}, call: 0 };
  const scenario = JSON.parse(readFileSync(path, 'utf8'));
  const roles = scenario.roles ?? {};
  const key = Array.isArray(roles[role]) ? role : '*';
  const counter = `${path}.${key.replace(/[^a-z*]/g, '_')}.count`;
  appendFileSync(counter, '.');
  const call = statSync(counter).size - 1;
  const list = Array.isArray(roles[key]) ? roles[key] : [];
  const step = list.length === 0 ? {} : list[Math.min(call, list.length - 1)];
  return { scenario, step: step ?? {}, call };
}

/**
 * Placeholders a scenario may use in any string of a step (structured output,
 * edit content, ...), resolved from the prompt the worker was given:
 *   $CANDIDATE    the candidate commit named by "- revision: <40 hex>" (what a review must echo)
 *   $FINGERPRINT  the failure fingerprint named by "Failure fingerprint: <id>" (what a repair brief must name)
 * A placeholder whose value is not in the prompt is left as written.
 */
export function promptPlaceholders(prompt) {
  return {
    $CANDIDATE: /- revision: ([0-9a-f]{40})/.exec(prompt)?.[1] ?? null,
    $FINGERPRINT: /Failure fingerprint: (\S+)/.exec(prompt)?.[1] ?? null,
  };
}

export function renderPlaceholders(value, prompt) {
  const map = promptPlaceholders(prompt);
  const walk = (v) => {
    if (typeof v === 'string') {
      let t = v;
      for (const [k, to] of Object.entries(map)) if (to !== null) t = t.split(k).join(to);
      return t;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Apply file edits inside cwd. Paths are relative to cwd unless absolute. */
export function applyEdits(cwd, edits = []) {
  const done = [];
  for (const e of edits) {
    const p = isAbsolute(e.path) ? e.path : resolve(cwd, e.path);
    if (e.op === 'write') {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, e.content ?? '');
    } else if (e.op === 'replace') {
      const text = readFileSync(p, 'utf8');
      if (!text.includes(e.find)) throw new Error(`replace: ${e.path} does not contain the text to replace`);
      writeFileSync(p, text.split(e.find).join(e.replace ?? ''));
    } else if (e.op === 'delete') {
      rmSync(p, { force: true, recursive: true });
    } else {
      throw new Error(`unknown edit op ${e.op}`);
    }
    done.push({ op: e.op, path: p });
  }
  return done;
}

/** Try a write the worker must not be able to make; report what happened instead of failing. */
export function attemptWrite(cwd, spec) {
  const p = isAbsolute(spec.path) ? spec.path : resolve(cwd, spec.path);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, spec.content ?? 'forbidden');
    return { path: p, written: true, error: null };
  } catch (err) {
    return { path: p, written: false, error: err && err.code ? err.code : String(err) };
  }
}

/** Write the first half of the content, then die the way an OOM kill looks: exit 137. */
export function crashMidEdit(cwd, spec) {
  const p = isAbsolute(spec.path) ? spec.path : resolve(cwd, spec.path);
  const content = spec.content ?? 'partial content that never finishes';
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content.slice(0, Math.max(1, Math.floor(content.length / 2))));
  process.exit(137);
}

/** A grandchild in the same process group, for proving that group kills reach it. Its pid goes to `pidFile`. */
export function spawnGrandchild(pidFile) {
  const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
  writeFileSync(pidFile, String(child.pid));
  return child;
}

/**
 * A real child that creates its own session, writes until it is stopped, and
 * leaves its pid where an integration test can prove the shim ended it. This
 * is deliberately only a fake-fixture primitive, not provider behaviour.
 */
export function spawnDetachedWriter(spec) {
  const pidFile = String(spec.pidFile);
  const markerPath = String(spec.markerPath);
  const writePath = String(spec.writePath);
  const intervalMs = Number.isSafeInteger(spec.intervalMs) && spec.intervalMs > 0 ? spec.intervalMs : 25;
  const code = `
    const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
    const { dirname } = require('node:path');
    const markerPath = ${JSON.stringify(markerPath)};
    const writePath = ${JSON.stringify(writePath)};
    const intervalMs = ${JSON.stringify(intervalMs)};
    mkdirSync(dirname(markerPath), { recursive: true });
    mkdirSync(dirname(writePath), { recursive: true });
    writeFileSync(markerPath, String(process.pid));
    let n = 0;
    const write = () => appendFileSync(writePath, String(++n) + '\\n');
    write();
    setInterval(write, intervalMs);
    setTimeout(() => process.exit(0), 60_000);
  `;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  return child;
}

export function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

export function logArgv(env, record) {
  if (env.ORBIT_FAKE_ARGV_LOG) appendFileSync(env.ORBIT_FAKE_ARGV_LOG, `${JSON.stringify(record)}\n`);
}

export function joinPath(...parts) {
  return join(...parts);
}
