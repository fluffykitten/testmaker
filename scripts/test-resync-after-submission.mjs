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

const {
  verifyTeacherUnlockPinDetailed,
  verifyTeacherUnlockPin,
} = await import('../src/services/quizCodeService.ts');
const { hashTeacherPin } = await import('../src/lib/examSubmissionGuards.ts');
const {
  flushSubmissionOutbox,
  saveToSubmissionOutbox,
  getSubmissionOutbox,
  markOutboxSynced,
} = await import('../src/services/quizSubmissionService.ts');
const {
  buildStudentDraftIdentifier,
  getDraftKey,
} = await import('../src/services/examDraftService.ts');
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

const origRpc = supabase.rpc.bind(supabase);
const origFrom = supabase.from.bind(supabase);

// ── Test 1: Teacher PIN Verification Offline / Timeout vs Genuine Wrong PIN ─
supabase.rpc = async (fn) => {
  if (fn === 'verify_teacher_unlock_pin') {
    return { data: null, error: { code: '544', message: 'DatabaseTimeout' } };
  }
  return { data: null, error: null };
};
const timeoutRes = await verifyTeacherUnlockPinDetailed('BIO101', '1234', '');
check(
  'RS-1a: verifyTeacherUnlockPinDetailed reports unreachable=true on 544/timeout when no offline hash exists',
  timeoutRes.valid === false &&
    timeoutRes.unreachable === true &&
    /DatabaseTimeout/i.test(timeoutRes.error || ''),
  JSON.stringify(timeoutRes)
);

supabase.rpc = async (fn, args) => {
  if (fn === 'verify_teacher_unlock_pin') {
    return { data: args.p_pin === '4321', error: null };
  }
  return { data: null, error: null };
};
const wrongPinRes = await verifyTeacherUnlockPinDetailed('BIO101', '0000', '');
const rightPinRes = await verifyTeacherUnlockPinDetailed('BIO101', '4321', '');
const legacyBoolRes = await verifyTeacherUnlockPin('BIO101', '4321', '');

// Offline hash match when expectedHash is present and server throws
supabase.rpc = async () => {
  throw new Error('Failed to fetch');
};
const offlineHash = await hashTeacherPin('BIO101', '4321');
const offlineHashMatch = await verifyTeacherUnlockPinDetailed('BIO101', '4321', offlineHash);
const offlineHashMiss = await verifyTeacherUnlockPinDetailed('BIO101', '9999', offlineHash);

check(
  'RS-1b: verifyTeacherUnlockPinDetailed separates wrong PIN vs valid PIN vs offline salted-hash match',
  wrongPinRes.valid === false &&
    wrongPinRes.unreachable !== true &&
    rightPinRes.valid === true &&
    legacyBoolRes === true &&
    offlineHashMatch.valid === true &&
    offlineHashMiss.valid === false,
  JSON.stringify({ wrongPinRes, rightPinRes, offlineHashMatch, offlineHashMiss })
);

// ── Test 2: flushSubmissionOutbox Error Propagation & Cleanup ───────────────
mem.clear();
const subItem = {
  id: 'sub_resync_test_1',
  quizId: 'quiz-bio-101',
  quizCode: 'BIO101',
  quizTitle: 'Bio Mid',
  subject: 'Biology',
  studentName: 'Ahmad',
  studentClass: 'X IPA 2',
  submittedAt: new Date().toISOString(),
  durationSeconds: 180,
  score: 0,
  totalMarks: 10,
  percentage: 0,
  violationsCount: 0,
  proctoringLogs: [],
  rawAnswers: { 0: 'A' },
  questionResults: [],
  topicBreakdown: {},
  status: 'submitted',
  resultPin: '654321',
  forensics: { studentPin: '7390' },
};

const ident = buildStudentDraftIdentifier('Ahmad', '7390', 'X IPA 2');
const dKey = getDraftKey('BIO101', ident);
localStorage.setItem(`fluffykitten_exam_draft_${dKey}`, JSON.stringify({ status: 'in_progress' }));
localStorage.setItem('exam_sess_BIO101', JSON.stringify({ isSubmitted: true }));
sessionStorage.setItem('exam_sess_BIO101', JSON.stringify({ isSubmitted: true }));
saveToSubmissionOutbox(subItem, 'pending');

supabase.rpc = async (fn) => {
  if (fn === 'submit_student_exam_attempt') {
    return {
      data: null,
      error: { code: '42501', message: 'Active exam session belongs to another device.' },
    };
  }
  return { data: null, error: null };
};
supabase.from = () => ({ upsert: async () => ({ error: null }) });

