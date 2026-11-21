import assert from 'node:assert/strict';

const {
  detectMarkSchemeTableStart,
  shouldTrimMarkScheme,
  isAnswerKeyStartPageText,
} = await import('../src/lib/markSchemeDetect.ts');

const {
  normalizeSubIdKey,
  isPlaceholderMarkSchemeText,
  hasAiFallbackTag,
  sumBracketedMarks,
  extractOptionLettersFromMarkScheme,
  auditQuestionMarkScheme,
  auditExtractionMarkSchemes,
  chooseBetterMarkScheme,
  chooseBetterSubMarkScheme,
} = await import('../src/lib/markSchemeAudit.ts');

const {
  buildGeminiMultimodalParts,
  getExtractionPrompt,
} = await import('../src/lib/gemini.ts');

const {
  getCambridgePracticalExtractionPrompt,
} = await import('../src/lib/practicalPrompt.ts');

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

// 1. Document-labeled multimodal parts
{
  const partsWithAll = buildGeminiMultimodalParts('PROMPT', 'QP_B64', 'MS_B64', 'INS_B64');
  const textLabels = partsWithAll.filter((p) => typeof p.text === 'string').map((p) => p.text);
  const inlineDataOrder = partsWithAll.filter((p) => p.inlineData).map((p) => p.inlineData.data);
  check(
    'MS-1a: buildGeminiMultimodalParts labels QP, Insert, and Official MS in exact order',
    partsWithAll.length === 7 &&
      textLabels[0] === 'PROMPT' &&
      textLabels[1].includes('DOCUMENT 1: QUESTION PAPER') &&
      textLabels[2].includes('DOCUMENT 2: INSERT / RESOURCE BOOKLET') &&
      textLabels[3].includes('DOCUMENT 3: OFFICIAL MARK SCHEME') &&
      inlineDataOrder.join(',') === 'QP_B64,INS_B64,MS_B64'
  );

  const qpOnlyParts = buildGeminiMultimodalParts('PROMPT', 'QP_ONLY');
  check(
    'MS-1b: buildGeminiMultimodalParts handles QP-only without empty MS/Insert parts',
    qpOnlyParts.length === 3 &&
      qpOnlyParts[1].text.includes('DOCUMENT 1: QUESTION PAPER') &&
      qpOnlyParts[2].inlineData.data === 'QP_ONLY'
  );
}

