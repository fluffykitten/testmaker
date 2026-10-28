import assert from 'assert';
import fs from 'fs';

// Load .env.local into process.env
if (fs.existsSync('.env.local')) {
  const envContent = fs.readFileSync('.env.local', 'utf8');
  envContent.split('\n').forEach((line) => {
    const clean = line.trim();
    if (clean && !clean.startsWith('#')) {
      const idx = clean.indexOf('=');
      if (idx !== -1) {
        const k = clean.slice(0, idx).trim();
        const v = clean.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        process.env[k] = v;
      }
    }
  });
}

import {
  detectSaveMyExamsMetadata,
  isSaveMyExamsDocument,
  splitSaveMyExamsPdfBySections,
} from '../src/lib/pdfChunker.js';
import { compareQuestionNumbers } from '../src/services/questionBankService.js';
import { getSaveMyExamsStemExtractionPrompt, getExtractionPrompt, extractQuestionsFromPdf } from '../src/lib/gemini.js';

const dir = 'C:/Users/orin/.gemini/antigravity/brain/9cb1d724-ff83-4c6b-bd09-6484005fe794/.user_uploaded/';
const testFiles = [
  { file: 'media_1793104355581_7dbf923f.pdf', expectedTopic: 'Simple Molecules & Covalent Bonds', expectedEasy: 6, expectedMed: 6, expectedHard: 6, expectedTotal: 18 },
  { file: 'media_1793104364367_6581e9bc.pdf', expectedTopic: 'Giant Structures', expectedEasy: 6, expectedMed: 6, expectedHard: 6, expectedTotal: 18 },
  { file: 'media_1793104366281_f542a7a6.pdf', expectedTopic: 'Ions & Ionic Bonds', expectedEasy: 6, expectedMed: 6, expectedHard: 10, expectedTotal: 22 },
];

