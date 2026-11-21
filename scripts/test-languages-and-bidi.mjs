import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';

if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {};
}

const { parseQuestionRange, expandTargetQuestionTokens, mergeChunkPassagesAndQuestions } =
  await import('../src/lib/passageMerge.ts');
const { stitchPassagesToQuestions } = await import('../src/lib/passageExtractor.ts');
const { propagateReadingPassages, filterActiveDiagramDataForSave } = await import('../src/lib/pdfProcessor.ts');
const { splitPassageAndPrompt } = await import('../src/lib/readingPassageUtils.ts');
const { parseTableChoiceFromQuestion } = await import('../src/lib/tableChoiceUtils.ts');

const { classifySubject } = await import('../src/lib/subjectClassifier.ts');
const { getLanguageExtractionPrompt } = await import('../src/lib/gemini.ts');
const { splitPdfForParallelExtraction } = await import('../src/lib/pdfChunker.ts');
const {
  isArabicText,
  hasArabicCharacters,
  isDominantlyArabicText,
} = await import('../src/services/deterministicGradingService.ts');

let passed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    process.exit(1);
  }
}

// 1. Exact Q13-15 -> Q1 passage overwrite regression test
{
  const jaheBody =
    'Jahe adalah tanaman jenis rempah-rempah yang memiliki nama latin Zingiber Officinale. '.repeat(20);
  const sapuSapuBody =
    'Ikan sapu-sapu, yang dikenal juga sebagai pleco, pada dasarnya bisa dikonsumsi jika berasal dari perairan bersih. '.repeat(
      25
    );

  const chunk0 = {
    paper_metadata: { subject: 'Bahasa Indonesia', subject_code: 'BI', year: 2026, series: 'Ganjil', paper_number: 1, has_insert_booklet: false },
    passages: [
      {
        id: 'Text 1',
        heading: '(Teks untuk soal nomor 1-3)',
        body: jaheBody,
        page_number: 1,
        target_questions: ['1', '2', '3'],
      },
    ],
    questions: [
      { question_number: '1', passage_ref: 'Text 1', question_text: 'Makna tersirat...', total_marks: 1 },
      { question_number: '2', passage_ref: 'Text 1', question_text: 'Berdasarkan informasi...', total_marks: 1 },
      { question_number: '3', passage_ref: 'Text 1', question_text: 'Fakta yang tepat...', total_marks: 1 },
    ],
  };

  const chunk1 = {
    paper_metadata: { subject: 'Bahasa Indonesia', subject_code: 'BI', year: 2026, series: 'Ganjil', paper_number: 1, has_insert_booklet: false },
    passages: [
      {
        // Independent chunk ALSO reused "Text 1" AND its passage body is longer than Chunk 0's!
        id: 'Text 1',
        heading: '(Teks untuk soal nomor 13-15)',
        body: sapuSapuBody,
        page_number: 2,
        target_questions: ['13', '14', '15'],
      },
    ],
    questions: [
      { question_number: '13', passage_ref: 'Text 1', question_text: 'Tentukan BENAR dan SALAH...', total_marks: 5 },
      { question_number: '14', passage_ref: 'Text 1', question_text: 'Topik paragraf kedua...', total_marks: 1 },
      { question_number: '15', passage_ref: 'Text 1', question_text: 'Keseimbangan informasi...', total_marks: 1 },
    ],
  };

  // Overlapping chunk re-extracting the same Q13-15 passage with longer/full text
  const chunk2Overlap = {
    paper_metadata: { subject: 'Bahasa Indonesia', subject_code: 'BI', year: 2026, series: 'Ganjil', paper_number: 1, has_insert_booklet: false },
    passages: [
      {
        id: 'Text 1',
        heading: '(Teks untuk soal nomor 13-15)',
        body: sapuSapuBody + ' Kalimat penutup.',
        page_number: 1,
        target_questions: ['13', '14', '15'],
      },
    ],
    questions: [],
  };

  const merged = mergeChunkPassagesAndQuestions([chunk0, chunk1, chunk2Overlap]);
  const passageMap = new Map(merged.passages.map((p) => [p.id, p]));
  const q1Ref = merged.chunkQuestions[0][0].passage_ref;
  const q13Ref = merged.chunkQuestions[1][0].passage_ref;

  check(
    'LANG-1a: Cross-chunk "Text 1" collision keeps Jahe (Q1-3) and Ikan sapu-sapu (Q13-15) completely separate',
    merged.passages.length === 2 &&
      q1Ref !== q13Ref &&
      passageMap.get(q1Ref)?.body.startsWith('Jahe adalah tanaman') &&
      passageMap.get(q13Ref)?.body.startsWith('Ikan sapu-sapu') &&
      passageMap.get(q13Ref)?.body.endsWith('Kalimat penutup.')
  );

  // Full stitching + propagation + split-view Reading Passage check (including Q13 Table Choice!)
  const flatQuestions = [
    ...merged.chunkQuestions[0],
    {
      ...merged.chunkQuestions[1][0],
      question_text:
        '13. Tentukan BENAR dan SALAH pada pernyataan-pernyataan berikut!\n\n' +
        '| PERNYATAAN | BENAR | SALAH |\n|---|---|---|\n' +
        '| Ikan sapu-sapu hidup di air tawar. | [ ] | [ ] |',
    },
    ...merged.chunkQuestions[1].slice(1),
  ];
  const pass1 = propagateReadingPassages(stitchPassagesToQuestions(flatQuestions, merged.passages));
  const pass2 = propagateReadingPassages(stitchPassagesToQuestions(pass1, merged.passages));

  const q1Stitched = pass2[0].question_text;
  const q13Stitched = pass2[3].question_text;
  const q1Split = splitPassageAndPrompt(q1Stitched, null, { allowParagraphHeuristic: false });

  // Simulate StudentQuizRunner's currentTable.preTableText extraction for Q13
  const q13TableParsed = parseTableChoiceFromQuestion(q13Stitched);
  const q13PreTableSplit = splitPassageAndPrompt(q13TableParsed.stemText, null, {
    allowParagraphHeuristic: false,
  });

  const openCountQ1 = (q1Stitched.match(/\[passage\]/g) || []).length;
  const closeCountQ1 = (q1Stitched.match(/\[\/passage\]/g) || []).length;

  check(
    'LANG-1b: stitchPassagesToQuestions wraps extracted passages in [passage]...[/passage] idempotently across Q1 & Q13 Table Choice',
    openCountQ1 === 1 &&
      closeCountQ1 === 1 &&
      q1Split.explicitMode === 'explicit_block' &&
      q1Split.passageText?.includes('Jahe adalah tanaman') &&
      !q1Split.passageText?.includes('Ikan sapu-sapu') &&
      q1Split.promptText === 'Makna tersirat...' &&
      q13PreTableSplit.explicitMode === 'explicit_block' &&
      q13PreTableSplit.passageText?.includes('Ikan sapu-sapu') &&
      !q13PreTableSplit.passageText?.includes('Jahe adalah tanaman') &&
      q13PreTableSplit.promptText === '13. Tentukan BENAR dan SALAH pada pernyataan-pernyataan berikut!'
  );
}

