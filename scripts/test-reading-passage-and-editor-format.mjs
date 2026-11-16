import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const memStorage = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (k) => (memStorage.has(k) ? memStorage.get(k) : null),
    setItem: (k, v) => memStorage.set(k, String(v)),
    removeItem: (k) => memStorage.delete(k),
    clear: () => memStorage.clear(),
  };
}
if (!globalThis.window) {
  globalThis.window = {
    localStorage: globalThis.localStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { origin: 'http://localhost', href: 'http://localhost/' },
  };
}

const { formatLatexForHtml } = await import('../src/services/pdfExportService.ts');
const { parseFormattedTextToDocxRuns } = await import('../src/services/docxExportService.ts');
const examMathSrc = fs.readFileSync(path.resolve('src/components/ExamMathText.tsx'), 'utf8');
const inlineGapSrc = fs.readFileSync(path.resolve('src/components/InlineGapText.tsx'), 'utf8');
const editorModalSrc = fs.readFileSync(path.resolve('src/components/QuestionEditorModal.tsx'), 'utf8');
const studentRunnerSrc = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');
const headerEditorSrc = fs.readFileSync(path.resolve('src/components/TestHeaderEditor.tsx'), 'utf8');
const paperPreviewSrc = fs.readFileSync(path.resolve('src/components/TestPaperPreview.tsx'), 'utf8');

