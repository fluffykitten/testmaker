import assert from 'node:assert/strict';
import { gradeDeterministicAnswer } from '../src/services/deterministicGradingService.ts';
import {
  getOfflineGradingColumns,
  gradeOfflineSubmissions,
} from '../src/services/offlineGradingService.ts';

function runTests() {
  const multiQ2Marks = {
    id: 'ms-1',
    question_number: '1',
    question_text: '[Multiple Select] Which TWO statements are true about ionic bonding?',
    question_style: 'Multiple Select',
    options: [
      'A. Electrons are shared equally',
      'B. Electrons are transferred from metal to non-metal',
      'C. High melting point due to strong electrostatic forces',
      'D. Low boiling point',
    ],
    marks: 2,
    topic: 'Chemical Bonding',
    mark_scheme: {
      acceptable_answers: ['B, C'],
      marking_points: ['B, C [2]'],
    },
  };

  // 1. Exact match -> full marks
  const exact = gradeDeterministicAnswer('C, B', multiQ2Marks);
  assert.equal(exact.isHandled, true);
  assert.equal(exact.earnedMarks, 2);
  assert.equal(exact.isCorrect, true);

  // 2. Partial subset -> 0 marks (strict all-or-nothing)
  const partialOnly = gradeDeterministicAnswer('B', multiQ2Marks);
  assert.equal(partialOnly.isHandled, true);
  assert.equal(partialOnly.earnedMarks, 0, 'Missing one required choice must earn 0');
  assert.equal(partialOnly.isCorrect, false);

  // 3. One right + one wrong within target count -> 0 marks
  const mixed = gradeDeterministicAnswer('A, B', multiQ2Marks);
  assert.equal(mixed.isHandled, true);
  assert.equal(mixed.earnedMarks, 0, 'Selecting one right and one wrong must earn 0');
  assert.equal(mixed.isCorrect, false);
  assert.match(mixed.feedback || '', /All selections must be correct to earn marks \(0\/2\)/);

  // 4. All right + one extra wrong -> 0 marks
  const extra = gradeDeterministicAnswer('A, B, C', multiQ2Marks);
  assert.equal(extra.isHandled, true);
  assert.equal(extra.earnedMarks, 0, 'Over-selecting must earn 0');
  assert.equal(extra.isCorrect, false);

  // 5. Three-target Multi-Select -> strict all-or-nothing even when 2/3 match
  const multiQ3Marks = {
    ...multiQ2Marks,
    id: 'ms-2',
    marks: 3,
    options: ['A. 1', 'B. 2', 'C. 3', 'D. 4', 'E. 5'],
    mark_scheme: { acceptable_answers: ['A; C; E'], marking_points: ['A; C; E [3]'] },
  };
  assert.equal(gradeDeterministicAnswer('A, C, E', multiQ3Marks).earnedMarks, 3);
  assert.equal(gradeDeterministicAnswer('A, C', multiQ3Marks).earnedMarks, 0);
  assert.equal(gradeDeterministicAnswer('A, C, D', multiQ3Marks).earnedMarks, 0);

  console.log('PASS  Deterministic Multiple Select grading enforces strict all-or-nothing');
}

async function runOfflineTests() {
  const questions = [
    {
      id: 'ms-offline-1',
      question_number: '1',
      question_text: 'Select all noble gases.',
      question_style: 'Multiple Select',
      options: ['A. Helium', 'B. Nitrogen', 'C. Neon', 'D. Oxygen'],
      marks: 2,
      topic: 'Periodic Table',
      mark_scheme: { acceptable_answers: ['A, C'], marking_points: ['A, C [2]'] },
    },
  ];

  const columns = getOfflineGradingColumns(questions);
  assert.equal(columns.length, 1);
  assert.equal(columns[0].questionStyle, 'Multiple Select');
  assert.equal(columns[0].referenceAnswer, 'A, C');

  const graded = await gradeOfflineSubmissions(
    [
      {
        rowNumber: 1,
        studentName: 'Exact Student',
        studentClass: '10-A',
        candidateNumber: '001',
        answers: { 'ms-offline-1': 'C, A' },
      },
      {
        rowNumber: 2,
        studentName: 'One Wrong Student',
        studentClass: '10-A',
        candidateNumber: '002',
        answers: { 'ms-offline-1': 'A, B' },
      },
      {
        rowNumber: 3,
        studentName: 'Partial Student',
        studentClass: '10-A',
        candidateNumber: '003',
        answers: { 'ms-offline-1': 'A' },
      },
    ],
    columns,
    'Offline Multi-Select Check',
    'Chemistry'
  );

  assert.equal(graded[0].score, 2);
  assert.equal(graded[0].questionResults[0].earnedMarks, 2);
  assert.equal(graded[0].questionResults[0].isCorrect, true);
  assert.equal(graded[1].score, 0, 'Offline A, B vs A, C must earn 0');
  assert.equal(graded[1].questionResults[0].earnedMarks, 0);
  assert.equal(graded[1].questionResults[0].isCorrect, false);
  assert.equal(graded[2].score, 0, 'Offline A vs A, C must earn 0');
  assert.equal(graded[2].questionResults[0].earnedMarks, 0);
  assert.equal(graded[2].questionResults[0].isCorrect, false);

  console.log('PASS  Offline Excel Multiple Select grading routes through strict all-or-nothing');
}

runTests();
await runOfflineTests();
process.exit(0);