// 2. Bilingual Indonesian & English question range parsing
{
  const r1 = parseQuestionRange('(Teks untuk soal nomor 1-3)');
  const r2 = parseQuestionRange('(Infografis utk soal nomor 11 & 12)');
  const r3 = parseQuestionRange('(Teks untuk nomor 18 saja)');
  const r4 = parseQuestionRange('soal no 6 s.d. 10');
  const exp = expandTargetQuestionTokens(['1-3', '11 & 12', 'R14-16']);
  check(
    'LANG-2: parseQuestionRange & expandTargetQuestionTokens handle Indonesian "nomor", "&", "saja", "s.d."',
    r1?.start === 1 && r1?.end === 3 &&
      r2?.start === 11 && r2?.end === 12 &&
      r3?.start === 18 && r3?.end === 18 &&
      r4?.start === 6 && r4?.end === 10 &&
      exp.has('1') && exp.has('2') && exp.has('3') &&
      exp.has('11') && exp.has('12') && exp.has('R15')
  );
}

// 3. Subject classifier for Bahasa Indonesia & non-regression for Cambridge
{
  const biMatch = classifySubject([
    'SCHOOL: SMA INSAN CENDEKIA MADANI SUBJECT: BAHASA INDONESIA GRADE/ SEMESTER: 10/ GANJIL',
  ]);
  const engMatch = classifySubject(['Cambridge IGCSE 0500/11 First Language English']);
  check(
    'LANG-3: classifySubject detects Bahasa Indonesia as non-Cambridge languages while preserving 0500',
    biMatch?.profile.domain === 'languages' &&
      biMatch?.profile.isNonCambridge === true &&
      engMatch?.profile.domain === 'languages' &&
      engMatch?.profile.syllabusCode === '0500' &&
      !engMatch?.profile.isNonCambridge
  );
}

