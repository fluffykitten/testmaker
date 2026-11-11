// ─── Test Builder Service ───────────────────────────────────────────────────
// Service for saving, retrieving, and managing custom exam tests in Supabase
// with robust local-storage persistence fallback.

import { supabase } from '../lib/supabase';
import type { Question, CustomTest } from '../types/database';
import { inferTopicFromContent, normalizeQuestionRecord } from './questionBankService';
import { PILOT_CUSTOM_TEST, PILOT_EXAM_ID } from '../data/pilotExam170Data';

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
  /**
   * Salted hash of the invigilator PIN. Candidate clients receive only this value
   * (never the plaintext) so an unlock can still be verified offline.
   */
  teacherPinHash?: string;
  questionOverrides?: Record<string, Question>;
  /**
   * Tracks whether the teacher has manually edited any header field
   * (subject, code, instructions, materials, title, duration).
   * When true, automatic question-based subject inference is strictly disabled.
   */
  isUserCustomized?: boolean;
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
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DELETED_TESTS_KEY) : null;
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
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DELETED_TESTS_KEY, JSON.stringify(trimmed));
    }
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
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCAL_STORAGE_KEY) : null;
    const list: CustomTest[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    const deletedIds = getDeletedTestIds();
    const active = list.filter((t) => t && t.id && !deletedIds.has(t.id));

    // Auto-seed pilot test into Saved Tests if not deleted and not in list
    if (!deletedIds.has(PILOT_EXAM_ID) && !active.some((t) => t.id === PILOT_EXAM_ID)) {
      active.unshift(PILOT_CUSTOM_TEST);
    }
    return active;
  } catch {
    return [PILOT_CUSTOM_TEST];
  }
}

function compactTestOverrides(test: CustomTest): CustomTest {
  if (!test.header_config?.questionOverrides) return test;
  const compactedOverrides: Record<string, Question> = {};
  for (const [qid, q] of Object.entries(test.header_config.questionOverrides)) {
    if (!q) continue;
    const copy: any = { ...q };
    if (copy.svg_content && copy.diagram_url && String(copy.diagram_url).startsWith('data:image/svg')) {
      delete copy.svg_content;
    }
    compactedOverrides[qid] = copy;
  }
  return {
    ...test,
    header_config: {
      ...test.header_config,
      questionOverrides: compactedOverrides,
    },
  };
}

function saveLocalTest(test: CustomTest) {
  const existing = getLocalTests();
  const otherTests = existing.filter((t) => t.id !== test.id);
  try {
    const updated = [test, ...otherTests];
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(updated));
  } catch (err) {
    try {
      // Fallback 1: compact redundant SVG strings in overrides across all stored tests
      const compacted = [
        compactTestOverrides(test),
        ...otherTests.slice(0, 30).map((t, idx) => (idx < 10 ? compactTestOverrides(t) : { ...t, header_config: t.header_config ? { ...t.header_config, questionOverrides: undefined } : undefined })),
      ];
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(compacted));
    } catch (retryErr) {
      console.warn('Failed to save to localStorage:', retryErr || err);
    }
  }
}

type StoredCloudTestHeader = ExamHeaderConfig & {
  _savedQuestionIds?: string[];
};

function serializeHeaderForCloud(
  headerConfig?: ExamHeaderConfig,
  questionIds?: string[]
): StoredCloudTestHeader | undefined {
  if (!headerConfig && (!questionIds || questionIds.every((id) => UUID_REGEX.test(id)))) {
    return undefined;
  }
  const baseHeader: ExamHeaderConfig = headerConfig || {
    title: '',
    schoolName: '',
    subject: 'General',
    subjectCode: '',
    durationMinutes: 45,
    instructions: '',
  };
  const compacted = compactTestOverrides({
    id: '',
    title: baseHeader.title || '',
    total_marks: 0,
    question_ids: [],
    created_at: '',
    header_config: baseHeader,
  }).header_config as StoredCloudTestHeader;

  // Preserve full ordered IDs (including non-UUID custom/local/pilot IDs) since custom_tests.question_ids is UUID[]
  if (Array.isArray(questionIds) && questionIds.length > 0 && questionIds.some((id) => !UUID_REGEX.test(id))) {
    compacted._savedQuestionIds = questionIds;
  } else if (compacted && '_savedQuestionIds' in compacted) {
    delete compacted._savedQuestionIds;
  }
  return compacted;
}

