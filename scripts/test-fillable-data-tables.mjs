import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractDataTableBlankTargets,
  findTableCompletionSubIndex,
  hasBlankDataTableCells,
  parseTableCellAnswers,
} from '../src/lib/dataTableUtils.ts';
import {
  buildAnswersByQuestionId,
  resolveStoredAnswer,
  sanitizeQuestionsForStudent,
} from '../src/lib/examSubmissionGuards.ts';
import {
  gradeDeterministicAnswer,
  gradeSubmissionDeterministically,
} from '../src/services/deterministicGradingService.ts';
import { formatCandidateAnswer } from '../src/services/quizSubmissionService.ts';
import { PILOT_EXAM_170_QUESTIONS } from '../src/data/pilotExam170Data.ts';

function runStep4Tests() {
  const q6 = PILOT_EXAM_170_QUESTIONS.find((q) => q.id === 'pilot-q6-econ');
  assert.ok(q6, 'pilot-q6-econ must exist in pilotExam170Data');

  // 1. Blank cell coordinate extraction matches ExamDataTable cellKey convention
  assert.equal(hasBlankDataTableCells(q6.data_tables), true);
  const q6Targets = extractDataTableBlankTargets(q6.data_tables);
  assert.equal(q6Targets.length, 1);
  assert.equal(q6Targets[0].cellKey, 'Table 6.1-r2-c1');
  assert.equal(q6Targets[0].expectedAnswer, '350');
  assert.equal(findTableCompletionSubIndex(q6), 0, 'Part (a) must own Table 6.1 completion');

  // 2. Sanitization strips expected_answer while keeping table layout & is_blank
  const [sanitizedQ6] = sanitizeQuestionsForStudent([q6], true);
  assert.ok(sanitizedQ6.data_tables && sanitizedQ6.data_tables.length === 1);
  const blankCell = sanitizedQ6.data_tables[0].rows[2][1];
  assert.equal(blankCell.is_blank, true);
  assert.equal(blankCell.expected_answer, undefined, 'expected_answer must be stripped in Exam Mode');

  // Legacy _data_tables fallback preservation
  const legacyQ = {
    ...q6,
    id: 'legacy-table-q',
    data_tables: undefined,
    mark_scheme: {
      ...q6.mark_scheme,
      _data_tables: q6.data_tables,
    },
  };
  const [sanitizedLegacy] = sanitizeQuestionsForStudent([legacyQ], true);
  assert.ok(sanitizedLegacy.data_tables && sanitizedLegacy.data_tables.length === 1);
  assert.equal(sanitizedLegacy.data_tables[0].rows[2][1].expected_answer, undefined);

  // 3. Answer serialization & resolution for _table slot
  const answers = {
    '0_table': JSON.stringify({ 'Table 6.1-r2-c1': '350' }),
    '0_1': '$4.00',
  };
  const byId = buildAnswersByQuestionId([q6], answers);
  assert.equal(byId['pilot-q6-econ::table'], answers['0_table']);
  assert.equal(byId['pilot-q6-econ::b'], '$4.00');
  assert.equal(
    resolveStoredAnswer({
      rawAnswers: answers,
      answersByQuestionId: byId,
      questionId: q6.id,
      subId: 'table',
      index: 0,
    }),
    answers['0_table']
  );

  // 4. Deterministic grading of Q6 via Exam Mode submission re-grading
  const examSub = {
    id: 'sub_q6_test',
    quizId: 'pilot-exam',
    quizCode: 'ICM170',
    quizTitle: 'Pilot',
    subject: 'Economics',
    studentName: 'Test Student',
    studentClass: '10A',
    submittedAt: new Date().toISOString(),
    durationSeconds: 60,
    score: 0,
    totalMarks: 3,
    percentage: 0,
    violationsCount: 0,
    rawAnswers: answers,
    questionResults: [
      {
        questionId: q6.id,
        questionNumber: 1,
        questionText: q6.question_text,
        topic: q6.topic,
        maxMarks: 3,
        earnedMarks: 0,
        isCorrect: false,
        studentAnswer: '',
        correctAnswer: 'See mark scheme',
        aiFeedback: 'Awaiting examiner AI evaluation',
        subQuestionResults: [
          {
            subId: 'a',
            questionText: q6.sub_questions[0].question_text,
            studentAnswer: '',
            earnedMarks: 0,
            maxMarks: 2,
            isCorrect: false,
            feedback: 'Awaiting examiner AI evaluation',
          },
          {
            subId: 'b',
            questionText: q6.sub_questions[1].question_text,
            studentAnswer: '$4.00',
            earnedMarks: 0,
            maxMarks: 1,
            isCorrect: false,
            feedback: 'Awaiting examiner AI evaluation',
          },
        ],
      },
    ],
    topicBreakdown: {},
    status: 'submitted',
    forensics: { answersByQuestionId: byId },
  };
  const graded = gradeSubmissionDeterministically(examSub, [q6], 3);
  assert.equal(graded.changed, true);
  assert.equal(graded.updatedSub.score, 3);
  assert.equal(graded.updatedSub.questionResults[0].earnedMarks, 3);
  assert.equal(graded.updatedSub.questionResults[0].subQuestionResults[0].earnedMarks, 2);
  assert.equal(graded.updatedSub.questionResults[0].subQuestionResults[0].isCorrect, true);
  assert.equal(graded.updatedSub.questionResults[0].subQuestionResults[1].earnedMarks, 1);

  // Wrong value in table scores 0 on part (a), 1 on part (b)
  const wrongTableSub = {
    ...examSub,
    rawAnswers: { '0_table': JSON.stringify({ 'Table 6.1-r2-c1': '400' }), '0_1': '$4.00' },
    forensics: { answersByQuestionId: { 'pilot-q6-econ::table': JSON.stringify({ 'Table 6.1-r2-c1': '400' }), 'pilot-q6-econ::b': '$4.00' } },
  };
  const gradedWrong = gradeSubmissionDeterministically(wrongTableSub, [q6], 3);
  assert.equal(gradedWrong.updatedSub.score, 1);
  assert.equal(gradedWrong.updatedSub.questionResults[0].subQuestionResults[0].earnedMarks, 0);

  // 5. Standalone multi-cell fillable data_tables (e.g. Chemistry properties table)
  const standaloneTableQ = {
    id: 'chem-table-q',
    syllabus_id: '0620-chemistry',
    year: 2026,
    series: 'Pilot',
    paper_number: '2',
    question_number: '1',
    topic: 'Bonding',
    difficulty: 'Medium',
    marks: 2,
    question_style: 'Structured',
    question_text: 'Complete the table below.',
    options: null,
    sub_questions: [],
    data_tables: [
      {
        id: 'Table 1.1',
        title: 'Properties',
        headers: ['Compound', 'Formula', 'State at r.t.p.'],
        rows: [
          ['Methane', '$CH_4$', 'gas'],
          [
            'Sodium chloride',
            { value: '', is_blank: true, expected_answer: 'NaCl' },
            { value: '', is_blank: true, expected_answer: 'solid' },
          ],
        ],
      },
    ],
    mark_scheme: { marking_points: ['NaCl', 'solid'], acceptable_answers: ['NaCl', 'solid'] },
  };

  const chemFull = gradeDeterministicAnswer(
    JSON.stringify({ 'Table 1.1-r1-c1': 'NaCl', 'Table 1.1-r1-c2': 'solid' }),
    standaloneTableQ
  );
  assert.equal(chemFull.isHandled, true);
  assert.equal(chemFull.earnedMarks, 2);
  assert.equal(chemFull.isCorrect, true);

  const chemHalf = gradeDeterministicAnswer(
    JSON.stringify({ 'Table 1.1-r1-c1': 'NaCl', 'Table 1.1-r1-c2': 'liquid' }),
    standaloneTableQ
  );
  assert.equal(chemHalf.earnedMarks, 1);
  assert.equal(chemHalf.isCorrect, false);

  assert.deepEqual(parseTableCellAnswers(''), {});

  // 6. formatCandidateAnswer formats gap & table JSON maps cleanly for UI & PDF reports
  assert.equal(formatCandidateAnswer(JSON.stringify({ 'Table 6.1-r2-c1': '350' })), '350');
  assert.equal(
    formatCandidateAnswer(JSON.stringify({ 'Table 1.1-r1-c1': 'NaCl', 'Table 1.1-r1-c2': 'solid' })),
    'Table 1.1 [R2, C2]: NaCl; Table 1.1 [R2, C3]: solid'
  );
  assert.equal(
    formatCandidateAnswer(JSON.stringify({ gap_1: 'released', gap_2: 'increase', gap_3: 'negative' })),
    '[1] released; [2] increase; [3] negative'
  );

  // 7. Structural wiring checks across StudentQuizRunner & QuizResultsModal
  const runnerSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/StudentQuizRunner.tsx'), 'utf8');
  assert.ok(runnerSrc.includes('<ExamDataTable'), 'StudentQuizRunner must render ExamDataTable');
  assert.ok(runnerSrc.includes('findTableCompletionSubIndex'), 'StudentQuizRunner must map parent table completion sub-part');
  assert.ok(runnerSrc.includes('${idx}_table') || runnerSrc.includes('${qIdx}_table') || runnerSrc.includes('${currentIndex}_table'), 'StudentQuizRunner must persist _table answers');

  const resultsSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/QuizResultsModal.tsx'), 'utf8');
  assert.ok(resultsSrc.includes('findTableCompletionSubIndex'), 'QuizResultsModal AI Grade All must resolve parent _table answers');
  assert.ok(resultsSrc.includes('formatCandidateAnswer(sub.studentAnswer)'), 'QuizResultsModal must format sub-question JSON responses');

  console.log('PASS Step 4 & 5: data_tables sanitization, resolution, grading, formatting, and runner wiring tests');
}

runStep4Tests();
