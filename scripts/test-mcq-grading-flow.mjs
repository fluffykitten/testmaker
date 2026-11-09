// Verification suite for Plan/mcq_grading_and_results_sync_fixes.md.
//
//   node scripts/test-mcq-grading-flow.mjs
//
// Simulates the end-to-end Exam Mode MCQ submission & teacher-side auto-grading flow
// (Electrolysis TU Grade 11 scenario), verifying:
//   Test 1: Candidate payload sanitization in Exam Mode strips mark_scheme
//   Test 2: Student submission preserves rawAnswers & answersByQuestionId with provisional 0 marks
//   Test 3: Teacher-side gradeSubmissionDeterministically() scores MCQs, populates model answers,
//           preserves descriptive AI/manual marks, and is strictly idempotent (changed === false on pass 2)
//   Test 4: QuizResultsModal.tsx state sync (selectedSubmission) & fallback model answer wiring

import fs from 'node:fs';
import {
  buildAnswersByQuestionId,
  sanitizeQuestionsForStudent,
} from '../src/lib/examSubmissionGuards.ts';
import {
  gradeDeterministicAnswer,
  gradeSubmissionDeterministically,
  resolveQuestionModelAnswer,
} from '../src/services/deterministicGradingService.ts';

let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ─── Master Questions (Teacher / Database Side: Electrolysis TU Grade 11) ────
const masterQuestions = [
  {
    id: 'q-elec-1',
    topic: 'Electrolysis',
    question_style: 'Multiple Choice',
    question_text: 'During the electrolysis of molten lead(II) bromide, what is formed at the cathode?',
    options: [
      'A. Bromine gas',
      'B. Lead metal',
      'C. Hydrogen gas',
      'D. Oxygen gas',
    ],
    marks: 1,
    mark_scheme: {
      acceptable_answers: ['B'],
      marking_points: ['B [1]'],
    },
  },
  {
    id: 'q-elec-2',
    topic: 'Electrolysis',
    question_style: 'Multiple Choice',
    question_text: 'Which ions migrate to the anode during the electrolysis of concentrated aqueous sodium chloride?',
    options: [
      'A. Na+ and H+',
      'B. Cl- and OH-',
      'C. Na+ and Cl-',
      'D. H+ and OH-',
    ],
    marks: 1,
    mark_scheme: {
      acceptable_answers: ['B'],
      marking_points: ['Option B'],
    },
  },
  {
    id: 'q-elec-3',
    topic: 'Electrolysis',
    question_style: 'Multiple Choice',
    question_text: 'What is the half-equation for the reaction at the anode in the electrolysis of molten aluminum oxide?',
    options: [
      'A. Al3+ + 3e- -> Al',
      'B. 2O2- -> O2 + 4e-',
      'C. O2 + 4e- -> 2O2-',
      'D. 2H+ + 2e- -> H2',
    ],
    marks: 1,
    mark_scheme: {
      acceptable_answers: ['B'],
      marking_points: ['B'],
    },
  },
];

// ─── Test 1: Candidate Payload Sanitization in Exam Mode ─────────────────────
const sanitizedQuestions = sanitizeQuestionsForStudent(masterQuestions, true);
{
  const allStripped = sanitizedQuestions.every((q) => q.mark_scheme === null);
  const allSeeMarkScheme = sanitizedQuestions.every(
    (q) => resolveQuestionModelAnswer(q) === 'See mark scheme'
  );
  const masterHasModelAnswers = masterQuestions.every((q) =>
    resolveQuestionModelAnswer(q).startsWith('Option B:')
  );

  assert(
    'Test 1: Exam Mode sanitization strips mark_scheme from candidate MCQ payload while master questions resolve Option B',
    allStripped && allSeeMarkScheme && masterHasModelAnswers,
    `stripped=${allStripped}, seeMs=${allSeeMarkScheme}, master=${masterHasModelAnswers}`
  );
}

