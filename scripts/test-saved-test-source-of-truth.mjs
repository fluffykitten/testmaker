// Verification suite: Saved Test as single source of truth for student quiz delivery and grading.
//
//   node --import ./scripts/register-ts.mjs scripts/test-saved-test-source-of-truth.mjs
//
// Tests:
//   1. Editing/deleting questions in a Saved Test propagates to resolveStudentQuiz() EVEN IF the
//      PublishedQuiz snapshot in storage still carries stale questionIds, overrides, or totalMarks.
//   2. Exam Mode security sanitization remains enforced (mark_scheme === null, no teacherPin/questionOverrides).
//   3. Grading (gradeSubmissionDeterministically with fetchCustomTestWithQuestions) uses the SAME live
//      saved test questions, updated mark scheme, and updated totalMarks.
//   4. hydrateTestWithCloudHeader({ replaceHeader: true }) replaces deleted overrides/questions cleanly
//      without resurrecting removed overrides from stale local state.
//   5. Offline/synthetic PublishedQuiz whose testId is not a saved test falls back cleanly to published overrides.
//   6. UI wiring checks on QuizResultsModal.tsx and QuizManagerPage.tsx.

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

import fs from 'node:fs';
import {
  saveCustomTest,
  updateCustomTest,
  fetchCustomTestWithQuestions,
  hydrateTestWithCloudHeader,
} from '../src/services/testBuilderService.ts';
import {
  savePublishedQuiz,
  getPublishedQuizzes,
} from '../src/services/quizManagerService.ts';
import {
  resolveStudentQuiz,
  clearQuizMemoryCache,
} from '../src/services/quizCodeService.ts';
import { gradeSubmissionDeterministically } from '../src/services/deterministicGradingService.ts';
import { buildAnswersByQuestionId } from '../src/lib/examSubmissionGuards.ts';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ─── Setup Initial 3-Question Saved Test (3 marks total) ───────────────────────
const q1Initial = {
  id: 'q-src-1',
  subject: 'Chemistry',
  question_number: '1',
  topic: 'Electrolysis',
  question_style: 'Multiple Choice',
  question_text: 'OLD Q1: Which electrode attracts anions?',
  options: ['A. Cathode', 'B. Anode', 'C. Battery', 'D. Switch'],
  marks: 1,
  mark_scheme: {
    acceptable_answers: ['B'],
    marking_points: ['Anions are negatively charged and move to the positive anode [1]'],
  },
};

const q2ToDelete = {
  id: 'q-src-2',
  subject: 'Chemistry',
  question_number: '2',
  topic: 'Electrolysis',
  question_style: 'Multiple Choice',
  question_text: 'Q2 TO BE DELETED: What is the charge on a cation?',
  options: ['A. Positive', 'B. Negative', 'C. Neutral', 'D. Variable'],
  marks: 1,
  mark_scheme: {
    acceptable_answers: ['A'],
    marking_points: ['Positive [1]'],
  },
};

const q3Initial = {
  id: 'q-src-3',
  subject: 'Chemistry',
  question_number: '3',
  topic: 'Electrolysis',
  question_style: 'Multiple Choice',
  question_text: 'OLD Q3: Molten NaCl cathode product?',
  options: ['A. Sodium metal', 'B. Chlorine gas', 'C. Hydrogen gas', 'D. Oxygen gas'],
  marks: 1,
  mark_scheme: {
    acceptable_answers: ['A'],
    marking_points: ['Sodium metal [1]'],
  },
};

const savedTest = await saveCustomTest({
  title: 'Electrolysis Verification Paper',
  totalMarks: 3,
  questionIds: ['q-src-1', 'q-src-2', 'q-src-3'],
  headerConfig: {
    title: 'Electrolysis Verification Paper',
    schoolName: 'Test Academy',
    subject: 'Chemistry',
    subjectCode: '0620',
    durationMinutes: 30,
    instructions: 'Original paper instructions',
    questionOverrides: {
      'q-src-1': q1Initial,
      'q-src-2': q2ToDelete,
      'q-src-3': q3Initial,
    },
  },
});

