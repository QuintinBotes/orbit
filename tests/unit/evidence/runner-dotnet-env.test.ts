import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkEnv, DOTNET_CHECK_ENV, NUGET_MIGRATIONS_DIR, prepareCheckHome, runChecks } from '../../../src/evidence/runner.ts';
import { checkDef, nodeCheck } from './fixtures.ts';
import { runnerEnv, type RunnerEnv } from '../../integration/evidence/harness.ts';

// Issue #10: what a check gets so the .NET SDK's first run needs nothing outside the sandbox.

const envs: RunnerEnv[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('checkEnv: the .NET SDK variables', () => {
  const paths = { homeDir: '/h', tmpDir: '/t', artifactsDir: '/a' };

  it('turns off the optional first-run steps and keeps the SDK\'s state in the check\'s private home', () => {
    const env = checkEnv(checkDef('build'), paths, '/host');
    expect(env).toMatchObject({
      DOTNET_CLI_HOME: '/h',
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
      DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false',
      DOTNET_SKIP_WORKLOAD_INTEGRITY_CHECK: '1',
    });
    for (const [k, v] of Object.entries(DOTNET_CHECK_ENV)) expect(env[k], k).toBe(v);
  });

  it('lets the check definition override any of them', () => {
    expect(checkEnv(checkDef('build', { env: { DOTNET_CLI_HOME: '/mine', DOTNET_NOLOGO: '0' } }), paths, '/host')).toMatchObject({ DOTNET_CLI_HOME: '/mine', DOTNET_NOLOGO: '0', HOME: '/h' });
  });
});

describe('prepareCheckHome', () => {
  it('marks the NuGet migrations done in an empty home, owner-only, and can run again', () => {
    const home = mkdtempSync(join(tmpdir(), 'orbit-home-'));
    dirs.push(home);
    prepareCheckHome(home);
    prepareCheckHome(home);
    const marker = join(home, NUGET_MIGRATIONS_DIR, '1');
    expect(readFileSync(marker, 'utf8')).toBe('');
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, NUGET_MIGRATIONS_DIR)).mode & 0o077).toBe(0);
  });

  it('is done for every check before it starts: the check finds the marker in its HOME', async () => {
    const script = `const fs=require("fs"),path=require("path");const m=path.join(process.env.HOME,${JSON.stringify(NUGET_MIGRATIONS_DIR)},"1");console.log(fs.existsSync(m)?"marker present":"marker missing");process.exit(fs.existsSync(m)&&process.env.DOTNET_CLI_HOME===process.env.HOME?0:1)`;
    const e = await runnerEnv([nodeCheck('home', script)]);
    envs.push(e);
    const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['home'] });
    expect(readFileSync(r!.logPath, 'utf8')).toContain('marker present');
    expect(r!.status).toBe('PASSED');
    // The private home is removed with the check's other scratch directories.
    expect(existsSync(join(e.run.runDir, 'evidence', '1', 'home', 'home'))).toBe(false);
  });
});
