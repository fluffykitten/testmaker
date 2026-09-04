import { supabase } from '../lib/supabase';
import type { Question, CustomTest } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import { getPublishedQuizzes, fetchPublishedQuizzesFromSupabase } from './quizManagerService';
import type { PublishedQuiz } from './quizManagerService';
import { normalizeQuestionRecord, compareQuestionNumbers } from './questionBankService';

export interface StudentQuizData {
  testId: string;
  quizCode: string;
  title: string;
  headerConfig?: ExamHeaderConfig;
  questions: Question[];
  totalMarks: number;
  durationMinutes?: number;
  isExamMode?: boolean;
  isActive?: boolean;
  securityEnabled?: boolean;
  enableWatermark?: boolean;
  enableMultiMonitorDetection?: boolean;
  requireTeacherUnlock?: boolean;
  teacherPin?: string;
  maxViolations?: number;
  showInstantSolutions?: boolean;
  requireStudentPin?: boolean;
  limitOneAttempt?: boolean;
  targetClass?: string;
  // Game mode fields
  quizMode?: 'exam' | 'game';
  enablePowerUps?: boolean;
  enableStreaks?: boolean;
  enableFunSounds?: boolean;
  enableMemes?: boolean;
  pointsPerQuestion?: number;
  questionTimerSeconds?: number;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
}

const LOCAL_STORAGE_KEY = 'fluffykitten_custom_tests';

/**
 * Derives a clean, human-friendly 6-character Quiz Code from subject and test ID
 * e.g. "CHEM-482", "PHYS-109", "TEST-7294"
 */
export function generateQuizCode(test: { id: string; header_config?: ExamHeaderConfig; title?: string }): string {
  const subject = test.header_config?.subject || test.title || 'TEST';
  const prefix = subject
    .replace(/[^a-zA-Z]/g, '')
    .slice(0, 4)
    .toUpperCase() || 'QUIZ';
  
  // Use first 3 alphanumeric characters of test id
  const suffix = (test.id.replace(/[^a-zA-Z0-9]/g, '') + '1234').slice(0, 4).toUpperCase();
  return `${prefix}-${suffix}`;
}

// ─── Fast In-Memory Cache for Resolved Quizzes & Question Objects ───────────────
const resolvedQuizMemoryCache = new Map<string, { data: StudentQuizData; timestamp: number }>();
const questionObjectCache = new Map<string, Question>();
const QUIZ_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes TTL

/**
 * Resolves a quiz by Quiz Code or Test UUID from Supabase, Published Quizzes, or LocalStorage (cached)
 */
