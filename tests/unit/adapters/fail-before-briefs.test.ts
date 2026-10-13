// What the role briefs say about fail-before (ADR 0014, 0.3.1 addendum), from the 0.3.0 retest:
// - reviewer: the brief told every reviewer, in every mode, to judge the probe log and to report a load-only failure as a
//   high finding. Under advisory that drove repairs (python run orb-20261013-080355-6ac27f); under required it blocked
//   every test of a new function, which can only fail on the base revision by not loading (orb-20261013-081148-e86c15),
//   and reviewers asked for stub, mutant or probe reruns that no check produces.
// - planner: it wrote "The new tests fail on the base revision (ImportError for round_price)" as AC-4 and assumed the
//   check runs the new tests, both of which Orbit checks itself.
// - inquisitor: it amended AC-4 to require recorded mutant runs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const brief = (role: string): string => readFileSync(fileURLToPath(new URL(`../../../plugin/agents/${role}.md`, import.meta.url)), 'utf8');

describe('the reviewer brief', () => {
  const text = brief('reviewer');

  it('no longer makes a load-only failure a blocking finding', () => {
    expect(text).not.toMatch(/load-only failure/i);
    expect(text).not.toMatch(/report it as a finding of high severity/);
  });

  it('says fail-before is reviewed only under required, and is not the reviewer\'s to judge otherwise', () => {
    expect(text).toMatch(/only when verification\.fail_before is required/);
    expect(text).toMatch(/advisory or off/);
  });

  it('under required: a compile, collection or import failure of a new symbol counts by policy and is not a finding; test quality is reviewed as before', () => {
    expect(text).toMatch(/A compile, collection or import failure of a new symbol counts as fail-before by policy: it is not a finding\./);
    expect(text).toMatch(/tautolog/);
    expect(text).toMatch(/cannot fail with any implementation/);
  });

  it('asks for no evidence that no check produces', () => {
    expect(text).toMatch(/Do not ask for mutant runs, stub implementations or a rerun of the probe/);
  });
});

describe('the planner brief', () => {
  const text = brief('planner');

  it('does not let the planner promise that the new tests fail on the base revision, or assume that the check runs them', () => {
    expect(text).toMatch(/Never write a criterion that the new tests fail on the base revision/);
    expect(text).toMatch(/nor an assumption that a check runs the new tests/);
    expect(text).toMatch(/verification\.fail_before/);
  });
});

describe('the inquisitor brief', () => {
  const text = brief('inquisitor');

  it('proposes no amendment that asks for evidence no check produces, and leaves Orbit\'s own evidence classifications alone', () => {
    expect(text).toMatch(/Never propose an amendment that requires evidence no check produces/);
    expect(text).toMatch(/fail-before/);
  });
});
