/**
 * `orbit doctor` and admission: the simplicity gate (issue #232) runs Unknot's base-compared diagnosis, so with a check
 * whose id is `simplicity` configured, an Unknot that is not installed, or older than 0.4.0 (which ignores --baseline and
 * would pass everything), makes the check unavailable. Doctor says so with the install step; `orbit run` refuses to start.
 */
import { isSimplicityCheck, probeUnknot, UNKNOT_INSTALL, unknotVersionProblem } from '../../evidence/simplicity.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import type { DoctorCheck } from './doctor.ts';

export interface SimplicityInput {
  config: OrbitConfig;
  /** `unknot --version` output where checks run, or null (default: ask the machine). */
  probe?: () => Promise<string | null>;
}

const configured = (config: OrbitConfig): string[] => Object.keys(config.checks).filter(isSimplicityCheck);

/** Why the configured gate cannot run, or null when it can or none is configured. */
async function problemOf(input: SimplicityInput): Promise<{ ids: string[]; problem: string | null; version: string | null }> {
  const ids = configured(input.config);
  if (ids.length === 0) return { ids, problem: null, version: null };
  const version = await (input.probe ?? (() => probeUnknot(process.env, process.cwd())))();
  return { ids, problem: unknotVersionProblem(version), version };
}

export async function simplicityCheck(input: SimplicityInput): Promise<DoctorCheck[]> {
  const { ids, problem, version } = await problemOf(input);
  if (ids.length === 0) return [];
  const id = 'checks.simplicity';
  const area = 'checks';
  if (problem === null) return [{ id, area, status: 'pass', summary: `unknot ${version} runs the simplicity check (${ids.join(', ')})`, details: [], missing: null, fix: null }];
  return [{ id, area, status: 'fail', summary: `the simplicity check (${ids.join(', ')}) is unavailable: ${problem}`, details: [], missing: 'unknot 0.4.0 or newer on PATH', fix: UNKNOT_INSTALL }];
}

/** A run with the gate configured and unavailable does not start; the same words as doctor's. */
export async function simplicityRefusal(input: SimplicityInput): Promise<{ reason: string; fix: string } | null> {
  const { ids, problem } = await problemOf(input);
  return problem === null ? null : { reason: `the simplicity check (${ids.join(', ')}) is unavailable: ${problem}`, fix: UNKNOT_INSTALL };
}