const stalePublishedQuiz = {
  id: 'pub-saved-source-test',
  testId: savedTest.id,
  quizCode: 'SAVEDSRC01',
  title: 'Electrolysis Period 2',
  subject: 'Chemistry',
  questionIds: ['q-src-1', 'q-src-2', 'q-src-3'],
  questionCount: 3,
  totalMarks: 3,
  durationMinutes: 30,
  isActive: true,
  isExamMode: true,
  showInstantSolutions: false,
  securityEnabled: true,
  teacherPin: '9988',
  createdAt: new Date().toISOString(),
  headerConfig: {
    title: 'Electrolysis Period 2',
    schoolName: 'Test Academy',
    subject: 'Chemistry',
    subjectCode: '0620',
    durationMinutes: 30,
    instructions: 'Original paper instructions',
    questionOverrides: {
      'q-src-1': q1Initial,
      'q-src-2': q2ToDelete,
      'q-src-3': q3Initial,
    },
  },
};

await savePublishedQuiz(stalePublishedQuiz);

// Initial resolve check
clearQuizMemoryCache();
const initialResolved = await resolveStudentQuiz('SAVEDSRC01');
check(
  '1a. Initial resolveStudentQuiz returns 3 questions and 3 marks',
  Boolean(initialResolved && initialResolved.questions.length === 3 && initialResolved.totalMarks === 3),
  initialResolved ? `got len=${initialResolved.questions.length}, marks=${initialResolved.totalMarks}` : 'null'
);

// ─── Edit Saved Test: Delete Q2, Change Q1 (1m 'B' -> 2m 'C'), Change Q3 (1m -> 3m) ─
const q1Updated = {
  ...q1Initial,
  question_text: 'NEW Q1: What forms at the cathode in dilute H2SO4?',
  options: ['A. Sulfur', 'B. Oxygen', 'C. Hydrogen gas', 'D. Water'],
  marks: 2,
  mark_scheme: {
    acceptable_answers: ['C'],
    marking_points: ['Hydrogen gas is discharged at the cathode [2]'],
  },
};

const q3Updated = {
  ...q3Initial,
  question_number: '2',
  question_text: 'NEW Q3 (renumbered Q2): Concentrated brine anode product?',
  options: ['A. Oxygen gas', 'B. Chlorine gas', 'C. Hydrogen gas', 'D. Sodium hydroxide'],
  marks: 3,
  mark_scheme: {
    acceptable_answers: ['B'],
    marking_points: ['Chlorine gas [3]'],
  },
};

await updateCustomTest(savedTest.id, {
  title: 'Electrolysis Verification Paper (Edited)',
  totalMarks: 5,
  questionIds: ['q-src-1', 'q-src-3'],
  headerConfig: {
    title: 'Electrolysis Verification Paper (Edited)',
    schoolName: 'Test Academy',
    subject: 'Chemistry',
    subjectCode: '0620',
    durationMinutes: 30,
    instructions: 'Updated saved test instructions',
    questionOverrides: {
      'q-src-1': q1Updated,
      'q-src-3': q3Updated,
    },
  },
});

// Explicitly overwrite published_quizzes in localStorage back to the STALE snapshot
// to simulate a student browser or cloud row where PublishedQuiz was never re-saved.
const currentPublished = getPublishedQuizzes().map((q) =>
  q.id === stalePublishedQuiz.id ? stalePublishedQuiz : q
);
globalThis.localStorage.setItem('fluffykitten_published_quizzes', JSON.stringify(currentPublished));

clearQuizMemoryCache();
const resolvedAfterEdit = await resolveStudentQuiz('SAVEDSRC01');

check(
  '1b. Student quiz resolves updated 2 questions (Q2 deleted) despite stale PublishedQuiz snapshot',
  Boolean(
    resolvedAfterEdit &&
    resolvedAfterEdit.questions.length === 2 &&
    resolvedAfterEdit.questions[0].id === 'q-src-1' &&
    resolvedAfterEdit.questions[1].id === 'q-src-3'
  ),
  resolvedAfterEdit ? `got ids=${resolvedAfterEdit.questions.map((q) => q.id).join(',')}` : 'null'
);

check(
  '1c. Student quiz serves updated question text, marks, header instructions, and totalMarks = 5',
  Boolean(
    resolvedAfterEdit &&
    resolvedAfterEdit.questions[0].question_text === q1Updated.question_text &&
    resolvedAfterEdit.questions[0].marks === 2 &&
    resolvedAfterEdit.totalMarks === 5 &&
    resolvedAfterEdit.headerConfig?.instructions === 'Updated saved test instructions'
  ),
  resolvedAfterEdit
    ? `marks=${resolvedAfterEdit.totalMarks}, q1=${resolvedAfterEdit.questions[0]?.question_text}`
    : 'null'
);

