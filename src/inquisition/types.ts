/**
 * Shared vocabulary of the Inquisition (spec section 10). Modes and question
 * shapes are the contract module's (they mirror schemas/inquisitor-output),
 * so a worker's output and the deterministic rules speak the same types.
 */
import type { InquisitionMode, InquisitorQuestion, Level, Reversibility } from '../contract/model-outputs.ts';

export type { InquisitionMode, InquisitorQuestion, Level, Reversibility };

export const INQUISITION_MODES: readonly InquisitionMode[] = ['clarify', 'challenge', 'reconcile', 'diagnose', 'risk-review', 'decision-record'];

/** Spec section 10 "Triggers", one id each (plus the two reviewer/decision splits the scenarios need). */
export const TRIGGER_KINDS = [
  'missing_outcomes',
  'contradictory_sources',
  'green_without_proof',
  'repeated_failure',
  'unexplained_architecture',
  'hidden_decision',
  'scope_pressure',
  'unsupported_confidence',
  'oracle_weakening',
  'reviewer_disagreement',
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export interface Trigger {
  kind: TriggerKind;
  mode: InquisitionMode;
  /** One line a human can read in a status report. */
  summary: string;
  /** What was observed: check ids, fingerprints, paths, criterion ids. Never model prose taken as fact. */
  evidence: string[];
  /** Criterion ids (AC-n) the trigger concerns; empty when it concerns the run as a whole. */
  subjects: string[];
  /**
   * Stable across detections of the same condition, so a controller can tell
   * "already inquired into this" from "something new happened".
   */
  key: string;
}

/** The criterion-level status vocabulary used by evidence reports (evidence/types.ts). */
export type EvidenceCriterionStatus = 'supported' | 'unsupported' | 'unverified' | 'blocked';

/** Qualitative only: spec section 10 forbids pretending these are calibrated probabilities. */
export const CONFIDENCE_LEVELS: readonly Level[] = ['low', 'medium', 'high'];
export const REVERSIBILITIES: readonly Reversibility[] = ['reversible', 'costly-to-reverse', 'irreversible'];