function hydrateTestWithCloudHeader(
  test: CustomTest,
  rawHeader?: StoredCloudTestHeader
): CustomTest {
  if (!rawHeader) return test;
  const { _savedQuestionIds, ...cleanHeader } = rawHeader;
  const existingOverrides = test.header_config?.questionOverrides || {};
  const cloudOverrides = cleanHeader.questionOverrides || {};
  const mergedHeader: ExamHeaderConfig = {
    ...cleanHeader,
    ...(test.header_config || {}),
    questionOverrides:
      Object.keys(cloudOverrides).length > 0 || Object.keys(existingOverrides).length > 0
        ? { ...cloudOverrides, ...existingOverrides }
        : undefined,
  };
  const resolvedQuestionIds =
    Array.isArray(_savedQuestionIds) && _savedQuestionIds.length > 0
      ? _savedQuestionIds
      : test.question_ids;

  return {
    ...test,
    question_ids: resolvedQuestionIds,
    header_config: mergedHeader,
  };
}

async function saveCloudTestHeaderConfig(
  testId: string,
  headerConfig?: ExamHeaderConfig,
  questionIds?: string[]
): Promise<void> {
  const payload = serializeHeaderForCloud(headerConfig, questionIds);
  if (!testId || !payload) return;
  try {
    await (supabase.from('app_config' as any) as any).upsert(
      {
        key: `custom_test_header_${testId}`,
        value: JSON.stringify(payload),
      },
      { onConflict: 'key' }
    );
  } catch (err) {
    console.warn('Could not sync test header_config to app_config:', err);
  }
}