// 4. Language prompt enhancements (range-scoped IDs, >30 Qs, Infographics, mixed Arabic+Indonesian)
{
  const prompt = getLanguageExtractionPrompt(true, false, false);
  check(
    'LANG-4: getLanguageExtractionPrompt enforces range-scoped IDs, Infographic linking, 40+ Q coverage, and BiDi preservation',
    prompt.includes('Teks Q13-15') &&
      prompt.includes('Infografis') &&
      prompt.includes('Question 1 through Question 40+') &&
      prompt.includes('harakat')
  );
}

// 5. Dense 19-page PDF chunking respects compact page budget (maxPagesPerChunk=4)
{
  const doc = await PDFDocument.create();
  for (let i = 0; i < 19; i++) doc.addPage();
  const bytes = await doc.save();
  const chunks = await splitPdfForParallelExtraction(bytes, 4);
  const maxSpan = Math.max(...chunks.map((c) => c.endPage - c.startPage + 1));
  check(
    'LANG-5: splitPdfForParallelExtraction(19 pages, 4) splits into compact chunks <= 6 pages instead of 10-page overload',
    chunks.length === 5 && maxSpan <= 6,
    `chunks=${chunks.length}, maxSpan=${maxSpan}`
  );
}

// 6. Mixed Arabic + Indonesian BiDi classification
{
  const pureArabic = 'مَا إِعْرَابُ كَلِمَةِ (الْمُسْلِمُونَ) فِي الْجُمْلَةِ الآتِيَةِ؟';
  const arabicWithLabel = 'Q9: اخْتَرِ الإِجَابَةَ الصَّحِيحَةَ فِي هٰذِهِ الْجُمْلَةِ';
  const mixedIndoWithArabicWord =
    'Arti dari lafaz السَّلَامُ عَلَيْكُمْ pada kalimat pembuka teks di atas adalah...';
  const mixedIndoStartsWithQuote =
    '"بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ" artinya dalam kehidupan sehari-hari seorang muslim adalah...';

  check(
    'BIDI-1: isDominantlyArabicText returns true for predominantly Arabic questions and false for mixed Indonesian+Arabic',
    isDominantlyArabicText(pureArabic) === true &&
      isDominantlyArabicText(arabicWithLabel) === true &&
      isDominantlyArabicText(mixedIndoWithArabicWord) === false &&
      isDominantlyArabicText(mixedIndoStartsWithQuote) === false &&
      isArabicText(mixedIndoWithArabicWord) === true &&
      hasArabicCharacters(mixedIndoWithArabicWord) === true
  );
}

// 7. Save-time diagram filtering respects deletions, splits, and deselected questions
{
  const fakeItem = (tag) => ({ blob: new Blob([tag]), localUrl: `blob:${tag}`, sourceDoc: 'qp', pageNumber: 1 });
  const diagramMap = new Map([
    ['1', fakeItem('q1-deleted')],
    ['2', fakeItem('q2-kept')],
    ['2_sub_0', fakeItem('q2a-deleted')],
    ['2_sub_1', fakeItem('q2b-kept')],
    ['3', fakeItem('q3-deselected')],
    ['4b', fakeItem('q4b-split')],
  ]);
  const questionsToSave = [
    { question_number: '1', has_diagram: false, sub_questions: [] },
    {
      question_number: '2',
      has_diagram: true,
      sub_questions: [
        { sub_id: '(a)', has_diagram: false },
        { sub_id: '(b)', has_diagram: true },
      ],
    },
    { question_number: '4b', has_diagram: true, sub_questions: [] },
  ];
  const filtered = filterActiveDiagramDataForSave(questionsToSave, diagramMap);
  check(
    'SAVE-1: filterActiveDiagramDataForSave excludes deleted/deselected diagrams while keeping active & split-renamed diagrams',
    !filtered.has('1') &&
      filtered.has('2') &&
      !filtered.has('2_sub_0') &&
      filtered.has('2_sub_1') &&
      !filtered.has('3') &&
      filtered.has('4b')
  );
}

console.log(`\nALL ${passed} LANGUAGES & ARABIC/INDONESIAN BIDI CHECKS PASSED`);
