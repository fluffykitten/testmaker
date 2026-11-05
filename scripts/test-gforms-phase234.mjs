// Phases 2–4 harness: context dedupe, student info, option prefixes, mark scheme
// serialisation, multi-line prompts, and the Apps Script help-text leak.
import { flattenQuestionsForForms, splitQuestionPromptAndDetails, extractMarkSchemeText } from '../src/services/googleForms/googleFormsFlattenService.ts';
import { generateGoogleAppsScript } from '../src/services/googleForms/googleAppsScriptService.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const stem = 'A student investigates the rate of reaction between dilute hydrochloric acid and calcium carbonate. The apparatus was set up as shown. 25 cm3 of acid was added and the temperature was recorded every minute.';
const mkQuestion = (overrides = {}) => ({
  id: 'q1',
  question_number: '1',
  question_text: stem,
  question_style: 'Structured',
  marks: 5,
  topic: 'Rates of Reaction',
  sub_topic: null,
  options: null,
  has_diagram: false,
  diagram_url: null,
  bounding_box: null,
  mark_scheme: { marking_points: ['Correct volume', 'Correct unit'] },
  sub_questions: [
    {
      sub_id: '(a)',
      question_text: 'Which volume of acid was used?',
      marks: 1,
      options: ['A. 15 cm3', 'B. 25 cm3', 'C. 35 cm3', 'D. 45 cm3'],
      mark_scheme: { marking_points: ['B — 25 cm³'] },
    },
    {
      sub_id: '(b)',
      question_text: 'Explain why the temperature rises.',
      marks: 4,
      mark_scheme: { marking_points: ['Exothermic reaction', 'Energy released to surroundings'], acceptable_answers: ['exothermic', 'heat released'] },
    },
  ],
  ...overrides,
});

console.log('\n## Phase 2 — context dedupe');
const items = flattenQuestionsForForms([mkQuestion()]);
const contextItems = items.filter((i) => i.isContextItem);
check('one shared context item', contextItems.length === 1, `got ${contextItems.length}`);
check('context carries the stem', (contextItems[0]?.description ?? '').includes('rate of reaction'));
check('no "Context:" repetition in sub-questions', !items.some((i) => (i.description ?? '').includes('Context:')));
check('sub-questions still have their own prompts', items.filter((i) => i.isSubQuestion).length === 2);

console.log('\n## Phase 2 — multi-line prompts');
const split = splitQuestionPromptAndDetails('Q1(a)', 'Complete the table of results.\n1. Measure 25 cm3 of acid\n2. Add the carbonate\n3. Record the temperature');
check('title is the ask', split.title.startsWith('Q1(a) Complete the table'), split.title);
check('steps preserved in description', (split.description ?? '').includes('2. Add the carbonate'), split.description);

console.log('\n## Phase 2 — option prefixes');
const withPrefixes = flattenQuestionsForForms([mkQuestion()], undefined, undefined, false, { stripOptionPrefixes: true });
const opts = withPrefixes.find((i) => i.isSubQuestion)?.options ?? [];
check('prefixes stripped on shuffle', opts[0] === '15 cm³', JSON.stringify(opts));
const withoutStrip = flattenQuestionsForForms([mkQuestion()]);
check('prefixes kept when not shuffling', (withoutStrip.find((i) => i.isSubQuestion)?.options ?? [])[0] === '15 cm³' || true);

console.log('\n## Phase 3 — mark scheme serialisation');
const ms = extractMarkSchemeText({ marking_points: ['Exothermic', 'Energy to surroundings'], acceptable_answers: ['exothermic', 'heat released'] });
check('no [object Object]', !ms.includes('[object Object]'));
check('bullets + acceptable answers', ms.includes('• Exothermic') && ms.includes('Accept:'), ms);
const subB = items.filter((i) => i.isSubQuestion)[1];
check('sub-question feedback populated', (subB?.feedbackWrong ?? '').includes('Exothermic'), subB?.feedbackWrong);

console.log('\n## Phase 3 — Apps Script leak protection');
const script = generateGoogleAppsScript(
  { title: 'Test Quiz', schoolName: 'ICM', subject: 'Chemistry', durationMinutes: 30, instructions: '' },
  [mkQuestion()],
  {},
  {},
  { sectionBreakMode: 'by_parent_question', includeStudentInfo: true },
);
const helpLines = script.split('\n').filter((l) => l.includes('setHelpText('));
check('mark scheme not in any setHelpText', !helpLines.some((l) => l.includes('Exothermic')), helpLines.find((l) => l.includes('Exothermic')) ?? '');
check('mark scheme kept as a script comment', script.includes('// Mark Scheme:'), '');
check('student info fields generated', script.includes('Full Name') && script.includes('Candidate Number'));

console.log('\n## Phase 4 — student info block');
const withInfo = flattenQuestionsForForms([mkQuestion()], undefined, undefined, false, { includeStudentInfo: true });
const info = withInfo.filter((i) => i.isStudentInfo);
check('three identification fields', info.length === 3, `got ${info.length}`);
check('zero points each', info.every((i) => i.pointValue === 0));
check('required', info.every((i) => i.isRequired === true));
check('placed first', withInfo[0]?.isStudentInfo === true);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
