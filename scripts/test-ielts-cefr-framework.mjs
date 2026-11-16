import assert from 'node:assert/strict';
import fs from 'node:fs';

if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor() {
      this.a = 1;
      this.b = 0;
      this.c = 0;
      this.d = 1;
      this.e = 0;
      this.f = 0;
    }
  };
}

const { classifySubject } = await import('../src/lib/subjectClassifier.ts');
const { getIeltsCefrExtractionPrompt } = await import('../src/lib/ieltsPrompt.ts');
const { getExtractionPrompt } = await import('../src/lib/gemini.ts');
const { stitchPassagesToQuestions } = await import('../src/lib/passageExtractor.ts');
const { gradeDeterministicAnswer } = await import('../src/services/deterministicGradingService.ts');
const { buildExaminerPrompt } = await import('../src/services/aiGradingService.ts');
const {
  roundIeltsBand,
  listeningMarksToBand,
  readingMarksToBand,
  productiveMarksToBand,
  mapBandToCefr,
  computeIeltsCefrProfile,
} = await import('../src/utils/ieltsScoringUtils.ts');

function testClassifierAndPromptIsolation() {
  const cefrMatch = classifySubject([
    'CEFR Test Set English Subject AY 2026/2027',
    'General Instructions: CEFR Test English subject Grade 12 Listening 20 questions, 2 reading passages, writing.',
  ]);
  assert.ok(cefrMatch, 'CEFR paper should be recognized');
  assert.equal(cefrMatch.profile.domain, 'languages');
  assert.equal(cefrMatch.profile.isIeltsCefr, true);

  // Regular Indonesian TKA / default languages prompt remains untouched when isIeltsCefr is false
  const defaultLangPrompt = getExtractionPrompt(true, 'languages', false, true, true, false, undefined, undefined, undefined, undefined, false);
  const ieltsPrompt = getExtractionPrompt(true, 'languages', false, true, true, false, undefined, undefined, undefined, undefined, true);
  assert.ok(defaultLangPrompt.includes('Pilihan Ganda Kompleks'), 'Default languages prompt must preserve TKA rules');
  assert.ok(!defaultLangPrompt.includes('SKILL SECTION PREFIXING'), 'Default languages prompt must stay isolated from IELTS rules');
  assert.ok(ieltsPrompt.includes('SKILL SECTION PREFIXING'), 'IELTS prompt must enforce L/R/W prefixes');
  assert.equal(ieltsPrompt, getIeltsCefrExtractionPrompt(true));

  console.log('PASS 1: Classifier & prompt isolation');
}

function testPassageStitchingIsolation() {
  const passages = [
    {
      id: 'Passage 1',
      heading: 'The development of the London underground railway',
      body: 'A'.repeat(250),
      page_number: 6,
      target_questions: ['1', '2', '3', '4', '5', '6', '7', '11'],
    },
  ];
  const questions = [
    {
      question_number: 'L11',
      question_text: 'What is the maximum number of people who can stand on each side of the boat?',
      question_style: 'Multiple Choice',
      total_marks: 1,
      passage_ref: null,
      topic: 'Listening - Multiple Choice',
      options: ['A. 9', 'B. 15', 'C. 18'],
      sub_questions: [],
      mark_scheme: { acceptable_answers: ['A'], marking_points: ['A [1]'] },
    },
    {
      question_number: 'R11',
      question_text: 'The windows on City & South London trains were at eye level.',
      question_style: 'Multiple Choice',
      total_marks: 1,
      passage_ref: null,
      topic: 'Reading - True/False/Not Given',
      options: ['A. TRUE', 'B. FALSE', 'C. NOT GIVEN'],
      sub_questions: [],
      mark_scheme: { acceptable_answers: ['B'], marking_points: ['B [1]'] },
    },
  ];

  const stitched = stitchPassagesToQuestions(questions, passages);
  assert.equal(stitched[0].passage_ref, null, 'Listening L11 must NEVER inherit Reading Passage 1 via target_questions');
  assert.ok(!stitched[0].question_text.includes('AAA'), 'Listening stem must not contain Passage body');
  assert.equal(stitched[1].passage_ref, 'Passage 1', 'Reading R11 should link to Passage 1');
  assert.ok(stitched[1].question_text.includes('AAA'), 'Reading R11 should include Passage 1');

  console.log('PASS 2: Passage stitching isolation (L vs R)');
}

