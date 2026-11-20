/**
 * Issue #176, FR-002 and FR-005: Codex and Muse have a writable worktree tier with the CLI's data-sharing switches off,
 * and a quota or login failure ends a session as a credential failure (`auth_failed`), never as a transient one.
 * Partner output stays untrusted: it is parsed against Orbit's own copy of the implementer schema.
 */
import { describe, expect, it } from 'vitest';
import { buildCodexArgv } from '../../../src/adapters/codex.ts';
import { classifyCodexTranscript } from '../../../src/adapters/codex-events.ts';
import { assertSafeMuseArgv, buildMuseArgv, MUSE_REVIEW_MAX_STEPS } from '../../../src/adapters/muse.ts';
import { classifyMuseTranscript } from '../../../src/adapters/muse-events.ts';
import type { ExitRecord } from '../../../src/adapters/shim.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';
import { codexReviewerProfile, museReviewerProfile } from '../../../src/isolation/profiles.ts';
import { buildSrtSettings } from '../../../src/isolation/sandbox-runtime.ts';
import type { SandboxProfile } from '../../../src/isolation/types.ts';

const IMPLEMENTER = MODEL_OUTPUT_SCHEMAS.implementer;
const exit = (over: Partial<ExitRecord> = {}): ExitRecord => ({ version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 0, endedAt: 1000, ...over });
const base: SandboxProfile = { writablePaths: [], denyReadPaths: ['/home/u/.ssh'], allowedHosts: [], limits: { timeoutMs: 1000, memoryMb: null, cpus: null, pids: null } };

describe('Codex writable tier (FR-002)', () => {
  const input = { command: ['codex'], model: 'gpt-6-astra', effort: 'high', cwd: '/wt', schemaPath: '/w/schema.json', lastMessagePath: '/w/last.json' };

  it('an implementer runs under Codex\'s own workspace-write sandbox, with the same data-sharing switches as a review', () => {
    const argv = buildCodexArgv({ ...input, writable: true });
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('workspace-write');
    for (const flag of ['--ephemeral', '--ignore-user-config', 'web_search="disabled"', 'multi_agent']) expect(argv, flag).toContain(flag);
    expect(argv[argv.indexOf('-C') + 1]).toBe('/wt');
    expect(argv.join(' ')).not.toMatch(/yolo|dangerously|full-auto/);
    // A review is unchanged: read-only.
    expect(buildCodexArgv(input)[buildCodexArgv(input).indexOf('--sandbox') + 1]).toBe('read-only');
  });

  it('workspace-write keeps the commands it runs off the shared /tmp and off the network, whatever a project config says', () => {
    const argv = buildCodexArgv({ ...input, writable: true });
    expect(argv).toContain('sandbox_workspace_write.exclude_slash_tmp=true');
    expect(argv).toContain('sandbox_workspace_write.network_access=false');
    expect(buildCodexArgv(input).join(' ')).not.toContain('sandbox_workspace_write');
  });

  it('inside srt the profile adds the worktree to what may be written, and nothing else', () => {
    const review = codexReviewerProfile(base, { checkout: '/tmp/orbit-wt', workerDir: '/tmp/orbit-w', codexHome: '/tmp/orbit-codex', homeDir: '/tmp/orbit-home' });
    const impl = codexReviewerProfile(base, { checkout: '/tmp/orbit-wt', workerDir: '/tmp/orbit-w', codexHome: '/tmp/orbit-codex', homeDir: '/tmp/orbit-home', writable: true });
    expect(impl.writablePaths.filter((p) => !review.writablePaths.includes(p))).toEqual([expect.stringMatching(/orbit-wt$/)]);
    expect(impl.allowedHosts).toEqual(review.allowedHosts);
    expect(impl.denyReadPaths).toEqual(review.denyReadPaths);
  });

  it('srt accepts the writable profile and lets it write the worktree', () => {
    const impl = codexReviewerProfile(base, { checkout: '/tmp/orbit-wt', workerDir: '/tmp/orbit-w', codexHome: '/tmp/orbit-codex', homeDir: '/tmp/orbit-home', writable: true });
    const fs = buildSrtSettings(impl).filesystem;
    expect(fs.allowWrite).toContainEqual(expect.stringMatching(/orbit-wt$/));
    expect(fs.denyWrite.filter((p) => /orbit-wt$/.test(p))).toEqual([]);
  });
});

