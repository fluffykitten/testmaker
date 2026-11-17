// ─── Exam Session Scheduling Helpers ──────────────────────────────────────────
// Pure domain helpers for windowed Active / Scheduled / Closed / Paused states,
// local datetime-input conversions, validation, and School Exam Schedule presets.

import type { ExamScheduleEntry } from './examSchedule';

export type EffectiveQuizStatus = 'active' | 'scheduled' | 'closed' | 'paused';

export interface SchedulableQuizLike {
  isActive?: boolean;
  quizMode?: 'exam' | 'game' | string;
  scheduledStartAt?: string | null;
  scheduledEndAt?: string | null;
}

const MONTH_MAP: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

/**
 * Safely parses an ISO timestamp string to epoch milliseconds, returning `null` if blank or invalid.
 */
export function parseScheduleTimestamp(iso?: string | null): number | null {
  if (!iso || typeof iso !== 'string') return null;
  const trimmed = iso.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolves the effective session status of a quiz at `nowMs`.
 *
 * Rules:
 * - Game Mode (`quizMode === 'game'`) ignores schedule windows and relies purely on `isActive`.
 * - `isActive === false` ALWAYS resolves to `'paused'` (manual pause overrides any window).
 * - Before `scheduledStartAt` -> `'scheduled'`.
 * - After `scheduledEndAt` -> `'closed'`.
 * - Inside `[scheduledStartAt, scheduledEndAt]` (or unscheduled) -> `'active'`.
 */
export function resolveEffectiveQuizStatus(
  quiz: SchedulableQuizLike | null | undefined,
  nowMs: number = Date.now()
): EffectiveQuizStatus {
  if (!quiz) return 'paused';
  if (quiz.isActive === false) return 'paused';
  if ((quiz.quizMode || 'exam') === 'game') {
    return 'active';
  }

  const startMs = parseScheduleTimestamp(quiz.scheduledStartAt);
  const endMs = parseScheduleTimestamp(quiz.scheduledEndAt);

  if (startMs !== null && nowMs < startMs) {
    return 'scheduled';
  }
  if (endMs !== null && nowMs > endMs) {
    return 'closed';
  }
  return 'active';
}

/**
 * Validates an optional `(scheduledStartAt, scheduledEndAt)` pair.
 */
export function validateExamScheduleWindow(
  startIso?: string | null,
  endIso?: string | null
): { valid: boolean; error?: string } {
  const hasStart = Boolean(startIso && startIso.trim());
  const hasEnd = Boolean(endIso && endIso.trim());

  const startMs = parseScheduleTimestamp(startIso);
  const endMs = parseScheduleTimestamp(endIso);

  if (hasStart && startMs === null) {
    return { valid: false, error: 'Start date/time is invalid.' };
  }
  if (hasEnd && endMs === null) {
    return { valid: false, error: 'End date/time is invalid.' };
  }
  if (startMs !== null && endMs !== null && endMs <= startMs) {
    return { valid: false, error: 'Close entry time must be strictly after Start time.' };
  }
  return { valid: true };
}

/**
 * Converts a UTC ISO string into the browser's local `YYYY-MM-DDTHH:mm` format
 * for `<input type="datetime-local">`.
 */
export function isoToLocalDateTimeInput(iso?: string | null): string {
  const ms = parseScheduleTimestamp(iso);
  if (ms === null) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Converts a local `<input type="datetime-local">` value (`YYYY-MM-DDTHH:mm`) to a UTC ISO string.
 */
export function localDateTimeInputToIso(localValue?: string | null): string | null {
  if (!localValue || typeof localValue !== 'string') return null;
  const trimmed = localValue.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * Parses a School Exam Schedule entry (`date` like `"Mon, 30 Nov 2026"` and `time` like `"07.30 - 09.30"`)
 * into UTC ISO `{ scheduledStartAt, scheduledEndAt }` in the local browser timezone.
 */
export function buildWindowFromSchoolScheduleEntry(
  entry: Pick<ExamScheduleEntry, 'date' | 'time' | 'duration'>,
  fallbackDurationMinutes: number = 60
): { scheduledStartAt: string | null; scheduledEndAt: string | null } {
  const dateStr = (entry.date || '').trim();
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;

  // Match "Mon, 30 Nov 2026" or "30 Nov 2026"
  const textMatch = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (textMatch) {
    day = parseInt(textMatch[1], 10);
    month = MONTH_MAP[textMatch[2].toLowerCase()] ?? null;
    year = parseInt(textMatch[3], 10);
  } else {
    // Match ISO date "YYYY-MM-DD"
    const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      year = parseInt(isoMatch[1], 10);
      month = parseInt(isoMatch[2], 10) - 1;
      day = parseInt(isoMatch[3], 10);
    }
  }

  if (year === null || month === null || day === null) {
    return { scheduledStartAt: null, scheduledEndAt: null };
  }

  // Extract start & end HH:MM or HH.MM from strings like "07.30 - 09.30" or "08:00 - 09:30"
  const timeMatches = Array.from((entry.time || '').matchAll(/(\d{1,2})[:.](\d{2})/g));
  const startHour = timeMatches[0] ? parseInt(timeMatches[0][1], 10) : 8;
  const startMin = timeMatches[0] ? parseInt(timeMatches[0][2], 10) : 0;

  const startDate = new Date(year, month, day, startHour, startMin, 0, 0);
  if (!Number.isFinite(startDate.getTime())) {
    return { scheduledStartAt: null, scheduledEndAt: null };
  }

  let endDate: Date | null = null;
  if (timeMatches[1]) {
    const endHour = parseInt(timeMatches[1][1], 10);
    const endMin = parseInt(timeMatches[1][2], 10);
    const candidateEnd = new Date(year, month, day, endHour, endMin, 0, 0);
    if (candidateEnd.getTime() > startDate.getTime()) {
      endDate = candidateEnd;
    }
  }

  if (!endDate) {
    const durDigits = (entry.duration || '').match(/\d+/);
    const durMins = durDigits ? parseInt(durDigits[0], 10) : fallbackDurationMinutes;
    endDate = new Date(startDate.getTime() + Math.max(5, durMins) * 60_000);
  }

  return {
    scheduledStartAt: startDate.toISOString(),
    scheduledEndAt: endDate.toISOString(),
  };
}

/**
 * Formats a concise human-readable local schedule window label for teacher cards and student banners.
 */
export function formatScheduleWindowLabel(
  startIso?: string | null,
  endIso?: string | null
): string {
  const startMs = parseScheduleTimestamp(startIso);
  const endMs = parseScheduleTimestamp(endIso);
  if (startMs === null && endMs === null) return '';

  const fmtFull = (ms: number) =>
    new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

  const fmtTime = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

  if (startMs !== null && endMs !== null) {
    const s = new Date(startMs);
    const e = new Date(endMs);
    const sameDay =
      s.getFullYear() === e.getFullYear() &&
      s.getMonth() === e.getMonth() &&
      s.getDate() === e.getDate();
    return sameDay ? `${fmtFull(startMs)} – ${fmtTime(endMs)}` : `${fmtFull(startMs)} → ${fmtFull(endMs)}`;
  }

  if (startMs !== null) return `Opens ${fmtFull(startMs)}`;
  return `Closes ${fmtFull(endMs!)}`;
}

/**
 * Formats remaining milliseconds cleanly as `Xd HH:MM:SS` or `HH:MM:SS`.
 */
export function formatScheduleCountdown(remainingMs: number): string {
  const clamped = Math.max(0, Math.floor(remainingMs / 1000));
  const days = Math.floor(clamped / 86400);
  const hours = Math.floor((clamped % 86400) / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const hms = `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

/**
 * Returns the browser's short timezone label (e.g. `GMT+7` or `Asia/Jakarta`).
 */
export function getLocalTimezoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local Time';
  } catch {
    return 'Local Time';
  }
}