// ─── Test 2: Sanitized Student Submission (StudentQuizRunner Exam Mode) ──────
// Student answers Q1='B' (correct), Q2='B' (correct), Q3='A' (incorrect)
const studentAnswers = { 0: 'B', 1: 'B', 2: 'A' };
const answersByQuestionId = buildAnswersByQuestionId(sanitizedQuestions, studentAnswers);

const sanitizedSubmission = (() => {
  const qResults = sanitizedQuestions.map((q, idx) => {
    const hasAnswerKey = Boolean(q.mark_scheme);
    const userAns = studentAnswers[idx] ?? '';
    return {
      questionId: q.id,
      questionNumber: idx + 1,
      questionText: q.question_text,
      options: q.options,
      topic: q.topic,
      maxMarks: q.marks,
      earnedMarks: hasAnswerKey ? gradeDeterministicAnswer(userAns, q).earnedMarks : 0,
      isCorrect: false,
      studentAnswer: userAns,
      correctAnswer: resolveQuestionModelAnswer(q),
      aiFeedback: 'Awaiting examiner AI evaluation',
      gradingMethod: 'deterministic',
    };
  });

  return {
    id: 'sub_electrolysis_1',
    quizId: 'quiz_elec_11',
    quizCode: 'ELEC11',
    quizTitle: 'Electrolysis TU Grade 11',
    subject: 'Chemistry',
    studentName: 'Test Candidate',
    studentClass: 'Grade 11',
    score: 0,
    totalMarks: 3,
    percentage: 0,
    grade: 'U',
    timeTakenSeconds: 300,
    submittedAt: new Date().toISOString(),
    violationsCount: 0,
    status: 'submitted',
    rawAnswers: studentAnswers,
    questionResults: qResults,
    topicBreakdown: {
      Electrolysis: { totalMarks: 3, earnedMarks: 0, percentage: 0 },
    },
    forensics: {
      answersByQuestionId,
    },
  };
})();

{
  const hasProvisionalZero =
    sanitizedSubmission.score === 0 &&
    sanitizedSubmission.status === 'submitted' &&
    sanitizedSubmission.questionResults.every((qr) => qr.correctAnswer === 'See mark scheme');
  const preservedAnswerMap =
    sanitizedSubmission.forensics.answersByQuestionId['q-elec-1'] === 'B' &&
    sanitizedSubmission.forensics.answersByQuestionId['q-elec-2'] === 'B' &&
    sanitizedSubmission.forensics.answersByQuestionId['q-elec-3'] === 'A';

  assert(
    'Test 2: Sanitized submission preserves rawAnswers and answersByQuestionId while recording provisional 0 marks',
    hasProvisionalZero && preservedAnswerMap,
    `provisionalZero=${hasProvisionalZero}, preservedAnswerMap=${preservedAnswerMap}`
  );
}