describe('Muse writable tier (FR-002)', () => {
  const input = { command: ['muse'], model: 'muse-wonder-full-1.0', effort: 'high', workspace: '/wt', schemaPath: '/w/schema.json', promptPath: '/w/prompt.md', maxSteps: MUSE_REVIEW_MAX_STEPS };

  it('an implementer runs only inside srt, edits in Orbit\'s worktree, with Contributor mode off and the shell disabled', () => {
    const argv = buildMuseArgv({ ...input, writable: true, wrapper: 'sandbox-runtime' });
    const value = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(value('--worktree')).toBe('off');
    expect(value('--contributor-mode')).toBe('off');
    for (const flag of ['--disable-shell', '--no-foreign-personal-context', '--disable-web-tools', '--no-session-log', '--disable-request-user-input', '--disable-approval']) expect(argv, flag).toContain(flag);
    expect(argv).not.toContain('--disable-write');
    expect(argv).not.toContain(':read-only');
    for (const wrapper of [null, 'none', 'container'] as const) {
      expect(() => buildMuseArgv({ ...input, writable: true, wrapper }), String(wrapper)).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
    }
  });

  it('--disable-approval stays refused in a review argv', () => {
    const review = buildMuseArgv(input);
    expect(review).toContain(':read-only');
    expect(() => assertSafeMuseArgv([...review, '--disable-approval'])).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });

  it('inside srt the profile adds the worktree to what may be written', () => {
    expect(museReviewerProfile(base, { checkout: '/tmp/orbit-wt', workerDir: '/tmp/orbit-w', writable: true }).writablePaths).toEqual([expect.stringMatching(/orbit-w$/), expect.stringMatching(/orbit-wt$/)]);
    expect(museReviewerProfile(base, { checkout: '/tmp/orbit-wt', workerDir: '/tmp/orbit-w' }).writablePaths).toEqual([expect.stringMatching(/orbit-w$/)]);
    // The profile the real srt builds its settings from: the worktree is writable, not write-denied as read-only.
    const fs = buildSrtSettings(museReviewerProfile(base, { checkout: '/tmp/orbit-wt', workerDir: '/tmp/orbit-w', writable: true })).filesystem;
    expect(fs.allowWrite).toContainEqual(expect.stringMatching(/orbit-wt$/));
    expect(fs.denyWrite.filter((p) => /orbit-wt$/.test(p))).toEqual([]);
  });
});

describe('quota and login failures are credential failures (FR-005)', () => {
  it('Codex: a used-up allowance ends auth_failed (reason quota), while a 429 rate limit stays transient', () => {
    const quota = classifyCodexTranscript({ events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro or try again later." } }], malformedTail: false, exit: exit({ code: 1 }), outputSchema: IMPLEMENTER, model: 'm' });
    expect(quota).toMatchObject({ status: 'auth_failed', reason: 'quota' });
    expect(quota.error).toMatch(/^out of quota: You've hit your usage limit/);
    const api = classifyCodexTranscript({ events: [{ type: 'turn.failed', error: { message: '{"status":429,"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}' } }], malformedTail: false, exit: exit({ code: 1 }), outputSchema: IMPLEMENTER, model: 'm' });
    expect(api).toMatchObject({ status: 'auth_failed', reason: 'quota' });
    const rate = classifyCodexTranscript({ events: [{ type: 'turn.failed', error: { message: '{"status":429,"error":{"message":"Rate limit reached, retry in 2s"}}' } }], malformedTail: false, exit: exit({ code: 1 }), outputSchema: IMPLEMENTER, model: 'm' });
    expect(rate.status).toBe('transient_error');
  });

  it('Muse: a usage limit in the terminal failure or on stderr ends auth_failed (reason quota)', () => {
    const terminal = classifyMuseTranscript({ events: [{ payload_type: 'run.terminal.failed', payload: { text: '', reason: 'usage limit reached for this account; try again later' } }], malformedTail: false, exit: exit({ code: 1 }), outputSchema: IMPLEMENTER, model: 'm' });
    expect(terminal).toMatchObject({ status: 'auth_failed', reason: 'quota' });
    const stderr = classifyMuseTranscript({ events: [], malformedTail: false, exit: exit({ code: 1 }), outputSchema: IMPLEMENTER, model: 'm', stderr: 'error: quota exceeded for this organization\n' });
    expect(stderr).toMatchObject({ status: 'auth_failed', reason: 'quota' });
    const plain = classifyMuseTranscript({ events: [{ payload_type: 'run.terminal.failed', payload: { text: '', reason: 'tool crashed' } }], malformedTail: false, exit: exit({ code: 1 }), outputSchema: IMPLEMENTER, model: 'm' });
    expect(plain).toMatchObject({ status: 'failed', reason: 'run_failed' });
  });

  it('partner output is untrusted: an answer that does not match the implementer schema is malformed, never accepted', () => {
    const codex = classifyCodexTranscript({ events: [{ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: '{"summary":"done"}' } }, { type: 'turn.completed', usage: {} }], malformedTail: false, exit: exit(), outputSchema: IMPLEMENTER, model: 'm' });
    expect(codex).toMatchObject({ status: 'malformed_output', reason: 'schema_mismatch', structured: null });
    const muse = classifyMuseTranscript({ events: [{ payload_type: 'run.terminal.completed', payload: { text: '{"summary":"done"}', reason: null } }], malformedTail: false, exit: exit(), outputSchema: IMPLEMENTER, model: 'm' });
    expect(muse).toMatchObject({ status: 'malformed_output', reason: 'schema_mismatch', structured: null });
  });
});
