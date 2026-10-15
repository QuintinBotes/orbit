import { existsSync } from 'node:fs';
import { systemClock } from '../core/clock.ts';
import { isOrbitError } from '../core/errors.ts';
import { findProcesses, findProcessesWithEnv, isAlive, isGroupAlive, terminateGroup } from '../core/proc.ts';
import { CHECK_TOKEN_ENV, isCheckShimCommandLine, readJsonFile, shimPath, type ShimExit, type ShimIntent, type ShimLaunch, type ShimPid, type ShimRegistration } from '../evidence/check-shim.ts';
import { groupOwnership, processOwnership, type GroupOwnership } from './identity.ts';

/**
 * What runs of one attempt of a check (a check run, or a fail-before probe attempt) whose controller stopped, from its
 * directory (evidence/check-shim.ts files) and the process table, and stopping it. The rule is the one for every record:
 * an attempt is closed only when its process is confirmed absent, because its open record is what keeps the run's
 * release from removing the checkout beneath it. A shim or a check group whose identity cannot be established, a stop
 * that failed or did not end it, and a check that no record names but whose token a live process carries all leave it
 * open (`mayRun`), with why in `detail`.
 */

export type CheckObservation = 'running' | 'finished' | 'lost' | 'not-started' | 'orphan-terminated';

export interface CheckSettlement {
  observation: CheckObservation;
  /** Something of the attempt may still run: its record must stay open. */
  mayRun: boolean;
  /** Leftover processes were stopped and confirmed gone. */
  terminated: boolean;
  detail: string | null;
}

/** What a check directory's shim records say, each counted only when it carries the intent's token. */
interface CheckFiles {
  exited: boolean;
  /** The shim's pid: launch.json's, else pid.json's, else the one it registered. */
  shimPid: number | null;
  /** launch.json's start time of the shim. */
  shimStart: string | null;
  childPgid: number | null;
  /** When pid.json was written (the check had just been spawned). */
  startedAt: number | null;
  /** The shim registered itself, so it may have reached the spawn. */
  registered: boolean;
  registeredAt: number | null;
}

function checkFiles(dir: string, token: string): CheckFiles {
  const exit = readJsonFile<ShimExit>(shimPath(dir, 'exit'));
  const launch = readJsonFile<ShimLaunch>(shimPath(dir, 'launch'));
  const pidFile = readJsonFile<ShimPid>(shimPath(dir, 'pid'));
  const registration = readJsonFile<ShimRegistration>(shimPath(dir, 'registration'));
  const ownLaunch = launch !== null && launch.token === token ? launch : null;
  const ownPid = pidFile !== null && pidFile.token === token ? pidFile : null;
  const ownRegistration = registration !== null && registration.token === token && typeof registration.shimPid === 'number' ? registration : null;
  return {
    exited: exit !== null && exit.token === token,
    shimPid: ownLaunch?.pid ?? ownPid?.shimPid ?? ownRegistration?.shimPid ?? null,
    shimStart: ownLaunch ? ownLaunch.procStart : null,
    childPgid: ownPid ? ownPid.childPgid : null,
    startedAt: ownPid ? ownPid.startedAt : null,
    registered: ownRegistration !== null,
    registeredAt: ownRegistration?.registeredAt ?? null,
  };
}

/**
 * Settle one attempt whose directory holds `intent`. With `stop` (its run is over, or the attempt is never reattached)
 * a live shim that is verifiably the one started is stopped, and the attempt may close only once the shim and its
 * check are confirmed gone. Without it a live shim is left running. A check whose shim is gone without exit.json is
 * stopped either way: a rerun in the same checkout must not race it.
 */