const {
  PASSAGE_OPEN_TAG,
  PASSAGE_CLOSE_TAG,
  NO_PASSAGE_TAG,
  stripPassageControlTags,
  hasNoPassageDirective,
  hasExplicitPassageMarkers,
  toggleNoPassageDirective,
  clearPassageMarkers,
  wrapSelectionWithToken,
  parseInstructionLines,
  toggleBulletPrefixOnSelection,
  insertNewLineAtSelection,
  splitPassageAndPrompt,
  resolveInheritedStimulusPassage,
} = await import('../src/lib/readingPassageUtils.ts');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`✅ ${label}`);
    passed++;
  } else {
    console.error(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ── Step 1A: CEFR Q1 False-Positive Prevention & [no_passage] Override ──────
const cefrQ1Prompt =
  'Read the notice from a school library below carefully before choosing your option.\n\n' +
  'Students returning overdue textbooks after Friday must bring their library card to the front desk so the librarian can update their borrowing record for next term.\n\n' +
  'Choose the correct statement about the notice.';

const cefrSplitDefault = splitPassageAndPrompt(cefrQ1Prompt, ['A', 'B'], {
  allowParagraphHeuristic: true,
});
check(
  'Step 1.1: Tightened Rule 2 does NOT split ordinary 2-paragraph CEFR Q1 (<350 char prose + instruction)',
  cefrSplitDefault.passageText === null && cefrSplitDefault.promptText.includes('Read the notice'),
  `Got passage=${cefrSplitDefault.passageText}`
);

const longNoPassageStem =
  `${NO_PASSAGE_TAG}\n` +
  'First paragraph of an extended writing/grammar prompt that easily exceeds four hundred characters to test whether the explicit [no_passage] directive disables splitting even on long stems with multiple paragraphs and trailing questions. ' +
  'It describes context about a community event in detail for candidates to consider.\n\n' +
  'Second paragraph continuing the background scenario with additional details for candidates to read carefully.\n\n' +
  'Which option best completes the response?';

const cefrNoPassage = splitPassageAndPrompt(longNoPassageStem, null, {
  allowParagraphHeuristic: true,
});
check(
  'Step 1.2: [no_passage] forces passageText=null and strips directive cleanly',
  cefrNoPassage.passageText === null &&
    cefrNoPassage.explicitMode === 'disabled' &&
    !cefrNoPassage.promptText.includes(NO_PASSAGE_TAG) &&
    cefrNoPassage.promptText.includes('Which option best completes')
);

// ── Step 1B: Explicit [passage]...[/passage] Boundaries ────────────────────
const explicitWrapped =
  `${PASSAGE_OPEN_TAG}Paragraph A: Short poem.\n\n1. Internal numbered item inside passage.${PASSAGE_CLOSE_TAG}\n\n` +
  'What does line 1 suggest?';
const explicitSplit = splitPassageAndPrompt(explicitWrapped, null, {
  allowParagraphHeuristic: false,
});
check(
  'Step 1.3: [passage]...[/passage] extracts exact boundaries even under 180 chars or in non-heuristic mode',
  explicitSplit.explicitMode === 'explicit_block' &&
    explicitSplit.passageText === 'Paragraph A: Short poem.\n\n1. Internal numbered item inside passage.' &&
    explicitSplit.promptText === 'What does line 1 suggest?'
);

// ── Step 1C: Rule 1 Fixed (### Heading followed by blank line + body) ──────
const stitchedPassageStem =
  '### Text 1\n\n' +
  'Paragraph one describes how mangrove forests protect coastal villages from storm surges and support juvenile fish habitats across tropical coastlines.\n\n' +
  'Paragraph two explains that community-led replanting programs have restored over three hundred hectares of mangrove wetlands in recent years.\n\n' +
  'Which of the following is the main benefit described in Text 1?';

const fixedRule1Split = splitPassageAndPrompt(stitchedPassageStem, null, {
  allowParagraphHeuristic: true,
});
check(
  'Step 1.4: Rule 1 keeps multi-paragraph body under ### Text 1 in passageText (fixes lazy title-only cutoff)',
  fixedRule1Split.passageText !== null &&
    fixedRule1Split.passageText.includes('### Text 1') &&
    fixedRule1Split.passageText.includes('Paragraph one describes') &&
    fixedRule1Split.passageText.includes('Paragraph two explains') &&
    !fixedRule1Split.passageText.includes('Which of the following') &&
    fixedRule1Split.promptText === 'Which of the following is the main benefit described in Text 1?'
);

// ── Step 1D: Cross-Question Inheritance (`resolveInheritedStimulusPassage`) ───
const multiQSet = [
  {
    question_text:
      '### Passage A\n\n' +
      'Dr. Elena Vance spent twelve months measuring glacier retreat across alpine valleys using solar-powered acoustic sensors.\n\n' +
      'What did Dr. Vance primarily measure?',
  },
  {
    question_text: 'How were the sensors powered according to the passage?',
  },
  {
    question_text: `${NO_PASSAGE_TAG}\nStandalone grammar question that must not inherit Passage A.`,
  },
];

const q2Inherited = resolveInheritedStimulusPassage(multiQSet, 1, {
  isLanguageExam: true,
  isCurrentStemOrMath: false,
  isQuestionStemOrMath: () => false,
});
const q3Inherited = resolveInheritedStimulusPassage(multiQSet, 2, {
  isLanguageExam: true,
  isCurrentStemOrMath: false,
  isQuestionStemOrMath: () => false,
});
check(
  'Step 1.5: resolveInheritedStimulusPassage supports lettered headings (### Passage A), strips Q1 prompt, and respects [no_passage]',
  q2Inherited !== null &&
    q2Inherited.includes('### Passage A') &&
    q2Inherited.includes('acoustic sensors') &&
    !q2Inherited.includes('What did Dr. Vance') &&
    q3Inherited === null
);

// ── Step 1E: wrapSelectionWithToken & Directive Toggles ────────────────────
const wrappedBold = wrapSelectionWithToken('Hello world', 6, 11, '**', '**');
const unwrappedBold = wrapSelectionWithToken(
  wrappedBold.nextText,
  wrappedBold.nextSelStart,
  wrappedBold.nextSelEnd,
  '**',
  '**'
);
const wrappedItalicFromBold = wrapSelectionWithToken('**world**', 2, 7, '*', '*');
const wrappedUnderline = wrapSelectionWithToken('underline me', 0, 9, '[u]', '[/u]');
const wrappedPassage = wrapSelectionWithToken(
  'Read this story.\n\nAnswer Q1.',
  0,
  16,
  PASSAGE_OPEN_TAG,
  PASSAGE_CLOSE_TAG
);

check(
  'Step 1.6: wrapSelectionWithToken toggles **bold**, avoids *italic*/**bold** confusion, wraps [u]...[/u] & [passage]...[/passage]',
  wrappedBold.nextText === 'Hello **world**' &&
    unwrappedBold.nextText === 'Hello world' &&
    wrappedItalicFromBold.nextText === '***world***' &&
    wrappedUnderline.nextText === '[u]underline[/u] me' &&
    hasExplicitPassageMarkers(wrappedPassage.nextText)
);

const toggledOn = toggleNoPassageDirective('Question text');
const toggledOff = toggleNoPassageDirective(toggledOn);
check(
  'Step 1.7: toggleNoPassageDirective and clearPassageMarkers cleanly manage markers',
  hasNoPassageDirective(toggledOn) &&
    toggledOff === 'Question text' &&
    clearPassageMarkers(`${PASSAGE_OPEN_TAG}Body${PASSAGE_CLOSE_TAG}\n\nQ?`) === 'Body\n\nQ?' &&
    stripPassageControlTags(`${NO_PASSAGE_TAG}\n${PASSAGE_OPEN_TAG}Hi${PASSAGE_CLOSE_TAG}`) === 'Hi'
);

// ── Step 2: Renderer & Exporter Tag Stripping + Bold/Italic/Underline Parity ─
const sampleMarkup =
  `${PASSAGE_OPEN_TAG}Read **bold**, *italic*, [u]underlined[/u], and ***both***.${PASSAGE_CLOSE_TAG}\n\n` +
  `${NO_PASSAGE_TAG}\nAnswer 3 * 4 carefully.`;

const pdfHtml = formatLatexForHtml(sampleMarkup);
check(
  'Step 2.1: pdfExportService strips passage control tags, renders <strong>, <em>, <u>, and ignores spaced math multiplication (3 * 4)',
  !pdfHtml.includes('[passage]') &&
    !pdfHtml.includes('[/passage]') &&
    !pdfHtml.includes('[no_passage]') &&
    pdfHtml.includes('<strong>bold</strong>') &&
    pdfHtml.includes('<em>italic</em>') &&
    pdfHtml.includes('<u>underlined</u>') &&
    pdfHtml.includes('<strong><em>both</em></strong>') &&
    pdfHtml.includes('3 * 4')
);

const docxRuns = parseFormattedTextToDocxRuns(sampleMarkup);
const docxJson = JSON.stringify(docxRuns);
check(
  'Step 2.2: docxExportService strips passage control tags and builds runs for bold, italic, and underline',
  docxRuns.length > 1 &&
    !docxJson.includes('[passage]') &&
    !docxJson.includes('[/passage]') &&
    !docxJson.includes('[no_passage]') &&
    docxJson.includes('bold') &&
    docxJson.includes('italic') &&
    docxJson.includes('underlined')
);

check(
  'Step 2.3: ExamMathText & InlineGapText strip passage tags and ExamMathText supports <em> & <u>',
  /stripPassageControlTags/.test(examMathSrc) &&
    /renderInlineRichText/.test(examMathSrc) &&
    /<em\b/.test(examMathSrc) &&
    /<u\b/.test(examMathSrc) &&
    /stripPassageControlTags/.test(inlineGapSrc)
);

// ── Step 3: QuestionEditorModal Context Menu, Shortcuts & Runner Wiring ─────
check(
  'Step 3.1: QuestionEditorModal implements right-click formatting menu, Ctrl+B/I/U/M shortcuts, and passage markers',
  /handleTextareaContextMenu/.test(editorModalSrc) &&
    /handleTextareaKeyDown/.test(editorModalSrc) &&
    /applySelectionFormat/.test(editorModalSrc) &&
    /q-editor-context-menu/.test(editorModalSrc) &&
    /Mark as Reading Passage/.test(editorModalSrc) &&
    /toggleNoPassageDirective/.test(editorModalSrc) &&
    /splitPassageAndPrompt/.test(editorModalSrc)
);

check(
  'Step 3.2: StudentQuizRunner delegates passage splitting & inheritance to readingPassageUtils',
  /from '\.\.\/lib\/readingPassageUtils'/.test(studentRunnerSrc) &&
    /resolveInheritedStimulusPassage/.test(studentRunnerSrc)
);

// ── Step 4: Exam Instructions Newlines, Bullets, Auto-Expand & Simple Menu ─
const parsedInst = parseInstructionLines(
  'Answer **all** questions.\n- Write in *black* ink.\n• Show [u]all[/u] working.\n*Keep silent* during exam.'
);
check(
  'Step 4.1: parseInstructionLines parses bullets (- / •) cleanly without mistaking *italic* for a bullet',
  parsedInst.length === 4 &&
    parsedInst[0].type === 'paragraph' &&
    parsedInst[1].type === 'bullet' &&
    parsedInst[1].text === 'Write in *black* ink.' &&
    parsedInst[2].type === 'bullet' &&
    parsedInst[2].text === 'Show [u]all[/u] working.' &&
    parsedInst[3].type === 'paragraph' &&
    parsedInst[3].text === '*Keep silent* during exam.'
);

const toggledBullet = toggleBulletPrefixOnSelection('Line 1\nLine 2', 0, 12);
const untoggledBullet = toggleBulletPrefixOnSelection(
  toggledBullet.nextText,
  0,
  toggledBullet.nextText.length
);
const withNewLine = insertNewLineAtSelection('HelloWorld', 5, 5);
check(
  'Step 4.2: toggleBulletPrefixOnSelection & insertNewLineAtSelection toggle bullets cleanly',
  toggledBullet.nextText === '- Line 1\n- Line 2' &&
    untoggledBullet.nextText === 'Line 1\nLine 2' &&
    withNewLine.nextText === 'Hello\nWorld'
);

check(
  'Step 4.3: TestHeaderEditor auto-expands instructions textarea, adds simple right-click menu, and views render bullets cleanly',
  /scrollHeight/.test(headerEditorSrc) &&
    /header-inst-context-menu/.test(headerEditorSrc) &&
    /Toggle Bullet Point/.test(headerEditorSrc) &&
    !/Mark as Reading Passage/.test(headerEditorSrc) &&
    /parseInstructionLines/.test(studentRunnerSrc) &&
    /parseInstructionLines/.test(paperPreviewSrc)
);

// Verify leading/trailing newlines after fill-in-the-blank tokens are preserved
check(
  'Step 4.4: stripPassageControlTags preserves edges when requested and InlineGapText converts chunk-edge newlines to <br />',
  stripPassageControlTags('\n\nNature reserve', true) === '\n\nNature reserve' &&
    /leadMatch/.test(inlineGapSrc) &&
    /stripPassageControlTags\(content,\s*true\)/.test(inlineGapSrc) &&
    /stripPassageControlTags\(.*,\s*true\)/.test(examMathSrc)
);

console.log(`\nReading Passage & Editor Format summary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
