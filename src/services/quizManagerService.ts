// ─── Quiz Manager Service ───────────────────────────────────────────────────
// Manages published interactive quizzes, custom codes, and anti-cheating settings.

import { supabase } from '../lib/supabase';
import type { Question, CustomTest } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import { generateQuizCode } from './quizCodeService';

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

export function getPublishedQuizzes(): PublishedQuiz[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
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
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('Could not fetch published quizzes from Supabase cloud:', err);
  }
  return [];
}

export function syncPublishedQuizzesToCloud(quizzes: PublishedQuiz[]): void {
  try {
    (supabase.from('app_config' as any) as any)
      .upsert({
        key: 'published_quizzes',
        value: JSON.stringify(quizzes),
      })
      .then(({ error }: any) => {
        if (error) console.warn('Supabase cloud sync notice:', error.message);
      });
  } catch (err) {
    console.warn('Cloud sync error:', err);
  }
}

export function savePublishedQuiz(quiz: PublishedQuiz): void {
  try {
    const existing = getPublishedQuizzes();
    const filtered = existing.filter((q) => q.id !== quiz.id && q.quizCode.toUpperCase() !== quiz.quizCode.toUpperCase());
    const updated = [quiz, ...filtered];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    syncPublishedQuizzesToCloud(updated);
  } catch (err) {
    console.error('Failed to save published quiz:', err);
  }
}

export function deletePublishedQuiz(id: string): void {
  try {
    const existing = getPublishedQuizzes();
    const updated = existing.filter((q) => q.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    syncPublishedQuizzesToCloud(updated);
  } catch (err) {
    console.error('Failed to delete published quiz:', err);
  }
}

export function toggleQuizActiveStatus(id: string): PublishedQuiz | null {
  try {
    const existing = getPublishedQuizzes();
    const target = existing.find((q) => q.id === id);
    if (!target) return null;
    target.isActive = !target.isActive;
    target.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
    syncPublishedQuizzesToCloud(existing);
    return target;
  } catch (err) {
    console.error('Failed to toggle quiz status:', err);
    return null;
  }
}

/**
 * Creates a PublishedQuiz draft from a CustomTest
 */
export function createDraftFromTest(
  test: CustomTest,
  questions?: Question[],
  customCode?: string
): PublishedQuiz {
  const generated = customCode?.trim().toUpperCase() || generateQuizCode(test);
  const header = test.header_config;
  const qCount = questions?.length || test.question_ids?.length || 0;
  const tMarks = test.total_marks || (questions ? questions.reduce((s, q) => s + (q.marks || 0), 0) : 0);

  // Intelligent Subject Resolution: Header -> Primary Subject -> Question Syllabus -> Chemistry
  let resolvedSubject = header?.subject?.trim() || '';
  if (!resolvedSubject || resolvedSubject.toLowerCase() === 'assessment') {
    resolvedSubject =
      (test as any).primarySubject ||
      ((test as any).subjects && (test as any).subjects[0]) ||
      (questions && questions.length > 0 && (questions[0] as any).syllabus?.subject_name) ||
      'Chemistry';
  }

  return {
    id: `quiz_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    testId: test.id,
    title: test.title || header?.title || `${resolvedSubject} Interactive Assessment`,
    quizCode: generated,
    subject: resolvedSubject,
    totalMarks: tMarks,
    questionCount: qCount,
    questionIds: test.question_ids || (questions ? questions.map((q) => q.id) : []),
    headerConfig: header,
    durationMinutes: header?.durationMinutes || 45,
    isExamMode: true,
    securityEnabled: true,
    requireTeacherUnlock: true,
    teacherPin: '1234',
    maxViolations: 3,
    showInstantSolutions: false,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // Game mode defaults
    quizMode: 'exam',
    enablePowerUps: true,
    enableStreaks: true,
    enableFunSounds: true,
    enableMemes: true,
    pointsPerQuestion: 1000,
    questionTimerSeconds: 20,
    shuffleQuestions: true,
    shuffleOptions: true,
  };
}
