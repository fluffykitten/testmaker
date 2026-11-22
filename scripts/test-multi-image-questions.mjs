import assert from 'node:assert/strict';
import {
  normalizeDiagramUrlList,
  normalizeOptionDiagramList,
  parseDiagramColumnValue,
  resolveOptionDiagramUrl,
  resolveOptionDiagramUrls,
  resolveQuestionDiagramUrls,
  serializeQuestionDiagramsForColumn,
  stripInlineMarkdownImage,
} from '../src/utils/questionDiagramUtils.ts';
import { normalizeQuestionRecord } from '../src/services/questionBankService.ts';
import { normalizeQuestionStyle } from '../src/types/database.ts';
import {
  gradeDeterministicAnswer,
  resolveMcqCorrectOptionIndex,
  resolveQuestionModelAnswer,
} from '../src/services/deterministicGradingService.ts';
import { sanitizeQuestionsForStudent } from '../src/lib/examSubmissionGuards.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

test('single stem image without option images serializes to plain legacy URL string', () => {
  const serialized = serializeQuestionDiagramsForColumn(['https://cdn.example.com/fig1.png'], null);
  assert.equal(serialized, 'https://cdn.example.com/fig1.png');

  const serializedWithEmptyOpts = serializeQuestionDiagramsForColumn(
    ['https://cdn.example.com/fig1.png'],
    [null, null, null, null]
  );
  assert.equal(serializedWithEmptyOpts, 'https://cdn.example.com/fig1.png');

  const parsed = parseDiagramColumnValue(serialized);
  assert.deepEqual(parsed.urls, ['https://cdn.example.com/fig1.png']);
  assert.equal(parsed.optionDiagrams, null);
});

test('multiple stem images serialize into compact JSON envelope and round-trip cleanly', () => {
  const urls = [
    'https://cdn.example.com/fig1.png',
    'https://cdn.example.com/fig2.png',
    'https://cdn.example.com/fig3.png',
  ];
  const serialized = serializeQuestionDiagramsForColumn(urls, null);
  assert.ok(serialized && serialized.startsWith('{'));

  const studentRpcRow = {
    id: '00000000-0000-4000-8000-000000000001',
    syllabus_id: '00000000-0000-4000-8000-000000000010',
    year: 2026,
    series: 'May/June',
    paper_number: 41,
    question_number: '2',
    parent_question_id: null,
    question_text: 'Compare Fig. 1, Fig. 2, and Fig. 3.',
    question_style: 'Structured',
    topic: 'Mechanics',
    sub_topic: null,
    difficulty: 'Medium',
    marks: 6,
    diagram_url: serialized,
    sub_questions: [
      {
        sub_id: '(a)',
        question_text: 'Use the two graphs below.',
        marks: 3,
        diagram_url: 'https://cdn.example.com/sub_a_1.png',
        diagram_urls: [
          'https://cdn.example.com/sub_a_1.png',
          'https://cdn.example.com/sub_a_2.png',
        ],
      },
    ],
    // Simulate Postgres sanitize_question_json_for_student stripping mark_scheme
    mark_scheme: null,
    created_at: '2026-11-22T00:00:00.000Z',
  };

  const normalized = normalizeQuestionRecord(studentRpcRow);
  assert.equal(normalized.diagram_url, 'https://cdn.example.com/fig1.png');
  assert.deepEqual(normalized.diagram_urls, urls);
  assert.deepEqual(resolveQuestionDiagramUrls(normalized), urls);
  assert.equal(normalized.option_diagrams, null);

  assert.equal(normalized.sub_questions.length, 1);
  assert.equal(normalized.sub_questions[0].diagram_url, 'https://cdn.example.com/sub_a_1.png');
  assert.deepEqual(normalized.sub_questions[0].diagram_urls, [
    'https://cdn.example.com/sub_a_1.png',
    'https://cdn.example.com/sub_a_2.png',
  ]);
});

