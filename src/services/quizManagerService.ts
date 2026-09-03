// ─── Quiz Manager Service ───────────────────────────────────────────────────
// Manages published interactive quizzes, custom codes, and anti-cheating settings.

import { supabase } from '../lib/supabase';
import type { Question, CustomTest } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import { generateQuizCode } from './quizCodeService';
import { getSavedSettings } from '../lib/settings';

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
  durationMinutes: number;
  isExamMode: boolean;                   // Enforce timer and submit gate
  securityEnabled: boolean;              // Anti-cheating fullscreen / tab lock
  enableWatermark?: boolean;             // Dynamic per-student ghost watermark (default: false)
  enableMultiMonitorDetection?: boolean; // Multi-monitor / extended display detection (default: false)
  requireTeacherUnlock?: boolean;        // Require invigilator PIN to unlock on tab/blur violation
  teacherPin?: string;                   // Configurable teacher/invigilator unlock PIN (e.g. "1234")
  maxViolations: number;                 // Auto-submit after N tab violations
  showInstantSolutions: boolean;         // Show step-by-step breakdown on submit
  isActive: boolean;                     // Open for student submissions
  createdAt: string;
  updatedAt: string;
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
  const seenTestIds = new Set<string>();
  const cleanList: PublishedQuiz[] = [];

  for (const q of sorted) {
    if (!q) continue;
    const cleanId = String(q.id || '').trim();
    const cleanCode = String(q.quizCode || '').trim().toUpperCase();
    const cleanTestId = String(q.testId || '').trim();
    const isOffline = cleanCode.startsWith('OFFLINE_') || cleanTestId.startsWith('OFFLINE_') || Boolean((q as any).isOffline);

    // Check duplicate by ID
    if (cleanId && seenIds.has(cleanId)) {
      continue;
    }

    // Check duplicate by Quiz Code
    if (cleanCode && seenCodes.has(cleanCode)) {
      continue;
    }

    // Check duplicate by Test ID (for standard custom tests, 1 test = 1 published quiz)
    if (!isOffline && cleanTestId && seenTestIds.has(cleanTestId)) {
      continue;
    }

    if (cleanId) seenIds.add(cleanId);
    if (cleanCode) seenCodes.add(cleanCode);
    if (!isOffline && cleanTestId) seenTestIds.add(cleanTestId);

    cleanList.push(q);
  }

  return cleanList;
}

export function getPublishedQuizzes(): PublishedQuiz[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list: PublishedQuiz[] = raw ? JSON.parse(raw) : [];
    return deduplicateQuizzes(list);
  } catch (err) {
    console.error('Failed to load published quizzes from localStorage:', err);
    return [];
  }
}

export async function fetchPublishedQuizzesFromSupabase(): Promise<PublishedQuiz[]> {
  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', 'published_quizzes')
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value) {
      const parsed = JSON.parse(data.value);
      if (Array.isArray(parsed)) return deduplicateQuizzes(parsed);
    }
  } catch (err) {
    console.warn('Could not fetch published quizzes from Supabase cloud:', err);
  }
  return [];
}

export async function syncPublishedQuizzesToCloud(quizzes: PublishedQuiz[]): Promise<boolean> {
  try {
    const deduplicated = deduplicateQuizzes(quizzes);
    const { error } = await (supabase.from('app_config' as any) as any)
      .upsert({
        key: 'published_quizzes',
        value: JSON.stringify(deduplicated),
      });
    if (error) {
      console.warn('Supabase cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud sync error:', err);
    return false;
  }
}

/**
 * Loads published quizzes from localStorage immediately, then fetches from Supabase Cloud,
 * merges both lists safely by ID, quizCode, and testId, updates localStorage, and returns the merged list.
 */
export async function loadAndSyncPublishedQuizzes(): Promise<PublishedQuiz[]> {
  const localList = getPublishedQuizzes();

  try {
    const cloudList = await fetchPublishedQuizzesFromSupabase();

    // Authoritatively merge and deduplicate both cloud and local lists
    const combined = [...localList, ...cloudList];
    const merged = deduplicateQuizzes(combined);

    // Update localStorage with authoritative merged list
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));

    // If local and cloud had differences or duplicates, sync clean list back to Supabase
    if (cloudList.length !== merged.length || localList.length !== merged.length) {
      await syncPublishedQuizzesToCloud(merged);
    }

    return merged;
  } catch (err) {
    console.warn('Could not sync published quizzes with cloud, using local cache:', err);
    return localList;
  }
}

