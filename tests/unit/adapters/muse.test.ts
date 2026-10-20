import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MUSE_FORBIDDEN_ARGS,
  MUSE_MIN_VERSION,
  MUSE_REQUIRED_FLAGS,
  MUSE_REVIEW_MAX_STEPS,
  MuseAdapter,
  assertSafeMuseArgv,
  buildMuseArgv,
  decideMuseTier,
} from '../../../src/adapters/muse.ts';
import { classifyMuseTranscript, museDepth, museEvents, museUsage } from '../../../src/adapters/muse-events.ts';
import { buildWorkerEnv, museEnvCredential } from '../../../src/adapters/env.ts';
import { LOG_FILE, type ExitRecord } from '../../../src/adapters/shim.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { readReviewDepth } from '../../../src/controller/review-depth.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';

const SCHEMA = MODEL_OUTPUT_SCHEMAS.review;
const REVIEW = { verdict: 'APPROVE', candidate_revision: 'abc1234', findings: [] };
const MODEL = 'muse-wonder-full-1.0';

const ev = (payload_type: string, payload: Record<string, unknown> = {}): Record<string, unknown> => ({ payload_type, payload });
const completed = (text: string) => ev('run.terminal.completed', { text, reason: null });
const failed = (reason: string) => ev('run.terminal.failed', { text: '', reason });
const usageEv = (models: Record<string, unknown>[]) => ev('run.usage', { models });
const USAGE = usageEv([{ model_id: MODEL, input_tokens: 1234, cached_tokens: 1000, output_tokens: 56, reasoning_tokens: 7, calls: 1 }]);

function exit(over: Partial<ExitRecord> = {}): ExitRecord {
  return { version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 0, endedAt: 1000, ...over };
}

function classify(events: Record<string, unknown>[], ex: Partial<ExitRecord> = {}, stderr?: string) {
  return classifyMuseTranscript({ events, malformedTail: false, exit: exit(ex), outputSchema: SCHEMA, model: MODEL, ...(stderr === undefined ? {} : { stderr }) });
}

describe('decideMuseTier', () => {
  const srtOk = { ok: true, why: '' };
  const srtBad = { ok: false, why: 'sandbox-runtime is unavailable (no srt)' };

  it('muse-sandbox is never wrapped, whatever else is available', () => {
    expect(decideMuseTier({ setting: 'muse-sandbox', apiKeyVar: 'META_API_KEY', srt: srtOk })).toMatchObject({ tier: 'muse-sandbox', automatic: false });
    expect(decideMuseTier({ setting: 'muse-sandbox', apiKeyVar: null, srt: srtBad })).toMatchObject({ tier: 'muse-sandbox', automatic: false });
  });

  it('os-sandbox runs only with META_API_KEY and an srt that starts', () => {
    expect(decideMuseTier({ setting: 'os-sandbox', apiKeyVar: 'META_API_KEY', srt: srtOk })).toMatchObject({ tier: 'os-sandbox', automatic: false });
  });

  it('os-sandbox fails closed without srt, and without META_API_KEY', () => {
    for (const input of [
      { setting: 'os-sandbox' as const, apiKeyVar: 'META_API_KEY', srt: srtBad },
      { setting: 'os-sandbox' as const, apiKeyVar: null, srt: srtOk },
      { setting: 'os-sandbox' as const, apiKeyVar: null, srt: srtBad },
    ]) {
      let caught: unknown;
      try {
        decideMuseTier(input);
      } catch (err) {
        caught = err;
      }
      expect(isOrbitError(caught, 'ISOLATION_UNAVAILABLE'), JSON.stringify(input)).toBe(true);
    }
    expect(() => decideMuseTier({ setting: 'os-sandbox', apiKeyVar: null, srt: srtOk })).toThrow(/META_API_KEY/);
  });

  it('auto picks os-sandbox only with META_API_KEY and srt, else muse-sandbox, and says why', () => {
    expect(decideMuseTier({ setting: 'auto', apiKeyVar: 'META_API_KEY', srt: srtOk })).toMatchObject({ tier: 'os-sandbox', automatic: true });
    const noKey = decideMuseTier({ setting: 'auto', apiKeyVar: null, srt: srtOk });
    expect(noKey).toMatchObject({ tier: 'muse-sandbox', automatic: true });
    expect(noKey.reason).toMatch(/META_API_KEY/);
    const noSrt = decideMuseTier({ setting: 'auto', apiKeyVar: 'META_API_KEY', srt: srtBad });
    expect(noSrt).toMatchObject({ tier: 'muse-sandbox', automatic: true });
    expect(noSrt.reason).toBe(srtBad.why);
    expect(decideMuseTier({ setting: 'auto', apiKeyVar: null, srt: srtBad }).tier).toBe('muse-sandbox');
  });
});