export async function resolveStudentQuiz(codeOrId: string): Promise<StudentQuizData | null> {
  const cleanInput = codeOrId.trim().toUpperCase();
  if (!cleanInput) return null;

  const cached = resolvedQuizMemoryCache.get(cleanInput);
  if (cached && Date.now() - cached.timestamp < QUIZ_CACHE_TTL_MS) {
    return cached.data;
  }

  // 1. Check Configured Published Quizzes in LocalStorage first
  let published: PublishedQuiz | undefined;
  try {
    const publishedList = getPublishedQuizzes();
    published = publishedList.find(
      (p) =>
        p.quizCode.toUpperCase() === cleanInput ||
        p.id.toUpperCase() === cleanInput ||
        p.testId.toUpperCase() === cleanInput
    );
  } catch (err) {
    console.warn('Local published lookup error:', err);
  }

  // 2. If not found locally (e.g., in a Private / Incognito window or different device), fetch from Supabase Cloud
  if (!published) {
    try {
      const cloudQuizzes = await fetchPublishedQuizzesFromSupabase();
      published = cloudQuizzes.find(
        (p) =>
          p.quizCode.toUpperCase() === cleanInput ||
          p.id.toUpperCase() === cleanInput ||
          p.testId.toUpperCase() === cleanInput
      );
      if (published) {
        try {
          const localList = getPublishedQuizzes();
          if (!localList.some((q) => q.id === published!.id)) {
            localStorage.setItem('fluffykitten_published_quizzes', JSON.stringify([published, ...localList]));
          }
        } catch {
          // ignore local caching error
        }
      }
    } catch (err) {
      console.warn('Cloud published quiz lookup error:', err);
    }
  }

  if (published) {
    let questions = await fetchQuestionsByIds(published.questionIds || []);

    // Auto-heal: If questions are from a single assessment numbered 1..N and were stored
    // in alphabetical string order (e.g. Q1, Q10, Q11, ... Q2), restore natural numeric order.
    // Safeguard: Check that question numbers are unique sequential integers (not a multi-paper custom exam with duplicate Q1, Q2, etc.)
    const parsedNums = questions.map((q) => parseInt(String(q.question_number), 10)).filter((n) => !isNaN(n));
    const isSinglePaperSequential =
      parsedNums.length === questions.length &&
      new Set(parsedNums).size === questions.length &&
      Math.min(...parsedNums) === 1 &&
      Math.max(...parsedNums) === questions.length;

    const isAlphabeticallyMuddled =
      isSinglePaperSequential &&
      questions.length >= 10 &&
      questions.some((q, idx) => {
        if (idx > 0) {
          const prevNum = parseInt(String(questions[idx - 1].question_number), 10);
          const currNum = parseInt(String(q.question_number), 10);
          return prevNum === 1 && currNum === 10;
        }
        return false;
      });

    if (isAlphabeticallyMuddled) {
      questions = [...questions].sort((a, b) => compareQuestionNumbers(a.question_number, b.question_number));
    }
    const result: StudentQuizData = {
      testId: published.testId,
      quizCode: published.quizCode,
      title: published.title,
      headerConfig: published.headerConfig,
      questions,
      totalMarks: published.totalMarks,
      durationMinutes: published.durationMinutes,
      isExamMode: published.isExamMode,
      isActive: published.isActive !== undefined ? published.isActive : true,
      securityEnabled: published.securityEnabled,
      enableWatermark: published.enableWatermark ?? false,
      enableMultiMonitorDetection: published.enableMultiMonitorDetection ?? false,
      requireTeacherUnlock: published.requireTeacherUnlock,
      teacherPin: published.teacherPin,
      maxViolations: published.maxViolations,
      showInstantSolutions: published.showInstantSolutions,
      requireStudentPin: published.requireStudentPin ?? false,
      limitOneAttempt: published.limitOneAttempt ?? true,
      targetClass: published.targetClass,
      quizMode: published.quizMode,
      enablePowerUps: published.enablePowerUps,
      enableStreaks: published.enableStreaks,
      enableFunSounds: published.enableFunSounds,
      enableMemes: published.enableMemes,
      pointsPerQuestion: published.pointsPerQuestion,
      questionTimerSeconds: published.questionTimerSeconds,
      shuffleQuestions: published.shuffleQuestions,
      shuffleOptions: published.shuffleOptions,
    };

    resolvedQuizMemoryCache.set(cleanInput, { data: result, timestamp: Date.now() });
    return result;
  }

  // 3. Check LocalStorage tests fallback
  try {
    const rawLocal = localStorage.getItem(LOCAL_STORAGE_KEY);
    const localTests: CustomTest[] = rawLocal ? JSON.parse(rawLocal) : [];
    
    for (const test of localTests) {
      const generated = generateQuizCode(test).toUpperCase();
      if (
        test.id.toUpperCase() === cleanInput ||
        test.id.replace(/-/g, '').toUpperCase().startsWith(cleanInput.replace(/-/g, '')) ||
        generated === cleanInput
      ) {
        // Fetch question objects
        const questions = await fetchQuestionsByIds(test.question_ids || []);
        return {
          testId: test.id,
          quizCode: generated,
          title: test.title || test.header_config?.title || 'Examination Assessment',
          headerConfig: test.header_config,
          questions,
          totalMarks: test.total_marks || questions.reduce((sum, q) => sum + (q.marks || 0), 0),
        };
      }
    }
  } catch (err) {
    console.warn('Local test resolution error:', err);
  }

  // 4. Query Supabase custom_tests table
  try {
    // If it looks like a full UUID
    if (cleanInput.length >= 32) {
      const { data: test, error } = await supabase
        .from('custom_tests')
        .select('*')
        .eq('id', codeOrId.trim())
        .single() as { data: CustomTest | null; error: any };

      if (!error && test) {
        const questions = await fetchQuestionsByIds(test.question_ids || []);
        return {
          testId: test.id,
          quizCode: generateQuizCode(test),
          title: test.title || test.header_config?.title || 'Examination Assessment',
          headerConfig: test.header_config,
          questions,
          totalMarks: test.total_marks || questions.reduce((sum, q) => sum + (q.marks || 0), 0),
        };
      }
    }

    // Search by prefix or list all recent tests to match generated Quiz Code
    const { data: allTests, error } = await supabase
      .from('custom_tests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50) as { data: CustomTest[] | null; error: any };

    if (!error && allTests) {
      for (const test of allTests) {
        const code = generateQuizCode(test).toUpperCase();
        if (
          code === cleanInput ||
          test.id.toUpperCase().startsWith(cleanInput) ||
          test.id.replace(/-/g, '').toUpperCase().startsWith(cleanInput.replace(/-/g, ''))
        ) {
          const questions = await fetchQuestionsByIds(test.question_ids || []);
          return {
            testId: test.id,
            quizCode: code,
            title: test.title || test.header_config?.title || 'Examination Assessment',
            headerConfig: test.header_config,
            questions,
            totalMarks: test.total_marks || questions.reduce((sum, q) => sum + (q.marks || 0), 0),
          };
        }
      }
    }
  } catch (err) {
    console.error('Supabase test lookup error:', err);
  }

  // 5. Live Multiplayer Room Fallback (Connects to Realtime Broadcast Host Session)
  if (cleanInput.length >= 3) {
    return {
      testId: cleanInput,
      quizCode: cleanInput,
      title: `${cleanInput} Live Quiz`,
      questions: [],
      totalMarks: 0,
      quizMode: 'game',
      enablePowerUps: true,
      enableStreaks: true,
      enableFunSounds: true,
      enableMemes: true,
      pointsPerQuestion: 1000,
      questionTimerSeconds: 20,
    };
  }

  return null;
}

/**
 * Fetches question rows by an array of IDs from Supabase (with questionObjectCache)
 */
export async function fetchQuestionsByIds(ids: string[]): Promise<Question[]> {
  if (!ids || ids.length === 0) return [];

  // 1. Check which IDs are already cached in memory
  const missingIds = ids.filter((id) => !questionObjectCache.has(id));

  if (missingIds.length > 0) {
    try {
      const { data, error } = await supabase
        .from('questions')
        .select('*')
        .in('id', missingIds);

      if (!error && data && Array.isArray(data)) {
        (data as any[]).forEach((raw) => {
          const norm = normalizeQuestionRecord(raw);
          questionObjectCache.set(norm.id, norm);
        });
      }
    } catch (err) {
      console.warn('fetchQuestionsByIds error:', err);
    }
  }

  // Return questions in the exact requested order
  return ids.map((id) => questionObjectCache.get(id)).filter(Boolean) as Question[];
}
