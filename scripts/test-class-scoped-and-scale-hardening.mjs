import fs from 'node:fs';
import path from 'node:path';

// Minimal DOM storage & window shims for Node ESM testing
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.window = {
  localStorage: globalThis.localStorage,
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

const {
  normalizeClassIdentityPart,
  isSameCandidateSession,
  shouldResetSessionForCandidate,
  computeCloudDraftFingerprint,
  isMissingRpcError,
} = await import('../src/lib/examSubmissionGuards.ts');
const {
  buildStudentDraftIdentifier,
  getDraftLockCredentials,
  saveExamDraft,
  fetchExamDraft,
  clearExamDraft,
  checkStudentAttemptSubmitted,
  resetDraftCloudBackoffForTests,
} = await import('../src/services/examDraftService.ts');
const {
  saveQuizSubmissionCloud,
  saveQuizSubmissionWithVerification,
  getLastCloudWriteError,
  saveDeviceReceipt,
  getDeviceReceipts,
} = await import('../src/services/quizSubmissionService.ts');
const { supabase } = await import('../src/lib/supabase.ts');

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

// ── Test 1: Class Normalization Parity ──────────────────────────────────────
check(
  'SC-1a: normalizeClassIdentityPart normalizes spacing, case, and Arabic/Roman numerals',
  normalizeClassIdentityPart('X IPA3') === 'x ipa 3' &&
    normalizeClassIdentityPart('  x   ipa   3 ') === 'x ipa 3' &&
    normalizeClassIdentityPart('10-IPA-03') === 'x ipa 3' &&
    normalizeClassIdentityPart('XI IPS2') === 'xi ips 2' &&
    normalizeClassIdentityPart('X IPA 1') !== normalizeClassIdentityPart('X IPA 2')
);

// ── Test 2: Class-Scoped Draft Identifier & Lock Credentials ────────────────
const pinIdent = buildStudentDraftIdentifier('Student Alpha', '6428');
const classIdent1 = buildStudentDraftIdentifier('Ahmad', undefined, 'X IPA 1');
const classIdent2 = buildStudentDraftIdentifier('Ahmad', '', 'X IPA 2');
const classIdent1Variant = buildStudentDraftIdentifier('  ahmad ', '', 'x ipa1');

const credClass1 = getDraftLockCredentials('BIO101', 'Ahmad', undefined, 'X IPA 1');
const credClass2 = getDraftLockCredentials('BIO101', 'Ahmad', '', 'X IPA 2');
const credClass1Variant = getDraftLockCredentials('BIO101', 'Ahmad', '', 'x ipa1');

check(
  'SC-2a: buildStudentDraftIdentifier preserves PIN format when PIN is given and isolates classes without PIN',
  pinIdent === 'student_alpha__6428' &&
    classIdent1 === 'ahmad__cls_x_ipa_1' &&
    classIdent2 === 'ahmad__cls_x_ipa_2' &&
    classIdent1 === classIdent1Variant &&
    credClass1.draftKey === 'draft_BIO101_ahmad__cls_x_ipa_1' &&
    credClass2.draftKey === 'draft_BIO101_ahmad__cls_x_ipa_2' &&
    credClass1.draftKey === credClass1Variant.draftKey &&
    credClass1.draftKey !== credClass2.draftKey &&
    credClass1.ownerToken !== credClass2.ownerToken,
  JSON.stringify({ pinIdent, classIdent1, classIdent2, credClass1, credClass2 })
);

// ── Test 3: Shared-Device Session Isolation & Class Receipts ────────────────
const savedIpa1 = { candidateName: 'Ahmad', candidateClass: 'X IPA 1', candidateNumber: '' };
check(
  'SC-3a: Same-name different-class resets shared-device session while same-class variant resumes',
  isSameCandidateSession(savedIpa1, { candidateName: 'Ahmad', candidateClass: 'X IPA 2' }) === false &&
    shouldResetSessionForCandidate(savedIpa1, { candidateName: 'Ahmad', candidateClass: 'X IPA 2' }) === true &&
    isSameCandidateSession(savedIpa1, { candidateName: 'Ahmad', candidateClass: 'x ipa1' }) === true &&
    shouldResetSessionForCandidate(savedIpa1, { candidateName: 'Ahmad', candidateClass: 'x ipa1' }) === false
);

// Verify device receipts stay isolated across same-name students in different classes
saveDeviceReceipt({
  quizCode: 'BIO101',
  quizTitle: 'Bio Mid',
  studentName: 'Ahmad',
  studentClass: 'X IPA 1',
  submittedAt: '2026-11-19T08:00:00.000Z',
});
saveDeviceReceipt({
  quizCode: 'BIO101',
  quizTitle: 'Bio Mid',
  studentName: 'Ahmad',
  studentClass: 'X IPA 2',
  submittedAt: '2026-11-19T08:05:00.000Z',
});
const storedReceipts = getDeviceReceipts().filter(
  (r) => r.quizCode === 'BIO101' && r.studentName === 'Ahmad'
);
check(
  'SC-3b: saveDeviceReceipt keeps separate offline receipts for homonyms in different classes',
  storedReceipts.length === 2,
  JSON.stringify(storedReceipts)
);

// Mock RPC offline fallback to ensure checkStudentAttemptSubmitted offline check respects studentClass
const origRpc = supabase.rpc.bind(supabase);
const origFrom = supabase.from.bind(supabase);

supabase.rpc = async () => ({ data: null, error: { code: '544', message: 'DatabaseTimeout' } });
let fromCalledDuring544Check = false;
supabase.from = () => {
  fromCalledDuring544Check = true;
  return { select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: null }) }) }) };
};

