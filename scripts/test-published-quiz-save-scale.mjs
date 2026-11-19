const rawStore = new Map();
let simulateQuotaExceeded = false;

globalThis.localStorage = {
  getItem: (k) => rawStore.get(k) ?? null,
  setItem: (k, v) => {
    if (simulateQuotaExceeded) {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    }
    rawStore.set(k, String(v));
  },
  removeItem: (k) => rawStore.delete(k),
  clear: () => rawStore.clear(),
};

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { supabase, isSupabaseConfigured } from '../src/lib/supabase.ts';
import {
  savePublishedQuiz,
  deletePublishedQuiz,
  toggleQuizActiveStatus,
  getLastQuizCloudSyncStatus,
  getDeletedQuizIds,
} from '../src/services/quizManagerService.ts';
import { resolveStudentQuiz, clearQuizMemoryCache } from '../src/services/quizCodeService.ts';

let passed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`);
    passed++;
  } else {
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    process.exit(1);
  }
}

if (process.argv.includes('--child-rpc-new-tab')) {
  // Simulates a new non-teacher browser tab (shared localStorage has slimmed quiz + saved test, sessionStorage empty)
  rawStore.set(
    'fluffykitten_published_quizzes',
    JSON.stringify([
      {
        id: 'pub-icm-10',
        testId: '11111111-1111-4111-8111-111111111110',
        quizCode: 'ICM-10',
        title: 'ICM 10 UUID Exam',
        subject: 'Chemistry',
        totalMarks: 2,
        questionCount: 1,
        questionIds: ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1'],
        durationMinutes: 30,
        isExamMode: true,
        securityEnabled: true,
        requireTeacherUnlock: true,
        teacherPin: '1234',
        maxViolations: 3,
        showInstantSolutions: false,
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        headerConfig: {
          title: 'ICM 10 UUID Exam',
          subject: 'Chemistry',
          durationMinutes: 30,
        },
      },
      {
        id: 'pub-icm-10-local',
        testId: 'pilot-sim-part2-12q',
        quizCode: 'ICM-10-LOCAL',
        title: 'ICM 10 Local Fallback Exam',
        subject: 'Cambridge Multi-Discipline Simulation',
        totalMarks: 30,
        questionCount: 12,
        questionIds: [],
        durationMinutes: 30,
        isExamMode: true,
        securityEnabled: true,
        requireTeacherUnlock: true,
        teacherPin: '1234',
        maxViolations: 3,
        showInstantSolutions: false,
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        headerConfig: {
          title: 'ICM 10 Local Fallback Exam',
          subject: 'Cambridge Multi-Discipline Simulation',
          durationMinutes: 30,
        },
      },
    ])
  );

  let rpcCalledForIcm10 = false;
  supabase.rpc = async (fn, params) => {
    if (fn === 'get_student_exam_paper' && params?.p_code === 'ICM-10') {
      rpcCalledForIcm10 = true;
      return {
        data: {
          publishedQuiz: {
            id: 'pub-icm-10',
            testId: '11111111-1111-4111-8111-111111111110',
            quizCode: 'ICM-10',
            title: 'ICM 10 UUID Exam',
            isActive: true,
            isExamMode: true,
            totalMarks: 2,
            durationMinutes: 30,
          },
          questions: [
            {
              id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
              question_number: '1',
              question_style: 'Multiple Choice',
              question_text: 'Sample UUID bank question',
              options: ['A', 'B', 'C', 'D'],
              marks: 2,
              mark_scheme: null,
            },
          ],
          scheduleStatus: 'active',
          serverNow: new Date().toISOString(),
        },
        error: null,
      };
    }
    if (fn === 'get_student_exam_paper' && params?.p_code === 'ICM-10-LOCAL') {
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };

  supabase.from = () => ({
    select() {
      return this;
    },
    in: async () => ({ data: [], error: null }),
    eq() {
      return this;
    },
    maybeSingle: async () => ({ data: null, error: null }),
  });

  clearQuizMemoryCache();
  const resRpc = await resolveStudentQuiz('ICM-10');
  check(
    '8a. New non-teacher tab calls get_student_exam_paper RPC even when slimmed ICM-10 is in localStorage',
    Boolean(
      isSupabaseConfigured() &&
        rpcCalledForIcm10 &&
        resRpc &&
        resRpc.questions.length === 1 &&
        resRpc.teacherPinHash === ''
    )
  );

  const resLocalFallback = await resolveStudentQuiz('ICM-10-LOCAL');
  check(
    '8b. New non-teacher tab falls back to localStorage saved test overrides if RPC returns null',
    Boolean(
      resLocalFallback &&
        resLocalFallback.questions.length === 12 &&
        resLocalFallback.totalMarks === 30 &&
        resLocalFallback.teacherPinHash === ''
    )
  );
  process.exit(0);
}

console.log('Testing Published Quiz Save Scale, Quota Resilience & Timeout Safety...\n');

const dbAppConfig = new Map();
let simulatePublishedListReadError = false;
let simulateCodeIndexReadError = false;
let simulateAsyncLatencyMs = 0;

const maybeYield = async () => {
  if (simulateAsyncLatencyMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, simulateAsyncLatencyMs));
  }
};

supabase.from = (table) => {
  if (table !== 'app_config') {
    throw new Error(`Unexpected table query in test: ${table}`);
  }

  let selectedCols = '*';
  let eqCol = null;
  let eqVal = null;

  const builder = {
    select(cols) {
      selectedCols = cols || '*';
      return builder;
    },
    eq(col, val) {
      eqCol = col;
      eqVal = val;
      return builder;
    },
    async like(col, pattern) {
      await maybeYield();
      if (col === 'key' && String(pattern).startsWith('quiz_by_code_') && simulateCodeIndexReadError) {
        return { data: null, error: { message: 'Timeout' } };
      }
      const prefix = String(pattern).replace(/%+$/, '');
      const rows = [];
      for (const [k, v] of dbAppConfig.entries()) {
        if (k.startsWith(prefix)) {
          rows.push(selectedCols.trim() === 'key' ? { key: k } : { key: k, value: v });
        }
      }
      return { data: rows, error: null };
    },
    async maybeSingle() {
      await maybeYield();
      if (eqCol === 'key' && eqVal === 'published_quizzes' && simulatePublishedListReadError) {
        return { data: null, error: { message: 'Timeout' } };
      }
      if (eqCol === 'key' && String(eqVal).startsWith('quiz_by_code_') && simulateCodeIndexReadError) {
        return { data: null, error: { message: 'Timeout' } };
      }
      if (eqCol === 'key' && dbAppConfig.has(eqVal)) {
        const val = dbAppConfig.get(eqVal);
        return {
          data: selectedCols.includes('key') ? { key: eqVal, value: val } : { value: val },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    async in(col, vals) {
      await maybeYield();
      if (col !== 'key') return { data: [], error: null };
      if (
        simulateCodeIndexReadError &&
        vals.some((v) => String(v).startsWith('quiz_by_code_'))
      ) {
        return { data: null, error: { message: 'Timeout' } };
      }
      const rows = [];
      for (const k of vals) {
        if (dbAppConfig.has(k)) {
          rows.push(
            selectedCols.trim() === 'key'
              ? { key: k }
              : { key: k, value: dbAppConfig.get(k) }
          );
        }
      }
      return { data: rows, error: null };
    },
    async upsert(rowOrRows) {
      await maybeYield();
      const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
      for (const r of rows) {
        if (r?.key !== undefined && r?.value !== undefined) {
          dbAppConfig.set(r.key, r.value);
        }
      }
      return { data: rowOrRows, error: null };
    },
    delete() {
      return {
        eq: async (_col, val) => {
          await maybeYield();
          dbAppConfig.delete(val);
          return { error: null };
        },
        in: async (_col, vals) => {
          await maybeYield();
          for (const v of vals) {
            dbAppConfig.delete(v);
          }
          return { error: null };
        },
      };
    },
  };

  return builder;
};

function makeHeavyOverrides(tag, sizeBytes = 50 * 1024) {
  const filler = `<svg>${'M0,0 '.repeat(Math.ceil(sizeBytes / 5))}</svg>`;
  return {
    [`q-${tag}-1`]: {
      id: `q-${tag}-1`,
      question_number: '1',
      topic: 'Physics',
      question_style: 'Multiple Choice',
      question_text: `Heavy question for ${tag}`,
      svg_content: filler,
      options: ['A: 1', 'B: 2', 'C: 3', 'D: 4'],
      marks: 2,
      mark_scheme: { acceptable_answers: ['A'], marking_points: ['Point A'] },
    },
  };
}

function makePublishedQuiz({ id, testId, quizCode, title, overrides, extra = {} }) {
  return {
    id,
    testId,
    quizCode,
    title,
    subject: 'Physics',
    totalMarks: 2,
    questionCount: 1,
    questionIds: Object.keys(overrides),
    durationMinutes: 30,
    isExamMode: true,
    securityEnabled: true,
    requireTeacherUnlock: true,
    teacherPin: '1234',
    maxViolations: 3,
    showInstantSolutions: false,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    headerConfig: {
      title,
      schoolName: 'Insan Cendekia Madani',
      subject: 'Physics',
      subjectCode: '0625',
      durationMinutes: 30,
      instructions: 'Answer all questions.',
      questionOverrides: overrides,
    },
    ...extra,
  };
}

// ─── Case 1: 5 Consecutive Heavy Published Exams ─────────────────────────────
const PREEXISTING_TEST_ID = '11111111-1111-4111-8111-111111111111';
const v2Header = {
  title: 'Pre-existing Test v2',
  subject: 'Physics',
  durationMinutes: 45,
  _savedQuestionIds: ['q-v2-only'],
  _savedTotalMarks: 5,
  _updatedAt: '2026-11-20T00:00:00.000Z',
  questionOverrides: {
    'q-v2-only': {
      id: 'q-v2-only',
      question_number: '1',
      topic: 'Optics',
      question_style: 'Multiple Choice',
      question_text: 'AUTHORITATIVE V2 QUESTION',
      options: ['A', 'B'],
      marks: 5,
      mark_scheme: { acceptable_answers: ['B'] },
    },
  },
};
dbAppConfig.set(`custom_test_header_${PREEXISTING_TEST_ID}`, JSON.stringify(v2Header));

const exams5 = [
  makePublishedQuiz({
    id: 'pub-scale-1',
    testId: 'pilot-auto-seeded-sim-part2',
    quizCode: 'SCALE-01',
    title: 'Auto-Seeded Sim Exam',
    overrides: makeHeavyOverrides('s1'),
  }),
  makePublishedQuiz({
    id: 'pub-scale-2',
    testId: PREEXISTING_TEST_ID,
    quizCode: 'SCALE-02',
    title: 'Stale Publish Over v2 Saved Test',
    overrides: makeHeavyOverrides('stale-v1'),
  }),
  makePublishedQuiz({
    id: 'pub-scale-3',
    testId: '33333333-3333-4333-8333-333333333333',
    quizCode: 'SCALE-03',
    title: 'Heavy Exam 3',
    overrides: makeHeavyOverrides('s3'),
  }),
  makePublishedQuiz({
    id: 'pub-scale-4',
    testId: '44444444-4444-4444-8444-444444444444',
    quizCode: 'SCALE-04',
    title: 'Heavy Exam 4',
    overrides: makeHeavyOverrides('s4'),
  }),
  makePublishedQuiz({
    id: 'pub-scale-5',
    testId: '55555555-5555-4555-8555-555555555555',
    quizCode: 'SCALE-05',
    title: 'Heavy Exam 5',
    overrides: makeHeavyOverrides('s5'),
  }),
];

for (const exam of exams5) {
  await savePublishedQuiz(exam);
}

const rawPubListAfter5 = dbAppConfig.get('published_quizzes') || '';
const pubListAfter5 = JSON.parse(rawPubListAfter5);
const hasAll5 = exams5.every((e) => pubListAfter5.some((q) => q.id === e.id && q.quizCode === e.quizCode));
const zeroOverridesInList = exams5.every((e) => {
  const row = pubListAfter5.find((q) => q.id === e.id);
  return row && !('questionOverrides' in (row.headerConfig || {}));
});
const zeroOverridesInCodeIndex = exams5.every((e) => {
  const raw = dbAppConfig.get(`quiz_by_code_${e.quizCode}`);
  const parsed = raw ? JSON.parse(raw) : null;
  return parsed && !('questionOverrides' in (parsed.headerConfig || {}));
});

check(
  '1a. 5 heavy exams saved sequentially all exist in published_quizzes with compact payload (<15 KB)',
  hasAll5 && zeroOverridesInList && rawPubListAfter5.length < 15000,
  `len=${rawPubListAfter5.length}, hasAll5=${hasAll5}, zeroOverridesInList=${zeroOverridesInList}`
);

check(
  '1b. All 5 quiz_by_code_<CODE> index entries omit questionOverrides',
  zeroOverridesInCodeIndex
);

const autoSeededHdrRaw = dbAppConfig.get('custom_test_header_pilot-auto-seeded-sim-part2');
const autoSeededHdr = autoSeededHdrRaw ? JSON.parse(autoSeededHdrRaw) : null;
check(
  '1c. Missing custom_test_header_<testId> was backfilled with overrides & _savedQuestionIds',
  Boolean(
    autoSeededHdr &&
      autoSeededHdr.questionOverrides?.['q-s1-1'] &&
      Array.isArray(autoSeededHdr._savedQuestionIds) &&
      autoSeededHdr._savedQuestionIds[0] === 'q-s1-1'
  )
);

const preexistingHdrAfter = JSON.parse(dbAppConfig.get(`custom_test_header_${PREEXISTING_TEST_ID}`) || '{}');
check(
  '1d. Existing custom_test_header_<testId> (v2) was NOT overwritten by stale publish overrides',
  preexistingHdrAfter.questionOverrides?.['q-v2-only']?.question_text === 'AUTHORITATIVE V2 QUESTION' &&
    !preexistingHdrAfter.questionOverrides?.['q-stale-v1-1']
);

// ─── Case 2: Legacy Bloat Cleanup ────────────────────────────────────────────
const LEGACY_BACKED_TEST_ID = '66666666-6666-4666-8666-666666666666';
const LEGACY_UNBACKED_TEST_ID = 'legacy-unbacked-test';
dbAppConfig.set(
  `custom_test_header_${LEGACY_BACKED_TEST_ID}`,
  JSON.stringify({
    title: 'Legacy Backed Cloud v2',
    questionOverrides: {
      'q-cloud-auth': {
        id: 'q-cloud-auth',
        question_number: '1',
        question_text: 'KEEP ME',
        marks: 4,
      },
    },
  })
);

const legacyBloated1 = makePublishedQuiz({
  id: 'pub-legacy-1',
  testId: LEGACY_BACKED_TEST_ID,
  quizCode: 'LEGACY-01',
  title: 'Legacy Backed Quiz',
  overrides: makeHeavyOverrides('leg1'),
});
const legacyBloated2 = makePublishedQuiz({
  id: 'pub-legacy-2',
  testId: LEGACY_UNBACKED_TEST_ID,
  quizCode: 'LEGACY-02',
  title: 'Legacy Unbacked Quiz',
  overrides: makeHeavyOverrides('leg2'),
});
dbAppConfig.set('published_quizzes', JSON.stringify([...pubListAfter5, legacyBloated1, legacyBloated2]));

await savePublishedQuiz(
  makePublishedQuiz({
    id: 'pub-trigger-clean',
    testId: '77777777-7777-4777-8777-777777777777',
    quizCode: 'CLEAN-01',
    title: 'Cleanup Trigger',
    overrides: makeHeavyOverrides('clean'),
  })
);

const postCleanupList = JSON.parse(dbAppConfig.get('published_quizzes') || '[]');
const leg1Row = postCleanupList.find((q) => q.id === 'pub-legacy-1');
const leg2Row = postCleanupList.find((q) => q.id === 'pub-legacy-2');
const leg2Backfilled = JSON.parse(dbAppConfig.get(`custom_test_header_${LEGACY_UNBACKED_TEST_ID}`) || '{}');
const leg1CloudCheck = JSON.parse(dbAppConfig.get(`custom_test_header_${LEGACY_BACKED_TEST_ID}`) || '{}');

check(
  '2. Saving strips legacy bloated overrides from older cloud quizzes & backfills missing unbacked headers',
  Boolean(
    leg1Row &&
      !('questionOverrides' in (leg1Row.headerConfig || {})) &&
      leg2Row &&
      !('questionOverrides' in (leg2Row.headerConfig || {})) &&
      leg2Backfilled.questionOverrides?.['q-leg2-1'] &&
      leg1CloudCheck.questionOverrides?.['q-cloud-auth']?.question_text === 'KEEP ME'
  )
);

// ─── Case 3: localStorage QuotaExceededError Resilience ──────────────────────
simulateQuotaExceeded = true;
const quotaExam = makePublishedQuiz({
  id: 'pub-quota-resilient',
  testId: '88888888-8888-4888-8888-888888888888',
  quizCode: 'QUOTA-01',
  title: 'Quota Resilient Exam',
  overrides: makeHeavyOverrides('quota'),
});
await savePublishedQuiz(quotaExam);
simulateQuotaExceeded = false;

const quotaSyncStatus = getLastQuizCloudSyncStatus();
const cloudAfterQuota = JSON.parse(dbAppConfig.get('published_quizzes') || '[]');
check(
  '3. localStorage QuotaExceededError never aborts Supabase cloud sync',
  Boolean(
    quotaSyncStatus?.listSynced === true &&
      quotaSyncStatus?.codeIndexSynced === true &&
      cloudAfterQuota.some((q) => q.id === 'pub-quota-resilient') &&
      dbAppConfig.has('quiz_by_code_QUOTA-01')
  )
);

// ─── Case 4: Timeout / Read-Error Safety (No Cloud Wipe!) ───────────────────
const seedA = makePublishedQuiz({
  id: 'pub-timeout-a',
  testId: '99999999-9999-4999-8999-999999999991',
  quizCode: 'TOUT-A',
  title: 'Timeout Seed A',
  overrides: makeHeavyOverrides('ta', 1024),
});
const seedB = makePublishedQuiz({
  id: 'pub-timeout-b',
  testId: '99999999-9999-4999-8999-999999999992',
  quizCode: 'TOUT-B',
  title: 'Timeout Seed B',
  overrides: makeHeavyOverrides('tb', 1024),
});
await savePublishedQuiz(seedA);
await savePublishedQuiz(seedB);
const snapshotBeforeTimeout = dbAppConfig.get('published_quizzes');
const countBeforeTimeout = JSON.parse(snapshotBeforeTimeout).length;

simulatePublishedListReadError = true;
simulateCodeIndexReadError = true;

// 4a. savePublishedQuiz during read timeout must NOT overwrite published_quizzes, while updating quiz_by_code_
const newDuringTimeout = makePublishedQuiz({
  id: 'pub-timeout-c',
  testId: '99999999-9999-4999-8999-999999999993',
  quizCode: 'TOUT-C',
  title: 'Saved During Timeout',
  overrides: makeHeavyOverrides('tc', 1024),
});
await savePublishedQuiz(newDuringTimeout);
const statusDuringTimeout = getLastQuizCloudSyncStatus();
check(
  '4a. savePublishedQuiz on full read timeout preserves published_quizzes & syncs quiz_by_code_TOUT-C',
  statusDuringTimeout?.listSynced === false &&
    statusDuringTimeout?.codeIndexSynced === true &&
    dbAppConfig.has('quiz_by_code_TOUT-C') &&
    dbAppConfig.get('published_quizzes') === snapshotBeforeTimeout
);

// 4b. deletePublishedQuiz during read timeout deletes quiz_by_code_ & records tombstone without wiping published_quizzes
await deletePublishedQuiz('pub-timeout-a');
check(
  '4b. deletePublishedQuiz on full read timeout deletes quiz_by_code_TOUT-A without wiping published_quizzes',
  getDeletedQuizIds().has('pub-timeout-a') &&
    !dbAppConfig.has('quiz_by_code_TOUT-A') &&
    dbAppConfig.get('published_quizzes') === snapshotBeforeTimeout &&
    JSON.parse(dbAppConfig.get('published_quizzes')).length === countBeforeTimeout
);

// 4c. toggleQuizActiveStatus during read timeout updates quiz_by_code_TOUT-B without wiping published_quizzes
const toggledB = await toggleQuizActiveStatus('pub-timeout-b');
const codeBAfterToggle = JSON.parse(dbAppConfig.get('quiz_by_code_TOUT-B') || '{}');
check(
  '4c. toggleQuizActiveStatus on full read timeout updates quiz_by_code_TOUT-B without wiping published_quizzes',
  toggledB?.isActive === false &&
    codeBAfterToggle.isActive === false &&
    dbAppConfig.get('published_quizzes') === snapshotBeforeTimeout
);

simulatePublishedListReadError = false;
simulateCodeIndexReadError = false;

// ─── Case 5: Concurrent Rapid savePublishedQuiz Serialization ────────────────
rawStore.clear();
dbAppConfig.clear();
simulateAsyncLatencyMs = 15;

const concurrentExams = [1, 2, 3, 4, 5].map((n) =>
  makePublishedQuiz({
    id: `pub-conc-${n}`,
    testId: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`,
    quizCode: `CONC-0${n}`,
    title: `Concurrent Exam ${n}`,
    overrides: makeHeavyOverrides(`c${n}`, 4096),
  })
);

