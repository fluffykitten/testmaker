// ─── Test Builder Service ───────────────────────────────────────────────────
// Service for saving, retrieving, and managing custom exam tests in Supabase
// with robust local-storage persistence fallback.

import { supabase, isSupabaseConfigured } from '../lib/supabase';
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
  updatedAt?: string;
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
  _savedTotalMarks?: number;
  _updatedAt?: string;
};

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

function parseTimestampMs(iso?: string | null): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function serializeHeaderForCloud(
  headerConfig?: ExamHeaderConfig,
  questionIds?: string[],
  testId?: string,
  totalMarks?: number
): StoredCloudTestHeader | undefined {
  const hasNonUuidQuestions = Boolean(
    Array.isArray(questionIds) && questionIds.length > 0 && questionIds.some((id) => !UUID_REGEX.test(id))
  );
  const isNonUuidTest = Boolean(testId && !UUID_REGEX.test(testId));

  if (!headerConfig && !hasNonUuidQuestions && !isNonUuidTest && typeof totalMarks !== 'number') {
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

  // Preserve full ordered IDs when custom/non-UUID IDs are used or when the test row itself is non-UUID
  if (Array.isArray(questionIds) && questionIds.length > 0 && (hasNonUuidQuestions || isNonUuidTest)) {
    compacted._savedQuestionIds = questionIds;
  } else if (compacted && '_savedQuestionIds' in compacted) {
    delete compacted._savedQuestionIds;
  }

  if (typeof totalMarks === 'number' && Number.isFinite(totalMarks)) {
    compacted._savedTotalMarks = totalMarks;
  }

  compacted._updatedAt = headerConfig?.updatedAt || compacted.updatedAt || new Date().toISOString();
  compacted.updatedAt = compacted._updatedAt;
  return compacted;
}

export function hydrateTestWithCloudHeader(
  test: CustomTest,
  rawHeader?: StoredCloudTestHeader,
  options: { replaceHeader?: boolean } = {}
): CustomTest {
  if (!rawHeader) return test;
  const { _savedQuestionIds, _savedTotalMarks, _updatedAt, ...cleanHeader } = rawHeader;
  const effectiveUpdatedAt = _updatedAt || cleanHeader.updatedAt || test.header_config?.updatedAt;
  const existingOverrides = test.header_config?.questionOverrides || {};
  const cloudOverrides = cleanHeader.questionOverrides || {};

  let mergedHeader: ExamHeaderConfig;
  if (options.replaceHeader) {
    mergedHeader = {
      ...cleanHeader,
      updatedAt: effectiveUpdatedAt,
      questionOverrides: Object.keys(cloudOverrides).length > 0 ? cloudOverrides : undefined,
    };
  } else {
    mergedHeader = {
      ...cleanHeader,
      ...(test.header_config || {}),
      updatedAt: effectiveUpdatedAt,
      questionOverrides:
        Object.keys(cloudOverrides).length > 0 || Object.keys(existingOverrides).length > 0
          ? { ...cloudOverrides, ...existingOverrides }
          : undefined,
    };
  }

  const resolvedQuestionIds =
    Array.isArray(_savedQuestionIds) && _savedQuestionIds.length > 0
      ? _savedQuestionIds
      : test.question_ids;

  const resolvedTotalMarks =
    typeof _savedTotalMarks === 'number' && _savedTotalMarks > 0
      ? _savedTotalMarks
      : test.total_marks;

  return {
    ...test,
    total_marks: resolvedTotalMarks,
    question_ids: resolvedQuestionIds,
    header_config: mergedHeader,
  };
}

async function saveCloudTestHeaderConfig(
  testId: string,
  headerConfig?: ExamHeaderConfig,
  questionIds?: string[],
  totalMarks?: number
): Promise<void> {
  const payload = serializeHeaderForCloud(headerConfig, questionIds, testId, totalMarks);
  if (!testId || !payload || !isSupabaseConfigured()) return;
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
  if (!testId || !isSupabaseConfigured()) return undefined;
  try {
    const { data, error } = await withTimeout<{ data: { value: string } | null; error: any }>(
      (supabase.from('app_config' as any) as any)
        .select('value')
        .eq('key', `custom_test_header_${testId}`)
        .maybeSingle(),
      4000,
      { data: null, error: null }
    );
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

function syncLocalPublishedQuizzesWithSavedTest(savedTest: CustomTest): void {
  if (typeof localStorage === 'undefined' || !savedTest?.id) return;
  try {
    const raw = localStorage.getItem('fluffykitten_published_quizzes');
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0) return;

    let changed = false;
    const nextIds = Array.isArray(savedTest.question_ids) ? savedTest.question_ids : [];
    const nextTotalMarks = Number(savedTest.total_marks) || 0;
    const updatedAt = new Date().toISOString();

    const updatedList = list.map((q: any) => {
      if (!q || q.testId !== savedTest.id) return q;
      changed = true;
      const nextHeader = q.headerConfig
        ? {
            ...q.headerConfig,
            ...(savedTest.header_config || {}),
            title: q.headerConfig.title || q.title || savedTest.title,
            subject: q.subject || q.headerConfig.subject || savedTest.header_config?.subject,
            durationMinutes: q.durationMinutes || q.headerConfig.durationMinutes,
            teacherPin: q.teacherPin || q.headerConfig.teacherPin,
          }
        : savedTest.header_config;

      return {
        ...q,
        questionIds: nextIds,
        questionCount: nextIds.length,
        totalMarks: nextTotalMarks > 0 ? nextTotalMarks : q.totalMarks,
        headerConfig: nextHeader,
        updatedAt,
      };
    });

    if (changed) {
      localStorage.setItem('fluffykitten_published_quizzes', JSON.stringify(updatedList));
    }
  } catch (err) {
    console.warn('Could not sync local published quiz cache for test update:', err);
  }
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

  const nowIso = new Date().toISOString();
  const safeTitle = (payload.title || 'Custom Assessment').trim().slice(0, 255);
  const fullQuestionIds = Array.isArray(payload.questionIds) ? payload.questionIds : [];
  const validUuidQuestionIds = fullQuestionIds.filter((id) => UUID_REGEX.test(id));
  const stampedHeaderConfig: ExamHeaderConfig = {
    title: payload.headerConfig?.title || safeTitle,
    schoolName: payload.headerConfig?.schoolName || '',
    subject: payload.headerConfig?.subject || 'General',
    subjectCode: payload.headerConfig?.subjectCode || '',
    durationMinutes: payload.headerConfig?.durationMinutes || 45,
    instructions: payload.headerConfig?.instructions || '',
    ...(payload.headerConfig || {}),
    updatedAt: nowIso,
  };

  const localRecord: CustomTest = {
    id: localId,
    user_id: null,
    title: safeTitle,
    total_marks: payload.totalMarks,
    question_ids: fullQuestionIds,
    created_at: nowIso,
    header_config: stampedHeaderConfig,
  };

  if (isSupabaseConfigured()) {
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
          header_config: stampedHeaderConfig,
        };
        saveLocalTest(saved);
        clearCustomTestsCache();
        await saveCloudTestHeaderConfig(saved.id, stampedHeaderConfig, fullQuestionIds, payload.totalMarks);
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('tests_updated'));
        return saved;
      }

      if (error) {
        console.warn('Supabase insert notice, persisting to local storage:', error.message);
      }
    } catch (err) {
      console.warn('Supabase insert failed, persisting to local storage:', err);
    }
  }

  // Fallback to local storage + cloud header store
  saveLocalTest(localRecord);
  clearCustomTestsCache();
  await saveCloudTestHeaderConfig(localRecord.id, stampedHeaderConfig, fullQuestionIds, payload.totalMarks);
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
  const nowIso = new Date().toISOString();
  const safeTitle = (payload.title || 'Custom Assessment').trim().slice(0, 255);
  const fullQuestionIds = Array.isArray(payload.questionIds) ? payload.questionIds : [];
  const validUuidQuestionIds = fullQuestionIds.filter((id) => UUID_REGEX.test(id));
  const mergedBaseHeader = payload.headerConfig || existingLocal?.header_config;
  const stampedHeaderConfig: ExamHeaderConfig = {
    title: mergedBaseHeader?.title || safeTitle,
    schoolName: mergedBaseHeader?.schoolName || '',
    subject: mergedBaseHeader?.subject || 'General',
    subjectCode: mergedBaseHeader?.subjectCode || '',
    durationMinutes: mergedBaseHeader?.durationMinutes || 45,
    instructions: mergedBaseHeader?.instructions || '',
    ...(mergedBaseHeader || {}),
    updatedAt: nowIso,
  };

  const updatedRecord: CustomTest = {
    id: testId,
    user_id: existingLocal?.user_id || null,
    title: safeTitle,
    total_marks: payload.totalMarks,
    question_ids: fullQuestionIds,
    created_at: existingLocal?.created_at || nowIso,
    header_config: stampedHeaderConfig,
  };

  if (isSupabaseConfigured()) {
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
            header_config: stampedHeaderConfig,
          };
          saveLocalTest(saved);
          syncLocalPublishedQuizzesWithSavedTest(saved);
          clearCustomTestsCache();
          await saveCloudTestHeaderConfig(saved.id, stampedHeaderConfig, fullQuestionIds, payload.totalMarks);
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
  }

  saveLocalTest(updatedRecord);
  syncLocalPublishedQuizzesWithSavedTest(updatedRecord);
  clearCustomTestsCache();
  await saveCloudTestHeaderConfig(updatedRecord.id, stampedHeaderConfig, fullQuestionIds, payload.totalMarks);
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

      // Hydrate cloud-persisted header_config for ALL cloud tests first so timestamps & overrides are authoritative
      const cloudIds = Array.from(mergedMap.keys());
      const cloudHeaders = await fetchCloudTestHeadersBatch(cloudIds);
      cloudHeaders.forEach((hdr, id) => {
        const existing = mergedMap.get(id);
        if (existing) {
          mergedMap.set(id, hydrateTestWithCloudHeader(existing, hdr, { replaceHeader: true }));
        }
      });

      localTests.forEach((t) => {
        if (deletedIds.has(t.id)) return;
        if (!mergedMap.has(t.id)) {
          mergedMap.set(t.id, t);
          return;
        }
        const existing = mergedMap.get(t.id)!;
        const cloudHdr = cloudHeaders.get(t.id);
        const localTs = parseTimestampMs(t.header_config?.updatedAt);
        const cloudTs = parseTimestampMs(cloudHdr?._updatedAt || cloudHdr?.updatedAt);

        // Only keep local copy over cloud when local has a strictly newer offline edit timestamp
        if (localTs > cloudTs) {
          mergedMap.set(t.id, t);
          return;
        }

        // Legacy fallback only: if cloud has neither header_config nor saved non-UUID IDs, keep local metadata/custom IDs
        const hasLocalCustomIds =
          Array.isArray(t.question_ids) && t.question_ids.some((id) => !UUID_REGEX.test(id));
        const preservedQuestionIds =
          hasLocalCustomIds && !cloudHdr?._savedQuestionIds && t.question_ids.length >= (existing.question_ids?.length || 0)
            ? t.question_ids
            : existing.question_ids;

        if (!existing.header_config && t.header_config) {
          mergedMap.set(t.id, {
            ...existing,
            question_ids: preservedQuestionIds,
            header_config: t.header_config,
          });
        } else if (preservedQuestionIds !== existing.question_ids) {
          mergedMap.set(t.id, { ...existing, question_ids: preservedQuestionIds });
        }
      });

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
 * Fetches a single custom test and resolves all questions in their exact saved order.
 * Prefers the latest cloud saved test + header config whenever available, falling back
 * to local storage when offline or when a newer local edit has not yet synced.
 */
