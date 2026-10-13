// What the role briefs say about fail-before (ADR 0014, 0.3.1 addendum), from the 0.3.0 retest:
// - reviewer: the brief told every reviewer, in every mode, to judge the probe log and to report a load-only failure as a
//   high finding. Under advisory that drove repairs (python run orb-20261013-080355-6ac27f); under required it blocked
//   every test of a new function, which can only fail on the base revision by not loading (orb-20261013-081148-e86c15),
//   and reviewers asked for stub, mutant or probe reruns that no check produces.
// - planner: it wrote "The new tests fail on the base revision (ImportError for round_price)" as AC-4 and assumed the
//   check runs the new tests, both of which Orbit checks itself.
// - inquisitor: it amended AC-4 to require recorded mutant runs, and told the implementer to keep the ImportError "as the
//   contract states".
// Whether a finding only disputes Orbit's own recorded evidence classification is structure, not wording (the lead's
// decision after three rounds of adversarial review): the reviewer files it under the category evidence-classification,
// and only for that; and the draft never removes a criterion, so the briefs carry the rule.
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

  // The retest's AC-4, "The new tests fail on the base revision (ImportError for round_price) and pass with the change",
  // stays in the contract now that the draft never removes a criterion. Under advisory the packet showed it as a
  // mandatory criterion backed only by the candidate's passing log, and the natural finding ("no evidence the new tests
  // fail before the change") blocked as a claim the candidate cannot answer. The brief now says, in every mode and by
  // structure (no criterion's wording is read), that this promise is Orbit's to keep, not the candidate's.
  it('in every mode: a criterion\'s promise that the new tests fail on the base revision is Orbit\'s to establish, not a finding, and does not withhold APPROVE', () => {
    const one = text.replace(/\s+/g, ' ');
    expect(one).toMatch(/In every mode, whether the new tests fail on the base revision is Orbit's to establish through verification\.fail_before/);
    expect(one).toMatch(/under advisory and off it is reported to the person/);
    expect(one).toMatch(/A criterion's promise of it is therefore not a finding against the candidate and does not withhold APPROVE: judge the criterion's other clauses as usual\./);
    expect(one).toMatch(/A finding that disputes only that promise uses the category "evidence-classification"\./);
    // The APPROVE rule says the same, so "every mandatory criterion has evidence" cannot be read to require it.
    expect(one).toMatch(/APPROVE only when every mandatory criterion has evidence for its clauses other than such a promise/);
  });

  it('files a finding that only disputes a recorded evidence classification under the category evidence-classification, and nothing else there', () => {
    const one = text.replace(/\s+/g, ' ');
    expect(one).toMatch(/category "evidence-classification" only for a finding that disputes a classification Orbit recorded of its own evidence, or a criterion's promise of one \(today the fail-before outcome\), and asks for nothing a change to the candidate can give/);
    expect(one).toMatch(/A finding about the tests' content, coverage or assertions, or about the code's behaviour, uses its normal category/);
    expect(one).toMatch(/A finding that disputes the recorded classification and also names such a defect uses the normal category/);
    expect(one).toMatch(/reported as a note: it never blocks and is never repaired/);
    expect(one).toMatch(/A finding with a SEC- id is never a note\./);
  });
});

describe('the planner brief', () => {
  const text = brief('planner');

  it('does not let the planner promise that the new tests fail on the base revision, or assume that the check runs them', () => {
    expect(text).toMatch(/Never write a criterion that the new tests fail on the base revision/);
    expect(text).toMatch(/nor an assumption that a check runs the new tests/);
    expect(text).toMatch(/verification\.fail_before/);
  });

  it('no longer says such a criterion is dropped: Orbit never removes a criterion', () => {
    expect(text).not.toMatch(/is dropped/);
  });
});

describe('the inquisitor brief', () => {
  const text = brief('inquisitor');

  it('proposes no amendment that asks for evidence no check produces, and leaves Orbit\'s own evidence classifications alone', () => {
    expect(text).toMatch(/Never propose an amendment that requires evidence no check produces/);
    expect(text).toMatch(/fail-before/);
  });

  it('never requires fail-before mechanics, since Orbit\'s probe establishes fail-before', () => {
    const one = text.replace(/\s+/g, ' ');
    expect(one).toMatch(/Never require fail-before mechanics: no mutant run, no stub implementation, and no keeping of an import error "as the contract states"/);
    expect(one).toMatch(/Orbit's fail-before probe establishes whether the new tests fail on the base revision/);
  });
});

describe('the review output schema', () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../../schemas/review-output.schema.json', import.meta.url)), 'utf8')) as {
    properties: { findings: { items: { properties: { category: { description: string } } } } };
  };
  const category = schema.properties.findings.items.properties.category.description;

  it('defines evidence-classification as the reviewer brief does: a recorded classification, or a criterion\'s promise of one', () => {
    expect(category).toMatch(/evidence-classification is reserved for a finding that disputes a classification Orbit recorded of its own evidence, or a criterion's promise of one \(today the fail-before outcome\), and asks for nothing a change to the candidate can give/);
  });

  it('says a finding whose id says security is never a note', () => {
    expect(category).toMatch(/whose id is not a SEC- one/);
  });
});
