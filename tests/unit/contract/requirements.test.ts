// Issue #200, FR-005: each MUST of the goal gets one conformance check, so the MUSTs are found first.
import { describe, expect, it } from 'vitest';
import { extractRequirements } from '../../../src/contract/requirements.ts';

describe('extractRequirements (issue #200, FR-005)', () => {
  it('keeps the id of a labelled requirement and the whole line as its wording', () => {
    const spec = [
      '### Functional Requirements',
      '',
      '- **FR-004**: The queue MUST stop after two consecutive failed runs.',
      '- **SC-001**: The lab replay is caught.',
      'FR-007: A quote whose code changes what is counted MUST be unmet; it MUST NOT pass.',
    ].join('\n');
    expect(extractRequirements([spec])).toEqual([
      { id: 'FR-004', wording: 'The queue MUST stop after two consecutive failed runs.' },
      { id: 'FR-007', wording: 'A quote whose code changes what is counted MUST be unmet; it MUST NOT pass.' },
    ]);
  });

  it('numbers an unlabelled MUST sentence, MUST NOT included, and skips the sentences around it', () => {
    expect(extractRequirements(['Export the rows. The export MUST include every page. It should be fast. Rows MUST NOT be repeated.'])).toEqual([
      { id: 'MUST-1', wording: 'The export MUST include every page.' },
      { id: 'MUST-2', wording: 'Rows MUST NOT be repeated.' },
    ]);
  });

  it('reads MUST as the verb only: "each MUST in the contract" and "a MUST NOT is met" are not requirements', () => {
    const text = ['Each MUST in the contract gets one narrow check.', 'Given a MUST and a quote, Orbit checks it.', 'A MUST NOT is met by quoting the guard.', 'Every MUST is quoted. One call per MUST is fine.', 'lowercase must is not RFC 2119.'].join('\n');
    expect(extractRequirements([text])).toEqual([]);
  });

  it('finds a MUST written with emphasis, labelled or not', () => {
    expect(extractRequirements(['The service **MUST** redirect legacy URLs.', '- **FR-009**: Logs _MUST NOT_ hold tokens.'])).toEqual([
      { id: 'MUST-1', wording: 'The service MUST redirect legacy URLs.' },
      { id: 'FR-009', wording: 'Logs MUST NOT hold tokens.' },
    ]);
  });

  it('does not end a sentence at a full stop inside a quotation', () => {
    expect(extractRequirements(['Be kind: unknown paths MUST answer 404 with the text "Page not found. Try /reports." Add a test.'])).toEqual([{ id: 'MUST-1', wording: 'Be kind: unknown paths MUST answer 404 with the text "Page not found. Try /reports."' }]);
  });

  it('skips fenced code, and counts a requirement found in two texts once', () => {
    const goal = 'The queue MUST stop after two consecutive failed runs.';
    const spec = ['```', 'The sample MUST be ignored.', '```', goal].join('\n');
    expect(extractRequirements([spec, goal])).toEqual([{ id: 'MUST-1', wording: goal }]);
  });

  it('gives a repeated label a numbered id of its own, so each requirement keeps one answer', () => {
    const r = extractRequirements(['FR-1: Logs MUST be kept.\nFR-1: Keys MUST be rotated.']);
    expect(r.map((x) => x.id)).toEqual(['FR-1', 'MUST-1']);
  });
});
