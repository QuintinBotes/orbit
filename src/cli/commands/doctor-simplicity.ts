/**
 * `orbit doctor` and admission: the simplicity gate (issue #232) runs Unknot's base-compared diagnosis in a checkout of
 * the candidate, so with a check named `simplicity` configured three things must hold: unknot runs where checks run (on
 * the PATH the check itself gets) and is 0.4.0 or newer (older ones ignore --baseline and would pass everything), and
 * the repository is an Unknot project with its .gitignore committed (else every candidate fails with UK_NOT_INITIALIZED,
 * or a check writes into its checkout). Doctor says which fails, with the step; `orbit run` refuses to start.
 */
import { isSimplicityCheck, probeUnknot, type UnknotProbe, UNKNOT_INSTALL, UNKNOT_INIT, unknotProjectProblem, unknotVersionProblem } from '../../evidence/simplicity.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import type { DoctorCheck } from './doctor.ts';

export interface SimplicityInput {
  config: OrbitConfig;
  /** The environment checks inherit from this process (its PATH is the one a check gets, unless the check sets its own). */
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** The repository's tracked files, relative (git ls-files). */
  files: readonly string[];
  /** `unknot --version` under the given environment (default: ask the machine). */
  probe?: (env: Readonly<Record<string, string | undefined>>) => Promise<UnknotProbe>;
}

interface Problem {
  ids: string[];
  problem: string | null;
  fix: string | null;
  version: string | null;
}

async function problemOf(input: SimplicityInput): Promise<Problem> {
  const ids = Object.keys(input.config.checks).filter(isSimplicityCheck);
  if (ids.length === 0) return { ids, problem: null, fix: null, version: null };
  // The runner gives a check the controller's PATH unless the check's own env sets one.
  const checkPath = ids.map((id) => input.config.checks[id]!.env.PATH).find((p) => typeof p === 'string');
  const env = checkPath ? { ...input.env, PATH: checkPath } : input.env;
  const probe = await (input.probe ?? ((e) => probeUnknot(e, input.cwd)))(env);
  const versionProblem = unknotVersionProblem(probe);
  if (versionProblem !== null) return { ids, problem: versionProblem, fix: UNKNOT_INSTALL, version: null };
  const projectProblem = unknotProjectProblem(input.files);
  if (projectProblem !== null) return { ids, problem: projectProblem, fix: UNKNOT_INIT, version: null };
  return { ids, problem: null, fix: null, version: probe.state === 'ok' ? probe.output : null };
}

export async function simplicityCheck(input: SimplicityInput): Promise<DoctorCheck[]> {
  const { ids, problem, fix, version } = await problemOf(input);
  if (ids.length === 0) return [];
  const id = 'checks.simplicity';
  const area = 'checks';
  if (problem === null) return [{ id, area, status: 'pass', summary: `unknot ${version} runs the simplicity check (${ids.join(', ')})`, details: [], missing: null, fix: null }];
  return [{ id, area, status: 'fail', summary: `the simplicity check (${ids.join(', ')}) is unavailable: ${problem}`, details: [], missing: 'unknot 0.4.0 or newer on the checks\' PATH, in a repository with a committed .unknot', fix }];
}

/** A run with the gate configured and unavailable does not start; the same words as doctor's. */
export async function simplicityRefusal(input: SimplicityInput): Promise<{ reason: string; fix: string } | null> {
  const { ids, problem, fix } = await problemOf(input);
  return problem === null ? null : { reason: `the simplicity check (${ids.join(', ')}) is unavailable: ${problem}`, fix: fix! };
}
