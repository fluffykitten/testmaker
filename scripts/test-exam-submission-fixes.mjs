// Verification suite for Plan/exam_mode_submission_fixes.md.
//
//   node scripts/test-exam-submission-fixes.mjs
//
// Exercises the pure submission guards the runner, outbox, draft service and
// grading modal now share, plus source tripwires for the integration points that
// need a browser/Supabase to exercise end to end.
import fs from 'node:fs';
import {
  buildAnswersByQuestionId,
  chooseRegradeMarks,
  didSubmitAttempt,
  hashTeacherPin,
  isOutboxRetryable,
  outboxBackoffMs,
  partitionAnalyticsSubmissions,
  resolveResumeClock,
  resolveStoredAnswer,
  sanitizeQuestionsForStudent,
  shouldResetSessionForCandidate,
} from '../src/lib/examSubmissionGuards.ts';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const read = (path) => fs.readFileSync(path, 'utf8');

const runnerSource = read('src/pages/StudentQuizRunner.tsx');
const resultsSource = read('src/components/QuizResultsModal.tsx');
const submissionSource = read('src/services/quizSubmissionService.ts');
const codeSource = read('src/services/quizCodeService.ts');
const draftSource = read('src/services/examDraftService.ts');

// ─── T1: H1 — an unsubmitted candidate may resume ────────────────────────────
{
  const result = { submitted: false, submissionId: undefined };
  check('T1 resume is allowed when checkStudentAttemptSubmitted returns {submitted:false}', didSubmitAttempt(result) === false);
  check('T1 runner unwraps the attempt result with didSubmitAttempt', runnerSource.includes('didSubmitAttempt(alreadySubmitted)'));
  check('T1 runner no longer treats the whole result object as a boolean', !runnerSource.includes('if (alreadySubmitted)'));
}

// ─── T2: H1 — a submitted candidate is blocked ───────────────────────────────
{
  check('T2 resume is blocked when the result says submitted:true', didSubmitAttempt({ submitted: true, submissionId: 'sub-1' }) === true);
  check('T2 a null attempt result does not block', didSubmitAttempt(null) === false && didSubmitAttempt(undefined) === false);
}