export async function fetchCustomTestWithQuestions(
  testId: string
): Promise<{ test: CustomTest; questions: Question[] } | null> {
  if (!testId || getDeletedTestIds().has(testId.trim())) {
    return null;
  }

  const localTest = getLocalTests().find((t) => t.id === testId);
  let cloudTestRow: CustomTest | null = null;
  let cloudHeader: StoredCloudTestHeader | undefined;

  if (isSupabaseConfigured()) {
    try {
      const [rowRes, hdrRes] = await Promise.all([
        UUID_REGEX.test(testId)
          ? withTimeout<{ data: any; error: any }>(
              supabase
                .from('custom_tests')
                .select('*')
                .eq('id', testId)
                .maybeSingle(),
              4500,
              { data: null, error: null }
            )
          : Promise.resolve({ data: null, error: null }),
        fetchCloudTestHeaderConfig(testId),
      ]);
      if (!rowRes?.error && rowRes?.data) {
        cloudTestRow = rowRes.data as CustomTest;
      }
      cloudHeader = hdrRes;
    } catch {
      // ignore and fall back to localTest
    }
  }

  const localTs = parseTimestampMs(localTest?.header_config?.updatedAt);
  const cloudTs = parseTimestampMs(cloudHeader?._updatedAt || cloudHeader?.updatedAt);

  let test: CustomTest | undefined;
  if (localTest && localTs > cloudTs) {
    test = localTest;
  } else if (cloudTestRow || cloudHeader) {
    const baseCloudTest: CustomTest = cloudTestRow
      ? {
          ...cloudTestRow,
          // Keep custom non-UUID question_ids only if cloud header didn't store _savedQuestionIds yet
          question_ids:
            !cloudHeader?._savedQuestionIds &&
            localTest?.question_ids?.some((id) => !UUID_REGEX.test(id))
              ? localTest.question_ids
              : cloudTestRow.question_ids,
          header_config: !cloudHeader && !cloudTestRow.header_config ? localTest?.header_config : cloudTestRow.header_config,
        }
      : {
          ...(localTest || {
            id: testId,
            user_id: null,
            title: cloudHeader?.title || 'Custom Assessment',
            total_marks: cloudHeader?._savedTotalMarks || 0,
            question_ids: cloudHeader?._savedQuestionIds || [],
            created_at: new Date().toISOString(),
          }),
        };

    test = cloudHeader
      ? hydrateTestWithCloudHeader(baseCloudTest, cloudHeader, { replaceHeader: true })
      : baseCloudTest;
    saveLocalTest(test);
  } else {
    test = localTest;
  }

  if (!test) return null;

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
  if (chunks.length > 0 && isSupabaseConfigured()) {
    try {
      const results = await Promise.all(
        chunks.map((chunk) =>
          withTimeout<{ data: any; error: any }>(
            supabase
              .from('questions')
              .select('*')
              .in('id', chunk),
            5000,
            { data: null, error: null }
          )
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

  if (orderedQuestions.length > 0 && (!Number(test.total_marks) || orderedQuestions.length !== questionIds.length)) {
    const computedMarks = orderedQuestions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0);
    if (computedMarks > 0) {
      test = { ...test, total_marks: computedMarks };
    }
  }

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
