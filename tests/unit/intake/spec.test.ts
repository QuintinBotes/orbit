/** The spec check (issue #170, FR-002 and FR-003): deterministic, text in and text out. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ISSUE_BODY_MAX_CHARS } from '../../../src/intake/issue.ts';
import { checkSpec, reproductionOf, scenariosOf } from '../../../src/intake/spec.ts';

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../../fixtures/specs/${name}`, import.meta.url)), 'utf8');
const SPEC = fixture('calc-mul.md');

describe('spec check', () => {
  it('passes a complete spec and reads its stories, scenarios, requirements, criteria and hints', () => {
    const r = checkSpec(SPEC);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.parsed.stories.map((s) => [s.number, s.title, s.priority, s.scenarios.length])).toEqual([
      [1, 'Multiply two numbers', 'P1', 2],
      [2, 'Addition is unchanged', 'P2', 1],
    ]);
    expect(scenariosOf(r.parsed).map((s) => [s.key, s.statement])).toEqual([
      ['S1-1', 'Given two integers, When `mul(2, 3)` is called, Then it returns 6.'],
      ['S1-2', 'Given a zero operand, When `mul(0, 5)` is called, Then it returns 0.'],
      ['S2-1', 'Given the existing `add`, When `add(2, 3)` is called, Then it still returns 5.'],
    ]);
    expect(r.parsed.requirements).toEqual([{ id: 'FR-001', text: '`apps/calc.mjs` MUST export `mul`.' }]);
    expect(r.parsed.successCriteria.map((c) => c.id)).toEqual(['SC-001']);
    // The implementation notes are outside the spec: returned apart, and not in the text workers get.
    expect(r.parsed.hints).toContain('npm run verify');
    expect(r.parsed.spec).not.toContain('npm run verify');
    expect(r.parsed.spec).toContain('## Success Criteria');
  });

  it('passes the issue that specifies it, which names the marker in inline code without leaving one (SC-001)', () => {
    const r = checkSpec(fixture('issue-170.md'));
    expect(r.problems).toEqual([]);
    expect(scenariosOf(r.parsed)).toHaveLength(5);
    expect(r.parsed.requirements.map((x) => x.id)).toEqual(['FR-001', 'FR-002', 'FR-003', 'FR-004', 'FR-005', 'FR-006']);
  });

  it('gives the same answer for the same body, and for CRLF line ends', () => {
    expect(checkSpec(SPEC)).toEqual(checkSpec(SPEC));
    expect(checkSpec(SPEC.replace(/\n/g, '\r\n')).problems).toEqual([]);
  });

  it('refuses a body with a clarification marker and quotes the marker', () => {
    const r = checkSpec(SPEC.replace('- **FR-001**: `apps/calc.mjs` MUST export `mul`.', '- **FR-001**: `apps/calc.mjs` MUST export `mul` [NEEDS CLARIFICATION: also for floats?].'));
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^line \d+ still has a clarification marker: "\[NEEDS CLARIFICATION: also for floats\?\]"$/);
  });

  it('does not take a marker inside a code block for one', () => {
    expect(checkSpec(`${SPEC}\n\`\`\`\n[NEEDS CLARIFICATION: example]\n\`\`\`\n`).problems).toEqual([]);
  });

  it('refuses a story without an Independent Test and names the story', () => {
    const r = checkSpec(SPEC.replace('**Independent Test**: Run the existing add test.\n', ''));
    expect(r.problems).toEqual(['User Story 2 (Addition is unchanged) has no Independent Test: "**Independent Test**:" is missing or empty']);
  });

  it('refuses a story without a Given/When/Then line and names the story', () => {
    const r = checkSpec(SPEC.replace('1. **Given** the existing `add`, **When** `add(2, 3)` is called, **Then** it still returns 5.', '1. add keeps working'));
    expect(r.problems).toEqual([
      expect.stringMatching(/^User Story 2 \(Addition is unchanged\): the acceptance scenario on line \d+ is not a Given\/When\/Then line: "add keeps working"$/),
      'User Story 2 (Addition is unchanged) has no Given/When/Then line',
    ]);
  });

  it('refuses a story without a priority or a reason', () => {
    const r = checkSpec(SPEC.replace(' (Priority: P1)', '').replace('**Why this priority**: It is the feature.', '**Why this priority**:'));
    expect(r.problems).toEqual([
      'User Story 1 (Multiply two numbers) has no priority: its heading must end with "(Priority: P1)" or another P-number',
      'User Story 1 (Multiply two numbers) has no reason: "**Why this priority**:" is missing or empty',
    ]);
  });

  it('refuses a missing heading, each by name', () => {
    expect(checkSpec('## Summary\n\nMake it faster.\n').problems).toEqual(['the heading "User Scenarios & Testing" is missing', 'the heading "Requirements" is missing', 'the heading "Success Criteria" is missing']);
    expect(checkSpec(SPEC.replace('## Success Criteria', '## Outcomes')).problems).toEqual(['the heading "Success Criteria" is missing']);
  });

  it('accepts the template headings with their (mandatory) note', () => {
    expect(checkSpec(SPEC.replace('## Requirements', '## Requirements *(mandatory)*').replace('## Success Criteria', '## Success Criteria *(mandatory)*')).problems).toEqual([]);
    expect(checkSpec(SPEC.replace('## Requirements', '## Requirements ##  ').replace('## Success Criteria', '## Success Criteria#')).problems).toEqual([]);
  });

  it('refuses requirement and criterion ids of another form, duplicates and sections with none', () => {
    expect(checkSpec(SPEC.replace('**FR-001**', '**FR-1**')).problems).toEqual(['requirement id "FR-1" does not have the form FR-###', '"Requirements" lists no requirement with an id of the form FR-###']);
    expect(checkSpec(SPEC.replace('**SC-001**', '**SC-01**')).problems).toEqual(['success criterion id "SC-01" does not have the form SC-###', '"Success Criteria" lists no success criterion with an id of the form SC-###']);
    expect(checkSpec(SPEC.replace('- **FR-001**: `apps/calc.mjs` MUST export `mul`.', '- **FR-001**: a\n- **FR-001**: b')).problems).toEqual(['requirement id FR-001 is used twice']);
  });

  it('refuses a section of scenarios without any story', () => {
    expect(checkSpec('## User Scenarios & Testing\n\nSome prose.\n\n## Requirements\n\n- **FR-001**: x\n\n## Success Criteria\n\n- **SC-001**: y\n').problems).toEqual([
      '"User Scenarios & Testing" has no user story (a heading such as "### User Story 1 - Title (Priority: P1)")',
    ]);
  });

  it('joins a scenario wrapped over several lines and caps a very long one', () => {
    const wrapped = SPEC.replace('1. **Given** two integers, **When** `mul(2, 3)` is called, **Then** it returns 6.', '1. **Given** two integers,\n   **When** `mul(2, 3)` is called,\n   **Then** it returns 6.');
    expect(scenariosOf(checkSpec(wrapped).parsed)[0]!.statement).toBe('Given two integers, When `mul(2, 3)` is called, Then it returns 6.');
    const long = SPEC.replace('**Then** it returns 6.', `**Then** it returns 6 ${'and more '.repeat(200)}.`);
    expect(scenariosOf(checkSpec(long).parsed)[0]!.statement.length).toBeLessThanOrEqual(603);
  });

  it('finds a reproduction section, and none where the heading is absent or its section empty', () => {
    expect(reproductionOf('### Steps to reproduce\n\n1. Call `add(2, 3)`.\n2. It returns 6.\n\n### Expected\n\n5\n')).toBe('1. Call `add(2, 3)`.\n2. It returns 6.');
    expect(reproductionOf('## Reproduction\nrun it\n')).toBe('run it');
    expect(reproductionOf('It is broken.\n')).toBeNull();
    expect(reproductionOf('## Steps to reproduce\n\n## Expected\n\n5\n')).toBeNull();
  });
});

// As in tests/unit/core/redact.test.ts: the bound catches catastrophic backtracking (minutes at the cap), not a busy runner.
const LINEAR_BOUND_MS = 6_000;

describe('spec check: linear time on hostile bodies at the cap', () => {
  /** `head`, then `unit` repeated, then `tail`: as long as `orbit run --issue` accepts. */
  const fill = (head: string, unit: string, tail = ''): string => head + unit.repeat(Math.floor((ISSUE_BODY_MAX_CHARS - head.length - tail.length) / unit.length)) + tail;
  const STORY = '## User Scenarios & Testing\n\n### User Story 1 - x (Priority: P1)\n\n';
  const hostile: [string, string][] = [
    ['a heading of spaces before its last word', fill('# a', ' ', 'b')],
    ['a heading of hashes before its last word', fill('# ', '#', 'a')],
    ['a scenario of repeated Given When', fill(`${STORY}1. `, 'Given When ')],
    ['a list entry of spaces before a line separator', fill(`${STORY}- `, ' ', 'x\u2028x')],
    ['an id of digits', fill('## Requirements\n\n- **FR', '1', '!**: x')],
    ['an id entry of bold marks before a line separator', fill('## Requirements\n\n- **a', '** ', '\u2028x')],
    ['a story title of unclosed priorities', fill('## User Scenarios & Testing\n\n### User Story 1 - ', '(Priority ')],
  ];
  for (const [name, body] of hostile) {
    it(name, () => {
      expect(body.length).toBeGreaterThan(ISSUE_BODY_MAX_CHARS - 20);
      expect(body.length).toBeLessThanOrEqual(ISSUE_BODY_MAX_CHARS);
      const t0 = performance.now();
      checkSpec(body);
      reproductionOf(body);
      expect(performance.now() - t0).toBeLessThan(LINEAR_BOUND_MS);
    });
  }
});