async function fetchCloudTestHeaderConfig(testId: string): Promise<StoredCloudTestHeader | undefined> {
  if (!testId) return undefined;
  try {
    const { data, error } = await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', `custom_test_header_${testId}`)
      .maybeSingle();
    if (!error && data?.value) {
      return JSON.parse(data.value) as StoredCloudTestHeader;
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function fetchCloudTestHeadersBatch(
  testIds: string[]
): Promise<Map<string, StoredCloudTestHeader>> {
  const headerMap = new Map<string, StoredCloudTestHeader>();
  const uniqueIds = Array.from(new Set(testIds.filter(Boolean)));
  if (uniqueIds.length === 0) return headerMap;

  try {
    const chunkSize = 50;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const slice = uniqueIds.slice(i, i + chunkSize);
      const keys = slice.map((id) => `custom_test_header_${id}`);
      const { data, error } = await (supabase.from('app_config' as any) as any)
        .select('key, value')
        .in('key', keys);

      if (!error && Array.isArray(data)) {
        for (const row of data as Array<{ key?: string; value?: string }>) {
          if (row?.key && row?.value && row.key.startsWith('custom_test_header_')) {
            const testId = row.key.slice('custom_test_header_'.length);
            try {
              headerMap.set(testId, JSON.parse(row.value) as StoredCloudTestHeader);
            } catch {
              // ignore malformed JSON entry
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not batch fetch test headers from app_config:', err);
  }

  return headerMap;
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
 * Saves a new custom exam test to Supabase with automatic local storage fallback.
 * Sends only schema-supported columns & UUID question_ids to custom_tests (no 400 errors)
 * while persisting full header_config (subject, custom/local question IDs, overrides) in app_config.
 */
export async function saveCustomTest(payload: SaveTestPayload): Promise<CustomTest> {
  const localId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `test-${Date.now()}`;

  const safeTitle = (payload.title || 'Custom Assessment').trim().slice(0, 255);
  const fullQuestionIds = Array.isArray(payload.questionIds) ? payload.questionIds : [];
  const validUuidQuestionIds = fullQuestionIds.filter((id) => UUID_REGEX.test(id));

  const localRecord: CustomTest = {
    id: localId,
    user_id: null,
    title: safeTitle,
    total_marks: payload.totalMarks,
    question_ids: fullQuestionIds,
    created_at: new Date().toISOString(),
    header_config: payload.headerConfig,
  };

  try {
    const { data, error } = await supabase
      .from('custom_tests')
      .insert([
        {
          title: safeTitle,
          total_marks: payload.totalMarks,
          question_ids: validUuidQuestionIds,
        },
      ] as any)
      .select('*')
      .maybeSingle();

    if (!error && data) {
      const saved: CustomTest = {
        ...(data as CustomTest),
        question_ids: fullQuestionIds,
        header_config: payload.headerConfig || (data as any).header_config,
      };
      saveLocalTest(saved);
      clearCustomTestsCache();
      await saveCloudTestHeaderConfig(saved.id, payload.headerConfig, fullQuestionIds);
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('tests_updated'));
      return saved;
    }

    if (error) {
      console.warn('Supabase insert notice, persisting to local storage:', error.message);
    }
  } catch (err) {
    console.warn('Supabase insert failed, persisting to local storage:', err);
  }

  // Fallback to local storage + cloud header store
  saveLocalTest(localRecord);
  clearCustomTestsCache();
  await saveCloudTestHeaderConfig(localRecord.id, payload.headerConfig, fullQuestionIds);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('tests_updated'));
  return localRecord;
}

/**
 * Updates an existing custom exam test in Supabase and local storage
 */
export async function updateCustomTest(
  testId: string,
  payload: SaveTestPayload
): Promise<CustomTest> {
  const existingLocal = getLocalTests().find((t) => t.id === testId);
  const safeTitle = (payload.title || 'Custom Assessment').trim().slice(0, 255);
  const fullQuestionIds = Array.isArray(payload.questionIds) ? payload.questionIds : [];
  const validUuidQuestionIds = fullQuestionIds.filter((id) => UUID_REGEX.test(id));

  const updatedRecord: CustomTest = {
    id: testId,
    user_id: existingLocal?.user_id || null,
    title: safeTitle,
    total_marks: payload.totalMarks,
    question_ids: fullQuestionIds,
    created_at: existingLocal?.created_at || new Date().toISOString(),
    header_config: payload.headerConfig,
  };

  try {
    if (UUID_REGEX.test(testId)) {
      const { data, error } = await (supabase.from('custom_tests' as any) as any)
        .update({
          title: safeTitle,
          total_marks: payload.totalMarks,
          question_ids: validUuidQuestionIds,
        })
        .eq('id', testId)
        .select('*')
        .maybeSingle();

      if (!error && data) {
        const saved: CustomTest = {
          ...(data as CustomTest),
          question_ids: fullQuestionIds,
          header_config: payload.headerConfig || (data as any).header_config,
        };
        saveLocalTest(saved);
        clearCustomTestsCache();
        await saveCloudTestHeaderConfig(saved.id, payload.headerConfig, fullQuestionIds);
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('tests_updated'));
        return saved;
      }

      if (error) {
        console.warn('Supabase update notice, updating local storage:', error.message);
      }
    }
  } catch (err) {
    console.warn('Supabase update failed, updating local storage:', err);
  }

  saveLocalTest(updatedRecord);
  clearCustomTestsCache();
  await saveCloudTestHeaderConfig(updatedRecord.id, payload.headerConfig, fullQuestionIds);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('tests_updated'));
  return updatedRecord;
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
 * Synchronously retrieves local tests mapped to CustomTestWithDetails structure
 * for instant, zero-delay rendering and hydration before cloud sync completes.
 */
export function getLocalTestsWithMetadata(): CustomTestWithDetails[] {
  const local = getLocalTests();
  return local.map((t) => ({
    ...t,
    topics: [],
    subjects: t.header_config?.subject ? [t.header_config.subject] : ['General'],
    primaryTopic: 'General',
    primarySubject: t.header_config?.subject || 'General',
  }));
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
          // Preserve local header_config, custom question_ids, and questionOverrides if cloud record is missing them
          const existing = mergedMap.get(t.id)!;
          const preservedQuestionIds =
            Array.isArray(t.question_ids) &&
            t.question_ids.length > (existing.question_ids?.length || 0)
              ? t.question_ids
              : existing.question_ids;

          if (!existing.header_config && t.header_config) {
            mergedMap.set(t.id, {
              ...existing,
              question_ids: preservedQuestionIds,
              header_config: t.header_config,
            });
          } else if (existing.header_config && t.header_config) {
            mergedMap.set(t.id, {
              ...existing,
              question_ids: preservedQuestionIds,
              header_config: {
                ...existing.header_config,
                ...t.header_config,
                questionOverrides: {
                  ...(existing.header_config.questionOverrides || {}),
                  ...(t.header_config.questionOverrides || {}),
                },
              },
            });
          } else if (preservedQuestionIds !== existing.question_ids) {
            mergedMap.set(t.id, { ...existing, question_ids: preservedQuestionIds });
          }
        }
      });

      // Hydrate cloud-persisted header_config (subject, custom question IDs, overrides) for any rows missing local headers
      const idsMissingHeaders = Array.from(mergedMap.values())
        .filter((t) => !t.header_config)
        .map((t) => t.id);

      if (idsMissingHeaders.length > 0) {
        const cloudHeaders = await fetchCloudTestHeadersBatch(idsMissingHeaders);
        cloudHeaders.forEach((hdr, id) => {
          const existing = mergedMap.get(id);
          if (existing) {
            mergedMap.set(id, hydrateTestWithCloudHeader(existing, hdr));
          }
        });
      }

      const mergedList = Array.from(mergedMap.values());

      // Safely cache merged tests to localStorage for instant hydration & offline access
      try {
        const testsToCache = mergedList.slice(0, 50).map((t, idx) =>
          idx < 15
            ? compactTestOverrides(t)
            : {
                ...t,
                header_config: t.header_config
                  ? { ...t.header_config, questionOverrides: undefined }
                  : undefined,
              }
        );
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(testsToCache));
      } catch (cacheErr) {
        console.warn('Could not cache merged tests to localStorage:', cacheErr);
      }

      return mergedList;
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
  // Only query PostgreSQL questions table with valid UUIDs (non-UUID custom/pilot IDs live in questionOverrides)
  const allQIds = Array.from(
    new Set(
      testsNeedingMeta
        .flatMap((t) => t.question_ids || [])
        .filter((id) => UUID_REGEX.test(id))
    )
  );

  const questionMetaMap = new Map<string, { topic: string; subject: string }>();

  // Pre-seed question metadata from embedded questionOverrides where available
  testsNeedingMeta.forEach((t) => {
    const overrides = (t.header_config?.questionOverrides || {}) as Record<string, Question>;
    Object.values(overrides).forEach((q) => {
      if (!q?.id) return;
      const inferredSub =
        (q.syllabus_id && syllabusMap.get(q.syllabus_id)) ||
        (q as any).syllabus?.subject_name ||
        inferSubjectFromText(`${q.topic || ''} ${q.sub_topic || ''} ${q.question_text || ''}`) ||
        'General';
      const inferredTopic = q.topic?.trim() && q.topic.toLowerCase() !== 'general'
        ? q.topic.trim()
        : inferTopicFromContent('', q.sub_topic ?? undefined);
      questionMetaMap.set(q.id, {
        topic: inferredTopic || 'General',
        subject: inferredSub,
      });
    });
  });

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

  if (!test && UUID_REGEX.test(testId)) {
    try {
      const { data: testData } = await supabase
        .from('custom_tests')
        .select('*')
        .eq('id', testId)
        .maybeSingle();
      if (testData) test = testData as CustomTest;
    } catch {
      // ignore
    }
  }

  if (!test) return null;

  // Recover cloud-synced header_config (including custom question_ids & questionOverrides) if missing locally
  if (!test.header_config || !test.header_config.questionOverrides) {
    const cloudHeader = await fetchCloudTestHeaderConfig(testId);
    if (cloudHeader) {
      test = hydrateTestWithCloudHeader(test, cloudHeader);
      saveLocalTest(test);
    }
  }

  const questionIds = test.question_ids || [];

  if (questionIds.length === 0) {
    return { test, questions: [] };
  }

  const overrides = test.header_config?.questionOverrides || {};
  const uuidIdsToFetch = questionIds.filter((qid) => !overrides[qid] && UUID_REGEX.test(qid));

  // Fetch only UUID questions not already satisfied by overrides (avoids invalid UUID 400 errors & redundant network calls)
  const chunkSize = 100;
  const chunks: string[][] = [];
  for (let i = 0; i < uuidIdsToFetch.length; i += chunkSize) {
    chunks.push(uuidIdsToFetch.slice(i, i + chunkSize));
  }

  const questionsMap = new Map<string, Question>();
  if (chunks.length > 0) {
    try {
      const results = await Promise.all(
        chunks.map((chunk) =>
          supabase
            .from('questions')
            .select('*')
            .in('id', chunk)
        )
      );

      results.forEach(({ data: qData, error: qError }) => {
        if (!qError && qData && Array.isArray(qData)) {
          (qData as Question[]).forEach((q) => {
            const normalized = normalizeQuestionRecord(q);
            questionsMap.set(normalized.id, normalized);
          });
        } else if (qError) {
          console.warn('Batch fetch test questions error:', qError.message);
        }
      });
    } catch (err) {
      console.error('Failed to fetch test questions batch:', err);
    }
  }

  // Maintain the exact array order specified in question_ids
  const orderedQuestions: Question[] = [];

  questionIds.forEach((qid) => {
    const override = overrides[qid];
    const found = questionsMap.get(qid);
    if (override) {
      orderedQuestions.push(normalizeQuestionRecord({ ...(found || {}), ...override }));
    } else if (found) {
      orderedQuestions.push(found);
    }
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

  try {
    await (supabase.from('app_config' as any) as any)
      .delete()
      .eq('key', `custom_test_header_${cleanId}`);
  } catch {
    // ignore
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
