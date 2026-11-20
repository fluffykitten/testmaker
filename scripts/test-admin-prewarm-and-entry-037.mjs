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
  loadAndSyncCreativeModeLandingVisibility,
  saveCreativeModeLandingVisibility,
} = await import('../src/lib/settings.ts');
const {
  findLocalExamDraft,
  enterStudentExamSession,
  buildStudentDraftIdentifier,
  getDraftKey,
} = await import('../src/services/examDraftService.ts');
const { prewarmExamPaperCache } = await import('../src/services/quizManagerService.ts');
const { saveQuizSubmissionWithVerification } = await import('../src/services/quizSubmissionService.ts');

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

// ── 1. Creative Mode Landing Visibility 10-Minute Boot Cache ────────────────
let landingQueryCount = 0;
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
        landingQueryCount++;
        return { data: { value: JSON.stringify(true) }, error: null };
      },
      async upsert() {
        return { error: null };
      },
    };
  }
  return origFrom(table);
};

mem.clear();
const firstBootVal = await loadAndSyncCreativeModeLandingVisibility();
const secondBootVal = await loadAndSyncCreativeModeLandingVisibility();
const thirdBootVal = await loadAndSyncCreativeModeLandingVisibility();
check(
  '037-1a: loadAndSyncCreativeModeLandingVisibility queries cloud once then caches across reloads for 10 min',
  firstBootVal === true && secondBootVal === true && thirdBootVal === true && landingQueryCount === 1,
  `landingQueryCount=${landingQueryCount}`
);

saveCreativeModeLandingVisibility(false);
const afterAdminToggle = await loadAndSyncCreativeModeLandingVisibility();
check(
  '037-1b: saveCreativeModeLandingVisibility refreshes TTL timestamp cleanly without extra read',
  afterAdminToggle === false && landingQueryCount === 1,
  `afterAdminToggle=${afterAdminToggle}, landingQueryCount=${landingQueryCount}`
);

// ── 2. prewarmExamPaperCache Deduplication & Guard Handling ─────────────────
let lastPrewarmArgs = null;
supabase.rpc = async (fn, args) => {
  if (fn === 'prewarm_exam_paper_cache') {
    lastPrewarmArgs = args;
    return {
      data: {
        warmedCodes: ['ICM-1', 'ICM-2'],
        skippedCodes: ['ICM-3'],
        missingCodes: [],
        warmedCount: 2,
        ttlMinutes: 90,
        cachedAt: '2026-11-20T01:00:00Z',
      },
      error: null,
    };
  }
  return { data: null, error: null };
};

const warmRes = await prewarmExamPaperCache([' icm-1 ', 'ICM-2', 'ICM-1', '']);
check(
  '037-2a: prewarmExamPaperCache deduplicates/normalizes codes and parses warm result',
  warmRes.ok &&
    warmRes.warmedCount === 2 &&
    warmRes.ttlMinutes === 90 &&
    JSON.stringify(lastPrewarmArgs?.p_quiz_codes) === JSON.stringify(['ICM-1', 'ICM-2']),
  JSON.stringify({ warmRes, lastPrewarmArgs })
);

supabase.rpc = async () => ({
  data: null,
  error: { code: '42501', message: 'Educator authentication required' },
});
const blockedWarmRes = await prewarmExamPaperCache(['ICM-1']);
check(
  '037-2b: prewarmExamPaperCache surfaces auth error cleanly when unauthenticated',
  !blockedWarmRes.ok && /Educator authentication/i.test(blockedWarmRes.error || ''),
  JSON.stringify(blockedWarmRes)
);

