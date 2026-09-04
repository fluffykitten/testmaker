// ─── Test Builder Service ───────────────────────────────────────────────────
// Service for saving, retrieving, and managing custom exam tests in Supabase
// with robust local-storage persistence fallback.

import { supabase } from '../lib/supabase';
import type { Question, CustomTest } from '../types/database';
import { inferTopicFromContent } from './questionBankService';

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
  teacherPin?: string;
}

export interface SaveTestPayload {
  title: string;
  totalMarks: number;
  questionIds: string[];
  headerConfig?: ExamHeaderConfig;
}

const LOCAL_STORAGE_KEY = 'fluffykitten_custom_tests';
const DELETED_TESTS_KEY = 'fluffykitten_deleted_test_ids';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns the set of all test IDs that have been explicitly deleted.
 */
export function getDeletedTestIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DELETED_TESTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

/**
 * Permanently records a deleted test ID in the tombstone registry.
 */
export function recordDeletedTestId(id: string): void {
  if (!id || typeof id !== 'string') return;
  const cleanId = id.trim();
  if (!cleanId) return;
  try {
    const current = getDeletedTestIds();
    current.add(cleanId);
    // Keep most recent 500 deleted IDs to prevent unbounded storage growth
    const arr = Array.from(current);
    const trimmed = arr.length > 500 ? arr.slice(arr.length - 500) : arr;
    localStorage.setItem(DELETED_TESTS_KEY, JSON.stringify(trimmed));
  } catch (err) {
    console.warn('Failed to record deleted test ID to tombstone registry:', err);
  }
}

/**
 * Checks whether a given test ID was marked as deleted.
 */
export function isTestDeleted(id: string): boolean {
  if (!id) return false;
  return getDeletedTestIds().has(id.trim());
}

export function getLocalTests(): CustomTest[] {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    const list: CustomTest[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    const deletedIds = getDeletedTestIds();
    return list.filter((t) => t && t.id && !deletedIds.has(t.id));
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
    const cleanId = id.trim();
    recordDeletedTestId(cleanId);
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    const existing: CustomTest[] = raw ? JSON.parse(raw) : [];
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(existing.filter((t) => t.id !== cleanId)));
  } catch (err) {
    console.warn('Failed to remove from localStorage:', err);
  }
}

/**
 * Helper to infer subject from keywords in titles or question text
 */
function inferSubjectFromText(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // English, Languages & Literature
  if (/english|ielts|toefl|listening|reading|comprehension|passage|grammar|vocabulary|literature|writing|essay|dialogue|conversation|cloze|tka|akm|bahasa inggris|indonesian|spanish|french/i.test(lower)) {
    return 'English';
  }
  // Chemistry
  if (/chem|stoich|acid|base|organic|element|compound|reaction|atom|mole|periodic|titrat|redox|halogen|alkane|alkene|polymer/i.test(lower)) {
    return 'Chemistry';
  }
  // Geography
  if (/geograph|population|tectonic|earthquake|volcano|weather|climate|river|coast|settlement|migration|urban|landform/i.test(lower)) {
    return 'Geography';
  }
  // Biology
  if (/biology|cell|photosynthesis|enzyme|respiration|organism|plant|digest|circulat|genetics|dna|ecosystem/i.test(lower)) {
    return 'Biology';
  }
  // Physics
  if (/physics|force|velocity|acceleration|energy|wave|refraction|lens|magnet|circuit|current|voltage|radioactivity/i.test(lower)) {
    return 'Physics';
  }
  // Mathematics
  if (/math|algebra|geometry|calculus|trigonometry|matrix|fraction|probability|statistic|arithmetic|polynomial|vector/i.test(lower)) {
    return 'Mathematics';
  }
  // Economics & Business
  if (/economic|business|account|inflation|gdp|finance|market|monopoly|trade|revenue|cost|elasticity|demand|supply/i.test(lower)) {
    return 'Economics';
  }
  // History
  if (/history|treaty|war|revolution|reich|cold war|league of nations|armistice|empire|colony/i.test(lower)) {
    return 'History';
  }
  // Computer Science
  if (/computer science|python|pseudocode|algorithm|binary|hexadecimal|logic gate|sql|database|cybersecurity/i.test(lower)) {
    return 'Computer Science';
  }

  return null;
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
    header_config: payload.headerConfig,
  };

  try {
    // Attempt insert with header_config included
    const { data, error } = await supabase
      .from('custom_tests')
      .insert([
        {
          title: payload.title,
          total_marks: payload.totalMarks,
          question_ids: payload.questionIds,
          header_config: payload.headerConfig,
        },
      ] as any)
      .select('*')
      .single();

    if (!error && data) {
      const saved = { ...(data as CustomTest), header_config: payload.headerConfig || (data as any).header_config };
      saveLocalTest(saved);
      return saved;
    }

    // Fallback: If header_config column doesn't exist in Supabase custom_tests schema
    if (error && error.message && error.message.includes('header_config')) {
      const { data: retryData, error: retryError } = await supabase
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

      if (!retryError && retryData) {
        const saved = { ...(retryData as CustomTest), header_config: payload.headerConfig };
        saveLocalTest(saved);
        return saved;
      }
    }
  } catch (err) {
    console.warn('Supabase insert failed, persisting to local storage:', err);
  }

  // Fallback to local storage
  saveLocalTest(localRecord);
  return localRecord;
}

