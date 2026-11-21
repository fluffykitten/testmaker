import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';

if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {};
}

const pdfjsLib = await import('pdfjs-dist');
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
  ).href;
}

const { parseQuestionRange, expandTargetQuestionTokens, mergeChunkPassagesAndQuestions } =
  await import('../src/lib/passageMerge.ts');
const { stitchPassagesToQuestions } = await import('../src/lib/passageExtractor.ts');
const { propagateReadingPassages, filterActiveDiagramDataForSave, mergeChunkQuestions } = await import(
  '../src/lib/pdfProcessor.ts'
);
const { splitPassageAndPrompt } = await import('../src/lib/readingPassageUtils.ts');
const { parseTableChoiceFromQuestion } = await import('../src/lib/tableChoiceUtils.ts');

const { classifySubject } = await import('../src/lib/subjectClassifier.ts');
const {
  getLanguageExtractionPrompt,
  getStemExtractionPrompt,
  buildGeminiMultimodalParts,
  remapBoundingBoxFromCrop,
  prioritizeModelsForVisualArabic,
  cleanExtAndLatexArtifacts,
  normalizeOptions,
  stripDuplicateOptionsFromStem,
} = await import('../src/lib/gemini.ts');
const { extractOptionLettersFromMarkScheme, auditQuestionMarkScheme } = await import('../src/lib/markSchemeAudit.ts');
const { cleanMcqOptionContent } = await import('../src/services/quizSubmissionService.ts');
const { getHumanitiesExtractionPrompt } = await import('../src/lib/humanitiesPrompt.ts');
const { splitPdfForParallelExtraction, detectArabicPagesInPdf } = await import('../src/lib/pdfChunker.ts');
const { normalizeExtractedArabicText, containsArabicScript } = await import('../src/lib/arabicTextUtils.ts');
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

