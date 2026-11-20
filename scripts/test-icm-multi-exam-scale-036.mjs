import fs from 'node:fs';
import path from 'node:path';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.sessionStorage = {
  getItem: (k) => (mem.has(`sess:${k}`) ? mem.get(`sess:${k}`) : null),
  setItem: (k, v) => mem.set(`sess:${k}`, String(v)),
  removeItem: (k) => mem.delete(`sess:${k}`),
  clear: () => {},
};
globalThis.window = {
  localStorage: globalThis.localStorage,
  sessionStorage: globalThis.sessionStorage,
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};
globalThis.document = {
  documentElement: {
    style: { setProperty: () => {} },
    setAttribute: () => {},
    classList: { add: () => {}, remove: () => {} },
    dataset: {},
  },
};

const { supabase } = await import('../src/lib/supabase.ts');
const {
  loadAndSyncSchoolClasses,
  loadAndSyncCreativeModeLandingVisibility,
  loadAndSyncSecurityTiers,
} = await import('../src/lib/settings.ts');
const { fetchExamDraft } = await import('../src/services/examDraftService.ts');
const {
  mergeSubmissionsPreferNewest,
  loadAndSyncAllSubmissions,
  fetchProctorMonitoredSubmissions,
  saveBatchQuizSubmissionsCloud,
  deleteSubmission,
} = await import('../src/services/quizSubmissionService.ts');
const { loadAndSyncPublishedQuizzes } = await import('../src/services/quizManagerService.ts');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS: ${label}`);
    passed++;
  } else {
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const origRpc = supabase.rpc.bind(supabase);
const origFrom = supabase.from.bind(supabase);

// ── Test 1: App.tsx Student Boot Diet & In-Flight Settings Deduplication ─────
const appSrc = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');
check(
  'MES-1a: App.tsx gates initAutoBackupPeriodicScheduler and all 7 teacher settings cloud syncs behind appMode === teacher',
  /if\s*\(\s*appMode\s*!==\s*'teacher'\s*\)\s*return;[\s\S]{0,400}initAutoBackupPeriodicScheduler\(\)[\s\S]{0,400}loadAndSyncSecurityTiers\(\)/.test(
    appSrc
  )
);

let appConfigSelectCount = 0;
supabase.from = (table) => {
  if (table === 'app_config') {
    return {
      select() {
        return this;
      },
      eq() {
        return this;
      },
      async maybeSingle() {
        appConfigSelectCount++;
        await new Promise((r) => setTimeout(r, 15));
        return { data: { value: JSON.stringify(['X IPA 1', 'X IPA 2']) }, error: null };
      },
    };
  }
  return origFrom(table);
};

await Promise.all([
  loadAndSyncSchoolClasses(),
  loadAndSyncSchoolClasses(),
  loadAndSyncSchoolClasses(),
  loadAndSyncCreativeModeLandingVisibility(),
  loadAndSyncCreativeModeLandingVisibility(),
  loadAndSyncSecurityTiers(),
  loadAndSyncSecurityTiers(),
]);

check(
  'MES-1b: Concurrent same-tab calls to loadAndSyncSchoolClasses/CreativeMode/SecurityTiers deduplicate into 1 query per key',
  appConfigSelectCount === 3,
  `appConfigSelectCount=${appConfigSelectCount}`
);

// ── Test 2: Single Lobby Draft Check With alternateQuizId ────────────────────
let draftRpcCalls = 0;
supabase.rpc = async (fn) => {
  if (fn === 'get_student_exam_draft') {
    draftRpcCalls++;
    return {
      data: JSON.stringify({
        quizCode: 'ICM-1',
        quizId: 'pilot-sim-part2-12q',
        studentName: 'Amando',
        candidateClass: 'X IPA 1',
        answers: { 0: 'A' },
        currentIndex: 1,
        timeLeftSeconds: 1500,
        startTime: Date.now() - 60000,
        lastSavedAt: new Date().toISOString(),
        status: 'in_progress',
      }),
      error: null,
    };
  }
  return { data: null, error: null };
};

mem.clear();
const recoveredWithAltId = await fetchExamDraft('ICM-1', 'quiz_1795115628773_nx2vu', 'amando__6428', {
  studentPin: '6428',
  expectedStudentName: 'Amando',
  expectedStudentClass: 'X IPA 1',
  alternateQuizId: 'pilot-sim-part2-12q',
});
const runnerSrc = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');

check(
  'MES-2a: fetchExamDraft accepts alternateQuizId in a single RPC call and StudentQuizRunner no longer double-queries get_student_exam_draft',
  draftRpcCalls === 1 &&
    recoveredWithAltId?.answers?.[0] === 'A' &&
    runnerSrc.includes('alternateQuizId:') &&
    !/if\s*\(\s*!draft\s*&&\s*resolvedTestId\s*&&\s*resolvedTestId\s*!==\s*finalId\s*\)/.test(runnerSrc),
  `draftRpcCalls=${draftRpcCalls}`
);

// ── Test 3: Teacher Submission & Live Proctor Diet ───────────────────────────
const cloud10 = Array.from({ length: 10 }, (_, i) => ({
  id: `sub_cloud_${i}`,
  quizId: 'quiz-hist-old',
  quizCode: 'HIST-OLD',
  quizTitle: 'Historical Exam',
  subject: 'Simulation',
  studentName: `Student ${i}`,
  studentClass: 'X IPA 1',
  submittedAt: '2026-11-20T01:00:00.000Z',
  updatedAt: '2026-11-20T01:00:00.000Z',
  durationSeconds: 300,
  score: 10,
  totalMarks: 30,
  percentage: 33,
  violationsCount: 0,
  proctoringLogs: [],
  rawAnswers: { 0: 'A' },
  questionResults: [],
  topicBreakdown: {},
  status: 'submitted',
}));
const localNew1 = {
  ...cloud10[0],
  id: 'sub_local_only_1',
  studentName: 'Local Exclusive Student',
};

const mergeRes = mergeSubmissionsPreferNewest(cloud10, [cloud10[0], localNew1], new Set());
check(
  'MES-3a: mergeSubmissionsPreferNewest isolates only genuinely new/newer local rows instead of flagging the entire cloud list',
  mergeRes.hasLocalNewerOrExclusive === true &&
    mergeRes.localNewerOrExclusiveRows.length === 1 &&
    mergeRes.localNewerOrExclusiveRows[0].id === 'sub_local_only_1' &&
    mergeRes.merged.length === 11
);

let upsertedSubmissionBatchSizes = [];
let appConfigQuizSubmissionsTouched = false;
let proctorInCodesQueried = null;

supabase.from = (table) => {
  if (table === 'app_config') {
    return {
      select() {
        return this;
      },
      eq(_col, val) {
        if (val === 'quiz_submissions') appConfigQuizSubmissionsTouched = true;
        return this;
      },
      async maybeSingle() {
        return { data: null, error: null };
      },
      async upsert(row) {
        if (row?.key === 'quiz_submissions') appConfigQuizSubmissionsTouched = true;
        return { error: null };
      },
    };
  }
  if (table === 'quiz_submissions') {
    const q = {
      select() {
        return q;
      },
      in(_col, codes) {
        proctorInCodesQueried = codes;
        return q;
      },
      order() {
        return q;
      },
      async limit() {
        return {
          data: [
            {
              id: 'sub_icm_1',
              quiz_id: 'quiz-icm-1',
              quiz_code: 'ICM-1',
              student_name: 'Amando',
              student_class: 'X IPA 1',
              submitted_at: '2026-11-20T01:05:00.000Z',
              violations_count: 1,
              raw_answers: { 0: 'B', _forensics: { proctorStudentId: 'stu-amando' } },
              status: 'submitted',
            },
          ],
          error: null,
        };
      },
      async range(from) {
        if (from > 0) return { data: [], error: null };
        return {
          data: cloud10.map((s) => ({
            id: s.id,
            quiz_id: s.quizId,
            quiz_code: s.quizCode,
            student_name: s.studentName,
            student_class: s.studentClass,
            submitted_at: s.submittedAt,
            updated_at: s.updatedAt,
            raw_answers: s.rawAnswers,
            status: s.status,
          })),
          error: null,
        };
      },
      async upsert(rows) {
        upsertedSubmissionBatchSizes.push(Array.isArray(rows) ? rows.length : 1);
        return { error: null };
      },
      delete() {
        return {
          eq: async () => ({ error: null }),
          or: async () => ({ error: null }),
        };
      },
    };
    return q;
  }
  return origFrom(table);
};

// Seed localStorage with 1 exclusive local row while cloud has 10 rows
mem.clear();
localStorage.setItem('fluffykitten_quiz_submissions', JSON.stringify([localNew1]));
await loadAndSyncAllSubmissions();
await saveBatchQuizSubmissionsCloud([localNew1]);
await deleteSubmission('sub_local_only_1');

mem.clear();
const proctorSubs = await fetchProctorMonitoredSubmissions([
  { id: 'q1', quizCode: 'ICM-1' },
  { id: 'q2', quizCode: 'ICM-2' },
]);
const liveInvigSrc = fs.readFileSync(path.resolve('src/components/LiveInvigilatorModal.tsx'), 'utf8');

check(
  'MES-3b: loadAndSyncAllSubmissions upserts only the 1 local-exclusive row (not all 11), never touches app_config[quiz_submissions], and LiveInvigilatorModal uses scoped fetchProctorMonitoredSubmissions',
  upsertedSubmissionBatchSizes[0] === 1 &&
    appConfigQuizSubmissionsTouched === false &&
    Array.isArray(proctorInCodesQueried) &&
    proctorInCodesQueried.includes('ICM-1') &&
    proctorInCodesQueried.includes('ICM-2') &&
    proctorSubs.length === 1 &&
    proctorSubs[0].forensics?.proctorStudentId === 'stu-amando' &&
    liveInvigSrc.includes('fetchProctorMonitoredSubmissions(monitoredQuizzes)') &&
    !liveInvigSrc.includes('loadAndSyncAllSubmissions()'),
  JSON.stringify({ upsertedSubmissionBatchSizes, appConfigQuizSubmissionsTouched, proctorInCodesQueried, proctorSubsLen: proctorSubs.length })
);

// ── Test 4: loadAndSyncPublishedQuizzes No-Write on Fresh Browser ────────────
let publishedQuizzesWritesOnLoad = 0;
supabase.from = (table) => {
  if (table === 'app_config') {
    const q = {
      select() {
        return q;
      },
      eq(_col, val) {
        q._eqVal = val;
        return q;
      },
      async maybeSingle() {
        if (q._eqVal === 'published_quizzes') {
          return {
            data: {
              value: JSON.stringify([
                {
                  id: 'pub-icm-1',
                  testId: 'pilot-sim-part2-12q',
                  quizCode: 'ICM-1',
                  title: 'ICM 1',
                  isActive: true,
                  headerConfig: { title: 'ICM 1' },
                },
                {
                  id: 'pub-icm-2',
                  testId: 'pilot-sim-part2-12q',
                  quizCode: 'ICM-2',
                  title: 'ICM 2',
                  isActive: true,
                  headerConfig: { title: 'ICM 2' },
                },
              ]),
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
      async in() {
        return {
          data: [{ key: 'custom_test_header_pilot-sim-part2-12q' }],
          error: null,
        };
      },
      async upsert(row) {
        if (row?.key === 'published_quizzes') publishedQuizzesWritesOnLoad++;
        return { error: null };
      },
    };
    return q;
  }
  return origFrom(table);
};

// Fresh teacher browser: localStorage has 0 user quizzes (only auto-seeded ICM170), cloud has 2 slim quizzes
mem.clear();
const loadedQuizzes = await loadAndSyncPublishedQuizzes();
check(
  'MES-4a: loadAndSyncPublishedQuizzes on a fresh browser with fewer local quizzes than cloud does NOT overwrite published_quizzes',
  loadedQuizzes.length >= 2 && publishedQuizzesWritesOnLoad === 0,
  `loadedQuizzes=${loadedQuizzes.length}, writes=${publishedQuizzesWritesOnLoad}`
);

supabase.rpc = origRpc;
supabase.from = origFrom;

// ── Test 5: Migration 036 SQL Contract & pg_safeupdate Checks ────────────────
const mig036 = fs.readFileSync(
  path.resolve('supabase/migrations/036_icm_multi_exam_scale_and_roster_cache.sql'),
  'utf8'
);
const stripComments = (sql) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
const clean036 = stripComments(mig036);

check(
  'MES-5a: Migration 036 drops redundant idx_quiz_submissions_attempt_class_lookup and optimizes clear_rate_limit with IF EXISTS PK check and no OR locked_until scan',
  /DROP INDEX IF EXISTS public\.idx_quiz_submissions_attempt_class_lookup;/i.test(clean036) &&
    /CREATE OR REPLACE FUNCTION public\.clear_rate_limit[\s\S]*?IF EXISTS \(\s*SELECT 1\s*FROM public\.security_rate_limits\s*WHERE scope_key = p_scope_key\s*\)/i.test(
      clean036
    ) &&
    !/DELETE FROM public\.security_rate_limits[\s\S]{0,160}OR\s*\(locked_until/i.test(clean036)
);

check(
  'MES-5b: Migration 036 creates RLS-locked school_roster_entries & school_roster_meta, trigger sync, and upgrades get_public_roster_directory, verify_student_pin, and verify_roster_pin_if_enrolled',
  /CREATE TABLE IF NOT EXISTS public\.school_roster_entries/i.test(clean036) &&
    /CREATE TABLE IF NOT EXISTS public\.school_roster_meta/i.test(clean036) &&
    /ALTER TABLE public\.school_roster_entries ENABLE ROW LEVEL SECURITY;/i.test(clean036) &&
    /REVOKE ALL ON TABLE public\.school_roster_entries FROM PUBLIC, anon, authenticated;/i.test(clean036) &&
    clean036.includes('idx_school_roster_entries_norm_lookup') &&
    clean036.includes('trg_sync_school_roster_cache_iu') &&
    clean036.includes('trg_sync_school_roster_cache_d') &&
    /CREATE OR REPLACE FUNCTION public\.get_public_roster_directory[\s\S]*?FROM public\.school_roster_meta/i.test(
      clean036
    ) &&
    /CREATE OR REPLACE FUNCTION public\.verify_student_pin[\s\S]*?FROM public\.school_roster_entries/i.test(
      clean036
    ) &&
    /CREATE OR REPLACE FUNCTION public\.verify_roster_pin_if_enrolled[\s\S]*?FROM public\.school_roster_entries/i.test(
      clean036
    )
);

check(
  'MES-5c: Migration 036 selectively invalidates exam_paper_cache on published_quizzes diff, returns non-active papers before pg_advisory_xact_lock, and contains zero bare DELETE statements (pg_safeupdate)',
  clean036.includes('JOIN jsonb_array_elements(v_new_arr) n') &&
    clean036.indexOf("IF v_schedule_status <> 'active' THEN") <
      clean036.indexOf("PERFORM pg_advisory_xact_lock(hashtext('exam_paper_cache:' || v_code));") &&
    !/DELETE\s+FROM\s+public\.[a-z0-9_]+\s*;/i.test(clean036)
);

check(
  'MES-5d: Migration 036 bundles publicRosterDirectory & lobby settings into get_student_exam_paper and adds cache-accelerated submit_student_exam_attempt with inline draft/lock cleanup',
  clean036.includes("'publicRosterDirectory', public.get_public_roster_directory()") &&
    clean036.includes("'schoolClasses', v_school_classes") &&
    /CREATE OR REPLACE FUNCTION public\.submit_student_exam_attempt[\s\S]*?FROM public\.exam_paper_cache c/i.test(
      clean036
    ) &&
    /DELETE FROM public\.app_config WHERE key = v_draft_key;[\s\S]*?DELETE FROM public\.exam_draft_locks WHERE draft_key = v_draft_key;/i.test(
      clean036
    )
);

console.log(`\nMulti-exam scale & roster cache (036) tests: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