await Promise.all(concurrentExams.map((exam) => savePublishedQuiz(exam)));
simulateAsyncLatencyMs = 0;

const cloudAfterConcurrent = JSON.parse(dbAppConfig.get('published_quizzes') || '[]');
const allConcurrentSaved = concurrentExams.every((e) =>
  cloudAfterConcurrent.some((q) => q.id === e.id && q.quizCode === e.quizCode)
);
const allConcurrentCodeIndexed = concurrentExams.every((e) =>
  dbAppConfig.has(`quiz_by_code_${e.quizCode}`)
);

check(
  '5. 5 concurrent savePublishedQuiz calls serialize cleanly with zero lost exams',
  allConcurrentSaved && allConcurrentCodeIndexed,
  `savedCount=${cloudAfterConcurrent.length}, allConcurrentSaved=${allConcurrentSaved}`
);

// ─── Case 6: Self-Healing Recovery from Bloated/Unreadable published_quizzes ─
rawStore.clear();
dbAppConfig.clear();

const seededRecoveryExams = [
  makePublishedQuiz({
    id: 'pub-rec-1',
    testId: 'rec-test-1-unbacked',
    quizCode: 'REC-01',
    title: 'Recovery Bloated Unbacked 1',
    overrides: makeHeavyOverrides('rec1'),
  }),
  makePublishedQuiz({
    id: 'pub-rec-2',
    testId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002',
    quizCode: 'REC-02',
    title: 'Recovery Quiz 2',
    overrides: makeHeavyOverrides('rec2', 2048),
  }),
  makePublishedQuiz({
    id: 'pub-rec-3',
    testId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003',
    quizCode: 'REC-03',
    title: 'Recovery Quiz 3',
    overrides: makeHeavyOverrides('rec3', 2048),
  }),
];

