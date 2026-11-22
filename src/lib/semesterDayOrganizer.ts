// ─── Semester Exam Day Organizer Domain & Warm-Cache Helpers ─────────────────
// Pure local-timezone calendar grouping, ICM schedule preset extraction,
// numeric quiz code ordering, and 90-minute local warm timestamp tracking.

import type { ExamScheduleEntry } from './examSchedule';
import { resolveEffectiveQuizStatus, parseScheduleTimestamp } from './examSessionSchedule';
import type { PublishedQuiz } from '../services/quizManagerService';

export const UNSCHEDULED_DAY_KEY = '__unscheduled__';
export const DEFAULT_WARM_TTL_MINUTES = 90;
export const WARM_CACHE_STORAGE_KEY = 'fluffykitten_exam_paper_warm_ts';

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

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface ScheduleDaySession {
  subject: string;
  time: string;
  duration?: string;
  targetClass?: string;
}

export interface ScheduleDayPreset {
  dayKey: string;
  label: string;
  subjects: string[];
  sessions: ScheduleDaySession[];
}

export interface SemesterDayGroup {
  dayKey: string;
  dayNumber: number | null;
  label: string;
  scheduleSubjects: string[];
  scheduleSessions: ScheduleDaySession[];
  quizzes: PublishedQuiz[];
  activeCount: number;
  scheduledCount: number;
  pausedCount: number;
  closedCount: number;
}

export interface QuizExamTimeInfo {
  windowLabel: string;
  durationLabel: string;
  timetableHint: string | null;
  hasExplicitWindow: boolean;
  tooltip: string;
}

export interface DayWarmSummary {
  status: 'warm' | 'partial' | 'cold';
  warmedCount: number;
  totalCount: number;
  lastWarmedAt: number | null;
  minutesRemaining: number;
}

function formatLocalYmd(year: number, monthIndexZero: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(monthIndexZero) || !Number.isInteger(day)) {
    return null;
  }
  const dt = new Date(year, monthIndexZero, day);
  if (
    !Number.isFinite(dt.getTime()) ||
    dt.getFullYear() !== year ||
    dt.getMonth() !== monthIndexZero ||
    dt.getDate() !== day
  ) {
    return null;
  }
  const mStr = String(monthIndexZero + 1).padStart(2, '0');
  const dStr = String(day).padStart(2, '0');
  return `${year}-${mStr}-${dStr}`;
}

/**
 * Normalizes a date input (`YYYY-MM-DD`, ISO datetime string, or human date like `"Mon, 30 Nov 2026"`)
 * into a local-calendar `'YYYY-MM-DD'` key without UTC midnight rollback.
 */
export function normalizeExamDayKey(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === UNSCHEDULED_DAY_KEY) return null;

  // 1. Plain YYYY-MM-DD
  const ymdMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) {
    return formatLocalYmd(
      parseInt(ymdMatch[1], 10),
      parseInt(ymdMatch[2], 10) - 1,
      parseInt(ymdMatch[3], 10)
    );
  }

  // 2. Human timetable label: "Mon, 30 Nov 2026" or "30 Nov 2026"
  const textMatch = trimmed.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (textMatch) {
    const day = parseInt(textMatch[1], 10);
    const monthIdx = MONTH_MAP[textMatch[2].toLowerCase()];
    const year = parseInt(textMatch[3], 10);
    if (monthIdx !== undefined) {
      return formatLocalYmd(year, monthIdx, day);
    }
  }

  // 3. Full ISO timestamp -> resolve using local browser Date getters
  const ms = parseScheduleTimestamp(trimmed);
  if (ms !== null) {
    const dt = new Date(ms);
    return formatLocalYmd(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }

  return null;
}

/**
 * Resolves the effective Exam Day key (`YYYY-MM-DD`) for a published quiz:
 * explicit manual `examDay` takes precedence over `scheduledStartAt` so clearing
 * `scheduledStartAt` during "Activate Day" preserves Day membership.
 */
export function resolveQuizExamDayKey(
  quiz?: Pick<PublishedQuiz, 'examDay' | 'scheduledStartAt'> | null
): string | null {
  if (!quiz) return null;
  return normalizeExamDayKey(quiz.examDay) ?? normalizeExamDayKey(quiz.scheduledStartAt);
}