// 2. Prompt strictness across all domains & Practical Paper 5
{
  const configs = [
    { name: 'STEM', args: [true, 'stem', false, true, true, false, undefined, undefined, undefined, undefined, false] },
    { name: 'Languages', args: [true, 'languages', false, true, false, false, undefined, undefined, undefined, undefined, false] },
    { name: 'Humanities', args: [true, 'humanities', true, true, true, false, undefined, undefined, undefined, undefined, false] },
    { name: 'IELTS/CEFR', args: [true, 'languages', false, true, false, false, undefined, undefined, undefined, undefined, true] },
    { name: 'SaveMyExams MCQ', args: [true, 'stem', false, true, true, true, 'Medium', 'Kinematics', 'mcq', undefined, false] },
    { name: 'SaveMyExams Theory', args: [true, 'stem', false, true, true, true, 'Hard', 'Bonding', 'theory', undefined, false] },
  ];

  for (const cfg of configs) {
    const strictPrompt = getExtractionPrompt(...cfg.args, true);
    const qpOnlyPrompt = getExtractionPrompt(...cfg.args, false);
    check(
      `MS-2 (${cfg.name}): hasMarkScheme=true enforces STRICT NO-OVERRIDE & [NOT IN MARK SCHEME — AI SOLVED]`,
      strictPrompt.includes('OFFICIAL MARK SCHEME STRICT ALIGNMENT PROTOCOL') &&
        strictPrompt.includes('STRICT NO-OVERRIDE RULE') &&
        strictPrompt.includes('[NOT IN MARK SCHEME — AI SOLVED]') &&
        !strictPrompt.includes('AUTONOMOUS MARK SCHEME GENERATION PROTOCOL'),
      `prompt missing strict directives for ${cfg.name}`
    );
    check(
      `MS-2 (${cfg.name}): hasMarkScheme=false enforces AUTONOMOUS generation without claiming official MS PDF`,
      qpOnlyPrompt.includes('AUTONOMOUS MARK SCHEME GENERATION PROTOCOL') &&
        qpOnlyPrompt.includes('STRICT MARK-TAG SUM PARITY') &&
        !qpOnlyPrompt.includes('An Official Mark Scheme / Answer Key PDF IS ATTACHED (DOCUMENT 3)')
    );
  }

  const dummyOutline = {
    usable: true,
    reasons: [],
    totalMarks: 40,
    profile: { key: '0620-52', family: 'practical-5x', syllabus: '0620', paperCode: '52' },
    questions: [
      {
        number: 1,
        totalMarks: 14,
        subs: [{ id: '(a)', marks: 2, isStem: false }],
      },
    ],
  };
  const pracStrict = getCambridgePracticalExtractionPrompt(dummyOutline, { includeGuidance: true, hasMarkScheme: true });
  const pracQpOnly = getCambridgePracticalExtractionPrompt(dummyOutline, { includeGuidance: true, hasMarkScheme: false });
  check(
    'MS-2 (Practical): hasMarkScheme=true includes non-override & missing fallback tag; hasMarkScheme=false fixes "marks" typo',
    pracStrict.includes('OFFICIAL MARK SCHEME STRICT ALIGNMENT PROTOCOL') &&
      pracStrict.includes('NEVER paraphrase, override, or replace') &&
      pracStrict.includes('[NOT IN MARK SCHEME — AI SOLVED]') &&
      pracQpOnly.includes('sub-question\'s "mark_scheme"') &&
      !pracQpOnly.includes('sub-question\'s "marks"')
  );
}

