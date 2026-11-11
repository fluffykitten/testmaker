if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

import assert from 'node:assert';
import { resolveStudentQuiz } from '../src/services/quizCodeService.ts';
import { PILOT_QUIZ_CODE, PILOT_EXAM_170_QUESTIONS } from '../src/data/pilotExam170Data.ts';
import { getPublishedQuizzes } from '../src/services/quizManagerService.ts';

console.log('🧪 Testing Pilot Exam (ICM170) Resolution & Integrity...\n');

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

// 1. getPublishedQuizzes includes ICM170
const publishedList = getPublishedQuizzes();
const foundInList = publishedList.find((q) => q.quizCode === PILOT_QUIZ_CODE);
check('1. getPublishedQuizzes() auto-seeds ICM170 by default', Boolean(foundInList));

// 2. resolveStudentQuiz('ICM170') resolves cleanly
const exam = await resolveStudentQuiz('ICM170');
check('2. resolveStudentQuiz("ICM170") returns valid StudentQuizData', Boolean(exam));
check('3. Quiz Code is ICM170', exam.quizCode === 'ICM170');
check('4. Duration is 20 minutes', exam.durationMinutes === 20);
check('5. Exam Mode is active with security enabled', exam.isExamMode === true && exam.securityEnabled === true);
check('6. Built-in tools are enabled (Calculator, Periodic Table, Scratchpad)', 
  exam.allowCalculator === true &&
  exam.calculatorType === 'scientific' &&
  exam.allowPeriodicTable === true &&
  exam.allowScratchpad === true
);
check('7. Plaintext teacherPin is stripped and teacherPinHash is populated',
  !(exam.headerConfig && 'teacherPin' in exam.headerConfig && exam.headerConfig.teacherPin) &&
  Boolean(exam.teacherPinHash)
);

// 8. Exactly 10 questions returned
check('8. Exam contains exactly 10 questions', exam.questions.length === 10);

// 9. Questions are in correct curriculum order
check('9. Q1 is Chemistry (Periodic table lookup)', exam.questions[0].topic.includes('Periodic Table'));
check('10. Q2 is Physics (Calculation)', exam.questions[1].question_style === 'Calculation');
check('11. Q3 is English Listening with audio stream', Boolean(exam.questions[2].audio_url));
check('12. Q4 is Biology with leaf anatomy SVG', exam.questions[3].svg_content?.includes('Transverse Section of a Dicotyledonous Leaf'));
check('13. Q5 is Geography with Resource Booklet Fig 5.1', exam.questions[4].resource_ref === 'Fig. 5.1');
check('14. Q6 is Economics with interactive data table', Array.isArray(exam.questions[5].data_tables) && exam.questions[5].data_tables.length > 0);
check('15. Q7 is Multi-Select question', exam.questions[6].question_style === 'Multiple Select');
check('16. Q8 is Fill in the Blank cloze question', exam.questions[7].question_style === 'Fill in the Blank');
check('17. Q9 is Arabic language question with Arabic options', exam.questions[8].options?.[0]?.includes('ذَهَبَ'));
check('18. Q10 is Bahasa Indonesia reading comprehension', exam.questions[9].question_text?.includes('Fotosintesis'));

console.log(`\n🎉 All ${passed} pilot exam tests passed successfully!`);