export async function settleCheckAttempt(dir: string, intent: ShimIntent, opts: { stop: boolean; graceMs: number }): Promise<CheckSettlement> {
  const files = checkFiles(dir, intent.token);
  const { shimPid, shimStart, startedAt, registeredAt } = files;
  if (files.exited) return { observation: 'finished', mayRun: false, terminated: false, detail: null };
  // Without launch.json's start time, the shim is identified by when it recorded itself (pid.json, registration.json) or was asked for (intent.json).
  const identityNow = (): ShimIdentity => (shimPid === null ? 'dead' : shimIdentity(shimPid, shimStart, startedAt ?? registeredAt ?? intent.writtenAt));
  const identity = identityNow();

  if (shimPid !== null && identity !== 'dead') {
    if (!opts.stop) return { observation: 'running', mayRun: true, terminated: false, detail: null };
    if (identity === 'unknown') {
      return { observation: 'running', mayRun: true, terminated: false, detail: `process ${shimPid} may be this check's shim, but its identity cannot be established, so it was not signalled; its row stays open for a later pass` };
    }
    const why = await stopCheck(dir, intent.token, shimPid, identityNow, files.childPgid, opts.graceMs);
    if (why === null) return { observation: 'orphan-terminated', mayRun: false, terminated: true, detail: null };
    return { observation: 'running', mayRun: true, terminated: false, detail: `its shim (process ${shimPid}) or its check could not be confirmed stopped (${why}); its row stays open for a later pass` };
  }
  if (shimPid === null) {
    // Only the intent is on disk: the shim never spawned, or the controller died between the spawn and launch.json and
    // the shim has not registered yet (it registers before it spawns the check, so no check of it runs).
    const spawned = checkShimSearch(dir, intent.token);
    if (spawned === null) return { observation: 'not-started', mayRun: false, terminated: false, detail: null };
    return { observation: 'running', mayRun: true, terminated: false, detail: spawned };
  }
  // The shim is gone without exit.json. Its check may still be running.
  const left = await orphanedCheck(intent.token, files, opts.graceMs);
  return { observation: 'lost', mayRun: left.why !== null, terminated: left.terminated, detail: left.why };
}

/**
 * Whether the shim of a check whose directory names no shim was spawned after all: null when no process carries the
 * intent's token on a check shim command line (isCheckShimCommandLine), and nothing of the shim appeared on disk
 * meanwhile; otherwise why the check may still run.
 */
function checkShimSearch(dir: string, token: string): string | null {
  let found: number[];
  try {
    found = findProcesses((line) => isCheckShimCommandLine(line, dir, token));
  } catch (err) {
    return `the process table could not be searched for its shim (${messageOf(err)}), so it may have been spawned; its row stays open for a later pass`;
  }
  if (found.length > 0) return `process ${found.join(', ')} carries its launch token but launch.json does not name it yet, so it was not signalled; its row stays open for a later pass`;
  // A shim that recorded itself and ended between the first read and the search: the next pass judges it by its records.
  const late = checkFiles(dir, token);
  if (late.exited || late.shimPid !== null) return 'its shim recorded itself while recovery looked for it; its row stays open for a later pass';
  return null;
}

/**
 * Why a process of a check whose group no record names may still run, from its token in the environments of the
 * process table (every process of the check inherits it); null when no process carries it.
 */
export function checkTokenSearch(token: string): string | null {
  let found: number[];
  try {
    found = findProcessesWithEnv(CHECK_TOKEN_ENV, token);
  } catch (err) {
    return `no record names its check's process group, and the process table could not be searched for its token (${messageOf(err)})`;
  }
  if (found.length > 0) return `no record names its check's process group, and process ${found.join(', ')} carries its token in its environment`;
  return null;
}

/** A check whose shim is gone without exit.json: its group stopped when a record names it, else its token searched for. */
async function orphanedCheck(token: string, files: CheckFiles, graceMs: number): Promise<{ terminated: boolean; why: string | null }> {
  const { childPgid, startedAt } = files;
  if (childPgid !== null && startedAt !== null) {
    const stop = await stopOrphanGroup(childPgid, startedAt, graceMs);
    if (stop === 'unknown') {
      return { terminated: false, why: `its shim is gone and its check's process group ${childPgid} could not be confirmed stopped (its identity could not be established, or the stop failed or did not end it); its row stays open for a later pass` };
    }
    return { terminated: stop === 'stopped', why: null };
  }
  // The shim registers before the spawn: one that never did never started the check.
  if (!files.registered) return { terminated: false, why: null };
  // It may have been killed between the spawn and pid.json.
  const found = checkTokenSearch(token);
  return { terminated: false, why: found === null ? null : `its shim is gone, ${found}, so it may still run; its row stays open for a later pass` };
}