const ipa3Attempt = await checkStudentAttemptSubmitted('BIO101', 'Ahmad', 'X IPA 3');
const ipa2Attempt = await checkStudentAttemptSubmitted('BIO101', 'Ahmad', 'X IPA 2');
check(
  'SC-3c: checkStudentAttemptSubmitted skips table scan on 544 timeout and scopes offline receipt by class',
  fromCalledDuring544Check === false && ipa3Attempt.submitted === false && ipa2Attempt.submitted === true,
  JSON.stringify({ fromCalledDuring544Check, ipa3Attempt, ipa2Attempt })
);

// ── Test 4: Dirty-Check Cloud Draft Fingerprint ─────────────────────────────
const fpBase = computeCloudDraftFingerprint({
  answers: { 1: 'B', 0: 'A' },
  flaggedIndices: [3, 1],
  audioProgress: { q2: { playedCount: 1 } },
  violationsCount: 1,
  strikeCount: 1,
  isLockedByProctor: false,
  totalPenaltySeconds: 0,
});
const fpReorderedSameState = computeCloudDraftFingerprint({
  answers: { 0: 'A', 1: 'B' },
  flaggedIndices: [1, 3],
  audioProgress: { q2: { playedCount: 1 } },
  violationsCount: 1,
  strikeCount: 1,
  isLockedByProctor: false,
  totalPenaltySeconds: 0,
});
const fpChangedAnswer = computeCloudDraftFingerprint({
  answers: { 0: 'A', 1: 'C' },
  flaggedIndices: [1, 3],
  audioProgress: { q2: { playedCount: 1 } },
  violationsCount: 1,
  strikeCount: 1,
  isLockedByProctor: false,
  totalPenaltySeconds: 0,
});
check(
  'SC-4a: computeCloudDraftFingerprint is deterministic across key/flag ordering and detects real changes',
  fpBase === fpReorderedSameState && fpBase !== fpChangedAnswer
);

// ── Test 5: isMissingRpcError ───────────────────────────────────────────────
check(
  'SC-5a: isMissingRpcError returns true only for 42883/PGRST202 and false for 544/42501/timeouts',
  isMissingRpcError({ code: '42883', message: 'function save_student_exam_draft does not exist' }) === true &&
    isMissingRpcError({ code: 'PGRST202', message: 'Could not find the function' }) === true &&
    isMissingRpcError({ code: '544', message: 'DatabaseTimeout' }) === false &&
    isMissingRpcError({ code: '42501', message: 'Active exam session belongs to another device.' }) === false &&
    isMissingRpcError({ message: 'FetchError: request timeout' }) === false
);

// ── Test 6: Circuit Breaker & No RLS-Blocked Fallback on 544 ────────────────
resetDraftCloudBackoffForTests();
let draftRpcCount = 0;
let draftTableFallbackCount = 0;
supabase.rpc = async (fn) => {
  if (fn === 'save_student_exam_draft') {
    draftRpcCount++;
    return { data: null, error: { code: '544', message: 'DatabaseTimeout' } };
  }
  if (fn === 'delete_student_exam_draft') {
    return { data: null, error: { code: '544', message: 'DatabaseTimeout' } };
  }
  return { data: null, error: null };
};
supabase.from = () => {
  draftTableFallbackCount++;
  return {
    upsert: async () => ({ error: { code: '42501', message: 'RLS blocked' } }),
    delete: () => ({ eq: async () => ({ error: { code: '42501', message: 'RLS blocked' } }) }),
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '42501' } }) }) }),
  };
};