// ─── High-Performance In-Memory Cache for Custom Tests ─────────────────────────
let customTestsMetadataCache: { data: CustomTestWithDetails[]; timestamp: number } | null = null;
const CUSTOM_TESTS_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes TTL

export function clearCustomTestsCache(): void {
  customTestsMetadataCache = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('tests_updated', clearCustomTestsCache);
}

export interface CustomTestWithDetails extends CustomTest {
  topics: string[];
  subjects: string[];
  primaryTopic: string;
  primarySubject: string;
}

/**
 * Fetches all saved custom tests from Supabase and local storage,
 * strictly filtering out any tombstoned/deleted test IDs.
 */
export async function fetchCustomTests(): Promise<CustomTest[]> {
  const deletedIds = getDeletedTestIds();
  const rawLocal = getLocalTests();
  const localTests = rawLocal.filter((t) => !deletedIds.has(t.id));

  // Auto-prune tombstoned records from localStorage if any slipped in
  if (rawLocal.length !== localTests.length) {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(localTests));
    } catch {
      // ignore
    }
  }

  try {
    const { data, error } = await supabase
      .from('custom_tests')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && Array.isArray(data)) {
      const mergedMap = new Map<string, CustomTest>();
      const orphanedCloudDeletes: string[] = [];

      (data as CustomTest[]).forEach((t) => {
        if (!t || !t.id) return;
        if (deletedIds.has(t.id)) {
          // Lingering in cloud despite local deletion — queue background cleanup
          orphanedCloudDeletes.push(t.id);
          return;
        }
        mergedMap.set(t.id, t);
      });

      // Background self-healing: purge orphaned rows from Supabase
      if (orphanedCloudDeletes.length > 0) {
        const validUuids = orphanedCloudDeletes.filter((id) => UUID_REGEX.test(id));
        if (validUuids.length > 0) {
          (async () => {
            try {
              const { error: delErr } = await supabase
                .from('custom_tests')
                .delete()
                .in('id', validUuids);
              if (delErr) console.warn('Orphaned cloud test cleanup notice:', delErr.message);
            } catch (delEx) {
              console.warn('Orphaned cloud test cleanup exception:', delEx);
            }
          })();
        }
      }

      localTests.forEach((t) => {
        if (deletedIds.has(t.id)) return;
        if (!mergedMap.has(t.id)) {
          mergedMap.set(t.id, t);
        } else {
          // Preserve local header_config if cloud record is missing it
          const existing = mergedMap.get(t.id)!;
          if (!existing.header_config && t.header_config) {
            mergedMap.set(t.id, { ...existing, header_config: t.header_config });
          }
        }
      });

      return Array.from(mergedMap.values());
    }
  } catch (err) {
    console.warn('Supabase fetch failed, using local tests:', err);
  }

  return localTests;
}

/**
 * Fetches all saved custom tests enriched with topic and subject metadata (cached & optimized)
 */
