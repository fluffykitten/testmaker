/**
 * Pure Proctoring Alert, Lock-Duration Escalation & Log Filtering Engine.
 * Zero React/DOM/Supabase dependencies so every rule is deterministically unit-testable.
 */

import type { ProctorLogEvent, ProctorStudentState, StudentExamStatus } from '../services/examProctorRealtimeService';

export const OVERDUE_LOCK_THRESHOLD_MS = 60_000; // 1 minute on violation/lock screen
const MAX_PLAUSIBLE_LOCK_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours sanity bound

export type ProctorLogCategory = 'all' | 'violations' | 'locks' | 'interventions';
export type ProctorAlertSoundMode = 'all' | 'critical_only' | 'muted';
export type ProctorAlertScopeMode = 'selected_scope' | 'whole_school';

export interface ProctorLogFilterCriteria {
  quizCode?: string;
  className?: string;
  studentId?: string;
  studentName?: string;
  candidateNumber?: string;
  category?: ProctorLogCategory;
  search?: string;
}

export interface ProctorAlertToast {
  id: string;
  compositeKey: string;
  quizCode: string;
  studentId: string;
  studentName: string;
  candidateNumber?: string;
  candidateClass?: string;
  kind: 'violation' | 'locked' | 'locked_overdue';
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  createdAt: number;
  repeatCount: number;
  lockedDurationMs?: number;
}

const VIOLATION_TYPES = new Set([
  'blur',
  'tab_switch',
  'fullscreen_exit',
  'multi_monitor',
  'shortcut',
  'blocked_shortcut',
  'exceeded_limit',
  'rate_limit',
]);

const LOCK_TYPES = new Set(['locked', 'locked_overdue', 'unlocked']);
const INTERVENTION_TYPES = new Set(['unlocked', 'time_extended', 'pardon', 'announcement', 'submitted']);

/**
 * Computes authoritative receiver-clock `lockedSince` timestamp across heartbeat transitions.
 * Clears cleanly when unlocked/submitted, preserves first lock timestamp while remaining locked,
 * and falls back to bounded sender timestamp only on initial dashboard join/reload.
 */
export function reconcileStudentLockTimestamp(
  prev: ProctorStudentState | undefined,
  incoming: ProctorStudentState,
  nowMs: number
): number | undefined {
  if (incoming.status !== 'locked') {
    return undefined;
  }

  if (prev?.status === 'locked' && typeof prev.lockedSince === 'number' && Number.isFinite(prev.lockedSince)) {
    return prev.lockedSince;
  }

  if (
    typeof incoming.lockedSince === 'number' &&
    Number.isFinite(incoming.lockedSince) &&
    incoming.lockedSince <= nowMs &&
    nowMs - incoming.lockedSince <= MAX_PLAUSIBLE_LOCK_AGE_MS
  ) {
    return incoming.lockedSince;
  }

  return nowMs;
}

/**
 * Returns elapsed milliseconds the student has spent on the current violation lock screen.
 */
export function getLockedDurationMs(student: ProctorStudentState, nowMs: number): number {
  if (student.status !== 'locked' || !student.lockedSince || !Number.isFinite(student.lockedSince)) {
    return 0;
  }
  return Math.max(0, nowMs - student.lockedSince);
}

/**
 * Formats milliseconds into compact `MM:SS` lock-screen wait indicator.
 */