check(
  '1d. Published quiz deployment title stays intact while paper content comes from saved test',
  Boolean(resolvedAfterEdit && resolvedAfterEdit.title === 'Electrolysis Period 2'),
  resolvedAfterEdit ? `title=${resolvedAfterEdit.title}` : 'null'
);

check(
  '2. Formal Exam Mode strips mark_scheme, teacherPin, and questionOverrides from student payload',
  Boolean(
    resolvedAfterEdit &&
    resolvedAfterEdit.questions.every((q) => q.mark_scheme === null) &&
    !('teacherPin' in (resolvedAfterEdit.headerConfig || {})) &&
    !('questionOverrides' in (resolvedAfterEdit.headerConfig || {})) &&
    Boolean(resolvedAfterEdit.teacherPinHash)
  )
);

// ─── Test 3: Grading Uses Exact Same Live Saved Test & Total Marks ────────────
const gradingSource = await fetchCustomTestWithQuestions(stalePublishedQuiz.testId);
check(
  '3a. fetchCustomTestWithQuestions returns matching 2 questions and total_marks = 5',
  Boolean(
    gradingSource &&
    gradingSource.questions.length === 2 &&
    gradingSource.test.total_marks === 5 &&
    gradingSource.questions[0].mark_scheme?.acceptable_answers?.[0] === 'C'
  )
);

const newStudentRawAnswers = {
  0: 'C', // NEW Q1 correct answer (2 marks)
  1: 'B', // NEW Q3 (pos 2) correct answer (3 marks)
};
const newKeySubmission = {
  id: 'sub-new-key',
  quizId: stalePublishedQuiz.id,
  quizCode: stalePublishedQuiz.quizCode,
  testId: stalePublishedQuiz.testId,
  quizTitle: stalePublishedQuiz.title,
  studentName: 'Alice Candidate',
  studentClass: '11A',
  submittedAt: new Date().toISOString(),
  score: 0,
  totalMarks: stalePublishedQuiz.totalMarks, // simulates provisional stale submission totalMarks
  percentage: 0,
  status: 'submitted',
  rawAnswers: newStudentRawAnswers,
  forensics: {
    answersByQuestionId: buildAnswersByQuestionId(resolvedAfterEdit.questions, newStudentRawAnswers),
  },
};

const { updatedSub: gradedNew, changed: newChanged } = gradeSubmissionDeterministically(
  newKeySubmission,
  gradingSource.questions,
  gradingSource.test.total_marks,
  { onlyUnresolved: true }
);

check(
  '3b. Deterministic grading scores against NEW saved mark schemes (5/5 = 100%) and updates totalMarks to 5',
  newChanged && gradedNew.score === 5 && gradedNew.totalMarks === 5 && gradedNew.percentage === 100,
  `score=${gradedNew.score}/${gradedNew.totalMarks} (${gradedNew.percentage}%)`
);

const oldStudentRawAnswers = {
  0: 'B', // OLD Q1 correct answer, NOW wrong
  1: 'A', // OLD Q3 correct answer, NOW wrong
};
const oldKeySubmission = {
  ...newKeySubmission,
  id: 'sub-old-key',
  studentName: 'Bob OldKey',
  rawAnswers: oldStudentRawAnswers,
  forensics: {
    answersByQuestionId: buildAnswersByQuestionId(resolvedAfterEdit.questions, oldStudentRawAnswers),
  },
};

const { updatedSub: gradedOld } = gradeSubmissionDeterministically(
  oldKeySubmission,
  gradingSource.questions,
  gradingSource.test.total_marks,
  { onlyUnresolved: true }
);

check(
  '3c. Old deleted/replaced answer keys earn 0 marks when graded against live saved test',
  gradedOld.score === 0 && gradedOld.totalMarks === 5 && gradedOld.percentage === 0,
  `score=${gradedOld.score}/${gradedOld.totalMarks}`
);

