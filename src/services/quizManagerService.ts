// ─── Quiz Manager Service ───────────────────────────────────────────────────
// Manages published interactive quizzes, custom codes, and anti-cheating settings.

import type { ExamHeaderConfig } from './testBuilderService';
import type { Question, CustomTest } from '../types/database';
import { generateQuizCode } from './quizCodeService';

export interface PublishedQuiz {
  id: string;                    // UUID
  testId: string;                // FK → custom_tests.id
  title: string;
  quizCode: string;              // Custom or generated (e.g. "CHEM-101", "PERIOD-3")
  subject: string;
  totalMarks: number;
  questionCount: number;
  questionIds: string[];
  headerConfig?: ExamHeaderConfig;
  
  // Interactive Assessment Configuration
  durationMinutes: number;
  isExamMode: boolean;           // true = Timed Exam, false = Practice
  securityEnabled: boolean;      // Anti-cheating lock (fullscreen + tab switch detection)
  maxViolations: number;         // e.g. 3 strikes before submission warning
  showInstantSolutions: boolean; // Show model solutions & misconceptions after test
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
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

export function savePublishedQuiz(quiz: PublishedQuiz): void {
  try {
    const existing = getPublishedQuizzes();
    const filtered = existing.filter((q) => q.id !== quiz.id && q.quizCode.toUpperCase() !== quiz.quizCode.toUpperCase());
    const updated = [quiz, ...filtered];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (err) {
    console.error('Failed to save published quiz:', err);
  }
}

export function deletePublishedQuiz(id: string): void {
  try {
    const existing = getPublishedQuizzes();
    const updated = existing.filter((q) => q.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
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
    maxViolations: 3,
    showInstantSolutions: true,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
