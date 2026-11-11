if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

import { supabase } from '../src/lib/supabase.ts';
import { getSubjectMetadata } from '../src/utils/subjectCatalog.ts';
import {
  saveCustomTest,
  fetchCustomTestsWithMetadata,
  fetchCustomTestWithQuestions,
  clearCustomTestsCache,
} from '../src/services/testBuilderService.ts';
import {
  resolveStudentQuiz,
  fetchAndApplyOverrides,
  clearQuizMemoryCache,
  generateQuizCode,
} from '../src/services/quizCodeService.ts';
import { savePublishedQuiz } from '../src/services/quizManagerService.ts';
import {
  createOrGetSyllabus,
  createQuestion,
  updateQuestion,
  fetchQuestionById,
  fetchQuestions,
  deleteQuestion,
  deleteQuestions,
  batchAttachCambridgeHubUrl,
  batchDetachCambridgeHubUrl,
  batchAttachCambridgeMsHubUrl,
  batchDetachCambridgeMsHubUrl,
  clearQuestionBankCache,
} from '../src/services/questionBankService.ts';
import { fetchPublicRosterDirectory } from '../src/services/studentRosterService.ts';
import {
  fetchAllSubmissionsFromSupabase,
  loadAndSyncAllSubmissions,
} from '../src/services/quizSubmissionService.ts';
import fs from 'node:fs';
import path from 'node:path';

console.log('🧪 Verifying Custom Subject Support ("ICM Exam"), Supabase Payload Safety & Quiz Code Latency...\n');

let passed = 0;
function check(name, cond) {
  if (cond) {
    console.log(`PASS  ${name}`);
    passed++;
  } else {
    console.error(`FAIL  ${name}`);
    process.exit(1);
  }
}

// 1. Subject Metadata Classification Tests
const icmMeta = getSubjectMetadata('ICM Exam');
check('1. getSubjectMetadata("ICM Exam") creates custom fallback subject metadata', icmMeta.name === 'ICM Exam' && icmMeta.id === 'icm-exam');

const econMeta = getSubjectMetadata('Economics');
check('2. getSubjectMetadata("Economics") resolves to Economics (not Computer Science)', econMeta.id === 'economics');

const ethicsMeta = getSubjectMetadata('Ethics');
check('3. getSubjectMetadata("Ethics") does not misclassify to Computer Science', ethicsMeta.id === 'ethics' && ethicsMeta.name === 'Ethics');

const csMeta = getSubjectMetadata('AP CS');
check('4. getSubjectMetadata("AP CS") resolves to Computer Science via word boundary', csMeta.id === 'computer science');

// 2. Mock Supabase in-memory DB to verify exact wire payloads & zero invalid UUID/column errors
const VALID_UUID_1 = '11111111-1111-4111-8111-111111111111';
const VALID_TEST_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOM_Q_ID = 'local-custom-1762900000';

const dbCustomTests = [];
const dbAppConfig = new Map();
const dbSyllabuses = [];
const dbQuestions = new Map();
const dbSubmissions = [];
const questionQueries = [];
const questionWrites = [];
const questionOrFilters = [];
const customTestInserts = [];
const appConfigQueries = [];
let edgeInvokeCount = 0;