// ─── Test 4: Cloud Header Replacement Does Not Resurrect Deleted Overrides ───
const staleLocalCopy = {
  id: savedTest.id,
  user_id: null,
  title: 'Stale Local Title',
  question_ids: ['q-src-1', 'q-src-2', 'q-src-3'],
  total_marks: 3,
  created_at: '2026-10-01T00:00:00.000Z',
  header_config: {
    title: 'Stale Local Title',
    updatedAt: '2026-10-01T00:00:00.000Z',
    questionOverrides: {
      'q-src-1': q1Initial,
      'q-src-2': q2ToDelete,
    },
  },
};

const cloudHeader = {
  title: 'Cloud Authoritative Title',
  instructions: 'Updated from cloud',
  _savedQuestionIds: ['q-src-1', 'q-src-3'],
  _savedTotalMarks: 5,
  _updatedAt: '2026-10-02T00:00:00.000Z',
  questionOverrides: {
    'q-src-1': q1Updated,
    'q-src-3': q3Updated,
  },
};

const replaced = hydrateTestWithCloudHeader(staleLocalCopy, cloudHeader, { replaceHeader: true });
check(
  '4. hydrateTestWithCloudHeader({ replaceHeader: true }) drops deleted Q2 override & applies _savedTotalMarks',
  replaced.question_ids.length === 2 &&
    !replaced.question_ids.includes('q-src-2') &&
    replaced.total_marks === 5 &&
    replaced.header_config?.questionOverrides?.['q-src-2'] === undefined &&
    replaced.header_config?.questionOverrides?.['q-src-1']?.marks === 2,
  `ids=${replaced.question_ids.join(',')}, marks=${replaced.total_marks}`
);

// ─── Test 5: Offline-Import PublishedQuiz Fallback (testId is not a saved test)
const offlineQ = {
  id: 'offline-q-synthetic-1',
  subject: 'Physics',
  question_number: '1',
  topic: 'Mechanics',
  question_style: 'Structured',
  question_text: 'Calculate work done for 10N over 4m.',
  marks: 4,
  mark_scheme: { acceptable_answers: ['40 J'], marking_points: ['W = F * d = 40 J [4]'] },
};

await savePublishedQuiz({
  id: 'pub-offline-fallback',
  testId: offlineQ.id,
  quizCode: 'OFFLINE99',
  title: 'Offline Physics Test',
  subject: 'Physics',
  questionIds: [offlineQ.id],
  questionCount: 1,
  totalMarks: 4,
  durationMinutes: 20,
  isActive: true,
  isExamMode: true,
  showInstantSolutions: false,
  createdAt: new Date().toISOString(),
  headerConfig: {
    title: 'Offline Physics Test',
    durationMinutes: 20,
    questionOverrides: {
      [offlineQ.id]: offlineQ,
    },
  },
});

clearQuizMemoryCache();
const resolvedOffline = await resolveStudentQuiz('OFFLINE99');
check(
  '5. PublishedQuiz without matching saved test falls back cleanly to published.questionIds/overrides',
  Boolean(
    resolvedOffline &&
    resolvedOffline.questions.length === 1 &&
    resolvedOffline.questions[0].id === offlineQ.id &&
    resolvedOffline.totalMarks === 4
  ),
  resolvedOffline ? `len=${resolvedOffline.questions.length}, marks=${resolvedOffline.totalMarks}` : 'null'
);

// ─── Test 6: Static Wiring Checks in UI Components ────────────────────────────
const resultsModalSrc = fs.readFileSync(
  new URL('../src/components/QuizResultsModal.tsx', import.meta.url),
  'utf8'
);
const quizManagerSrc = fs.readFileSync(
  new URL('../src/pages/QuizManagerPage.tsx', import.meta.url),
  'utf8'
);

check(
  '6a. QuizResultsModal keeps effectiveTotalMarksRef & currentQuiz synced with fetchCustomTestWithQuestions',
  resultsModalSrc.includes('effectiveTotalMarksRef') &&
    resultsModalSrc.includes('setCurrentQuiz') &&
    resultsModalSrc.includes("window.addEventListener('tests_updated'")
);

check(
  '6b. QuizManagerPage hydrates quizzes from savedTests via hydrateQuizFromSavedTest',
  quizManagerSrc.includes('hydrateQuizFromSavedTest') &&
    quizManagerSrc.includes('hydrateQuizFromSavedTest(quiz).questionCount') &&
    quizManagerSrc.includes('hydrateQuizFromSavedTest(selectedQuizForResults)')
);

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