// 3. Preamble trim guard & in-PDF Answer Key heading detection
{
  // Cambridge standard header on page 5
  const cambridgeMs = [
    'Cambridge IGCSE Generic Marking Principles published by UCLES Page 1',
    'Generic Marking Principles continued',
    'Science-Specific Marking Principles',
    'Abbreviations used in mark schemes',
    'Question Answer Marks 1(a) 25 cm3 [1]',
    '2(a) Copper(II) sulfate [1]',
  ];
  const camStart = detectMarkSchemeTableStart(cambridgeMs);
  check(
    'MS-3a: Cambridge MS trims at "Question Answer Marks" header (page 5)',
    camStart.startPage === 5 && camStart.method === 'header' && shouldTrimMarkScheme(camStart, cambridgeMs.length)
  );

  // Cambridge Sociology rubric before header
  const socioMs = [
    'Cambridge IGCSE Sociology Generic Marking Principles UCLES',
    'Marking abbreviations',
    'Generic levels of response grids Table A – use this table for 14-mark answers',
    'Table B – use this table',
    'Question Answer Marks 1(a) Define socialisation [2]',
  ];
  const socioStart = detectMarkSchemeTableStart(socioMs);
  check(
    'MS-3b: Cambridge Sociology rubric grid before header trims at rubric page 3',
    socioStart.startPage === 3 && socioStart.method === 'rubric' && shouldTrimMarkScheme(socioStart, socioMs.length)
  );

  // Cambridge part-label fallback when preamble phrases ARE present and no early answers exist
  const cambridgePartFallback = [
    'Cambridge International Generic Marking Principles UCLES',
    'Mark Scheme Abbreviations: owtte; ora; ecf',
    '1(a) Mass increases [1] 1(b) Exothermic [1]',
    '2(a) Titre = 24.5 cm3 [1]',
  ];
  const fbStart = detectMarkSchemeTableStart(cambridgePartFallback);
  check(
    'MS-3c: Cambridge MS without header still trims preamble before part-label when Cambridge preamble is present',
    fbStart.startPage === 3 && fbStart.method === 'part-label' && shouldTrimMarkScheme(fbStart, cambridgePartFallback.length)
  );

  // Non-Cambridge teacher MS with MCQ answers on page 1 and 1(a) on page 2 -> MUST NOT drop page 1!
  const customMixedMs = [
    'Physics Quiz Answers  1. B   2. A   3. D   4. C   5. B',
    'Section B Structured  1(a) F = ma [1] = 10 N [1]',
    '2(a) Energy conserved [1]',
  ];
  const customStart = detectMarkSchemeTableStart(customMixedMs);
  check(
    'MS-3d: Custom multi-page MS with MCQ answers on Page 1 and 1(a) on Page 2 is NEVER trimmed',
    customStart.startPage === 1 && customStart.method === 'none' && !shouldTrimMarkScheme(customStart, customMixedMs.length)
  );

  // Embedded in-PDF answer key detection
  check(
    'MS-3e: isAnswerKeyStartPageText matches Indonesian & English headings and rejects mid-prose question text',
    isAnswerKeyStartPageText('KUNCI JAWABAN DAN PEMBAHASAN SOAL UJIAN  1. C  2. A') &&
      isAnswerKeyStartPageText('PEDOMAN PENSKORAN EVALUASI AKHIR') &&
      isAnswerKeyStartPageText('Rubrik Penilaian Matematika') &&
      isAnswerKeyStartPageText('MARK SCHEME FOR PAPER 2 OCTOBER/NOVEMBER') &&
      !isAnswerKeyStartPageText(
        'Question 4. A teacher explains an experiment to students. Using the mark scheme for peer assessment, discuss why repeat readings reduce random error. ' +
          'State two variables controlled in this investigation.'
      ) &&
      !isAnswerKeyStartPageText(
        `${'Lorem ipsum question text. '.repeat(22)} Answer Key appendix note.`
      )
  );
}