/**
 * Formats a `'YYYY-MM-DD'` key into a stable local display label (e.g., `"Mon, 30 Nov 2026"`).
 */
export function formatExamDayDateLabel(dayKey: string): string {
  const m = dayKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dayKey;
  const year = parseInt(m[1], 10);
  const monthIdx = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const dt = new Date(year, monthIdx, day);
  if (!Number.isFinite(dt.getTime())) return dayKey;
  return `${WEEKDAY_SHORT[dt.getDay()]}, ${day} ${MONTH_SHORT[dt.getMonth()]} ${year}`;
}

function extractStartMinutes(timeStr?: string): number {
  const m = String(timeStr || '').match(/(\d{1,2})[:.](\d{2})/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Extracts unique chronological day presets with aggregated subject labels and timed sessions
 * from School Exam Schedule entries.
 */
export function extractScheduleDayPresets(
  entries?: ExamScheduleEntry[] | null
): ScheduleDayPreset[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const map = new Map<string, { subjects: string[]; sessions: ScheduleDaySession[] }>();

  for (const entry of entries) {
    const dayKey = normalizeExamDayKey(entry?.date);
    if (!dayKey) continue;
    const bucket = map.get(dayKey) || { subjects: [], sessions: [] };
    const subj = String(entry?.subject || '').trim();
    const time = String(entry?.time || '').trim();
    if (subj && !bucket.subjects.some((s) => s.toLowerCase() === subj.toLowerCase())) {
      bucket.subjects.push(subj);
    }
    if (
      subj &&
      !bucket.sessions.some(
        (s) => s.subject.toLowerCase() === subj.toLowerCase() && s.time.toLowerCase() === time.toLowerCase()
      )
    ) {
      bucket.sessions.push({
        subject: subj,
        time,
        duration: entry?.duration,
        targetClass: entry?.targetClass,
      });
    }
    map.set(dayKey, bucket);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayKey, bucket]) => ({
      dayKey,
      label: formatExamDayDateLabel(dayKey),
      subjects: bucket.subjects,
      sessions: [...bucket.sessions].sort((a, b) => extractStartMinutes(a.time) - extractStartMinutes(b.time)),
    }));
}