for (const ex of seededRecoveryExams) {
  dbAppConfig.set(`quiz_by_code_${ex.quizCode}`, JSON.stringify(ex));
}
// Mark tests 2 & 3 as already backed; test 1 intentionally has NO custom_test_header_ yet
dbAppConfig.set('custom_test_header_bbbbbbbb-bbbb-4bbb-8bbb-000000000002', JSON.stringify({ title: 'Rec 2' }));
dbAppConfig.set('custom_test_header_bbbbbbbb-bbbb-4bbb-8bbb-000000000003', JSON.stringify({ title: 'Rec 3' }));

// Simulate legacy bloated published_quizzes timing out on read while per-code index succeeds
simulatePublishedListReadError = true;
simulateCodeIndexReadError = false;

const icm1Quiz = makePublishedQuiz({
  id: 'pub-icm-1',
  testId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000004',
  quizCode: 'ICM-1',
  title: 'ICM Exam 1',
  overrides: makeHeavyOverrides('icm1', 4096),
});

await savePublishedQuiz(icm1Quiz);
simulatePublishedListReadError = false;

const recoverySyncStatus = getLastQuizCloudSyncStatus();
const healedRaw = dbAppConfig.get('published_quizzes') || '';
const healedList = healedRaw ? JSON.parse(healedRaw) : [];
const all4Healed = [...seededRecoveryExams, icm1Quiz].every((e) =>
  healedList.some((q) => q.id === e.id && q.quizCode === e.quizCode)
);
const healedHasNoOverrides = healedList.every((q) => !('questionOverrides' in (q.headerConfig || {})));
const rec1HeaderBackfilled = JSON.parse(dbAppConfig.get('custom_test_header_rec-test-1-unbacked') || '{}');

