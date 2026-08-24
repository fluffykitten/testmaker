// ─── Quiz Code & Student Resolution Service ─────────────────────────────────
// Generates and resolves friendly 6-to-8 character Quiz Codes (e.g., CHEM-101)
// to fetch test questions and configuration for students without teacher PIN.

import { supabase } from '../lib/supabase';
import type { Question, CustomTest } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import { getPublishedQuizzes } from './quizManagerService';

export interface StudentQuizData {
  testId: string;
  quizCode: string;
  title: string;
  headerConfig?: ExamHeaderConfig;
  questions: Question[];
  totalMarks: number;
  durationMinutes?: number;
  isExamMode?: boolean;
  securityEnabled?: boolean;
  maxViolations?: number;
  showInstantSolutions?: boolean;
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

/**
 * Resolves a quiz by Quiz Code or Test UUID from Supabase, Published Quizzes, or LocalStorage
 */
export async function resolveStudentQuiz(codeOrId: string): Promise<StudentQuizData | null> {
  const cleanInput = codeOrId.trim().toUpperCase();
  if (!cleanInput) return null;

  // 1. Check Configured Published Quizzes first
  try {
    const publishedList = getPublishedQuizzes();
    const published = publishedList.find(
      (p) =>
        p.quizCode.toUpperCase() === cleanInput ||
        p.id.toUpperCase() === cleanInput ||
        p.testId.toUpperCase() === cleanInput
    );

    if (published) {
      const questions = await fetchQuestionsByIds(published.questionIds || []);
      return {
        testId: published.testId,
        quizCode: published.quizCode,
        title: published.title,
        headerConfig: published.headerConfig,
        questions,
        totalMarks: published.totalMarks,
        durationMinutes: published.durationMinutes,
        isExamMode: published.isExamMode,
        securityEnabled: published.securityEnabled,
        maxViolations: published.maxViolations,
        showInstantSolutions: published.showInstantSolutions,
      };
    }
  } catch (err) {
    console.warn('Published quiz lookup error:', err);
  }

  // 2. Check LocalStorage tests fallback
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

  // 2. Query Supabase custom_tests table
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

  return null;
}

/**
 * Fetches question rows by an array of IDs from Supabase
 */
async function fetchQuestionsByIds(ids: string[]): Promise<Question[]> {
  if (!ids || ids.length === 0) return [];
  try {
    const { data, error } = await supabase
      .from('questions')
      .select('*')
      .in('id', ids);

    if (error || !data) {
      console.warn('Could not fetch questions from Supabase:', error);
      return [];
    }

    // Preserve the original order of question IDs
    const qMap = new Map((data as Question[]).map((q) => [q.id, q]));
    return ids.map((id) => qMap.get(id)).filter(Boolean) as Question[];
  } catch (err) {
    console.error('fetchQuestionsByIds error:', err);
    return [];
  }
}
