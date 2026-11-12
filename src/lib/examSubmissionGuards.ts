// ─── Exam Submission Guards ───────────────────────────────────────────────────
// Pure, dependency-free helpers shared by the student runner, the grading modal,
// the draft service, and the submission outbox. Kept pure so the regression suite
// (scripts/test-exam-submission-fixes.mjs) can exercise the tricky decisions in Node.

import type { Question } from '../types/database';
import { stripDataTableExpectedAnswers } from './dataTableUtils.ts';

// ─── Attempt checks ─────────────────────────────────────────────────────────────

export interface AttemptCheckLike {
  submitted?: boolean;
  submissionId?: string;
  submittedAt?: string;
}

/**
 * The attempt-check service returns an object, not a boolean. Unwrapping it in the
 * UI is load-bearing: `if (result)` is always true and blocks every legitimate resume.
 */
export function didSubmitAttempt(result: AttemptCheckLike | null | undefined): boolean {
  return result?.submitted === true;
}

// ─── Resume clock ───────────────────────────────────────────────────────────────

export interface ResumableDraftLike {
  targetEndTime?: number | null;
  timeLeftSeconds?: number;
  startTime?: number;
  lastSavedAt?: string;
}

export interface ResumeClock {
  /** Absolute epoch ms deadline to run the exam against. */
  deadline: number;
  /** Whole seconds left at `now` (never negative). */
  remainingSeconds: number;
  /** True when the deadline has already passed and the attempt must be submitted. */
  expired: boolean;
  /** True when the deadline was derived from startTime because the draft was legacy. */
  derivedFromStart: boolean;
}

/**
 * Resume must use the absolute deadline captured at start, never the remaining
 * seconds from the last (up to 50 s stale) autosave. For legacy drafts without a
 * deadline we derive one from `startTime + duration`, which cannot award free time.
 */
export function resolveResumeClock(
  draft: ResumableDraftLike | null | undefined,
  now: number,
  fallbackDurationSec: number
): ResumeClock {
  const fallbackMs = Math.max(60, Math.floor(Number(fallbackDurationSec) || 0)) * 1000;
  const start = typeof draft?.startTime === 'number' && draft.startTime > 0 ? draft.startTime : now;
  const hasDeadline = typeof draft?.targetEndTime === 'number' && (draft.targetEndTime as number) > 0;
  const deadline = hasDeadline ? (draft!.targetEndTime as number) : start + fallbackMs;
  const remainingSeconds = Math.max(0, Math.floor((deadline - now) / 1000));
  return {
    deadline,
    remainingSeconds,
    expired: remainingSeconds <= 0,
    derivedFromStart: !hasDeadline,
  };
}

// ─── Shared-device session identity ────────────────────────────────────────────

export interface SessionIdentityLike {
  candidateName?: string;
  candidateNumber?: string;
}