test('MC option_diagrams and image-only MC choices survive student RPC mark_scheme stripping', () => {
  const stemUrls = ['https://cdn.example.com/circuit_main.png'];
  const optDiagrams = [
    'https://cdn.example.com/opt_A.png',
    'https://cdn.example.com/opt_B.png',
    'https://cdn.example.com/opt_C.png',
    'https://cdn.example.com/opt_D.png',
  ];

  const serializedCol = serializeQuestionDiagramsForColumn(stemUrls, optDiagrams);
  assert.ok(serializedCol && serializedCol.startsWith('{'));

  const studentRow = {
    id: '00000000-0000-4000-8000-000000000002',
    syllabus_id: '00000000-0000-4000-8000-000000000010',
    year: 2026,
    series: 'May/June',
    paper_number: 11,
    question_number: '5',
    parent_question_id: null,
    question_text: 'Which circuit diagram shows two resistors in parallel?',
    question_style: normalizeQuestionStyle(undefined, ['', '', '', ''], optDiagrams),
    topic: 'Electricity',
    sub_topic: null,
    difficulty: 'Easy',
    marks: 1,
    diagram_url: serializedCol,
    options: ['', '', '', ''],
    sub_questions: [],
    mark_scheme: null,
    created_at: '2026-11-22T00:00:00.000Z',
  };

  assert.equal(studentRow.question_style, 'Multiple Choice');
  const normalized = normalizeQuestionRecord(studentRow);
  const sanitized = sanitizeQuestionsForStudent([normalized], true)[0];

  assert.equal(sanitized.diagram_url, 'https://cdn.example.com/circuit_main.png');
  assert.deepEqual(sanitized.diagram_urls, ['https://cdn.example.com/circuit_main.png']);
  assert.deepEqual(sanitized.option_diagrams, optDiagrams);
  assert.equal(resolveOptionDiagramUrl(sanitized, 2, ''), 'https://cdn.example.com/opt_C.png');
  assert.deepEqual(resolveOptionDiagramUrls(sanitized, 4), optDiagrams);
});

test('inline markdown option images are extracted and stripped cleanly from option text', () => {
  const rawOpt = 'C. ![Graph C](https://cdn.example.com/graph_c.png)';
  assert.equal(resolveOptionDiagramUrl(null, 2, rawOpt), 'https://cdn.example.com/graph_c.png');
  assert.equal(stripInlineMarkdownImage(rawOpt), 'C.');
});

test('deterministicGradingService grades image-only MC options and Multiple Select accurately', () => {
  const mcqVisualQ = {
    id: '00000000-0000-4000-8000-000000000003',
    syllabus_id: '00000000-0000-4000-8000-000000000010',
    year: 2026,
    series: 'May/June',
    paper_number: 11,
    question_number: '8',
    parent_question_id: null,
    question_text: 'Which velocity-time graph represents uniform acceleration?',
    question_style: 'Multiple Choice',
    topic: 'Kinematics',
    sub_topic: null,
    difficulty: 'Easy',
    marks: 1,
    diagram_url: null,
    options: ['', '', '', ''],
    option_diagrams: [
      'https://cdn.example.com/g_a.png',
      'https://cdn.example.com/g_b.png',
      'https://cdn.example.com/g_c.png',
      'https://cdn.example.com/g_d.png',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: ['C [1]'],
      acceptable_answers: ['C'],
    },
    created_at: '2026-11-22T00:00:00.000Z',
  };

  assert.equal(resolveMcqCorrectOptionIndex(mcqVisualQ), 2);
  assert.equal(resolveQuestionModelAnswer(mcqVisualQ), 'Option C (Diagram)');

  const correctByIndex = gradeDeterministicAnswer(2, mcqVisualQ);
  assert.equal(correctByIndex.isHandled, true);
  assert.equal(correctByIndex.isCorrect, true);
  assert.equal(correctByIndex.earnedMarks, 1);

  const wrongByIndex = gradeDeterministicAnswer(0, mcqVisualQ);
  assert.equal(wrongByIndex.isHandled, true);
  assert.equal(wrongByIndex.isCorrect, false);
  assert.equal(wrongByIndex.earnedMarks, 0);
  assert.ok(!wrongByIndex.feedback.includes('()'));

  const multiSelectVisualQ = {
    ...mcqVisualQ,
    question_style: 'Multiple Select',
    marks: 2,
    mark_scheme: {
      marking_points: ['B, D [2]'],
      acceptable_answers: ['B, D'],
    },
  };

  const msCorrect = gradeDeterministicAnswer('B, D', multiSelectVisualQ);
  assert.equal(msCorrect.isHandled, true);
  assert.equal(msCorrect.isCorrect, true);
  assert.equal(msCorrect.earnedMarks, 2);

  assert.deepEqual(normalizeDiagramUrlList([' https://a ', '', 'https://a', 'https://b']), ['https://a', 'https://b']);
  assert.deepEqual(normalizeOptionDiagramList([' https://a ', '', null, 'https://d', null]), ['https://a', null, null, 'https://d']);
});

console.log(`\nAll ${passed} multi-image & MC option diagram regression tests passed.`);
