if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

import {
  PILOT_SIM_PART2_ID,
  PILOT_SIM_PART2_AUDIO_TITLE,
  PILOT_SIM_PART2_QUESTIONS,
  PILOT_SIM_PART2_TOTAL_MARKS,
} from '../src/data/pilotExamPart2Data.ts';
import { getPublishedQuizzes } from '../src/services/quizManagerService.ts';
import {
  getLocalTests,
  fetchCustomTestWithQuestions,
  recordDeletedTestId,
} from '../src/services/testBuilderService.ts';

console.log('Testing ICM Exam Simulation Part 2 (Saved Tests)...\n');

let passed = 0;
function check(name, cond) {
  if (cond) {
    console.log(`PASS  ${name}`);
    passed++;
  } else {
    console.error(`FAIL  ${name}`);
    process.exit(1);
  }
}

// 1. Saved Tests auto-seeding
const savedTests = getLocalTests();
const foundInSaved = savedTests.find((t) => t.id === PILOT_SIM_PART2_ID);
check(
  '1. getLocalTests() auto-seeds ICM Exam Simulation Part 2 into Saved Tests',
  Boolean(foundInSaved && foundInSaved.title === 'ICM Exam Simulation Part 2')
);

// 2. Not auto-published into Quiz Manager
const publishedList = getPublishedQuizzes();
const foundInPublished = publishedList.find(
  (q) => q.id === PILOT_SIM_PART2_ID || q.testId === PILOT_SIM_PART2_ID
);
check(
  '2. Saved Test is NOT auto-published into Quiz Manager by default',
  !foundInPublished
);

// 3. fetchCustomTestWithQuestions resolves cleanly
const resolved = await fetchCustomTestWithQuestions(PILOT_SIM_PART2_ID);
const test = resolved?.test;
const questions = resolved?.questions || [];
const sumMarks = questions.reduce((acc, q) => acc + (Number(q.marks) || 0), 0);

check(
  '3. fetchCustomTestWithQuestions resolves test metadata (30 min, 30 marks, Cambridge header)',
  Boolean(
    test &&
      test.title === 'ICM Exam Simulation Part 2' &&
      test.total_marks === 30 &&
      test.header_config?.durationMinutes === 30 &&
      test.header_config?.subjectCode === '0002' &&
      test.header_config?.schoolName === 'Insan Cendekia Madani'
  )
);

check(
  '4. Exactly 12 questions totaling 30 marks',
  questions.length === 12 &&
    PILOT_SIM_PART2_QUESTIONS.length === 12 &&
    sumMarks === 30 &&
    PILOT_SIM_PART2_TOTAL_MARKS === 30
);

// 4. Question variety & features
const styles = new Set(questions.map((q) => q.question_style));
check(
  '5. Covers Multiple Choice, Multiple Select, Fill in the Blank, and Structured styles',
  styles.has('Multiple Choice') &&
    styles.has('Multiple Select') &&
    styles.has('Fill in the Blank') &&
    styles.has('Structured')
);

check(
  '6. Q1 Chem Periodic Table MCQ (Na) & Q2 Phys GPE Calculator MCQ',
  questions[0]?.question_style === 'Multiple Choice' &&
    questions[0]?.question_text.includes('Sodium') &&
    questions[1]?.question_style === 'Multiple Choice' &&
    questions[1]?.question_text.includes('850')
);

check(
  '7. Q3 Audio MCQ carries dynamic libraryLookupTitle "0L1 my room"',
  questions[2]?.question_style === 'Multiple Choice' &&
    questions[2]?.audio_metadata?.libraryLookupTitle === PILOT_SIM_PART2_AUDIO_TITLE
);

check(
  '8. Q4 Biology includes SVG diagram & Q5 Geography includes Fig. 5.2 Resource Booklet',
  Boolean(questions[3]?.svg_content) &&
    Boolean(questions[4]?.svg_content) &&
    questions[4]?.resource_ref === 'Fig. 5.2' &&
    Array.isArray(questions[4]?.mark_scheme?._insert_resources) &&
    questions[4].mark_scheme._insert_resources.some((r) => r.id === 'Fig. 5.2')
);

check(
  '9. Q6 Economics Data Table, Q7 Multiple Select, Q8 Cloze Fill in the Blank',
  Array.isArray(questions[5]?.data_tables) &&
    questions[5].data_tables.length > 0 &&
    questions[6]?.question_style === 'Multiple Select' &&
    questions[7]?.question_style === 'Fill in the Blank' &&
    questions[7].question_text.includes('[chlorine|oxygen]')
);

check(
  '10. Q9 Arabic RTL & Q10 Bahasa Indonesia comprehension',
  /[\u0600-\u06FF]/.test(questions[8]?.question_text || '') &&
    questions[9]?.question_text.includes('hutan mangrove')
);

check(
  '11. Q11 Math Structured multi-part with [no_passage] and 2 sub_questions',
  questions[10]?.question_style === 'Structured' &&
    questions[10].question_text.includes('[no_passage]') &&
    Array.isArray(questions[10].sub_questions) &&
    questions[10].sub_questions.length === 2
);

const q12Text = questions[11]?.question_text || '';
const passageMatch = q12Text.match(/\[passage\]([\s\S]*?)\[\/passage\]/i);
const passageLen = passageMatch ? passageMatch[1].trim().length : 0;
check(
  '12. Q12 English Structured split-view passage (>= 600 chars) + 80-word target',
  questions[11]?.question_style === 'Structured' &&
    passageLen >= 600 &&
    /Write at least 80 words/i.test(q12Text)
);

// 5. Tombstone deletion works cleanly
recordDeletedTestId(PILOT_SIM_PART2_ID);
const afterDelete = getLocalTests();
check(
  '13. Deleting via recordDeletedTestId removes Part 2 without re-seeding it',
  !afterDelete.some((t) => t.id === PILOT_SIM_PART2_ID)
);
globalThis.localStorage.clear();

console.log(`\nAll ${passed} checks passed!`);