supabase.from = (table) => {
  if (table === 'custom_tests') {
    let filterEq = null;
    const builder = {
      insert(rows) {
        const row = rows[0];
        customTestInserts.push(row);
        if ('header_config' in row) {
          throw new Error("Unexpected 'header_config' column sent to custom_tests");
        }
        for (const qid of row.question_ids || []) {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(qid)) {
            throw new Error(`invalid input syntax for type uuid: "${qid}"`);
          }
        }
        const inserted = {
          id: VALID_TEST_UUID,
          user_id: null,
          title: row.title,
          total_marks: row.total_marks,
          question_ids: row.question_ids,
          created_at: new Date().toISOString(),
        };
        dbCustomTests.unshift(inserted);
        return {
          select() {
            return {
              single: async () => ({ data: inserted, error: null }),
              maybeSingle: async () => ({ data: inserted, error: null }),
            };
          },
        };
      },
      select() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return Promise.resolve({ data: [...dbCustomTests], error: null });
      },
      eq(col, val) {
        filterEq = { col, val };
        return builder;
      },
      single: async () => {
        const match = dbCustomTests.find((t) => (!filterEq ? true : t[filterEq.col] === filterEq.val));
        return { data: match || null, error: match ? null : { message: 'Not found' } };
      },
      maybeSingle: async () => {
        const match = dbCustomTests.find((t) => (!filterEq ? true : t[filterEq.col] === filterEq.val));
        return { data: match || null, error: null };
      },
      then(resolve) {
        return Promise.resolve({ data: [...dbCustomTests], error: null }).then(resolve);
      },
    };
    return builder;
  }

  if (table === 'app_config') {
    let filterCol = null;
    let filterVal = null;
    return {
      async upsert(row) {
        const rows = Array.isArray(row) ? row : [row];
        rows.forEach((r) => dbAppConfig.set(r.key, r.value));
        return { data: row, error: null };
      },
      select() {
        return this;
      },
      eq(col, val) {
        filterCol = col;
        filterVal = val;
        if (col === 'key') appConfigQueries.push(val);
        return this;
      },
      in(col, vals) {
        filterCol = col;
        return Promise.resolve({
          data: vals
            .filter((k) => dbAppConfig.has(k))
            .map((k) => ({ key: k, value: dbAppConfig.get(k) })),
          error: null,
        });
      },
      delete() {
        return {
          eq: async (_, val) => {
            dbAppConfig.delete(val);
            return { error: null };
          },
          in: async (_, vals) => {
            vals.forEach((v) => dbAppConfig.delete(v));
            return { error: null };
          },
        };
      },
      maybeSingle: async () => {
        if (filterCol === 'key' && dbAppConfig.has(filterVal)) {
          return { data: { value: dbAppConfig.get(filterVal) }, error: null };
        }
        return { data: null, error: null };
      },
    };
  }

  if (table === 'questions') {
    const VALID_QUESTION_COLUMNS = new Set([
      'id',
      'syllabus_id',
      'year',
      'series',
      'paper_number',
      'question_number',
      'parent_question_id',
      'question_text',
      'question_style',
      'topic',
      'sub_topic',
      'difficulty',
      'marks',
      'diagram_url',
      'sub_questions',
      'mark_scheme',
      'options',
      'diagram_source',
      'resource_ref',
      'insert_page_number',
      'audio_url',
      'audio_metadata',
      'source_pdf_url',
      'page_number',
      'cognitive_level',
      'question_number_numeric',
      'created_at',
    ]);
    let eqId = null;
    let eqSyllabusId = null;
    let inIds = null;
    const builder = {
      select() {
        return builder;
      },
      eq(col, val) {
        if (col === 'id') {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(val))) {
            throw new Error(`invalid input syntax for type uuid: "${val}"`);
          }
          eqId = val;
        }
        if (col === 'syllabus_id') eqSyllabusId = val;
        return builder;
      },
      in(col, ids) {
        if (col === 'id') {
          for (const id of ids) {
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) {
              throw new Error(`invalid input syntax for type uuid: "${id}"`);
            }
          }
          questionQueries.push(ids);
          inIds = ids;
        }
        return builder;
      },
      or(expr) {
        questionOrFilters.push(expr);
        return builder;
      },
      filter() {
        return builder;
      },
      ilike() {
        return builder;
      },
      gte() {
        return builder;
      },
      lte() {
        return builder;
      },
      not() {
        return builder;
      },
      neq() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      range() {
        const list = Array.from(dbQuestions.values());
        return Promise.resolve({ data: list, count: list.length, error: null });
      },
      insert(rows) {
        const row = { ...rows[0] };
        questionWrites.push(row);
        for (const key of Object.keys(row)) {
          if (!VALID_QUESTION_COLUMNS.has(key)) {
            return {
              select: () => ({
                single: async () => ({ data: null, error: { message: `Could not find the '${key}' column of 'questions' in the schema cache` } }),
                maybeSingle: async () => ({ data: null, error: { message: `Could not find the '${key}' column of 'questions' in the schema cache` } }),
              }),
            };
          }
        }
        const saved = { id: row.id || 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ...row };
        dbQuestions.set(saved.id, saved);
        return {
          select: () => ({
            single: async () => ({ data: saved, error: null }),
            maybeSingle: async () => ({ data: saved, error: null }),
          }),
        };
      },
      update(patch) {
        questionWrites.push(patch);
        for (const key of Object.keys(patch)) {
          if (!VALID_QUESTION_COLUMNS.has(key)) {
            const err = { message: `Could not find the '${key}' column of 'questions' in the schema cache` };
            return {
              eq: () => ({ select: () => ({ single: async () => ({ data: null, error: err }), maybeSingle: async () => ({ data: null, error: err }) }), then: (r) => Promise.resolve({ data: null, error: err }).then(r) }),
              in: async () => ({ data: null, error: err }),
            };
          }
        }
        const applyPatch = (targetId) => {
          const existing = dbQuestions.get(targetId);
          if (!existing) return null;
          const updated = { ...existing, ...patch };
          dbQuestions.set(targetId, updated);
          return updated;
        };
        return {
          eq: (_, targetId) => {
            const updated = applyPatch(targetId);
            return {
              select: () => ({
                single: async () => ({ data: updated, error: updated ? null : { message: 'Not found' } }),
                maybeSingle: async () => ({ data: updated, error: null }),
              }),
              then: (r) => Promise.resolve({ data: updated, error: null }).then(r),
            };
          },
          in: async (_, ids) => {
            ids.forEach(applyPatch);
            return { data: [], error: null };
          },
        };
      },
      delete() {
        return {
          eq: async (_, targetId) => {
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(targetId))) {
              throw new Error(`invalid input syntax for type uuid: "${targetId}"`);
            }
            dbQuestions.delete(targetId);
            return { error: null };
          },
          in: async (_, ids) => {
            for (const id of ids) {
              if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) {
                throw new Error(`invalid input syntax for type uuid: "${id}"`);
              }
              dbQuestions.delete(id);
            }
            return { error: null };
          },
        };
      },
      maybeSingle: async () => {
        const match = eqId ? dbQuestions.get(eqId) || null : null;
        return { data: match, error: null };
      },
      single: async () => {
        const match = eqId ? dbQuestions.get(eqId) || null : null;
        return { data: match, error: match ? null : { message: 'JSON object requested, multiple (or no) rows returned' } };
      },
      then(resolve) {
        if (inIds) {
          return Promise.resolve({
            data: inIds.map((id) =>
              dbQuestions.get(id) || {
                id,
                syllabus_id: null,
                year: 2026,
                series: 'Mock',
                paper_number: 1,
                question_number: '1',
                question_text: 'Sample DB question',
                question_style: 'Multiple Choice',
                topic: 'Stoichiometry',
                difficulty: 'Medium',
                marks: 1,
                options: ['A', 'B', 'C', 'D'],
                mark_scheme: { answer: 'A' },
              }
            ),
            error: null,
          }).then(resolve);
        }
        const all = Array.from(dbQuestions.values()).filter((q) => !eqSyllabusId || q.syllabus_id === eqSyllabusId);
        return Promise.resolve({ data: all, count: all.length, error: null }).then(resolve);
      },
    };
    return builder;
  }

  if (table === 'quiz_submissions') {
    const subBuilder = {
      select() {
        return subBuilder;
      },
      order() {
        return subBuilder;
      },
      range(from, to) {
        return Promise.resolve({ data: dbSubmissions.slice(from, to + 1), error: null });
      },
      delete() {
        // Strict PostgrestFilterBuilder simulation: thenable ONLY, NO .catch() method
        return {
          eq: (_, id) => ({
            then: (resolve) => {
              const idx = dbSubmissions.findIndex((s) => s.id === id);
              if (idx >= 0) dbSubmissions.splice(idx, 1);
              return Promise.resolve({ error: null }).then(resolve);
            },
          }),
        };
      },
      upsert: async () => ({ error: null }),
    };
    return subBuilder;
  }

  if (table === 'syllabuses') {
    let filterEqSyl = null;
    const sylBuilder = {
      select() {
        return sylBuilder;
      },
      eq(col, val) {
        filterEqSyl = { col, val };
        return sylBuilder;
      },
      limit() {
        return Promise.resolve({ data: [...dbSyllabuses], error: null });
      },
      order: async () => ({ data: [...dbSyllabuses], error: null }),
      maybeSingle: async () => {
        const match = dbSyllabuses.find((s) => !filterEqSyl || s[filterEqSyl.col] === filterEqSyl.val) || null;
        return { data: match, error: null };
      },
      then: (resolve) => Promise.resolve({ data: [...dbSyllabuses], error: null }).then(resolve),
      insert(row) {
        if (!row.subject_code || row.subject_code.length > 20) {
          throw new Error('subject_code violates NOT NULL / VARCHAR(20)');
        }
        const created = {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          subject_name: row.subject_name,
          subject_code: row.subject_code,
          created_at: new Date().toISOString(),
        };
        dbSyllabuses.push(created);
        return {
          select() {
            return {
              single: async () => ({ data: created, error: null }),
            };
          },
        };
      },
    };
    return sylBuilder;
  }

  return {
    select: async () => ({ data: [], error: null }),
  };
};

