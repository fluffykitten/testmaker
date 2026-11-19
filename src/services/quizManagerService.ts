// ─── Quiz Manager Service ───────────────────────────────────────────────────
// Manages published interactive quizzes, custom codes, and anti-cheating settings.

import { supabase } from '../lib/supabase';
import type { Question, CustomTest } from '../types/database';
import { ensureCloudTestHeadersExist, getLocalTests, type ExamHeaderConfig } from './testBuilderService';
import { generateQuizCode, clearQuizMemoryCache } from './quizCodeService';
import type { GradeThresholds } from '../utils/gradeThresholdUtils';
import { getSavedSettings } from '../lib/settings';
import { PILOT_EXAM_170_PUBLISHED_QUIZ, PILOT_EXAM_ID, PILOT_QUIZ_CODE } from '../data/pilotExam170Data';

export interface ExamAttachment {
  id: string;
  name: string;
  url: string;
  fileType: 'pdf' | 'image' | 'doc';
  sizeBytes?: number;
  uploadedAt: string;
  description?: string;
}

export interface PublishedQuiz {
  id: string;                            // Unique published quiz ID
  testId: string;                        // Associated CustomTest ID
  title: string;                         // Assessment Title
  quizCode: string;                      // 6-8 character student access code (e.g., CHEM-101)
  subject?: string;                      // Syllabus / subject name
  totalMarks: number;
  questionCount: number;
  questionIds: string[];
  headerConfig?: ExamHeaderConfig;
  gradeThresholds?: GradeThresholds;
  durationMinutes: number;
  isExamMode: boolean;                   // Enforce timer and submit gate
  securityEnabled: boolean;              // Anti-cheating fullscreen / tab lock
  enableWatermark?: boolean;             // Dynamic per-student ghost watermark (default: false)
  enableMultiMonitorDetection?: boolean; // Multi-monitor / extended display detection (default: false)
  hideEmergencyExamButton?: boolean;     // Hide Emergency Save & Exit button in exam runner (default: false)
  requireTeacherUnlock?: boolean;        // Require invigilator PIN to unlock on tab/blur violation
  teacherPin?: string;                   // Configurable teacher/invigilator unlock PIN (e.g. "1234")
  maxViolations: number;                 // Auto-submit after N tab violations
  showInstantSolutions: boolean;         // Show step-by-step breakdown on submit
  allowStudentScriptDownload?: boolean;  // Allow students to view/download Full Script PDF & stems after submit/release (default: false)
  requireStudentPin?: boolean;           // Require 4-digit student PIN from school roster (default: false)
  limitOneAttempt?: boolean;             // Limit candidate to 1 attempt (default: true for exams)
  targetClass?: string;                  // Optional target class cohort filter (e.g. "10-A")
  isActive: boolean;                     // Master Enabled / Armed switch for student entry
  scheduledStartAt?: string | null;      // Optional ISO UTC timestamp when Exam Mode auto-opens
  scheduledEndAt?: string | null;        // Optional ISO UTC timestamp when new student entry closes
  createdAt: string;
  updatedAt: string;

  // Student Exam Reference Tools Suite
  allowCalculator?: boolean;             // Explicitly enable/disable on-screen calculator
  calculatorType?: 'scientific' | 'basic'; // Calculator type: 'scientific' (default) or 'basic'
  allowPeriodicTable?: boolean;          // Explicitly enable/disable Cambridge Periodic Table
  allowScratchpad?: boolean;             // In-exam digital rough-work scratchpad
  allowFormulaSheet?: boolean;           // Standard formula & constants reference sheet
  attachments?: ExamAttachment[];        // Teacher-uploaded reference files (PDF, images, case studies)

  // Game Mode Configuration (Quizizz / Kahoot Style)
  quizMode?: 'exam' | 'game';            // Which runner to launch (default 'exam')
  enablePowerUps?: boolean;               // Allow 50/50, time freeze, double points
  enableStreaks?: boolean;                // Streak multiplier system
  enableFunSounds?: boolean;              // Sound effects (ding, buzz, airhorn)
  enableMemes?: boolean;                  // Fun reaction messages after answers
  pointsPerQuestion?: number;             // Base points per question (default 1000)
  questionTimerSeconds?: number;          // Per-question countdown (default 20)
  shuffleQuestions?: boolean;             // Randomize question order
  shuffleOptions?: boolean;               // Randomize MCQ option order
  previousCodes?: string[];               // Historical access codes alias list to prevent student lockout
}

const STORAGE_KEY = 'fluffykitten_published_quizzes';

/**
 * Deduplicates a list of PublishedQuiz records by ID, Quiz Code, and Test ID.
 * When collisions occur, the record with the newest timestamp is preserved.
 */
export function deduplicateQuizzes(quizzes: PublishedQuiz[]): PublishedQuiz[] {
  if (!Array.isArray(quizzes)) return [];
  const valid = quizzes.filter((q) => q && typeof q === 'object');
  if (valid.length <= 1) return valid;

  // Sort newest first so that recent edits/updates take precedence
  const sorted = [...valid].sort((a, b) => {
    const timeA = new Date((a && (a.updatedAt || a.createdAt)) || 0).getTime();
    const timeB = new Date((b && (b.updatedAt || b.createdAt)) || 0).getTime();
    return timeB - timeA;
  });

  const seenIds = new Set<string>();
  const seenCodes = new Set<string>();
  const cleanList: PublishedQuiz[] = [];

  for (const q of sorted) {
    if (!q) continue;
    const cleanId = String(q.id || '').trim();
    const cleanCode = String(q.quizCode || '').trim().toUpperCase();

    // Check duplicate by ID
    if (cleanId && seenIds.has(cleanId)) {
      continue;
    }

    // Check duplicate by Quiz Code
    if (cleanCode && seenCodes.has(cleanCode)) {
      continue;
    }

    if (cleanId) seenIds.add(cleanId);
    if (cleanCode) seenCodes.add(cleanCode);

    cleanList.push(q);
  }

  return cleanList;
}