// ── 3. findLocalExamDraft (0-RPC Lobby Detection) ───────────────────────────
mem.clear();
const ident = buildStudentDraftIdentifier('Nadia Putri', '4821', 'X IPA 1');
const dKey = getDraftKey('ICM-1', ident);
localStorage.setItem(
  `fluffykitten_exam_draft_${dKey}`,
  JSON.stringify({
    quizCode: 'ICM-1',
    quizId: 'test-uuid-1',
    studentName: 'Nadia Putri',
    candidateClass: 'X IPA 1',
    answers: { 0: 'B' },
    currentIndex: 1,
    timeLeftSeconds: 1800,
    startTime: Date.now() - 60_000,
    lastSavedAt: new Date().toISOString(),
    status: 'in_progress',
  })
);
const localMatch = findLocalExamDraft('ICM-1', 'test-uuid-1', ident, {
  expectedStudentName: 'Nadia Putri',
  expectedStudentClass: 'X IPA 1',
});
const localWrongClass = findLocalExamDraft('ICM-1', 'test-uuid-1', ident, {
  expectedStudentName: 'Nadia Putri',
  expectedStudentClass: 'X IPA 2',
});
check(
  '037-3a: findLocalExamDraft recovers matching class draft synchronously and rejects class mismatch',
  localMatch?.answers?.[0] === 'B' && localWrongClass === null
);

// ── 4. enterStudentExamSession Unified Entry Client Wiring ──────────────────
mem.clear();
supabase.rpc = async (fn, args) => {
  if (fn === 'enter_student_exam_session') {
    check(
      '037-4a: enterStudentExamSession transmits normalized code, identity, PIN, and draft lock credentials',
      args?.p_payload?.quiz_code === 'ICM-4' &&
        args?.p_payload?.student_pin === '7391' &&
        String(args?.p_payload?.draft_key || '').startsWith('draft_ICM-4_') &&
        Boolean(args?.p_payload?.draft_owner_token),
      JSON.stringify(args)
    );
    return {
      data: {
        status: 'draft_found',
        valid: true,
        submitted: false,
        student: { id: 'stu-1', name: 'Bima', class: 'XI IPA 2', candidateNumber: '014' },
        draftJson: JSON.stringify({
          quizCode: 'ICM-4',
          quizId: 'quiz-4',
          studentName: 'Bima',
          candidateClass: 'XI IPA 2',
          answers: { 0: 'C', 1: 'A' },
          currentIndex: 2,
          timeLeftSeconds: 1200,
          startTime: Date.now() - 120_000,
          lastSavedAt: new Date().toISOString(),
          status: 'in_progress',
        }),
      },
      error: null,
    };
  }
  return { data: null, error: null };
};

const entryDraft = await enterStudentExamSession({
  quizCode: ' icm-4 ',
  quizId: 'quiz-4',
  studentName: 'Bima',
  studentClass: 'XI IPA 2',
  studentPin: '7391',
  requireStudentPin: true,
  limitOneAttempt: true,
});
check(
  '037-4b: enterStudentExamSession parses cloud draft recovery & candidate metadata atomically',
  entryDraft.status === 'draft_found' &&
    entryDraft.valid === true &&
    entryDraft.student?.candidateNumber === '014' &&
    entryDraft.draft?.answers?.[1] === 'A',
  JSON.stringify(entryDraft)
);

supabase.rpc = async () => ({
  data: null,
  error: { code: 'PGRST202', message: 'Could not find the function enter_student_exam_session' },
});
const entryFallback = await enterStudentExamSession({
  quizCode: 'ICM-4',
  quizId: 'quiz-4',
  studentName: 'Bima',
  studentClass: 'XI IPA 2',
  requireStudentPin: true,
  limitOneAttempt: true,
});
check(
  '037-4c: enterStudentExamSession returns rpc_unavailable on PGRST202 so client falls back gracefully',
  entryFallback.status === 'rpc_unavailable'
);