supabase.rpc = async (fn) => {
  if (fn === 'get_public_roster_directory') {
    return { data: [], error: null };
  }
  return { data: null, error: { message: 'unknown rpc' } };
};

Object.defineProperty(supabase, 'functions', {
  configurable: true,
  value: {
    invoke: async () => {
      edgeInvokeCount++;
      return { data: null, error: null };
    },
  },
});

// 3. Test saveCustomTest with 'ICM Exam' subject & mixed UUID + local-custom ID
const q1 = {
  id: VALID_UUID_1,
  syllabus_id: '',
  year: 2026,
  series: 'ICM',
  paper_number: 1,
  question_number: '1',
  question_text: 'What is the formula of water?',
  question_style: 'Multiple Choice',
  topic: 'Chemistry',
  difficulty: 'Easy',
  marks: 1,
  options: ['H2O', 'CO2', 'O2', 'H2'],
  mark_scheme: { answer: 'H2O' },
};
const q2 = {
  id: CUSTOM_Q_ID,
  syllabus_id: '',
  year: 2026,
  series: 'ICM',
  paper_number: 1,
  question_number: '2',
  question_text: 'Custom ICM question text',
  question_style: 'Multiple Choice',
  topic: 'ICM Topic',
  difficulty: 'Medium',
  marks: 2,
  options: ['Yes', 'No'],
  mark_scheme: { answer: 'Yes' },
};