const DELETED_QUIZZES_KEY = 'fluffykitten_deleted_quiz_ids';

/**
 * Returns all deleted quiz identifiers (IDs, testIds, quiz codes).
 */
export function getDeletedQuizIds(): Set<string> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DELETED_QUIZZES_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

/**
 * Records a deleted quiz in the persistent tombstone registry.
 */
export function recordDeletedQuiz(id?: string): void {
  try {
    const current = getDeletedQuizIds();
    if (id) current.add(id.trim());
    const arr = Array.from(current);
    const trimmed = arr.length > 500 ? arr.slice(arr.length - 500) : arr;
    localStorage.setItem(DELETED_QUIZZES_KEY, JSON.stringify(trimmed));
    // Asynchronously push tombstones to cloud
    syncDeletedQuizIdsToCloud(trimmed).catch(() => { });
  } catch (err) {
    console.warn('Failed to record deleted quiz tombstone:', err);
  }
}

export async function fetchDeletedQuizIdsFromCloud(): Promise<string[]> {
  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', 'deleted_quiz_ids')
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value) {
      const parsed = JSON.parse(data.value);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('Could not fetch deleted quiz ids from Supabase cloud:', err);
  }
  return [];
}

export async function syncDeletedQuizIdsToCloud(deletedIds: string[]): Promise<boolean> {
  try {
    const { error } = await (supabase.from('app_config' as any) as any)
      .upsert({
        key: 'deleted_quiz_ids',
        value: JSON.stringify(deletedIds),
      });
    if (error) {
      console.warn('Supabase cloud sync deleted ids notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud sync deleted ids error:', err);
    return false;
  }
}

export function getPublishedQuizzes(): PublishedQuiz[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    const list: PublishedQuiz[] = raw ? JSON.parse(raw) : [];
    const deletedIds = getDeletedQuizIds();
    const activeOnly = list.filter((q) => {
      if (!q) return false;
      const qId = String(q.id || '').trim();
      return !deletedIds.has(qId);
    });

    // Auto-seed pilot exam ICM170 if not deleted and not already in list
    if (
      !deletedIds.has(PILOT_EXAM_ID) &&
      !activeOnly.some((q) => q.id === PILOT_EXAM_ID || q.quizCode === PILOT_QUIZ_CODE)
    ) {
      activeOnly.unshift(PILOT_EXAM_170_PUBLISHED_QUIZ);
    }

    return deduplicateQuizzes(activeOnly);
  } catch (err) {
    console.error('Failed to load published quizzes from localStorage:', err);
    return [PILOT_EXAM_170_PUBLISHED_QUIZ];
  }
}

const QUIZ_BY_CODE_KEY_PREFIX = 'quiz_by_code_';
const CLOUD_QUIZZES_CACHE_TTL_MS = 15 * 1000;
const CLOUD_QUIZ_FETCH_TIMEOUT_MS = 12 * 1000;
const CLOUD_QUIZ_WRITE_TIMEOUT_MS = 20 * 1000;
const CODE_INDEX_RECOVERY_BATCH_TIMEOUT_MS = 12 * 1000;

interface CloudQuizzesFetchResult {
  ok: boolean;
  data: PublishedQuiz[];
  error?: string;
  recoveredFromCodeIndex?: boolean;
}

export interface QuizCloudSyncStatus {
  quizId: string;
  quizCode: string;
  codeIndexSynced: boolean;
  listSynced: boolean;
  stage?: 'fetch_list' | 'sync_list' | 'sync_code_index' | 'done';
  payloadBytes?: number;
  error?: string;
  timestamp: number;
}

let cloudQuizzesCache: { data: PublishedQuiz[]; timestamp: number } | null = null;
let inFlightCloudQuizzes: Promise<CloudQuizzesFetchResult> | null = null;
let suppressNextCacheClear = false;
let lastQuizCloudSyncStatus: QuizCloudSyncStatus | null = null;
let quizMutationQueue: Promise<unknown> = Promise.resolve();

export function getLastQuizCloudSyncStatus(): QuizCloudSyncStatus | null {
  return lastQuizCloudSyncStatus;
}

function enqueueQuizMutation<T>(fn: () => Promise<T>): Promise<T> {
  const next = quizMutationQueue.then(fn, fn);
  quizMutationQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function clearCloudQuizzesCache(): void {
  cloudQuizzesCache = null;
}

function dispatchQuizzesUpdated(detail?: Record<string, unknown>, preserveCloudCache = false): void {
  if (typeof window === 'undefined') return;
  const event = detail ? new CustomEvent('quizzes_updated', { detail }) : new Event('quizzes_updated');
  if (preserveCloudCache) {
    suppressNextCacheClear = true;
    try {
      window.dispatchEvent(event);
    } finally {
      suppressNextCacheClear = false;
    }
  } else {
    window.dispatchEvent(event);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('quizzes_updated', () => {
    if (suppressNextCacheClear) {
      suppressNextCacheClear = false;
      return;
    }
    clearCloudQuizzesCache();
  });
}

function compactQuizOverrides(quiz: PublishedQuiz): PublishedQuiz {
  const header = quiz.headerConfig;
  const overrides = header?.questionOverrides;
  if (!header || !overrides) return quiz;
  const compacted: Record<string, Question> = {};
  for (const [qid, q] of Object.entries(overrides)) {
    if (!q) continue;
    const copy: any = { ...q };
    if (copy.svg_content && copy.diagram_url && String(copy.diagram_url).startsWith('data:image/svg')) {
      delete copy.svg_content;
    }
    compacted[qid] = copy;
  }
  return {
    ...quiz,
    headerConfig: {
      ...header,
      questionOverrides: compacted,
    },
  };
}

function stripQuizOverrides(quiz: PublishedQuiz): PublishedQuiz {
  if (!quiz.headerConfig || !('questionOverrides' in quiz.headerConfig)) return quiz;
  const nextHeader = { ...quiz.headerConfig };
  delete nextHeader.questionOverrides;
  return {
    ...quiz,
    headerConfig: nextHeader,
  };
}

function safeWritePublishedQuizzesToLocalStorage(quizzes: PublishedQuiz[]): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(quizzes));
    return true;
  } catch (err) {
    try {
      const stripped = quizzes.map(stripQuizOverrides);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
      return true;
    } catch (retryErr) {
      console.warn('Failed to cache published quizzes to localStorage (cloud sync will still continue):', retryErr || err);
      return false;
    }
  }
}

