import { ManualClock } from '../../../src/core/clock.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { lessonIdFor } from '../../../src/knowledge/text.ts';
import type { Applicability, EvidenceRef, Lesson, LessonKind } from '../../../src/knowledge/types.ts';

export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);

export function openStore(clock = new ManualClock()): { store: KnowledgeStore; clock: ManualClock } {
  return { store: KnowledgeStore.open(':memory:', { clock }), clock };
}

export function ev(runId: string, artifact = 'evidence/1/unit.log', relation: EvidenceRef['relation'] = 'supports', sha: string | null = SHA_A): EvidenceRef {
  return { run_id: runId, artifact, sha256: sha, relation };
}

export interface LessonInput extends Partial<Omit<Lesson, 'applicability'>> {
  applicability?: Partial<Applicability>;
}

/** A valid lesson; the id follows the statement unless one is given. */
export function makeLesson(input: LessonInput = {}): Lesson {
  const kind: LessonKind = input.kind ?? 'practice';
  const statement = input.statement ?? 'Add a negative test for every new validation rule.';
  return {
    schema: 'orbit.lesson/1',
    id: input.id ?? lessonIdFor(kind, statement),
    kind,
    statement,
    rationale: input.rationale ?? 'Validation rules without negative tests silently accept bad input after refactors.',
    applicability: {
      languages: [],
      frameworks: [],
      paths: [],
      check_ids: [],
      fingerprints: [],
      roles: [],
      keywords: [],
      ...(input.applicability ?? {}),
    },
    verification: input.verification ?? 'Each validation rule has a test that feeds it invalid input and expects a refusal.',
    evidence: input.evidence ?? [ev('run-1')],
    provenance: input.provenance ?? { source: 'run', uri: null, derived_from: ['obs-000000000001'], generated_by: 'curator-test-model', generated_at: '2026-10-03T00:00:00.000Z' },
    confidence: input.confidence ?? 'medium',
    status: input.status ?? 'candidate',
    scope: input.scope ?? 'repo',
    code_free: input.code_free ?? true,
    supersedes: input.supersedes ?? null,
  };
}