const savedIcmTest = await saveCustomTest({
  title: 'ICM Midterm Exam',
  totalMarks: 3,
  questionIds: [VALID_UUID_1, CUSTOM_Q_ID],
  headerConfig: {
    title: 'ICM Midterm Exam',
    schoolName: 'Insan Cendekia Madani',
    subject: 'ICM Exam',
    subjectCode: 'ICM-01',
    durationMinutes: 45,
    instructions: 'Answer all questions.',
    isUserCustomized: true,
    questionOverrides: {
      [VALID_UUID_1]: q1,
      [CUSTOM_Q_ID]: q2,
    },
  },
});

check('5. saveCustomTest sends NO non-existent header_config column & ONLY UUIDs to custom_tests',
  customTestInserts.length === 1 &&
  !('header_config' in customTestInserts[0]) &&
  JSON.stringify(customTestInserts[0].question_ids) === JSON.stringify([VALID_UUID_1])
);

check('6. app_config stores custom_test_header with subject "ICM Exam" & full _savedQuestionIds',
  dbAppConfig.has(`custom_test_header_${savedIcmTest.id}`) &&
  JSON.parse(dbAppConfig.get(`custom_test_header_${savedIcmTest.id}`)).subject === 'ICM Exam' &&
  JSON.parse(dbAppConfig.get(`custom_test_header_${savedIcmTest.id}`))._savedQuestionIds?.length === 2
);