// ── 5. Submission Fast-Abort Guard With 4-Attempt Default ───────────────────
mem.clear();
let submitAttempts = 0;
supabase.rpc = async (fn) => {
  if (fn === 'submit_student_exam_attempt') {
    submitAttempts++;
    return {
      data: null,
      error: { code: '42501', message: 'Active exam session belongs to another device.' },
    };
  }
  return { data: null, error: null };
};
const subRes = await saveQuizSubmissionWithVerification({
  id: 'sub_037_test',
  quizId: 'q1',
  quizCode: 'ICM-1',
  quizTitle: 'Test',
  subject: 'Chemistry',
  studentName: 'Bima',
  studentClass: 'XI IPA 2',
  submittedAt: new Date().toISOString(),
  durationSeconds: 300,
  score: 0,
  totalMarks: 10,
  percentage: 0,
  violationsCount: 0,
  proctoringLogs: [],
  rawAnswers: {},
  questionResults: [],
  topicBreakdown: {},
  status: 'submitted',
});
check(
  '037-5a: saveQuizSubmissionWithVerification defaults to 4 retries for transient issues but aborts on 42501 immediately',
  !subRes.success && submitAttempts === 1,
  `submitAttempts=${submitAttempts}`
);

// ── 6. Migration 037 & UI/Service Source Verification ───────────────────────
const sql037 = fs.readFileSync(
  path.resolve('supabase/migrations/037_admin_prewarm_and_unified_exam_entry.sql'),
  'utf8'
);
check(
  '037-6a: Migration 037 extends exam_paper_cache TTL to 90 minutes and keeps schedule bounds & private helper revoke',
  sql037.includes("INTERVAL '90 minutes'") &&
    sql037.includes('REVOKE ALL ON FUNCTION public._compile_and_cache_exam_paper(TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;') &&
    /IF v_cache_row\.scheduled_start_at IS NOT NULL AND v_now < v_cache_row\.scheduled_start_at THEN[\s\S]{0,400}'scheduleStatus', 'scheduled'[\s\S]{0,200}'questions', '\[\]'::jsonb/i.test(
      sql037
    )
);
check(
  '037-6b: Migration 037 gates prewarm_exam_paper_cache with is_authenticated_teacher() (42501) and uses WHERE on DELETEs',
  sql037.includes('public.is_authenticated_teacher()') &&
    sql037.includes("USING ERRCODE = '42501'") &&
    !/DELETE\s+FROM\s+public\.[a-z_]+\s*;/i.test(sql037)
);
check(
  '037-6c: Migration 037 enter_student_exam_session resolves server quiz flags & verifies lock before returning draftJson',
  /v_require_student_pin := COALESCE\(\(v_quiz->>'requireStudentPin'\)::boolean/.test(sql037) &&
    sql037.includes('v_lock_found := FOUND;') &&
    sql037.includes('public.verify_student_pin(') &&
    sql037.includes('public.check_student_attempt_submitted(')
);

const qmServiceSrc = fs.readFileSync(path.resolve('src/services/quizManagerService.ts'), 'utf8');
check(
  '037-6d: toggleQuizActiveStatus writes quiz_by_code sequentially before published_quizzes (no Promise.all write storm)',
  /await upsertQuizCodeIndexToCloud\(slimTarget\);[\s\S]{0,400}await syncPublishedQuizzesToCloud\(cloudList\);/.test(
    qmServiceSrc
  )
);

const runnerSrc = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');
check(
  '037-6e: StudentQuizRunner uses findLocalExamDraft in lobby, enterStudentExamSession on start, and widened jitter windows',
  runnerSrc.includes('findLocalExamDraft(') &&
    runnerSrc.includes('enterStudentExamSession(') &&
    runnerSrc.includes('Math.random() * 6000') &&
    runnerSrc.includes('Math.random() * 7000') &&
    runnerSrc.includes('Math.random() * 15000')
);

const qmPageSrc = fs.readFileSync(path.resolve('src/pages/QuizManagerPage.tsx'), 'utf8');
check(
  '037-6f: QuizManagerPage exposes Pre-Warm Cache control and triggers non-blocking warm after save/open',
  qmPageSrc.includes('handlePrewarmExamCache') &&
    qmPageSrc.includes('Pre-Warm Cache') &&
    qmPageSrc.includes('prewarmExamPaperCache([updated.quizCode])')
);

supabase.rpc = origRpc;
supabase.from = origFrom;

console.log(`\nAdmin Pre-Warm & Unified Exam Entry (037) tests: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
