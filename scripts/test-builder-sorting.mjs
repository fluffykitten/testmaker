import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isMcqQuestion,
  getQuestionSectionRank,
  sortTestBuilderQuestions,
  TEST_SORT_PRESETS,
  getSortPresetMeta,
} from '../src/utils/testSortingUtils.ts';

console.log('=== Test Builder Question Sorting Test Suite ===\n');

let totalTests = 0;
let passedTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function makeQuestion(overrides) {
  return {
    id: overrides.id || `q-${Math.random()}`,
    syllabus_id: 'syl-1',
    year: 2025,
    series: 'May/June',
    paper_number: 1,
    question_number: overrides.question_number || '1',
    parent_question_id: null,
    question_text: overrides.question_text || 'Sample question',
    question_style: 'question_style' in overrides ? overrides.question_style : 'Structured',
    topic: 'topic' in overrides ? overrides.topic : 'General',
    sub_topic: 'sub_topic' in overrides ? overrides.sub_topic : null,
    difficulty: 'difficulty' in overrides ? overrides.difficulty : 'Medium',
    marks: 'marks' in overrides ? overrides.marks : 2,
    diagram_url: null,
    options: overrides.options ?? null,
    sub_questions: overrides.sub_questions ?? [],
    mark_scheme: null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Section Classification (MCQ First vs Essay Second)
// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 1. Testing MCQ vs. Essay Section Classification ---');

test('Identifies Multiple Choice and Multiple Select as Section A (rank 0)', () => {
  const mcq1 = makeQuestion({ id: 'm1', question_style: 'Multiple Choice' });
  const mcq2 = makeQuestion({ id: 'm2', question_style: 'Multiple Select' });
  const mcqImplicit = makeQuestion({
    id: 'm3',
    question_style: 'Structured',
    options: ['A. 1', 'B. 2', 'C. 3', 'D. 4'],
  });

  assert.equal(isMcqQuestion(mcq1), true);
  assert.equal(getQuestionSectionRank(mcq1), 0);
  assert.equal(isMcqQuestion(mcq2), true);
  assert.equal(getQuestionSectionRank(mcq2), 0);
  assert.equal(isMcqQuestion(mcqImplicit), true);
  assert.equal(getQuestionSectionRank(mcqImplicit), 0);
});

test('Identifies Structured, Calculation, Short Answer, Fill in the Blank as Section B (rank 1)', () => {
  const structured = makeQuestion({ id: 'e1', question_style: 'Structured', options: null });
  const calc = makeQuestion({ id: 'e2', question_style: 'Calculation', options: null });
  const shortAns = makeQuestion({ id: 'e3', question_style: 'Short Answer', options: null });
  const gapFill = makeQuestion({ id: 'e4', question_style: 'Fill in the Blank', options: null });

  assert.equal(getQuestionSectionRank(structured), 1);
  assert.equal(getQuestionSectionRank(calc), 1);
  assert.equal(getQuestionSectionRank(shortAns), 1);
  assert.equal(getQuestionSectionRank(gapFill), 1);
});

test('All 5 sort presets keep ALL MCQs before ALL Essays in mixed papers', () => {
  const mixed = [
    makeQuestion({ id: 'essay-1', question_style: 'Structured', topic: 'Atomic Structure', difficulty: 'Easy' }),
    makeQuestion({ id: 'mcq-1', question_style: 'Multiple Choice', topic: 'Organic Chemistry', difficulty: 'Hard' }),
    makeQuestion({ id: 'essay-2', question_style: 'Calculation', topic: 'Stoichiometry', difficulty: 'Medium' }),
    makeQuestion({ id: 'mcq-2', question_style: 'Multiple Choice', topic: 'Acids and Bases', difficulty: 'Easy' }),
  ];

  for (const preset of TEST_SORT_PRESETS) {
    const sorted = sortTestBuilderQuestions(mixed, preset.id);
    assert.equal(sorted.length, 4);
    assert.equal(isMcqQuestion(sorted[0]), true, `Preset ${preset.id} index 0 must be MCQ`);
    assert.equal(isMcqQuestion(sorted[1]), true, `Preset ${preset.id} index 1 must be MCQ`);
    assert.equal(isMcqQuestion(sorted[2]), false, `Preset ${preset.id} index 2 must be Essay`);
    assert.equal(isMcqQuestion(sorted[3]), false, `Preset ${preset.id} index 3 must be Essay`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Difficulty Sorting (Easy → Hard & Hard → Easy)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 2. Testing Difficulty Sorting & Stability ---');

test('difficulty_asc orders Easy → Medium → Hard → Unassigned while preserving original order on ties', () => {
  const items = [
    makeQuestion({ id: 'e-hard-1', question_style: 'Structured', difficulty: 'Hard' }),
    makeQuestion({ id: 'e-med-1', question_style: 'Structured', difficulty: 'Medium' }),
    makeQuestion({ id: 'e-easy-1', question_style: 'Structured', difficulty: 'Easy' }),
    makeQuestion({ id: 'e-none', question_style: 'Structured', difficulty: null }),
    makeQuestion({ id: 'e-easy-2', question_style: 'Structured', difficulty: 'Easy' }),
    makeQuestion({ id: 'e-hard-2', question_style: 'Structured', difficulty: 'Hard' }),
  ];

  const sorted = sortTestBuilderQuestions(items, 'difficulty_asc');
  assert.deepEqual(
    sorted.map((q) => q.id),
    ['e-easy-1', 'e-easy-2', 'e-med-1', 'e-hard-1', 'e-hard-2', 'e-none']
  );
});

test('difficulty_desc orders Hard → Medium → Easy → Unassigned while preserving original order on ties', () => {
  const items = [
    makeQuestion({ id: 'e-easy-1', question_style: 'Structured', difficulty: 'Easy' }),
    makeQuestion({ id: 'e-none', question_style: 'Structured', difficulty: null }),
    makeQuestion({ id: 'e-hard-1', question_style: 'Structured', difficulty: 'Hard' }),
    makeQuestion({ id: 'e-med-1', question_style: 'Structured', difficulty: 'Medium' }),
    makeQuestion({ id: 'e-hard-2', question_style: 'Structured', difficulty: 'Hard' }),
  ];

  const sorted = sortTestBuilderQuestions(items, 'difficulty_desc');
  assert.deepEqual(
    sorted.map((q) => q.id),
    ['e-hard-1', 'e-hard-2', 'e-med-1', 'e-easy-1', 'e-none']
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Topic & Topic + Difficulty Sorting
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 3. Testing Topic & Topic + Difficulty Sorting ---');

test('topic_asc sorts by Topic (A → Z), then Sub-Topic (A → Z), then Difficulty (Easy → Hard)', () => {
  const items = [
    makeQuestion({ id: 'q1', topic: 'States of Matter', sub_topic: 'Diffusion', difficulty: 'Hard' }),
    makeQuestion({ id: 'q2', topic: 'Atomic Structure', sub_topic: 'Isotopes', difficulty: 'Medium' }),
    makeQuestion({ id: 'q3', topic: 'Atomic Structure', sub_topic: 'Bonding', difficulty: 'Hard' }),
    makeQuestion({ id: 'q4', topic: 'Atomic Structure', sub_topic: 'Bonding', difficulty: 'Easy' }),
    makeQuestion({ id: 'q5', topic: '', sub_topic: null, difficulty: 'Easy' }),
  ];

  const sorted = sortTestBuilderQuestions(items, 'topic_asc');
  assert.deepEqual(
    sorted.map((q) => q.id),
    ['q4', 'q3', 'q2', 'q1', 'q5']
  );
});

test('topic_difficulty groups by Topic (A → Z) and progresses Easy → Medium → Hard within each Topic', () => {
  const items = [
    makeQuestion({ id: 'm-org-hard', question_style: 'Multiple Choice', topic: 'Organic', difficulty: 'Hard' }),
    makeQuestion({ id: 'e-chem-hard', question_style: 'Structured', topic: 'Electrochemistry', sub_topic: 'Cells', difficulty: 'Hard' }),
    makeQuestion({ id: 'm-org-easy', question_style: 'Multiple Choice', topic: 'Organic', difficulty: 'Easy' }),
    makeQuestion({ id: 'e-chem-easy', question_style: 'Structured', topic: 'Electrochemistry', sub_topic: 'Z-Electrolysis', difficulty: 'Easy' }),
    makeQuestion({ id: 'e-chem-med', question_style: 'Structured', topic: 'Electrochemistry', sub_topic: 'Anodes', difficulty: 'Medium' }),
    makeQuestion({ id: 'e-acid-easy', question_style: 'Structured', topic: 'Acids', difficulty: 'Easy' }),
  ];

  const sorted = sortTestBuilderQuestions(items, 'topic_difficulty');
  assert.deepEqual(
    sorted.map((q) => q.id),
    [
      // Section A (MCQs): Organic Easy -> Organic Hard
      'm-org-easy',
      'm-org-hard',
      // Section B (Essays): Acids Easy -> Electrochemistry (Easy -> Medium -> Hard)
      'e-acid-easy',
      'e-chem-easy',
      'e-chem-med',
      'e-chem-hard',
    ]
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Shuffle, Immutability & Undo Integrity
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 4. Testing Shuffle, Immutability & Undo Integrity ---');

test('shuffle randomizes within MCQ and Essay sections without crossing section boundary', () => {
  const items = [
    makeQuestion({ id: 'mcq-1', question_style: 'Multiple Choice' }),
    makeQuestion({ id: 'mcq-2', question_style: 'Multiple Choice' }),
    makeQuestion({ id: 'mcq-3', question_style: 'Multiple Choice' }),
    makeQuestion({ id: 'essay-1', question_style: 'Structured' }),
    makeQuestion({ id: 'essay-2', question_style: 'Structured' }),
    makeQuestion({ id: 'essay-3', question_style: 'Structured' }),
  ];

  // Deterministic RNG
  let seed = 0.42;
  const fakeRng = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  const shuffled = sortTestBuilderQuestions(items, 'shuffle', fakeRng);
  assert.equal(shuffled.length, 6);
  const firstThreeIds = shuffled.slice(0, 3).map((q) => q.id).sort();
  const lastThreeIds = shuffled.slice(3, 6).map((q) => q.id).sort();

  assert.deepEqual(firstThreeIds, ['mcq-1', 'mcq-2', 'mcq-3']);
  assert.deepEqual(lastThreeIds, ['essay-1', 'essay-2', 'essay-3']);
});

test('sortTestBuilderQuestions does not mutate the original array (Undo snapshot safety)', () => {
  const original = [
    makeQuestion({ id: 'q-b', topic: 'Zoology', difficulty: 'Hard' }),
    makeQuestion({ id: 'q-a', topic: 'Anatomy', difficulty: 'Easy' }),
  ];
  const snapshot = [...original];

  const sorted = sortTestBuilderQuestions(original, 'topic_asc');
  assert.deepEqual(sorted.map((q) => q.id), ['q-a', 'q-b']);
  // Original array and snapshot must remain untouched
  assert.deepEqual(original.map((q) => q.id), ['q-b', 'q-a']);
  assert.deepEqual(snapshot.map((q) => q.id), ['q-b', 'q-a']);
});

test('getSortPresetMeta returns valid metadata for all presets', () => {
  for (const preset of TEST_SORT_PRESETS) {
    const meta = getSortPresetMeta(preset.id);
    assert.equal(meta.id, preset.id);
    assert(meta.label.length > 0);
    assert(meta.shortLabel.length > 0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. UI Wiring Verification in TestBuilderPage
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 5. Testing TestBuilderPage UI Integration ---');

const builderSrc = fs.readFileSync('src/pages/TestBuilderPage.tsx', 'utf8');
const builderCss = fs.readFileSync('src/pages/TestBuilderPage.css', 'utf8');

test('TestBuilderPage wires sort dropdown, preset options, and Undo handler', () => {
  assert(builderSrc.includes('sortTestBuilderQuestions'));
  assert(builderSrc.includes('TEST_SORT_PRESETS'));
  assert(builderSrc.includes('handleApplySort'));
  assert(builderSrc.includes('handleUndoSort'));
  assert(builderSrc.includes('builder-sort-trigger-btn'));
  assert(builderSrc.includes('builder-undo-sort-banner'));
  assert(builderCss.includes('.builder-sort-menu'));
  assert(builderCss.includes('.builder-undo-sort-banner'));
});

console.log(`\n========================================`);
console.log(`Results: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log(`========================================\n`);

if (passedTests !== totalTests) {
  process.exit(1);
}