async function withTimeout<T>(promise: PromiseLike<T>, ms: number, fallbackValue: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function upsertQuizCodeIndexToCloudDetailed(
  quiz: PublishedQuiz
): Promise<{ ok: boolean; error?: string }> {
  try {
    const codes = Array.from(
      new Set(
        [quiz.quizCode, ...(quiz.previousCodes || [])]
          .map((c) => (c || '').trim().toUpperCase())
          .filter(Boolean)
      )
    );
    if (codes.length === 0) return { ok: true };

    const payload = JSON.stringify(quiz);
    const rows = codes.map((code) => ({
      key: `${QUIZ_BY_CODE_KEY_PREFIX}${code}`,
      value: payload,
    }));

    const { error } = await withTimeout<{ error?: any }>(
      (supabase.from('app_config' as any) as any).upsert(rows, { onConflict: 'key' }),
      15000,
      { error: { message: 'Timeout updating quiz_by_code index' } }
    );
    if (error) {
      return { ok: false, error: error.message || String(error) };
    }
    return { ok: true };
  } catch (err: any) {
    console.warn('Quiz code index sync notice:', err);
    return { ok: false, error: err?.message || 'Quiz code index sync exception' };
  }
}

async function upsertQuizCodeIndexToCloud(quiz: PublishedQuiz): Promise<boolean> {
  const res = await upsertQuizCodeIndexToCloudDetailed(quiz);
  return res.ok;
}

async function deleteQuizCodeIndexFromCloud(codes: string[]): Promise<void> {
  const cleanCodes = Array.from(
    new Set(codes.map((c) => (c || '').trim().toUpperCase()).filter(Boolean))
  );
  if (cleanCodes.length === 0) return;
  try {
    const keys = cleanCodes.map((c) => `${QUIZ_BY_CODE_KEY_PREFIX}${c}`);
    await (supabase.from('app_config' as any) as any).delete().in('key', keys);
  } catch (err) {
    console.warn('Quiz code index delete notice:', err);
  }
}

/**
 * Fast single-quiz lookup by Quiz Code (avoids downloading the full published_quizzes array on student devices).
 */
export async function fetchPublishedQuizByCodeFromSupabase(
  quizCode: string
): Promise<PublishedQuiz | null> {
  const cleanCode = (quizCode || '').trim().toUpperCase();
  if (!cleanCode) return null;

  try {
    const result = await withTimeout<{ data: { value: string } | null; error: any }>(
      (supabase.from('app_config' as any) as any)
        .select('value')
        .eq('key', `${QUIZ_BY_CODE_KEY_PREFIX}${cleanCode}`)
        .maybeSingle(),
      4000,
      { data: null, error: null }
    );

    if (!result.error && result.data?.value) {
      const parsed = JSON.parse(result.data.value) as PublishedQuiz;
      if (parsed && parsed.id) {
        const deletedIds = getDeletedQuizIds();
        if (deletedIds.has(String(parsed.id).trim())) {
          return null;
        }
        return parsed;
      }
    }
  } catch (err) {
    console.warn('Could not fetch quiz by code from Supabase:', err);
  }
  return null;
}

async function reconstructPublishedQuizzesFromCodeIndex(): Promise<CloudQuizzesFetchResult> {
  try {
    const keysRes = await withTimeout<{ data: Array<{ key?: string }> | null; error: any }>(
      (supabase.from('app_config' as any) as any)
        .select('key')
        .like('key', 'quiz_by_code_%'),
      8000,
      { data: null, error: { message: 'Timeout scanning quiz_by_code index keys' } }
    );

    if (keysRes.error || !Array.isArray(keysRes.data)) {
      return {
        ok: false,
        data: cloudQuizzesCache ? cloudQuizzesCache.data : [],
        error: keysRes.error?.message || 'Code index key scan failed',
      };
    }

    const codeKeys = Array.from(
      new Set(
        keysRes.data
          .map((row) => (typeof row?.key === 'string' ? row.key : ''))
          .filter((k) => k.startsWith('quiz_by_code_') || k.startsWith('quiz_by_code:'))
      )
    );

    if (codeKeys.length === 0) {
      cloudQuizzesCache = { data: [], timestamp: Date.now() };
      return { ok: true, data: [], recoveredFromCodeIndex: true };
    }

    const rawValues: Array<{ key: string; value: string }> = [];
    let failedKeyCount = 0;

    for (let i = 0; i < codeKeys.length; i += 2) {
      const batch = codeKeys.slice(i, i + 2);
      const batchRes = await withTimeout<{
        data: Array<{ key?: string; value?: string }> | null;
        error: any;
      }>(
        (supabase.from('app_config' as any) as any).select('key, value').in('key', batch),
        CODE_INDEX_RECOVERY_BATCH_TIMEOUT_MS,
        { data: null, error: { message: 'Timeout' } }
      );

      if (!batchRes.error && Array.isArray(batchRes.data)) {
        for (const row of batchRes.data) {
          if (typeof row?.key === 'string' && typeof row?.value === 'string') {
            rawValues.push({ key: row.key, value: row.value });
          }
        }
        continue;
      }

      // Batch failed or timed out — fall back to single-key reads for this small pair
      for (const k of batch) {
        const singleRes = await withTimeout<{ data: { value?: string } | null; error: any }>(
          (supabase.from('app_config' as any) as any)
            .select('value')
            .eq('key', k)
            .maybeSingle(),
          CODE_INDEX_RECOVERY_BATCH_TIMEOUT_MS,
          { data: null, error: { message: 'Timeout' } }
        );
        if (singleRes.error) {
          failedKeyCount++;
        } else if (typeof singleRes.data?.value === 'string') {
          rawValues.push({ key: k, value: singleRes.data.value });
        }
      }
    }

    if (failedKeyCount > 0) {
      return {
        ok: false,
        data: cloudQuizzesCache ? cloudQuizzesCache.data : [],
        error: `Partial code-index recovery failed (${failedKeyCount}/${codeKeys.length} keys)`,
      };
    }

    const deletedIds = getDeletedQuizIds();
    const recovered: PublishedQuiz[] = [];
    for (const row of rawValues) {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed && typeof parsed === 'object' && parsed.id && !deletedIds.has(String(parsed.id).trim())) {
          recovered.push(parsed as PublishedQuiz);
        }
      } catch {
        // Skip malformed non-JSON entry
      }
    }

    const deduped = deduplicateQuizzes(recovered);
    cloudQuizzesCache = { data: deduped, timestamp: Date.now() };
    return { ok: true, data: deduped, recoveredFromCodeIndex: true };
  } catch (err: any) {
    return {
      ok: false,
      data: cloudQuizzesCache ? cloudQuizzesCache.data : [],
      error: err?.message || 'Code index recovery exception',
    };
  }
}