type ShimIdentity = 'ours' | 'unknown' | 'dead';

/**
 * Whether `pid` is still the check shim that was started. With launch.json's
 * start time, core/proc compares it exactly. Without it (the controller died
 * before writing launch.json), a bare pid proves nothing: a recycled pid would
 * read as a live shim and be signalled, so the process start is compared with
 * the time the record was written instead. 'unknown' (no ps) is treated as
 * running but never signalled.
 */
function shimIdentity(pid: number, start: string | null, recordedAtMs: number): ShimIdentity {
  if (start !== null) {
    try {
      return isAlive(pid, start) ? 'ours' : 'dead';
    } catch {
      return 'unknown';
    }
  }
  const own = processOwnership(pid, recordedAtMs);
  return own === 'ours' ? 'ours' : own === 'unknown' ? 'unknown' : 'dead';
}

/**
 * SIGTERM the shim (it stops its check's group and writes exit.json), SIGKILL it when it outlives the wait, then stop
 * the check's group: null only when the shim is confirmed gone and the check with it, otherwise why not. A check whose
 * group no record names (the shim was killed between the spawn and pid.json) is confirmed gone only when no process
 * carries its token; one whose shim never registered never started.
 */
async function stopCheck(dir: string, token: string, shimPid: number, identity: () => ShimIdentity, childPgid: number | null, graceMs: number): Promise<string | null> {
  try {
    process.kill(shimPid, 'SIGTERM');
  } catch {
    /* exited in between */
  }
  // Real time: the wait is for a real process, whatever clock the caller injected.
  const waitWhileOurs = async (ms: number, untilExit: boolean): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !(untilExit && existsSync(shimPath(dir, 'exit'))) && identity() === 'ours') await systemClock.sleep(25);
  };
  await waitWhileOurs(graceMs * 2 + 1_000, true);
  // Identity again, not bare liveness: the shim may have exited and its pid been reused during the wait.
  if (identity() === 'ours') {
    try {
      process.kill(shimPid, 'SIGKILL');
    } catch {
      /* gone */
    }
    await waitWhileOurs(graceMs + 1_000, false);
  }
  if (identity() !== 'dead') return 'the shim did not end, or its identity could no longer be established';
  // The shim was verified alive moments ago, so its check's group is ours; it may have recorded the group during the wait.
  const late = checkFiles(dir, token);
  const pgid = childPgid ?? late.childPgid;
  if (pgid !== null) {
    try {
      if (!isGroupAlive(pgid)) return null;
      return (await terminateGroup(pgid, graceMs)).exited ? null : `its check's process group ${pgid} did not end`;
    } catch (err) {
      if (isOrbitError(err, 'INTERNAL')) return `its check's process group ${pgid} could not be signalled (${messageOf(err)})`;
      throw err;
    }
  }
  if (!late.registered) return null;
  return checkTokenSearch(token);
}

/**
 * Stop the process group of a check whose shim is gone: 'gone' when nothing of it runs (no member, or a leader with
 * another start time, a recycled pid: a pid is not reused while a group of that id exists), 'stopped' when it was
 * stopped and confirmed ended, 'unknown' when its identity cannot be established or the stop failed or did not end it.
 */
async function stopOrphanGroup(pgid: number, startedAt: number, graceMs: number): Promise<'gone' | 'stopped' | 'unknown'> {
  let own: GroupOwnership;
  try {
    own = groupOwnership(pgid, startedAt);
  } catch (err) {
    if (isOrbitError(err, 'INTERNAL')) return 'unknown';
    throw err;
  }
  if (own === 'gone' || own === 'foreign') return 'gone';
  if (own === 'unknown') return 'unknown';
  try {
    return (await terminateGroup(pgid, graceMs)).exited ? 'stopped' : 'unknown';
  } catch (err) {
    if (isOrbitError(err, 'INTERNAL')) return 'unknown';
    throw err;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
