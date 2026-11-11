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
import fs from 'node:fs';
import path from 'node:path';
import { resolveStudentQuiz } from '../src/services/quizCodeService.ts';
import { PILOT_QUIZ_CODE, PILOT_EXAM_ID, PILOT_EXAM_170_QUESTIONS } from '../src/data/pilotExam170Data.ts';
import { getPublishedQuizzes } from '../src/services/quizManagerService.ts';
import { getLocalTests, fetchCustomTestWithQuestions } from '../src/services/testBuilderService.ts';
import { detectMultiMonitor } from '../src/utils/examSecurityUtils.ts';

console.log('🧪 Testing Pilot Exam (ICM170) Resolution, Saved Tests & Integrity...\n');

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

// 2. Saved Tests: getLocalTests includes pilot exam
const savedTests = getLocalTests();
const foundInSaved = savedTests.find((t) => t.id === PILOT_EXAM_ID);
check('2. getLocalTests() auto-seeds ICM170 into Saved Tests dashboard', Boolean(foundInSaved));

// 3. fetchCustomTestWithQuestions resolves pilot exam with all 10 questions
const customTestResult = await fetchCustomTestWithQuestions(PILOT_EXAM_ID);
check('3. fetchCustomTestWithQuestions(PILOT_EXAM_ID) returns valid test and 10 questions',
  Boolean(customTestResult && customTestResult.questions.length === 10)
);

// 4. resolveStudentQuiz('ICM170') resolves cleanly
const exam = await resolveStudentQuiz('ICM170');
check('4. resolveStudentQuiz("ICM170") returns valid StudentQuizData', Boolean(exam));
check('5. Quiz Code is ICM170', exam.quizCode === 'ICM170');
check('6. Duration is 20 minutes and total marks is 22', exam.durationMinutes === 20 && exam.totalMarks === 22);
check('7. Exam Mode is active with security enabled', exam.isExamMode === true && exam.securityEnabled === true);
check('8. Built-in tools are enabled (Calculator, Periodic Table, Scratchpad)', 
  exam.allowCalculator === true &&
  exam.calculatorType === 'scientific' &&
  exam.allowPeriodicTable === true &&
  exam.allowScratchpad === true
);
check('9. Plaintext teacherPin is stripped and teacherPinHash is populated',
  !(exam.headerConfig && 'teacherPin' in exam.headerConfig && exam.headerConfig.teacherPin) &&
  Boolean(exam.teacherPinHash)
);

// 10. Exactly 10 questions returned
check('10. Exam contains exactly 10 questions', exam.questions.length === 10);

// 11. Question types verification
check('11. Q1 is Chemistry MCQ (Periodic table lookup)', 
  exam.questions[0].question_style === 'Multiple Choice' &&
  exam.questions[0].topic.includes('Periodic Table')
);

check('12. Q2 is Physics MCQ (Calculation converted to MCQ with 4 options)', 
  exam.questions[1].question_style === 'Multiple Choice' &&
  exam.questions[1].options?.length === 4 &&
  exam.questions[1].options[2].includes('375,000 J')
);

check('13. Q3 is English Listening with local speech audio track (/audio/pilot-english-listening.wav)', 
  exam.questions[2].question_style === 'Multiple Choice' &&
  exam.questions[2].audio_url === '/audio/pilot-english-listening.wav' &&
  exam.questions[2].audio_metadata?.duration === 19
);

check('14. Q4 is Biology MCQ (Transverse leaf anatomy converted to MCQ with SVG)', 
  exam.questions[3].question_style === 'Multiple Choice' &&
  exam.questions[3].options?.length === 4 &&
  Boolean(exam.questions[3].svg_content?.includes('Transverse Section of a Dicotyledonous Leaf'))
);

check('15. Q5 is Geography MCQ (Topographic contours converted to MCQ with Resource Booklet Fig 5.1)', 
  exam.questions[4].question_style === 'Multiple Choice' &&
  exam.questions[4].options?.length === 4 &&
  exam.questions[4].resource_ref === 'Fig. 5.1'
);

check('16. Q6 is Economics Structured with interactive data table (last short/structured question)', 
  exam.questions[5].question_style === 'Structured' &&
  Array.isArray(exam.questions[5].data_tables) &&
  exam.questions[5].data_tables.length > 0 &&
  exam.questions[5].sub_questions.length > 0
);

check('17. Q7 is Multi-Select question', exam.questions[6].question_style === 'Multiple Select');
check('18. Q8 is Fill in the Blank cloze question', exam.questions[7].question_style === 'Fill in the Blank');
check('19. Q9 is Arabic language MCQ with Arabic options', 
  exam.questions[8].question_style === 'Multiple Choice' &&
  exam.questions[8].options?.[0]?.includes('ذَهَبَ')
);
check('20. Q10 is Bahasa Indonesia reading comprehension', 
  exam.questions[9].question_style === 'Multiple Choice' &&
  exam.questions[9].question_text?.includes('Fotosintesis')
);

// 21. Audio file presence & non-zero size
const audioPath = path.resolve('public/audio/pilot-english-listening.wav');
check('21. Local audio file exists and has valid speech waveform (> 500 KB)', 
  fs.existsSync(audioPath) && fs.statSync(audioPath).size > 500000
);

// 22. Pilot exam matches school default (no window-management surprises)
check('22. Pilot exam sets enableMultiMonitorDetection: false by default',
  exam.enableMultiMonitorDetection === false
);

// 23-24. detectMultiMonitor permission-prompt safety regression tests
let screenDetailsPromptTriggered = false;
const origNav = globalThis.navigator;
try {
  globalThis.screen = { width: 1920, height: 1080, isExtended: false };
  globalThis.window = {
    screen: globalThis.screen,
    screenLeft: 0,
    screenTop: 0,
    outerWidth: 1920,
    getScreenDetails: async () => {
      screenDetailsPromptTriggered = true;
      return { screens: [{}, {}] };
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      permissions: {
        query: async () => ({ state: 'prompt' }),
      },
    },
  });

  const singleRes = await detectMultiMonitor();
  check('23. detectMultiMonitor() NEVER triggers getScreenDetails() popup when permission is prompt',
    screenDetailsPromptTriggered === false && singleRes.isMultiMonitor === false
  );

  globalThis.screen.isExtended = true;
  const extendedRes = await detectMultiMonitor();
  check('24. detectMultiMonitor() silently detects extended monitor via screen.isExtended without prompting',
    screenDetailsPromptTriggered === false && extendedRes.isMultiMonitor === true
  );
} finally {
  delete globalThis.window;
  delete globalThis.screen;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNav });
}

console.log(`\n🎉 All ${passed} pilot exam tests passed successfully!`);