export async function fetchCustomTestsWithMetadata(): Promise<CustomTestWithDetails[]> {
  if (customTestsMetadataCache && Date.now() - customTestsMetadataCache.timestamp < CUSTOM_TESTS_CACHE_TTL_MS) {
    return customTestsMetadataCache.data;
  }

  const tests = await fetchCustomTests();
  if (tests.length === 0) return [];

  // Check which tests actually lack explicit subject information in header_config
  const testsNeedingMeta = tests.filter(
    (t) => !t.header_config?.subject || t.header_config.subject.toLowerCase() === 'general'
  );
  const allQIds = Array.from(new Set(testsNeedingMeta.flatMap((t) => t.question_ids || [])));

  const questionMetaMap = new Map<string, { topic: string; subject: string }>();

  // Fetch syllabuses in parallel for resilient fallback mapping
  const syllabusMap = new Map<string, string>();
  try {
    const { data: sData } = await supabase.from('syllabuses').select('id, subject_name');
    if (sData && Array.isArray(sData)) {
      sData.forEach((s: any) => {
        if (s.id && s.subject_name) syllabusMap.set(s.id, s.subject_name);
      });
    }
  } catch (err) {
    console.warn('Could not fetch syllabuses dictionary:', err);
  }

  if (allQIds.length > 0) {
    try {
      const chunkSize = 100;
      const chunks: string[][] = [];
      for (let i = 0; i < allQIds.length; i += chunkSize) {
        chunks.push(allQIds.slice(i, i + chunkSize));
      }

      const results = await Promise.all(
        chunks.map((chunk) =>
          supabase
            .from('questions')
            .select('id, topic, sub_topic, syllabus_id')
            .in('id', chunk)
        )
      );

      results.forEach(({ data: qData, error: qError }) => {
        if (!qError && qData && Array.isArray(qData)) {
          qData.forEach((q: any) => {
            let subject = '';

            if (q.syllabus_id && syllabusMap.has(q.syllabus_id)) {
              subject = syllabusMap.get(q.syllabus_id) || '';
            }

            if (!subject || subject.toLowerCase() === 'general') {
              const inferred = inferSubjectFromText(`${q.topic || ''} ${q.sub_topic || ''}`);
              if (inferred) subject = inferred;
            }

            let topic = q.topic?.trim() || '';
            if (!topic || topic.toLowerCase() === 'general') {
              topic = inferTopicFromContent('', q.sub_topic);
            }

            questionMetaMap.set(q.id, {
              topic: topic || 'General',
              subject: subject || 'General',
            });
          });
        }
      });
    } catch (err) {
      console.warn('Could not fetch question metadata for tests:', err);
    }
  }

  const result: CustomTestWithDetails[] = tests.map((t) => {
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

    const nonGeneralTopics = testTopics.filter((top) => top && top.toLowerCase() !== 'general');
    let uniqueTopics = Array.from(new Set(nonGeneralTopics));
    let primaryTopic = 'General';

    if (uniqueTopics.length === 1) {
      primaryTopic = uniqueTopics[0];
    } else if (uniqueTopics.length > 1) {
      // Find highest frequency non-general topic
      let maxCount = 0;
      for (const [top, count] of topicCounts.entries()) {
        if (top.toLowerCase() !== 'general' && count > maxCount) {
          maxCount = count;
          primaryTopic = top;
        }
      }
      if (uniqueTopics.length > 2 && maxCount <= qIds.length / 2) {
        primaryTopic = 'Multi-Topic';
      }
    } else if (testTopics.length > 0) {
      primaryTopic = testTopics[0];
    }

    // Fallback: If primaryTopic is still General, try inferring from test title or header
    if (!primaryTopic || primaryTopic === 'General') {
      const titleTopic = inferTopicFromContent(t.title || '');
      if (titleTopic && titleTopic !== 'General') {
        primaryTopic = titleTopic;
      }
    }

    // If uniqueTopics was empty, populate with primaryTopic if non-general
    if (uniqueTopics.length === 0 && primaryTopic && primaryTopic !== 'General') {
      uniqueTopics = [primaryTopic];
    }

    // Resolve primary subject with multi-tier hierarchy:
    // 1. Explicit header config subject (if present and not "General")
    // 2. Title keyword inference (e.g. "Chemistry Paper 4 Practice", "IGCSE Biology")
    // 3. Predominant question subject
    // 4. Inferred subject from topics
    let primarySubject = '';
    const headerSubject = t.header_config?.subject;
    if (headerSubject && headerSubject.trim() && headerSubject.toLowerCase() !== 'general') {
      primarySubject = headerSubject.trim();
    }

    if (!primarySubject) {
      const titleInferred = inferSubjectFromText(t.title || '');
      if (titleInferred) primarySubject = titleInferred;
    }

    if (!primarySubject && testSubjects.length > 0 && testSubjects[0].toLowerCase() !== 'general') {
      primarySubject = testSubjects[0];
    }

    if (!primarySubject) {
      primarySubject = inferSubjectFromText(testTopics.join(' ') + ' ' + (t.title || '')) || 'General';
    }

    const finalSubjects = testSubjects.filter((s) => s.toLowerCase() !== 'general');
    if (finalSubjects.length === 0 && primarySubject && primarySubject !== 'General') {
      finalSubjects.push(primarySubject);
    } else if (finalSubjects.length === 0) {
      finalSubjects.push('General');
    }

    return {
      ...t,
      topics: uniqueTopics.length > 0 ? uniqueTopics : [primaryTopic || 'General'],
      subjects: Array.from(new Set(finalSubjects)),
      primaryTopic: primaryTopic || 'General',
      primarySubject: primarySubject || 'General',
    };
  });

  customTestsMetadataCache = { data: result, timestamp: Date.now() };
  return result;
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
 * Deletes a custom test from Supabase and local storage,
 * and adds it to the persistent tombstone registry to prevent resurrection.
 */
export async function deleteCustomTest(testId: string): Promise<boolean> {
  const cleanId = (testId || '').trim();
  if (!cleanId) return false;

  // 1. Record into tombstone registry immediately
  recordDeletedTestId(cleanId);

  // 2. Remove from local storage & memory cache
  removeLocalTest(cleanId);
  clearCustomTestsCache();

  // 3. Delete from Supabase if valid UUID
  if (UUID_REGEX.test(cleanId)) {
    try {
      const { error } = await supabase
        .from('custom_tests')
        .delete()
        .eq('id', cleanId);

      if (error) {
        console.warn('Supabase delete custom_tests notice:', error.message);
      }
    } catch (err) {
      console.warn('Supabase delete custom_tests exception:', err);
    }
  }

  // 4. Also clean up any associated published interactive quiz (both local & cloud)
  try {
    const { deletePublishedQuiz } = await import('./quizManagerService');
    await deletePublishedQuiz(cleanId);
  } catch (err) {
    console.warn('Cleanup published quiz notice:', err);
  }

  // 5. Broadcast deletion to all open tabs/views
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('tests_updated', { detail: { deletedId: cleanId } }));
  }

  return true;
}