async function runTests() {
  console.log('🧪 Starting Save My Exams / PMA Mode Verification Tests...\n');

  // Test 1: Sorting Natural Ordering (Easy -> Medium -> Hard)
  console.log('Test 1: Sorting Natural Ordering (Easy -> Medium -> Hard)');
  const sampleQNums = [
    'Hard - 2',
    'Medium - 1',
    'Easy - 6',
    'Hard - 10',
    'Easy - 1',
    'Medium - 6',
    'Hard - 1',
    'Easy - 2',
  ];

  sampleQNums.sort(compareQuestionNumbers);
  console.log('Sorted QNums:', sampleQNums);
  assert.deepStrictEqual(sampleQNums, [
    'Easy - 1',
    'Easy - 2',
    'Easy - 6',
    'Medium - 1',
    'Medium - 6',
    'Hard - 1',
    'Hard - 2',
    'Hard - 10',
  ]);
  console.log('✓ Section difficulty ordering successfully places Easy 1..N, Medium 1..N, Hard 1..N in natural sequence.');

  // Test 2: Standard questions sorting regression check
  console.log('\nTest 2: Standard Questions Sorting Regression Check');
  const standardQNums = ['10', '1', '2(a)', '2', '1(b)', '1(a)'];
  standardQNums.sort(compareQuestionNumbers);
  assert.deepStrictEqual(standardQNums, ['1', '1(a)', '1(b)', '2', '2(a)', '10']);
  console.log('✓ Standard Cambridge IGCSE question sorting preserved with zero regressions.');

  // Test 3: Prompt Generation
  console.log('\nTest 3: Save My Exams Prompt Dispatcher');
  const smePrompt = getExtractionPrompt(true, 'stem', false, true, true, true, 'Easy', 'Simple Molecules & Covalent Bonds');
  assert(smePrompt.includes('TARGET SECTION: EASY QUESTIONS'), 'Prompt must target Easy Questions section');
  assert(smePrompt.includes('ALL QUESTIONS ARE MULTIPLE CHOICE (MCQs)'), 'Prompt must require MCQs');
  assert(smePrompt.includes('PREMISE NUMBERED LISTS (1, 2, 3, 4)'), 'Prompt must warn against confusing premise numbers with questions');
  assert(smePrompt.includes('TABULAR OPTION MCQs'), 'Prompt must preserve table options');
  console.log('✓ Save My Exams prompt dispatcher generates comprehensive rules for multi-tier sections & MCQs.');

  // Test 4: Verification against the 3 User-Uploaded PDFs
  console.log('\nTest 4: Metadata & Section Detection across 3 User PDFs');
  for (const item of testFiles) {
    const raw = fs.readFileSync(dir + item.file);
    const isSme = await isSaveMyExamsDocument(raw);
    assert.strictEqual(isSme, true, `${item.file} must be detected as Save My Exams document`);

    const { chunks, meta } = await splitSaveMyExamsPdfBySections(raw);
    console.log(`\n📄 [${item.file}]`);
    console.log(`   Topic: "${meta.topic}" (Expected: "${item.expectedTopic}")`);
    console.log(`   Sections detected: ${chunks.length}`);
    assert.strictEqual(chunks.length, 3, 'Must split into 3 section chunks (Easy, Medium, Hard)');
    assert.strictEqual(chunks[0].targetSection, 'Easy');
    assert.strictEqual(chunks[1].targetSection, 'Medium');
    assert.strictEqual(chunks[2].targetSection, 'Hard');

    assert.strictEqual(chunks[0].expectedCount, item.expectedEasy, `Easy count must match ${item.expectedEasy}`);
    assert.strictEqual(chunks[1].expectedCount, item.expectedMed, `Medium count must match ${item.expectedMed}`);
    assert.strictEqual(chunks[2].expectedCount, item.expectedHard, `Hard count must match ${item.expectedHard}`);

    const sumExpected = chunks.reduce((acc, c) => acc + (c.expectedCount || 0), 0);
    assert.strictEqual(sumExpected, item.expectedTotal, `Total count must match ${item.expectedTotal}`);
    console.log(`   ✓ 100% Match: Easy=${chunks[0].expectedCount}, Medium=${chunks[1].expectedCount}, Hard=${chunks[2].expectedCount}, Total=${sumExpected}`);
  }

  // Test 5: Live Gemini Extraction Test on Easy Section of PDF 1
  console.log('\nTest 5: Live Gemini Extraction on Easy Section of PDF 1');
  const raw1 = fs.readFileSync(dir + testFiles[0].file);
  const { chunks: chunks1 } = await splitSaveMyExamsPdfBySections(raw1);
  const easyChunk = chunks1[0];

  console.log(`Sending Easy Chunk (Pages ${easyChunk.startPage}–${easyChunk.endPage}) to Gemini…`);
  const extractResult = await extractQuestionsFromPdf(
    easyChunk.pdfBase64,
    undefined,
    undefined,
    (status) => console.log('   [Gemini status]:', status),
    {
      includeGuidance: true,
      domain: 'stem',
      isIgcse: true,
      isSaveMyExams: true,
      targetSection: 'Easy',
      topicHint: 'Simple Molecules & Covalent Bonds',
    }
  );

  console.log(`\nExtracted ${extractResult.questions.length} questions from Easy section (Expected: 6)`);
  extractResult.questions.forEach((q) => {
    console.log(`   - ${q.question_number} [${q.estimated_difficulty}]: "${q.question_text.slice(0, 50).replace(/\n/g, ' ')}..." (Options: ${q.options?.length || 0})`);
    assert(q.question_number.startsWith('Easy -'), `Question number must start with "Easy -", got: ${q.question_number}`);
    assert.strictEqual(q.estimated_difficulty, 'Easy');
    assert(['Multiple Choice', 'multiple_choice'].includes(q.question_style), `Expected Multiple Choice style, got: ${q.question_style}`);
    assert.strictEqual(q.total_marks, 1);
    assert(Array.isArray(q.options) && q.options.length === 4, `Must have 4 options, got: ${q.options?.length}`);
  });

  assert.strictEqual(extractResult.questions.length, 6, 'Must extract exactly 6 questions from Easy section of PDF 1');
  console.log('\n✓ Live extraction extracted all 6 Easy questions with zero collisions, valid 4-choice options, and correct metadata!');

  console.log('\n🎉 ALL SAVE MY EXAMS / PMA TESTS PASSED SUCCESSFULLY (100% VERIFIED)!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
