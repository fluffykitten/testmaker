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
} from '../src/lib/pdfChunker.ts';
import { getExtractionPrompt, extractQuestionsFromPdf } from '../src/lib/gemini.ts';

const testPdfs = [
  {
    name: 'Ions & Ionic Bonds (Theory Pack)',
    path: 'C:/Users/orin/.gemini/antigravity-ide/brain/637d58d9-db11-479d-a254-537eb73658d7/.user_uploaded/media_1793151309896.pdf',
    expectedTopic: 'Ions & Ionic Bonds',
    expectedTotal: 19,
    expectedMarks: 185,
    expectedEasy: 6,
    expectedEasyMarks: 49,
    expectedMed: 7,
    expectedMedMarks: 59,
    expectedHard: 6,
    expectedHardMarks: 77,
  },
  {
    name: 'Simple Molecules & Covalent Bonds (Theory Pack)',
    path: 'C:/Users/orin/.gemini/antigravity-ide/brain/637d58d9-db11-479d-a254-537eb73658d7/.user_uploaded/media_1793152454939.pdf',
    expectedTopic: 'Simple Molecules & Covalent Bonds',
    expectedTotal: 15,
    expectedMarks: 117,
    expectedEasy: 5,
    expectedEasyMarks: 28,
    expectedMed: 5,
    expectedMedMarks: 36,
    expectedHard: 5,
    expectedHardMarks: 53,
  },
];

async function runTheoryTests() {
  console.log('🧪 Starting Multi-PDF Save My Exams Theory / Structured Pack Tests...\n');

  for (const item of testPdfs) {
    console.log(`\n============================================================`);
    console.log(`📄 Testing: ${item.name}`);
    console.log(`============================================================`);

    const rawBytes = fs.readFileSync(item.path);
    const isSme = await isSaveMyExamsDocument(rawBytes);
    assert.strictEqual(isSme, true, 'Must detect as Save My Exams document');

    const { chunks, meta } = await splitSaveMyExamsPdfBySections(rawBytes);
    console.log('Detected Metadata:', {
      isSaveMyExams: meta.isSaveMyExams,
      packType: meta.packType,
      topic: meta.topic,
      subTopics: meta.subTopics,
      easyExpected: meta.easyExpected,
      easyMarks: meta.easyMarks,
      medExpected: meta.medExpected,
      medMarks: meta.medMarks,
      hardExpected: meta.hardExpected,
      hardMarks: meta.hardMarks,
      totalExpected: meta.totalExpected,
      totalMarks: meta.totalMarks,
    });

    assert.strictEqual(meta.packType, 'theory', 'Must detect packType as "theory"');
    assert.strictEqual(meta.topic, item.expectedTopic, `Must extract topic "${item.expectedTopic}"`);
    assert.strictEqual(meta.easyExpected, item.expectedEasy, `Easy count must match ${item.expectedEasy}`);
    assert.strictEqual(meta.easyMarks, item.expectedEasyMarks, `Easy marks must match ${item.expectedEasyMarks}`);
    assert.strictEqual(meta.medExpected, item.expectedMed, `Medium count must match ${item.expectedMed}`);
    assert.strictEqual(meta.medMarks, item.expectedMedMarks, `Medium marks must match ${item.expectedMedMarks}`);
    assert.strictEqual(meta.hardExpected, item.expectedHard, `Hard count must match ${item.expectedHard}`);
    assert.strictEqual(meta.hardMarks, item.expectedHardMarks, `Hard marks must match ${item.expectedHardMarks}`);
    assert.strictEqual(meta.totalExpected, item.expectedTotal, `Total count must match ${item.expectedTotal}`);
    assert.strictEqual(meta.totalMarks, item.expectedMarks, `Total marks must match ${item.expectedMarks}`);
    assert.strictEqual(chunks.length, 3, 'Must split into 3 chunks');
    console.log('✓ Metadata and section boundaries 100% matched!');

    // Live Gemini Extraction on Easy Section Chunk
    console.log(`\nLive Gemini Extraction on Easy Section (Pages ${chunks[0].startPage}–${chunks[0].endPage}, ${item.expectedEasy} questions, ${item.expectedEasyMarks} marks)...`);
    const easyChunk = chunks[0];
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
        saveMyExamsPackType: 'theory',
        targetSection: 'Easy',
        topicHint: item.expectedTopic,
      }
    );

    console.log(`\nExtracted ${extractResult.questions.length} questions from Easy section (Expected: ${item.expectedEasy})`);
    let totalExtractedMarks = 0;
    extractResult.questions.forEach((q) => {
      totalExtractedMarks += q.total_marks || 0;
      console.log(
        `   - ${q.question_number} [${q.estimated_difficulty}] (${q.total_marks} marks, ${q.sub_questions?.length || 0} sub-parts): "${q.question_text.slice(0, 60).replace(/\n/g, ' ')}..."`
      );
      if (q.sub_questions && q.sub_questions.length > 0) {
        q.sub_questions.forEach((sq) => {
          console.log(`       * ${sq.sub_id} (${sq.marks} marks): "${sq.question_text.slice(0, 50).replace(/\n/g, ' ')}..."`);
        });
      }
      assert(q.question_number.startsWith('Easy -'), `Must start with "Easy -", got: ${q.question_number}`);
      assert.strictEqual(q.question_style, 'Structured', 'Question style must be Structured');
      assert.deepStrictEqual(q.options || [], [], 'Options array must be empty');
      assert(q.sub_questions && q.sub_questions.length > 0, 'Must have sub_questions');
    });

    console.log(`\nTotal extracted marks: ${totalExtractedMarks} (Expected: ~${item.expectedEasyMarks})`);
    assert.strictEqual(extractResult.questions.length, item.expectedEasy, `Must extract exactly ${item.expectedEasy} questions from Easy section`);
    console.log(`✓ 100% Verified: All ${item.expectedEasy} structured questions extracted cleanly with full sub-question hierarchy!`);
  }

  console.log('\n🎉 ALL SAVE MY EXAMS THEORY TESTS PASSED ACROSS ALL UPLOADED PDFS (100% VERIFIED)!');
}

runTheoryTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