// 8. Arabic / Islamic Studies classifier + Arabic normalization + visual page image bypass
{
  const paiMatch = classifySubject(['SOAL PILIHAN GANDA PAI KELAS XI Tahun Pelajaran 2026/2027']);
  const arabMatch = classifySubject(['UJIAN AKHIR SEMESTER BAHASA ARAB KELAS X']);
  check(
    'ARABIC-1: classifySubject detects PAI (Humanities) and Bahasa Arab (Languages) as non-Cambridge',
    paiMatch?.syllabusCode === 'PAI' &&
      paiMatch?.profile.domain === 'humanities' &&
      paiMatch?.profile.isNonCambridge === true &&
      arabMatch?.syllabusCode === 'BAR' &&
      arabMatch?.profile.domain === 'languages' &&
      arabMatch?.profile.isNonCambridge === true
  );

  // Presentation Forms (\uFEF7 = LAM WITH ALEF WITH HAMZA ABOVE ISOLATED) + detached harakat + math safety
  const corrupted = 'Menemukan bacaan \u202Aال\uFEF7لبَاب ِ\u202C dan rumus x² + H₂O, خَلْق ِ السَّمَاوَات ِ';
  const normalized = normalizeExtractedArabicText(cleanExtAndLatexArtifacts(corrupted));
  check(
    'ARABIC-2: normalizeExtractedArabicText converts Arabic Presentation Forms to logical Unicode, reattaches harakat, and keeps x² intact',
    !normalized.includes('\uFEF7') &&
      !normalized.includes('\u202A') &&
      normalized.includes('لألبَابِ') &&
      normalized.includes('خَلْقِ السَّمَاوَاتِ') &&
      normalized.includes('x²') &&
      containsArabicScript('الْأَ')
  );

  const visualParts = buildGeminiMultimodalParts(
    'PROMPT',
    'RAW_PDF_BASE64',
    'MS_PDF_BASE64',
    undefined,
    [
      { pageNumber: 1, mimeType: 'image/png', data: 'IMG_P1' },
      { pageNumber: 2, mimeType: 'image/png', data: 'IMG_P2' },
    ]
  );
  const hasRawQpPdf = visualParts.some((p) => p?.inlineData?.mimeType === 'application/pdf' && p?.inlineData?.data === 'RAW_PDF_BASE64');
  const pngParts = visualParts.filter((p) => p?.inlineData?.mimeType === 'image/png');
  check(
    'ARABIC-3: buildGeminiMultimodalParts omits corrupted QP PDF binary when visual pageImages are supplied',
    !hasRawQpPdf && pngParts.length === 2 && pngParts[0].inlineData.data === 'IMG_P1'
  );

  const stemPrompt = getStemExtractionPrompt(true, false, false);
  const humPrompt = getHumanitiesExtractionPrompt(false, true, false, false);
  const langPrompt = getLanguageExtractionPrompt(true, false, false);
  check(
    'ARABIC-4: Arabic visual extraction guidance is injected across STEM, Humanities, and Languages prompts',
    [stemPrompt, humPrompt, langPrompt].every(
      (p) => p.includes('ARABIC SCRIPT & MIXED ARABIC') && p.includes('الْأَلْبَابِ') && p.includes('الْأَ')
    )
  );

  const samplePaiPdf =
    'C:\\Users\\orin\\.gemini\\antigravity\\brain\\c47873ec-764e-4639-9c60-2d8b6e73fc78\\.user_uploaded\\media_1795252322315_7c11710b.pdf';
  if (fs.existsSync(samplePaiPdf)) {
    const paiBytes = new Uint8Array(fs.readFileSync(samplePaiPdf));
    const arabicPages = await detectArabicPagesInPdf(paiBytes);
    const expectedPages = [3, 6, 8, 9, 11, 13, 14, 15, 16];
    check(
      'ARABIC-5: detectArabicPagesInPdf identifies every Arabic page (including Q5 on Page 3) in PAI sample paper',
      expectedPages.every((p) => arabicPages.has(p)) && arabicPages.size === expectedPages.length,
      `found=${Array.from(arabicPages).join(',')}`
    );
  }

  // 9. Cambridge / School ARABIC 0620 cover detection (guards against Chemistry template collision)
  const arabic0620Match = classifySubject(
    ['Cambridge IGCSE™ CANDIDATE NAME ARABIC 0620 Multiple Choice & Theory 2026 Additional materials: Periodic Table'],
    { fileName: '0620_arabic_p1.pdf' }
  );
  const chem0620Match = classifySubject(['Cambridge IGCSE CHEMISTRY 0620/21 Multiple Choice'], { fileName: '0620_s25_qp_21.pdf' });
  check(
    'ARABIC-6: classifySubject routes ARABIC 0620 (even with Chemistry template code) to languages without breaking real 0620 Chemistry',
    arabic0620Match?.profile.domain === 'languages' &&
      arabic0620Match?.syllabusCode === 'ARA' &&
      chem0620Match?.profile.domain === 'stem' &&
      chem0620Match?.syllabusCode === '0620'
  );

  // 10. Arabic option prefixes (أ، ب، ج، د، هـ / ه): normalizeOptions, stripDuplicateOptionsFromStem, cleanMcqOptionContent, QA audit
  const rawArOpts = [
    'أ. رَكْعَتَانِ بَعْدَهُ',
    'ب. رَكْعَتَانِ قَبْلَ الْفَرْضِ',
    'ج. صَلَاةُ الْعِشَاءِ',
    'د. أَرْبَعُ رَكَعَاتٍ',
    'ه. رَكْعَتَانِ قَبْلَ الْفَرْضِ وَ رَكْعَتَانِ بَعْدَهُ',
  ];
  const normOpts = normalizeOptions(rawArOpts);
  const stemWithDupArOpts = 'كم ركعة سنة صلاة الظهر ؟\n' + rawArOpts.join('\n');
  const cleanedStem = stripDuplicateOptionsFromStem(stemWithDupArOpts, normOpts);
  const msLetters = extractOptionLettersFromMarkScheme({ acceptable_answers: ['هـ'], marking_points: ['ه [1]'] }, 5);
  const msMulti = extractOptionLettersFromMarkScheme({ acceptable_answers: ['أ، ج'], marking_points: ['أ، ج [2]'] }, 5);
  const qaAudit = auditQuestionMarkScheme({
    question_text: 'كم ركعة سنة صلاة الظهر ؟',
    question_style: 'Multiple Choice',
    options: normOpts,
    total_marks: 1,
    mark_scheme: { marking_points: ['ه [1]'], acceptable_answers: ['ه'] },
  });
  check(
    'ARABIC-7: normalizeOptions, stripDuplicateOptionsFromStem, cleanMcqOptionContent & markSchemeAudit handle أ–هـ option labels',
    normOpts?.[0] === 'أ. رَكْعَتَانِ بَعْدَهُ' &&
      !normOpts?.[0].startsWith('A.') &&
      cleanedStem === 'كم ركعة سنة صلاة الظهر ؟' &&
      cleanMcqOptionContent('A. أ. رَكْعَتَانِ بَعْدَهُ', 0) === 'رَكْعَتَانِ بَعْدَهُ' &&
      cleanMcqOptionContent('ه. نص', 4) === 'نص' &&
      cleanMcqOptionContent('هـ. نص', 4) === 'نص' &&
      msLetters.join(',') === 'E' &&
      msMulti.join(',') === 'A,C' &&
      qaAudit.status === 'ok'
  );

  const sampleArabicExamPdf =
    'C:\\Users\\orin\\.gemini\\antigravity\\brain\\c47873ec-764e-4639-9c60-2d8b6e73fc78\\.user_uploaded\\media_1795258578279_56e300dd.pdf';
  if (fs.existsSync(sampleArabicExamPdf)) {
    const arBytes = new Uint8Array(fs.readFileSync(sampleArabicExamPdf));
    const arPages = await detectArabicPagesInPdf(arBytes);
    const arChunks = await splitPdfForParallelExtraction(arBytes, 3, {
      allowCompactChunks: true,
      overlapPages: 1,
    });
    const maxArSpan = Math.max(...arChunks.map((c) => c.endPage - c.startPage + 1));
    check(
      'ARABIC-8: detectArabicPagesInPdf flags all question pages (2..16), trims p17, and compact chunks stay <= 4 pages',
      arPages.size === 15 &&
        !arPages.has(1) &&
        !arPages.has(17) &&
        arPages.has(2) &&
        arPages.has(16) &&
        arChunks[arChunks.length - 1]?.endPage === 16 &&
        maxArSpan <= 4,
      `pages=${Array.from(arPages).join(',')}, maxSpan=${maxArSpan}, lastChunkEnd=${arChunks[arChunks.length - 1]?.endPage}`
    );
  }

  // 11. Regression test for duplicate R:: / W:: chunk merge bug (40 questions becoming 44 across overlapping chunks)
  const chunk0Overlap = [
    { question_number: '5', topic: 'Reading Comprehension', question_text: 'هَلْ عَلِيّ صَلَّى؟', total_marks: 1 },
    { question_number: '06', topic: 'Grammar', question_text: '...', total_marks: 1 },
  ];
  const chunk1Overlap = [
    { question_number: '٥', topic: 'Islamic Prayer', question_text: 'هَلْ عَلِيّ صَلَّى؟', options: ['أ. نَعَمْ', 'ب. لا'], total_marks: 1 },
    { question_number: '6', topic: 'Arabic Reading', question_text: '...', options: ['أ. سَرِيرٌ', 'ب. ...'], total_marks: 1 },
    { question_number: '17', topic: '', question_text: '[Turn over]', total_marks: 0 },
  ];
  const mergedNoDups = mergeChunkQuestions(
    [chunk0Overlap, chunk1Overlap],
    [{ startPage: 1 }, { startPage: 3 }],
    { isIeltsFlow: false, isSaveMyExams: false }
  );
  check(
    'MERGE-1: mergeChunkQuestions merges overlapping chunks strictly by Q# without R::/W:: topic splits or Eastern digit dupes',
    mergedNoDups.length === 2 &&
      mergedNoDups[0].question_number === '5' &&
      mergedNoDups[0].options?.length === 2 &&
      mergedNoDups[1].question_number === '6'
  );

  // 12. Q32 orthographic distractor preservation (سَكَنُ كَ with intentional space vs سَكَنُكِ vs سَكَنُكَ)
  const q32Opts = [
    'أ. سَكَنُ كَ',
    'ب. سَكَنُ أَنْتَ',
    'ج. سَكَنُكِ',
    'د. سَكَنُكُمْ',
    'ه. سَكَنُكَ',
  ];
  const q32Norm = normalizeOptions(q32Opts)?.map((o) => cleanExtAndLatexArtifacts(o)) || [];
  const q32LangPrompt = getLanguageExtractionPrompt(true, true, true);
  check(
    'ARABIC-9: Q32 orthographic distractors (سَكَنُ كَ vs سَكَنُكِ vs سَكَنُكَ) stay distinct through normalization and prompt rules',
    q32Norm.length === 5 &&
      q32Norm[0] === 'أ. سَكَنُ كَ' &&
      q32Norm[2] === 'ج. سَكَنُكِ' &&
      q32Norm[4] === 'ه. سَكَنُكَ' &&
      cleanMcqOptionContent(q32Norm[0], 0) !== cleanMcqOptionContent(q32Norm[4], 4) &&
      cleanMcqOptionContent(q32Norm[2], 2) !== cleanMcqOptionContent(q32Norm[4], 4) &&
      q32LangPrompt.includes('سَكَنُ كَ') &&
      q32LangPrompt.includes('سَكَنُكَ') &&
      q32LangPrompt.includes('margin-cropped PNG')
  );

  // 13. Single-image-per-page multimodal attachment + cropRegion inverse remapping + full-Flash model priority
  const singleParts = buildGeminiMultimodalParts('PROMPT', 'RAW_PDF', undefined, undefined, [
    {
      pageNumber: 1,
      mimeType: 'image/png',
      data: 'PAGE_1',
      cropRegion: { normYMin: 0.1, normXMin: 0.4, normYMax: 0.9, normXMax: 0.95 },
    },
    {
      pageNumber: 2,
      mimeType: 'image/png',
      data: 'PAGE_2',
    },
  ]);
  const remapped = remapBoundingBoxFromCrop([250, 500, 750, 1000], {
    normYMin: 0.1,
    normXMin: 0.4,
    normYMax: 0.9,
    normXMax: 0.95,
  });
  const prioritized = prioritizeModelsForVisualArabic([
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash-lite',
  ]);
  check(
    'ARABIC-10: Single PNG/page, remapBoundingBoxFromCrop inverse mapping, and prioritizeModelsForVisualArabic ordering',
    singleParts.filter((p) => p?.inlineData?.mimeType === 'image/png').length === 2 &&
      Array.isArray(remapped) &&
      remapped[0] === 300 &&
      remapped[1] === 675 &&
      remapped[2] === 700 &&
      remapped[3] === 950 &&
      prioritized[0] === 'gemini-2.5-flash' &&
      prioritized.indexOf('gemini-2.5-flash') < prioritized.indexOf('gemini-3.1-flash-lite') &&
      prioritized.indexOf('gemini-2.5-pro') < prioritized.indexOf('gemini-3.1-flash-lite')
  );
}

console.log(`\nALL ${passed} LANGUAGES & ARABIC/INDONESIAN BIDI CHECKS PASSED`);