async function fetchPublishedQuizzesFromSupabaseDetailed(
  forceRefresh = false
): Promise<CloudQuizzesFetchResult> {
  if (
    !forceRefresh &&
    cloudQuizzesCache &&
    Date.now() - cloudQuizzesCache.timestamp < CLOUD_QUIZZES_CACHE_TTL_MS
  ) {
    return { ok: true, data: cloudQuizzesCache.data };
  }

  if (!forceRefresh && inFlightCloudQuizzes) {
    return inFlightCloudQuizzes;
  }

  const fetchPromise = (async (): Promise<CloudQuizzesFetchResult> => {
    let primaryErr = '';
    try {
      const { data, error } = await withTimeout<{ data: { value: string } | null; error: any }>(
        (supabase.from('app_config' as any) as any)
          .select('value')
          .eq('key', 'published_quizzes')
          .maybeSingle(),
        CLOUD_QUIZ_FETCH_TIMEOUT_MS,
        { data: null, error: { message: 'Timeout reading published_quizzes' } }
      );

      if (!error) {
        if (!data?.value) {
          cloudQuizzesCache = { data: [], timestamp: Date.now() };
          return { ok: true, data: [] };
        }

        const parsed = JSON.parse(data.value);
        if (Array.isArray(parsed)) {
          const deduped = deduplicateQuizzes(parsed);
          cloudQuizzesCache = { data: deduped, timestamp: Date.now() };
          return { ok: true, data: deduped };
        }
        primaryErr = 'Malformed published_quizzes payload';
      } else {
        primaryErr = error.message || 'Failed to fetch published quizzes';
      }
    } catch (err: any) {
      primaryErr = err?.message || 'Failed to fetch published quizzes';
    }

    console.warn(`Primary published_quizzes fetch failed (${primaryErr}); attempting per-code index recovery...`);
    const recovered = await reconstructPublishedQuizzesFromCodeIndex();
    if (recovered.ok) {
      return recovered;
    }

    return {
      ok: false,
      data: cloudQuizzesCache ? cloudQuizzesCache.data : [],
      error: `${primaryErr} (recovery failed: ${recovered.error || 'unknown'})`,
    };
  })();

  if (!forceRefresh) {
    inFlightCloudQuizzes = fetchPromise;
    try {
      return await fetchPromise;
    } finally {
      if (inFlightCloudQuizzes === fetchPromise) {
        inFlightCloudQuizzes = null;
      }
    }
  }

  return fetchPromise;
}

export async function fetchPublishedQuizzesFromSupabase(forceRefresh = false): Promise<PublishedQuiz[]> {
  const res = await fetchPublishedQuizzesFromSupabaseDetailed(forceRefresh);
  return res.data;
}

async function syncPublishedQuizzesToCloudDetailed(
  quizzes: PublishedQuiz[]
): Promise<{ ok: boolean; error?: string; payloadBytes: number }> {
  let payloadBytes = 0;
  try {
    const deduplicated = deduplicateQuizzes(quizzes);
    const payload = JSON.stringify(deduplicated);
    payloadBytes = payload.length;

    const { error } = await withTimeout<{ error: any }>(
      (supabase.from('app_config' as any) as any).upsert(
        {
          key: 'published_quizzes',
          value: payload,
        },
        { onConflict: 'key' }
      ),
      CLOUD_QUIZ_WRITE_TIMEOUT_MS,
      { error: { message: `Timeout writing published_quizzes (${Math.round(payloadBytes / 1024)} KB)` } }
    );
    if (error) {
      console.warn(
        `Supabase published_quizzes sync failed (${Math.round(payloadBytes / 1024)} KB):`,
        error.message || error
      );
      return { ok: false, error: error.message || 'Cloud list write failed', payloadBytes };
    }
    cloudQuizzesCache = { data: deduplicated, timestamp: Date.now() };
    return { ok: true, payloadBytes };
  } catch (err: any) {
    console.warn('Cloud sync error:', err);
    return { ok: false, error: err?.message || 'Cloud list sync exception', payloadBytes };
  }
}

export async function syncPublishedQuizzesToCloud(quizzes: PublishedQuiz[]): Promise<boolean> {
  const res = await syncPublishedQuizzesToCloudDetailed(quizzes);
  return res.ok;
}