describe('muse invocation', () => {
  const input = { command: ['muse'], model: MODEL, effort: 'high', workspace: '/r', schemaPath: '/w/schema.json', promptPath: '/w/prompt.md', maxSteps: MUSE_REVIEW_MAX_STEPS };

  it('builds the fixed read-only argv: every required flag with its value, no approval mode, nothing forbidden', () => {
    const argv = buildMuseArgv(input);
    expect(MUSE_REVIEW_MAX_STEPS).toBe(200);
    expect(MUSE_MIN_VERSION).toBe('1.4.11');
    expect(argv.slice(0, 2)).toEqual(['muse', 'exec']);
    for (const flag of MUSE_REQUIRED_FLAGS) expect(argv, flag).toContain(flag);
    const value = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(value('--model')).toBe(MODEL);
    expect(value('--reasoning-effort')).toBe('high');
    expect(value('--workspace')).toBe('/r');
    expect(value('--permission-profile')).toBe(':read-only');
    expect(value('--output-schema')).toBe('/w/schema.json');
    expect(value('--max-model-steps')).toBe('200');
    expect(value('--prompt-file')).toBe('/w/prompt.md');
    // Muse 1.4.11 refuses --approval-mode together with --permission-profile (ADR 0017).
    expect(argv).not.toContain('--approval-mode');
    for (const bad of ['--yolo', '--disable-sandbox', '--disable-approval', '--trust-workspace']) expect(argv, bad).not.toContain(bad);
    expect(argv.some((a) => a.includes(':unrestricted'))).toBe(false);
  });

  // Spelled out, not read from the source: an emptied MUSE_FORBIDDEN_ARGS must fail here, not remove the cases (issue #108 claim 5).
  const FORBIDDEN = ['--yolo', '--disable-sandbox', '--disable-approval', '--trust-workspace'];
  it('keeps every flag the issue forbids in MUSE_FORBIDDEN_ARGS', () => {
    for (const bad of FORBIDDEN) expect(MUSE_FORBIDDEN_ARGS).toContain(bad);
  });

  it.each(FORBIDDEN)('assertSafeMuseArgv refuses %s, bare and in = form', (bad) => {
    for (const argv of [['muse', 'exec', bad], ['muse', 'exec', `${bad}=x`]]) {
      let caught: unknown;
      try {
        assertSafeMuseArgv(argv);
      } catch (err) {
        caught = err;
      }
      expect(isOrbitError(caught, 'POLICY_DENIED'), argv.join(' ')).toBe(true);
    }
  });

  it('assertSafeMuseArgv refuses an :unrestricted profile and accepts the built argv', () => {
    expect(() => assertSafeMuseArgv(['muse', 'exec', '--permission-profile', ':unrestricted'])).toThrow(/read-only/);
    expect(() => assertSafeMuseArgv(['muse', 'exec', '--permission-profile=:unrestricted'])).toThrow(/read-only/);
    expect(() => assertSafeMuseArgv(buildMuseArgv(input))).not.toThrow();
  });

  it('the constructor refuses extra_args flags: the review invocation is fixed', () => {
    for (const flag of ['--yolo', '--disable-sandbox', '--model', '--max-model-steps=9999']) {
      let caught: unknown;
      try {
        new MuseAdapter({ extraArgs: [flag] });
      } catch (err) {
        caught = err;
      }
      expect(isOrbitError(caught, 'CONFIG_INVALID'), flag).toBe(true);
      expect((caught as Error).message).toMatch(/extra_args/);
    }
    expect(() => new MuseAdapter({ extraArgs: [] })).not.toThrow();
  });
});