// 4. Simulate fresh device (empty localStorage & empty cache) loading Saved Tests
globalThis.localStorage.clear();
clearCustomTestsCache();
questionQueries.length = 0;

const crossDeviceTests = await fetchCustomTestsWithMetadata();
const restoredIcmTest = crossDeviceTests.find((t) => t.id === savedIcmTest.id);
check('7. Fresh device recovers "ICM Exam" subject & full mixed question_ids from Supabase + app_config',
  Boolean(restoredIcmTest) &&
  restoredIcmTest.primarySubject === 'ICM Exam' &&
  restoredIcmTest.question_ids.length === 2 &&
  restoredIcmTest.question_ids[1] === CUSTOM_Q_ID
);

check('8. fetchCustomTestsWithMetadata never queries questions table with non-UUID IDs',
  questionQueries.every((batch) => batch.every((id) => !id.startsWith('local-custom-')))
);

// 5. fetchCustomTestWithQuestions uses overrides first and never hits questions table with non-UUIDs
globalThis.localStorage.clear();
questionQueries.length = 0;
const loadedForBuilder = await fetchCustomTestWithQuestions(savedIcmTest.id);
check('9. fetchCustomTestWithQuestions resolves both questions from overrides with 0 questions-table queries',
  loadedForBuilder?.questions.length === 2 &&
  loadedForBuilder.questions[1].id === CUSTOM_Q_ID &&
  questionQueries.length === 0
);

// 6. fetchAndApplyOverrides fast-path + UUID guard
questionQueries.length = 0;
const overrideOnlyQs = await fetchAndApplyOverrides([CUSTOM_Q_ID, VALID_UUID_1], {
  [CUSTOM_Q_ID]: q2,
  [VALID_UUID_1]: q1,
});
check('10. fetchAndApplyOverrides returns overridden questions with 0 DB round-trips',
  overrideOnlyQs.length === 2 && questionQueries.length === 0
);

const missingCustomOnlyQs = await fetchAndApplyOverrides([CUSTOM_Q_ID], {});
check('11. fetchAndApplyOverrides skips questions table when IDs are non-UUID',
  missingCustomOnlyQs.length === 0 && questionQueries.length === 0
);

