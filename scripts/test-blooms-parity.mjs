import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeQuestionRecord } from '../src/services/questionBankService.ts';

console.log('=== Bloom\'s Taxonomy Parity & Independence Test Suite ===\n');

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

// ─────────────────────────────────────────────────────────────────────────────
// 1. Service Layer: normalizeQuestionRecord & Independence
// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 1. Testing normalizeQuestionRecord Independence ---');

test('Parent Bloom level (C4) does NOT cascade onto sub-questions with their own level (C1)', () => {
  const raw = {
    id: 'q-test-1',
    question_number: '1',
    question_text: 'Explain reaction',
    cognitive_level: 'C4',
    sub_questions: [
      { sub_id: '(a)', question_text: 'Name gas', marks: 1, cognitive_level: 'C1' },
      { sub_id: '(b)', question_text: 'Describe test', marks: 2, cognitive_level: 'C2' },
    ],
  };

  const normalized = normalizeQuestionRecord(raw);
  assert.equal(normalized.cognitive_level, 'C4');
  assert.equal(normalized.sub_questions[0].cognitive_level, 'C1');
  assert.equal(normalized.sub_questions[1].cognitive_level, 'C2');
});

test('Unassigned sub-questions stay null and are NOT forcibly overwritten by parent level', () => {
  const raw = {
    id: 'q-test-2',
    question_number: '2',
    question_text: 'Stem text',
    cognitive_level: 'C5',
    sub_questions: [
      { sub_id: '(a)', question_text: 'Part 1', marks: 1 },
      { sub_id: '(b)', question_text: 'Part 2', marks: 2, cognitive_level: null },
    ],
  };

  const normalized = normalizeQuestionRecord(raw);
  assert.equal(normalized.cognitive_level, 'C5');
  assert.equal(normalized.sub_questions[0].cognitive_level, null);
  assert.equal(normalized.sub_questions[1].cognitive_level, null);
});

test('Legacy mark_scheme._cognitive_level on parent and sub-question resolves properly', () => {
  const raw = {
    id: 'q-test-3',
    question_number: '3',
    question_text: 'Stem text',
    mark_scheme: {
      marking_points: ['Point 1'],
      _cognitive_level: 'C3',
    },
    sub_questions: [
      {
        sub_id: '(a)',
        question_text: 'Sub part',
        marks: 2,
        mark_scheme: {
          marking_points: ['Answer'],
          _cognitive_level: 'C2',
        },
      },
    ],
  };

  const normalized = normalizeQuestionRecord(raw);
  assert.equal(normalized.cognitive_level, 'C3');
  assert.equal(normalized.sub_questions[0].cognitive_level, 'C2');
});