export async function savePublishedQuiz(quiz: PublishedQuiz): Promise<PublishedQuiz[]> {
  try {
    const cleanQuiz: PublishedQuiz = {
      ...quiz,
      quizCode: quiz.quizCode.trim().toUpperCase(),
      updatedAt: new Date().toISOString(),
    };

    // 1. Update local storage immediately for zero-lag UI
    const existing = getPublishedQuizzes();
    const updated = deduplicateQuizzes([cleanQuiz, ...existing]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));

    // 2. Fetch current cloud state and merge to avoid overwriting quizzes from other devices
    const cloudList = await fetchPublishedQuizzesFromSupabase();
    const finalMerged = deduplicateQuizzes([cleanQuiz, ...updated, ...cloudList]);
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(finalMerged));
    await syncPublishedQuizzesToCloud(finalMerged);

    return finalMerged;
  } catch (err) {
    console.error('Failed to save published quiz:', err);
    return getPublishedQuizzes();
  }
}

export async function deletePublishedQuiz(id: string): Promise<PublishedQuiz[]> {
  try {
    const cleanId = id.trim();
    const existing = getPublishedQuizzes();
    const target = existing.find(
      (q) =>
        q.id === cleanId ||
        q.testId === cleanId ||
        q.quizCode.toUpperCase() === cleanId.toUpperCase()
    );
    const targetId = target?.id || cleanId;
    const targetCode = (target?.quizCode || cleanId).toUpperCase();
    const targetTestId = target?.testId || cleanId;

    const matchesTarget = (q: PublishedQuiz) => {
      const qId = q.id;
      const qCode = q.quizCode.toUpperCase();
      const qTestId = q.testId;
      return (
        qId === cleanId ||
        qId === targetId ||
        qTestId === cleanId ||
        qTestId === targetTestId ||
        qCode === cleanId.toUpperCase() ||
        qCode === targetCode
      );
    };

    const updated = existing.filter((q) => !matchesTarget(q));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));

    const cloudList = await fetchPublishedQuizzesFromSupabase();
    const updatedCloud = cloudList.filter((q) => !matchesTarget(q));
    await syncPublishedQuizzesToCloud(updatedCloud);

    return updated;
  } catch (err) {
    console.error('Failed to delete published quiz:', err);
    return getPublishedQuizzes();
  }
}

export async function toggleQuizActiveStatus(id: string): Promise<PublishedQuiz | null> {
  try {
    const existing = getPublishedQuizzes();
    const target = existing.find((q) => q.id === id);
    if (!target) return null;
    target.isActive = !target.isActive;
    target.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));

    const cloudList = await fetchPublishedQuizzesFromSupabase();
    const cloudTarget = cloudList.find((q) => q.id === id);
    if (cloudTarget) {
      cloudTarget.isActive = target.isActive;
      cloudTarget.updatedAt = target.updatedAt;
    } else {
      cloudList.push(target);
    }
    await syncPublishedQuizzesToCloud(cloudList);

    return target;
  } catch (err) {
    console.error('Failed to toggle quiz status:', err);
    return null;
  }
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
  // If an existing published quiz already exists for this test, preserve its ID and configuration
  const existing = existingQuiz || getPublishedQuizzes().find((q) => q.testId === test.id);
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

  return {
    id: existing?.id || `quiz_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    testId: test.id,
    title: existing?.title || test.title || header?.title || `${resolvedSubject} Interactive Assessment`,
    quizCode: generated,
    subject: resolvedSubject,
    totalMarks: tMarks,
    questionCount: qCount,
    questionIds: test.question_ids || (questions ? questions.map((q) => q.id) : existing?.questionIds || []),
    headerConfig: header,
    durationMinutes: existing?.durationMinutes || header?.durationMinutes || 45,
    isExamMode: existing?.isExamMode ?? true,
    securityEnabled: existing?.securityEnabled ?? true,
    enableWatermark: existing?.enableWatermark ?? (getSavedSettings().defaultEnableWatermark ?? false),
    enableMultiMonitorDetection: existing?.enableMultiMonitorDetection ?? (getSavedSettings().defaultEnableMultiMonitor ?? false),
    requireTeacherUnlock: existing?.requireTeacherUnlock ?? true,
    teacherPin: existing?.teacherPin || '1234',
    maxViolations: existing?.maxViolations || 3,
    showInstantSolutions: existing?.showInstantSolutions ?? false,
    isActive: existing?.isActive ?? true,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