/**
 * Loads published quizzes from localStorage immediately, then fetches from Supabase Cloud,
 * merges both lists safely by ID, quizCode, and testId, updates localStorage, and returns the merged list.
 */
export async function loadAndSyncPublishedQuizzes(): Promise<PublishedQuiz[]> {
  // Sync tombstones first
  const localDeleted = getDeletedQuizIds();
  try {
    const cloudDeleted = await fetchDeletedQuizIdsFromCloud();
    let hasNewCloudDeleted = false;
    cloudDeleted.forEach(id => {
      if (!localDeleted.has(id)) {
        localDeleted.add(id);
        hasNewCloudDeleted = true;
      }
    });
    if (hasNewCloudDeleted) {
      const arr = Array.from(localDeleted);
      const trimmed = arr.length > 500 ? arr.slice(arr.length - 500) : arr;
      localStorage.setItem(DELETED_QUIZZES_KEY, JSON.stringify(trimmed));
    }
    // Also push local deleted to cloud if we had exclusive local ones
    if (cloudDeleted.length < localDeleted.size) {
      const arr = Array.from(localDeleted);
      const trimmed = arr.length > 500 ? arr.slice(arr.length - 500) : arr;
      await syncDeletedQuizIdsToCloud(trimmed);
    }
  } catch (err) {
    console.warn('Error syncing deleted quiz tombstones:', err);
  }

  const localList = getPublishedQuizzes();
  const deletedIds = getDeletedQuizIds(); // Refresh after potential update

  try {
    const cloudRes = await fetchPublishedQuizzesFromSupabaseDetailed();
    if (!cloudRes.ok) {
      return localList;
    }

    const rawCloudList = cloudRes.data;
    // Filter cloud list through tombstones to prevent resurrection of deleted quizzes
    const cloudList = rawCloudList.filter((q) => {
      if (!q) return false;
      const qId = String(q.id || '').trim();
      return !deletedIds.has(qId);
    });

    // Authoritatively merge and deduplicate both cloud and local lists
    const combined = [...localList, ...cloudList];
    const mergedRaw = deduplicateQuizzes(combined);

    const backfillEntries = mergedRaw
      .filter((q) => q.testId && q.headerConfig?.questionOverrides && Object.keys(q.headerConfig.questionOverrides).length > 0)
      .map((q) => ({
        testId: q.testId,
        headerConfig: q.headerConfig,
        questionIds: q.questionIds,
        totalMarks: q.totalMarks,
      }));
    const backedInCloud = await ensureCloudTestHeadersExist(backfillEntries);
    const localTestIds = new Set(getLocalTests().map((t) => t.id));

    const cloudHadStrippedOverrides = cloudList.some(
      (q) =>
        q.testId &&
        backedInCloud.has(q.testId) &&
        Boolean(q.headerConfig?.questionOverrides)
    );

    const cloudMerged = mergedRaw.map((q) =>
      q.testId && backedInCloud.has(q.testId) ? stripQuizOverrides(q) : compactQuizOverrides(q)
    );
    const localMerged = mergedRaw.map((q) =>
      q.testId && (backedInCloud.has(q.testId) || localTestIds.has(q.testId))
        ? stripQuizOverrides(q)
        : compactQuizOverrides(q)
    );

    // Update localStorage with authoritative merged list safely
    safeWritePublishedQuizzesToLocalStorage(localMerged);

    // Heal cloud list if lengths differed, legacy blobs had questionOverrides stripped, or recovered from per-code index
    if (
      rawCloudList.length !== cloudMerged.length ||
      localList.length !== cloudMerged.length ||
      cloudHadStrippedOverrides ||
      Boolean(cloudRes.recoveredFromCodeIndex)
    ) {
      await syncPublishedQuizzesToCloud(cloudMerged);
    }

    return localMerged;
  } catch (err) {
    console.warn('Could not sync published quizzes with cloud, using local cache:', err);
    return localList;
  }
}