const failFlush = await flushSubmissionOutbox();
const afterFailOutbox = getSubmissionOutbox().find((i) => i.submission.id === subItem.id);
check(
  'RS-2a: flushSubmissionOutbox preserves real server rejection error in return payload and outbox item',
  failFlush.syncedCount === 0 &&
    failFlush.failedCount === 1 &&
    /Active exam session belongs to another device/i.test(failFlush.lastError || '') &&
    /Active exam session belongs to another device/i.test(afterFailOutbox?.lastError || ''),
  JSON.stringify({ failFlush, afterFailOutbox })
);

// Make item immediately retryable as pending and succeed on reconnect
saveToSubmissionOutbox(subItem, 'pending');
let deletedDraftCalled = false;
supabase.rpc = async (fn) => {
  if (fn === 'submit_student_exam_attempt') {
    return { data: true, error: null };
  }
  if (fn === 'delete_student_exam_draft') {
    deletedDraftCalled = true;
    return { data: true, error: null };
  }
  return { data: null, error: null };
};

const okFlush = await flushSubmissionOutbox();
const afterOkOutbox = getSubmissionOutbox().find((i) => i.submission.id === subItem.id);
markOutboxSynced(subItem.id);
check(
  'RS-2b: flushSubmissionOutbox on success marks outbox synced and clears local exam_sess & draft keys',
  okFlush.syncedCount === 1 &&
    okFlush.failedCount === 0 &&
    afterOkOutbox?.status === 'synced' &&
    localStorage.getItem('exam_sess_BIO101') === null &&
    sessionStorage.getItem('exam_sess_BIO101') === null &&
    localStorage.getItem(`fluffykitten_exam_draft_${dKey}`) === null &&
    deletedDraftCalled === true,
  JSON.stringify({ okFlush, status: afterOkOutbox?.status, deletedDraftCalled })
);

supabase.rpc = origRpc;
supabase.from = origFrom;

// ── Test 3: StudentQuizRunner Fallback, Offline Reload & Practice UI ────────
const runnerSrc = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');

const catchBlock = runnerSrc.slice(
  runnerSrc.indexOf('const fallback: StudentSubmission = {'),
  runnerSrc.indexOf('setCompletedSubmission(fallback);') + 40
);
const practiceBlock = runnerSrc.slice(
  runnerSrc.indexOf("status: 'graded'"),
  runnerSrc.indexOf('setCompletedSubmission(submission);', runnerSrc.indexOf("status: 'graded'"))
);

check(
  'RS-3a: Emergency catch fallback preserves resultPin, studentPin, and outbox; Practice Mode includes resultPin & offline_failed retry UI',
  catchBlock.includes('resultPin: createPostSubmitResultPin()') &&
    catchBlock.includes('studentPin: studentPinInput || undefined') &&
    catchBlock.includes('saveToSubmissionOutbox(fallback') &&
    runnerSrc.includes("status: 'graded'") &&
    /status:\s*'graded',[\s\S]{0,120}resultPin:\s*createPostSubmitResultPin\(\)/.test(runnerSrc) &&
    runnerSrc.includes("syncStatus === 'offline_failed'") &&
    practiceBlock !== undefined
);

check(
  'RS-3b: StudentQuizRunner keeps Pending Upload screen accessible when offline/reloaded, resets modal spinner on missing submission, distinguishes unreachable PIN, and avoids "3-digit PIN" copy',
  runnerSrc.includes('if (loading && !(isSubmitted && completedSubmission))') &&
    runnerSrc.includes('if (!(isSubmitted && completedSubmission) && (error || (!loading && questions.length === 0)))') &&
    runnerSrc.includes('pinCheck.unreachable') &&
    /if \(!completedSubmission\) \{\s*setIsTeacherActionRunning\(false\);/.test(runnerSrc) &&
    runnerSrc.includes('{completedSubmission.resultPin.length}-digit PIN') &&
    !runnerSrc.includes('this 3-digit PIN')
);

// ── Test 4: Migration 033 SQL Parity ────────────────────────────────────────
const mig033 = fs.readFileSync(
  path.resolve('supabase/migrations/033_resync_pin_verification_parity.sql'),
  'utf8'
);
check(
  'RS-4a: Migration 033 updates verify_teacher_unlock_pin across quiz_by_code_, quiz_by_code:, published_quizzes, previousCodes, and default 1234 fallback',
  /CREATE OR REPLACE FUNCTION public\.verify_teacher_unlock_pin/i.test(mig033) &&
    mig033.includes("'quiz_by_code_' || v_code") &&
    mig033.includes("'quiz_by_code:' || v_code") &&
    mig033.includes("elem->'previousCodes'") &&
    mig033.includes("'1234'") &&
    /GRANT EXECUTE ON FUNCTION public\.verify_teacher_unlock_pin\(TEXT, TEXT\) TO anon, authenticated;/i.test(mig033)
);

console.log(`\nRe-sync after submission tests: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
