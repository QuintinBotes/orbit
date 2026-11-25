// Issue #233: the shared memory command, checked with the read-only recall Orbit itself makes. Silent unless
// `knowledge.shared_memory.enabled` is true. A failure is a warning: runs go on without recall and record it.
import type { OrbitConfig } from '../../policy/types.ts';
import type { DoctorCheck } from './doctor.ts';
import { recallShared, type SharedMemoryConfig, type SharedRow } from '../../knowledge/shared-memory.ts';

export interface SharedMemoryProbe {
  config: OrbitConfig;
  cwd: string;
  recall?: (memory: SharedMemoryConfig, cwd: string) => SharedRow[];
}

const probe = (memory: SharedMemoryConfig, cwd: string): SharedRow[] => recallShared(memory, cwd, { paths: [], checkIds: ['orbit-doctor'], fingerprints: [], maxTokens: 50 });

export function sharedMemoryCheck({ config, cwd, recall = probe }: SharedMemoryProbe): DoctorCheck[] {
  const memory = config.knowledge.shared_memory;
  if (memory?.enabled !== true) return [];
  const id = 'knowledge.memory';
  const warn = (summary: string, missing: string, fix: string): DoctorCheck[] => [{ id, area: 'knowledge', status: 'warn', summary, details: [], missing, fix }];
  if (memory.command.length === 0) return warn('knowledge.shared_memory is on but has no command', 'the argv of the memory command', 'set knowledge.shared_memory.command, for example ["memory"]');
  try {
    recall(memory, cwd);
  } catch (err) {
    return warn(`the shared memory command cannot be run: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200)}`, 'a memory command that answers `recall --orbit`', 'check knowledge.shared_memory.command; runs continue without shared recall');
  }
  if (config.knowledge.lessons_in_prompts !== true) return warn('shared memory is on, but lessons_in_prompts is off, so nothing is recalled into prompts (proposals and feedback still go to memory)', 'knowledge.lessons_in_prompts: true', 'turn lessons_in_prompts on, or leave recall off');
  return [{ id, area: 'knowledge', status: 'pass', summary: 'the shared memory command answers recall', details: [], missing: null, fix: null }];
}