// 4. markSchemeAudit helpers & QA verdicts
{
  check(
    'MS-4a: normalizeSubIdKey unifies "(a)(ii)", "a(ii)", "a.ii", and " (A)(II) "',
    normalizeSubIdKey('(a)(ii)') === 'aii' &&
      normalizeSubIdKey('a(ii)') === 'aii' &&
      normalizeSubIdKey(' a.ii ') === 'aii' &&
      normalizeSubIdKey(' (A)(II) ') === 'aii'
  );

  check(
    'MS-4b: sumBracketedMarks sums marks accurately and ignores Fill-in-the-Blank "[18]" gap indices & obeys max caps',
    sumBracketedMarks(['Formula n = m/M [1]', '0.25 mol [1]', 'Volume = 6.0 dm^3 [1]']) === 3 &&
      sumBracketedMarks(['[18] fortress [1]', '[19] bullfights [1]']) === 2 &&
      sumBracketedMarks(['Any 3 of: point A [1]; point B [1]; point C [1]; point D [1] (max 3)']) === 3 &&
      sumBracketedMarks(['No bracket tags here']) === null
  );

  const emptyMsAudit = auditQuestionMarkScheme({
    question_text: 'Explain osmosis.',
    question_style: 'Structured',
    total_marks: 3,
    mark_scheme: { marking_points: ['See marking criteria'], acceptable_answers: [] },
  });
  check(
    'MS-4c: auditQuestionMarkScheme flags placeholder MS as error',
    emptyMsAudit.status === 'error' && emptyMsAudit.issues.some((i) => i.code === 'missing_mark_scheme')
  );

  const mcqBadAudit = auditQuestionMarkScheme({
    question_text: 'Which gas turns limewater milky?',
    question_style: 'Multiple Choice',
    options: ['A. Oxygen', 'B. Carbon dioxide', 'C. Hydrogen', 'D. Nitrogen'],
    total_marks: 1,
    mark_scheme: { marking_points: ['Carbon dioxide gas [1]'], acceptable_answers: ['carbon dioxide'] },
  });
  const mcqGoodAudit = auditQuestionMarkScheme({
    question_text: 'Which gas turns limewater milky?',
    question_style: 'Multiple Choice',
    options: ['A. Oxygen', 'B. Carbon dioxide', 'C. Hydrogen', 'D. Nitrogen'],
    total_marks: 1,
    mark_scheme: { marking_points: ['B — Carbon dioxide reacts with Ca(OH)2 [1]'], acceptable_answers: ['B'] },
  });
  check(
    'MS-4d: auditQuestionMarkScheme enforces valid option letters on MCQ & accepts "B — ..." / ["B"]',
    mcqBadAudit.status === 'error' &&
      mcqBadAudit.issues.some((i) => i.code === 'mcq_missing_letter') &&
      mcqGoodAudit.status === 'ok'
  );

  const multiSelectBad = auditQuestionMarkScheme({
    question_text: 'Select all true statements.',
    question_style: 'Multiple Select',
    options: ['A. 1', 'B. 2', 'C. 3', 'D. 4', 'E. 5'],
    total_marks: 2,
    mark_scheme: { marking_points: ['A [2]'], acceptable_answers: ['A'] },
  });
  const multiSelectGood = auditQuestionMarkScheme({
    question_text: 'Select all true statements.',
    question_style: 'Multiple Select',
    options: ['A. 1', 'B. 2', 'C. 3', 'D. 4', 'E. 5'],
    total_marks: 2,
    mark_scheme: { marking_points: ['A, C [2]'], acceptable_answers: ['A, C'] },
  });
  check(
    'MS-4e: auditQuestionMarkScheme validates Multiple Select letter counts',
    multiSelectBad.status === 'error' &&
      multiSelectBad.issues.some((i) => i.code === 'multi_select_missing_letters') &&
      multiSelectGood.status === 'ok'
  );

  const tableChoiceMismatch = auditQuestionMarkScheme({
    question_text:
      'Tentukan Tepat/Tidak Tepat:\n| No. | Pernyataan | Tepat | Tidak Tepat |\n|---|---|---|---|\n| 1 | S1 | [ ] | [ ] |\n| 2 | S2 | [ ] | [ ] |\n| 3 | S3 | [ ] | [ ] |',
    question_style: 'Table Choice',
    total_marks: 3,
    mark_scheme: {
      marking_points: ['1. S1: Tepat [1]', '2. S2: Tidak Tepat [1]'],
      acceptable_answers: [],
    },
  });
  check(
    'MS-4f: auditQuestionMarkScheme flags Table Choice row count mismatch & [1] sum mismatch',
    tableChoiceMismatch.status === 'warning' &&
      tableChoiceMismatch.issues.some((i) => i.code === 'table_choice_row_mismatch') &&
      tableChoiceMismatch.issues.some((i) => i.code === 'marks_sum_mismatch')
  );

  const subMismatchAudit = auditQuestionMarkScheme({
    question_text: 'Parent stem',
    question_style: 'Structured',
    total_marks: 4,
    sub_questions: [
      { sub_id: '(a)', question_text: 'Explain...', marks: 2, mark_scheme: '[NOT IN MARK SCHEME — AI SOLVED] One point [1]' },
      { sub_id: '(b)', question_text: 'State...', marks: 2, mark_scheme: 'Correct [2]' },
    ],
  });
  check(
    'MS-4g: auditQuestionMarkScheme flags sub-question [NOT IN MARK SCHEME] fallback and [1] vs [2] sum mismatch',
    subMismatchAudit.status === 'warning' &&
      subMismatchAudit.issues.some((i) => i.code === 'ai_fallback_used') &&
      subMismatchAudit.issues.some((i) => i.code === 'marks_sum_mismatch')
  );

  const batchSummary = auditExtractionMarkSchemes([emptyMsAudit, mcqGoodAudit, tableChoiceMismatch].map((_, idx) =>
    idx === 0
      ? { question_text: 'Q1', question_style: 'Short Answer', total_marks: 2, mark_scheme: null }
      : idx === 1
        ? { question_text: 'Q2', question_style: 'Multiple Choice', options: ['A. 1', 'B. 2'], total_marks: 1, mark_scheme: { marking_points: ['B [1]'], acceptable_answers: ['B'] } }
        : { question_text: 'Q3', question_style: 'Structured', total_marks: 2, mark_scheme: { marking_points: ['One point [1]'], acceptable_answers: [] } }
  ));
  check(
    'MS-4h: auditExtractionMarkSchemes aggregates error/warning/ok counts accurately',
    batchSummary.errorCount === 1 &&
      batchSummary.warningCount === 1 &&
      batchSummary.okCount === 1 &&
      batchSummary.flaggedIndices.join(',') === '0,2'
  );
}

