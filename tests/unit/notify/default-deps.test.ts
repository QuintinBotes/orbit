import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultNotifyDeps } from '../../../src/notify/channels.ts';
import { FakeThreadClient, GhThreadClient } from '../../../src/notify/threads.ts';
import { notifyConfig } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repoWithRemote(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-notify-repo-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
  return dir;
}

describe('the real collaborators', () => {
  it('run a program, and report a missing one as not found', async () => {
    const deps = defaultNotifyDeps({ PATH: process.env.PATH });
    expect(await deps.exec([process.execPath, '-e', 'process.exit(0)'], 10_000)).toEqual({ exitCode: 0, notFound: false, stderr: '' });
    expect(await deps.exec([process.execPath, '-e', 'process.stderr.write("nope"); process.exit(3)'], 10_000)).toEqual({ exitCode: 3, notFound: false, stderr: 'nope' });
    expect(await deps.exec(['orbit-no-such-notifier-acme'], 10_000)).toMatchObject({ notFound: true, exitCode: null });
    expect(await deps.exec([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], 200)).toMatchObject({ exitCode: null, stderr: 'timed out after 200 ms' });
  });

  it('post with fetch and report the status without reading the answer', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        seen.push(body);
        res.writeHead(202).end('accepted, with a body Orbit ignores');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as { port: number }).port;
      const deps = defaultNotifyDeps({});
      const r = await deps.fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}', redirect: 'error', signal: AbortSignal.timeout(5_000) });
      expect(r).toEqual({ status: 202, ok: true });
      expect(seen).toEqual(['{"text":"hi"}']);
    } finally {
      server.close();
    }
  });

  it('pick the comment client from the policy and the remote', async () => {
    const deps = defaultNotifyDeps({ GH_TOKEN: 'github_pat_acme' });
    const fake = await deps.threads('/repo/acme', notifyConfig((c) => void (c.delivery.provider = 'fake')));
    expect(fake).toBeInstanceOf(FakeThreadClient);
    const gh = await deps.threads(repoWithRemote('git@github.com:acme/app.git'), notifyConfig((c) => void (c.delivery.provider = 'github')));
    expect(gh).toBeInstanceOf(GhThreadClient);
    await expect(deps.threads(repoWithRemote('https://git.acme.test/acme/app.git'), notifyConfig((c) => void (c.delivery.provider = 'github')))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});
