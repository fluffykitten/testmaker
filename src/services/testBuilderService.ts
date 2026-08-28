// ─── Test Builder Service ───────────────────────────────────────────────────
// Service for saving, retrieving, and managing custom exam tests in Supabase
// with robust local-storage persistence fallback.

import { supabase } from '../lib/supabase';
import type { Question, CustomTest } from '../types/database';

export interface ExamHeaderConfig {
  title: string;
  schoolName: string;
  subject: string;
  subjectCode: string;
  durationMinutes: number;
  instructions: string;
  examDate?: string;
  additionalMaterials?: string;
  layoutTemplate?: 'cambridge' | 'standard';
}

export interface SaveTestPayload {
  title: string;
  totalMarks: number;
  questionIds: string[];
  headerConfig?: ExamHeaderConfig;
}

const LOCAL_STORAGE_KEY = 'fluffykitten_custom_tests';

function getLocalTests(): CustomTest[] {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalTest(test: CustomTest) {
  try {
    const existing = getLocalTests();
    const updated = [test, ...existing.filter((t) => t.id !== test.id)];
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(updated));
  } catch (err) {
    console.warn('Failed to save to localStorage:', err);
  }
}

function removeLocalTest(id: string) {
  try {
    const existing = getLocalTests();
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(existing.filter((t) => t.id !== id)));
  } catch (err) {
    console.warn('Failed to remove from localStorage:', err);
  }
}

/**
 * Saves a new custom exam test to Supabase with automatic local storage fallback
 */
export async function saveCustomTest(payload: SaveTestPayload): Promise<CustomTest> {
  const localId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `test-${Date.now()}`;

  const localRecord: CustomTest = {
    id: localId,
    user_id: null,
    title: payload.title,
    total_marks: payload.totalMarks,
    question_ids: payload.questionIds,
    created_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await supabase
      .from('custom_tests')
      .insert([
        {
          title: payload.title,
          total_marks: payload.totalMarks,
          question_ids: payload.questionIds,
        },
      ] as any)
      .select('*')
      .single();

    if (!error && data) {
      saveLocalTest(data as CustomTest);
      return data as CustomTest;
    }
  } catch (err) {
    console.warn('Supabase insert failed, persisting to local storage:', err);
  }

  // Fallback to local storage
  saveLocalTest(localRecord);
  return localRecord;
}

export interface CustomTestWithDetails extends CustomTest {
  topics: string[];
  subjects: string[];
  primaryTopic: string;
  primarySubject: string;
}

/**
 * Fetches all saved custom tests from Supabase and local storage
 */
export async function fetchCustomTests(): Promise<CustomTest[]> {
  const localTests = getLocalTests();
  try {
    const { data, error } = await supabase
      .from('custom_tests')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && Array.isArray(data)) {
      const mergedMap = new Map<string, CustomTest>();
      (data as CustomTest[]).forEach((t) => mergedMap.set(t.id, t));
      localTests.forEach((t) => {
        if (!mergedMap.has(t.id)) mergedMap.set(t.id, t);
      });
      return Array.from(mergedMap.values());
    }
  } catch (err) {
    console.warn('Supabase fetch failed, using local tests:', err);
  }

  return localTests;
}

/**
 * Fetches all saved custom tests enriched with topic and subject metadata
 */
export async function fetchCustomTestsWithMetadata(): Promise<CustomTestWithDetails[]> {
  const tests = await fetchCustomTests();
  if (tests.length === 0) return [];

  // Collect all unique question IDs
  const allQIds = Array.from(new Set(tests.flatMap((t) => t.question_ids || [])));

  const questionMetaMap = new Map<string, { topic: string; subject: string }>();

  if (allQIds.length > 0) {
    try {
      const { data: qData } = await supabase
        .from('questions')
        .select(`
          id,
          topic,
          syllabuses (
            subject_name
          )
        `)
        .in('id', allQIds);

      if (qData && Array.isArray(qData)) {
        qData.forEach((q: any) => {
          const subject = q.syllabuses?.subject_name || 'General';
          questionMetaMap.set(q.id, {
            topic: q.topic || 'General',
            subject,
          });
        });
      }
    } catch (err) {
      console.warn('Could not fetch question metadata for tests:', err);
    }
  }

  return tests.map((t) => {
    const qIds = t.question_ids || [];
    const testTopics: string[] = [];
    const testSubjects: string[] = [];
    const topicCounts = new Map<string, number>();

    qIds.forEach((qid) => {
      const meta = questionMetaMap.get(qid);
      if (meta) {
        if (meta.topic) {
          testTopics.push(meta.topic);
          topicCounts.set(meta.topic, (topicCounts.get(meta.topic) || 0) + 1);
        }
        if (meta.subject && !testSubjects.includes(meta.subject)) {
          testSubjects.push(meta.subject);
        }
      }
    });

    const uniqueTopics = Array.from(new Set(testTopics));
    let primaryTopic = 'General';

    if (uniqueTopics.length === 1) {
      primaryTopic = uniqueTopics[0];
    } else if (uniqueTopics.length > 1) {
      // Find highest frequency topic
      let maxCount = 0;
      for (const [top, count] of topicCounts.entries()) {
        if (count > maxCount) {
          maxCount = count;
          primaryTopic = top;
        }
      }
      if (uniqueTopics.length > 2 && maxCount <= qIds.length / 2) {
        primaryTopic = 'Multi-Topic';
      }
    }

    const primarySubject = testSubjects.length > 0 ? testSubjects[0] : 'General';

    return {
      ...t,
      topics: uniqueTopics.length > 0 ? uniqueTopics : ['General'],
      subjects: testSubjects.length > 0 ? testSubjects : ['General'],
      primaryTopic,
      primarySubject,
    };
  });
}

/**
 * Fetches a single custom test and resolves all questions in their exact saved order
 */
export async function fetchCustomTestWithQuestions(
  testId: string
): Promise<{ test: CustomTest; questions: Question[] } | null> {
  let test: CustomTest | undefined = getLocalTests().find((t) => t.id === testId);

  if (!test) {
    try {
      const { data: testData } = await supabase
        .from('custom_tests')
        .select('*')
        .eq('id', testId)
        .single();
      if (testData) test = testData as CustomTest;
    } catch {
      // ignore
    }
  }

  if (!test) return null;
  const questionIds = test.question_ids || [];

  if (questionIds.length === 0) {
    return { test, questions: [] };
  }

  // Fetch all questions matching the IDs
  const { data: qData, error: qError } = await supabase
    .from('questions')
    .select('*')
    .in('id', questionIds);

  if (qError || !qData) {
    console.error('Failed to fetch test questions:', qError);
    return { test, questions: [] };
  }

  const questionsMap = new Map<string, Question>();
  (qData as Question[]).forEach((q) => questionsMap.set(q.id, q));

  // Maintain the exact array order specified in question_ids
  const orderedQuestions: Question[] = [];
  questionIds.forEach((qid) => {
    const found = questionsMap.get(qid);
    if (found) orderedQuestions.push(found);
  });

  return { test, questions: orderedQuestions };
}

/**
 * Deletes a custom test from Supabase and local storage
 */
export async function deleteCustomTest(testId: string): Promise<boolean> {
  removeLocalTest(testId);
  try {
    await supabase
      .from('custom_tests')
      .delete()
      .eq('id', testId);
  } catch {
    // ignore
  }

  return true;
}
