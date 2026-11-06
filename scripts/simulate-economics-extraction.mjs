import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));
const { PDFDocument } = await import('file://' + require.resolve('pdf-lib').replace(/\\/g, '/'));
const { parseOutline } = await import('../src/lib/paperOutlineParse.ts');
const { classifySubject } = await import('../src/lib/subjectClassifier.ts');
const { detectMarkSchemeTableStart, shouldTrimMarkScheme } = await import('../src/lib/markSchemeDetect.ts');
const { getHumanitiesExtractionPrompt } = await import('../src/lib/humanitiesPrompt.ts');

// 1. Read API credentials from .env.local
const envContent = fs.readFileSync('.env.local', 'utf8');
const apiKey = envContent.match(/VITE_GEMINI_API_KEY=(.*)/)?.[1]?.trim();
const modelArg = process.argv.find((a) => a.startsWith('--model='));
const model = modelArg ? modelArg.split('=')[1] : (process.env.MODEL || envContent.match(/VITE_GEMINI_MODEL=(.*)/)?.[1]?.trim() || 'gemini-3.5-flash-lite');

const paperArg = process.argv.find((a) => a.startsWith('--paper='));
const targetPaper = paperArg ? paperArg.split('=')[1] : '22';

if (!apiKey) {
  console.error('FATAL: VITE_GEMINI_API_KEY not found in .env.local');
  process.exit(1);
}

let qpFile;
let msFile;

if (targetPaper === '12') {
  qpFile = 'economics paper/0455 Economics June 2023 Question paper  12.pdf';
  msFile = 'economics paper/0455 Economics June 2023 Mark Scheme  12.pdf';
} else {
  qpFile = 'economics paper/0455 Economics June 2024 Question paper  22.pdf';
  msFile = 'economics paper/0455 Economics June 2024 Mark Scheme  22.pdf';
}

// Allow positional overrides
const nonFlagArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (nonFlagArgs[0]) qpFile = nonFlagArgs[0];
if (nonFlagArgs[1]) msFile = nonFlagArgs[1];

console.log(`[SIMULATION] Initializing Cambridge IGCSE Economics (0455/${targetPaper}) with model: ${model}`);
console.log(`[SIMULATION] Question Paper: ${qpFile}`);
console.log(`[SIMULATION] Mark Scheme:    ${msFile}`);

// Helper to read PDF layout
async function readPages(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data: data.slice(), useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({
      page: p,
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
      items: content.items
        .map((it) => ({
          s: it.str,
          x: Math.round(it.transform[4]),
          y: Math.round(it.transform[5]),
          w: Math.round(it.width),
          h: Math.round(it.height),
        }))
        .filter((i) => i.s.trim() !== ''),
    });
  }
  if (typeof doc.destroy === 'function') await doc.destroy();
  return pages;
}

// 2. Pre-processing: Subject Classification
console.log('\n--- STAGE 1: PRE-FLIGHT DETERMINISTIC CLASSIFICATION ---');
const qpPages = await readPages(qpFile);
const qpTexts = qpPages.map((p) => p.items.map((i) => i.s).join(' '));
const match = classifySubject(qpTexts, { fileName: path.basename(qpFile) });

console.log('Subject Classification:', match ? {
  syllabusCode: match.syllabusCode,
  subjectName: match.profile.subjectName,
  domain: match.profile.domain,
  paperCode: match.paperCode,
  hasInPaperStimulus: match.profile.hasInPaperStimulus,
  isOptionalChoicePaper: match.profile.isOptionalChoicePaper,
  standardTotalMarks: match.profile.standardTotalMarks,
} : 'UNRECOGNIZED');

// 3. Pre-processing: Outline Parsing
console.log('\n--- STAGE 2: DETERMINISTIC PAPER OUTLINE ---');
const outline = parseOutline(qpPages, { fileName: path.basename(qpFile) });
console.log('Outline Usable:', outline.usable);
console.log('Paper Family:', outline.profile?.paperFamily);
console.log('Option Groups:', JSON.stringify(outline.profile?.optionGroups));
console.log('Reasons:', outline.reasons);
console.log(`Questions found: ${outline.questions.length}`);
for (const q of outline.questions) {
  console.log(`  Q${q.number} (Section ${q.section || 'None'}): ${q.subs.length} sub-parts, declared total: ${q.declaredTotal}, sum: ${q.total}`);
  if (q.subs.length > 0) {
    console.log(`    Sub-IDs: ${q.subs.map((s) => s.id + (s.marks != null ? `[${s.marks}]` : '')).join(', ')}`);
  }
}

