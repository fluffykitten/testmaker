import assert from 'node:assert/strict';

// Import normalizeQuestionStyle
import { normalizeQuestionStyle } from '../src/types/database';

console.log('--- 1. Testing normalizeQuestionStyle ---');

// Case a: snake_case 'multiple_choice'
assert.equal(normalizeQuestionStyle('multiple_choice'), 'Multiple Choice');

// Case b: lowercase 'multiple choice'
assert.equal(normalizeQuestionStyle('multiple choice'), 'Multiple Choice');

// Case c: abbreviation 'mcq' / 'MCQ'
assert.equal(normalizeQuestionStyle('mcq'), 'Multiple Choice');
assert.equal(normalizeQuestionStyle('MCQ'), 'Multiple Choice');

// Case d: 'Structured' but has options
assert.equal(normalizeQuestionStyle('Structured', ['A. Alpha', 'B. Beta', 'C. Gamma', 'D. Delta']), 'Multiple Choice');

// Case e: null / undefined style but has options
assert.equal(normalizeQuestionStyle(null, ['A. Alpha', 'B. Beta']), 'Multiple Choice');
assert.equal(normalizeQuestionStyle(undefined, ['A. Alpha', 'B. Beta']), 'Multiple Choice');

// Case f: Structured without options
assert.equal(normalizeQuestionStyle('Structured', []), 'Structured');
assert.equal(normalizeQuestionStyle('Structured', null), 'Structured');

// Case g: Explicit Calculation / Short Answer / Multiple Select
assert.equal(normalizeQuestionStyle('Calculation'), 'Calculation');
assert.equal(normalizeQuestionStyle('Short Answer'), 'Short Answer');
assert.equal(normalizeQuestionStyle('Multiple Select'), 'Multiple Select');
assert.equal(normalizeQuestionStyle('Fill in the Blank'), 'Fill in the Blank');

console.log('✓ normalizeQuestionStyle tests passed!');

console.log('\n--- 2. Testing QuestionEditorModal handleSave options logic ---');

function simulateModalSave(inputQuestion, userState) {
  const options = userState.options;
  const questionStyle = userState.questionStyle;

  const effectiveStyle = normalizeQuestionStyle(questionStyle, options);
  const isMcq = effectiveStyle === 'Multiple Choice' || effectiveStyle === 'Multiple Select';

  const cleanUserOptions = options
    .map((opt) => (typeof opt === 'string' ? opt.trim() : ''))
    .filter(Boolean);

  let cleanOptions = [];
  if (isMcq || cleanUserOptions.length >= 2) {
    cleanOptions = cleanUserOptions;
  } else if (effectiveStyle === 'Calculation' || effectiveStyle === 'Short Answer') {
    cleanOptions = [];
  } else if (cleanUserOptions.length > 0) {
    cleanOptions = cleanUserOptions;
  } else if (Array.isArray(inputQuestion?.options) && inputQuestion.options.length > 0) {
    cleanOptions = inputQuestion.options.map((opt) => typeof opt === 'string' ? opt.trim() : '').filter(Boolean);
  }

  const finalQuestionStyle = (cleanOptions.length >= 2 && effectiveStyle !== 'Multiple Select')
    ? 'Multiple Choice'
    : effectiveStyle;

  return {
    question_style: finalQuestionStyle,
    options: cleanOptions.length > 0 ? cleanOptions : null,
  };
}

// Scenario 1: Gemini returned question_style: 'multiple_choice' with 4 options
const q1 = {
  question_number: '1',
  question_style: 'multiple_choice',
  options: ['A. Option 1', 'B. Option 2', 'C. Option 3', 'D. Option 4'],
};

// Initial state as set by useEffect
const initialOptions1 = Array.isArray(q1.options) ? q1.options : [];
const initialStyle1 = normalizeQuestionStyle(q1.question_style, initialOptions1);
assert.equal(initialStyle1, 'Multiple Choice');

// User edits only topic or stem without touching options, then saves:
const saved1 = simulateModalSave(q1, { questionStyle: initialStyle1, options: initialOptions1 });
assert.equal(saved1.question_style, 'Multiple Choice');
assert.deepEqual(saved1.options, ['A. Option 1', 'B. Option 2', 'C. Option 3', 'D. Option 4']);
console.log('✓ Scenario 1 (snake_case multiple_choice edited & saved) preserved choices!');

// Scenario 2: Gemini returned question_style: 'Structured' but included options A, B, C, D
const q2 = {
  question_number: '2',
  question_style: 'Structured',
  options: ['A. Carbon', 'B. Oxygen', 'C. Nitrogen', 'D. Hydrogen'],
};
const initialOptions2 = q2.options;
const initialStyle2 = normalizeQuestionStyle(q2.question_style, initialOptions2);
assert.equal(initialStyle2, 'Multiple Choice');

const saved2 = simulateModalSave(q2, { questionStyle: initialStyle2, options: initialOptions2 });
assert.equal(saved2.question_style, 'Multiple Choice');
assert.deepEqual(saved2.options, ['A. Carbon', 'B. Oxygen', 'C. Nitrogen', 'D. Hydrogen']);
console.log('✓ Scenario 2 (Gemini marked MCQ as Structured) normalized to Multiple Choice and preserved choices!');

// Scenario 3: Teacher explicitly switches style to 'Calculation'
const saved3 = simulateModalSave(q1, { questionStyle: 'Calculation', options: [] });
assert.equal(saved3.question_style, 'Calculation');
assert.equal(saved3.options, null);
console.log('✓ Scenario 3 (Explicit style switch to Calculation) cleared options as expected!');

console.log('\n--- 3. Testing ExtractionReview defensive onSave handler ---');

function simulateReviewOnSave(originalQ, savedPayload) {
  const preservedOptions = (savedPayload.options && savedPayload.options.length > 0)
    ? savedPayload.options
    : (originalQ.options && originalQ.options.length > 0 && savedPayload.question_style !== 'Calculation' && savedPayload.question_style !== 'Short Answer')
    ? originalQ.options
    : null;

  const resolvedSavedStyle = normalizeQuestionStyle(savedPayload.question_style, preservedOptions);

  return {
    ...originalQ,
    question_style: resolvedSavedStyle,
    options: preservedOptions,
  };
}

// Even if savedPayload.options was somehow null, original options must survive
const reviewResult = simulateReviewOnSave(
  { question_number: '1', question_style: 'Multiple Choice', options: ['A. Foo', 'B. Bar'] },
  { question_number: '1', question_style: 'Multiple Choice', options: null }
);
assert.deepEqual(reviewResult.options, ['A. Foo', 'B. Bar']);
assert.equal(reviewResult.question_style, 'Multiple Choice');
console.log('✓ Scenario 4 (Review onSave defensive fallback) protected against null options!');

console.log('\nAll MCQ option preservation tests PASSED successfully!');
