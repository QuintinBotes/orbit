import lessonSchema from '../../schemas/lesson.schema.json' with { type: 'json' };
import { schemaErrors, validate } from '../core/schema.ts';
import type { Lesson } from './types.ts';

/** Schema errors for a candidate lesson; empty when it conforms to orbit.lesson/1. */
export function lessonSchemaErrors(value: unknown): string[] {
  return schemaErrors(lessonSchema, value);
}

/**
 * Every lesson that reaches the store, from any source, passes the published
 * schema first, so nothing downstream ever handles a malformed node.
 */
export function assertLesson(value: unknown): asserts value is Lesson {
  validate<Lesson>(lessonSchema, value, 'lesson');
}