const draftPayload = {
  quizCode: 'BIO101',
  quizId: 'quiz-bio-101',
  studentName: 'Ahmad',
  candidateClass: 'X IPA 1',
  answers: { 0: 'A' },
  currentIndex: 0,
  timeLeftSeconds: 1800,
  startTime: Date.now(),
  lastSavedAt: new Date().toISOString(),
  status: 'in_progress',
};

const save544First = await saveExamDraft(draftPayload);
const save544SecondImmediate = await saveExamDraft({ ...draftPayload, answers: { 0: 'B' } });
const localAfterBackoff = await fetchExamDraft('BIO101', 'quiz-bio-101', classIdent1, {
  expectedStudentName: 'Ahmad',
  expectedStudentClass: 'X IPA 1',
});

check(
  'SC-6a: saveExamDraft does not fall back to app_config on 544 and engages circuit-breaker backoff while preserving localStorage',
  save544First === false &&
    save544SecondImmediate === false &&
    draftRpcCount === 1 &&
    draftTableFallbackCount === 0 &&
    localAfterBackoff?.answers?.[0] === 'B',
  JSON.stringify({ save544First, save544SecondImmediate, draftRpcCount, draftTableFallbackCount })
);

// Class mismatch guard on fetchExamDraft
const wrongClassLocalFetch = await fetchExamDraft('BIO101', 'quiz-bio-101', classIdent1, {
  expectedStudentName: 'Ahmad',
  expectedStudentClass: 'X IPA 2',
});
check(
  'SC-6b: fetchExamDraft blocks class mismatch recovery cleanly',
  wrongClassLocalFetch === null
);

// clearExamDraft must NOT fall back to RLS-blocked app_config.delete() on 544
await clearExamDraft('BIO101', 'quiz-bio-101', classIdent1);
check(
  'SC-6c: clearExamDraft does not fall back to app_config.delete on 544 timeout',
  draftTableFallbackCount === 0
);

// Verify saveQuizSubmissionCloud & saveQuizSubmissionWithVerification preserve error diagnostics and skip table fallback on 544
let submitRpcCalls = 0;
let submitTableFallbackCalls = 0;
supabase.rpc = async (fn) => {
  if (fn === 'submit_student_exam_attempt') {
    submitRpcCalls++;
    return {
      data: null,
      error: {
        code: '42501',
        message: 'Active exam session belongs to another device.',
      },
    };
  }
  return { data: null, error: null };
};
supabase.from = () => {
  submitTableFallbackCalls++;
  return { upsert: async () => ({ error: null }) };
};

const fakeSub = {
  id: 'sub_scale_test_1',
  quizId: 'quiz-bio-101',
  quizCode: 'BIO101',
  quizTitle: 'Bio Mid',
  subject: 'Biology',
  studentName: 'Ahmad',
  studentClass: 'X IPA 2',
  submittedAt: new Date().toISOString(),
  durationSeconds: 300,
  score: 0,
  totalMarks: 10,
  percentage: 0,
  violationsCount: 0,
  proctoringLogs: [],
  rawAnswers: { 0: 'A' },
  questionResults: [],
  topicBreakdown: {},
  status: 'submitted',
  resultPin: '123456',
};

const verify42501 = await saveQuizSubmissionWithVerification(fakeSub, 3);
check(
  'SC-6d: saveQuizSubmissionWithVerification aborts retries immediately on deterministic 42501 and surfaces exact server error',
  verify42501.success === false &&
    verify42501.attempts === 1 &&
    /Active exam session belongs to another device/i.test(verify42501.error || '') &&
    submitRpcCalls === 1 &&
    submitTableFallbackCalls === 0 &&
    /Active exam session belongs to another device/i.test(getLastCloudWriteError(fakeSub.id) || ''),
  JSON.stringify({ verify42501, submitRpcCalls, submitTableFallbackCalls })
);

supabase.rpc = async (fn) => {
  if (fn === 'submit_student_exam_attempt') {
    submitRpcCalls++;
    return { data: null, error: { code: '544', message: 'DatabaseTimeout' } };
  }
  return { data: null, error: null };
};
const cloud544Ok = await saveQuizSubmissionCloud({ ...fakeSub, id: 'sub_scale_test_2' });
check(
  'SC-6e: saveQuizSubmissionCloud does not fall back to RLS-blocked quiz_submissions.upsert on 544 timeout',
  cloud544Ok === false &&
    submitTableFallbackCalls === 0 &&
    /DatabaseTimeout/i.test(getLastCloudWriteError('sub_scale_test_2') || ''),
  JSON.stringify({ cloud544Ok, submitTableFallbackCalls, err: getLastCloudWriteError('sub_scale_test_2') })
);

supabase.rpc = origRpc;
supabase.from = origFrom;

