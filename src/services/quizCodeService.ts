import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { Question, CustomTest } from '../types/database';
import { fetchCustomTestWithQuestions, type ExamHeaderConfig } from './testBuilderService';
import {
  getPublishedQuizzes,
  fetchPublishedQuizzesFromSupabase,
  fetchPublishedQuizByCodeFromSupabase,
} from './quizManagerService';
import type { PublishedQuiz, ExamAttachment } from './quizManagerService';
import { normalizeQuestionRecord, compareQuestionNumbers } from './questionBankService';
import { hashTeacherPin, sanitizeQuestionsForStudent } from '../lib/examSubmissionGuards';
import { type SecurityViolationTier } from '../lib/securityTiers';
import { getSecurityTiers, loadAndSyncSecurityTiers } from '../lib/settings';
import { PILOT_EXAM_170_PUBLISHED_QUIZ, PILOT_EXAM_ID, PILOT_QUIZ_CODE } from '../data/pilotExam170Data';

export interface StudentQuizData {
  publishedId?: string;
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
  hideEmergencyExamButton?: boolean;
  securityTiers?: SecurityViolationTier[];
  requireTeacherUnlock?: boolean;
  /** Salted hash of the invigilator PIN — the plaintext PIN is never sent to candidates. */
  teacherPinHash?: string;
  maxViolations?: number;
  showInstantSolutions?: boolean;
  requireStudentPin?: boolean;
  limitOneAttempt?: boolean;
  targetClass?: string;

