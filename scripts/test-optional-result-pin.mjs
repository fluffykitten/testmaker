import fs from 'node:fs';
import path from 'node:path';

const memLocal = new Map();
const memSession = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (k) => (memLocal.has(k) ? memLocal.get(k) : null),
    setItem: (k, v) => memLocal.set(k, String(v)),
    removeItem: (k) => memLocal.delete(k),
    clear: () => memLocal.clear(),
  };
}
if (!globalThis.sessionStorage) {
  globalThis.sessionStorage = {
    getItem: (k) => (memSession.has(k) ? memSession.get(k) : null),
    setItem: (k, v) => memSession.set(k, String(v)),
    removeItem: (k) => memSession.delete(k),
    clear: () => memSession.clear(),
  };
}
if (!globalThis.window) {
  globalThis.window = {
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { origin: 'http://localhost', href: 'http://localhost/' },
  };
}

const {
  ENABLE_POST_SUBMIT_RESULT_PIN,
  createPostSubmitResultPin,
  generateResultPin,
  saveQuizSubmission,
  fetchStudentResultsCloud,
} = await import('../src/services/quizSubmissionService.ts');

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

// 1. Default flag & PIN creation behavior
check(
  'ENABLE_POST_SUBMIT_RESULT_PIN defaults to false',
  ENABLE_POST_SUBMIT_RESULT_PIN === false
);
check(
  'createPostSubmitResultPin() returns undefined while disabled',
  createPostSubmitResultPin() === undefined
);
const explicitPin = createPostSubmitResultPin(true);
check(
  'createPostSubmitResultPin(true) issues a 6-digit numeric PIN when enabled',
  typeof explicitPin === 'string' && /^[1-9]\d{5}$/.test(explicitPin)
);
const rawPin = generateResultPin();
check(
  'generateResultPin() remains functional for legacy compatibility',
  typeof rawPin === 'string' && /^[1-9]\d{5}$/.test(rawPin)
);

// 2. Local lookup behavior for PIN-less vs legacy PIN-protected submissions
saveQuizSubmission({
  id: 'sub_pinless_test_1',
  quizId: 'quiz_pinless',
  quizCode: 'NOPIN01',
  quizTitle: 'PIN-less Exam',
  subject: 'Chemistry',
  studentName: 'Alice Tan',
  studentClass: 'Sec 4A',
  submittedAt: '2026-11-18T12:00:00.000Z',
  durationSeconds: 600,
  score: 18,
  totalMarks: 20,
  percentage: 90,
  violationsCount: 0,
  proctoringLogs: [],
  questionResults: [],
  topicBreakdown: {},
  status: 'published',
  resultPin: createPostSubmitResultPin(),
});

const pinlessLookup = await fetchStudentResultsCloud('NOPIN01', 'Alice Tan', '');
check(
  'PIN-less published submission resolves without a PIN',
  !pinlessLookup.pinMismatch && pinlessLookup.submissions.length === 1 && pinlessLookup.submissions[0].id === 'sub_pinless_test_1'
);

saveQuizSubmission({
  id: 'sub_legacy_pin_test_1',
  quizId: 'quiz_legacy_pin',
  quizCode: 'LEGPIN01',
  quizTitle: 'Legacy PIN Exam',
  subject: 'Chemistry',
  studentName: 'Bob Lim',
  studentClass: 'Sec 4B',
  submittedAt: '2026-11-18T12:00:00.000Z',
  durationSeconds: 600,
  score: 15,
  totalMarks: 20,
  percentage: 75,
  violationsCount: 0,
  proctoringLogs: [],
  questionResults: [],
  topicBreakdown: {},
  status: 'published',
  resultPin: '482910',
});

const legacyBlankLookup = await fetchStudentResultsCloud('LEGPIN01', 'Bob Lim', '');
check(
  'Legacy submission with stored resultPin still returns pinMismatch when queried without PIN',
  legacyBlankLookup.pinMismatch === true && legacyBlankLookup.submissions.length === 0
);

const legacyValidLookup = await fetchStudentResultsCloud('LEGPIN01', 'Bob Lim', '482910');
check(
  'Legacy submission unlocks when matching 6-digit resultPin is supplied',
  !legacyValidLookup.pinMismatch && legacyValidLookup.submissions.length === 1 && legacyValidLookup.submissions[0].id === 'sub_legacy_pin_test_1'
);

// 3. UI & migration static checks
const runnerSrc = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');
const portalSrc = fs.readFileSync(path.resolve('src/pages/PortalLandingPage.tsx'), 'utf8');
const modalSrc = fs.readFileSync(path.resolve('src/components/StudentResultModal.tsx'), 'utf8');
const resultsModalSrc = fs.readFileSync(path.resolve('src/components/QuizResultsModal.tsx'), 'utf8');
const mig030 = fs.readFileSync(path.resolve('supabase/migrations/030_optional_result_pin.sql'), 'utf8');

check(
  'StudentQuizRunner gates post-submit resultPin generation and card behind ENABLE_POST_SUBMIT_RESULT_PIN',
  /createPostSubmitResultPin\(\)/.test(runnerSrc) &&
    /ENABLE_POST_SUBMIT_RESULT_PIN && completedSubmission\.resultPin/.test(runnerSrc) &&
    !/resultPin:\s*generateResultPin\(\)/.test(runnerSrc)
);
check(
  'PortalLandingPage hides Access PIN field and skips mandatory PIN check when disabled, and accepts 6-digit PINs when enabled',
  /if \(ENABLE_POST_SUBMIT_RESULT_PIN && !resultPinInput\.trim\(\)\)/.test(portalSrc) &&
    /\{ENABLE_POST_SUBMIT_RESULT_PIN && \(/.test(portalSrc) &&
    /maxLength=\{6\}/.test(portalSrc)
);
check(
  'StudentResultModal provides inline 6-digit PIN recovery prompt if a legacy submission requires a PIN',
  /Personal Access PIN Required/.test(modalSrc) &&
    /setOverridePin\(trimmed\)/.test(modalSrc) &&
    /maxLength=\{6\}/.test(modalSrc)
);
check(
  'Stale 3-digit PIN copy removed across StudentQuizRunner, PortalLandingPage, StudentResultModal, and QuizResultsModal',
  !/3-digit\s+(?:Access\s+)?PIN/i.test(runnerSrc) &&
    !/3-digit\s+(?:Access\s+)?PIN/i.test(portalSrc) &&
    !/3-digit\s+(?:Access\s+)?PIN/i.test(modalSrc) &&
    !/3-digit\s+Personal\s+Access\s+PIN/i.test(resultsModalSrc)
);
check(
  'Migration 030 supports idempotent retries for blank result_pin rows while keeping legacy PIN anti-hijack guard',
  /CREATE OR REPLACE FUNCTION public\.submit_student_exam_attempt/i.test(mig030) &&
    /NULLIF\(TRIM\(s\.result_pin\), ''\) IS NULL/.test(mig030) &&
    /TRIM\(public\.quiz_submissions\.result_pin\) = v_result_pin/.test(mig030)
);

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
