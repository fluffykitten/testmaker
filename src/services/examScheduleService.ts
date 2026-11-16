// ─── Exam Schedule Service ────────────────────────────────────────────────────
// Manages configurable examination timetable rows for the reverse side of
// printed Candidate Desk Cards. Syncs with Supabase app_config ('exam_schedule_entries').

import { supabase } from '../lib/supabase';
import {
  type ExamScheduleEntry,
  ICM_SEMESTER1_2026_2027_SCHEDULE,
  normalizeExamScheduleEntries,
} from '../lib/examSchedule';

const EXAM_SCHEDULE_STORAGE_KEY = 'testmaker_school_exam_schedule';
const CLOUD_EXAM_SCHEDULE_KEY = 'exam_schedule_entries';

/**
 * Reads cached exam schedule entries from localStorage.
 * Falls back to the ICM Semester 1 2026/2027 preset if never configured yet.
 */
export function getExamSchedule(): ExamScheduleEntry[] {
  if (typeof localStorage === 'undefined') {
    return ICM_SEMESTER1_2026_2027_SCHEDULE.map((e) => ({ ...e }));
  }

  try {
    const raw = localStorage.getItem(EXAM_SCHEDULE_STORAGE_KEY);
    if (raw === null) {
      return ICM_SEMESTER1_2026_2027_SCHEDULE.map((e) => ({ ...e }));
    }
    const parsed = JSON.parse(raw);
    return normalizeExamScheduleEntries(parsed);
  } catch (err) {
    console.warn('Failed to parse local exam schedule, using preset fallback:', err);
    return ICM_SEMESTER1_2026_2027_SCHEDULE.map((e) => ({ ...e }));
  }
}

/**
 * Syncs exam schedule entries to Supabase app_config store.
 */
export async function syncExamScheduleToCloud(entries: ExamScheduleEntry[]): Promise<boolean> {
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: CLOUD_EXAM_SCHEDULE_KEY,
      value: JSON.stringify(entries),
    });
    if (error) {
      console.warn('Exam schedule cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Network error syncing exam schedule:', err);
    return false;
  }
}

/**
 * Saves exam schedule locally, syncs to Supabase cloud, and broadcasts an update event.
 */
export async function saveExamSchedule(entries: ExamScheduleEntry[]): Promise<boolean> {
  const normalized = normalizeExamScheduleEntries(entries);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(EXAM_SCHEDULE_STORAGE_KEY, JSON.stringify(normalized));
    } catch (err) {
      console.warn('Failed to cache exam schedule to localStorage:', err);
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('exam_schedule_updated', {
        detail: { entries: normalized },
      })
    );
  }

  return syncExamScheduleToCloud(normalized);
}

/**
 * Fetches exam schedule from Supabase cloud app_config if present, updating local cache.
 */
export async function loadAndSyncExamSchedule(): Promise<ExamScheduleEntry[]> {
  const localEntries = getExamSchedule();

  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', CLOUD_EXAM_SCHEDULE_KEY)
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value !== undefined && data?.value !== null) {
      const cloudEntries = normalizeExamScheduleEntries(JSON.parse(data.value));
      if (JSON.stringify(localEntries) !== JSON.stringify(cloudEntries)) {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(EXAM_SCHEDULE_STORAGE_KEY, JSON.stringify(cloudEntries));
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('exam_schedule_updated', {
              detail: { entries: cloudEntries },
            })
          );
        }
      }
      return cloudEntries;
    }
  } catch (err) {
    console.warn('Could not fetch exam schedule from cloud, using local cache:', err);
  }

  return localEntries;
}