export function normalizeIdentityPart(value: string | undefined | null): string {
  return (value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A saved session belongs to the current candidate when the names match and, if
 * both numbers are present, the numbers match too. Missing numbers are treated as
 * "unknown" rather than a mismatch so a candidate who leaves the optional field
 * blank is not logged out of their own attempt.
 */
export function isSameCandidateSession(
  saved: SessionIdentityLike | null | undefined,
  current: SessionIdentityLike
): boolean {
  if (!saved) return true;
  const savedName = normalizeIdentityPart(saved.candidateName);
  const currentName = normalizeIdentityPart(current.candidateName);
  if (savedName && currentName && savedName !== currentName) return false;

  const savedNumber = normalizeIdentityPart(saved.candidateNumber);
  const currentNumber = normalizeIdentityPart(current.candidateNumber);
  if (savedNumber && currentNumber && savedNumber !== currentNumber) return false;

  return true;
}

export function shouldResetSessionForCandidate(
  saved: SessionIdentityLike | null | undefined,
  current: SessionIdentityLike
): boolean {
  if (!saved) return false;
  return !isSameCandidateSession(saved, current);
}

// ─── Submission outbox ─────────────────────────────────────────────────────────

export type OutboxStatus = 'pending' | 'synced' | 'failed';

export interface OutboxItemLike {
  status: OutboxStatus;
  retryCount?: number;
  nextRetryAt?: string;
}

export const MAX_OUTBOX_ATTEMPTS = 10;

/** 15 s, 30 s, 60 s … capped at 30 min. */
export function outboxBackoffMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(30 * 60_000, 15_000 * Math.pow(2, safeAttempt - 1));
}

export function computeNextRetryAt(attempt: number, now: number): string {
  return new Date(now + outboxBackoffMs(attempt)).toISOString();
}

/**
 * A failed submission is retryable until it exhausts its attempt budget; pending
 * items are always retryable. Synced items never are.
 */
export function isOutboxRetryable(item: OutboxItemLike | null | undefined, now: number): boolean {
  if (!item) return false;
  if (item.status === 'pending') return true;
  if (item.status !== 'failed') return false;

  const attempts = Number(item.retryCount) || 0;
  if (attempts >= MAX_OUTBOX_ATTEMPTS) return false;
  if (!item.nextRetryAt) return true;
  const due = new Date(item.nextRetryAt).getTime();
  return Number.isNaN(due) ? true : due <= now;
}

// ─── Analytics split ──────────────────────────────────────────────────────────

export interface AnalyticsSubmissionLike {
  status?: string;
  score: number;
  percentage: number;
}

export interface AnalyticsSplit<T> {
  graded: T[];
  pending: T[];
  /** Rows the KPI strip should average (graded ones, or all when nothing is graded). */
  analytics: T[];
  /** True when we are averaging ungraded rows because no graded row exists yet. */
  provisional: boolean;
}

export function partitionAnalyticsSubmissions<T extends AnalyticsSubmissionLike>(
  submissions: T[]
): AnalyticsSplit<T> {
  const graded = submissions.filter((s) => s.status === 'graded' || s.status === 'published');
  const pending = submissions.filter((s) => s.status !== 'graded' && s.status !== 'published');
  return {
    graded,
    pending,
    analytics: graded.length > 0 ? graded : submissions,
    provisional: graded.length === 0 && submissions.length > 0,
  };
}

// ─── Deterministic re-grade preservation ──────────────────────────────────────

export interface DeterministicOutcomeLike {
  isHandled: boolean;
  earnedMarks: number;
  isCorrect: boolean;
  feedback?: string;
}

export interface PreviousMarkLike {
  earnedMarks: number;
  isCorrect: boolean;
  feedback?: string;
  aiFeedback?: string;
  manualOverride?: boolean;
  gradingMethod?: string;
}

export interface RegradeChoice {
  earnedMarks: number;
  isCorrect: boolean;
  feedback?: string;
  /** True when the deterministic pass could not grade this item and the old mark was kept. */
  preserved: boolean;
}

/**
 * `gradeDeterministicAnswer()` returns `{ isHandled: false, earnedMarks: 0 }` for
 * multi-mark descriptive answers. Overwriting those with 0 destroyed AI and
 * teacher marks, so unhandled items keep their previous result.
 */
export function chooseRegradeMarks(
  det: DeterministicOutcomeLike,
  previous: PreviousMarkLike | null | undefined
): RegradeChoice {
  if (previous && (previous.manualOverride || previous.gradingMethod === 'teacher')) {
    return {
      earnedMarks: Number(previous.earnedMarks) || 0,
      isCorrect: Boolean(previous.isCorrect),
      feedback: previous.feedback ?? previous.aiFeedback,
      preserved: true,
    };
  }

  if (det.isHandled) {
    return {
      earnedMarks: det.earnedMarks,
      isCorrect: det.isCorrect,
      feedback: det.feedback,
      preserved: false,
    };
  }

  if (previous) {
    return {
      earnedMarks: Number(previous.earnedMarks) || 0,
      isCorrect: Boolean(previous.isCorrect),
      feedback: previous.feedback ?? previous.aiFeedback,
      preserved: true,
    };
  }

  return {
    earnedMarks: 0,
    isCorrect: false,
    feedback: 'Awaiting examiner AI evaluation',
    preserved: true,
  };
}

// ─── Question-id answer maps ──────────────────────────────────────────────────

export function answerMapKey(questionId: string, subId?: string | number): string {
  return subId === undefined || subId === null || subId === ''
    ? questionId
    : `${questionId}::${subId}`;
}

/**
 * Builds a stable `questionId -> answer` lookup alongside the legacy positional
 * `rawAnswers`. Re-grading prefers this map, so reordering a test cannot shift
 * answers onto the wrong questions.
 */
export function buildAnswersByQuestionId(
  questions: Question[],
  answers: Record<string | number, string | number>
): Record<string, string | number> {
  const map: Record<string, string | number> = {};
  questions.forEach((q, idx) => {
    if (q.sub_questions && q.sub_questions.length > 0) {
      q.sub_questions.forEach((sq, sIdx) => {
        const positionalKey = `${idx}_${sIdx}`;
        const parent = answers[idx] as any;
        const val = answers[positionalKey] !== undefined
          ? answers[positionalKey]
          : (parent && typeof parent === 'object' ? parent[sIdx] : undefined);
        if (val !== undefined && val !== null) {
          map[answerMapKey(q.id, sq.sub_id || sIdx)] = val;
        }
      });
      if (answers[`${idx}_table`] !== undefined && answers[`${idx}_table`] !== null) {
        map[answerMapKey(q.id, 'table')] = answers[`${idx}_table`];
      }
    } else if (answers[idx] !== undefined && answers[idx] !== null) {
      map[q.id] = answers[idx];
    }
  });
  return map;
}

export interface StoredAnswerLookup {
  rawAnswers?: Record<string | number, string | number>;
  answersByQuestionId?: Record<string, string | number>;
  questionId?: string;
  subId?: string | number;
  index: number;
  subIndex?: number;
}

/**
 * Resolves a stored answer by id first and falls back to the legacy positional
 * keys for rows submitted before the id map existed.
 */
export function resolveStoredAnswer({
  rawAnswers,
  answersByQuestionId,
  questionId,
  subId,
  index,
  subIndex,
}: StoredAnswerLookup): string | number | undefined {
  const raw = rawAnswers || {};

  if (answersByQuestionId && questionId) {
    if (subIndex !== undefined || (subId !== undefined && subId !== null && subId !== '')) {
      const subKeys: string[] = [];
      if (subId !== undefined && subId !== null && subId !== '') {
        subKeys.push(answerMapKey(questionId, subId));
      }
      if (subIndex !== undefined) {
        subKeys.push(answerMapKey(questionId, subIndex));
      }
      for (const key of subKeys) {
        const val = answersByQuestionId[key];
        if (val !== undefined) return val;
      }
    } else {
      const val = answersByQuestionId[questionId];
      if (val !== undefined) return val;
    }
  }

  if (subIndex !== undefined) {
    const positional = raw[`${index}_${subIndex}`];
    if (positional !== undefined) return positional;
    const parent = raw[index] as any;
    if (parent && typeof parent === 'object') {
      const nested = parent[subIndex];
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (subId !== undefined && subId !== null && subId !== '') {
    return raw[`${index}_${subId}`];
  }

  return raw[index];
}

// ─── Candidate payload sanitization ──────────────────────────────────────────

/**
 * Strips answer-key material from the questions handed to a candidate browser.
 * The UI already hides solutions, but the payload itself was readable in DevTools.
 */
export function sanitizeQuestionsForStudent(questions: Question[], stripAnswerKeys: boolean): Question[] {
  if (!stripAnswerKeys) return questions;

  return questions.map((q) => {
    const subs = Array.isArray(q.sub_questions)
      ? q.sub_questions.map((sq) => {
          const clean = { ...sq };
          if (clean.data_tables) {
            clean.data_tables = stripDataTableExpectedAnswers(clean.data_tables);
          }
          delete (clean as any).mark_scheme;
          delete (clean as any).guidance;
          delete (clean as any).common_misconceptions;
          delete (clean as any).acceptable_answers;
          return clean;
        })
      : q.sub_questions;

    const preservedInsertResources =
      Array.isArray((q as any).insert_resources) && (q as any).insert_resources.length > 0
        ? (q as any).insert_resources
        : Array.isArray((q.mark_scheme as any)?._insert_resources) && (q.mark_scheme as any)._insert_resources.length > 0
          ? (q.mark_scheme as any)._insert_resources
          : undefined;

    const rawDataTables =
      Array.isArray(q.data_tables) && q.data_tables.length > 0
        ? q.data_tables
        : Array.isArray((q.mark_scheme as any)?._data_tables) && (q.mark_scheme as any)._data_tables.length > 0
          ? (q.mark_scheme as any)._data_tables
          : undefined;

    const clean: any = {
      ...q,
      ...(preservedInsertResources ? { insert_resources: preservedInsertResources } : {}),
      ...(rawDataTables ? { data_tables: stripDataTableExpectedAnswers(rawDataTables) } : {}),
      mark_scheme: null,
      scratchpad: undefined,
      sub_questions: subs,
    };
    delete clean.guidance;
    delete clean.common_misconceptions;
    delete clean.acceptable_answers;
    delete clean.metadata;
    return clean as Question;
  });
}

// ─── Teacher unlock PIN hashing ──────────────────────────────────────────────

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * SHA-256 of `<QUIZ_CODE>::<pin>` when Web Crypto is available, with a
 * deterministic FNV-1a fallback for non-secure contexts (LAN HTTP deployments).
 * The plaintext PIN is never returned to a candidate payload.
 */
export async function hashTeacherPin(quizCode: string, pin: string): Promise<string> {
  const input = `${(quizCode || '').trim().toUpperCase()}::${(pin || '').trim()}`;
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `sha256:${hex}`;
    }
  } catch {
    // Non-secure context: use the deterministic fallback below.
  }
  return `fnv1a:${fnv1aHex(input)}`;
}