describe('buildWorkerEnv for muse', () => {
  const base = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
    XDG_CONFIG_HOME: '/home/u/.config',
    META_API_KEY: 'meta-key',
    MUSE_PERMISSION_PROFILE_FAIL_OPEN: '1',
    MUSE_SOME_OTHER_SETTING: 'x',
    ANTHROPIC_API_KEY: 'sk-ant',
    CODEX_API_KEY: 'sk-codex',
    GH_TOKEN: 'ghp_x',
    AWS_SECRET_ACCESS_KEY: 'secret',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
  };
  const input = (extra?: Record<string, string>) => ({ provider: 'muse' as const, base, policyPath: '/run/policy.json', policyHash: 'sha256:abc', worktree: '/wt', tmpDir: '/tmp/orbit-1/x', extra });

  it('passes META_API_KEY and XDG_CONFIG_HOME, sets MUSE_NO_AUTO_UPDATE=1, and drops everything else of the host', () => {
    const env = buildWorkerEnv(input());
    expect(env).toMatchObject({ META_API_KEY: 'meta-key', XDG_CONFIG_HOME: '/home/u/.config', MUSE_NO_AUTO_UPDATE: '1', PATH: base.PATH, HOME: base.HOME });
    for (const leaked of ['MUSE_PERMISSION_PROFILE_FAIL_OPEN', 'MUSE_SOME_OTHER_SETTING', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DOCKER_HOST']) {
      expect(env, leaked).not.toHaveProperty(leaked);
    }
  });

  it('refuses any MUSE_ variable as an extra, MUSE_PERMISSION_PROFILE_FAIL_OPEN above all', () => {
    for (const bad of ['MUSE_PERMISSION_PROFILE_FAIL_OPEN', 'MUSE_NO_AUTO_UPDATE', 'MUSE_ANYTHING']) {
      let caught: unknown;
      try {
        buildWorkerEnv(input({ [bad]: '1' }));
      } catch (err) {
        caught = err;
      }
      expect(isOrbitError(caught, 'POLICY_DENIED'), bad).toBe(true);
    }
  });

  it('names (never returns) META_API_KEY as the env credential', () => {
    expect(museEnvCredential({ META_API_KEY: 'k' })).toBe('META_API_KEY');
    expect(museEnvCredential({ META_API_KEY: '   ' })).toBeNull();
    expect(museEnvCredential({})).toBeNull();
  });
});

describe('classifyMuseTranscript', () => {
  it('accepts a final answer that parses and validates against Orbit\'s own schema copy', () => {
    const r = classify([ev('run.lifecycle.started'), USAGE, completed(JSON.stringify(REVIEW))]);
    expect(r).toMatchObject({ status: 'succeeded', reason: 'success', structured: REVIEW, exitCode: 0 });
    expect(r.usage).toEqual({ provider: 'muse', model: MODEL, inputTokens: 1234, outputTokens: 56, cacheReadTokens: 1000, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' });
  });

  it('treats invalid JSON, a schema mismatch and an empty answer as malformed, never as "no findings"', () => {
    expect(classify([completed('not json at all')])).toMatchObject({ status: 'malformed_output', reason: 'invalid_json', structured: null });
    expect(classify([completed('{"verdict":"MAYBE","extra":1}')])).toMatchObject({ status: 'malformed_output', reason: 'schema_mismatch', structured: null });
    expect(classify([completed('')])).toMatchObject({ status: 'malformed_output', reason: 'no_answer', structured: null });
    expect(classify([completed('   ')])).toMatchObject({ status: 'malformed_output', reason: 'no_answer' });
  });

  it('does not rescue a fenced JSON block: schema output only (ADR 0017)', () => {
    const fenced = '```json\n' + JSON.stringify(REVIEW) + '\n```';
    expect(classify([completed(fenced)])).toMatchObject({ status: 'malformed_output', reason: 'invalid_json', structured: null });
  });

  it('separates a step cap from other run failures, keeping the reason', () => {
    expect(classify([failed('model did not reach a terminal state within 200 step(s)')], { code: 1 })).toMatchObject({ status: 'failed', reason: 'step_cap' });
    const r = classify([failed('the provider exploded')], { code: 1 });
    expect(r).toMatchObject({ status: 'failed', reason: 'run_failed' });
    expect(r.error).toContain('the provider exploded');
  });

  it('reads a missing login from stderr (it fails before any event) as an auth failure', () => {
    const stderr = 'missing meta credentials: run `muse login` or set META_API_KEY, or save credentials at /home/u/.config/muse/auth.json\n';
    expect(classify([], { code: 1 }, stderr)).toMatchObject({ status: 'auth_failed', reason: 'auth' });
    expect(classify([failed('unexpected status 401 Unauthorized')], { code: 1 })).toMatchObject({ status: 'auth_failed', reason: 'auth' });
  });

  it('classifies timeouts, crashes and a completed run with a non-zero exit', () => {
    expect(classify([ev('run.lifecycle.started')], { timedOut: true, code: null, signal: 'SIGKILL', escalation: ['SIGINT', 'SIGTERM', 'SIGKILL'] })).toMatchObject({ status: 'timeout', reason: 'timeout' });
    expect(classify([ev('run.lifecycle.started')], { code: 1 })).toMatchObject({ status: 'failed', reason: 'crashed' });
    expect(classify([], { code: null, signal: 'SIGKILL' })).toMatchObject({ status: 'failed', reason: 'crashed' });
    expect(classify([completed(JSON.stringify(REVIEW))], { code: 1 })).toMatchObject({ status: 'failed', reason: 'crashed', structured: null });
    expect(classify([], { error: 'spawn muse ENOENT' })).toMatchObject({ status: 'failed', reason: 'spawn_failed' });
  });

  it('reports usage as null, not zero, when the run reported none', () => {
    expect(classify([completed(JSON.stringify(REVIEW))]).usage).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null, costUsd: null });
  });
});

