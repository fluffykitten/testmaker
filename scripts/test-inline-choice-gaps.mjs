import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasInlineGaps, parseGapSegments } from '../src/lib/inlineGapParser.ts';
import {
  extractGapExpectedMap,
  gradeDeterministicAnswer,
  gradeSubmissionDeterministically,
} from '../src/services/deterministicGradingService.ts';
import { PILOT_EXAM_170_QUESTIONS } from '../src/data/pilotExam170Data.ts';

function runStep1Tests() {
  // 1. Q8 inline choice prompt detection & segmentation
  const q8Prompt = `Complete the scientific explanation regarding chemical energetics below by typing or selecting the correct terms:

During an exothermic chemical reaction, heat energy is [released|absorbed] to the surroundings. This transfer of thermal energy causes the temperature of the reaction mixture to [increase|decrease]. The overall enthalpy change ($\\Delta H$) for any exothermic reaction has a [negative|positive] value.`;

  assert.equal(hasInlineGaps(q8Prompt), true, 'Q8 pipe-choice prompt must be detected as inline gap');

  const q8Segs = parseGapSegments(q8Prompt);
  const q8Gaps = q8Segs.filter((s) => s.type === 'gap');
  assert.equal(q8Gaps.length, 3, 'Q8 should produce 3 inline choice gaps');
  assert.deepEqual(
    q8Gaps.map((g) => ({ gapId: g.gapId, gapNum: g.gapNum, choices: g.choices })),
    [
      { gapId: 'gap_1', gapNum: 1, choices: ['released', 'absorbed'] },
      { gapId: 'gap_2', gapNum: 2, choices: ['increase', 'decrease'] },
      { gapId: 'gap_3', gapNum: 3, choices: ['negative', 'positive'] },
    ]
  );

  // Ensure math block before gap 3 remained text
  const textContent = q8Segs
    .filter((s) => s.type === 'text')
    .map((s) => s.content)
    .join('');
  assert.ok(textContent.includes('($\\Delta H$)'), 'Math block should remain intact in text segments');

  // 2. Currency sign earlier in prompt must not break pipe-choice gap parsing
  const currencyChoicePrompt = 'At $4.00 per kg, the market experiences a [shortage|surplus|equilibrium].';
  assert.equal(hasInlineGaps(currencyChoicePrompt), true);
  assert.deepEqual(
    parseGapSegments(currencyChoicePrompt).filter((s) => s.type === 'gap')[0].choices,
    ['shortage', 'surplus', 'equilibrium']
  );

  // 3. Classic gap formats still work & trailing marks still ignored
  assert.equal(hasInlineGaps('The capital of France is [1] in {{2}} or [blank].'), true);
  assert.equal(hasInlineGaps('Answer is [1: Springfield].'), true);
  assert.equal(hasInlineGaps('State the equilibrium price per kilogram for organic apples. [1]'), false);
  assert.equal(hasInlineGaps('Explain your reasoning. [2 marks]'), false);
  assert.equal(hasInlineGaps('Calculate $\\left[ x | y \\right]$ value.'), false);

  // 4. Pipe choices with digits inside option text must not override sequential gap number
  const numericChoicePrompt = 'At [$2.00|$4.00] the quantity is [250|350].';
  const numGaps = parseGapSegments(numericChoicePrompt).filter((s) => s.type === 'gap');
  assert.deepEqual(
    numGaps.map((g) => ({ gapId: g.gapId, gapNum: g.gapNum, choices: g.choices })),
    [
      { gapId: 'gap_1', gapNum: 1, choices: ['$2.00', '$4.00'] },
      { gapId: 'gap_2', gapNum: 2, choices: ['250', '350'] },
    ]
  );

  console.log('PASS Step 1: inlineGapParser tests');
}

