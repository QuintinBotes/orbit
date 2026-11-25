/** `orbit doctor`: with review.mode: review-voice, the Review Voice CLI must be installed and set up (issue #231). */
import { reviewMode } from '../../policy/review.ts';
import { reviewVoiceAvailability } from '../../review/review-voice.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import type { DoctorCheck } from './doctor.ts';

/** The check, or null while the mode is off. A fail: every risky run would fall back to the default same-family reviewer. */
export function reviewVoiceCheck(config: Pick<OrbitConfig, 'review'>, env: NodeJS.ProcessEnv): DoctorCheck | null {
  if (reviewMode(config.review) !== 'review-voice') return null;
  const a = reviewVoiceAvailability(config.review.review_voice, env);
  if (a.ok) return { id: 'review.review-voice', area: 'providers', status: 'pass', summary: `Review Voice is installed and set up (${config.review.review_voice!.command.join(' ')})`, details: ['the controller runs it on the exact candidate diff, outside any worker; its corpus never enters a worker session'], missing: null, fix: null };
  return {
    id: 'review.review-voice',
    area: 'providers',
    status: 'fail',
    summary: `review.mode is review-voice but ${a.reason}; a run falls back to the default same-family reviewer and records why`,
    details: [],
    missing: 'an installed, set-up Review Voice CLI',
    fix: 'install Review Voice, run /review-voice:init, and set review.review_voice.command in .orbit/config.yaml (or set review.mode: default)',
  };
}