check(
  '6. Bloated/unreadable published_quizzes recovers from quiz_by_code_*, backfills headers, and heals slim list',
  Boolean(
    recoverySyncStatus?.listSynced === true &&
      recoverySyncStatus?.codeIndexSynced === true &&
      recoverySyncStatus?.stage === 'done' &&
      all4Healed &&
      healedHasNoOverrides &&
      healedRaw.length < 15000 &&
      rec1HeaderBackfilled.questionOverrides?.['q-rec1-1']
  ),
  `listSynced=${recoverySyncStatus?.listSynced}, len=${healedRaw.length}, count=${healedList.length}`
);

// ─── Case 7: pg_safeupdate Regression Check on Cache Invalidation Triggers ────
const stripSqlLineComments = (sql) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

const mig032Sql = fs.readFileSync(
  path.resolve('supabase/migrations/032_exam_paper_cache_and_fast_lobby.sql'),
  'utf8'
);
const mig035Sql = fs.readFileSync(
  path.resolve('supabase/migrations/035_fix_exam_paper_cache_safeupdate.sql'),
  'utf8'
);

const bareDeleteRegex = /DELETE\s+FROM\s+public\.exam_paper_cache\s*;/i;
check(
  '7. Migrations 032 & 035 contain NO bare DELETE FROM public.exam_paper_cache without WHERE clause (pg_safeupdate)',
  !bareDeleteRegex.test(stripSqlLineComments(mig032Sql)) &&
    !bareDeleteRegex.test(stripSqlLineComments(mig035Sql)) &&
    mig035Sql.includes('invalidate_exam_paper_cache_on_config') &&
    mig035Sql.includes('invalidate_exam_paper_cache_all') &&
    mig035Sql.includes('WHERE quiz_code IS NOT NULL')
);

// ─── Case 8: Same-Browser New Tab Resolution (Slimmed localStorage + Empty sessionStorage) ─
const childOutput = execFileSync(
  process.execPath,
  ['--import', './scripts/register-ts.mjs', 'scripts/test-published-quiz-save-scale.mjs', '--child-rpc-new-tab'],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      VITE_SUPABASE_URL: 'https://mock.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'mock-key',
    },
  }
);
for (const line of childOutput.trim().split(/\r?\n/)) {
  if (line.trim()) {
    console.log(line);
    if (line.startsWith('PASS  ')) passed++;
  }
}

console.log(`\nAll ${passed} checks passed!`);
