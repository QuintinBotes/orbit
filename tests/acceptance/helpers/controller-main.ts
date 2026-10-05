// A real controller process for the restart, crash and cancellation scenarios:
// the lab's fake-backed adapters, the repository's state database and the
// Controller loop with short leases. It runs until SIGTERM/SIGINT (service
// mode), until its run is terminal (foreground), or until a test kills it.
// ORBIT_FAULTS in its environment arms the named fault points (core/faults).
import { readFileSync } from 'node:fs';
import { systemClock } from '../../../src/core/clock.ts';
import { createLogger } from '../../../src/core/log.ts';
import { openDb } from '../../../src/storage/db.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { stateDbPath } from '../../../src/controller/start.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { labAdapters, ORBIT_ROOT } from './lab.ts';

const args = JSON.parse(process.argv[2]!) as {
  repo: string;
  orbitHome: string;
  configPath: string;
  scenarioPath: string;
  argvLog: string;
  mode: 'service' | 'foreground';
  runId?: string;
  leaseTtlMs?: number;
};

const config = JSON.parse(readFileSync(args.configPath, 'utf8')) as OrbitConfig;
const db = openDb(stateDbPath(args.repo));
const clock = systemClock;
const controller = new Controller({
  mode: args.mode,
  ...(args.runId ? { runId: args.runId } : {}),
  deps: {
    db,
    clock,
    logger: createLogger({ stderr: true, level: 'info', clock }),
    adapters: labAdapters({ config, scenarioPath: args.scenarioPath, argvLog: args.argvLog }),
    registry: new ModelRegistry(db, clock),
    orbitHome: args.orbitHome,
    hostEnv: process.env,
    orbitInstallDir: ORBIT_ROOT,
    gitleaksPath: null,
    timing: { checkPollMs: 50, killGraceMs: 300, ciAbsentGraceMs: 0, workerTimeoutMs: 180_000 },
  },
  leaseTtlMs: args.leaseTtlMs ?? 1_500,
  leaseRenewMs: 250,
  heartbeatMs: 250,
  tickIntervalMs: 100,
  handleSignals: true,
  graceMs: 300,
  startGraceMs: 2_000,
});
process.stdout.write(`controller ${controller.ownerId} pid ${process.pid}\n`);
await controller.start();
db.close();
process.exit(0);