function normalizeSubjectToken(raw?: string | null): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function formatClock24(ms: number): string {
  const dt = new Date(ms);
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatShortMonthDay(ms: number): string {
  const dt = new Date(ms);
  return `${MONTH_SHORT[dt.getMonth()]} ${dt.getDate()}`;
}

function formatLocalDayKey(ms: number): string | null {
  const dt = new Date(ms);
  return formatLocalYmd(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/**
 * Resolves concise exam time window, duration, and matching School Exam Schedule timetable hint
 * for a quiz row inside Semester Exam Day Organizer.
 */
export function resolveQuizExamTimeInfo(
  quiz: Pick<PublishedQuiz, 'scheduledStartAt' | 'scheduledEndAt' | 'durationMinutes' | 'subject' | 'headerConfig'>,
  groupDayKey?: string | null,
  scheduleEntries?: ExamScheduleEntry[] | null
): QuizExamTimeInfo {
  const startMs = parseScheduleTimestamp(quiz?.scheduledStartAt);
  const endMs = parseScheduleTimestamp(quiz?.scheduledEndAt);
  const mins = Number(quiz?.durationMinutes) > 0 ? Math.round(Number(quiz.durationMinutes)) : 45;
  const durationLabel = `${mins} min`;

  const effectiveDayKey =
    groupDayKey && groupDayKey !== UNSCHEDULED_DAY_KEY ? groupDayKey : null;

  const formatPoint = (ms: number): string => {
    const clock = formatClock24(ms);
    if (effectiveDayKey && formatLocalDayKey(ms) === effectiveDayKey) {
      return clock;
    }
    return `${formatShortMonthDay(ms)}, ${clock}`;
  };

  let windowLabel = 'Open (No window)';
  const hasExplicitWindow = startMs !== null || endMs !== null;

  if (startMs !== null && endMs !== null) {
    const sameDay = formatLocalDayKey(startMs) === formatLocalDayKey(endMs);
    if (sameDay) {
      windowLabel = `${formatPoint(startMs)} – ${formatClock24(endMs)}`;
    } else {
      windowLabel = `${formatPoint(startMs)} → ${formatPoint(endMs)}`;
    }
  } else if (startMs !== null) {
    windowLabel = `Opens ${formatPoint(startMs)}`;
  } else if (endMs !== null) {
    windowLabel = `Closes ${formatPoint(endMs)}`;
  }

  let timetableHint: string | null = null;
  if (effectiveDayKey && Array.isArray(scheduleEntries) && scheduleEntries.length > 0) {
    const rawSubj = (quiz?.subject || quiz?.headerConfig?.subject || '').trim();
    const normSubj = normalizeSubjectToken(rawSubj);
    if (normSubj) {
      const matched = scheduleEntries.find((entry) => {
        if (normalizeExamDayKey(entry?.date) !== effectiveDayKey) return false;
        const entryNorm = normalizeSubjectToken(entry?.subject);
        return Boolean(entryNorm && (entryNorm === normSubj || entryNorm.includes(normSubj) || normSubj.includes(entryNorm)));
      });
      if (matched?.time) {
        timetableHint = `Timetable: ${matched.time}`;
      }
    }
  }

  const tooltipParts: string[] = [];
  if (startMs !== null) tooltipParts.push(`Starts: ${new Date(startMs).toLocaleString()}`);
  if (endMs !== null) tooltipParts.push(`Closes: ${new Date(endMs).toLocaleString()}`);
  if (!hasExplicitWindow) tooltipParts.push('No scheduled start/close time window (manual open/pause)');
  tooltipParts.push(`Duration: ${durationLabel}`);
  if (timetableHint) tooltipParts.push(timetableHint);

  return {
    windowLabel,
    durationLabel,
    timetableHint,
    hasExplicitWindow,
    tooltip: tooltipParts.join(' · '),
  };
}

function compareQuizzesByCode(a: PublishedQuiz, b: PublishedQuiz): number {
  const codeCmp = String(a.quizCode || '').localeCompare(String(b.quizCode || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (codeCmp !== 0) return codeCmp;
  return String(a.title || '').localeCompare(String(b.title || ''), undefined, {
    sensitivity: 'base',
  });
}

function buildStatusSummary(quizzes: PublishedQuiz[], nowMs: number) {
  let activeCount = 0;
  let scheduledCount = 0;
  let pausedCount = 0;
  let closedCount = 0;

  for (const q of quizzes) {
    const status = resolveEffectiveQuizStatus(q, nowMs);
    if (status === 'active') activeCount++;
    else if (status === 'scheduled') scheduledCount++;
    else if (status === 'closed') closedCount++;
    else pausedCount++;
  }

  return { activeCount, scheduledCount, pausedCount, closedCount };
}

/**
 * Groups all formal/practice exams (`quizMode !== 'game'`) chronologically by Exam Day,
 * plus an Unscheduled trailing group.
 */
export function groupQuizzesByExamDay(
  quizzes: PublishedQuiz[],
  scheduleEntries?: ExamScheduleEntry[] | null,
  extraDayKeys?: string[],
  nowMs: number = Date.now()
): { days: SemesterDayGroup[]; unscheduled: SemesterDayGroup } {
  const schedulePresetMap = new Map<string, { subjects: string[]; sessions: ScheduleDaySession[] }>();
  for (const preset of extractScheduleDayPresets(scheduleEntries)) {
    schedulePresetMap.set(preset.dayKey, {
      subjects: preset.subjects,
      sessions: preset.sessions,
    });
  }

  const byDay = new Map<string, PublishedQuiz[]>();
  const unscheduledList: PublishedQuiz[] = [];

  if (Array.isArray(extraDayKeys)) {
    for (const rawKey of extraDayKeys) {
      const normalized = normalizeExamDayKey(rawKey);
      if (normalized && !byDay.has(normalized)) {
        byDay.set(normalized, []);
      }
    }
  }

  for (const quiz of quizzes || []) {
    if (!quiz || quiz.quizMode === 'game') continue;
    const dayKey = resolveQuizExamDayKey(quiz);
    if (dayKey) {
      const arr = byDay.get(dayKey) || [];
      arr.push(quiz);
      byDay.set(dayKey, arr);
    } else {
      unscheduledList.push(quiz);
    }
  }

  const sortedDayKeys = Array.from(byDay.keys()).sort((a, b) => a.localeCompare(b));
  const days: SemesterDayGroup[] = sortedDayKeys.map((dayKey, idx) => {
    const sortedQuizzes = [...(byDay.get(dayKey) || [])].sort(compareQuizzesByCode);
    const counts = buildStatusSummary(sortedQuizzes, nowMs);
    const presetInfo = schedulePresetMap.get(dayKey);
    return {
      dayKey,
      dayNumber: idx + 1,
      label: formatExamDayDateLabel(dayKey),
      scheduleSubjects: presetInfo?.subjects || [],
      scheduleSessions: presetInfo?.sessions || [],
      quizzes: sortedQuizzes,
      ...counts,
    };
  });

  const sortedUnscheduled = [...unscheduledList].sort(compareQuizzesByCode);
  const unscheduledCounts = buildStatusSummary(sortedUnscheduled, nowMs);

  return {
    days,
    unscheduled: {
      dayKey: UNSCHEDULED_DAY_KEY,
      dayNumber: null,
      label: 'Unscheduled Exams',
      scheduleSubjects: [],
      scheduleSessions: [],
      quizzes: sortedUnscheduled,
      ...unscheduledCounts,
    },
  };
}

// ─── Local Warm-Cache Timestamp Tracking (90-Min Migration 037 TTL) ──────────

export function getWarmedQuizTimestamps(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(WARM_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const code = String(k || '').trim().toUpperCase();
      const num = Number(v);
      if (code && Number.isFinite(num) && num > 0) {
        out[code] = num;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeWarmedQuizTimestamps(map: Record<string, number>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(WARM_CACHE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota or private storage errors
  }
}

export function recordWarmedQuizCodes(
  codes: string[],
  timestampMs: number = Date.now()
): Record<string, number> {
  const current = getWarmedQuizTimestamps();
  for (const rawCode of codes || []) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (code) {
      current[code] = timestampMs;
    }
  }
  writeWarmedQuizTimestamps(current);
  return current;
}

export function clearWarmedQuizCodes(codes: string[]): Record<string, number> {
  const current = getWarmedQuizTimestamps();
  let changed = false;
  for (const rawCode of codes || []) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (code && code in current) {
      delete current[code];
      changed = true;
    }
  }
  if (changed) {
    writeWarmedQuizTimestamps(current);
  }
  return current;
}

export function computeDayWarmSummary(
  quizCodes: string[],
  warmMap: Record<string, number>,
  nowMs: number = Date.now(),
  ttlMinutes: number = DEFAULT_WARM_TTL_MINUTES
): DayWarmSummary {
  const uniqueCodes = Array.from(
    new Set(
      (quizCodes || [])
        .map((c) => String(c || '').trim().toUpperCase())
        .filter(Boolean)
    )
  );
  const totalCount = uniqueCodes.length;
  if (totalCount === 0) {
    return { status: 'cold', warmedCount: 0, totalCount: 0, lastWarmedAt: null, minutesRemaining: 0 };
  }

  const ttlMs = Math.max(1, ttlMinutes) * 60_000;
  let warmedCount = 0;
  let lastWarmedAt: number | null = null;
  let oldestWarmTs: number | null = null;

  for (const code of uniqueCodes) {
    const ts = Number(warmMap?.[code] || 0);
    if (Number.isFinite(ts) && ts > 0 && nowMs - ts >= 0 && nowMs - ts < ttlMs) {
      warmedCount++;
      if (lastWarmedAt === null || ts > lastWarmedAt) lastWarmedAt = ts;
      if (oldestWarmTs === null || ts < oldestWarmTs) oldestWarmTs = ts;
    }
  }

  const minutesRemaining =
    oldestWarmTs !== null ? Math.max(1, Math.ceil((ttlMs - (nowMs - oldestWarmTs)) / 60_000)) : 0;

  const status: DayWarmSummary['status'] =
    warmedCount === totalCount ? 'warm' : warmedCount > 0 ? 'partial' : 'cold';

  return {
    status,
    warmedCount,
    totalCount,
    lastWarmedAt,
    minutesRemaining,
  };
}