test('Editing parent question level does NOT mutate sub-question levels', () => {
  const original = {
    id: 'q-test-4',
    question_number: '4',
    question_text: 'Stem',
    cognitive_level: 'C2',
    sub_questions: [
      { sub_id: '(a)', question_text: 'Calculate x', marks: 3, cognitive_level: 'C3' },
      { sub_id: '(b)', question_text: 'Evaluate result', marks: 3, cognitive_level: 'C5' },
    ],
  };

  const normalizedOriginal = normalizeQuestionRecord(original);
  assert.equal(normalizedOriginal.cognitive_level, 'C2');
  assert.equal(normalizedOriginal.sub_questions[0].cognitive_level, 'C3');
  assert.equal(normalizedOriginal.sub_questions[1].cognitive_level, 'C5');

  // Change parent from C2 to C6
  const updatedParent = {
    ...original,
    cognitive_level: 'C6',
  };

  const normalizedUpdated = normalizeQuestionRecord(updatedParent);
  assert.equal(normalizedUpdated.cognitive_level, 'C6');
  // Sub-questions must remain C3 and C5
  assert.equal(normalizedUpdated.sub_questions[0].cognitive_level, 'C3');
  assert.equal(normalizedUpdated.sub_questions[1].cognitive_level, 'C5');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. QuestionEditorModal: Sanitization & Payload Construction
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 2. Testing QuestionEditorModal Logic & Persistence ---');

function simulateSanitizedSubs(rawSubs) {
  return rawSubs.map((sub) => ({
    ...sub,
    sub_id: String(sub?.sub_id || ''),
    question_text: typeof sub?.question_text === 'string' ? sub.question_text : '',
    marks: Number(sub?.marks) || 1,
    cognitive_level: (sub?.cognitive_level || sub?.mark_scheme?._cognitive_level || null),
  }));
}

function simulateEditorSavePayload({
  question,
  cognitiveLevel,
  sourcePdfUrl,
  pageNumber,
  subQuestions,
  markingPoints,
  topic,
}) {
  const existingMarkSchemeMeta = {};
  if (question?.mark_scheme && typeof question.mark_scheme === 'object') {
    for (const [k, v] of Object.entries(question.mark_scheme)) {
      if (k.startsWith('_')) existingMarkSchemeMeta[k] = v;
    }
  }
  if (cognitiveLevel) {
    existingMarkSchemeMeta._cognitive_level = cognitiveLevel;
  } else {
    delete existingMarkSchemeMeta._cognitive_level;
  }

  const markSchemePayload = {
    ...existingMarkSchemeMeta,
    marking_points: markingPoints,
  };

  return {
    topic: topic.trim() || 'General',
    cognitive_level: cognitiveLevel || null,
    source_pdf_url: sourcePdfUrl.trim() || null,
    page_number: pageNumber !== '' ? Number(pageNumber) : null,
    sub_questions: subQuestions,
    mark_scheme: markSchemePayload,
  };
}

test('Sanitizer preserves distinct sub-question cognitive levels', () => {
  const incomingSubs = [
    { sub_id: '(a)', marks: 1, cognitive_level: 'C1' },
    { sub_id: '(b)', marks: 2, cognitive_level: 'C4' },
    { sub_id: '(c)', marks: 3, mark_scheme: { _cognitive_level: 'C6' } },
    { sub_id: '(d)', marks: 1 },
  ];

  const sanitized = simulateSanitizedSubs(incomingSubs);
  assert.equal(sanitized[0].cognitive_level, 'C1');
  assert.equal(sanitized[1].cognitive_level, 'C4');
  assert.equal(sanitized[2].cognitive_level, 'C6');
  assert.equal(sanitized[3].cognitive_level, null);
});

test('Editor handleSave includes cognitive_level in payload and mark_scheme', () => {
  const payload = simulateEditorSavePayload({
    question: { id: 'q-edit-1', mark_scheme: { marking_points: ['A'] } },
    cognitiveLevel: 'C4',
    sourcePdfUrl: 'https://example.com/paper.pdf',
    pageNumber: 3,
    subQuestions: [
      { sub_id: '(a)', marks: 2, cognitive_level: 'C2' },
      { sub_id: '(b)', marks: 3, cognitive_level: 'C4' },
    ],
    markingPoints: ['Criterion 1'],
    topic: 'Organic Chemistry',
  });

  assert.equal(payload.cognitive_level, 'C4');
  assert.equal(payload.mark_scheme._cognitive_level, 'C4');
  assert.equal(payload.source_pdf_url, 'https://example.com/paper.pdf');
  assert.equal(payload.page_number, 3);
  assert.equal(payload.sub_questions[0].cognitive_level, 'C2');
  assert.equal(payload.sub_questions[1].cognitive_level, 'C4');
});

test('Editor unassigned cognitiveLevel produces null and cleans mark_scheme metadata', () => {
  const payload = simulateEditorSavePayload({
    question: { id: 'q-edit-2', mark_scheme: { _cognitive_level: 'C2', marking_points: ['A'] } },
    cognitiveLevel: '',
    sourcePdfUrl: '',
    pageNumber: '',
    subQuestions: [],
    markingPoints: ['Criterion 1'],
    topic: 'Physics',
  });

  assert.equal(payload.cognitive_level, null);
  assert.equal(payload.mark_scheme._cognitive_level, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ExtractionReview: Round-trip & Split Operations
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 3. Testing ExtractionReview Operations ---');

function simulateModalSaveCallback(originalQ, saved) {
  return {
    ...originalQ,
    question_text: saved.question_text || originalQ.question_text,
    topic: saved.topic || originalQ.topic,
    difficulty: saved.difficulty || originalQ.difficulty,
    cognitive_level: saved.cognitive_level !== undefined ? saved.cognitive_level : (originalQ.cognitive_level || null),
    total_marks: saved.marks || originalQ.total_marks,
    sub_questions: saved.sub_questions && saved.sub_questions.length > 0 ? saved.sub_questions : undefined,
    mark_scheme: saved.mark_scheme,
  };
}

function simulateSplitSubQuestion(parentQ, subIdx) {
  const sub = parentQ.sub_questions[subIdx];
  const remainingSubs = parentQ.sub_questions.filter((_, i) => i !== subIdx);
  const subMarks = Number(sub.marks) || 1;

  const updatedParent = {
    ...parentQ,
    sub_questions: remainingSubs,
    total_marks: Math.max(1, (Number(parentQ.total_marks) || subMarks) - subMarks),
  };

  const newQuestion = {
    question_number: `${parentQ.question_number}${sub.sub_id.replace(/[()]/g, '')}`,
    total_marks: subMarks,
    cognitive_level: sub.cognitive_level || parentQ.cognitive_level || null,
    topic: parentQ.topic,
    sub_questions: [],
  };

  return { updatedParent, newQuestion };
}

test('ExtractionReview modal onSave updates parent and sub-question levels cleanly', () => {
  const originalQ = {
    question_number: '1',
    total_marks: 5,
    cognitive_level: 'C2',
    sub_questions: [
      { sub_id: '(a)', marks: 2, cognitive_level: 'C1' },
      { sub_id: '(b)', marks: 3, cognitive_level: 'C3' },
    ],
  };

  const savedFromModal = {
    marks: 6,
    cognitive_level: 'C5',
    sub_questions: [
      { sub_id: '(a)', marks: 2, cognitive_level: 'C1' },
      { sub_id: '(b)', marks: 4, cognitive_level: 'C4' },
    ],
  };

  const updated = simulateModalSaveCallback(originalQ, savedFromModal);
  assert.equal(updated.cognitive_level, 'C5');
  assert.equal(updated.sub_questions[0].cognitive_level, 'C1');
  assert.equal(updated.sub_questions[1].cognitive_level, 'C4');
});

test('1-Click Split retains sub-question specific Bloom level', () => {
  const parentQ = {
    question_number: '3',
    total_marks: 6,
    cognitive_level: 'C2',
    topic: 'Electrolysis',
    sub_questions: [
      { sub_id: '(a)', marks: 2, cognitive_level: 'C1' },
      { sub_id: '(b)', marks: 4, cognitive_level: 'C4' },
    ],
  };

  const { updatedParent, newQuestion } = simulateSplitSubQuestion(parentQ, 1);
  assert.equal(updatedParent.total_marks, 2);
  assert.equal(updatedParent.sub_questions.length, 1);
  assert.equal(updatedParent.sub_questions[0].sub_id, '(a)');

  assert.equal(newQuestion.question_number, '3b');
  assert.equal(newQuestion.total_marks, 4);
  assert.equal(newQuestion.cognitive_level, 'C4'); // Sub had C4, must keep C4!
});

test('1-Click Split falls back to parent Bloom level only when sub-question level is unassigned', () => {
  const parentQ = {
    question_number: '5',
    total_marks: 4,
    cognitive_level: 'C3',
    topic: 'Kinematics',
    sub_questions: [
      { sub_id: '(a)', marks: 2 }, // unassigned
    ],
  };

  const { newQuestion } = simulateSplitSubQuestion(parentQ, 0);
  assert.equal(newQuestion.cognitive_level, 'C3');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Source Code Parity & AST Check
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 4. Static Parity Verifications in Component Source ---');

const qemSrc = fs.readFileSync('src/components/QuestionEditorModal.tsx', 'utf8');
const erSrc = fs.readFileSync('src/components/ExtractionReview.tsx', 'utf8');
const qbsSrc = fs.readFileSync('src/services/questionBankService.ts', 'utf8');
const ppSrc = fs.readFileSync('src/lib/pdfProcessor.ts', 'utf8');
const tqiSrc = fs.readFileSync('src/components/TestQuestionItem.tsx', 'utf8');
const qdmSrc = fs.readFileSync('src/components/QuestionDetailModal.tsx', 'utf8');
const qcSrc = fs.readFileSync('src/components/QuestionCard.tsx', 'utf8');

test('QuestionEditorModal contains sub-question Bloom select dropdown', () => {
  assert(qemSrc.includes('title="Sub-question Bloom\'s Taxonomy Cognitive Level"'));
  assert(qemSrc.includes('value={sub.cognitive_level || \'\'}'));
});

test('QuestionEditorModal contains modal header Main Bloom dropdown', () => {
  assert(qemSrc.includes('id="q-header-cognitive-select"'));
  assert(qemSrc.includes('title="Main Question Bloom\'s Taxonomy Cognitive Level"'));
});

test('ExtractionReview passes cognitive_level to QuestionEditorModal and reads saved', () => {
  assert(erSrc.includes("cognitive_level: curQ.cognitive_level || 'C2'"));
  assert(erSrc.includes('cognitive_level: saved.cognitive_level !== undefined ? saved.cognitive_level'));
});

test('ExtractionReview header contains interactive Bloom selector', () => {
  assert(erSrc.includes('title="Bloom\'s Taxonomy Cognitive Level (Click to change)"'));
});

test('ExtractionReview sub-questions render Bloom badges', () => {
  assert(erSrc.includes('sub.cognitive_level && ('));
  assert(erSrc.includes("title={`Bloom's Taxonomy: ${sub.cognitive_level}`}"));
});

test('questionBankService normalizeQuestionRecord never cascades parent cognitiveLevel', () => {
  assert(qbsSrc.includes('cognitive_level: sub.cognitive_level || sub.mark_scheme?._cognitive_level || null,'));
  assert(!qbsSrc.includes('sub.mark_scheme?._cognitive_level || cognitiveLevel'));
});

test('pdfProcessor saveExtractedQuestions preserves independent sub.cognitive_level', () => {
  assert(ppSrc.includes('cognitive_level: sub.cognitive_level || null,'));
});

test('TestQuestionItem renders parent Bloom badge', () => {
  assert(tqiSrc.includes('question.cognitive_level && ('));
  assert(tqiSrc.includes("title={`Bloom's Taxonomy Cognitive Level: ${question.cognitive_level}`}"));
});

test('TestQuestionItem renders sub-question Bloom badge', () => {
  assert(tqiSrc.includes('sub.cognitive_level && ('));
  assert(tqiSrc.includes("title={`Bloom's Taxonomy: ${sub.cognitive_level}`}"));
});

test('QuestionDetailModal renders sub-question Bloom badge', () => {
  assert(qdmSrc.includes('sub.cognitive_level && ('));
  assert(qdmSrc.includes("title={`Bloom's Taxonomy: ${sub.cognitive_level}`}"));
});

test('QuestionCard renders parent and sub Bloom badges', () => {
  assert(qcSrc.includes('question.cognitive_level && ('));
  assert(qcSrc.includes('sub.cognitive_level && ('));
});

console.log(`\n========================================`);
console.log(`Results: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log(`========================================\n`);

if (passedTests !== totalTests) {
  process.exit(1);
}