// 7. Publish ICM Exam & resolve concurrently on fresh student device via fast quiz_by_code lookup
await savePublishedQuiz({
  id: 'quiz_icm_test_1',
  testId: savedIcmTest.id,
  title: 'ICM Midterm Exam',
  quizCode: 'ICMEXM-99',
  subject: 'ICM Exam',
  totalMarks: 3,
  questionCount: 2,
  questionIds: [VALID_UUID_1, CUSTOM_Q_ID],
  headerConfig: savedIcmTest.header_config,
  durationMinutes: 45,
  isExamMode: true,
  securityEnabled: true,
  requireTeacherUnlock: true,
  teacherPin: '1234',
  maxViolations: 3,
  showInstantSolutions: false,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

globalThis.localStorage.clear();
clearQuizMemoryCache();
appConfigQueries.length = 0;
questionQueries.length = 0;

// Simulate StudentQuizDispatcher + StudentQuizRunner calling resolveStudentQuiz concurrently
const [res1, res2] = await Promise.all([
  resolveStudentQuiz('ICMEXM-99'),
  resolveStudentQuiz('ICMEXM-99'),
]);

check('12. Concurrent resolveStudentQuiz deduplicates calls & resolves ICM Exam cleanly',
  Boolean(res1 && res2 && res1 === res2) &&
  res1.headerConfig?.subject === 'ICM Exam' &&
  res1.questions.length === 2 &&
  questionQueries.length === 0
);

check('13. Fresh student code lookup uses fast quiz_by_code_<CODE> without downloading full published_quizzes array',
  appConfigQueries.includes('quiz_by_code_ICMEXM-99') &&
  !appConfigQueries.includes('published_quizzes')
);

// 8. Empty school roster RPC should NOT invoke Edge Function cold start
const roster = await fetchPublicRosterDirectory();
check('14. Empty roster RPC does not trigger unnecessary verify-student-pin Edge Function invocation',
  Array.isArray(roster) && roster.length === 0 && edgeInvokeCount === 0
);

// 9. createOrGetSyllabus supports creating & reusing a custom subject ('ICM Exam') for Question Bank
clearQuestionBankCache();
const createdSyl = await createOrGetSyllabus('ICM Exam');
const reusedSyl = await createOrGetSyllabus('icm exam');
check('15. createOrGetSyllabus("ICM Exam") creates & deduplicates custom syllabus within VARCHAR(20) limit',
  createdSyl.subject_name === 'ICM Exam' &&
  createdSyl.subject_code === 'ICM-EXAM' &&
  reusedSyl.id === createdSyl.id
);

// 10. createQuestion & updateQuestion avoid non-migrated columns while persisting in mark_scheme JSONB
questionWrites.length = 0;
const createdQ = await createQuestion({
  syllabus_id: createdSyl.id,
  question_number: '1',
  question_text: 'Sample Cambridge Hub question',
  topic: 'Acids & Bases',
  marks: 2,
  cambridge_hub_url: 'https://schoolsupporthub.cambridge.org/qp-sample',
  cambridge_ms_hub_url: 'https://schoolsupporthub.cambridge.org/ms-sample',
  insert_pdf_url: 'https://example.com/insert.pdf',
  ai_diagram_prompt: 'draw beaker',
});
check('16. createQuestion never sends non-migrated columns yet hydrates them from mark_scheme JSONB',
  Boolean(createdQ) &&
  questionWrites.length === 1 &&
  !('cambridge_hub_url' in questionWrites[0]) &&
  !('cambridge_ms_hub_url' in questionWrites[0]) &&
  !('insert_pdf_url' in questionWrites[0]) &&
  createdQ.cambridge_hub_url === 'https://schoolsupporthub.cambridge.org/qp-sample' &&
  createdQ.cambridge_ms_hub_url === 'https://schoolsupporthub.cambridge.org/ms-sample' &&
  createdQ.insert_pdf_url === 'https://example.com/insert.pdf'
);

questionWrites.length = 0;
const updatedQ = await updateQuestion(createdQ.id, {
  topic: 'Titration',
  cambridge_hub_url: 'https://schoolsupporthub.cambridge.org/qp-v2',
});
check('17. updateQuestion strips non-migrated columns and rejects non-UUID IDs cleanly',
  Boolean(updatedQ) &&
  questionWrites.length === 1 &&
  !('cambridge_hub_url' in questionWrites[0]) &&
  updatedQ.cambridge_hub_url === 'https://schoolsupporthub.cambridge.org/qp-v2' &&
  (await updateQuestion(CUSTOM_Q_ID, { topic: 'Nope' })) === null &&
  (await fetchQuestionById(CUSTOM_Q_ID)) === null &&
  (await deleteQuestion(CUSTOM_Q_ID)) === false &&
  (await deleteQuestions([CUSTOM_Q_ID])).deletedCount === 0
);

// 11. Cambridge Hub batch attach/detach never sends SQL column updates
questionWrites.length = 0;
await batchAttachCambridgeHubUrl(
  { syllabusId: createdSyl.id, year: new Date().getFullYear(), series: 'Variant', paperNumber: '1' },
  'https://schoolsupporthub.cambridge.org/qp-batch'
);
await batchAttachCambridgeMsHubUrl(
  { syllabusId: createdSyl.id, year: new Date().getFullYear(), series: 'Variant', paperNumber: '1' },
  'https://schoolsupporthub.cambridge.org/ms-batch'
);
await batchDetachCambridgeHubUrl({ syllabusId: createdSyl.id, year: new Date().getFullYear(), series: 'Variant', paperNumber: '1' });
await batchDetachCambridgeMsHubUrl({ syllabusId: createdSyl.id, year: new Date().getFullYear(), series: 'Variant', paperNumber: '1' });
check('18. Cambridge Hub batch attach/detach never issues failing SQL column updates',
  questionWrites.every((w) => !('cambridge_hub_url' in w) && !('cambridge_ms_hub_url' in w))
);

// 12. fetchQuestions sanitizes non-UUID bookmarked/tagged IDs & quotes reserved Chemistry chars in .or()
globalThis.localStorage.setItem('fluffykitten_bookmarked_questions', JSON.stringify([CUSTOM_Q_ID, createdQ.id]));
questionQueries.length = 0;
questionOrFilters.length = 0;
await fetchQuestions({ bookmarkedOnly: true, searchQuery: 'Ca(OH)2, (aq)' });
check('19. fetchQuestions filters non-UUID bookmarks & quotes parens/commas in PostgREST .or() search',
  questionQueries.length >= 1 &&
  questionQueries.every((ids) => ids.includes(createdQ.id) && ids.every((id) => id !== CUSTOM_Q_ID)) &&
  questionOrFilters.some((expr) => expr.includes('question_text.ilike."%Ca(OH)2, (aq)%"'))
);

// 13. Unpublished custom-subject test resolves cross-device via Step 5 suffix-matched header lookup
globalThis.localStorage.clear();
clearQuizMemoryCache();
dbAppConfig.delete('quiz_by_code_ICMEXM-99');
dbAppConfig.delete('published_quizzes');
const derivedIcmCode = generateQuizCode(savedIcmTest); // e.g. ICME-AAAA
const step5Resolved = await resolveStudentQuiz(derivedIcmCode);
check('20. Step 5 custom_tests fallback resolves custom-subject generated code via cloud header suffix match',
  Boolean(step5Resolved) &&
  step5Resolved.testId === savedIcmTest.id &&
  step5Resolved.headerConfig?.subject === 'ICM Exam'
);

// 14. quizSubmissionService pagination (>1000 rows) + safe PostgrestFilterBuilder cleanup
dbSubmissions.length = 0;
for (let i = 0; i < 1250; i++) {
  dbSubmissions.push({
    id: `sub_${i}`,
    quiz_id: 'quiz_1',
    quiz_code: 'TEST-1',
    quiz_title: 'Scale Test',
    subject: 'ICM Exam',
    student_name: `Student ${i}`,
    student_class: '10A',
    candidate_number: String(i + 1),
    submitted_at: new Date().toISOString(),
    duration_seconds: 120,
    score: 10,
    total_marks: 10,
    percentage: 100,
    violations_count: 0,
    proctoring_logs: [],
    raw_answers: {},
    question_results: [],
    topic_breakdown: {},
    status: 'submitted',
    teacher_adjusted_marks: 0,
    teacher_notes: '',
    result_pin: '1234',
  });
}
const allSubs = await fetchAllSubmissionsFromSupabase();
const syncedSubs = await loadAndSyncAllSubmissions();
check('21. fetchAllSubmissionsFromSupabase paginates beyond 1000 rows & sync avoids PostgrestFilterBuilder .catch crash',
  allSubs.length === 1250 && syncedSubs.length === 1250
);

// 15. Static source hygiene guards against dead endpoints / unsafe .single() / PostgREST .catch()
const pdfProcSrc = fs.readFileSync(path.resolve('src/lib/pdfProcessor.ts'), 'utf8');
const pinGateSrc = fs.readFileSync(path.resolve('src/components/PinGate.tsx'), 'utf8');
check('22. pdfProcessor omits non-existent insert_resources table & non-migrated columns; PinGate uses .maybeSingle()',
  !pdfProcSrc.includes("from('insert_resources')") &&
  !/\bcambridge_hub_url:\s*effectiveHubUrl\b/.test(pdfProcSrc) &&
  !/\.eq\(['"]key['"],\s*['"]access_pin['"]\)\s*\.single\(\)/.test(pinGateSrc) &&
  pinGateSrc.includes('.maybeSingle()')
);

console.log(`\n🎉 All ${passed} custom subject & diagnostic tests passed successfully!`);