export async function savePublishedQuiz(quiz: PublishedQuiz, oldQuizCode?: string): Promise<PublishedQuiz[]> {
  return enqueueQuizMutation(async () => {
    try {
      const resolvedDuration = quiz.durationMinutes || quiz.headerConfig?.durationMinutes || 45;
      const cleanSubject = quiz.subject || quiz.headerConfig?.subject || 'General';
      const effectiveTeacherPin = quiz.teacherPin || quiz.headerConfig?.teacherPin || '1234';
      const cleanQuizCode = quiz.quizCode.trim().toUpperCase();

      // Track previous code aliases to avoid student lockouts
      const prevCodesSet = new Set<string>(quiz.previousCodes || []);
      if (oldQuizCode) {
        const cleanOld = oldQuizCode.trim().toUpperCase();
        if (cleanOld && cleanOld !== cleanQuizCode) {
          prevCodesSet.add(cleanOld);
        }
      }
      const updatedPrevCodes = Array.from(prevCodesSet).slice(-5);

      const mergedHeader = quiz.headerConfig
        ? { ...quiz.headerConfig, durationMinutes: resolvedDuration, subject: cleanSubject, teacherPin: effectiveTeacherPin }
        : {
          title: quiz.title || 'Examination Assessment',
          schoolName: '',
          subject: cleanSubject,
          subjectCode: '',
          durationMinutes: resolvedDuration,
          instructions: '',
          teacherPin: effectiveTeacherPin,
        };

      const cleanQuiz: PublishedQuiz = {
        ...quiz,
        durationMinutes: resolvedDuration,
        headerConfig: mergedHeader,

        subject: cleanSubject,
        teacherPin: effectiveTeacherPin,
        quizCode: cleanQuizCode,
        previousCodes: updatedPrevCodes,
        updatedAt: new Date().toISOString(),
      };

      // Invalidate resolution cache so changes take effect immediately
      clearQuizMemoryCache(cleanQuiz.quizCode);
      clearQuizMemoryCache(cleanQuiz.id);
      clearQuizMemoryCache(cleanQuiz.testId);
      updatedPrevCodes.forEach((code) => clearQuizMemoryCache(code));
      if (oldQuizCode) {
        clearQuizMemoryCache(oldQuizCode.trim().toUpperCase());
      }

      // 1. Update local storage immediately for zero-lag UI (never aborts cloud sync on quota)
      const existing = getPublishedQuizzes();
      const localTestIds = new Set(getLocalTests().map((t) => t.id));
      const localCleanQuiz =
        cleanQuiz.testId && localTestIds.has(cleanQuiz.testId)
          ? stripQuizOverrides(cleanQuiz)
          : compactQuizOverrides(cleanQuiz);
      const updatedLocal = deduplicateQuizzes([localCleanQuiz, ...existing]);
      safeWritePublishedQuizzesToLocalStorage(updatedLocal);

      // 2. Fetch current cloud state & backfill any missing custom_test_header_<testId> before slimming
      clearCloudQuizzesCache();
      const cloudRes = await fetchPublishedQuizzesFromSupabaseDetailed(true);

      const backfillCandidates = [
        cleanQuiz,
        ...(cloudRes.ok ? cloudRes.data : []),
        ...updatedLocal,
      ]
        .filter((q) => q.testId && q.headerConfig?.questionOverrides && Object.keys(q.headerConfig.questionOverrides).length > 0)
        .map((q) => ({
          testId: q.testId,
          headerConfig: q.headerConfig,
          questionIds: q.questionIds,
          totalMarks: q.totalMarks,
        }));

      const backedInCloud = await ensureCloudTestHeadersExist(backfillCandidates);
      const cloudCleanQuiz =
        cleanQuiz.testId && backedInCloud.has(cleanQuiz.testId)
          ? stripQuizOverrides(cleanQuiz)
          : compactQuizOverrides(cleanQuiz);

      let finalLocal = updatedLocal;
      let listSynced = false;
      let listError: string | undefined;
      let payloadBytes: number | undefined;

      // Write per-code index first so students can join immediately, sequentially before updating published_quizzes
      const codeRes = await upsertQuizCodeIndexToCloudDetailed(cloudCleanQuiz);
      const codeIndexSynced = codeRes.ok;

      if (cloudRes.ok) {
        const mergedRaw = deduplicateQuizzes([cloudCleanQuiz, ...updatedLocal, ...cloudRes.data]);
        const cloudMerged = mergedRaw.map((q) =>
          q.testId && backedInCloud.has(q.testId) ? stripQuizOverrides(q) : compactQuizOverrides(q)
        );
        finalLocal = mergedRaw.map((q) =>
          q.testId && (backedInCloud.has(q.testId) || localTestIds.has(q.testId))
            ? stripQuizOverrides(q)
            : compactQuizOverrides(q)
        );
        safeWritePublishedQuizzesToLocalStorage(finalLocal);

        const listRes = await syncPublishedQuizzesToCloudDetailed(cloudMerged);
        listSynced = listRes.ok;
        listError = listRes.error;
        payloadBytes = listRes.payloadBytes;
      } else {
        // Cloud fetch timed out or errored (and recovery also failed): NEVER overwrite published_quizzes
        if (cleanQuiz.testId && backedInCloud.has(cleanQuiz.testId)) {
          finalLocal = deduplicateQuizzes([cloudCleanQuiz, ...updatedLocal]);
          safeWritePublishedQuizzesToLocalStorage(finalLocal);
        }
      }

      const stage: QuizCloudSyncStatus['stage'] = !cloudRes.ok
        ? 'fetch_list'
        : !listSynced
          ? 'sync_list'
          : !codeIndexSynced
            ? 'sync_code_index'
            : 'done';

      const syncError = !cloudRes.ok
        ? cloudRes.error
        : !listSynced
          ? listError
          : !codeIndexSynced
            ? codeRes.error
            : undefined;

      lastQuizCloudSyncStatus = {
        quizId: cleanQuiz.id,
        quizCode: cleanQuiz.quizCode,
        codeIndexSynced,
        listSynced,
        stage,
        payloadBytes,
        error: syncError,
        timestamp: Date.now(),
      };

      dispatchQuizzesUpdated(
        { quizId: cleanQuiz.id, listSynced, codeIndexSynced },
        listSynced
      );
      return finalLocal;
    } catch (err: any) {
      console.error('Failed to save published quiz:', err);
      lastQuizCloudSyncStatus = {
        quizId: quiz.id,
        quizCode: quiz.quizCode,
        codeIndexSynced: false,
        listSynced: false,
        stage: 'fetch_list',
        error: err?.message || 'Unexpected save error',
        timestamp: Date.now(),
      };
      return getPublishedQuizzes();
    }
  });
}

async function syncQuizDeletionToCloud(
  codesToDelete: string[],
  matchesTarget: (q: PublishedQuiz) => boolean
): Promise<boolean> {
  clearCloudQuizzesCache();
  const cloudRes = await fetchPublishedQuizzesFromSupabaseDetailed(true);
  if (cloudRes.ok) {
    const updatedCloud = cloudRes.data.filter((q) => !matchesTarget(q));
    await Promise.all([
      syncPublishedQuizzesToCloud(updatedCloud),
      deleteQuizCodeIndexFromCloud(codesToDelete),
    ]);
    return true;
  }
  await deleteQuizCodeIndexFromCloud(codesToDelete);
  return false;
}

