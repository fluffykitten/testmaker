// Regression suite for Plan/manual_grading_revert_fix_plan.md
//
//   npm run test:manual-grading
//
// Verifies manual mark override & total-score override persistence against:
// 1. Pre-upsert submissions_updated race + in-flight save protection
// 2. Timestamp-based cloud/local merge & failed-outbox protection
// 3. Deterministic auto-grading & full re-grade preservation
// 4. QuizResultsModal staleness/race guards & teacher grading markers

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

const dispatchedEvents = [];
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    dispatchEvent: (ev) => {
      dispatchedEvents.push(ev?.type || String(ev));
      return true;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
if (typeof globalThis.Event === 'undefined') {
  globalThis.Event = class Event {
    constructor(type) {
      this.type = type;
    }
  };
}

import fs from 'node:fs';
import { supabase } from '../src/lib/supabase.ts';
import { chooseRegradeMarks } from '../src/lib/examSubmissionGuards.ts';
import { gradeSubmissionDeterministically } from '../src/services/deterministicGradingService.ts';
import {
  saveQuizSubmissionCloud,
  fetchSubmissionsFromSupabase,
  getAllSubmissions,
  getSubmissionOutbox,
  setQuizSubmissionsStatus,
} from '../src/services/quizSubmissionService.ts';

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

function makeQuestion(id, overrides = {}) {
  return {
    id,
    question_text: 'Explain electrolysis of molten lead(II) bromide.',
    question_style: 'Structured',
    marks: 3,
    topic: 'Electrochemistry',
    correct_answer: 'Lead ions gain electrons at cathode; bromide ions lose electrons at anode.',
    sub_questions: [],
    ...overrides,
  };
}

function makeCloudRow(sub) {
  return {
    id: sub.id,
    quiz_id: sub.quizId,
    quiz_code: sub.quizCode,
    quiz_title: sub.quizTitle,
    subject: sub.subject,
    student_name: sub.studentName,
    student_class: sub.studentClass,
    candidate_number: sub.candidateNumber,
    submitted_at: sub.submittedAt,
    duration_seconds: sub.durationSeconds,
    score: sub.score,
    total_marks: sub.totalMarks,
    percentage: sub.percentage,
    violations_count: sub.violationsCount || 0,
    proctoring_logs: sub.proctoringLogs || [],
    raw_answers: {
      ...(sub.rawAnswers || {}),
      ...(sub.forensics ? { _forensics: sub.forensics } : {}),
    },
    question_results: sub.questionResults || [],
    topic_breakdown: sub.topicBreakdown || {},
    status: sub.status || 'submitted',
    teacher_adjusted_marks: sub.teacherAdjustedMarks || 0,
    teacher_notes: sub.teacherNotes || '',
    result_pin: sub.resultPin || '',
    updated_at: sub.updatedAt || sub.submittedAt,
  };
}

// ─── T1: chooseRegradeMarks protects manual overrides even if deterministic handles item ───
{
  const detHandled = { isHandled: true, earnedMarks: 0, isCorrect: false, feedback: 'Auto 0' };
  const manualPrev = {
    earnedMarks: 2,
    isCorrect: false,
    feedback: 'Teacher partial credit',
    manualOverride: true,
    gradingMethod: 'teacher',
  };
  const choice = chooseRegradeMarks(detHandled, manualPrev);
  check('T1.1 chooseRegradeMarks preserves manualOverride mark when deterministic handles item', choice.preserved === true && choice.earnedMarks === 2);

  const nonManualPrev = { earnedMarks: 1, isCorrect: false, feedback: 'Old det mark' };
  const detChoice = chooseRegradeMarks(detHandled, nonManualPrev);
  check('T1.2 chooseRegradeMarks still updates non-manual handled item', detChoice.preserved === false && detChoice.earnedMarks === 0);
}

// ─── T2: gradeSubmissionDeterministically preserves standalone, sub-question, & total overrides ───
{
  const q1 = makeQuestion('q1', {
    question_style: 'Multiple Choice',
    options: ['Option A', 'Option B'],
    correct_answer: '0',
    marks: 1,
  });
  const q2 = makeQuestion('q2', {
    marks: 4,
    correct_answer: undefined,
    marking_scheme: undefined,
    sub_questions: [
      { sub_id: 'a', label: 'a', question_text: 'Part A', marks: 2 },
      {
        sub_id: 'b',
        label: 'b',
        question_text: 'Part B',
        marks: 2,
        mark_scheme: { acceptable_answers: ['42'], marking_points: ['42'] },
      },
    ],
  });
  const q3 = makeQuestion('q3', {
    marks: 3,
    correct_answer: undefined,
  });

  const sub = {
    id: 'sub_det_1',
    quizId: 'quiz_1',
    quizCode: 'ELC101',
    quizTitle: 'Electrolysis',
    subject: 'Chemistry',
    studentName: 'Student A',
    studentClass: '10A',
    candidateNumber: '001',
    submittedAt: '2026-11-12T01:00:00.000Z',
    durationSeconds: 120,
    score: 5,
    totalMarks: 8,
    percentage: 63,
    violationsCount: 0,
    proctoringLogs: [],
    rawAnswers: { q1: 1, 'q2::a': 'cathode reduces Pb2+', 'q2::b': '42', q3: 'some explanation' },
    forensics: {
      answersByQuestionId: { q1: 1, 'q2::a': 'cathode reduces Pb2+', 'q2::b': '42', q3: 'some explanation' },
    },
    questionResults: [
      {
        questionId: 'q1',
        questionNumber: 1,
        topic: 'Electrochemistry',
        maxMarks: 1,
        earnedMarks: 1,
        isCorrect: true,
        studentAnswer: 1,
        correctAnswer: 'Option A',
        gradingMethod: 'teacher',
        manualOverride: true,
        aiFeedback: 'Teacher accepted alternate key',
      },
      {
        questionId: 'q2',
        questionNumber: 2,
        topic: 'Electrochemistry',
        maxMarks: 4,
        earnedMarks: 2,
        isCorrect: false,
        studentAnswer: '',
        correctAnswer: 'See mark scheme',
        gradingMethod: 'teacher',
        manualOverride: true,
        subQuestionResults: [
          {
            subId: 'a',
            studentAnswer: 'cathode reduces Pb2+',
            earnedMarks: 2,
            maxMarks: 2,
            isCorrect: true,
            feedback: 'Marked by teacher (2/2 marks)',
            manualOverride: true,
          },
          {
            subId: 'b',
            studentAnswer: '42',
            earnedMarks: 0,
            maxMarks: 2,
            isCorrect: false,
            feedback: 'Awaiting examiner AI evaluation',
          },
        ],
      },
      {
        questionId: 'q3',
        questionNumber: 3,
        topic: 'Electrochemistry',
        maxMarks: 3,
        earnedMarks: 2,
        isCorrect: false,
        studentAnswer: 'some explanation',
        correctAnswer: 'See mark scheme',
        gradingMethod: 'teacher',
        manualOverride: true,
        aiFeedback: 'Manual 2/3',
      },
    ],
    topicBreakdown: { Electrochemistry: { totalMarks: 8, earnedMarks: 5, percentage: 62.5 } },
    status: 'graded',
    teacherAdjustedMarks: 4,
    teacherNotes: '',
    resultPin: '1234',
    updatedAt: '2026-11-12T01:05:00.000Z',
  };

  const unresolvedPass = gradeSubmissionDeterministically(sub, [q1, q2, q3], 8, { onlyUnresolved: true });
  const r1 = unresolvedPass.updatedSub.questionResults.find((r) => r.questionId === 'q1');
  const r2 = unresolvedPass.updatedSub.questionResults.find((r) => r.questionId === 'q2');
  const r3 = unresolvedPass.updatedSub.questionResults.find((r) => r.questionId === 'q3');
  const r2a = r2?.subQuestionResults?.find((sr) => sr.subId === 'a');
  const r2b = r2?.subQuestionResults?.find((sr) => sr.subId === 'b');

  check('T2.1 onlyUnresolved preserves manual MCQ override (1/1)', r1?.earnedMarks === 1 && r1?.manualOverride === true && r1?.gradingMethod === 'teacher');
  check('T2.2 onlyUnresolved preserves manual sub-question (a) (2/2)', r2a?.earnedMarks === 2 && r2a?.manualOverride === true);
  check('T2.3 onlyUnresolved grades unresolved non-manual sub-question (b) (2/2)', r2b?.earnedMarks === 2);
  check('T2.4 onlyUnresolved preserves manual standalone structured question (2/3) even with See mark scheme', r3?.earnedMarks === 2 && r3?.manualOverride === true);

  const fullRegradePass = gradeSubmissionDeterministically(unresolvedPass.updatedSub, [q1, q2, q3], 8, {
    onlyUnresolved: false,
  });
  check(
    'T2.5 Re-Grade All (onlyUnresolved:false) still preserves manual MCQ, sub-question, and structured marks',
    fullRegradePass.updatedSub.questionResults[0].earnedMarks === 1 &&
      fullRegradePass.updatedSub.questionResults[1].subQuestionResults[0].earnedMarks === 2 &&
      fullRegradePass.updatedSub.questionResults[2].earnedMarks === 2 &&
      fullRegradePass.updatedSub.score === 7
  );

  const withTotalOverride = {
    ...sub,
    score: 6,
    percentage: 75,
    forensics: { ...(sub.forensics || {}), manualTotalScoreOverride: true },
  };
  const totalPass = gradeSubmissionDeterministically(withTotalOverride, [q1, q2, q3], 8, {
    onlyUnresolved: true,
  });
  check(
    'T2.6 manualTotalScoreOverride preserves teacher total score (6/8) during auto-regrade',
    totalPass.updatedSub.score === 6 && totalPass.updatedSub.percentage === 75
  );
}

// ─── T3 & T4 & T5: Cloud race, timestamp merge, and failed outbox fallback ───
{
  localStorage.clear();
  dispatchedEvents.length = 0;

  const nowMs = Date.now();
  const isoMinus = (ms) => new Date(nowMs - ms).toISOString();
  const tsBase = isoMinus(600_000);
  const tsEdit = isoMinus(300_000);
  const tsCloudNewer = isoMinus(120_000);
  const tsOfflineSkew = isoMinus(60_000);
  const tsCloudStaleNewClock = isoMinus(30_000);

  const baseSub = {
    id: 'sub_race_1',
    quizId: 'quiz_race',
    quizCode: 'RACE01',
    quizTitle: 'Race Test',
    subject: 'Chemistry',
    studentName: 'Bob',
    studentClass: '10B',
    candidateNumber: '002',
    submittedAt: tsBase,
    durationSeconds: 300,
    score: 1,
    totalMarks: 5,
    percentage: 20,
    violationsCount: 0,
    proctoringLogs: [],
    rawAnswers: { q1: 'answer' },
    questionResults: [
      {
        questionId: 'q1',
        questionNumber: 1,
        topic: 'Electrochemistry',
        maxMarks: 5,
        earnedMarks: 1,
        isCorrect: false,
        studentAnswer: 'answer',
        correctAnswer: 'See mark scheme',
      },
    ],
    topicBreakdown: { Electrochemistry: { totalMarks: 5, earnedMarks: 1, percentage: 20 } },
    status: 'submitted',
    teacherAdjustedMarks: 0,
    teacherNotes: '',
    resultPin: '1111',
    updatedAt: tsBase,
  };

  let cloudTableRows = [makeCloudRow(baseSub)];
  let cloudAppConfigSubs = [];
  let releaseUpsert = null;
  let nextUpsertError = null;

  const origFrom = supabase.from;
  supabase.from = (tableName) => {
    if (tableName === 'quiz_submissions') {
      return {
        upsert: async (row) => {
          if (releaseUpsert) {
            await new Promise((resolve) => {
              releaseUpsert = () => resolve();
            });
          }
          if (nextUpsertError) {
            const err = nextUpsertError;
            nextUpsertError = null;
            return { error: err };
          }
          const idx = cloudTableRows.findIndex((r) => r.id === row.id);
          if (idx >= 0) cloudTableRows[idx] = row;
          else cloudTableRows.unshift(row);
          return { error: null };
        },
        update: (patch) => {
          const chain = {
            or: async () => {
              cloudTableRows = cloudTableRows.map((r) => ({ ...r, ...patch }));
              return { error: null };
            },
            eq: async () => ({ error: null }),
          };
          return chain;
        },
        select: () => {
          const chain = {
            order: () => chain,
            or: async () => ({ data: cloudTableRows, error: null }),
            eq: async () => ({ data: cloudTableRows, error: null }),
            range: async () => ({ data: cloudTableRows, error: null }),
          };
          return chain;
        },
      };
    }

    if (tableName === 'app_config') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { value: JSON.stringify(cloudAppConfigSubs) },
              error: null,
            }),
            single: async () => ({
              data: { value: JSON.stringify(cloudAppConfigSubs) },
              error: null,
            }),
          }),
        }),
        upsert: async (row) => {
          if (row.key === 'quiz_submissions') {
            cloudAppConfigSubs = JSON.parse(row.value);
          }
          return { error: null };
        },
      };
    }

    return origFrom.call(supabase, tableName);
  };

  try {
    // 3a. In-flight pre-upsert race: slow upsert
    let resolveSlowUpsert;
    releaseUpsert = () => {};
    const editedSub = {
      ...baseSub,
      score: 4,
      percentage: 80,
      status: 'graded',
      teacherAdjustedMarks: 3,
      updatedAt: tsEdit,
    };

    // Wrap upsert to pause until resolveSlowUpsert is called
    const baseFromMock = supabase.from;
    supabase.from = (tableName) => {
      const tbl = baseFromMock(tableName);
      if (tableName === 'quiz_submissions') {
        tbl.upsert = async (row) => {
          await new Promise((res) => {
            resolveSlowUpsert = res;
          });
          cloudTableRows = [row];
          return { error: null };
        };
      }
      return tbl;
    };

    const eventsBefore = dispatchedEvents.length;
    const savePromise = saveQuizSubmissionCloud(editedSub);
    // Allow microtask queue to reach pending upsert
    await new Promise((r) => setTimeout(r, 15));

    check(
      'T3.1 saveQuizSubmissionCloud does NOT dispatch pre-upsert submissions_updated while cloud write is in flight',
      dispatchedEvents.length === eventsBefore
    );

    const midFlightFetched = await fetchSubmissionsFromSupabase('quiz_race', 'RACE01');
    const localAfterMidFetch = getAllSubmissions().find((s) => s.id === 'sub_race_1');
    check(
      'T3.2 fetchSubmissionsFromSupabase mid-flight protects score=4 in returned list & localStorage',
      midFlightFetched[0]?.score === 4 && localAfterMidFetch?.score === 4,
      `fetched=${midFlightFetched[0]?.score}, local=${localAfterMidFetch?.score}`
    );

    resolveSlowUpsert();
    await savePromise;

    check(
      'T3.3 saveQuizSubmissionCloud dispatches submissions_updated after cloud upsert completes',
      dispatchedEvents.length === eventsBefore + 1
    );

    // 3b. Stale replica read after outbox synced (older cloud updated_at must NOT clobber newer local updatedAt)
    cloudTableRows = [makeCloudRow({ ...baseSub, score: 1, updatedAt: tsBase })];
    const afterStaleRead = await fetchSubmissionsFromSupabase('quiz_race', 'RACE01');
    check(
      'T4.1 Newer local updatedAt beats stale cloud updated_at',
      afterStaleRead[0]?.score === 4 && getAllSubmissions()[0]?.score === 4
    );

    // 3c. Newer cloud edit from another teacher device DOES win
    cloudTableRows = [makeCloudRow({ ...editedSub, score: 5, percentage: 100, updatedAt: tsCloudNewer })];
    const afterNewerCloudRead = await fetchSubmissionsFromSupabase('quiz_race', 'RACE01');
    check(
      'T4.2 Newer remote cloud edit updates local cache cleanly',
      afterNewerCloudRead[0]?.score === 5 && getAllSubmissions()[0]?.score === 5
    );

    // 3d. Failed cloud upsert keeps outbox failed and prevents stale table SELECT from reverting mark
    supabase.from = baseFromMock;
    releaseUpsert = null;
    nextUpsertError = { message: 'network timeout' };
    cloudTableRows = [makeCloudRow({ ...baseSub, score: 2, updatedAt: tsCloudStaleNewClock })];

    const offlineEdit = {
      ...editedSub,
      score: 4,
      percentage: 80,
      updatedAt: tsOfflineSkew, // even if clock skew is older than stale row!
    };
    const ok = await saveQuizSubmissionCloud(offlineEdit);
    const outboxItem = getSubmissionOutbox().find((o) => o.submission.id === 'sub_race_1');
    const fetchedWithFailedOutbox = await fetchSubmissionsFromSupabase('quiz_race', 'RACE01');
    check(
      'T5 failed cloud upsert marks outbox=failed and prevents stale cloud row from overwriting edited mark',
      ok === false && outboxItem?.status === 'failed' && fetchedWithFailedOutbox[0]?.score === 4,
      `ok=${ok}, outbox=${outboxItem?.status}, score=${fetchedWithFailedOutbox[0]?.score}`
    );

    // 3e. setQuizSubmissionsStatus updates updatedAt locally to match cloud release timestamp
    await setQuizSubmissionsStatus('quiz_race', 'RACE01', 'published');
    const releasedLocal = getAllSubmissions().find((s) => s.id === 'sub_race_1');
    check(
      'T6 setQuizSubmissionsStatus updates both status and updatedAt locally',
      releasedLocal?.status === 'published' && Date.parse(releasedLocal?.updatedAt || '') >= Date.parse(tsOfflineSkew)
    );
  } finally {
    supabase.from = origFrom;
  }
}

// ─── T7: Source tripwires on QuizResultsModal.tsx ───
{
  const modalSrc = fs.readFileSync('src/components/QuizResultsModal.tsx', 'utf8');
  check('T7.1 QuizResultsModal tracks refresh sequence (refreshSeqRef)', modalSrc.includes('refreshSeqRef'));
  check('T7.2 QuizResultsModal tracks manual edit guard (latestManualEditAtRef)', modalSrc.includes('latestManualEditAtRef'));
  check('T7.3 handleSaveMarkOverride stamps manualOverride & teacher gradingMethod', modalSrc.includes("gradingMethod: 'teacher' as const") && modalSrc.includes('manualOverride: true'));
  check('T7.4 handleSaveTotalScoreOverride stamps manualTotalScoreOverride', modalSrc.includes('manualTotalScoreOverride: true'));
  check('T7.5 postgres_changes scopes incoming events to active exam', modalSrc.includes('!codeMatches && !idMatches && !testMatches'));
}

console.log(`\nManual grading persistence suite: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