function testIeltsDeterministicGrading() {
  // 1. Choose TWO letters (2 marks -> 1 mark per correct letter when <= 2 letters picked)
  const twoLetterQ = {
    id: 'q-l15-16',
    question_number: 'L15-16',
    question_text: 'Which TWO features of the lighthouse does Lou mention?',
    question_style: 'Multiple Select',
    options: ['A. why it was built', 'B. who built it', 'C. how long it took', 'D. who staffed it', 'E. what it was built with'],
    marks: 2,
    topic: 'Listening - Multiple Select',
    mark_scheme: { acceptable_answers: ['A, E'], marking_points: ['A, E [2]'] },
  };
  assert.equal(gradeDeterministicAnswer('A, E', twoLetterQ).earnedMarks, 2);
  assert.equal(gradeDeterministicAnswer('A, C', twoLetterQ).earnedMarks, 1);
  assert.equal(gradeDeterministicAnswer('A, B, C, D, E', twoLetterQ).earnedMarks, 0, 'Over-selection (>2 letters) must earn 0');

  // 2. Reading ONE WORD ONLY & non-1-based gaps [18]..[22]
  const summaryQ = {
    id: 'q-r18-22',
    question_number: 'R18-22',
    question_text:
      'Complete the summary below.\nChoose ONE WORD ONLY from the passage for each answer.\nThe amphitheatre was a [18], where people watched [19]. Verona hosted [20]. Lucca stored [21] and has [22].',
    question_style: 'Fill in the Blank',
    marks: 5,
    topic: 'Reading - Summary Completion',
    mark_scheme: {
      acceptable_answers: ['[18] fortress', '[19] bullfights', '[20] opera', '[21] salt', '[22] shops'],
      marking_points: ['[18] fortress [1]', '[19] bullfights [1]', '[20] opera [1]', '[21] salt [1]', '[22] shops [1]'],
    },
  };
  const allCorrect = gradeDeterministicAnswer(
    JSON.stringify({ gap_18: 'fortress', gap_19: 'bullfights', gap_20: 'opera', gap_21: 'salt', gap_22: 'shops' }),
    summaryQ
  );
  assert.equal(allCorrect.earnedMarks, 5);
  assert.equal(allCorrect.isCorrect, true);

  // Exceeding ONE WORD ONLY ("stone fortress") or spelling typo ("fortres") must NOT earn credit under IELTS rule
  const limitViolation = gradeDeterministicAnswer(
    JSON.stringify({ gap_18: 'stone fortress', gap_19: 'bullfightz', gap_20: '12', gap_21: 'salt', gap_22: 'shops' }),
    summaryQ
  );
  assert.equal(limitViolation.earnedMarks, 2, 'Only salt and shops should score when others violate ONE WORD ONLY / exact spelling');

  // 3. Listening ONE WORD AND/OR A NUMBER
  const listeningNotesQ = {
    id: 'q-l1-10',
    question_number: 'L1-10',
    question_text: 'Write ONE WORD AND/OR A NUMBER for each answer.\n- no [1]\n- cost: £ [2]',
    question_style: 'Fill in the Blank',
    marks: 2,
    topic: 'Listening - Note Completion',
    mark_scheme: {
      acceptable_answers: ['[1] litter', '[2] 10'],
      marking_points: ['[1] litter [1]', '[2] 10 [1]'],
    },
  };
  assert.equal(gradeDeterministicAnswer(JSON.stringify({ gap_1: 'litter', gap_2: '10' }), listeningNotesQ).earnedMarks, 2);
  assert.equal(
    gradeDeterministicAnswer(JSON.stringify({ gap_1: 'plastic litter bags', gap_2: '10' }), listeningNotesQ).earnedMarks,
    1,
    '3 words exceeds ONE WORD AND/OR A NUMBER'
  );

  console.log('PASS 3: Deterministic grading (Choose TWO partial credit, ONE WORD ONLY, non-1-based gaps)');
}

