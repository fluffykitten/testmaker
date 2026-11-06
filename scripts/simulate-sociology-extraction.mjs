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

console.log(`[SIMULATION] Initializing Sociology extraction with model: ${model}`);

const nonFlagArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const qpFile = nonFlagArgs[0] || 'sociology/0495_s25_qp_11.pdf';
const msFile = nonFlagArgs[1] || 'sociology/0495_s25_ms_11.pdf';

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
} : 'UNRECOGNIZED');

// 3. Pre-processing: Outline Parsing
console.log('\n--- STAGE 2: DETERMINISTIC PAPER OUTLINE ---');
const outline = parseOutline(qpPages, { fileName: path.basename(qpFile) });
console.log('Outline Usable:', outline.usable);
console.log('Profile:', JSON.stringify(outline.profile));
console.log('Reasons:', outline.reasons);
console.log(`Questions found: ${outline.questions.length}`);
for (const q of outline.questions) {
  console.log(`  Q${q.number}: ${q.subs.length} sub-parts, declared total: ${q.declaredTotal}, sum: ${q.total}`);
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

// 5. Build Extraction Prompt
console.log('\n--- STAGE 4: PROMPT GENERATION ---');
const promptText = getHumanitiesExtractionPrompt(
  false, // hasInsert
  true,  // includeGuidance
  false, // extractResourceCatalog
  true,  // isIgcse
  match?.profile
);
console.log(`Prompt character length: ${promptText.length}`);

// 6. Call Gemini Multimodal API
console.log('\n--- STAGE 5: CALLING GEMINI API ---');
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

console.log(`Payload: QP (${(qpBase64.length / 1024 / 1024).toFixed(2)} MB base64), MS (${(msBase64.length / 1024 / 1024).toFixed(2)} MB base64)`);
console.log(`Sending request to ${model}... (this may take 20-45 seconds for a full paper)`);

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
console.log('\n--- STAGE 6: DIAGNOSIS OF EXTRACTED JSON ---');
fs.writeFileSync('scripts/last-sociology-extraction.json', text, 'utf8');
fs.writeFileSync(`scripts/extraction-${model}.json`, text, 'utf8');
console.log(`Saved raw JSON response to scripts/extraction-${model}.json and scripts/last-sociology-extraction.json`);

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

console.log('\n[DIAGNOSIS: QUESTIONS SUMMARY]');
const questions = parsed.questions || [];
console.log(`Total Top-Level Questions Extracted: ${questions.length}`);

let totalExtractedMarks = 0;
for (const q of questions) {
  const subs = q.sub_questions || [];
  const subMarks = subs.reduce((sum, s) => sum + (Number(s.marks) || 0), 0);
  totalExtractedMarks += subMarks;
  console.log(`\n======================================================`);
  console.log(`QUESTION ${q.question_number}: Total Marks declared: ${q.total_marks}, Sub-marks sum: ${subMarks}`);
  console.log(`Topic: ${q.topic} / ${q.sub_topic}`);
  console.log(`Question Text Preview (first 150 chars): "${(q.question_text || '').slice(0, 150).replace(/\n/g, ' ')}..."`);
  
  // Check Source A capture on Q1
  if (String(q.question_number) === '1') {
    const hasSourceA = /Source A/i.test(q.question_text || '') || /Ehrenreich/i.test(q.question_text || '');
    console.log(`  Source A captured in Q1 stem: ${hasSourceA ? 'YES (VERIFIED)' : 'NO / MISSING'}`);
  }

  console.log(`  Sub-questions count: ${subs.length}`);
  for (const s of subs) {
    const msPreview = typeof s.mark_scheme === 'string'
      ? s.mark_scheme.slice(0, 80).replace(/\n/g, ' ')
      : JSON.stringify(s.mark_scheme).slice(0, 80);
    console.log(`    ${s.sub_id} [${s.marks}m]: "${(s.question_text || '').slice(0, 60).replace(/\n/g, ' ')}..."`);
    console.log(`       MS: "${msPreview}..."`);
    
    // Check Levels of response rubrics for high-mark questions
    if (s.marks >= 8) {
      const hasLevels = /Level\s+[1-4]/i.test(String(s.mark_scheme)) || /Table\s+[A-D]/i.test(String(s.mark_scheme));
      console.log(`       -> High-mark rubric check (>=8m): ${hasLevels ? 'LEVELS/TABLES DETECTED' : 'WARNING: No explicit levels detected'}`);
    }
  }
}

console.log(`\n======================================================`);
console.log(`[DIAGNOSIS: TOTAL PAPER MARKS]`);
console.log(`Total Sum of all Questions: ${totalExtractedMarks} marks (Expected: 120 marks printed, 80 marks required)`);
console.log('\nExtraction simulation complete.');