describe('museUsage and museDepth', () => {
  it('sums tokens over every model of the last run.usage, and reports no cost', () => {
    const events = [
      usageEv([{ input_tokens: 1, cached_tokens: 1, output_tokens: 1, reasoning_tokens: 1 }]),
      usageEv([
        { input_tokens: 100, cached_tokens: 10, output_tokens: 5, reasoning_tokens: 3 },
        { input_tokens: 23, cached_tokens: 0, output_tokens: 1, reasoning_tokens: 4 },
      ]),
    ];
    expect(museUsage(events, MODEL)).toEqual({ provider: 'muse', model: MODEL, inputTokens: 123, outputTokens: 6, cacheReadTokens: 10, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' });
    expect(museDepth(events)).toEqual({ toolCalls: 0, reasoningTokens: 7 });
  });

  it('counts tool results as the looks at the checkout, and leaves unreported fields null', () => {
    const events = [ev('tool.result', { correlation_facts: { tool_name: 'Read' }, text: 'x' }), ev('tool.result', { correlation_facts: { tool_name: 'Grep' }, text: 'y' }), ev('run.output.delta', {})];
    expect(museDepth(events)).toEqual({ toolCalls: 2, reasoningTokens: null });
    expect(museUsage([], null).inputTokens).toBeNull();
    // A model entry missing a field makes that field unknown, not zero.
    expect(museUsage([usageEv([{ input_tokens: 5 }])], MODEL).outputTokens).toBeNull();
    expect(museDepth([usageEv([{ input_tokens: 5 }])]).reasoningTokens).toBeNull();
  });

  it('museEvents maps start, tools, usage and the terminal events; unknown types are skipped', () => {
    const events = museEvents([ev('run.lifecycle.started'), ev('runtime.command.accepted'), ev('tool.result', { correlation_facts: { tool_name: 'Read' }, text: 'apps/a.ts' }), USAGE, completed('{}')], 1, MODEL);
    expect(events.map((e) => e.type)).toEqual(['started', 'tool', 'usage', 'message', 'finished']);
    const failedEvents = museEvents([failed('boom')], 1, MODEL);
    expect(failedEvents.map((e) => e.type)).toEqual(['error', 'finished']);
  });
});

describe('readReviewDepth reads a muse transcript', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('counts tool results and reasoning tokens, for muse and a muse alias alike', () => {
    const workerDir = mkdtempSync(join(tmpdir(), 'orbit-muse-depth-'));
    dirs.push(workerDir);
    const lines = [ev('run.lifecycle.started'), ev('tool.result', { correlation_facts: { tool_name: 'Read' }, text: 'x' }), ev('tool.result', { correlation_facts: { tool_name: 'Read' }, text: 'y' }), USAGE, completed(JSON.stringify(REVIEW))];
    writeFileSync(join(workerDir, LOG_FILE), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(readReviewDepth({ provider: 'muse', workerDir })).toEqual({ toolCalls: 2, reasoningTokens: 7 });
    expect(readReviewDepth({ provider: 'muse-review', workerDir })).toEqual({ toolCalls: 2, reasoningTokens: 7 });
  });

  it('leaves both unknown when there is no transcript', () => {
    const workerDir = mkdtempSync(join(tmpdir(), 'orbit-muse-depth-'));
    dirs.push(workerDir);
    expect(readReviewDepth({ provider: 'muse', workerDir })).toEqual({ toolCalls: null, reasoningTokens: null });
  });
});