export function formatLockedDuration(durationMs: number): string {
  const totalSec = Math.max(0, Math.floor(durationMs / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Suggests minutes to restore when a candidate waited >= 1 minute on a violation lock screen.
 */
export function computeWaitCompensationMinutes(durationMs: number): number {
  if (durationMs < OVERDUE_LOCK_THRESHOLD_MS) return 1;
  return Math.min(15, Math.max(1, Math.round(durationMs / 60_000)));
}

/**
 * Returns candidates currently in `status === 'locked'` for >= `thresholdMs` who have NOT yet
 * triggered an overdue escalation alert during the current `lockedSince` lock episode.
 */
export function findOverdueLockedStudents(
  students: ProctorStudentState[],
  alertedLockEpisodeByKey: Record<string, number>,
  nowMs: number,
  thresholdMs = OVERDUE_LOCK_THRESHOLD_MS
): ProctorStudentState[] {
  const overdue: ProctorStudentState[] = [];

  for (const s of students) {
    if (s.status !== 'locked' || s.autoSubmittedBySecurity) continue;
    if (!s.lockedSince || !Number.isFinite(s.lockedSince)) continue;
    if (nowMs - s.lockedSince < thresholdMs) continue;

    const compKey = `${(s.quizCode || '').trim().toUpperCase()}::${s.studentId}`;
    if (alertedLockEpisodeByKey[compKey] === s.lockedSince) {
      continue;
    }
    overdue.push(s);
  }

  return overdue;
}

/**
 * Categorizes an event type for Activity Log filtering.
 */
export function classifyProctorEventCategory(eventType: string): Exclude<ProctorLogCategory, 'all'> | 'session' {
  const t = (eventType || '').toLowerCase();
  if (LOCK_TYPES.has(t)) return 'locks';
  if (INTERVENTION_TYPES.has(t)) return 'interventions';
  if (VIOLATION_TYPES.has(t)) return 'violations';
  return 'session';
}

/**
 * Filters chronological proctoring events by exam code, class cohort, candidate identity, category, and query text.
 */
export function filterProctorLogs(
  logs: ProctorLogEvent[],
  criteria: ProctorLogFilterCriteria
): ProctorLogEvent[] {
  const targetQuiz = criteria.quizCode ? criteria.quizCode.trim().toUpperCase() : '';
  const targetClass = criteria.className ? criteria.className.trim().toLowerCase() : '';
  const targetStudentId = criteria.studentId ? criteria.studentId.trim() : '';
  const targetName = criteria.studentName ? criteria.studentName.trim().toLowerCase() : '';
  const targetSeat = criteria.candidateNumber ? criteria.candidateNumber.trim().toLowerCase() : '';
  const category = criteria.category || 'all';
  const search = (criteria.search || '').trim().toLowerCase();

  return logs.filter((evt) => {
    if (targetQuiz && (evt.quizCode || '').trim().toUpperCase() !== targetQuiz) {
      return false;
    }

    if (targetClass) {
      const evtClass = (evt.candidateClass || 'Unassigned').trim().toLowerCase();
      if (evtClass !== targetClass) return false;
    }

    if (targetStudentId || targetName) {
      const idMatches = Boolean(targetStudentId && evt.studentId && evt.studentId === targetStudentId);
      const nameMatches = Boolean(
        targetName &&
          evt.studentName.trim().toLowerCase() === targetName &&
          (!targetSeat || (evt.candidateNumber || '').trim().toLowerCase() === targetSeat)
      );
      if (!idMatches && !nameMatches) return false;
    }

    if (category !== 'all') {
      const evtType = (evt.type || '').toLowerCase();
      if (category === 'locks') {
        if (!LOCK_TYPES.has(evtType)) return false;
      } else if (category === 'interventions') {
        if (!INTERVENTION_TYPES.has(evtType)) return false;
      } else if (!VIOLATION_TYPES.has(evtType)) {
        return false;
      }
    }

    if (search) {
      const hay = `${evt.studentName} ${evt.candidateNumber || ''} ${evt.candidateClass || ''} ${evt.quizCode || ''} ${evt.type} ${evt.detail}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }

    return true;
  });
}

/**
 * Coalesces rapid repeat notifications for the same candidate & alert kind while capping stack size.
 */
export function upsertProctorAlertToast(
  existing: ProctorAlertToast[],
  incoming: Omit<ProctorAlertToast, 'repeatCount'>,
  maxToasts = 5,
  coalesceWindowMs = 15_000
): ProctorAlertToast[] {
  const idx = existing.findIndex(
    (t) =>
      t.compositeKey === incoming.compositeKey &&
      t.kind === incoming.kind &&
      incoming.createdAt - t.createdAt <= coalesceWindowMs
  );

  if (idx >= 0) {
    const updated = [...existing];
    const current = updated[idx];
    updated[idx] = {
      ...incoming,
      id: current.id,
      repeatCount: current.repeatCount + 1,
    };
    return updated;
  }

  return [{ ...incoming, repeatCount: 1 }, ...existing].slice(0, maxToasts);
}

/**
 * Priority rank for "Priority Triage" sorting in whole-school invigilation:
 * 0 = Locked >= 1m, 1 = Locked < 1m, 2 = Exceeded Strike Limit, 3 = Warning / Multi-monitor,
 * 4 = Offline, 5 = Active, 6 = Submitted.
 */
export function getPriorityTriageRank(
  student: ProctorStudentState,
  nowMs: number,
  isExceeded = false
): number {
  if (student.status === 'locked') {
    return getLockedDurationMs(student, nowMs) >= OVERDUE_LOCK_THRESHOLD_MS ? 0 : 1;
  }
  if (isExceeded || student.autoSubmittedBySecurity) return 2;
  if (student.status === 'warning' || student.multiMonitorDetected || student.violationsCount > 0) return 3;

  const map: Record<StudentExamStatus, number> = {
    locked: 1,
    warning: 3,
    offline: 4,
    active: 5,
    submitted: 6,
  };
  return map[student.status] ?? 99;
}
