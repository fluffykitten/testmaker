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

if (!apiKey) {
  console.error('FATAL: VITE_GEMINI_API_KEY not found in .env.local');
  process.exit(1);
}

console.log(`[SIMULATION] Initializing AS/A Level Geography extraction with model: ${model}`);

const nonFlagArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const qpFile = nonFlagArgs[0] || 'geography paper/paper1_question paper_11_june25.pdf';
const msFile = nonFlagArgs[1] || 'geography paper/paper1_mark scheme_11_june25.pdf';
const insertFile = nonFlagArgs[2] || 'geography paper/paper1_insert_11_june25.pdf';

console.log(`[SIMULATION] Question Paper: ${qpFile}`);
console.log(`[SIMULATION] Mark Scheme:    ${msFile}`);
console.log(`[SIMULATION] Insert Booklet: ${insertFile}`);

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
  hasInsertByDefault: match.profile.hasInsertByDefault,
  isOptionalChoicePaper: match.profile.isOptionalChoicePaper,
  standardTotalMarks: match.profile.standardTotalMarks,
} : 'UNRECOGNIZED');

// 3. Pre-processing: Outline Parsing
console.log('\n--- STAGE 2: DETERMINISTIC PAPER OUTLINE ---');
const outline = parseOutline(qpPages, { fileName: path.basename(qpFile) });
console.log('Outline Usable:', outline.usable);
console.log('Profile:', JSON.stringify(outline.profile));
console.log('Option Groups:', JSON.stringify(outline.profile.optionGroups));
console.log('Reasons:', outline.reasons);
console.log(`Questions found: ${outline.questions.length}`);
for (const q of outline.questions) {
  console.log(`  Q${q.number} (Section ${q.section || 'None'}): ${q.subs.length} sub-parts, declared total: ${q.declaredTotal}, sum: ${q.total}`);
  console.log(`    Sub-IDs: ${q.subs.map((s) => s.id + (s.marks != null ? `[${s.marks}]` : '')).join(', ')}`);
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

// 5. Pre-processing: Insert Booklet Inspection
console.log('\n--- STAGE 4: INSERT BOOKLET INSPECTION ---');
const insertPages = await readPages(insertFile);
console.log(`Insert Pages: ${insertPages.length}`);
for (const p of insertPages) {
  const t = p.items.map((i) => i.s).join(' ').replace(/\s+/g, ' ');
  const figMatch = t.match(/Fig\.\s*\d+\.\d+/gi);
  console.log(`  Page ${p.page} (${t.length} chars): ${figMatch ? `Contains ${figMatch.join(', ')}` : 'Cover / no fig'}`);
}

// 6. Build Extraction Prompt
console.log('\n--- STAGE 5: PROMPT GENERATION ---');
const promptText = getHumanitiesExtractionPrompt(
  true,  // hasInsert
  true,  // includeGuidance
  true,  // extractResourceCatalog
  true,  // isIgcse
  match?.profile
);
console.log(`Prompt character length: ${promptText.length}`);

// 7. Call Gemini Multimodal API
console.log('\n--- STAGE 6: CALLING GEMINI MULTIMODAL API ---');
const qpBase64 = Buffer.from(fs.readFileSync(qpFile)).toString('base64');
const insertBase64 = Buffer.from(fs.readFileSync(insertFile)).toString('base64');
const msBase64 = Buffer.from(trimmedMsBytes).toString('base64');

const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
const parts = [
  { text: promptText },
  { inlineData: { mimeType: 'application/pdf', data: qpBase64 } },
  { inlineData: { mimeType: 'application/pdf', data: insertBase64 } },
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
console.log(`  1. QP PDF:     ${(qpBase64.length / 1024 / 1024).toFixed(2)} MB base64`);
console.log(`  2. Insert PDF: ${(insertBase64.length / 1024 / 1024).toFixed(2)} MB base64`);
console.log(`  3. MS PDF:     ${(msBase64.length / 1024 / 1024).toFixed(2)} MB base64 (trimmed from ${msPages.length} to ${msPages.length - start.startPage + 1} pages)`);
console.log(`Sending request to ${model}... (this may take 25-50 seconds)`);

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

// 8. Parse & Diagnose Extracted Output
console.log('\n--- STAGE 7: DIAGNOSIS OF EXTRACTED GEOGRAPHY JSON ---');
fs.writeFileSync('scripts/last-geography-extraction.json', text, 'utf8');
fs.writeFileSync(`scripts/extraction-geography-${model}.json`, text, 'utf8');
console.log(`Saved raw JSON response to scripts/extraction-geography-${model}.json and scripts/last-geography-extraction.json`);

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

console.log('\n[DIAGNOSIS: INSERT RESOURCES CATALOG]');
const insertResources = parsed.insert_resources || [];
console.log(`Total Resources in Catalog: ${insertResources.length}`);
for (const r of insertResources) {
  console.log(`  - [${r.id}] "${r.title}" (Page ${r.page_number}) -> Target: ${JSON.stringify(r.target_questions)}`);
}

console.log('\n[DIAGNOSIS: QUESTIONS SUMMARY]');
const questions = parsed.questions || [];
console.log(`Total Top-Level Questions Extracted: ${questions.length}`);

let totalExtractedMarks = 0;
let sectionAMarks = 0;
let sectionBMarks = 0;

for (const q of questions) {
  const subs = q.sub_questions || [];
  const subMarks = subs.reduce((sum, s) => sum + (Number(s.marks) || 0), 0);
  totalExtractedMarks += subMarks;
  const qNum = Number(q.question_number) || 0;
  if (qNum <= 3) sectionAMarks += subMarks;
  else sectionBMarks += subMarks;

  console.log(`\n======================================================`);
  console.log(`QUESTION ${q.question_number}: Total Marks declared: ${q.total_marks}, Sub-marks sum: ${subMarks}`);
  console.log(`Topic: ${q.topic} / ${q.sub_topic}`);
  console.log(`Has Diagram: ${q.has_diagram}, Source: ${q.diagram_source}, Ref: ${q.resource_ref}, Insert Page: ${q.insert_page_number}`);
  console.log(`Bounding Box: ${JSON.stringify(q.bounding_box)}`);
  console.log(`Stem Text Preview: "${(q.question_text || '').slice(0, 150).replace(/\n/g, ' ')}..."`);

  console.log(`  Sub-questions count: ${subs.length}`);
  for (const s of subs) {
    const msPreview = typeof s.mark_scheme === 'string'
      ? s.mark_scheme.slice(0, 80).replace(/\n/g, ' ')
      : JSON.stringify(s.mark_scheme).slice(0, 80);
    console.log(`    ${s.sub_id} [${s.marks}m]: "${(s.question_text || '').slice(0, 60).replace(/\n/g, ' ')}..."`);
    console.log(`       MS: "${msPreview}..."`);

    // Check Levels of response rubrics for 8m and 15m essay questions
    if (s.marks >= 8) {
      const hasLevels = /Level\s+[1-4]/i.test(String(s.mark_scheme));
      console.log(`       -> Essay Rubric Check (>=8m): ${hasLevels ? 'LEVEL 1-4 DESCRIPTORS DETECTED' : 'WARNING: No explicit levels detected'}`);
    }
  }
}

console.log(`\n======================================================`);
console.log(`[DIAGNOSIS: TOTAL PAPER MARKS & ARITHMETIC]`);
console.log(`Section A Marks (Q1-Q3): ${sectionAMarks} (Expected: 30)`);
console.log(`Section B Marks (Q4-Q6): ${sectionBMarks} (Expected: 90)`);
console.log(`Total Extracted Marks:   ${totalExtractedMarks} (Expected Printed: 120 marks)`);
console.log(`Standard Paper Total:    60 marks (Section A [30] + 1 from Section B [30])`);
console.log('\nSimulation complete.');

