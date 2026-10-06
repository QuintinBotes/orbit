import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultConfig, notificationsPolicy, parseConfig } from '../../../src/policy/config.ts';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';

function problems(text: string): string[] {
  try {
    parseConfig(text);
  } catch (err) {
    expect(isOrbitError(err, 'CONFIG_INVALID')).toBe(true);
    return ((err as OrbitError).details?.problems as string[]) ?? [];
  }
  throw new Error('expected CONFIG_INVALID');
}

describe('notifications policy (ADR 0008)', () => {
  it('defaults to desktop on, webhook, comments and remote answers off', () => {
    expect(parseConfig('version: 1\n').notifications).toEqual({ desktop: true, webhook: null, github_comment: false, remote_answers: { enabled: false, issue: null, poll_seconds: 120 } });
  });

  it('accepts every channel, with the webhook URL named by a variable', () => {
    const c = parseConfig('version: 1\nnotifications:\n  desktop: false\n  webhook:\n    url_env: ACME_WEBHOOK_URL\n  github_comment: true\n  remote_answers:\n    enabled: true\n    issue: 42\n');
    expect(c.notifications).toEqual({ desktop: false, webhook: { url_env: 'ACME_WEBHOOK_URL' }, github_comment: true, remote_answers: { enabled: true, issue: 42, poll_seconds: 120 } });
  });

  it('never takes a URL in the config file: url_env must be a variable name', () => {
    expect(problems('version: 1\nnotifications:\n  webhook:\n    url_env: https://hooks.acme.test/T/B/x\n').join('\n')).toMatch(/notifications\.webhook/);
    expect(problems('version: 1\nnotifications:\n  webhook:\n    url: https://hooks.acme.test/T/B/x\n').join('\n')).toMatch(/notifications\.webhook/);
  });

  it('refuses a credential variable as the webhook URL', () => {
    expect(problems('version: 1\nnotifications:\n  webhook:\n    url_env: GH_TOKEN\n')).toContain('notifications.webhook.url_env: GH_TOKEN holds a credential, not a webhook URL; name a variable that holds only the URL (for example ORBIT_WEBHOOK_URL)');
  });

  it('bounds the poll interval and needs a positive issue number', () => {
    expect(problems('version: 1\nnotifications:\n  remote_answers:\n    poll_seconds: 5\n').join('\n')).toMatch(/poll_seconds/);
    expect(problems('version: 1\nnotifications:\n  remote_answers:\n    issue: 0\n').join('\n')).toMatch(/issue/);
    expect(problems('version: 1\nnotifications:\n  sms: true\n').join('\n')).toMatch(/sms/);
  });

  it('a snapshot written before the section existed reads the defaults', () => {
    const old = defaultConfig('autonomous');
    delete old.notifications;
    expect(notificationsPolicy(old)).toEqual({ desktop: true, webhook: null, github_comment: false, remote_answers: { enabled: false, issue: null, poll_seconds: 120 } });
    expect(notificationsPolicy({ notifications: { desktop: false, webhook: null, github_comment: true } as never }).remote_answers.poll_seconds).toBe(120);
  });

  it('the starter template documents the section and validates', () => {
    const template = readFileSync(new URL('../../../templates/config.yaml', import.meta.url), 'utf8');
    expect(template).toMatch(/^notifications:/m);
    expect(parseConfig(template).notifications?.desktop).toBe(true);
  });
});