  // Student Exam Reference Tools Suite
  allowCalculator?: boolean;
  calculatorType?: 'scientific' | 'basic';
  allowPeriodicTable?: boolean;
  allowScratchpad?: boolean;
  allowFormulaSheet?: boolean;
  attachments?: ExamAttachment[];

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

const resolvedQuizMemoryCache = new Map<string, { data: StudentQuizData; timestamp: number }>();
const inFlightQuizResolutions = new Map<string, Promise<StudentQuizData | null>>();
const questionObjectCache = new Map<string, Question>();
const QUIZ_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes TTL
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, fallbackValue: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveCustomTestHeaderAndQuestions(test: CustomTest): Promise<{
  headerConfig?: ExamHeaderConfig;
  questions: Question[];
}> {
  let headerConfig = test.header_config;
  let questionIds = test.question_ids || [];

  if (isSupabaseConfigured()) {
    try {
      const res = await withTimeout<{ data: { value: string } | null; error: any }>(
        (supabase.from('app_config' as any) as any)
          .select('value')
          .eq('key', `custom_test_header_${test.id}`)
          .maybeSingle(),
        3000,
        { data: null, error: null }
      );
      if (!res.error && res.data?.value) {
        const parsed = JSON.parse(res.data.value) as ExamHeaderConfig & {
          _savedQuestionIds?: string[];
          _savedTotalMarks?: number;
          _updatedAt?: string;
        };
        const { _savedQuestionIds, _savedTotalMarks, _updatedAt, ...cleanParsed } = parsed;
        const localTs = Date.parse(headerConfig?.updatedAt || '') || 0;
        const cloudTs = Date.parse(_updatedAt || cleanParsed.updatedAt || '') || 0;
        const localStrictlyNewer = Boolean(headerConfig?.updatedAt) && localTs > cloudTs && cloudTs > 0;
        if (!localStrictlyNewer) {
          if (Array.isArray(_savedQuestionIds) && _savedQuestionIds.length > 0) {
            questionIds = _savedQuestionIds;
          }
          headerConfig = {
            ...(headerConfig || {}),
            ...cleanParsed,
            questionOverrides: cleanParsed.questionOverrides || {},
          };
        }
      }
    } catch {
      // ignore cloud header hydration error
    }
  }

  const questions = await fetchAndApplyOverrides(questionIds, headerConfig?.questionOverrides);
  return { headerConfig, questions };
}

/**
 * Clears the in-memory cache for resolved quizzes and cached question objects
 */
export function clearQuizMemoryCache(codeOrId?: string): void {
  if (codeOrId) {
    const clean = codeOrId.trim().toUpperCase();
    resolvedQuizMemoryCache.delete(clean);
  } else {
    resolvedQuizMemoryCache.clear();
  }
}

export function clearQuestionObjectCache(questionId?: string): void {
  if (questionId) {
    questionObjectCache.delete(questionId);
  } else {
    questionObjectCache.clear();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('questions_updated', () => {
    questionObjectCache.clear();
    resolvedQuizMemoryCache.clear();
  });
  window.addEventListener('tests_updated', () => {
    questionObjectCache.clear();
    resolvedQuizMemoryCache.clear();
  });
}

/**
 * Resolves a quiz by Quiz Code or Test UUID from Supabase, Published Quizzes, or LocalStorage (cached & deduplicated)
 */
export async function resolveStudentQuiz(codeOrId: string): Promise<StudentQuizData | null> {
  const cleanInput = codeOrId.trim().toUpperCase();
  if (!cleanInput) return null;

  const cached = resolvedQuizMemoryCache.get(cleanInput);
  if (cached && Date.now() - cached.timestamp < QUIZ_CACHE_TTL_MS) {
    return cached.data;
  }

  const existingInFlight = inFlightQuizResolutions.get(cleanInput);
  if (existingInFlight) {
    return existingInFlight;
  }

  const resolutionPromise = (async (): Promise<StudentQuizData | null> => {
    return resolveStudentQuizUncached(codeOrId, cleanInput);
  })();

  inFlightQuizResolutions.set(cleanInput, resolutionPromise);
  try {
    return await resolutionPromise;
  } finally {
    inFlightQuizResolutions.delete(cleanInput);
  }
}

async function resolveStudentQuizUncached(
  codeOrId: string,
  cleanInput: string
): Promise<StudentQuizData | null> {
  // 1. Check Configured Published Quizzes in LocalStorage first
  const matchQuiz = (p: PublishedQuiz) =>
    p.quizCode.toUpperCase() === cleanInput ||
    p.id.toUpperCase() === cleanInput ||
    p.testId.toUpperCase() === cleanInput ||
    (p.previousCodes && p.previousCodes.some((c) => c.toUpperCase() === cleanInput));

  let published: PublishedQuiz | undefined;
  try {
    const publishedList = getPublishedQuizzes();
    published = publishedList.find(matchQuiz);
  } catch (err) {
    console.warn('Local published lookup error:', err);
  }

  // 2. If not found locally (e.g., fresh student device / incognito), try fast per-code cloud index first, then full cloud list
  if (!published) {
    try {
      const byCode = await fetchPublishedQuizByCodeFromSupabase(cleanInput);
      if (byCode) {
        published = byCode;
      } else {
        const cloudQuizzes = await fetchPublishedQuizzesFromSupabase();
        published = cloudQuizzes.find(matchQuiz);
      }
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

  // 3. Fallback to Pre-configured 170-Student Pilot Drill (ICM170)
  if (!published && (cleanInput === PILOT_QUIZ_CODE || cleanInput === PILOT_EXAM_ID.toUpperCase())) {
    published = PILOT_EXAM_170_PUBLISHED_QUIZ;
    try {
      const localList = getPublishedQuizzes();
      if (!localList.some((q) => q.id === published!.id) && typeof localStorage !== 'undefined') {
        localStorage.setItem('fluffykitten_published_quizzes', JSON.stringify([published, ...localList]));
      }
    } catch {
      // ignore
    }
  }

  if (published) {
    const effectiveDuration = published.durationMinutes || published.headerConfig?.durationMinutes || 45;
    const effectiveTeacherPin = published.teacherPin || published.headerConfig?.teacherPin || '1234';

    // Saved test is the single source of truth for paper questions, overrides, mark schemes, and total marks.
    // Falls back to published.questionIds only when published.testId does not resolve to a saved test (e.g. offline import).
    const [savedTestData, teacherPinHash, schoolSecurityTiers] = await Promise.all([
      published.testId ? fetchCustomTestWithQuestions(published.testId) : Promise.resolve(null),
      hashTeacherPin(published.quizCode, effectiveTeacherPin),
      withTimeout(loadAndSyncSecurityTiers(), 2500, getSecurityTiers()),
    ]);

    const hasSavedTest = Boolean(savedTestData && savedTestData.questions.length > 0);
    const rawQuestions = hasSavedTest
      ? savedTestData!.questions
      : await fetchAndApplyOverrides(published.questionIds || [], published.headerConfig?.questionOverrides);

    let questions = rawQuestions;

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

    // A candidate browser must never receive the invigilator PIN or the test
    // overrides (they are full Question objects and therefore contain mark schemes).
    const publishedHeader = { ...(published.headerConfig || {}) } as ExamHeaderConfig;
    const savedHeader = hasSavedTest
      ? ({ ...(savedTestData!.test.header_config || {}) } as ExamHeaderConfig)
      : undefined;
    const headerSource = {
      ...publishedHeader,
      ...(savedHeader || {}),
    } as ExamHeaderConfig;
    delete (headerSource as any).teacherPin;
    delete (headerSource as any).questionOverrides;
    delete (headerSource as any).updatedAt;

    const syncedHeader: ExamHeaderConfig = {
      ...headerSource,
      title: published.title || publishedHeader.title || savedHeader?.title || 'Examination Assessment',
      schoolName: savedHeader?.schoolName || publishedHeader.schoolName || '',
      subject: published.subject || publishedHeader.subject || savedHeader?.subject || 'Assessment',
      subjectCode: savedHeader?.subjectCode || publishedHeader.subjectCode || '',
      durationMinutes: effectiveDuration,
      instructions: savedHeader?.instructions ?? publishedHeader.instructions ?? '',
      additionalMaterials: savedHeader?.additionalMaterials ?? publishedHeader.additionalMaterials,
      teacherPinHash,
    };

    // In formal Exam Mode the browser is not allowed to see answer keys at all.
    // (Practice mode keeps them so instant solutions can still be rendered.)
    const stripAnswerKeys = Boolean(published.isExamMode && !published.showInstantSolutions);
    const studentQuestions = sanitizeQuestionsForStudent(questions, stripAnswerKeys);
    const computedQuestionMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
    const effectiveTotalMarks = hasSavedTest
      ? (computedQuestionMarks > 0 ? computedQuestionMarks : (savedTestData!.test.total_marks || published.totalMarks))
      : (published.totalMarks || computedQuestionMarks);

    const result: StudentQuizData = {
      publishedId: published.id,
      testId: published.testId,
      quizCode: published.quizCode,
      title: published.title,
      headerConfig: syncedHeader,
      questions: studentQuestions,
      totalMarks: effectiveTotalMarks,
      durationMinutes: effectiveDuration,
      isExamMode: published.isExamMode,
      isActive: published.isActive !== undefined ? published.isActive : true,
      securityEnabled: published.securityEnabled,
      enableWatermark: published.enableWatermark ?? false,
      enableMultiMonitorDetection: published.enableMultiMonitorDetection ?? false,
      hideEmergencyExamButton: published.hideEmergencyExamButton ?? false,
      securityTiers: schoolSecurityTiers,
      requireTeacherUnlock: published.requireTeacherUnlock,
      teacherPinHash,
      maxViolations: published.maxViolations,
      showInstantSolutions: published.showInstantSolutions,
      requireStudentPin: published.requireStudentPin ?? false,
      limitOneAttempt: published.limitOneAttempt ?? true,
      targetClass: published.targetClass,
      // Student Exam Reference Tools Suite
      allowCalculator: published.allowCalculator,
      calculatorType: published.calculatorType,
      allowPeriodicTable: published.allowPeriodicTable,
      allowScratchpad: published.allowScratchpad,
      allowFormulaSheet: published.allowFormulaSheet,
      attachments: published.attachments,
      // Game mode fields
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

  // 4. Check LocalStorage tests fallback
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
        const questions = await fetchAndApplyOverrides(test.question_ids || [], test.header_config?.questionOverrides);
        const effectiveDuration = test.header_config?.durationMinutes || Math.round((test.total_marks || 20) * 1.25);
        const result: StudentQuizData = {
          testId: test.id,
          quizCode: generated,
          title: test.title || test.header_config?.title || 'Examination Assessment',
          headerConfig: test.header_config ? { ...test.header_config, durationMinutes: effectiveDuration } : undefined,
          questions,
          totalMarks: test.total_marks || questions.reduce((sum, q) => sum + (q.marks || 0), 0),
          durationMinutes: effectiveDuration,
        };
        resolvedQuizMemoryCache.set(cleanInput, { data: result, timestamp: Date.now() });
        return result;
      }
    }
  } catch (err) {
    console.warn('Local test resolution error:', err);
  }

  // 5. Query Supabase custom_tests table (explicit columns only; bounded timeout)
  try {
    const trimmedInput = codeOrId.trim();
    if (UUID_REGEX.test(trimmedInput)) {
      const { data: test, error } = await withTimeout<{ data: CustomTest | null; error: any }>(
        supabase
          .from('custom_tests')
          .select('id, title, total_marks, question_ids, created_at')
          .eq('id', trimmedInput)
          .maybeSingle(),
        4500,
        { data: null, error: null }
      );

      if (!error && test) {
        const { headerConfig, questions } = await resolveCustomTestHeaderAndQuestions(test);
        const hydratedTest = { ...test, header_config: headerConfig };
        const effectiveDuration = headerConfig?.durationMinutes || Math.round((test.total_marks || 20) * 1.25);
        const result: StudentQuizData = {
          testId: test.id,
          quizCode: generateQuizCode(hydratedTest),
          title: test.title || headerConfig?.title || 'Examination Assessment',
          headerConfig: headerConfig ? { ...headerConfig, durationMinutes: effectiveDuration } : undefined,
          questions,
          totalMarks: test.total_marks || questions.reduce((sum, q) => sum + (q.marks || 0), 0),
          durationMinutes: effectiveDuration,
        };
        resolvedQuizMemoryCache.set(cleanInput, { data: result, timestamp: Date.now() });
        return result;
      }
    }

    // Search recent tests by ID prefix or generated Quiz Code
    const { data: allTests, error } = await withTimeout<{ data: CustomTest[] | null; error: any }>(
      supabase
        .from('custom_tests')
        .select('id, title, total_marks, question_ids, created_at')
        .order('created_at', { ascending: false })
        .limit(50),
      4500,
      { data: null, error: null }
    );

    if (!error && allTests) {
      const dashIdx = cleanInput.indexOf('-');
      const requestedSuffix = dashIdx > 0 ? cleanInput.slice(dashIdx + 1) : '';

      for (const test of allTests) {
        const code = generateQuizCode(test).toUpperCase();
        const testSuffix = (test.id.replace(/[^a-zA-Z0-9]/g, '') + '1234').slice(0, 4).toUpperCase();
        const directMatch =
          code === cleanInput ||
          test.id.toUpperCase().startsWith(cleanInput) ||
          test.id.replace(/-/g, '').toUpperCase().startsWith(cleanInput.replace(/-/g, ''));

        if (directMatch || (requestedSuffix && requestedSuffix === testSuffix)) {
          const { headerConfig, questions } = await resolveCustomTestHeaderAndQuestions(test);
          const hydratedTest = headerConfig ? { ...test, header_config: headerConfig } : test;
          const hydratedCode = generateQuizCode(hydratedTest).toUpperCase();
          if (directMatch || hydratedCode === cleanInput) {
            const effectiveDuration = headerConfig?.durationMinutes || Math.round((test.total_marks || 20) * 1.25);
            const result: StudentQuizData = {
              testId: test.id,
              quizCode: hydratedCode,
              title: test.title || headerConfig?.title || 'Examination Assessment',
              headerConfig: headerConfig ? { ...headerConfig, durationMinutes: effectiveDuration } : undefined,
              questions,
              totalMarks: test.total_marks || questions.reduce((sum, q) => sum + (q.marks || 0), 0),
              durationMinutes: effectiveDuration,
            };
            resolvedQuizMemoryCache.set(cleanInput, { data: result, timestamp: Date.now() });
            return result;
          }
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
 * Verifies an invigilator unlock PIN without shipping the plaintext PIN to the
 * candidate. Prefers the server-side `verify_teacher_unlock_pin` RPC and falls
 * back to comparing the salted hash embedded in the student config (offline).
 */
export async function verifyTeacherUnlockPin(
  quizCode: string,
  pin: string,
  expectedHash?: string
): Promise<boolean> {
  const cleanCode = (quizCode || '').trim().toUpperCase();
  const cleanPin = (pin || '').trim();
  if (!cleanCode || !cleanPin) return false;

  try {
    const { data, error } = await (supabase as any).rpc('verify_teacher_unlock_pin', {
      p_quiz_code: cleanCode,
      p_pin: cleanPin,
    });
    if (!error && typeof data === 'boolean') return data;
  } catch {
    // RPC not deployed yet — fall through to the offline hash check.
  }

  if (!expectedHash) return false;
  return (await hashTeacherPin(cleanCode, cleanPin)) === expectedHash;
}

/**
 * Fetches question rows by an array of IDs from Supabase (with questionObjectCache)
 */
export async function fetchQuestionsByIds(ids: string[]): Promise<Question[]> {
  if (!ids || ids.length === 0) return [];

  // 1. Check which valid UUID IDs are missing from cache (non-UUID IDs live in overrides/local data)
  const missingIds = ids.filter((id) => UUID_REGEX.test(id) && !questionObjectCache.has(id));

  if (missingIds.length > 0) {
    try {
      const chunkSize = 100;
      const chunks: string[][] = [];
      for (let i = 0; i < missingIds.length; i += chunkSize) {
        chunks.push(missingIds.slice(i, i + chunkSize));
      }

      const results = await Promise.all(
        chunks.map((chunk) =>
          withTimeout(
            supabase
              .from('questions')
              .select('*')
              .in('id', chunk),
            5000,
            { data: null, error: null } as any
          )
        )
      );

      results.forEach(({ data, error }: any) => {
        if (!error && data && Array.isArray(data)) {
          (data as any[]).forEach((raw) => {
            const norm = normalizeQuestionRecord(raw);
            questionObjectCache.set(norm.id, norm);
          });
        } else if (error) {
          console.warn('fetchQuestionsByIds chunk error:', error.message);
        }
      });
    } catch (err) {
      console.warn('fetchQuestionsByIds exception:', err);
    }
  }

  // Return questions in the exact requested order
  return ids.map((id) => questionObjectCache.get(id)).filter(Boolean) as Question[];
}

/**
 * Helper to fetch questions and cleanly merge any test-specific overrides
 */
export async function fetchAndApplyOverrides(
  questionIds: string[],
  overrides?: Record<string, any>
): Promise<Question[]> {
  if (!questionIds || questionIds.length === 0) return [];
  const safeOverrides = overrides || {};

  // Resolve overrides first so custom/pilot tests resolve immediately without redundant DB round-trips
  const missingFromOverrides = questionIds.filter((qid) => !safeOverrides[qid]);
  const dbQuestions =
    missingFromOverrides.length > 0 ? await fetchQuestionsByIds(missingFromOverrides) : [];

  const dbMap = new Map(dbQuestions.map((q) => [q.id, q]));
  const result: Question[] = [];

  for (const qid of questionIds) {
    if (safeOverrides[qid]) {
      result.push(normalizeQuestionRecord(safeOverrides[qid] as Question));
    } else if (dbMap.has(qid)) {
      result.push(dbMap.get(qid)!);
    }
  }

  return result;
}