// 4. Pre-processing: Mark Scheme Preamble Trimming
console.log('\n--- STAGE 3: MARK SCHEME PREAMBLE TRIMMING ---');
const msPages = await readPages(msFile);
const msTexts = msPages.map((p) => p.items.map((i) => i.s).join(' '));
const start = detectMarkSchemeTableStart(msTexts);
console.log(`Original MS Pages: ${msPages.length}`);
console.log(`Trim Boundary Detected: startPage=${start.startPage}, method=${start.method}, rubricPage=${start.rubricPage ?? 'none'}`);

let trimmedMsBytes;
const rawMsBytes = new Uint8Array(fs.readFileSync(msFile));
if (shouldTrimMarkScheme(start, msPages.length)) {
  const source = await PDFDocument.load(rawMsBytes);
  const target = await PDFDocument.create();
  const indices = Array.from({ length: msPages.length - start.startPage + 1 }, (_, i) => start.startPage - 1 + i);
  const copied = await target.copyPages(source, indices);
  copied.forEach((page) => target.addPage(page));
  trimmedMsBytes = await target.save();
  console.log(`Trimmed ${start.startPage - 1} preamble pages. Sending pages ${start.startPage}–${msPages.length} to Gemini.`);
} else {
  trimmedMsBytes = rawMsBytes;
  console.log(`No trimming applied. Sending all ${msPages.length} pages.`);
}

// 5. Build Extraction Prompt
console.log('\n--- STAGE 4: PROMPT GENERATION ---');
const hasInsert = false; // Economics embeds stimulus directly in QP
const promptText = getHumanitiesExtractionPrompt(
  hasInsert,
  true,  // includeGuidance
  false, // extractResourceCatalog (no insert booklet)
  true,  // isIgcse
  match?.profile
);
console.log(`Prompt character length: ${promptText.length}`);

// 6. Call Gemini Multimodal API
console.log('\n--- STAGE 5: CALLING GEMINI MULTIMODAL API ---');
const qpBase64 = Buffer.from(fs.readFileSync(qpFile)).toString('base64');
const msBase64 = Buffer.from(trimmedMsBytes).toString('base64');

const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
const parts = [
  { text: promptText },
  { inlineData: { mimeType: 'application/pdf', data: qpBase64 } },
  { inlineData: { mimeType: 'application/pdf', data: msBase64 } },
];
const requestBody = {
  contents: [{ parts }],
  generationConfig: {
    responseMimeType: 'application/json',
    temperature: 0.1,
    maxOutputTokens: 32768,
  },
};

console.log(`Payload parts:`);
console.log(`  1. QP PDF: ${(qpBase64.length / 1024 / 1024).toFixed(2)} MB base64`);
console.log(`  2. MS PDF: ${(msBase64.length / 1024 / 1024).toFixed(2)} MB base64 (trimmed from ${msPages.length} to ${msPages.length - start.startPage + 1} pages)`);
console.log(`Sending request to ${model}... (this may take 25-60 seconds)`);

const startTime = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(requestBody),
});

const duration = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`Gemini HTTP Response: ${res.status} (${duration}s)`);

if (!res.ok) {
  const errText = await res.text();
  console.error(`Gemini Error (${res.status}):`, errText);
  process.exit(1);
}

const rawData = await res.json();
const text = rawData.candidates?.[0]?.content?.parts?.[0]?.text;

if (!text) {
  console.error('ERROR: No text content in Gemini response candidate');
  console.log('Candidate finishReason:', rawData.candidates?.[0]?.finishReason);
  process.exit(1);
}

// 7. Parse & Diagnose Extracted Output
console.log('\n--- STAGE 6: DIAGNOSIS OF EXTRACTED ECONOMICS JSON ---');
const outName = `scripts/extraction-economics-${targetPaper}.json`;
fs.writeFileSync(outName, text, 'utf8');
console.log(`Saved raw JSON response to ${outName}`);

let parsed;
try {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  }
  parsed = JSON.parse(cleaned);
} catch (e) {
  console.error('JSON Parse error:', e.message);
  process.exit(1);
}

console.log('\n[DIAGNOSIS: PAPER METADATA]');
console.log(JSON.stringify(parsed.paper_metadata, null, 2));

const questions = parsed.questions || [];
console.log(`\n[DIAGNOSIS: QUESTIONS SUMMARY] Total Questions: ${questions.length}`);