// ── Test 7: Migration 031 & Client Contract Checks ──────────────────────────
const mig031 = fs.readFileSync(
  path.resolve('supabase/migrations/031_class_scoped_identity_and_170_student_scale.sql'),
  'utf8'
);
const runnerSrc = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');

check(
  'SC-7a: Migration 031 sets fillfactor = 70 on app_config & exam_draft_locks and adds audit + class lookup indexes',
  /ALTER TABLE public\.app_config SET \(fillfactor = 70\);/i.test(mig031) &&
    /ALTER TABLE public\.exam_draft_locks SET \(fillfactor = 70\);/i.test(mig031) &&
    mig031.includes('idx_proctor_audit_guard_lookup') &&
    mig031.includes('idx_quiz_submissions_attempt_class_lookup')
);

check(
  'SC-7b: Migration 031 skips redundant exam_draft_locks updates within 10 minutes and uses valid 3-column schema',
  mig031.includes("INTERVAL '10 minutes'") &&
    mig031.includes('INSERT INTO public.exam_draft_locks (draft_key, owner_token_hash, updated_at)') &&
    !/INSERT\s+INTO\s+public\.exam_draft_locks[^;]*created_at/i.test(mig031)
);

check(
  'SC-7c: Migration 031 preserves RETURNS JSONB on check_student_attempt_submitted, class normalization, Practice graded, and Migration 030 optional result_pin idempotency',
  /CREATE OR REPLACE FUNCTION public\.check_student_attempt_submitted[\s\S]*?RETURNS JSONB/i.test(mig031) &&
    (mig031.match(/public\.normalize_roster_class_label\(s\.student_class\)/g) || []).length >= 2 &&
    mig031.includes("__cls_") &&
    mig031.includes("NULLIF(TRIM(s.result_pin), '') IS NULL") &&
    mig031.includes('cleanup_stale_exam_drafts')
);

check(
  'SC-7d: StudentQuizRunner uses dirty-checked cloud draft sync, 12s debounce without currentIndex, 90s jittered interval, 3s audit throttle, and 0-6s timer auto-submit jitter',
  runnerSrc.includes('computeCloudDraftFingerprint') &&
    runnerSrc.includes('12000') &&
    runnerSrc.includes('90000 + Math.floor(Math.random() * 20000)') &&
    runnerSrc.includes('lastStudentAuditWriteByTypeRef') &&
    runnerSrc.includes('timerExpiryAutoSubmitTriggeredRef')
);

// ── Test 8: Migration 032 Exam Paper Cache & Lobby Resilience ───────────────
const mig032 = fs.readFileSync(
  path.resolve('supabase/migrations/032_exam_paper_cache_and_fast_lobby.sql'),
  'utf8'
);
const quizCodeSrc = fs.readFileSync(path.resolve('src/services/quizCodeService.ts'), 'utf8');

check(
  'SC-8a: Migration 032 creates RLS-locked exam_paper_cache, trigger invalidation (app_config/questions/custom_tests), advisory-lock build, live scheduleStatus gating & zero teacherPinHash',
  /CREATE TABLE IF NOT EXISTS public\.exam_paper_cache[\s\S]*fillfactor = 70/i.test(mig032) &&
    /ALTER TABLE public\.exam_paper_cache ENABLE ROW LEVEL SECURITY;/i.test(mig032) &&
    /REVOKE ALL ON TABLE public\.exam_paper_cache FROM PUBLIC, anon, authenticated;/i.test(mig032) &&
    mig032.includes('trg_invalidate_exam_paper_cache_app_config_iu') &&
    mig032.includes('trg_invalidate_exam_paper_cache_app_config_d') &&
    mig032.includes('trg_invalidate_exam_paper_cache_questions') &&
    mig032.includes('trg_invalidate_exam_paper_cache_custom_tests') &&
    mig032.includes('pg_advisory_xact_lock') &&
    mig032.includes('WHERE id = v_test_id::uuid') &&
    mig032.includes("'scheduleStatus'") &&
    mig032.includes("'serverNow'") &&
    mig032.includes('scheduled_end_at') &&
    /'teacherPinHash',\s*NULL/i.test(mig032)
);

check(
  'SC-8b: quizCodeService uses 12s timeout, 2-attempt jittered retry, and gates legacy table fallback on isMissingRpcError',
  quizCodeSrc.includes('isMissingRpcError') &&
    quizCodeSrc.includes('12000') &&
    quizCodeSrc.includes('maxRpcAttempts = 2') &&
    /if \(isMissingRpcError\(rpcRes\.error\)\)\s*\{\s*\/\/[^\n]*\n\s*allowLegacyCloudTableFallback = true;/.test(quizCodeSrc)
);

console.log(`\nClass-scoped identity & 170-student scale tests: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