// ─── T3: H2/M3 — deadline preserved and draft id unified ─────────────────────
{
  const now = 1_700_000_000_000;
  const draft = {
    startTime: now - 60_000,
    targetEndTime: now + 600_000,
    timeLeftSeconds: 600, // stale snapshot
  };
  const twoMinLater = now + 120_000;
  const resume = resolveResumeClock(draft, twoMinLater, 45 * 60);
  check('T3 resume keeps the absolute deadline', resume.deadline === draft.targetEndTime);
  check('T3 resume subtracts closed time (480 s, not the 600 s snapshot)', resume.remainingSeconds === 480, String(resume.remainingSeconds));
  check('T3 resume is not expired while time remains', resume.expired === false);

  const expired = resolveResumeClock({ targetEndTime: now - 5_000 }, now, 45 * 60);
  check('T3 an elapsed deadline marks the resume expired', expired.expired === true && expired.remainingSeconds === 0);

  const legacy = resolveResumeClock({ startTime: now - 120_000, timeLeftSeconds: 600 }, now, 600);
  check('T3 legacy draft derives deadline from startTime, never adds time', legacy.deadline === now + 480_000 && legacy.derivedFromStart);

  check('T3 runner uses resolveResumeClock for resume', runnerSource.includes('resolveResumeClock(detectedDraft'));
  check('T3 initial draft uses the shared effectiveDraftQuizId', /saveExamDraft\(\{[\s\S]{0,200}quizId: effectiveDraftQuizId/.test(runnerSource));
  check('T3 draft service falls through to cloud on a local quizId mismatch', draftSource.includes('checking cloud copy instead'));
}

// ─── T4: C5 — deterministic re-grade preserves AI/manual marks ───────────────
{
  const unhandled = { isHandled: false, earnedMarks: 0, isCorrect: false, feedback: 'Complex descriptive' };
  const previous = { earnedMarks: 5, isCorrect: false, feedback: 'AI: 5/6' };
  const kept = chooseRegradeMarks(unhandled, previous);
  check('T4 unhandled descriptive mark is preserved (5, not 0)', kept.earnedMarks === 5);
  check('T4 preserved mark keeps its feedback', kept.feedback === 'AI: 5/6');
  check('T4 preservation is flagged for the summary', kept.preserved === true);

  const handled = { isHandled: true, earnedMarks: 1, isCorrect: true, feedback: 'Correct' };
  const fresh = chooseRegradeMarks(handled, { earnedMarks: 0, isCorrect: false });
  check('T4 handled deterministic marks still update', fresh.earnedMarks === 1 && fresh.preserved === false);

  const noPrevious = chooseRegradeMarks(unhandled, undefined);
  check('T4 unhandled with no previous mark stays pending at 0', noPrevious.earnedMarks === 0 && /Awaiting/.test(noPrevious.feedback));

  check('T4 grading modal uses chooseRegradeMarks', resultsSource.includes('chooseRegradeMarks(det'));
  check('T4 grading modal no longer marks pending descriptive papers as graded', resultsSource.includes("hasPendingDescriptive ? sub.status : 'graded'"));
}

// ─── T5: H7 — question-id answer lookup survives reordering ──────────────────
{
  const originalOrder = [
    { id: 'q1', sub_questions: [{ sub_id: '(a)' }] },
    { id: 'q2', sub_questions: [] },
  ];
  // Student answered Q1(a) and Q2 when the order was [q1, q2].
  const answers = { '0_0': 'blue', 1: 'B' };
  const idMap = buildAnswersByQuestionId(originalOrder, answers);
  check('T5 id map keys sub-answers by question + sub id', idMap['q1::(a)'] === 'blue', JSON.stringify(idMap));
  check('T5 id map keys standalone answers by question id', idMap.q2 === 'B');

  const reordered = resolveStoredAnswer({
    rawAnswers: answers,
    answersByQuestionId: { q2: 'B', 'q1::(a)': 'blue' },
    questionId: 'q2',
    index: 0,
  });
  check('T5 re-grade resolves Q2 by id, not by its new index', reordered === 'B');

  const sub = resolveStoredAnswer({
    rawAnswers: answers,
    answersByQuestionId: { q2: 'B', 'q1::(a)': 'blue' },
    questionId: 'q1',
    subId: '(a)',
    index: 1,
    subIndex: 0,
  });
  check('T5 re-grade resolves a sub-answer by question/sub id', sub === 'blue');

  const legacy = resolveStoredAnswer({ rawAnswers: { '1_0': 'old' }, index: 1, subIndex: 0 });
  check('T5 legacy positional rows still grade', legacy === 'old');
}

// ─── T6: H4/H5 — failed outbox retry + truthful sync flag ────────────────────
{
  const now = 1_700_000_000_000;
  check('T6 pending items are always retryable', isOutboxRetryable({ status: 'pending' }, now) === true);
  check('T6 a failed item is retryable before its budget runs out', isOutboxRetryable({ status: 'failed', retryCount: 2 }, now) === true);
  check('T6 a failed item honours an unexpired backoff', isOutboxRetryable({ status: 'failed', retryCount: 2, nextRetryAt: new Date(now + 60_000).toISOString() }, now) === false);
  check('T6 a failed item retries once the backoff elapses', isOutboxRetryable({ status: 'failed', retryCount: 2, nextRetryAt: new Date(now - 1).toISOString() }, now) === true);
  check('T6 an exhausted item is not retried', isOutboxRetryable({ status: 'failed', retryCount: 10 }, now) === false);
  check('T6 backoff grows then caps at 30 minutes', outboxBackoffMs(1) === 15_000 && outboxBackoffMs(2) === 30_000 && outboxBackoffMs(20) === 1_800_000);
  check('T6 service flushes retryable (not only pending) items', submissionSource.includes('isOutboxRetryable(item, now)'));
  check('T6 app_config mirror is only written after a table failure', submissionSource.includes('if (!tableSuccess) {'));
  check('T6 synced is only marked by the table-success branch', !/appConfigSuccess[\s\S]{0,80}markOutboxSynced/.test(submissionSource));
}

// ─── T7: C2 — exam payload sanitization ──────────────────────────────────────
{
  const raw = [
    {
      id: 'q1',
      question_text: 'Explain the trend.',
      options: ['A', 'B'],
      marks: 2,
      mark_scheme: { marking_points: ['trend', 'reason'], acceptable_answers: ['increases'] },
      guidance: ['examiner tip'],
      scratchpad: { answer: 42 },
      sub_questions: [
        {
          sub_id: '(a)',
          question_text: 'State the value.',
          marks: 1,
          mark_scheme: 'answer: 7',
          guidance: 'look at the graph',
          common_misconceptions: ['reading the axis'],
        },
      ],
    },
  ];

  const sanitized = sanitizeQuestionsForStudent(raw, true);
  const q = sanitized[0];
  check('T7 top-level mark scheme is stripped', q.mark_scheme === null);
  check('T7 guidance/acceptable answers are stripped', q.guidance === undefined && q.acceptable_answers === undefined);
  check('T7 scratchpad/answer metadata is stripped', q.scratchpad === undefined && q.metadata === undefined);
  check('T7 sub-question mark scheme/guidance is stripped', q.sub_questions[0].mark_scheme === undefined && q.sub_questions[0].guidance === undefined && q.sub_questions[0].common_misconceptions === undefined);
  check('T7 render fields are preserved', q.question_text === raw[0].question_text && q.options.length === 2 && q.marks === 2);
  check('T7 practice mode keeps the answer keys', sanitizeQuestionsForStudent(raw, false) === raw);
  check('T7 quiz resolver applies the sanitizer', codeSource.includes('sanitizeQuestionsForStudent(questions, stripAnswerKeys)'));
  check('T7 quiz resolver strips plaintext teacherPin from the header', codeSource.includes('delete (headerSource as any).teacherPin'));
  check('T7 quiz resolver never returns teacherPin', !/teacherPin: effectiveTeacherPin/.test(codeSource));

  const hash = await hashTeacherPin('CHEM-1A2B', '1234');
  check('T7 unlock PIN is represented by a hash, not plaintext', hash.startsWith('sha256:') || hash.startsWith('fnv1a:'));
  check('T7 unlock hash is deterministic and code-scoped', hash === (await hashTeacherPin('chem-1a2b', '1234')) && hash !== (await hashTeacherPin('PHYS-0001', '1234')));
}

// ─── T8: C3 — student result lookup is scoped ───────────────────────────────
{
  const start = submissionSource.indexOf('export async function fetchStudentResultsCloud');
  const end = submissionSource.indexOf('\nexport ', start + 10);
  const block = submissionSource.slice(start, end === -1 ? undefined : end);

  check('T8 result lookup calls the scoped RPC', block.includes("lookup_student_exam_result"));
  check('T8 result lookup never downloads school-wide submissions', !block.includes('loadAndSyncAllSubmissions('));
  check('T8 fallback filters by candidate name, not the whole cohort', block.includes("ilike('student_name'"));
  check('T8 last-resort fallback is local storage only', block.includes('getAllSubmissions().filter'));
}

// ─── T9: H8 — shared-device session isolation ────────────────────────────────
{
  check('T9 a different candidate on the same device resets the session', shouldResetSessionForCandidate({ candidateName: 'Alice', candidateNumber: '001' }, { candidateName: 'Bob', candidateNumber: '002' }) === true);
  check('T9 the same candidate keeps their session', shouldResetSessionForCandidate({ candidateName: 'Alice', candidateNumber: '001' }, { candidateName: 'alice ', candidateNumber: '001' }) === false);
  check('T9 a different candidate number resets a same-name session', shouldResetSessionForCandidate({ candidateName: 'Alex', candidateNumber: '001' }, { candidateName: 'Alex', candidateNumber: '002' }) === true);
  check('T9 a missing saved session never resets', shouldResetSessionForCandidate(null, { candidateName: 'Bob' }) === false);
  check('T9 runner purges a foreign sitting before starting', runnerSource.includes('shouldResetSessionForCandidate(previousSession'));
}

// ─── T10: M1/M2 — graded-only analytics + null-safe result screen ───────────
{
  const graded = [
    { status: 'graded', score: 8, percentage: 80 },
    { status: 'published', score: 9, percentage: 90 },
  ];
  const pending = [
    { status: 'submitted', score: 0, percentage: 0 },
    { status: 'submitted', score: 0, percentage: 0 },
  ];
  const split = partitionAnalyticsSubmissions([...graded, ...pending]);
  check('T10 pending submissions are excluded from the KPI average', split.analytics.length === 2 && split.analytics.every((s) => s.status !== 'submitted'));
  check('T10 pending count is surfaced separately', split.pending.length === 2);
  check('T10 a graded cohort is not marked provisional', split.provisional === false);

  const allPending = partitionAnalyticsSubmissions(pending);
  check('T10 an entirely ungraded cohort is marked provisional', allPending.provisional === true && allPending.analytics.length === 2);

  check('T10 grading modal uses the graded-only analytics split', resultsSource.includes('partitionAnalyticsSubmissions(activeSubmissions)'));
  check('T10 result screen guards a null completedSubmission', runnerSource.includes('if (!completedSubmission) {') && runnerSource.includes('Attempt Closed'));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