function runStep2And3Tests() {
  const q8 = PILOT_EXAM_170_QUESTIONS.find((q) => q.id === 'pilot-q8-cloze');
  assert.ok(q8, 'pilot-q8-cloze must exist in pilotExam170Data');

  // 1. Expected map must isolate Gap 1, Gap 2, Gap 3 separately
  const gapMap = extractGapExpectedMap(q8);
  assert.deepEqual(gapMap, {
    '1': ['released'],
    '2': ['increase'],
    '3': ['negative'],
  });

  // 2. All 3 correct -> 3/3 marks
  const full = gradeDeterministicAnswer(
    JSON.stringify({ gap_1: 'released', gap_2: 'increase', gap_3: 'negative' }),
    q8
  );
  assert.equal(full.isHandled, true);
  assert.equal(full.earnedMarks, 3);
  assert.equal(full.isCorrect, true);

  // 3. Partial 2/3 correct -> 2/3 marks
  const partial = gradeDeterministicAnswer(
    JSON.stringify({ gap_1: 'released', gap_2: 'decrease', gap_3: 'negative' }),
    q8
  );
  assert.equal(partial.isHandled, true);
  assert.equal(partial.earnedMarks, 2);
  assert.equal(partial.isCorrect, false);

  // 4. Swapped options must NOT earn false credit on Gap 1 / Gap 3
  const swapped = gradeDeterministicAnswer(
    JSON.stringify({ gap_1: 'negative', gap_2: 'increase', gap_3: 'released' }),
    q8
  );
  assert.equal(swapped.isHandled, true);
  assert.equal(swapped.earnedMarks, 1);
  assert.equal(swapped.isCorrect, false);

  // 5. Teacher-side Exam Mode re-grading (gradeSubmissionDeterministically) scores Q8 accurately
  const examSub = {
    id: 'sub_q8_test',
    quizId: 'pilot-exam',
    quizCode: 'ICM170',
    quizTitle: 'Pilot',
    subject: 'General',
    studentName: 'Test Student',
    studentClass: '10A',
    submittedAt: new Date().toISOString(),
    durationSeconds: 60,
    score: 0,
    totalMarks: 3,
    percentage: 0,
    violationsCount: 0,
    rawAnswers: {
      0: JSON.stringify({ gap_1: 'released', gap_2: 'increase', gap_3: 'positive' }),
    },
    questionResults: [
      {
        questionId: q8.id,
        questionNumber: 1,
        questionText: q8.question_text,
        topic: q8.topic,
        maxMarks: 3,
        earnedMarks: 0,
        isCorrect: false,
        studentAnswer: JSON.stringify({ gap_1: 'released', gap_2: 'increase', gap_3: 'positive' }),
        correctAnswer: 'See mark scheme',
        aiFeedback: 'Awaiting examiner AI evaluation',
      },
    ],
    topicBreakdown: {},
    status: 'submitted',
    forensics: {
      answersByQuestionId: {
        [q8.id]: JSON.stringify({ gap_1: 'released', gap_2: 'increase', gap_3: 'positive' }),
      },
    },
  };
  const graded = gradeSubmissionDeterministically(examSub, [q8], 3);
  assert.equal(graded.changed, true);
  assert.equal(graded.updatedSub.score, 2);
  assert.equal(graded.updatedSub.questionResults[0].earnedMarks, 2);
  assert.equal(graded.updatedSub.questionResults[0].isCorrect, false);

  // 6. Closed-set choice gap rejects fuzzy typo confusion (e.g. increase vs increased)
  const closeSpellQ = {
    ...q8,
    id: 'close-spell-q',
    question_style: 'Structured',
    marks: 1,
    question_text: 'The rate will [increase|increased].',
    mark_scheme: {
      marking_points: ['Gap 1: increased'],
      acceptable_answers: ['increased'],
    },
  };
  const falseFuzzy = gradeDeterministicAnswer(JSON.stringify({ gap_1: 'increase' }), closeSpellQ);
  assert.equal(falseFuzzy.earnedMarks, 0, 'Closed choice "increase" must not match "increased"');

  // 7. Positional fallback when only acceptable_answers array matches gap count
  const noPrefixQ = {
    ...q8,
    id: 'no-prefix-q',
    question_style: 'Structured',
    marks: 2,
    question_text: 'Enthalpy change is [negative|positive] when heat is [released|absorbed].',
    mark_scheme: {
      marking_points: [],
      acceptable_answers: ['negative', 'released'],
    },
  };
  const noPrefixGrade = gradeDeterministicAnswer(
    JSON.stringify({ gap_1: 'negative', gap_2: 'released' }),
    noPrefixQ
  );
  assert.equal(noPrefixGrade.earnedMarks, 2);
  assert.equal(noPrefixGrade.isCorrect, true);

  // 8. InlineGapText & StudentQuizRunner structural wiring checks
  const inlineGapComp = fs.readFileSync(path.resolve(process.cwd(), 'src/components/InlineGapText.tsx'), 'utf8');
  assert.ok(inlineGapComp.includes('sq-gap-select'), 'InlineGapText must render sq-gap-select for pipe choices');

  const runner = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/StudentQuizRunner.tsx'), 'utf8');
  assert.ok(runner.includes('hasInlineGaps(promptText)'), 'StudentQuizRunner must gate on hasInlineGaps');

  console.log('PASS Steps 2 & 3: InlineGapText UI & deterministic choice grading tests');
}

runStep1Tests();
runStep2And3Tests();