function testIeltsCefrScoringAndAiPrompt() {
  // Worked examples from PDF p. 20
  assert.equal(roundIeltsBand((6.5 + 6.5 + 5.0 + 7.0) / 4), 6.5);
  assert.equal(roundIeltsBand((7.0 + 6.5 + 6.5 + 7.0) / 4), 7.0);
  assert.equal(roundIeltsBand((7.5 + 8.0 + 7.0 + 7.0) / 4), 7.5);

  // CEFR boundaries (PDF pp. 21-23)
  assert.equal(mapBandToCefr(8.5).code, 'C2');
  assert.equal(mapBandToCefr(7.5).code, 'C1');
  assert.equal(mapBandToCefr(6.0).code, 'B2');
  assert.equal(mapBandToCefr(4.5).code, 'B1');
  assert.equal(mapBandToCefr(3.5).code, 'A2');
  assert.equal(mapBandToCefr(2.0).code, 'A1');

  // Listening / Reading table spot checks (PDF p. 18)
  assert.equal(listeningMarksToBand(30, 40).band, 7.0);
  assert.equal(readingMarksToBand(30, 40).band, 7.0);
  assert.equal(readingMarksToBand(32, 40).band, 7.0);
  assert.equal(listeningMarksToBand(18, 40).band, 5.5);
  assert.equal(readingMarksToBand(18, 40).band, 5.0);
  // Scaled mini-IELTS (15/20 Listening -> 30/40 eq -> 7.0)
  assert.equal(listeningMarksToBand(15, 20).band, 7.0);
  assert.equal(productiveMarksToBand(30, 40), 7.0);

  // Full 3-skill mini-IELTS aggregation (Listening + Reading + Writing, Speaking excluded)
  const profile = computeIeltsCefrProfile([
    { topic: 'Listening - Note Completion', earnedMarks: 16, maxMarks: 20 },
    { topic: 'Reading - True/False/Not Given', earnedMarks: 17, maxMarks: 22 },
    { topic: 'Writing - Task 2 Essay', earnedMarks: 29, maxMarks: 40 },
  ]);
  assert.ok(profile, '3-skill mini-IELTS should produce a profile');
  assert.equal(profile.skills.length, 3);
  assert.equal(profile.isPartialAssessment, true);
  assert.ok(profile.overallBand >= 6.0 && profile.overallBand <= 8.0);

  // Single-skill STEM test must NOT get an IELTS profile
  assert.equal(computeIeltsCefrProfile([{ topic: 'Stoichiometry', earnedMarks: 8, maxMarks: 10 }]), null);

  // AI Writing examiner prompt word count telemetry
  const prompt = buildExaminerPrompt(
    'Some children spend hours every day on their smartphones. Write at least 250 words.',
    40,
    { marking_points: ['Task Achievement (25%) [10]', 'Coherence and Cohesion (25%) [10]'] },
    undefined,
    undefined,
    undefined,
    'Short answer with only ten words written by candidate.'
  );
  assert.ok(prompt.includes('Candidate wrote 9 words'), 'Examiner prompt should include candidate word count');
  assert.ok(prompt.includes('UNDER LENGTH'), 'Examiner prompt should flag under-length (<250) essays');

  console.log('PASS 4: IELTS Band, CEFR mapping & AI examiner word-count telemetry');
}

function testRunnerAndUiWiring() {
  const uploadTsx = fs.readFileSync('c:/testmaker/src/components/PdfUpload.tsx', 'utf8');
  assert.ok(uploadTsx.includes('ielts-cefr-toggle'), 'PdfUpload must include IELTS / CEFR option under Languages');
  const runnerTsx = fs.readFileSync('c:/testmaker/src/pages/StudentQuizRunner.tsx', 'utf8');
  assert.ok(runnerTsx.includes('sq-reading-split-grid'), 'StudentQuizRunner must include side-by-side reading split layout');
  assert.ok(runnerTsx.includes('isWritingEssayTask'), 'StudentQuizRunner must include Writing essay word-target editor');
  console.log('PASS 5: UI wiring verified');
}

testClassifierAndPromptIsolation();
testPassageStitchingIsolation();
testIeltsDeterministicGrading();
testIeltsCefrScoringAndAiPrompt();
testRunnerAndUiWiring();
console.log('\nALL IELTS / CEFR FRAMEWORK CHECKS PASSED!');
