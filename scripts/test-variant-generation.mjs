import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildMisconceptionsWithDistractors,
  buildSharedPassageRefSet,
  classifyQuestionForVariant,
  pruneQuestionOverridesForVariantSet,
  resolveVariantStyleAndSubs,
} from '../src/utils/variantClassification.ts';

function runVariantClassificationTests() {
  // 1. Shared reading passage detection without explicit is_shared_passage boolean
  const q1 = {
    id: 'q1',
    question_number: '1',
    topic: 'Reading',
    question_text: '### Text 1\n\nLong reading passage about solar energy.\n\nWhat is the main benefit?',
    passage_ref: 'Text 1',
    marks: 1,
  };
  const q2 = {
    id: 'q2',
    question_number: '2',
    topic: 'Reading',
    question_text: 'According to Text 1, why did costs fall?',
    passage_ref: 'Text 1',
    marks: 1,
  };
  const q3Range = {
    id: 'q3',
    question_number: '3',
    topic: 'Reading',
    question_text: 'Questions 3 to 5 are based on the following passage.',
    marks: 1,
  };
  const q4Standalone = {
    id: 'q4',
    question_number: '4',
    topic: 'Algebra',
    question_text: 'Solve for $x$: $2x + 5 = 13$.',
    marks: 2,
  };
  const q5Audio = {
    id: 'q5',
    question_number: '5',
    topic: 'Listening',
    question_text: 'Listen to the track.',
    audio_url: 'https://example.com/track.mp3',
    marks: 1,
  };
  const q6Photo = {
    id: 'q6',
    question_number: '6',
    topic: 'Biology',
    question_text: 'The photomicrograph shows a plant cell. Calculate the magnification.',
    diagram_url: 'https://cdn.example.com/cell-specimen.png',
    diagram_type: 'photo',
    marks: 3,
  };

  const exam = [q1, q2, q3Range, q4Standalone, q5Audio, q6Photo];
  const sharedRefs = buildSharedPassageRefSet(exam);

  assert.equal(classifyQuestionForVariant(q1, exam, sharedRefs).action, 'skip');
  assert.equal(classifyQuestionForVariant(q2, exam, sharedRefs).action, 'skip');
  assert.equal(classifyQuestionForVariant(q3Range, exam, sharedRefs).action, 'skip');
  assert.equal(classifyQuestionForVariant(q4Standalone, exam, sharedRefs).action, 'generate');
  assert.equal(classifyQuestionForVariant(q5Audio, exam, sharedRefs).action, 'skip');

  const photoRes = classifyQuestionForVariant(q6Photo, exam, sharedRefs);
  assert.equal(photoRes.action, 'generate');
  assert.equal(photoRes.isPhotoReused, true);

  console.log('PASS Step 1: Set Variant shared-passage, audio & photo classification tests');
}

function runStyleAndMarkResolutionTests() {
  // 2. Scaffolding an MCQ into guided sub_questions converts style cleanly to Structured
  const scaffoldMcq = resolveVariantStyleAndSubs({
    mode: 'scaffold',
    originalStyle: 'Multiple Choice',
    parsedStyle: 'Multiple Choice',
    normalizedOptions: ['A. 2', 'B. 4', 'C. 6', 'D. 8'],
    sanitizedSubs: [
      { sub_id: '(a)', question_text: 'Write the formula for momentum.', marks: 1 },
      { sub_id: '(b)', question_text: 'Calculate the value.', marks: 2 },
    ],
    originalMarks: 1,
    parsedMarks: 1,
  });
  assert.equal(scaffoldMcq.questionStyle, 'Structured');
  assert.equal(scaffoldMcq.options, null);
  assert.equal(scaffoldMcq.subQuestions?.length, 2);
  assert.equal(scaffoldMcq.marks, 3);

  // 3. Parallel mode preserves original marks even if LLM output drifted
  const parallelMarks = resolveVariantStyleAndSubs({
    mode: 'parallel',
    originalStyle: 'Structured',
    parsedStyle: 'Structured',
    normalizedOptions: null,
    sanitizedSubs: [{ sub_id: '(a)', question_text: 'Step 1', marks: 2 }],
    originalMarks: 5,
    parsedMarks: 2,
  });
  assert.equal(parallelMarks.marks, 5);

  // 4. Filter out CORRECT rationale from common_misconceptions
  const misconceptions = buildMisconceptionsWithDistractors(
    ['Confuses mass and weight'],
    {
      A: 'Uses radius instead of diameter',
      B: 'CORRECT answer: divides distance by time',
      C: 'Multiplies instead of divides',
    }
  );
  assert.equal(misconceptions.length, 3);
  assert.ok(!misconceptions.some((m) => m.includes('CORRECT answer')));

  // 5. Prune Set A questionOverrides for replaced questions while keeping kept originals
  const pruned = pruneQuestionOverridesForVariantSet(
    {
      'orig-replaced': { id: 'orig-replaced', question_text: 'Old A' },
      'orig-kept': { id: 'orig-kept', question_text: 'Kept B' },
    },
    new Set(['orig-kept'])
  );
  assert.deepEqual(Object.keys(pruned || {}), ['orig-kept']);

  console.log('PASS Step 2: Scaffold MCQ, parallel marks, misconceptions & override pruning tests');
}

function runSourceWiringChecks() {
  const geminiSrc = fs.readFileSync('src/lib/gemini.ts', 'utf8');
  assert.ok(geminiSrc.includes('inlineImageParts'), 'gemini.ts must pass attached images to Gemini Vision');
  assert.ok(geminiSrc.includes('STRICT VISUAL GROUNDING'), 'gemini.ts must enforce zero-hallucination image grounding');
  assert.ok(geminiSrc.includes('hasInlineGaps'), 'gemini.ts must check inline gap formatting');

  const qModalSrc = fs.readFileSync('src/components/QuestionVariantModal.tsx', 'utf8');
  assert.ok(qModalSrc.includes('data_tables: generated.data_tables ?? question.data_tables'));
  assert.ok(qModalSrc.includes('cognitive_level: generated.cognitive_level ?? question.cognitive_level'));
  assert.ok(qModalSrc.includes('scratchpad: generated.scratchpad'));

  const examModalSrc = fs.readFileSync('src/components/ExamVariantModal.tsx', 'utf8');
  assert.equal(examModalSrc.includes('setGenerateAiDiagrams(true);'), false, 'Must not force AI diagrams on open');
  assert.ok(examModalSrc.includes('onOpenInBuilder(savedQuestions, updatedHeaderConfig, savedTest.id)'));

  console.log('PASS Step 3: Image grounding, QuestionVariantModal & ExamVariantModal wiring verified');
}

runVariantClassificationTests();
runStyleAndMarkResolutionTests();
runSourceWiringChecks();
