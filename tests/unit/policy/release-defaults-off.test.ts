/**
 * Issues #173 and #175 ship off: lessons stay out of worker prompts and the repository map's prompt slice stays out
 * of planner and reviewer prompts until a person turns them on (#176's default is in implementers-config.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig, repoMapPolicy } from '../../../src/policy/config.ts';

const BASE = 'version: 1\nmode: autonomous\nscope: {allowed_paths: ["src/**"]}\n';

describe('features that ship off', () => {
  it('lessons in prompts (#173) default to off, built in and from a minimal policy file', () => {
    expect(defaultConfig().knowledge.lessons_in_prompts).toBe(false);
    expect(parseConfig(BASE).knowledge.lessons_in_prompts).toBe(false);
  });

  it("the repository map's prompt slice (#175) defaults to off, built in and from a minimal policy file", () => {
    expect(repoMapPolicy(defaultConfig()).prompt_slice).toBe(false);
    expect(repoMapPolicy(parseConfig(BASE)).prompt_slice).toBe(false);
  });
});