export async function deletePublishedQuiz(id: string): Promise<PublishedQuiz[]> {
  return enqueueQuizMutation(async () => {
    try {
      const cleanId = id.trim();
      const existing = getPublishedQuizzes();

      // 1. Direct Quiz ID Deletion (standard from QuizManagerPage)
      const directQuiz = existing.find((q) => q.id === cleanId);
      if (directQuiz) {
        const targetId = directQuiz.id;
        const targetCode = directQuiz.quizCode?.trim().toUpperCase();

        recordDeletedQuiz(targetId);
        clearQuizMemoryCache(targetId);
        if (targetCode) clearQuizMemoryCache(targetCode);

        // Only delete this exact quiz ID - NEVER touch sibling quizzes from same test
        const matchesTarget = (q: PublishedQuiz) => q.id === targetId;
        const updated = existing.filter((q) => !matchesTarget(q));
        safeWritePublishedQuizzesToLocalStorage(updated);

        const codesToDelete = [
          directQuiz.quizCode,
          ...(directQuiz.previousCodes || []),
        ];
        const listSynced = await syncQuizDeletionToCloud(codesToDelete, matchesTarget);
        dispatchQuizzesUpdated({ deletedId: targetId }, listSynced);
        return updated;
      }

      // 2. Test ID Deletion (e.g. called from testBuilderService when an entire test paper is deleted)
      const matchingByTest = existing.filter((q) => q.testId === cleanId);
      if (matchingByTest.length > 0) {
        const codesToDelete: string[] = [];
        matchingByTest.forEach((q) => {
          recordDeletedQuiz(q.id);
          clearQuizMemoryCache(q.id);
          if (q.quizCode) {
            clearQuizMemoryCache(q.quizCode.trim().toUpperCase());
            codesToDelete.push(q.quizCode);
          }
          if (q.previousCodes) codesToDelete.push(...q.previousCodes);
        });

        const matchesTarget = (q: PublishedQuiz) => q.testId === cleanId;
        const updated = existing.filter((q) => !matchesTarget(q));
        safeWritePublishedQuizzesToLocalStorage(updated);

        const listSynced = await syncQuizDeletionToCloud(codesToDelete, matchesTarget);
        dispatchQuizzesUpdated({ deletedId: cleanId }, listSynced);
        return updated;
      }

      // 3. Fallback: match by Quiz Code
      const cleanCodeUpper = cleanId.toUpperCase();
      const matchingByCode = existing.filter((q) => q.quizCode.toUpperCase() === cleanCodeUpper);
      if (matchingByCode.length > 0) {
        const codesToDelete: string[] = [cleanCodeUpper];
        matchingByCode.forEach((q) => {
          recordDeletedQuiz(q.id);
          clearQuizMemoryCache(q.id);
          clearQuizMemoryCache(cleanCodeUpper);
          if (q.quizCode) codesToDelete.push(q.quizCode);
          if (q.previousCodes) codesToDelete.push(...q.previousCodes);
        });

        const matchesTarget = (q: PublishedQuiz) => q.quizCode.toUpperCase() === cleanCodeUpper;
        const updated = existing.filter((q) => !matchesTarget(q));
        safeWritePublishedQuizzesToLocalStorage(updated);

        const listSynced = await syncQuizDeletionToCloud(codesToDelete, matchesTarget);
        dispatchQuizzesUpdated({ deletedId: cleanId }, listSynced);
        return updated;
      }

      // 4. If not found in local cache, record cleanId tombstone and prune cloud safely
      recordDeletedQuiz(cleanId);
      clearQuizMemoryCache(cleanId);

      clearCloudQuizzesCache();
      const cloudRes = await fetchPublishedQuizzesFromSupabaseDetailed(true);
      if (cloudRes.ok) {
        const matchedCloud = cloudRes.data.filter(
          (q) => q.id === cleanId || q.testId === cleanId || q.quizCode.toUpperCase() === cleanCodeUpper
        );
        const codesToDelete = [
          cleanCodeUpper,
          ...matchedCloud.flatMap((q) => [q.quizCode, ...(q.previousCodes || [])]),
        ];
        const updatedCloud = cloudRes.data.filter(
          (q) => q.id !== cleanId && q.testId !== cleanId && q.quizCode.toUpperCase() !== cleanCodeUpper
        );
        await Promise.all([
          syncPublishedQuizzesToCloud(updatedCloud),
          deleteQuizCodeIndexFromCloud(codesToDelete),
        ]);
      } else {
        await deleteQuizCodeIndexFromCloud([cleanCodeUpper]);
      }

      return existing;
    } catch (err) {
      console.error('Failed to delete published quiz:', err);
      return getPublishedQuizzes();
    }
  });
}

export async function toggleQuizActiveStatus(id: string): Promise<PublishedQuiz | null> {
  return enqueueQuizMutation(async () => {
    try {
      const existing = getPublishedQuizzes();
      const targetIdx = existing.findIndex((q) => q.id === id);
      if (targetIdx === -1) return null;

      const updatedTarget: PublishedQuiz = {
        ...existing[targetIdx],
        isActive: !existing[targetIdx].isActive,
        updatedAt: new Date().toISOString(),
      };
      const localTestIds = new Set(getLocalTests().map((t) => t.id));
      const localTarget =
        updatedTarget.testId && localTestIds.has(updatedTarget.testId)
          ? stripQuizOverrides(updatedTarget)
          : compactQuizOverrides(updatedTarget);

      const nextExisting = existing.map((q, idx) => (idx === targetIdx ? localTarget : q));
      safeWritePublishedQuizzesToLocalStorage(nextExisting);

      clearCloudQuizzesCache();
      const cloudRes = await fetchPublishedQuizzesFromSupabaseDetailed(true);

      const backfillCandidates = [
        updatedTarget,
        ...(cloudRes.ok ? cloudRes.data : []),
      ]
        .filter((q) => q.testId && q.headerConfig?.questionOverrides && Object.keys(q.headerConfig.questionOverrides).length > 0)
        .map((q) => ({
          testId: q.testId,
          headerConfig: q.headerConfig,
          questionIds: q.questionIds,
          totalMarks: q.totalMarks,
        }));
      const backedInCloud = await ensureCloudTestHeadersExist(backfillCandidates);
      const slimTarget =
        updatedTarget.testId && backedInCloud.has(updatedTarget.testId)
          ? stripQuizOverrides(updatedTarget)
          : compactQuizOverrides(updatedTarget);

      if (cloudRes.ok) {
        const cloudList = cloudRes.data.map((q) =>
          q.id === id
            ? slimTarget
            : q.testId && backedInCloud.has(q.testId)
              ? stripQuizOverrides(q)
              : compactQuizOverrides(q)
        );
        if (!cloudList.some((q) => q.id === id)) {
          cloudList.push(slimTarget);
        }
        await Promise.all([
          syncPublishedQuizzesToCloud(cloudList),
          upsertQuizCodeIndexToCloud(slimTarget),
        ]);
      } else {
        // Cloud list fetch failed/timed out: only update per-code index so we don't wipe other quizzes
        await upsertQuizCodeIndexToCloud(slimTarget);
      }

      return localTarget;
    } catch (err) {
      console.error('Failed to toggle quiz status:', err);
      return null;
    }
  });
}