if (targetPaper === '12') {
  // Multiple Choice Analysis
  let mcqWith4Options = 0;
  let mcqWithAnswerKey = 0;
  let totalMcqMarks = 0;

  for (const q of questions) {
    const opts = q.options || [];
    const has4 = opts.length === 4;
    if (has4) mcqWith4Options++;
    const mark = Number(q.total_marks || q.marks || 1);
    totalMcqMarks += mark;

    const ms = q.mark_scheme;
    const ansKey = ms?.acceptable_answers?.[0] || (typeof ms === 'string' ? ms : '');
    if (ansKey && ansKey.length <= 4) mcqWithAnswerKey++;

    if (Number(q.question_number) <= 5 || Number(q.question_number) === 30) {
      console.log(`  Q${q.question_number} [${mark}m] (${q.question_style || 'MCQ'}): "${(q.question_text || '').slice(0, 70).replace(/\n/g, ' ')}..."`);
      console.log(`    Options: ${opts.map((o) => o.slice(0, 20)).join(' | ')}`);
      console.log(`    Key: ${ansKey}`);
    }
  }

  console.log(`\n======================================================`);
  console.log(`[DIAGNOSIS: MCQ ACCURACY]`);
  console.log(`Total Questions Extracted: ${questions.length} / 30`);
  console.log(`Questions with 4 Options:  ${mcqWith4Options} / 30`);
  console.log(`Questions with Answer Key: ${mcqWithAnswerKey} / 30`);
  console.log(`Total Marks Sum:           ${totalMcqMarks} / 30`);
} else {
  // Structured Paper 22 Analysis
  let totalExtractedMarks = 0;
  let sectionAMarks = 0;
  let sectionBMarks = 0;

  for (const q of questions) {
    const subs = q.sub_questions || [];
    const subMarks = subs.reduce((sum, s) => sum + (Number(s.marks) || 0), 0);
    totalExtractedMarks += subMarks;
    const qNum = Number(q.question_number) || 0;
    if (qNum === 1) sectionAMarks += subMarks;
    else sectionBMarks += subMarks;

    console.log(`\n======================================================`);
    console.log(`QUESTION ${q.question_number}: Total Marks declared: ${q.total_marks}, Sub-marks sum: ${subMarks}`);
    console.log(`Topic: ${q.topic} / ${q.sub_topic}`);
    console.log(`Stem Text Preview (length=${(q.question_text || '').length}): "${(q.question_text || '').slice(0, 160).replace(/\n/g, ' ')}..."`);
    if (qNum === 1) {
      const hasFactFile = /fact\s*file|tunisia|unemployment|gdp/i.test(q.question_text || '');
      const hasChartRef = /Fig\.\s*1\.1|chart|graph/i.test(q.question_text || '');
      console.log(`  -> Q1 Stimulus Preserved: Fact File/Context=${hasFactFile}, Fig 1.1 chart=${hasChartRef}`);
    }

    console.log(`  Sub-questions count: ${subs.length}`);
    for (const s of subs) {
      const msPreview = typeof s.mark_scheme === 'string'
        ? s.mark_scheme.slice(0, 80).replace(/\n/g, ' ')
        : JSON.stringify(s.mark_scheme).slice(0, 80);
      console.log(`    ${s.sub_id} [${s.marks}m]: "${(s.question_text || '').slice(0, 60).replace(/\n/g, ' ')}..."`);
      console.log(`       MS: "${msPreview}..."`);

      // Check Levels of response rubrics for 8m "Discuss" questions
      if (s.marks >= 8) {
        const hasLevels = /Level\s+[1-3]/i.test(String(s.mark_scheme));
        console.log(`       -> 8-mark Discuss Rubric Check: ${hasLevels ? 'LEVEL 1-3 DESCRIPTORS DETECTED' : 'WARNING: No explicit levels detected'}`);
      }
    }
  }

  console.log(`\n======================================================`);
  console.log(`[DIAGNOSIS: TOTAL PAPER MARKS & ARITHMETIC]`);
  console.log(`Section A Marks (Q1):      ${sectionAMarks} (Expected: 30)`);
  console.log(`Section B Marks (Q2-Q5):   ${sectionBMarks} (Expected: 80)`);
  console.log(`Total Extracted Marks:     ${totalExtractedMarks} (Expected Printed: 110 marks)`);
  console.log(`Candidate Required Total:  90 marks (Section A [30] + 3 of 4 from Section B [60])`);
}

console.log('\nSimulation complete.');