// ─── Test 3: Automatic Teacher-Side Deterministic Grading & Idempotency ──────
{
  const pass1 = gradeSubmissionDeterministically(
    sanitizedSubmission,
    masterQuestions,
    3,
    { onlyUnresolved: true }
  );

  const graded = pass1.updatedSub;
  const q1 = graded.questionResults[0];
  const q2 = graded.questionResults[1];
  const q3 = graded.questionResults[2];

  const scoresRight =
    pass1.changed === true &&
    graded.score === 2 &&
    graded.percentage === 67 &&
    graded.status === 'graded' &&
    q1.isCorrect === true &&
    q1.earnedMarks === 1 &&
    q1.gradingMethod === 'mcq' &&
    q1.correctAnswer === 'Option B: Lead metal' &&
    q2.isCorrect === true &&
    q2.earnedMarks === 1 &&
    q2.correctAnswer === 'Option B: Cl- and OH-' &&
    q3.isCorrect === false &&
    q3.earnedMarks === 0 &&
    q3.correctAnswer === 'Option B: 2O2- -> O2 + 4e-' &&
    graded.topicBreakdown.Electrolysis.earnedMarks === 2;

  // Second pass must be a no-op (changed === false)
  const pass2 = gradeSubmissionDeterministically(
    graded,
    masterQuestions,
    3,
    { onlyUnresolved: true }
  );

  // Mixed paper check: ensure descriptive AI/manual marks are preserved and status stays 'submitted' while descriptive is pending
  const mixedQuestions = [
    ...masterQuestions,
    {
      id: 'q-elec-essay',
      topic: 'Electrolysis',
      question_style: 'Structured',
      question_text: 'Explain why solid lead(II) bromide does not conduct electricity whereas molten lead(II) bromide does.',
      marks: 3,
      mark_scheme: {
        acceptable_answers: [
          'In solid state ions are fixed in a lattice and cannot move; when molten, ions are mobile and free to move to electrodes',
        ],
      },
    },
  ];
  const mixedSub = {
    ...sanitizedSubmission,
    totalMarks: 6,
    rawAnswers: { ...studentAnswers, 3: 'Because ions can move in liquid state' },
    questionResults: [
      ...sanitizedSubmission.questionResults,
      {
        questionId: 'q-elec-essay',
        questionNumber: 4,
        questionText: mixedQuestions[3].question_text,
        topic: 'Electrolysis',
        maxMarks: 3,
        earnedMarks: 0,
        isCorrect: false,
        studentAnswer: 'Because ions can move in liquid state',
        correctAnswer: 'See mark scheme',
        aiFeedback: 'Awaiting examiner AI evaluation',
        gradingMethod: 'deterministic',
      },
    ],
  };

  const mixedPass1 = gradeSubmissionDeterministically(mixedSub, mixedQuestions, 6, { onlyUnresolved: true });
  const mixedPass2 = gradeSubmissionDeterministically(mixedPass1.updatedSub, mixedQuestions, 6, { onlyUnresolved: true });

  const mixedOk =
    mixedPass1.changed === true &&
    mixedPass1.updatedSub.score === 2 &&
    mixedPass1.updatedSub.status === 'submitted' &&
    mixedPass1.updatedSub.questionResults[3].aiFeedback === 'Awaiting examiner AI evaluation' &&
    mixedPass1.updatedSub.questionResults[3].correctAnswer.includes('mobile') &&
    mixedPass2.changed === false;

  assert(
    'Test 3: gradeSubmissionDeterministically scores MCQs, populates Option X model answers, handles mixed papers, and is idempotent on pass 2',
    scoresRight && pass2.changed === false && mixedOk,
    `scoresRight=${scoresRight}, pass2Changed=${pass2.changed}, mixedOk=${mixedOk}`
  );
}

// ─── Test 4: QuizResultsModal.tsx State Sync & Fallback Model Answer Wiring ──
{
  const modalSource = fs.readFileSync('src/components/QuizResultsModal.tsx', 'utf8');
  const hasSelectedSubmissionSync =
    modalSource.includes('setSelectedSubmission((prev) =>') &&
    modalSource.includes('updatedList.find((s) => s.id === prev.id)');
  const hasAutoGradeCall =
    modalSource.includes('gradeSubmissionDeterministically(') &&
    modalSource.includes('onlyUnresolved: true');
  const hasDisplayCorrectAnswerFallback =
    modalSource.includes("qr.correctAnswer === 'See mark scheme'") &&
    modalSource.includes('resolveQuestionModelAnswer(masterQuestion)');

  assert(
    'Test 4: QuizResultsModal.tsx syncs selectedSubmission, auto-grades unresolved Exam Mode MCQs, and resolves fallback model answers',
    hasSelectedSubmissionSync && hasAutoGradeCall && hasDisplayCorrectAnswerFallback,
    `sync=${hasSelectedSubmissionSync}, autoGrade=${hasAutoGradeCall}, fallback=${hasDisplayCorrectAnswerFallback}`
  );
}

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