/**
 * Creates or retrieves a PublishedQuiz draft from a CustomTest.
 * If an existing quiz already exists for this test, reuses its ID, code, and settings to prevent duplicates.
 */
export function createDraftFromTest(
  test: CustomTest,
  questions?: Question[],
  customCode?: string,
  existingQuiz?: PublishedQuiz
): PublishedQuiz {
  // If an existing published quiz is explicitly provided (e.g. editing), preserve its ID and configuration
  const existing = existingQuiz;
  const generated = customCode?.trim().toUpperCase() || existing?.quizCode || generateQuizCode(test);
  const header = test.header_config || existing?.headerConfig;
  const qCount = questions?.length || test.question_ids?.length || existing?.questionCount || 0;
  const tMarks = test.total_marks || (questions ? questions.reduce((s, q) => s + (q.marks || 0), 0) : existing?.totalMarks || 0);

  // Intelligent Subject Resolution: Existing -> Header -> Primary Subject -> Question Syllabus -> Chemistry
  let resolvedSubject = existing?.subject || header?.subject?.trim() || '';
  if (!resolvedSubject || resolvedSubject.toLowerCase() === 'assessment') {
    resolvedSubject =
      (test as any).primarySubject ||
      ((test as any).subjects && (test as any).subjects[0]) ||
      (questions && questions.length > 0 && (questions[0] as any).syllabus?.subject_name) ||
      'Chemistry';
  }

  const dur = existing?.durationMinutes || header?.durationMinutes || 45;
  const pin = existing?.teacherPin || header?.teacherPin || test.header_config?.teacherPin || '1234';
  const mergedHeader = header
    ? { ...header, durationMinutes: dur, teacherPin: pin }
    : {
      title: existing?.title || test.title || header?.title || `${resolvedSubject} Interactive Assessment`,
      schoolName: '',
      subject: resolvedSubject,
      subjectCode: '',
      durationMinutes: dur,
      instructions: '',
      teacherPin: pin,
    };

  return {
    id: existing?.id || `quiz_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    testId: test.id,
    title: existing?.title || test.title || header?.title || `${resolvedSubject} Interactive Assessment`,
    quizCode: generated,
    previousCodes: existing?.previousCodes || [],
    subject: resolvedSubject,
    totalMarks: tMarks,
    questionCount: qCount,
    questionIds: test.question_ids || (questions ? questions.map((q) => q.id) : existing?.questionIds || []),
    gradeThresholds: existing?.gradeThresholds || (header as any)?.gradeThresholds || undefined,
    headerConfig: mergedHeader,

    durationMinutes: dur,
    isExamMode: existing?.isExamMode ?? true,
    securityEnabled: existing?.securityEnabled ?? true,
    enableWatermark: existing?.enableWatermark ?? (getSavedSettings().defaultEnableWatermark ?? false),
    enableMultiMonitorDetection: existing?.enableMultiMonitorDetection ?? (getSavedSettings().defaultEnableMultiMonitor ?? false),
    hideEmergencyExamButton: existing?.hideEmergencyExamButton ?? (getSavedSettings().hideEmergencyExamButton ?? false),
    requireTeacherUnlock: existing?.requireTeacherUnlock ?? true,
    teacherPin: pin,
    requireStudentPin: existing?.requireStudentPin ?? (getSavedSettings().defaultRequireStudentPin ?? false),
    maxViolations: existing?.maxViolations || 3,
    showInstantSolutions: existing?.showInstantSolutions ?? false,
    isActive: existing?.isActive ?? true,
    scheduledStartAt: existing?.scheduledStartAt ?? null,
    scheduledEndAt: existing?.scheduledEndAt ?? null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // Student Exam Reference Tools Suite (off by default)
    allowCalculator: existing?.allowCalculator ?? false,
    calculatorType: existing?.calculatorType || 'scientific',
    allowPeriodicTable: existing?.allowPeriodicTable ?? (resolvedSubject.toLowerCase().includes('chem') ? true : false),
    allowScratchpad: existing?.allowScratchpad ?? false,
    allowFormulaSheet: existing?.allowFormulaSheet ?? false,
    attachments: existing?.attachments ? [...existing.attachments] : [],
    // Game mode defaults
    quizMode: existing?.quizMode || 'exam',
    enablePowerUps: existing?.enablePowerUps ?? true,
    enableStreaks: existing?.enableStreaks ?? true,
    enableFunSounds: existing?.enableFunSounds ?? true,
    enableMemes: existing?.enableMemes ?? true,
    pointsPerQuestion: existing?.pointsPerQuestion || 1000,
    questionTimerSeconds: existing?.questionTimerSeconds || 20,
    shuffleQuestions: existing?.shuffleQuestions ?? true,
    shuffleOptions: existing?.shuffleOptions ?? true,
  };
}