// 5. Smart chunk-merge mark scheme preservation
{
  const officialExisting = {
    _option_group: 'Q2 or Q3',
    marking_points: ['Official step 1 [1]', 'Official step 2 [1]'],
    acceptable_answers: ['4.5 cm'],
  };
  const aiFallbackIncoming = {
    _cambridge_ms_hub_url: 'https://schoolsupporthub.cambridge.org/item/123',
    marking_points: ['[NOT IN MARK SCHEME — AI SOLVED] Longer hallucinated explanation that happens to have many words [1]'],
    acceptable_answers: [],
    guidance: ['Check units'],
  };

  const mergedMs = chooseBetterMarkScheme(officialExisting, aiFallbackIncoming, 2);
  check(
    'MS-5a: chooseBetterMarkScheme keeps official exact-mark MS over longer AI-fallback chunk & preserves underscore metadata + backfills guidance',
    mergedMs !== undefined &&
      mergedMs.marking_points[0] === 'Official step 1 [1]' &&
      mergedMs.acceptable_answers?.[0] === '4.5 cm' &&
      mergedMs.guidance?.[0] === 'Check units' &&
      mergedMs._option_group === 'Q2 or Q3' &&
      mergedMs._cambridge_ms_hub_url === 'https://schoolsupporthub.cambridge.org/item/123'
  );

  const placeholderExisting = { marking_points: ['See marking criteria'], acceptable_answers: [] };
  const validIncoming = { marking_points: ['B [1]'], acceptable_answers: ['B'] };
  check(
    'MS-5b: chooseBetterMarkScheme replaces placeholder MS with valid incoming MS',
    chooseBetterMarkScheme(placeholderExisting, validIncoming, 1)?.acceptable_answers?.[0] === 'B'
  );

  const subOfficial = 'Copper(II) sulfate [1]; blue precipitate [1]';
  const subFallback = '[NOT IN MARK SCHEME — AI SOLVED] Some guessed long paragraph without complete alignment [1]';
  check(
    'MS-5c: chooseBetterSubMarkScheme prefers mark-aligned official sub-MS over longer AI-fallback text',
    chooseBetterSubMarkScheme(subOfficial, subFallback, 2) === subOfficial &&
      chooseBetterSubMarkScheme('See marking criteria', subOfficial, 2) === subOfficial
  );
}

// Verify extractOptionLettersFromMarkScheme handles "Answer: C" & rationales
check(
  'MS-6: extractOptionLettersFromMarkScheme extracts letters cleanly from mixed formats',
  extractOptionLettersFromMarkScheme({ marking_points: ['Answer: D [1]'], acceptable_answers: [] }, 4).join(',') === 'D' &&
    extractOptionLettersFromMarkScheme({ marking_points: ['B and E [2]'], acceptable_answers: ['B, E'] }, 5).join(',') === 'B,E'
);

console.log(`\nALL ${passed} MARK SCHEME STRICTNESS & GENERATION CHECKS PASSED`);
