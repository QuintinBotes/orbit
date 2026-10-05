import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChecks } from '../../../src/evidence/runner.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { nodeCheck } from '../../unit/evidence/fixtures.ts';
import { checkDirOf, pidGone, runnerEnv, waitFor, type RunnerEnv } from './harness.ts';

/**
 * The same runner through the real OS sandbox. Skipped, with the probe's
 * reason, on hosts where srt cannot run (missing binary, nested sandbox).
 */
const installDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const provider = new SandboxRuntimeIsolation({ orbitInstallDir: installDir });
const probe = await provider.available();

const envs: RunnerEnv[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

describe.skipIf(!probe.ok)(probe.ok ? 'runChecks through sandbox-runtime' : `runChecks through sandbox-runtime skipped: ${probe.detail}`, () => {
  async function setup(script: string, extra: Record<string, unknown> = {}) {
    const e = await runnerEnv([nodeCheck('sb', script, extra)], { isolation: provider });
    envs.push(e);
    return e;
  }

  it('runs a passing check, lets it write its checkout and artifacts, and records the sandbox limitations', async () => {
    const e = await setup('const fs=require("fs");fs.writeFileSync("built.txt","ok");fs.writeFileSync(process.env.ORBIT_ARTIFACTS_DIR+"/out.txt","a");console.log("sandboxed ok")');
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['sb'] });
    expect(r).toMatchObject({ status: 'PASSED', isolation: 'sandbox-runtime' });
    expect(readFileSync(r!.logPath, 'utf8')).toContain('sandboxed ok');
    expect(r!.artifacts.some((a) => a.path.endsWith('out.txt'))).toBe(true);
    expect(existsSync(join(e.checkoutDir, 'built.txt'))).toBe(true);
  });

  it('denies writes outside the checkout and reads of planted credentials', async () => {
    // The checkout sits next to the fake home in the test root, so the script can find both from its cwd.
    const script = `const fs=require("fs"),path=require("path");const root=path.dirname(process.cwd());const denied=[];
try{fs.writeFileSync(path.join(root,"outside.txt"),"x")}catch(e){denied.push("write")}
try{fs.readFileSync(path.join(root,"home",".ssh","id_ed25519"))}catch(e){denied.push("read")}
console.log("denied:"+denied.join(","));process.exit(denied.length===2?0:1)`;
    const e = await setup(script);
    mkdirSync(join(e.t.root, 'home', '.ssh'), { recursive: true });
    writeFileSync(join(e.t.root, 'home', '.ssh', 'id_ed25519'), 'FAKE-KEY-acme');
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['sb'] });
    expect(readFileSync(r!.logPath, 'utf8')).toContain('denied:write,read');
    expect(r!.status).toBe('PASSED');
    expect(existsSync(join(e.t.root, 'outside.txt'))).toBe(false);
    expect(existsSync(checkDirOf(e, 'sb'))).toBe(true);
  });

  // A test suite that starts an HTTP server on loopback (the demo app's `unit` check) listens, then reaches itself.
  const LOOPBACK_SERVER = `const net=require("net");
const server=net.createServer((c)=>c.end("pong"));
server.on("error",(e)=>{console.error("Error: "+e.message);process.exit(1)});
server.listen(0,"127.0.0.1",()=>{
  const c=net.connect(server.address().port,"127.0.0.1");let got="";
  c.on("data",(d)=>{got+=d});
  c.on("error",(e)=>{console.error("Error: connect "+e.code);process.exit(2)});
  c.on("end",()=>{console.log("loopback "+got);server.close()});
});`;

  it('lets a check that may bind loopback listen on 127.0.0.1 and reach itself (local_binding: true)', async () => {
    const e = await setup(LOOPBACK_SERVER, { local_binding: true });
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['sb'] });
    expect(readFileSync(r!.logPath, 'utf8')).toContain('loopback pong');
    expect(r).toMatchObject({ status: 'PASSED', exitCode: 0, isolation: 'sandbox-runtime' });
  });

  it('still denies the same bind when the check says local_binding: false', async () => {
    const e = await setup(LOOPBACK_SERVER, { local_binding: false });
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['sb'] });
    if (process.platform === 'darwin') {
      expect(r!.status).toBe('FAILED');
      expect(readFileSync(r!.logPath, 'utf8')).toMatch(/listen EPERM/);
      expect(readFileSync(r!.logPath, 'utf8')).not.toContain('loopback pong');
    } else {
      // srt's allowLocalBinding is macOS-only: a Linux sandbox always has a private loopback, which the check may bind and nothing outside can reach.
      expect(r!.status).toBe('PASSED');
      expect(readFileSync(r!.logPath, 'utf8')).toContain('loopback pong');
    }
  });

  it('cancels a sandboxed check and leaves nothing running', async () => {
    const e = await setup('setInterval(()=>{},1000)', { timeout_seconds: 120 });
    const ac = new AbortController();
    const pending = runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['sb'], signal: ac.signal });
    await waitFor(() => existsSync(join(checkDirOf(e, 'sb'), 'pid.json')));
    ac.abort();
    const [r] = await pending;
    expect(r).toMatchObject({ status: 'CANCELLED', isolation: 'sandbox-runtime' });
    const pids = JSON.parse(readFileSync(join(checkDirOf(e, 'sb'), 'pid.json'), 'utf8')) as { shimPid: number; childPgid: number };
    await waitFor(() => pidGone(pids.shimPid), 5_000);
    await waitFor(() => pidGone(-pids.childPgid), 5_000);
  });
});
